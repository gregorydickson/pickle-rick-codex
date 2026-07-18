import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ProtectedPathManifest {
  schema_version: 1;
  patterns: string[];
  files: Record<string, string>;
}

function normalizePattern(value: string): string {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Protected paths must be non-empty repository-relative paths or globs; received ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function gitPathspec(pattern: string): string {
  return /[*?[]/.test(pattern) ? `:(glob)${pattern}` : pattern;
}

function listProtectedFiles(workingDir: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const output = execFileSync('git', [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
    '--',
    ...patterns.map(gitPathspec),
  ], {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter(Boolean))]
    .filter((relativePath) => fs.existsSync(path.join(workingDir, relativePath)))
    .sort();
}

function hashPath(workingDir: string, relativePath: string): string {
  const absolutePath = path.join(workingDir, relativePath);
  const stat = fs.lstatSync(absolutePath);
  const hash = crypto.createHash('sha256');
  hash.update(relativePath);
  hash.update('\0');
  if (stat.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(fs.readlinkSync(absolutePath));
  } else if (stat.isFile()) {
    hash.update('file\0');
    hash.update(fs.readFileSync(absolutePath));
  } else {
    hash.update(`unsupported:${stat.mode}`);
  }
  return hash.digest('hex');
}

export function captureProtectedPathManifest(
  workingDir: string,
  requestedPatterns: unknown,
): ProtectedPathManifest {
  const patterns = [...new Set(
    (Array.isArray(requestedPatterns) ? requestedPatterns : [])
      .map((entry) => normalizePattern(String(entry))),
  )].sort();
  const files = Object.fromEntries(
    listProtectedFiles(workingDir, patterns).map((relativePath) => [
      relativePath,
      hashPath(workingDir, relativePath),
    ]),
  );
  return { schema_version: 1, patterns, files };
}

export function changedProtectedPaths(
  workingDir: string,
  manifest: ProtectedPathManifest,
): string[] {
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.patterns) || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Invalid Microverse protected-path manifest.');
  }
  const current = captureProtectedPathManifest(workingDir, manifest.patterns);
  return [...new Set([
    ...Object.keys(manifest.files),
    ...Object.keys(current.files),
  ])].filter((relativePath) => manifest.files[relativePath] !== current.files[relativePath]).sort();
}
