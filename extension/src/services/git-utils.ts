import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { atomicWriteFile, ensureDir, slugify } from './pickle-utils.js';

interface RunGitOptions {
  timeout?: number;
  trim?: boolean;
  allowFailure?: boolean;
}

function runGit(args: string[], cwd: string, options: RunGitOptions = {}): string {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
      timeout: options.timeout ?? 15_000,
    });
    return options.trim === false ? output : output.trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

export function isGitRepo(cwd: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true }) === 'true';
}

export function getRepoRoot(cwd: string): string | null {
  return runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true }) || null;
}

export function getHeadSha(cwd: string): string {
  return runGit(['rev-parse', 'HEAD'], cwd, { allowFailure: true }) || '';
}

export function commitExists(cwd: string, sha: string): boolean {
  if (!sha) return false;
  try {
    runGit(['cat-file', '-e', `${String(sha)}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function hasResolvableHead(cwd: string): boolean {
  return runGit(['rev-parse', '--verify', 'HEAD'], cwd, { allowFailure: true }) !== '';
}

export function countCommitsSince(cwd: string, baselineSha: string): number {
  if (!baselineSha) return 0;
  const raw = runGit(['rev-list', '--count', `${baselineSha}..HEAD`], cwd, { allowFailure: true });
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : 0;
}

export function isIndexClean(cwd: string): boolean {
  try {
    runGit(['diff', '--cached', '--quiet'], cwd);
    return true;
  } catch {
    return false;
  }
}

export function readCommitTrailer(cwd: string, sha: string, key: string): string | null {
  if (!sha || !key) return null;
  const value = runGit(['log', '-1', `--format=%(trailers:key=${key},valueonly)`, sha], cwd, {
    allowFailure: true,
  });
  return value.length > 0 ? value : null;
}

export function amendCommitTrailer(cwd: string, sha: string, trailer: string): string | null {
  if (!sha || !trailer) return null;
  const message = runGit(['log', '-1', '--format=%B', sha], cwd, { allowFailure: true, trim: false });
  if (!message.trim()) return null;
  try {
    runGit(
      [
        '-c',
        'user.name=Pickle Rick',
        '-c',
        'user.email=pickle-rick@local.invalid',
        'commit',
        '--amend',
        '--no-gpg-sign',
        '-m',
        message,
        '-m',
        trailer,
      ],
      cwd,
    );
    return getHeadSha(cwd) || null;
  } catch {
    return null;
  }
}

export function getWorkingTreeStatus(cwd: string): string {
  return runGit(['status', '--porcelain'], cwd, { allowFailure: true }) || '';
}

function porcelainStatusLines(status: string): string[] {
  return String(status || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function isWorkingTreeDirty(cwd: string): boolean {
  return getWorkingTreeStatus(cwd) !== '';
}

export function hasTrackedWorkingTreeChanges(cwd: string): boolean {
  return porcelainStatusLines(getWorkingTreeStatus(cwd)).some((line) => !line.startsWith('?? '));
}

export function stageTrackedChanges(cwd: string): void {
  runGit(['add', '-u'], cwd);
}

export function stageAllChanges(cwd: string): void {
  runGit(['add', '-A'], cwd);
}

export function listUntrackedFiles(cwd: string): string[] {
  const output = runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd, {
    allowFailure: true,
    trim: false,
  });
  return output
    .split('\0')
    .filter(Boolean)
    .sort();
}

export function stagePaths(cwd: string, paths: string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    return;
  }
  runGit(['add', '--', ...paths], cwd);
}

export function stageTrackedChangesAndNewPaths(cwd: string, paths: string[] = []): void {
  stageTrackedChanges(cwd);
  stagePaths(cwd, paths);
}

interface CommitOptions {
  allowEmpty?: boolean;
}

function commitArgs(message: string, options: CommitOptions = {}): string[] {
  const args = [
    '-c',
    'user.name=Pickle Rick',
    '-c',
    'user.email=pickle-rick@local.invalid',
    'commit',
  ];
  if (options.allowEmpty) {
    args.push('--allow-empty');
  }
  args.push('-m', message);
  return args;
}

export function commitTrackedChanges(cwd: string, message: string, options: CommitOptions = {}): string {
  return runGit(commitArgs(message, options), cwd);
}

export function resetGitIndex(cwd: string): void {
  runGit(['reset'], cwd, { allowFailure: true });
}

function appendFilesystemEntryFingerprint(hash: crypto.Hash, rootDir: string, relativePath: string = ''): void {
  const absolutePath = relativePath ? path.join(rootDir, relativePath) : rootDir;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    hash.update(relativePath);
    hash.update('\0missing\0');
    return;
  }

  if (relativePath) {
    hash.update(relativePath);
    hash.update('\0');
  }

  if (stat.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(fs.readlinkSync(absolutePath));
    hash.update('\0');
    return;
  }

  if (stat.isDirectory()) {
    hash.update('dir\0');
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const childRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name;
      appendFilesystemEntryFingerprint(hash, rootDir, childRelativePath);
    }
    return;
  }

  hash.update('file\0');
  hash.update(fs.readFileSync(absolutePath));
  hash.update('\0');
}

function getFilesystemFingerprint(cwd: string): string {
  const hash = crypto.createHash('sha256');
  appendFilesystemEntryFingerprint(hash, cwd);
  return hash.digest('hex');
}

export function getWorkingTreeFingerprint(cwd: string): string {
  if (!isGitRepo(cwd)) {
    return getFilesystemFingerprint(cwd);
  }

  const filesOutput = runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd, {
    allowFailure: true,
    trim: false,
  });
  const files = filesOutput
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = crypto.createHash('sha256');

  for (const relativePath of files) {
    const absolutePath = path.join(cwd, relativePath);
    hash.update(relativePath);
    hash.update('\0');
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(fs.readlinkSync(absolutePath));
      } else {
        hash.update('file\0');
        hash.update(fs.readFileSync(absolutePath));
      }
    } catch {
      hash.update('missing\0');
    }
    hash.update('\0');
  }

  return hash.digest('hex');
}

function worktreeExists(worktreeDir: string): boolean {
  try {
    fs.lstatSync(worktreeDir);
    return true;
  } catch {
    return false;
  }
}

function removeExistingWorktree(repoDir: string, worktreeDir: string): void {
  if (!worktreeExists(worktreeDir)) return;
  runGit(['worktree', 'remove', '--force', worktreeDir], repoDir, { allowFailure: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

function shouldLinkBootstrapFile(fileName: string): boolean {
  return fileName === '.env.local' || /\.env\.[^.]+\.local$/.test(fileName);
}

function collectBootstrapArtifacts(repoDir: string): string[] {
  const artifacts: string[] = [];
  const queue: string[] = ['.'];

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    const absoluteDir = relativeDir === '.'
      ? repoDir
      : path.join(repoDir, relativeDir);
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relativePath = relativeDir === '.'
        ? entry.name
        : path.join(relativeDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          artifacts.push(relativePath);
          continue;
        }
        queue.push(relativePath);
        continue;
      }

      if (entry.isFile() && shouldLinkBootstrapFile(entry.name)) {
        artifacts.push(relativePath);
      }
    }
  }

  return artifacts;
}

function linkBootstrapArtifacts(repoDir: string, worktreeDir: string): void {
  for (const relativePath of collectBootstrapArtifacts(repoDir)) {
    const sourcePath = path.join(repoDir, relativePath);
    const targetPath = path.join(worktreeDir, relativePath);
    if (worktreeExists(targetPath)) continue;

    ensureDir(path.dirname(targetPath));
    const sourceStats = fs.lstatSync(sourcePath);
    fs.symlinkSync(sourcePath, targetPath, sourceStats.isDirectory() ? 'dir' : 'file');
  }
}

function copyRepoSnapshot(repoDir: string, worktreeDir: string): void {
  ensureDir(worktreeDir);
  const queue: string[] = ['.'];

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    const sourceDir = relativeDir === '.'
      ? repoDir
      : path.join(repoDir, relativeDir);
    const targetDir = relativeDir === '.'
      ? worktreeDir
      : path.join(worktreeDir, relativeDir);
    ensureDir(targetDir);

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (entry.name === 'node_modules') continue;

      const relativePath = relativeDir === '.'
        ? entry.name
        : path.join(relativeDir, entry.name);
      if (entry.isFile() && shouldLinkBootstrapFile(entry.name)) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(relativePath);
        continue;
      }
      fs.cpSync(sourcePath, targetPath, {
        recursive: true,
        dereference: false,
        force: true,
      });
    }
  }
}

interface SnapshotWorktreeInput {
  repoDir: string;
  sessionDir: string;
  ticketId: string;
}

function createSnapshotWorktree({ repoDir, sessionDir, ticketId }: SnapshotWorktreeInput): { worktreeDir: string; baseSha: string } {
  const worktreeRoot = ensureDir(path.join(sessionDir, 'worktrees'));
  const worktreeDir = path.join(worktreeRoot, `${slugify(ticketId) || 'ticket'}-snapshot`);
  removeExistingWorktree(repoDir, worktreeDir);
  copyRepoSnapshot(repoDir, worktreeDir);
  linkBootstrapArtifacts(repoDir, worktreeDir);
  runGit(['init'], worktreeDir);
  runGit(['add', '-A'], worktreeDir);
  runGit([
    '-c',
    'user.name=Pickle Rick',
    '-c',
    'user.email=pickle-rick@local.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'pickle baseline',
  ], worktreeDir);
  const baseSha = runGit(['rev-parse', 'HEAD'], worktreeDir);
  return { worktreeDir, baseSha };
}

export interface CreateTicketWorktreeInput {
  repoDir: string;
  sessionDir: string;
  ticketId: string;
  baseRef?: string;
}

export interface TicketWorktree {
  worktreeDir: string;
  baseSha: string;
}

export function createTicketWorktree({ repoDir, sessionDir, ticketId, baseRef = 'HEAD' }: CreateTicketWorktreeInput): TicketWorktree {
  if (!hasResolvableHead(repoDir)) {
    return createSnapshotWorktree({ repoDir, sessionDir, ticketId });
  }
  const baseSha = runGit(['rev-parse', baseRef], repoDir);
  const worktreeRoot = ensureDir(path.join(sessionDir, 'worktrees'));
  const worktreeDir = path.join(worktreeRoot, `${slugify(ticketId) || 'ticket'}-${baseSha.slice(0, 8)}`);
  removeExistingWorktree(repoDir, worktreeDir);
  runGit(['worktree', 'add', '--detach', worktreeDir, baseSha], repoDir);
  linkBootstrapArtifacts(repoDir, worktreeDir);
  return { worktreeDir, baseSha };
}

export function removeTicketWorktree(worktreeDir: string): void {
  const repoDir = getRepoRoot(worktreeDir) || worktreeDir;
  runGit(['worktree', 'remove', '--force', worktreeDir], repoDir, { allowFailure: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

export function worktreeHasDiff(worktreeDir: string, baseSha: string): boolean {
  const diff = runGit(['diff', '--stat', baseSha], worktreeDir, { allowFailure: true });
  return diff.length > 0;
}

export function createPatchFromWorktree(worktreeDir: string, baseSha: string, outputPath: string): string {
  const patch = runGit(['diff', '--binary', baseSha], worktreeDir, {
    allowFailure: true,
    trim: false,
  });
  atomicWriteFile(outputPath, patch, { mode: 0o600 });
  return outputPath;
}

export interface PatchApplyResult {
  ok: boolean;
  error: string;
}

function extractExecErrorStderr(error: unknown): string {
  const candidate = error as { stderr?: unknown };
  if (typeof candidate.stderr === 'string') return candidate.stderr;
  if (Buffer.isBuffer(candidate.stderr)) return candidate.stderr.toString('utf8');
  if (error instanceof Error) return error.message;
  return String(error);
}

export function checkPatchApply(targetDir: string, patchPath: string): PatchApplyResult {
  try {
    const args = hasResolvableHead(targetDir)
      ? ['apply', '--check', '--3way', patchPath]
      : ['apply', '--check', patchPath];
    runGit(args, targetDir);
    return { ok: true, error: '' };
  } catch (error) {
    const stderr = extractExecErrorStderr(error);
    return { ok: false, error: stderr.trim() };
  }
}

export function classifyPatchApplyError(errorText: unknown): string {
  const text = String(errorText || '');
  if (
    /corrupt patch/i.test(text)
    || /no valid patches in input/i.test(text)
    || /patch fragment without header/i.test(text)
    || /patch with only garbage/i.test(text)
    || /unrecognized input/i.test(text)
  ) {
    return 'patch-invalid';
  }
  return 'patch-conflict';
}

export function canApplyPatch(targetDir: string, patchPath: string): boolean {
  return checkPatchApply(targetDir, patchPath).ok;
}

export function applyPatch(targetDir: string, patchPath: string): void {
  const args = hasResolvableHead(targetDir)
    ? ['apply', '--3way', patchPath]
    : ['apply', patchPath];
  runGit(args, targetDir);
}

export function writePatchSummary(sessionDir: string, ticketId: string, patchPath: string, details: Record<string, unknown> = {}): string {
  const outputPath = path.join(sessionDir, `${slugify(ticketId) || 'ticket'}.patch.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ ticketId, patchPath, ...details }, null, 2));
  return outputPath;
}
