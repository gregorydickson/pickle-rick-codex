#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
  type InstalledRuntimeDescriptor,
} from '../services/durable-supervisor.js';
import { prepareLiveSessionMigration } from '../services/live-session-migration.js';

interface HandoffSpec {
  session_dir: string;
  source_owner_id: string;
  source_token: string;
  source_runtime: InstalledRuntimeDescriptor;
  target_runtime: InstalledRuntimeDescriptor;
  runner_bin?: 'mux-runner.js' | 'pipeline-runner.js';
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function pendingRequestId(sessionDir: string, target: InstalledRuntimeDescriptor): string | null {
  const state = readLogicalPipeline(sessionDir);
  const completed = new Set(state.events.filter((event) => event.kind === 'runtime_handoff_completed')
    .map((event) => String(event.details.request_id)));
  return [...state.events].reverse().find((event) => event.kind === 'runtime_handoff_requested'
    && !completed.has(String(event.details.request_id))
    && JSON.stringify(event.details.target_runtime) === JSON.stringify(target))?.details.request_id as string | null ?? null;
}

export function runRuntimeHandoff(specPath: string): void {
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8')) as HandoffSpec;
  const sessionDir = path.resolve(spec.session_dir);
  let requestId = pendingRequestId(sessionDir, spec.target_runtime);
  if (!requestId) {
    const migration = prepareLiveSessionMigration(sessionDir, spec.source_runtime, spec.target_runtime);
    requestId = requestRuntimeHandoff(
      sessionDir,
      spec.source_owner_id,
      spec.source_token,
      spec.source_runtime,
      spec.target_runtime,
      { ...migration.resume_checkpoint },
    );
    releaseRuntimeHandoffLease(sessionDir, spec.source_owner_id, spec.source_token, requestId);
  }

  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const runnerBin = spec.runner_bin ?? 'mux-runner.js';
  const supervisor = spawn(process.execPath, [
    path.join(runtimeBin, 'supervised-runner.js'),
    sessionDir,
    `--runner-bin=${runnerBin}`,
    `--handoff-request=${requestId}`,
    `--target-runtime=${Buffer.from(JSON.stringify(spec.target_runtime)).toString('base64url')}`,
  ], { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env });
  supervisor.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = readLogicalPipeline(sessionDir);
    const completed = state.events.find((event) => event.kind === 'runtime_handoff_completed'
      && event.details.request_id === requestId);
    if (completed && state.lease?.owner_identity?.pid) {
      process.stdout.write(`${JSON.stringify({ request_id: requestId, supervisor_pid: supervisor.pid, lease: state.lease })}\n`);
      return;
    }
    Atomics.wait(waitBuffer, 0, 0, 25);
  }
  throw new Error(`Green runtime did not accept handoff ${requestId} within 10 seconds.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('Usage: node bin/runtime-handoff.js <handoff-spec.json>');
  runRuntimeHandoff(specPath);
}
