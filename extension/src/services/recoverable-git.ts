import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stashUnattributableRemainder } from './dirty-tree-salvage.js';

export type DestructiveGitSafetyErrorKind =
  | 'destructive-archive-cap-exceeded'
  | 'destructive-archive-failed'
  | 'destructive-reset-failed';

export class DestructiveGitSafetyError extends Error {
  kind: DestructiveGitSafetyErrorKind;

  constructor(kind: DestructiveGitSafetyErrorKind, message: string, options: ErrorOptions = {}) {
    super(`${kind}: ${message}`, options);
    this.name = 'DestructiveGitSafetyError';
    this.kind = kind;
  }
}

export interface RecoverableHardResetOptions {
  workingDir: string;
  sessionDir: string;
  targetHead: string;
  operation: string;
  preserveUntracked?: string[];
  headRecoveryRef?: string;
  maxArchiveBytes?: number;
  log?: (message: string) => void;
}

export interface RecoverableGitArchive {
  headRef: string | null;
  dirtyRef: string | null;
  estimatedBytes: number;
}

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'recovery';
}

function archiveLimit(explicit: number | undefined): number {
  const configured = explicit ?? Number(process.env.PICKLE_DESTRUCTIVE_ARCHIVE_MAX_BYTES || 50 * 1024 * 1024);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new DestructiveGitSafetyError('destructive-archive-cap-exceeded', 'archive byte cap must be a positive finite number');
  }
  return Math.floor(configured);
}

function untrackedPaths(workingDir: string): string[] {
  return git(workingDir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
}

function estimateArchiveBytes(workingDir: string, targetHead: string, maxBytes: number): number {
  const diff = spawnSync('git', ['diff', '--binary', targetHead, '--'], {
    cwd: workingDir,
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: maxBytes + 1,
  });
  if (diff.error || diff.status !== 0) {
    if ((diff.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') {
      throw new DestructiveGitSafetyError('destructive-archive-cap-exceeded', `tracked recovery archive exceeds ${maxBytes} bytes`);
    }
    throw new DestructiveGitSafetyError('destructive-archive-failed', `could not measure tracked recovery state: ${String(diff.stderr || diff.error?.message || '')}`);
  }
  let bytes = Buffer.isBuffer(diff.stdout) ? diff.stdout.length : Buffer.byteLength(String(diff.stdout || ''));
  const repoRoot = fs.realpathSync(git(workingDir, ['rev-parse', '--show-toplevel']));
  for (const relativePath of untrackedPaths(workingDir)) {
    const target = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DestructiveGitSafetyError('destructive-archive-failed', `refusing to archive out-of-repository path ${relativePath}`);
    }
    try {
      bytes += fs.lstatSync(target).size;
    } catch (error) {
      throw new DestructiveGitSafetyError('destructive-archive-failed', `could not size recovery path ${relativePath}`, { cause: error });
    }
    if (bytes > maxBytes) {
      throw new DestructiveGitSafetyError('destructive-archive-cap-exceeded', `recovery archive requires ${bytes} bytes, above ${maxBytes}-byte cap`);
    }
  }
  return bytes;
}

export function archiveRecoverableGitState(options: RecoverableHardResetOptions): RecoverableGitArchive {
  const maxBytes = archiveLimit(options.maxArchiveBytes);
  const estimatedBytes = estimateArchiveBytes(options.workingDir, options.targetHead, maxBytes);
  const currentHead = git(options.workingDir, ['rev-parse', 'HEAD']);
  let headRef: string | null = null;
  let dirtyRef: string | null = null;
  try {
    if (currentHead !== options.targetHead) {
      headRef = options.headRecoveryRef || `refs/pickle/recovery/${safeName(path.basename(options.sessionDir))}/${safeName(options.operation)}`;
      git(options.workingDir, ['update-ref', headRef, currentHead]);
      options.log?.(`archived destructive-operation HEAD at ${headRef}: ${currentHead}`);
    }
    if (git(options.workingDir, ['status', '--porcelain']).trim()) {
      dirtyRef = stashUnattributableRemainder(options.workingDir, options.sessionDir, options.log || (() => {}));
      if (!dirtyRef) throw new Error('dirty snapshot did not produce a recovery ref');
    }
  } catch (error) {
    throw new DestructiveGitSafetyError('destructive-archive-failed', 'recovery state could not be anchored; destructive operation aborted', { cause: error });
  }
  return { headRef, dirtyRef, estimatedBytes };
}

export function recoverableHardReset(options: RecoverableHardResetOptions): RecoverableGitArchive {
  const archive = archiveRecoverableGitState(options);
  try {
    git(options.workingDir, ['reset', '--hard', options.targetHead]);
    const preserved = new Set(options.preserveUntracked || []);
    const repoRoot = fs.realpathSync(git(options.workingDir, ['rev-parse', '--show-toplevel']));
    for (const relativePath of untrackedPaths(options.workingDir)) {
      if (preserved.has(relativePath)) continue;
      const target = path.resolve(repoRoot, relativePath);
      const relative = path.relative(repoRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`refusing to remove out-of-repository path ${relativePath}`);
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (error) {
    throw new DestructiveGitSafetyError('destructive-reset-failed', 'recovery state was archived, but checkpoint restore failed', { cause: error });
  }
  return archive;
}
