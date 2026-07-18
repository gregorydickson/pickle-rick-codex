import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MICROVERSE_EXPERIMENT_ARCHIVE_SCHEMA_VERSION = 1;

export interface MicroverseArchivedBlob {
  encoding: 'base64';
  byte_length: number;
  sha256: string;
  data: string;
}

export interface MicroverseArchivedUntrackedEntry extends MicroverseArchivedBlob {
  path: string;
  type: 'file' | 'symlink';
  mode: number;
}

export interface MicroverseExperimentArchive {
  schema_version: 1;
  experiment_id: string;
  base_ref: string;
  created_at: string;
  tracked_patch: MicroverseArchivedBlob;
  untracked: MicroverseArchivedUntrackedEntry[];
}

export interface ArchiveMicroverseExperimentOptions {
  workingDir: string;
  sessionDir: string;
  experimentId: string;
  baseRef: string;
  /** Untracked paths that existed before the experiment and must not be attributed to it. */
  excludeUntrackedPaths?: string[];
  maxArchiveBytes?: number;
  now?: string;
}

export interface ArchivedMicroverseExperiment {
  artifact: string;
  changedPaths: string[];
  sha256: string;
  byteLength: number;
  untrackedCount: number;
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function archivedBlob(content: Buffer): MicroverseArchivedBlob {
  return {
    encoding: 'base64',
    byte_length: content.length,
    sha256: sha256(content),
    data: content.toString('base64'),
  };
}

function archiveLimit(value?: number): number {
  const configured = value ?? Number(process.env.PICKLE_MICROVERSE_ARCHIVE_MAX_BYTES || 64 * 1024 * 1024);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error('Microverse experiment archive byte limit must be a positive safe integer.');
  }
  return configured;
}

function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(value)}.`);
  }
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function runGitBuffer(workingDir: string, args: string[], maxBuffer: number): Buffer {
  const result = spawnSync('git', args, {
    cwd: workingDir,
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : String(result.stderr || '');
    throw new Error(`Unable to capture Microverse experiment archive: ${detail || result.error?.message || `git exited ${result.status}`}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function gitPaths(content: Buffer): string[] {
  return content
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(safeRelativePath);
}

function captureUntrackedEntry(repoRoot: string, relativePath: string): MicroverseArchivedUntrackedEntry {
  const target = path.resolve(repoRoot, ...relativePath.split('/'));
  if (!isInside(repoRoot, target)) throw new Error(`Refusing to archive out-of-repository path ${relativePath}.`);
  const stat = fs.lstatSync(target);
  let content: Buffer;
  let type: 'file' | 'symlink';
  if (stat.isSymbolicLink()) {
    type = 'symlink';
    content = Buffer.from(fs.readlinkSync(target), 'utf8');
  } else if (stat.isFile()) {
    const resolved = fs.realpathSync(target);
    if (!isInside(repoRoot, resolved)) throw new Error(`Refusing to archive out-of-repository path ${relativePath}.`);
    const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) throw new Error(`Refusing to archive non-regular path ${relativePath}.`);
      content = fs.readFileSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    type = 'file';
  } else {
    throw new Error(`Refusing to archive non-file path ${relativePath}.`);
  }
  return {
    path: relativePath,
    type,
    mode: stat.mode & 0o777,
    ...archivedBlob(content),
  };
}

function durableAtomicWrite(filePath: string, content: Buffer): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
    try {
      const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Some platforms do not permit fsync on directories; the file itself is still synced and atomically renamed.
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Captures all changes relative to baseRef in one self-verifying JSON artifact.
 * Tracked changes use git's binary patch format; new files and symlinks are stored byte-for-byte as base64.
 */
export function archiveMicroverseExperiment(
  options: ArchiveMicroverseExperimentOptions,
): ArchivedMicroverseExperiment {
  if (!/^exp-\d{4,}$/.test(options.experimentId)) {
    throw new Error(`Invalid experiment id: ${JSON.stringify(options.experimentId)}.`);
  }
  if (!options.baseRef.trim() || options.baseRef.startsWith('-')) throw new Error('Microverse archive base ref is invalid.');
  const limit = archiveLimit(options.maxArchiveBytes);
  const rootOutput = runGitBuffer(options.workingDir, ['rev-parse', '--show-toplevel'], 1024 * 1024).toString('utf8').trim();
  const repoRoot = fs.realpathSync(rootOutput);
  const trackedPatch = runGitBuffer(
    repoRoot,
    ['diff', '--binary', '--full-index', '--no-ext-diff', options.baseRef, '--'],
    limit + 1,
  );
  let rawBytes = trackedPatch.length;
  if (rawBytes > limit) throw new Error(`Microverse experiment archive exceeds ${limit} bytes.`);

  const excluded = new Set((options.excludeUntrackedPaths || []).map(safeRelativePath));
  const untrackedPaths = gitPaths(runGitBuffer(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    Math.min(limit + 1, 16 * 1024 * 1024),
  )).filter((entry) => !excluded.has(entry));
  const untracked: MicroverseArchivedUntrackedEntry[] = [];
  for (const relativePath of untrackedPaths) {
    const entry = captureUntrackedEntry(repoRoot, relativePath);
    rawBytes += entry.byte_length;
    if (rawBytes > limit) throw new Error(`Microverse experiment archive exceeds ${limit} bytes.`);
    untracked.push(entry);
  }

  const changedPaths = gitPaths(runGitBuffer(
    repoRoot,
    ['diff', '--name-only', '-z', options.baseRef, '--'],
    Math.min(limit + 1, 16 * 1024 * 1024),
  ));
  changedPaths.push(...untrackedPaths);
  const createdAt = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error(`Invalid archive timestamp: ${JSON.stringify(createdAt)}.`);
  const archive: MicroverseExperimentArchive = {
    schema_version: MICROVERSE_EXPERIMENT_ARCHIVE_SCHEMA_VERSION,
    experiment_id: options.experimentId,
    base_ref: options.baseRef,
    created_at: createdAt,
    tracked_patch: archivedBlob(trackedPatch),
    untracked,
  };
  const serialized = Buffer.from(`${JSON.stringify(archive, null, 2)}\n`, 'utf8');

  const sessionRoot = fs.realpathSync(options.sessionDir);
  const experimentDir = path.join(sessionRoot, 'experiments');
  fs.mkdirSync(experimentDir, { recursive: true, mode: 0o700 });
  const resolvedExperimentDir = fs.realpathSync(experimentDir);
  if (!isInside(sessionRoot, resolvedExperimentDir)) throw new Error('Refusing to write experiment archive outside the session directory.');
  const relativeArtifact = path.posix.join('experiments', `${options.experimentId}.archive.json`);
  const artifactPath = path.join(resolvedExperimentDir, `${options.experimentId}.archive.json`);
  durableAtomicWrite(artifactPath, serialized);
  return {
    artifact: relativeArtifact,
    changedPaths: [...new Set(changedPaths)].sort(),
    sha256: sha256(serialized),
    byteLength: serialized.length,
    untrackedCount: untracked.length,
  };
}
