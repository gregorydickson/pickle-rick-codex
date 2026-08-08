import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  /** Exact repository-relative files owned by the failed operation. */
  ownedPaths: string[];
  /** Exact paths to archive as evidence even when they are not safe to roll back. */
  evidencePaths?: string[];
  headRecoveryRef?: string;
  maxArchiveBytes?: number;
  log?: (message: string) => void;
}

export interface RecoverableGitArchive {
  headRef: string | null;
  dirtyRef: string | null;
  estimatedBytes: number;
}

function git(workingDir: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
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

function normalizeOwnedPaths(workingDir: string, candidates: string[]): string[] {
  const repoRoot = fs.realpathSync(git(workingDir, ['rev-parse', '--show-toplevel']));
  const normalized = [...new Set(candidates.map((candidate) => candidate.replaceAll('\\', '/')))].sort();
  if (normalized.length === 0) {
    throw new DestructiveGitSafetyError('destructive-archive-failed', 'path-scoped recovery requires at least one operation-owned file');
  }
  for (const candidate of normalized) {
    const target = path.resolve(repoRoot, candidate);
    const relative = path.relative(repoRoot, target).replaceAll('\\', '/');
    if (!candidate || candidate === '.' || relative !== candidate || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new DestructiveGitSafetyError('destructive-archive-failed', `invalid operation-owned recovery path: ${candidate}`);
    }
    try {
      if (fs.lstatSync(target).isDirectory()) {
        throw new DestructiveGitSafetyError('destructive-archive-failed', `operation-owned recovery path must name a file, not a directory: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return normalized;
}

function validateRecoveryRef(workingDir: string, recoveryRef: string): void {
  git(workingDir, ['check-ref-format', recoveryRef]);
}

function buildOwnedSnapshot(
  workingDir: string,
  currentHead: string,
  ownedPaths: string[],
  operation: string,
): { commit: string; dirty: boolean } {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-owned-recovery-'));
  const indexPath = path.join(temporaryDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  const repoRoot = fs.realpathSync(git(workingDir, ['rev-parse', '--show-toplevel']));
  try {
    git(workingDir, ['read-tree', currentHead], env);
    for (const ownedPath of ownedPaths) {
      let existsInWorktree = true;
      try { fs.lstatSync(path.join(repoRoot, ownedPath)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') existsInWorktree = false;
        else throw error;
      }
      const existsInCurrentHead = git(workingDir, ['ls-tree', '-z', currentHead, '--', ownedPath]).length > 0;
      // A rename source absent from both the attempted commit and worktree is
      // already represented correctly by the temp index seeded from currentHead.
      if (!existsInWorktree && !existsInCurrentHead) continue;
      git(workingDir, ['add', '-A', '--', ownedPath], env);
    }
    const tree = git(workingDir, ['write-tree'], env);
    const currentTree = git(workingDir, ['rev-parse', `${currentHead}^{tree}`]);
    if (tree === currentTree) return { commit: currentHead, dirty: false };
    const commit = git(workingDir, [
      'commit-tree', tree, '-p', currentHead, '-m', `pickle recovery: ${operation}`,
    ]);
    return { commit, dirty: true };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function estimateArchiveBytes(
  workingDir: string,
  targetHead: string,
  snapshotCommit: string,
  ownedPaths: string[],
  maxBytes: number,
): number {
  const diff = spawnSync('git', ['diff', '--binary', targetHead, snapshotCommit, '--', ...ownedPaths], {
    cwd: workingDir,
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: maxBytes + 1,
  });
  if (diff.error || diff.status !== 0) {
    if ((diff.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') {
      throw new DestructiveGitSafetyError('destructive-archive-cap-exceeded', `owned recovery archive exceeds ${maxBytes} bytes`);
    }
    throw new DestructiveGitSafetyError('destructive-archive-failed', `could not measure owned recovery state: ${String(diff.stderr || diff.error?.message || '')}`);
  }
  const bytes = Buffer.isBuffer(diff.stdout) ? diff.stdout.length : Buffer.byteLength(String(diff.stdout || ''));
  if (bytes > maxBytes) {
    throw new DestructiveGitSafetyError('destructive-archive-cap-exceeded', `owned recovery archive requires ${bytes} bytes, above ${maxBytes}-byte cap`);
  }
  return bytes;
}

function defaultRecoveryRef(options: RecoverableHardResetOptions): string {
  return `refs/pickle/recovery/${safeName(path.basename(options.sessionDir))}/${safeName(options.operation)}`;
}

export function archiveRecoverableGitState(options: RecoverableHardResetOptions): RecoverableGitArchive {
  const maxBytes = archiveLimit(options.maxArchiveBytes);
  const targetHead = git(options.workingDir, ['rev-parse', `${options.targetHead}^{commit}`]);
  const currentHead = git(options.workingDir, ['rev-parse', 'HEAD']);
  const evidenceCandidates = options.evidencePaths ?? options.ownedPaths;
  if (evidenceCandidates.length === 0 && currentHead === targetHead) {
    return { headRef: null, dirtyRef: null, estimatedBytes: 0 };
  }
  const ownedPaths = evidenceCandidates.length > 0
    ? normalizeOwnedPaths(options.workingDir, evidenceCandidates)
    : [];
  const headRef = currentHead === targetHead ? null : (options.headRecoveryRef || defaultRecoveryRef(options));
  try {
    if (headRef) validateRecoveryRef(options.workingDir, headRef);
    const snapshot = ownedPaths.length > 0
      ? buildOwnedSnapshot(options.workingDir, currentHead, ownedPaths, options.operation)
      : { commit: currentHead, dirty: false };
    const session = safeName(path.basename(options.sessionDir));
    const dirtyRef = `refs/pickle/salvage-history/${session}/${snapshot.commit}`;
    const latestDirtyRef = `refs/pickle/salvage/${session}`;
    if (snapshot.dirty) {
      validateRecoveryRef(options.workingDir, dirtyRef);
      validateRecoveryRef(options.workingDir, latestDirtyRef);
    }
    const estimatedBytes = estimateArchiveBytes(
      options.workingDir,
      targetHead,
      snapshot.commit,
      ownedPaths,
      maxBytes,
    );
    if (headRef) {
      git(options.workingDir, ['update-ref', headRef, currentHead]);
      options.log?.(`archived destructive-operation HEAD at ${headRef}: ${currentHead}`);
    }
    if (snapshot.dirty) {
      git(options.workingDir, ['update-ref', dirtyRef, snapshot.commit]);
      git(options.workingDir, ['update-ref', latestDirtyRef, snapshot.commit]);
      options.log?.(`archived operation-owned dirty state at ${dirtyRef}: ${snapshot.commit}`);
    }
    return { headRef, dirtyRef: snapshot.dirty ? dirtyRef : null, estimatedBytes };
  } catch (error) {
    if (error instanceof DestructiveGitSafetyError) throw error;
    throw new DestructiveGitSafetyError('destructive-archive-failed', 'operation-owned recovery state could not be anchored; rollback aborted', { cause: error });
  }
}

function targetContainsPath(workingDir: string, targetHead: string, ownedPath: string): boolean {
  return git(workingDir, ['ls-tree', '-z', targetHead, '--', ownedPath]).length > 0;
}

function committedPathsBetween(workingDir: string, targetHead: string, currentHead: string): string[] {
  return execFileSync('git', ['diff', '--name-only', '-z', targetHead, currentHead], {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
}

/** Build an inverse, owned-path-only commit on top of the current topology.
 * This is required when the attempted commit also contains paths the caller
 * does not own: moving HEAD to the old checkpoint would silently demote those
 * preserved changes from committed history into the index. */
function commitOwnedPathRollback(
  workingDir: string,
  currentHead: string,
  targetHead: string,
  ownedPaths: string[],
  operation: string,
): string {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-owned-rollback-'));
  const indexPath = path.join(temporaryDir, 'index');
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    git(workingDir, ['read-tree', currentHead], indexEnv);
    for (const ownedPath of ownedPaths) {
      if (targetContainsPath(workingDir, targetHead, ownedPath)) {
        git(workingDir, ['restore', `--source=${targetHead}`, '--staged', '--', ownedPath], indexEnv);
      } else {
        git(workingDir, ['update-index', '--force-remove', '--', ownedPath], indexEnv);
      }
    }
    const tree = git(workingDir, ['write-tree'], indexEnv);
    const currentTree = git(workingDir, ['rev-parse', `${currentHead}^{tree}`]);
    if (tree === currentTree) return currentHead;
    const identityEnv = {
      GIT_AUTHOR_NAME: 'Pickle Rick Recovery',
      GIT_AUTHOR_EMAIL: 'pickle-recovery@localhost',
      GIT_COMMITTER_NAME: 'Pickle Rick Recovery',
      GIT_COMMITTER_EMAIL: 'pickle-recovery@localhost',
    };
    return git(workingDir, [
      'commit-tree', tree, '-p', currentHead, '-m', `pickle recovery: rollback owned paths for ${operation}`,
    ], identityEnv);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/**
 * Restore only files explicitly owned by a failed operation. The historical name
 * remains API-compatible; this implementation never performs a repository reset.
 */
export function recoverableHardReset(options: RecoverableHardResetOptions): RecoverableGitArchive {
  const currentHead = git(options.workingDir, ['rev-parse', 'HEAD']);
  const targetHead = git(options.workingDir, ['rev-parse', `${options.targetHead}^{commit}`]);
  const ownedPaths = options.ownedPaths.length > 0
    ? normalizeOwnedPaths(options.workingDir, options.ownedPaths)
    : [];
  const archive = archiveRecoverableGitState({ ...options, ownedPaths, targetHead });
  if (ownedPaths.length === 0) return archive;
  try {
    if (currentHead !== targetHead) {
      const owned = new Set(ownedPaths);
      const hasPreservedCommittedPaths = committedPathsBetween(options.workingDir, targetHead, currentHead)
        .some((candidate) => !owned.has(candidate));
      const restoredHead = hasPreservedCommittedPaths
        ? commitOwnedPathRollback(
          options.workingDir, currentHead, targetHead, ownedPaths, options.operation,
        )
        : targetHead;
      git(options.workingDir, ['update-ref', 'HEAD', restoredHead, currentHead]);
    }
    const restoredHead = git(options.workingDir, ['rev-parse', 'HEAD']);
    const repoRoot = fs.realpathSync(git(options.workingDir, ['rev-parse', '--show-toplevel']));
    for (const ownedPath of ownedPaths) {
      if (targetContainsPath(options.workingDir, restoredHead, ownedPath)) {
        git(options.workingDir, ['restore', `--source=${restoredHead}`, '--staged', '--worktree', '--', ownedPath]);
        continue;
      }
      git(options.workingDir, ['update-index', '--force-remove', '--', ownedPath]);
      const target = path.join(repoRoot, ownedPath);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) throw new Error(`refusing recursive removal of operation-owned directory ${ownedPath}`);
        fs.unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    throw new DestructiveGitSafetyError('destructive-reset-failed', 'recovery state was archived, but path-scoped checkpoint restore failed', { cause: error });
  }
  return archive;
}
