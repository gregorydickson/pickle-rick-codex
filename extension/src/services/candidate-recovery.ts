import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  staged_patch_base64?: string;
  staged_patch_sha256?: string;
  evidence_path: string | null;
  recorded_at: string;
}

function checkpointPath(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, 'rejected-candidates', `${ticketId}.json`);
}

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function decodeStagedPatch(checkpoint: RejectedCandidateCheckpoint): Buffer | null {
  const encoded = checkpoint.staged_patch_base64;
  const expectedHash = checkpoint.staged_patch_sha256;
  if (encoded === undefined && expectedHash === undefined) return null;
  if (typeof encoded !== 'string' || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('rejected-candidate-staged-evidence-invalid: staged patch evidence is incomplete');
  }
  const patch = Buffer.from(encoded, 'base64');
  if (patch.toString('base64') !== encoded || sha256(patch) !== expectedHash) {
    throw new Error('rejected-candidate-staged-evidence-invalid: staged patch hash does not match');
  }
  return patch;
}

export function persistRejectedCandidateCheckpoint(input: {
  sessionDir: string; workingDir: string; ticketId: string; baseHead: string; recoveryRef: string;
  evidencePath?: string | null; stagedPaths?: string[]; stagedPatch?: Buffer;
}): RejectedCandidateCheckpoint {
  git(input.workingDir, ['rev-parse', '--verify', input.recoveryRef]);
  const changedPaths = git(input.workingDir, ['diff', '--name-only', '-z', input.baseHead, input.recoveryRef, '--']).split('\0').filter(Boolean).sort();
  if (changedPaths.length === 0) throw new Error('rejected-candidate-empty: recovery ref contains no candidate changes');
  const checkpoint: RejectedCandidateCheckpoint = {
    schema_version: 1, ticket_id: input.ticketId, base_head: input.baseHead, recovery_ref: input.recoveryRef,
    changed_paths: changedPaths, staged_paths: [...new Set(input.stagedPaths || [])].sort(),
    evidence_path: input.evidencePath || null, recorded_at: new Date().toISOString(),
  };
  if (input.stagedPatch && input.stagedPatch.length > 0) {
    checkpoint.staged_patch_base64 = input.stagedPatch.toString('base64');
    checkpoint.staged_patch_sha256 = sha256(input.stagedPatch);
  }
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
  const stagedPatch = decodeStagedPatch(checkpoint);
  const preflight = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
    cwd: input.workingDir, input: patch, encoding: 'buffer',
  });
  if (preflight.status !== 0) throw new Error(`rejected-candidate-restore-failed: ${String(preflight.stderr || '')}`);
  if (stagedPatch) {
    const stagedPreflight = spawnSync('git', ['apply', '--cached', '--check', '--whitespace=nowarn', '-'], {
      cwd: input.workingDir, input: stagedPatch, encoding: 'buffer',
    });
    if (stagedPreflight.status !== 0) {
      throw new Error(`rejected-candidate-staged-evidence-invalid: ${String(stagedPreflight.stderr || '')}`);
    }
  }
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: input.workingDir, input: patch, encoding: 'buffer' });
  if (applied.status !== 0) throw new Error(`rejected-candidate-restore-failed: ${String(applied.stderr || '')}`);
  if (stagedPatch) {
    const stagedApplied = spawnSync('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
      cwd: input.workingDir, input: stagedPatch, encoding: 'buffer',
    });
    const expectedStaged = [...new Set(checkpoint.staged_paths || [])].sort();
    const actualStaged = stagedApplied.status === 0
      ? git(input.workingDir, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort()
      : [];
    if (stagedApplied.status !== 0 || JSON.stringify(actualStaged) !== JSON.stringify(expectedStaged)) {
      if (stagedApplied.status === 0) {
        spawnSync('git', ['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'], {
          cwd: input.workingDir, input: stagedPatch, encoding: 'buffer',
        });
      }
      spawnSync('git', ['apply', '--reverse', '--whitespace=nowarn', '-'], {
        cwd: input.workingDir, input: patch, encoding: 'buffer',
      });
      throw new Error('rejected-candidate-staged-evidence-invalid: staged patch paths do not match the checkpoint');
    }
  } else {
    for (const relative of checkpoint.staged_paths || []) git(input.workingDir, ['add', '--', relative]);
  }
  return checkpoint;
}

export function clearRejectedCandidateCheckpoint(sessionDir: string, ticketId: string): void {
  fs.rmSync(checkpointPath(sessionDir, ticketId), { force: true });
}
