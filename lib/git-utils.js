import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { atomicWriteFile, ensureDir, slugify } from './pickle-utils.js';

function runGit(args, cwd, options = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 15_000,
    });
    return options.trim === false ? output : output.trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

export function isGitRepo(cwd) {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true }) === 'true';
}

export function getRepoRoot(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true }) || null;
}

export function getHeadSha(cwd) {
  return runGit(['rev-parse', 'HEAD'], cwd, { allowFailure: true }) || '';
}

function hasResolvableHead(cwd) {
  return runGit(['rev-parse', '--verify', 'HEAD'], cwd, { allowFailure: true }) !== '';
}

export function getWorkingTreeStatus(cwd) {
  return runGit(['status', '--porcelain'], cwd, { allowFailure: true }) || '';
}

function worktreeExists(worktreeDir) {
  try {
    fs.lstatSync(worktreeDir);
    return true;
  } catch {
    return false;
  }
}

function removeExistingWorktree(repoDir, worktreeDir) {
  if (!worktreeExists(worktreeDir)) return;
  runGit(['worktree', 'remove', '--force', worktreeDir], repoDir, { allowFailure: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

function shouldLinkBootstrapFile(fileName) {
  return fileName === '.env.local' || /\.env\.[^.]+\.local$/.test(fileName);
}

function collectBootstrapArtifacts(repoDir) {
  const artifacts = [];
  const queue = ['.'];

  while (queue.length > 0) {
    const relativeDir = queue.shift();
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

function linkBootstrapArtifacts(repoDir, worktreeDir) {
  for (const relativePath of collectBootstrapArtifacts(repoDir)) {
    const sourcePath = path.join(repoDir, relativePath);
    const targetPath = path.join(worktreeDir, relativePath);
    if (worktreeExists(targetPath)) continue;

    ensureDir(path.dirname(targetPath));
    const sourceStats = fs.lstatSync(sourcePath);
    fs.symlinkSync(sourcePath, targetPath, sourceStats.isDirectory() ? 'dir' : 'file');
  }
}

function copyRepoSnapshot(repoDir, worktreeDir) {
  ensureDir(worktreeDir);
  const queue = ['.'];

  while (queue.length > 0) {
    const relativeDir = queue.shift();
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

function createSnapshotWorktree({ repoDir, sessionDir, ticketId }) {
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

export function createTicketWorktree({ repoDir, sessionDir, ticketId, baseRef = 'HEAD' }) {
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

export function removeTicketWorktree(worktreeDir) {
  const repoDir = getRepoRoot(worktreeDir) || worktreeDir;
  runGit(['worktree', 'remove', '--force', worktreeDir], repoDir, { allowFailure: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

export function worktreeHasDiff(worktreeDir, baseSha) {
  const diff = runGit(['diff', '--stat', baseSha], worktreeDir, { allowFailure: true });
  return diff.length > 0;
}

export function createPatchFromWorktree(worktreeDir, baseSha, outputPath) {
  const patch = runGit(['diff', '--binary', baseSha], worktreeDir, {
    allowFailure: true,
    trim: false,
  });
  atomicWriteFile(outputPath, patch, { mode: 0o600 });
  return outputPath;
}

export function checkPatchApply(targetDir, patchPath) {
  try {
    const args = hasResolvableHead(targetDir)
      ? ['apply', '--check', '--3way', patchPath]
      : ['apply', '--check', patchPath];
    runGit(args, targetDir);
    return { ok: true, error: '' };
  } catch (error) {
    const stderr = typeof error?.stderr === 'string'
      ? error.stderr
      : Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString('utf8')
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: stderr.trim() };
  }
}

export function classifyPatchApplyError(errorText) {
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

export function canApplyPatch(targetDir, patchPath) {
  return checkPatchApply(targetDir, patchPath).ok;
}

export function applyPatch(targetDir, patchPath) {
  const args = hasResolvableHead(targetDir)
    ? ['apply', '--3way', patchPath]
    : ['apply', patchPath];
  runGit(args, targetDir);
}

export function writePatchSummary(sessionDir, ticketId, patchPath, details = {}) {
  const outputPath = path.join(sessionDir, `${slugify(ticketId) || 'ticket'}.patch.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ ticketId, patchPath, ...details }, null, 2));
  return outputPath;
}
