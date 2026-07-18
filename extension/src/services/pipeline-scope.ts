import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getHeadSha, listWorkingTreeDirtyPaths } from './git-utils.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { normalizePipelineScope } from './pipeline.js';
import { recoverableHardReset } from './recoverable-git.js';
import { normalizeTicketId, readManifest } from './tickets.js';
import { workerLifecycleArtifactPath } from './worker-lifecycle.js';
import type { PipelineContract, Ticket } from '../types/index.js';

export interface ResolvedPipelineScope {
  schema_version: 1;
  working_dir: string;
  source: 'explicit' | 'completed-tickets';
  paths: string[];
}

export class PipelineScopeError extends Error {
  code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(`${code}: ${message}`, options);
    this.name = 'PipelineScopeError';
    this.code = code;
  }
}

function scopeArtifactPath(sessionDir: string): string {
  return path.join(sessionDir, 'pipeline-scope.json');
}

function completed(ticket: Ticket): boolean {
  return String(ticket.status || '').trim().toLowerCase() === 'done';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function implementationChangedPaths(sessionDir: string, ticket: Ticket): string[] {
  const ticketId = normalizeTicketId(String(ticket.id), String(ticket.id));
  const filePath = workerLifecycleArtifactPath(sessionDir, ticketId, 'implement');
  const artifact = readJsonFile<Record<string, unknown>>(filePath, null);
  return stringList(artifact?.files_changed);
}

function collapseScope(paths: string[]): string[] {
  const normalized = normalizePipelineScope(paths);
  return normalized.filter((candidate, index) => !normalized.some((parent, parentIndex) => (
    parentIndex !== index && candidate.startsWith(`${parent}/`)
  )));
}

export function deriveCompletedTicketScope(sessionDir: string): string[] {
  const manifest = readManifest(sessionDir);
  const declaredAndChanged = manifest.tickets
    .filter(completed)
    .flatMap((ticket) => [
      ...stringList(ticket.allowed_paths ?? ticket.allowedPaths ?? ticket.files),
      ...implementationChangedPaths(sessionDir, ticket),
    ]);
  return collapseScope(declaredAndChanged);
}

function validateResolvedScope(value: unknown, pipeline: PipelineContract): ResolvedPipelineScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PipelineScopeError('PIPELINE_SCOPE_INVALID', 'pipeline-scope.json must be a JSON object');
  }
  const raw = value as Record<string, unknown>;
  const paths = collapseScope(stringList(raw.paths));
  if (typeof raw.working_dir !== 'string' || !path.isAbsolute(raw.working_dir)) {
    throw new PipelineScopeError('PIPELINE_SCOPE_INVALID', 'pipeline-scope.json working_dir must be absolute');
  }
  const workingDir = fs.realpathSync(raw.working_dir);
  if (raw.schema_version !== 1 || !['explicit', 'completed-tickets'].includes(String(raw.source))) {
    throw new PipelineScopeError('PIPELINE_SCOPE_INVALID', 'pipeline-scope.json identity is malformed');
  }
  if (workingDir !== fs.realpathSync(pipeline.working_dir)) {
    throw new PipelineScopeError('PIPELINE_SCOPE_IMMUTABLE', 'resolved scope belongs to a different working directory');
  }
  if (pipeline.scope.length > 0 && JSON.stringify(paths) !== JSON.stringify(collapseScope(pipeline.scope))) {
    throw new PipelineScopeError('PIPELINE_SCOPE_IMMUTABLE', 'resolved scope differs from immutable pipeline scope');
  }
  if (paths.length === 0) {
    throw new PipelineScopeError('PIPELINE_SCOPE_EMPTY', 'optional mutation phases require at least one safe repository-relative scope path');
  }
  return {
    schema_version: 1,
    working_dir: workingDir,
    source: raw.source as ResolvedPipelineScope['source'],
    paths,
  };
}

export function resolvePipelineScope(sessionDir: string, pipeline: PipelineContract): ResolvedPipelineScope {
  const filePath = scopeArtifactPath(sessionDir);
  if (fs.existsSync(filePath)) {
    return validateResolvedScope(readJsonFile(filePath, null), pipeline);
  }
  const paths = pipeline.scope.length > 0 ? collapseScope(pipeline.scope) : deriveCompletedTicketScope(sessionDir);
  if (paths.length === 0) {
    throw new PipelineScopeError(
      'PIPELINE_SCOPE_EMPTY',
      'could not derive a safe optional-loop scope from completed ticket allowed_paths/files_changed; pass --scope <repo-relative-path> or skip optional loops',
    );
  }
  const resolved: ResolvedPipelineScope = {
    schema_version: 1,
    working_dir: fs.realpathSync(pipeline.working_dir),
    source: pipeline.scope.length > 0 ? 'explicit' : 'completed-tickets',
    paths,
  };
  atomicWriteJson(filePath, resolved);
  return resolved;
}

export function pathIsInPipelineScope(relativePath: string, allowedPaths: string[]): boolean {
  const [candidate] = normalizePipelineScope([relativePath]);
  return allowedPaths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`));
}

function committedPathsSince(workingDir: string, beforeHead: string): string[] {
  const currentHead = getHeadSha(workingDir);
  if (!beforeHead || !currentHead || beforeHead === currentHead) return [];
  return execFileSync('git', ['diff', '--name-only', '-z', beforeHead, currentHead, '--'], {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 30_000,
  }).split('\0').filter(Boolean);
}

export function enforceLoopMutationScope(options: {
  sessionDir: string;
  workingDir: string;
  mode: string;
  beforeHead: string;
  allowedPaths: string[];
  preserveUntracked?: string[];
  log?: (message: string) => void;
}): string[] {
  const allowedPaths = collapseScope(options.allowedPaths);
  if (allowedPaths.length === 0) {
    throw new PipelineScopeError('PIPELINE_SCOPE_EMPTY', `${options.mode} has no safe mutation scope`);
  }
  const changed = collapseScope([
    ...committedPathsSince(options.workingDir, options.beforeHead),
    ...listWorkingTreeDirtyPaths(options.workingDir),
  ]);
  const outside = changed.filter((candidate) => !pathIsInPipelineScope(candidate, allowedPaths));
  if (outside.length === 0) return changed;

  const session = path.basename(options.sessionDir).replace(/[^A-Za-z0-9._-]/g, '-');
  recoverableHardReset({
    workingDir: options.workingDir,
    sessionDir: options.sessionDir,
    targetHead: options.beforeHead,
    operation: `${options.mode}-scope-violation`,
    preserveUntracked: options.preserveUntracked,
    headRecoveryRef: `refs/pickle/optional-loop-recovery/${session}/${options.mode}`,
    log: options.log,
  });
  throw new PipelineScopeError(
    'PIPELINE_SCOPE_VIOLATION',
    `${options.mode} touched paths outside immutable scope (${allowedPaths.join(', ')}): ${outside.join(', ')}; iteration was archived and rolled back`,
  );
}
