import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import type { Ticket } from '../types/index.js';
import type { WorkerLifecycleArtifact } from './worker-lifecycle.js';

export interface LifecycleContextCheckpoint {
  schema_version: 1;
  input_hash: string;
  digest: string;
  artifacts: WorkerLifecycleArtifact[];
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function lifecycleContextInputHash(ticket: Ticket, baseHead: string): string {
  return hash({
    base_head: baseHead,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      acceptance_criteria: ticket.acceptance_criteria,
      allowed_paths: ticket.allowed_paths,
      verification: ticket.verification,
      citadel_remediation: ticket.citadel_remediation,
    },
  });
}

function checkpointDir(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, 'worker-lifecycle-checkpoints', ticketId);
}

export function writeLifecycleContextCheckpoint(
  sessionDir: string,
  ticketId: string,
  inputHash: string,
  artifacts: WorkerLifecycleArtifact[],
): LifecycleContextCheckpoint {
  const payload = { schema_version: 1 as const, input_hash: inputHash, artifacts };
  const checkpoint = { ...payload, digest: hash(payload) };
  const dir = checkpointDir(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteJson(path.join(dir, `${checkpoint.digest}.json`), checkpoint);
  atomicWriteJson(path.join(dir, 'current.json'), { digest: checkpoint.digest });
  return checkpoint;
}

export function readLifecycleContextCheckpoint(
  sessionDir: string,
  ticketId: string,
  inputHash: string,
): LifecycleContextCheckpoint | null {
  const dir = checkpointDir(sessionDir, ticketId);
  const pointer = readJsonFile<{ digest?: string }>(path.join(dir, 'current.json'), null);
  if (!pointer?.digest || !/^[a-f0-9]{64}$/.test(pointer.digest)) return null;
  const checkpoint = readJsonFile<LifecycleContextCheckpoint>(path.join(dir, `${pointer.digest}.json`), null);
  if (!checkpoint || checkpoint.schema_version !== 1 || checkpoint.input_hash !== inputHash
    || !Array.isArray(checkpoint.artifacts)) return null;
  const { digest, ...payload } = checkpoint;
  return digest === pointer.digest && hash(payload) === digest ? checkpoint : null;
}
