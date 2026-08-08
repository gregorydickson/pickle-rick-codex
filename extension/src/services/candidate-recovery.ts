import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';

export interface RejectedCandidateCheckpoint {
  schema_version: 1;
  ticket_id: string;
  base_head: string;
  recovery_ref: string;
  changed_paths: string[];
  staged_paths?: string[];
  evidence_path: string | null;
  recorded_at: string;
}

function checkpointPath(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, 'rejected-candidates', `${ticketId}.json`);
}

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function persistRejectedCandidateCheckpoint(input: {
  sessionDir: string; workingDir: string; ticketId: string; baseHead: string; recoveryRef: string;
  evidencePath?: string | null; stagedPaths?: string[];
}): RejectedCandidateCheckpoint {
  git(input.workingDir, ['rev-parse', '--verify', input.recoveryRef]);
  const changedPaths = git(input.workingDir, ['diff', '--name-only', '-z', input.baseHead, input.recoveryRef, '--']).split('\0').filter(Boolean).sort();
  if (changedPaths.length === 0) throw new Error('rejected-candidate-empty: recovery ref contains no candidate changes');
  const checkpoint: RejectedCandidateCheckpoint = {
    schema_version: 1, ticket_id: input.ticketId, base_head: input.baseHead, recovery_ref: input.recoveryRef,
    changed_paths: changedPaths, staged_paths: [...new Set(input.stagedPaths || [])].sort(),
    evidence_path: input.evidencePath || null, recorded_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(checkpointPath(input.sessionDir, input.ticketId)), { recursive: true, mode: 0o700 });
  atomicWriteJson(checkpointPath(input.sessionDir, input.ticketId), checkpoint);
  return checkpoint;
}

export function readRejectedCandidateCheckpoint(sessionDir: string, ticketId: string): RejectedCandidateCheckpoint | null {
  const value = readJsonFile<RejectedCandidateCheckpoint>(checkpointPath(sessionDir, ticketId), null);
  return value?.schema_version === 1 && value.ticket_id === ticketId && Array.isArray(value.changed_paths) ? value : null;
}

export function restoreRejectedCandidateCheckpoint(input: {
  sessionDir: string; workingDir: string; ticketId: string; expectedBaseHead: string; validateScope: (changedPaths: string[]) => void;
}): RejectedCandidateCheckpoint | null {
  const checkpoint = readRejectedCandidateCheckpoint(input.sessionDir, input.ticketId);
  if (!checkpoint || checkpoint.base_head !== input.expectedBaseHead) return null;
  git(input.workingDir, ['rev-parse', '--verify', checkpoint.recovery_ref]);
  input.validateScope(checkpoint.changed_paths);
  const patch = execFileSync('git', ['diff', '--binary', checkpoint.base_head, checkpoint.recovery_ref, '--'], { cwd: input.workingDir, encoding: 'buffer' });
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: input.workingDir, input: patch, encoding: 'buffer' });
  if (applied.status !== 0) throw new Error(`rejected-candidate-restore-failed: ${String(applied.stderr || '')}`);
  for (const relative of checkpoint.staged_paths || []) git(input.workingDir, ['add', '--', relative]);
  return checkpoint;
}

export function clearRejectedCandidateCheckpoint(sessionDir: string, ticketId: string): void {
  fs.rmSync(checkpointPath(sessionDir, ticketId), { force: true });
}
