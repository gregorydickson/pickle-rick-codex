import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalPipeline } from './durable-supervisor.js';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  reapRecordedLiveProcessGroup,
  type OrphanReapResult,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';

export const LEGACY_ADOPTION_EXECUTOR_FILE = 'legacy-session-adoption-executor.json';

export interface LegacyAdoptionExecutorStatus {
  schema_version: 1;
  session_id: string;
  status: 'supervising' | 'launched' | 'cancelled' | 'terminal';
  manager_identity: PersistedProcessIdentity;
  executor_identity: PersistedProcessIdentity | null;
  executor_generation: number;
  executor_started_at: string | null;
  executor_lease_expires_at: string | null;
  executor_spec_sha256: string;
  replacement_count: number;
  last_loss_at: string | null;
  updated_at: string;
}

export interface LegacyAdoptionExecutorSpec {
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
  validationSessionDir?: string;
}

interface Dependencies {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  managerIdentity?: PersistedProcessIdentity;
  spawnExecutor?: (spec: LegacyAdoptionExecutorSpec) => number;
  capture?: (pid: number) => PersistedProcessIdentity | null;
  inspect?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused';
  reap?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  outcome?: (sessionDir: string) => 'running' | 'launched' | 'cancelled' | 'terminal';
  onIteration?: (status: LegacyAdoptionExecutorStatus) => void;
  leaseMs?: number;
  pollMs?: number;
}

function reapExecutor(
  identity: PersistedProcessIdentity,
  reap: NonNullable<Dependencies['reap']>,
): void {
  const result = reap(identity);
  if (result.status !== 'reaped' && result.status !== 'not-running') {
    throw new Error(`Adoption executor ${identity.pid} could not be safely reaped: ${result.status}: ${result.reason}`);
  }
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function executorArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [
    path.resolve(fileURLToPath(new URL('../bin/adopt-legacy-session.js', import.meta.url))),
    'watch', '--session-dir', spec.sessionDir,
    '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot,
  ];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  return args;
}

function spawnExecutor(spec: LegacyAdoptionExecutorSpec): number {
  const child = spawn(process.execPath, executorArgs(spec), { detached: true, stdio: 'ignore', env: process.env });
  if (!child.pid) throw new Error('Could not start the legacy adoption watchdog executor.');
  child.unref();
  return child.pid;
}

function defaultOutcome(sessionDir: string): 'running' | 'launched' | 'cancelled' | 'terminal' {
  const record = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'legacy-session-adoption.json'), null);
  if (record?.status === 'launched') return 'launched';
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  if (state?.cancel_requested_at || state?.cancelled === true) return 'cancelled';
  try {
    if (readLogicalPipeline(sessionDir).terminal_state !== null) return 'terminal';
  } catch {
    // Adoption may still be fencing the legacy session.
  }
  return 'running';
}

function specHash(spec: LegacyAdoptionExecutorSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    sessionDir: fs.realpathSync(spec.sessionDir),
    sourceRuntimeRoot: fs.realpathSync(spec.sourceRuntimeRoot),
    targetRuntimeRoot: fs.realpathSync(spec.targetRuntimeRoot),
    validationSessionDir: spec.validationSessionDir ? fs.realpathSync(spec.validationSessionDir) : '',
  })).digest('hex');
}

export function runLegacyAdoptionExecutorSupervisor(
  spec: LegacyAdoptionExecutorSpec,
  deps: Dependencies = {},
): LegacyAdoptionExecutorStatus {
  const sessionDir = fs.realpathSync(spec.sessionDir);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE);
  const manager = new StateManager({ acquireTimeoutMs: 1_000, staleLockThresholdMs: 0 });
  manager.acquireLock(statusPath);
  try {
    const now = deps.now || Date.now;
    const wait = deps.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
    const inspect = deps.inspect || inspectProcessLivenessIdentity;
    const capture = deps.capture || captureProcessLivenessIdentity;
    const reap = deps.reap || reapRecordedLiveProcessGroup;
    const leaseMs = Math.max(1_000, deps.leaseMs ?? 30_000);
    const pollMs = Math.max(10, Math.min(leaseMs / 3, deps.pollMs ?? 1_000));
    const managerIdentity = deps.managerIdentity || capture(process.pid);
    if (!managerIdentity) throw new Error('Could not capture immutable adoption supervisor identity.');
    const hash = specHash({ ...spec, sessionDir });
    const prior = readJsonFile<LegacyAdoptionExecutorStatus>(statusPath, null);
    if (prior && (prior.schema_version !== 1 || prior.session_id !== path.basename(sessionDir)
      || prior.executor_spec_sha256 !== hash)) throw new Error('Persisted adoption executor supervision contract is invalid.');
    let executor = prior?.executor_identity || null;
    let generation = prior?.executor_generation || 0;
    let replacements = prior?.replacement_count || 0;
    let lastLossAt = prior?.last_loss_at || null;
    const priorLeaseLive = prior?.executor_lease_expires_at
      && Date.parse(prior.executor_lease_expires_at) > now();
    if (executor && (!priorLeaseLive || inspect(executor) !== 'matched')) {
      if (inspect(executor) === 'matched') reapExecutor(executor, reap);
      executor = null;
      replacements += 1;
      lastLossAt = new Date(now()).toISOString();
    }
    for (;;) {
      const outcome = (deps.outcome || defaultOutcome)(sessionDir);
      if (outcome !== 'running') {
        if (executor && inspect(executor) === 'matched') {
          reapExecutor(executor, reap);
        }
        const timestamp = new Date(now()).toISOString();
        const terminal: LegacyAdoptionExecutorStatus = {
          schema_version: 1, session_id: path.basename(sessionDir), status: outcome,
          manager_identity: managerIdentity, executor_identity: null, executor_generation: generation,
          executor_started_at: null, executor_lease_expires_at: null, executor_spec_sha256: hash,
          replacement_count: replacements, last_loss_at: lastLossAt, updated_at: timestamp,
        };
        atomicWriteJson(statusPath, terminal);
        return terminal;
      }
      if (!executor) {
        const pid = (deps.spawnExecutor || spawnExecutor)({ ...spec, sessionDir });
        executor = capture(pid);
        if (!executor) throw new Error(`Could not capture immutable adoption executor identity for pid ${pid}.`);
        generation += 1;
      }
      if (inspect(executor) !== 'matched') {
        executor = null;
        replacements += 1;
        lastLossAt = new Date(now()).toISOString();
        continue;
      }
      const timestamp = new Date(now()).toISOString();
      const status: LegacyAdoptionExecutorStatus = {
        schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
        manager_identity: managerIdentity, executor_identity: executor, executor_generation: generation,
        executor_started_at: prior?.executor_identity?.fingerprint === executor.fingerprint
          ? prior.executor_started_at : timestamp,
        executor_lease_expires_at: new Date(now() + leaseMs).toISOString(), executor_spec_sha256: hash,
        replacement_count: replacements, last_loss_at: lastLossAt, updated_at: timestamp,
      };
      atomicWriteJson(statusPath, status);
      deps.onIteration?.(status);
      wait(pollMs);
    }
  } finally {
    manager.releaseLock(statusPath);
  }
}
