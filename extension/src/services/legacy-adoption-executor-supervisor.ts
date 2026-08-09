import { spawn, spawnSync } from 'node:child_process';
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
import { readTmuxRunnerBinding, tmuxSessionExists, type TmuxRunnerBinding } from './tmux.js';

export const LEGACY_ADOPTION_EXECUTOR_FILE = 'legacy-session-adoption-executor.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_FILE = 'legacy-session-adoption-executor-restart.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE = 'legacy-session-adoption-executor-restart-rejected.json';

export interface LegacyAdoptionExecutorStatus {
  schema_version: 1;
  session_id: string;
  status: 'supervising' | 'launched' | 'cancelled' | 'terminal';
  manager_identity: PersistedProcessIdentity;
  manager_generation: number;
  manager_parent_pid: number;
  manager_argv_sha256: string;
  owner_nonce: string;
  executor_identity: PersistedProcessIdentity | null;
  executor_generation: number;
  executor_started_at: string | null;
  executor_lease_expires_at: string | null;
  executor_spec_sha256: string;
  replacement_count: number;
  last_loss_at: string | null;
  last_restart_request_id: string | null;
  updated_at: string;
}

export interface LegacyAdoptionExecutorRestartRequest {
  schema_version: 1;
  request_id: string;
  expected_generation: number;
  expected_executor_fingerprint: string;
  reason: string;
  requested_at: string;
}

export interface LegacyAdoptionExecutorSpec {
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
  validationSessionDir?: string;
  ownerNonce?: string;
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

export function legacyAdoptionExecutorArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [
    path.resolve(fileURLToPath(new URL('../bin/adopt-legacy-session.js', import.meta.url))),
    'watch', '--session-dir', spec.sessionDir,
    '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot,
  ];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  if (spec.ownerNonce) args.push('--owner-nonce', spec.ownerNonce);
  return args;
}

function spawnExecutor(spec: LegacyAdoptionExecutorSpec): number {
  const child = spawn(process.execPath, legacyAdoptionExecutorArgs(spec), { detached: true, stdio: 'ignore', env: process.env });
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

export function legacyAdoptionExecutorSpecHash(spec: LegacyAdoptionExecutorSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    sessionDir: fs.realpathSync(spec.sessionDir),
    sourceRuntimeRoot: fs.realpathSync(spec.sourceRuntimeRoot),
    targetRuntimeRoot: fs.realpathSync(spec.targetRuntimeRoot),
    validationSessionDir: spec.validationSessionDir ? fs.realpathSync(spec.validationSessionDir) : '',
    ownerNonce: spec.ownerNonce || '',
  })).digest('hex');
}

function parentPid(pid: number): number {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    if (raw.length > 3) return Number(raw[3]);
  } catch { /* macOS uses ps below */ }
  const result = requirePs(pid);
  return result;
}

function requirePs(pid: number): number {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 5_000 });
  const value = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isInteger(value) || value <= 0) throw new Error('Could not capture adoption supervisor parent pid.');
  return value;
}

export function readLegacyAdoptionExecutorStatus(sessionDir: string): LegacyAdoptionExecutorStatus | null {
  const status = readJsonFile<LegacyAdoptionExecutorStatus>(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), null);
  if (!status || status.schema_version !== 1 || status.session_id !== path.basename(sessionDir)
    || !status.manager_identity?.fingerprint || !Number.isInteger(status.manager_generation)
    || status.manager_generation < 1 || !Number.isInteger(status.manager_parent_pid) || status.manager_parent_pid <= 0
    || !status.manager_argv_sha256 || typeof status.owner_nonce !== 'string'
    || !Number.isInteger(status.executor_generation)
    || status.executor_generation < 0 || typeof status.executor_spec_sha256 !== 'string') return null;
  return status;
}

function processArgv(pid: number): string[] | null {
  try {
    const content = fs.readFileSync(`/proc/${pid}/cmdline`);
    return content.toString('utf8').split('\0').filter(Boolean);
  } catch {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    return result.stdout.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) || null;
  }
}

function exactArgv(actual: string[] | null, expected: string[]): boolean {
  return Boolean(actual && actual.length === expected.length
    && actual.every((token, index) => path.resolve(token) === path.resolve(expected[index] || '')));
}

function authenticatedManagerArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [path.resolve(fileURLToPath(new URL('../bin/legacy-adoption-executor-supervisor.js', import.meta.url))),
    '--session-dir', spec.sessionDir, '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  if (spec.ownerNonce) args.push('--owner-nonce', spec.ownerNonce);
  return args;
}

interface PersistedSupervisorOwnerAuthority {
  schema_version: 1;
  session_id: string;
  status: 'booting' | 'ready' | 'terminal';
  binding: TmuxRunnerBinding;
  supervisor_identity_fingerprint: string | null;
  supervisor_generation: number;
  launch_nonce: string;
  executor_spec_sha256: string;
}

export function readAuthenticatedLegacyAdoptionExecutorStatus(
  spec: Omit<LegacyAdoptionExecutorSpec, 'ownerNonce'>,
): LegacyAdoptionExecutorStatus | null {
  const sessionDir = fs.realpathSync(spec.sessionDir);
  const status = readLegacyAdoptionExecutorStatus(sessionDir);
  const owner = readJsonFile<PersistedSupervisorOwnerAuthority>(
    path.join(sessionDir, 'legacy-session-adoption-supervisor-owner.json'), null,
  );
  if (!status || status.status !== 'supervising' || !status.executor_identity || !owner
    || owner.schema_version !== 1 || owner.session_id !== path.basename(sessionDir) || owner.status !== 'ready'
    || !owner.launch_nonce || owner.launch_nonce !== status.owner_nonce
    || !Number.isInteger(owner.supervisor_generation) || owner.supervisor_generation < 1
    || status.manager_generation < owner.supervisor_generation
    || (status.manager_generation === owner.supervisor_generation
      && owner.supervisor_identity_fingerprint !== status.manager_identity.fingerprint)
    || status.executor_spec_sha256 !== owner.executor_spec_sha256
    || status.executor_spec_sha256 !== legacyAdoptionExecutorSpecHash({ ...spec, sessionDir, ownerNonce: owner.launch_nonce })
    || status.manager_parent_pid !== owner.binding.pane_pid
    || inspectProcessLivenessIdentity(status.manager_identity) !== 'matched'
    || inspectProcessLivenessIdentity(status.executor_identity) !== 'matched'
    || !tmuxSessionExists(owner.binding.session_name)) return null;
  const liveBinding = readTmuxRunnerBinding(owner.binding.pane_id);
  if (!liveBinding || JSON.stringify(liveBinding) !== JSON.stringify(owner.binding)) return null;
  const managerArgs = [process.execPath, ...authenticatedManagerArgs({
    ...spec, sessionDir, ownerNonce: owner.launch_nonce,
  })];
  const executor = [process.execPath, ...legacyAdoptionExecutorArgs({
    ...spec, sessionDir, ownerNonce: owner.launch_nonce,
  })];
  if (status.manager_argv_sha256 !== crypto.createHash('sha256').update(JSON.stringify(managerArgs)).digest('hex')
    || !exactArgv(processArgv(status.manager_identity.pid), managerArgs)
    || !exactArgv(processArgv(status.executor_identity.pid), executor)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(sessionDir, `${LEGACY_ADOPTION_EXECUTOR_FILE}.lock`), 'utf8')) as Record<string, unknown>;
    if (lock.pid !== status.manager_identity.pid) return null;
  } catch {
    return null;
  }
  return status;
}

export function requestLegacyAdoptionExecutorRestart(sessionDir: string, reason: string): LegacyAdoptionExecutorRestartRequest {
  const status = readLegacyAdoptionExecutorStatus(sessionDir);
  if (!status?.executor_identity || status.status !== 'supervising') {
    throw new Error('Legacy adoption executor restart requires an authenticated supervising executor.');
  }
  const request: LegacyAdoptionExecutorRestartRequest = {
    schema_version: 1,
    request_id: crypto.randomUUID(),
    expected_generation: status.executor_generation,
    expected_executor_fingerprint: status.executor_identity.fingerprint,
    reason: String(reason || 'strategy-requested restart'),
    requested_at: new Date().toISOString(),
  };
  atomicWriteJson(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), request);
  return request;
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
    const hash = legacyAdoptionExecutorSpecHash({ ...spec, sessionDir });
    const managerArgvSha256 = crypto.createHash('sha256').update(JSON.stringify(process.argv)).digest('hex');
    const managerParentPid = parentPid(process.pid);
    const prior = readJsonFile<LegacyAdoptionExecutorStatus>(statusPath, null);
    if (prior && (prior.schema_version !== 1 || prior.session_id !== path.basename(sessionDir)
      || prior.executor_spec_sha256 !== hash)) throw new Error('Persisted adoption executor supervision contract is invalid.');
    let executor = prior?.executor_identity || null;
    const managerGeneration = (prior?.manager_generation || 0)
      + (prior?.manager_identity?.fingerprint === managerIdentity.fingerprint ? 0 : 1);
    let generation = prior?.executor_generation || 0;
    let replacements = prior?.replacement_count || 0;
    let lastLossAt = prior?.last_loss_at || null;
    let lastRestartRequestId = prior?.last_restart_request_id || null;
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
          manager_identity: managerIdentity, manager_generation: managerGeneration,
          manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
          owner_nonce: spec.ownerNonce || '',
          executor_identity: null, executor_generation: generation,
          executor_started_at: null, executor_lease_expires_at: null, executor_spec_sha256: hash,
          replacement_count: replacements, last_loss_at: lastLossAt,
          last_restart_request_id: lastRestartRequestId, updated_at: timestamp,
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
      const restartPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE);
      const restart = readJsonFile<LegacyAdoptionExecutorRestartRequest>(restartPath, null);
      if (restart) {
        if (restart.schema_version !== 1 || !restart.request_id
          || restart.expected_generation !== generation
          || restart.expected_executor_fingerprint !== executor.fingerprint) {
          atomicWriteJson(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), {
            ...restart, rejected_at: new Date(now()).toISOString(),
            rejection_reason: 'request does not match the authenticated executor generation and fingerprint',
          });
          fs.rmSync(restartPath, { force: true });
        } else {
          reapExecutor(executor, reap);
          executor = null;
          replacements += 1;
          lastLossAt = new Date(now()).toISOString();
          lastRestartRequestId = restart.request_id;
          fs.rmSync(restartPath, { force: true });
          continue;
        }
      }
      const timestamp = new Date(now()).toISOString();
      const status: LegacyAdoptionExecutorStatus = {
        schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
        manager_identity: managerIdentity, manager_generation: managerGeneration,
        manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
        owner_nonce: spec.ownerNonce || '',
        executor_identity: executor, executor_generation: generation,
        executor_started_at: prior?.executor_identity?.fingerprint === executor.fingerprint
          ? prior.executor_started_at : timestamp,
        executor_lease_expires_at: new Date(now() + leaseMs).toISOString(), executor_spec_sha256: hash,
        replacement_count: replacements, last_loss_at: lastLossAt, updated_at: timestamp,
        last_restart_request_id: lastRestartRequestId,
      };
      atomicWriteJson(statusPath, status);
      deps.onIteration?.(status);
      wait(pollMs);
    }
  } finally {
    manager.releaseLock(statusPath);
  }
}
