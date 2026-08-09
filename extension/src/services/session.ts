import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureConfigFile, loadConfig } from './config.js';
import { logActivity } from './activity-logger.js';
import {
  atomicWriteJson,
  ensureDir,
  getSessionsRoot,
  nowIso,
} from './pickle-utils.js';
import { commitExists, getHeadSha, isGitRepo } from './git-utils.js';
import { cancelPipelineSession, isPipelineSession } from './pipeline-state.js';
import {
  findLastSessionForCwd,
  getSessionForCwd,
  pruneSessionMap,
  removeSessionMapEntry,
  updateSessionMap,
  withSessionMapLock,
} from './session-map.js';
import { StateManager } from './state-manager.js';
import type { PersistedState } from './state-manager.js';
import type { Config } from '../types/index.js';
import { tmuxSessionExists } from './tmux.js';
import { inspectProcessLivenessIdentity, recoverSessionOrphanState, type PersistedProcessIdentity } from './orphan-reaper.js';
import {
  validateAutonomousOwnerSpec,
  ensureAutonomousOwnerRecoveryDaemon,
  authenticateProcessOwnerRuntime,
  deriveAutonomousProcessOwnerSpec,
  type AutonomousOwnerRestorationIntent,
  type AutonomousOwnerSpec,
} from './autonomous-owner-recovery.js';
import { scheduleAuthenticatedLegacyMaxTimeRollover, scheduleAutonomousBudgetRollover } from './autonomous-budget.js';
import { assertPrdSealMatchesPrd, readPrdSeal } from './prd-seal.js';
import { readLogicalPipeline } from './durable-supervisor.js';
import { describeInstalledRuntime } from './runtime-descriptor.js';
import { acquireCwdReservationLocks } from './detached-launch.js';

export interface SessionResult {
  sessionDir: string;
  state: PersistedState;
}

const cwdAuthorityQueues = new Map<string, Promise<void>>();

async function withInProcessCwdQueue<T>(
  normalizedCwd: string,
  callback: () => Promise<T>,
): Promise<T> {
  const prior = cwdAuthorityQueues.get(normalizedCwd) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = prior.then(() => gate);
  cwdAuthorityQueues.set(normalizedCwd, queued);
  await prior;
  try {
    return await callback();
  } finally {
    releaseQueue();
    if (cwdAuthorityQueues.get(normalizedCwd) === queued) cwdAuthorityQueues.delete(normalizedCwd);
  }
}

async function withFilesystemCwdAuthority<T>(normalizedCwd: string, callback: () => Promise<T>): Promise<T> {
  const manager = new StateManager();
  const authorityPath = cwdAuthorityPath(normalizedCwd);
  let acquired = false;
  try {
    manager.acquireLock(authorityPath);
    acquired = true;
    return await callback();
  } finally {
    if (acquired) manager.releaseLock(authorityPath);
  }
}

async function withCwdAuthorityLock<T>(normalizedCwd: string, callback: () => Promise<T>): Promise<T> {
  return withInProcessCwdQueue(normalizedCwd, () => withFilesystemCwdAuthority(normalizedCwd, callback));
}

interface CreateInitialStateArgs {
  cwd: string;
  prompt: string;
  sessionDir: string;
  config?: Config;
  overrides?: Record<string, unknown>;
}

interface CreateSessionArgs {
  cwd?: string;
  prompt: string;
  overrides?: Record<string, unknown>;
  updateMap?: boolean;
}

interface ResolveSessionForCwdOptions {
  last?: boolean;
}

interface ReconcileSessionLivenessOptions {
  allowLegacyMaxTimeMigration?: boolean;
}

export function getStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'state.json');
}

export function createInitialState({
  cwd,
  prompt,
  sessionDir,
  config = loadConfig(),
  overrides = {},
}: CreateInitialStateArgs): PersistedState {
  const now = new Date();
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const state: PersistedState = {
    active: true,
    working_dir: cwd,
    step: 'prd',
    iteration: 0,
    max_iterations: config.defaults.max_iterations,
    max_time_minutes: config.defaults.max_time_minutes,
    worker_timeout_seconds: config.defaults.worker_timeout_seconds,
    start_time_epoch: epochSeconds,
    original_prompt: prompt,
    current_ticket: null,
    history: [],
    started_at: now.toISOString(),
    run_start_time_epoch: epochSeconds,
    run_started_at: now.toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    tmux_mode: false,
    command_template: null,
    session_map_cwds: [cwd],
    pipeline_mode: false,
    pipeline_phase: null,
    pipeline_total_phases: null,
    pipeline_phase_index: null,
    pipeline_working_dir: null,
    pipeline_target: null,
    pipeline_bootstrap_source: null,
    pipeline_bootstrap_prd: null,
    pipeline_task: null,
    pipeline_phases: null,
    pipeline_skip_flags: null,
    start_commit: isGitRepo(cwd) ? getHeadSha(cwd) : null,
    pinned_sha: isGitRepo(cwd) ? getHeadSha(cwd) : null,
    quality_baseline: null,
    manager_relaunch_count: 0,
    manager_relaunch_history: [],
    manager_relaunch_recovery_epoch: 1,
    manager_relaunch_recovery_route: 'standard_relaunch',
    manager_relaunch_strategy_hash: null,
    ...overrides,
  };
  if (state.active === false) {
    state.run_start_time_epoch = null;
    state.run_started_at = null;
  }
  return state;
}

export async function createSession({
  cwd = process.cwd(),
  prompt,
  overrides = {},
  updateMap = true,
}: CreateSessionArgs): Promise<SessionResult> {
  ensureConfigFile();
  const config = loadConfig();
  ensureDir(getSessionsRoot());
  return withCwdAuthorityLock(normalizeSessionCwd(cwd), async () => {
  const sessionId = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
  const sessionDir = path.join(getSessionsRoot(), sessionId);
  ensureDir(sessionDir);

  const state = createInitialState({
    cwd,
    prompt,
    sessionDir,
    config,
    overrides,
  });

  atomicWriteJson(getStatePath(sessionDir), state);
  if (updateMap) {
    await updateSessionMap(cwd, sessionDir);
  }
  await pruneSessionMap();
  logActivity({
    event: 'session_start',
    source: 'pickle',
    session: sessionId,
    original_prompt: prompt,
  }, { enabled: config.defaults.activity_logging });

    return { sessionDir, state };
  });
}

export function loadSessionState(sessionDir: string, stateManager: StateManager = new StateManager()): PersistedState {
  return stateManager.read(getStatePath(sessionDir));
}

export function readOrInitSessionState(
  sessionDir: string,
  createDefault: () => PersistedState,
  stateManager: StateManager = new StateManager(),
): PersistedState {
  return stateManager.readOrReinitialize(getStatePath(sessionDir), createDefault);
}

export function appendHistory(state: PersistedState, step: string, ticket?: unknown): void {
  state.history ??= [];
  (state.history as unknown[]).push({
    step,
    ticket,
    timestamp: nowIso(),
  });
}

export function getRunStartEpoch(state: PersistedState): number {
  const preciseIso = state.run_started_at || (
    state.active === false && state.last_exit_reason == null
      ? null
      : state.started_at
  );
  if (typeof preciseIso === 'string') {
    const parsed = Date.parse(preciseIso);
    if (Number.isFinite(parsed)) {
      return parsed / 1000;
    }
  }
  if (state.run_start_time_epoch != null) {
    return Number(state.run_start_time_epoch || 0);
  }
  if (state.active === false && state.last_exit_reason == null) {
    return 0;
  }
  return Number(state.start_time_epoch || 0);
}

export function markRunStart(state: PersistedState, now: Date = new Date()): PersistedState {
  state.run_start_time_epoch = Math.floor(now.getTime() / 1000);
  state.run_started_at = now.toISOString();
  return state;
}

export function normalizeSessionCwd(cwd: string): string {
  if (typeof cwd !== 'string' || !cwd) {
    return cwd;
  }
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function cwdAuthorityPath(normalizedCwd: string): string {
  const digest = crypto.createHash('sha256').update(normalizedCwd).digest('hex');
  return path.join(getSessionsRoot(), `.cwd-authority-${digest}`);
}

export function getSessionMapCwds(state: PersistedState): string[] {
  const values: string[] = [];
  const pushUnique = (value: unknown): void => {
    if (typeof value !== 'string' || !value) {
      return;
    }
    if (!values.includes(value)) {
      values.push(value);
    }
  };

  if (Array.isArray(state?.session_map_cwds)) {
    state.session_map_cwds.forEach(pushUnique);
  }
  pushUnique(state?.working_dir);
  return values;
}

function isProcessAlive(pid: unknown): boolean {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pgid: unknown): boolean {
  const normalized = Number(pgid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(-normalized, 0);
    return true;
  } catch {
    return false;
  }
}

interface LegacyMaxTimeMigrationEvidence {
  sourceStateSha256: string;
  sourceHistoryLength: number;
  prdSealHash: string;
  startCommit: string;
  pinnedSha: string | null;
  ownerSpecId: string;
  targetOwnerSpec: AutonomousOwnerSpec;
  targetRuntimeRoot: string;
  targetRuntime: Record<string, unknown>;
}

function validLegacyMaxTimeMigrationTransaction(
  value: unknown,
  state: PersistedState,
  sessionDir: string,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const transaction = value as Record<string, unknown>;
  if (transaction.schema_version !== 1 || typeof transaction.migration_id !== 'string'
    || !['rollover_scheduled', 'owner_restoration_planned', 'owner_restored', 'rollover_consumed']
      .includes(String(transaction.status || ''))) return false;
  const contract = {
    schema_version: transaction.schema_version,
    migration_id: transaction.migration_id,
    source_state_sha256: transaction.source_state_sha256,
    source_history_length: transaction.source_history_length,
    prd_seal_hash: transaction.prd_seal_hash,
    start_commit: transaction.start_commit,
    pinned_sha: transaction.pinned_sha,
    source_owner_spec_id: transaction.source_owner_spec_id,
    target_owner_spec_id: transaction.target_owner_spec_id,
    target_runtime_root: transaction.target_runtime_root,
    target_runtime: transaction.target_runtime,
    rollover_intent_id: transaction.rollover_intent_id,
    rollover_epoch: transaction.rollover_epoch,
  };
  if (transaction.contract_sha256 !== crypto.createHash('sha256')
    .update(JSON.stringify(contract)).digest('hex')) return false;
  const consumed = transaction.status === 'rollover_consumed';
  const boundIntent = consumed
    ? state.autonomous_budget_consumed_intent_id : state.autonomous_budget_rollover_intent_id;
  if (transaction.rollover_intent_id !== boundIntent
    || Number(transaction.rollover_epoch) !== Number(state.autonomous_budget_epoch)
    || transaction.target_owner_spec_id
      !== (state.autonomous_owner_spec as Record<string, unknown> | null)?.spec_id
    || transaction.start_commit !== state.start_commit
    || transaction.pinned_sha !== (state.pinned_sha ?? null)) return false;
  const restoration = state.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
  if (['owner_restoration_planned', 'owner_restored'].includes(String(transaction.status))
    && (!restoration || restoration.rollover_intent_id !== transaction.rollover_intent_id
      || restoration.owner_spec_id !== transaction.target_owner_spec_id)) return false;
  try {
    const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf8');
    const seal = readPrdSeal(sessionDir);
    assertPrdSealMatchesPrd(seal, prd);
    if (seal.semantic_hash !== transaction.prd_seal_hash
      || typeof transaction.target_runtime_root !== 'string') return false;
    return JSON.stringify(describeInstalledRuntime(transaction.target_runtime_root))
      === JSON.stringify(transaction.target_runtime);
  } catch {
    return false;
  }
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validPersistedProcessIdentity(value: unknown): value is PersistedProcessIdentity {
  const identity = value as PersistedProcessIdentity | null;
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0
    || !Number.isInteger(identity.pgid) || identity.pgid <= 0
    || typeof identity.start_time !== 'string' || !identity.start_time
    || typeof identity.fingerprint !== 'string') return false;
  return identity.fingerprint === crypto.createHash('sha256')
    .update(`${identity.pid}\0${identity.pgid}\0${identity.start_time}`).digest('hex');
}

function legacyMaxTimeMigrationEvidence(
  state: PersistedState,
  resolvedSessionDir: string,
): LegacyMaxTimeMigrationEvidence | null {
  if (state.active !== false || state.step !== 'paused' || state.last_exit_reason !== 'max_time'
    || state.cancel_requested_at || state.cancelled === true || state.recovery_required === true
    || Number(state.orphan_child_pid || 0) > 0 || Number(state.active_child_pid || 0) > 0
    || state.autonomous_budget_rollover_intent_id || state.autonomous_budget_rollover_checkpoint_pending
    || state.autonomous_owner_restoration || state.legacy_max_time_migration
    || state.completed_at) return null;
  if (isProcessAlive(state.worker_pid) || isProcessAlive(state.tmux_runner_pid)
    || isProcessAlive(state.active_child_pid)) return null;
  if (Number(state.schema_version) !== 1 || state.session_dir !== resolvedSessionDir) return null;

  let workingDir: string;
  try {
    workingDir = fs.realpathSync(String(state.working_dir || ''));
  } catch {
    return null;
  }
  if (!isGitRepo(workingDir)) return null;
  const startCommit = typeof state.start_commit === 'string' ? state.start_commit : '';
  const pinnedSha = typeof state.pinned_sha === 'string' ? state.pinned_sha : null;
  if (!/^[a-f0-9]{40,64}$/.test(startCommit) || !commitExists(workingDir, startCommit)
    || (pinnedSha !== null && (!/^[a-f0-9]{40,64}$/.test(pinnedSha) || !commitExists(workingDir, pinnedSha)))) return null;

  const owner = validateAutonomousOwnerSpec(state.autonomous_owner_spec);
  if (!owner || owner.session_dir !== resolvedSessionDir || owner.working_dir !== workingDir) return null;
  if (owner.owner_mode === 'process') {
    try { authenticateProcessOwnerRuntime(owner); } catch { return null; }
  }
  let targetOwnerSpec: AutonomousOwnerSpec;
  let targetRuntimeRoot: string;
  let targetRuntime: Record<string, unknown>;
  try {
    const testRuntimeBin = process.env.PICKLE_TEST_MODE === '1'
      ? process.env.PICKLE_TEST_LEGACY_MIGRATION_RUNTIME_BIN : null;
    const runtimeBin = testRuntimeBin
      ? fs.realpathSync(testRuntimeBin)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin');
    targetRuntimeRoot = fs.realpathSync(path.resolve(runtimeBin, '../..'));
    targetRuntime = describeInstalledRuntime(targetRuntimeRoot) as unknown as Record<string, unknown>;
    targetOwnerSpec = deriveAutonomousProcessOwnerSpec(
      resolvedSessionDir,
      workingDir,
      owner.runner_bin,
      owner.runner_args,
      runtimeBin,
    );
  } catch {
    return null;
  }
  const supervisorIdentity = state.autonomous_supervisor_identity as PersistedProcessIdentity | null;
  if (!validPersistedProcessIdentity(supervisorIdentity)
    || Number(state.autonomous_supervisor_pid) !== supervisorIdentity.pid
    || inspectProcessLivenessIdentity(supervisorIdentity) === 'matched'
    || isProcessGroupAlive(supervisorIdentity.pgid)) return null;
  const daemonIdentity = state.autonomous_owner_recovery_daemon_identity as PersistedProcessIdentity | null;
  if (state.autonomous_owner_recovery_daemon_pid != null
    && (!validPersistedProcessIdentity(daemonIdentity)
      || Number(state.autonomous_owner_recovery_daemon_pid) !== daemonIdentity.pid
      || inspectProcessLivenessIdentity(daemonIdentity) === 'matched'
      || isProcessGroupAlive(daemonIdentity.pgid))) return null;
  if (owner.owner_mode === 'tmux' && (tmuxSessionExists(owner.tmux_session_name)
    || isProcessAlive(state.tmux_runner_pid))) return null;
  const history = Array.isArray(state.history) ? state.history as Array<Record<string, unknown>> : [];
  const terminal = history.at(-1);
  const productive = history.slice(0, -1).some((entry) => entry && typeof entry === 'object'
    && typeof entry.step === 'string' && !['inactive', 'paused', 'max_time', 'cancelled'].includes(entry.step)
    && typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)));
  if (!terminal || terminal.step !== 'max_time' || typeof terminal.timestamp !== 'string'
    || !Number.isFinite(Date.parse(terminal.timestamp)) || !productive) return null;

  try {
    const prd = fs.readFileSync(path.join(resolvedSessionDir, 'prd.md'), 'utf8');
    const seal = readPrdSeal(resolvedSessionDir);
    assertPrdSealMatchesPrd(seal, prd);
    const logical = readLogicalPipeline(resolvedSessionDir);
    if (logical.control_state !== 'autonomous_execution' || logical.terminal_state !== null
      || logical.prd_seal_hash !== seal.semantic_hash) return null;
    return {
      sourceStateSha256: sha256Json(state),
      sourceHistoryLength: history.length,
      prdSealHash: seal.semantic_hash,
      startCommit,
      pinnedSha,
      ownerSpecId: owner.spec_id,
      targetOwnerSpec,
      targetRuntimeRoot,
      targetRuntime,
    };
  } catch {
    return null;
  }
}

function reconcileSessionLivenessInternal(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
  options: ReconcileSessionLivenessOptions = {},
): { state: PersistedState; stale: boolean } {
  const statePath = getStatePath(sessionDir);
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  let state = stateManager.read(statePath);
  const rolloverIntentId = typeof state.autonomous_budget_rollover_intent_id === 'string'
    ? state.autonomous_budget_rollover_intent_id : '';
  const hasPersistedRolloverEpoch = state.autonomous_budget_epoch !== undefined
    && state.autonomous_budget_epoch !== null;
  const persistedRolloverEpoch = hasPersistedRolloverEpoch
    ? Number(state.autonomous_budget_epoch) : 1;
  const rolloverEpoch = Math.max(1, persistedRolloverEpoch);
  const rolloverCancelled = state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled';
  const rolloverUnsafe = state.recovery_required === true || Number(state.orphan_child_pid || 0) > 0;
  if (rolloverCancelled) return { state, stale: false };
  if (state.step === 'complete' || state.completed_at || state.last_exit_reason === 'completed') {
    return { state, stale: false };
  }
  if (state.legacy_max_time_migration
    && !validLegacyMaxTimeMigrationTransaction(state.legacy_max_time_migration, state, resolvedSessionDir)) {
    state = stateManager.update(statePath, (current) => {
      if (current.cancel_requested_at || current.cancelled === true || current.step === 'complete') return current;
      current.active = false;
      current.step = 'blocked';
      current.recovery_required = true;
      current.recovery_kind = 'legacy_max_time_migration_corrupt';
      current.recovery_reason = 'legacy max_time migration transaction failed its content hash';
      current.autonomous_owner_recovery_suspended = true;
      appendHistory(current, 'legacy_max_time_migration_corrupt');
      return current;
    });
    return { state, stale: false };
  }
  const initialOwnerSpec = validateAutonomousOwnerSpec(state.autonomous_owner_spec);
  if (state.autonomous_owner_spec != null
    && (!initialOwnerSpec || initialOwnerSpec.session_dir !== resolvedSessionDir)) {
    state = stateManager.update(statePath, (current) => {
      if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') {
        return current;
      }
      if (current.recovery_required === true
        && current.recovery_kind === 'autonomous_owner_contract_invalid'
        && current.recovery_reason === 'autonomous owner specification is invalid or bound to a different session') {
        return current;
      }
      current.step = current.step === 'complete' ? current.step : 'blocked';
      current.recovery_required = true;
      current.recovery_kind = 'autonomous_owner_contract_invalid';
      current.recovery_reason = 'autonomous owner specification is invalid or bound to a different session';
      appendHistory(current, 'autonomous_owner_contract_invalid', current.current_ticket || undefined);
      return current;
    });
    return { state, stale: false };
  }
  if (rolloverIntentId && hasPersistedRolloverEpoch
    && (!Number.isInteger(persistedRolloverEpoch) || persistedRolloverEpoch < 1)) {
    throw new Error('Autonomous budget rollover intent has a corrupt epoch.');
  }
  if (rolloverIntentId && rolloverUnsafe) return { state, stale: false };
  if (rolloverIntentId && state.autonomous_owner_recovery_suspended === true && !rolloverCancelled) {
    return { state, stale: false };
  }
  if (rolloverIntentId && Number.isInteger(rolloverEpoch) && !rolloverCancelled && !rolloverUnsafe) {
    const deadlineMs = Date.parse(String(state.autonomous_relaunch_deadline || ''));
    const supervisorIdentity = state.autonomous_supervisor_identity as PersistedProcessIdentity | null;
    const supervisorAlive = supervisorIdentity
      ? inspectProcessLivenessIdentity(supervisorIdentity) === 'matched'
      : isProcessAlive(state.autonomous_supervisor_pid);
    const validatedOwnerSpec = initialOwnerSpec;
    const ownerProcessAlive = validatedOwnerSpec ? supervisorAlive : isProcessAlive(state.tmux_runner_pid);
    const ownerMissing = validatedOwnerSpec?.owner_mode === 'process'
      ? !supervisorAlive
      : state.tmux_mode === true && (
        !ownerProcessAlive
        || (typeof state.tmux_session_name === 'string' && !tmuxSessionExists(state.tmux_session_name))
      );
    const planned = state.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
    const exactRecoveryPending = planned?.rollover_intent_id === rolloverIntentId
      && Number(planned.rollover_epoch) === rolloverEpoch
      && planned.owner_spec_id === (state.autonomous_owner_spec as AutonomousOwnerSpec | null)?.spec_id
      && (planned.status === 'pending' || planned.status === 'restoring');
    if (state.active === true && ownerMissing && exactRecoveryPending
      && Number.isFinite(deadlineMs) && nowMs <= deadlineMs) return { state, stale: false };
    if (state.active !== true || !Number.isFinite(deadlineMs) || nowMs > deadlineMs || ownerMissing) {
      const delayMs = Math.min(30_000, 250 * (2 ** Math.min(rolloverEpoch - 1, 7)));
      state = stateManager.update(statePath, (current) => {
        const currentEpoch = Math.max(1, Number(current.autonomous_budget_epoch || 0));
        if (current.autonomous_budget_rollover_intent_id !== rolloverIntentId
          || currentEpoch !== rolloverEpoch
          || current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') return current;
        current.active = true;
        current.last_exit_reason = 'autonomous_budget_rollover';
        current.autonomous_relaunch_not_before = new Date(nowMs + delayMs).toISOString();
        current.autonomous_relaunch_deadline = new Date(nowMs + delayMs + 60_000).toISOString();
        current.tmux_runner_pid = null;
        current.worker_pid = null;
        const candidateSpec = validateAutonomousOwnerSpec(current.autonomous_owner_spec);
        const spec = candidateSpec?.session_dir === resolvedSessionDir ? candidateSpec : null;
        const existing = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
        if (ownerMissing && spec?.schema_version === 1 && typeof spec.spec_id === 'string') {
          const sameIntent = existing?.rollover_intent_id === rolloverIntentId
            && Number(existing?.rollover_epoch) === rolloverEpoch
            && existing?.owner_spec_id === spec.spec_id;
          const restorerIdentity = existing?.restorer_identity as PersistedProcessIdentity | null;
          const restorerAlive = existing?.status === 'restoring' && (restorerIdentity
            ? inspectProcessLivenessIdentity(restorerIdentity) === 'matched'
            : isProcessAlive(existing.restorer_pid));
          if (!sameIntent || existing?.status === 'restored' || (existing?.status === 'restoring' && !restorerAlive)) {
            current.autonomous_owner_restoration = {
              schema_version: 1,
              intent_id: crypto.randomUUID(),
              rollover_intent_id: rolloverIntentId,
              rollover_epoch: rolloverEpoch,
              owner_spec_id: spec.spec_id,
              status: 'pending',
              attempt: sameIntent ? Number(existing?.attempt || 0) : 0,
              not_before: new Date(nowMs + delayMs).toISOString(),
              restorer_pid: null,
              restorer_identity: null,
            };
            const legacyMigration = current.legacy_max_time_migration as Record<string, unknown> | null;
            if (legacyMigration?.rollover_intent_id === rolloverIntentId
              && legacyMigration?.target_owner_spec_id === spec.spec_id) {
              current.legacy_max_time_migration = {
                ...legacyMigration,
                status: 'owner_restoration_planned',
                updated_at: new Date(nowMs).toISOString(),
              };
            }
            appendHistory(current, 'autonomous_owner_restoration_planned');
          } else if (existing?.status === 'failed') {
            const attempt = Math.max(1, Number(existing.attempt || 1));
            const retryDelay = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
            current.autonomous_owner_restoration = {
              ...existing,
              status: 'pending',
              not_before: new Date(nowMs + retryDelay).toISOString(),
              restorer_pid: null,
              restorer_identity: null,
            };
            appendHistory(current, 'autonomous_owner_restoration_retried');
          }
        }
        appendHistory(current, ownerMissing
          ? 'autonomous_budget_owner_recovery_scheduled'
          : 'autonomous_budget_relaunch_rescheduled');
        return current;
      });
    }
    return { state, stale: false };
  }
  const legacyEvidence = options.allowLegacyMaxTimeMigration
    ? legacyMaxTimeMigrationEvidence(state, resolvedSessionDir) : null;
  if (legacyEvidence) {
    const migrationFencePath = path.join(resolvedSessionDir, '.legacy-max-time-migration-fence');
    stateManager.acquireLock(migrationFencePath);
    const repair = (): boolean => Boolean(scheduleAuthenticatedLegacyMaxTimeRollover(
      stateManager,
      statePath,
      {
        nowMs,
        ticketId: typeof state.current_ticket === 'string' ? state.current_ticket : null,
        repairMissingIntent: true,
        legacyInactiveMaxTimeMigration: {
          migrationId: crypto.randomUUID(),
          sourceStateSha256: legacyEvidence.sourceStateSha256,
          sourceHistoryLength: legacyEvidence.sourceHistoryLength,
          prdSealHash: legacyEvidence.prdSealHash,
          startCommit: legacyEvidence.startCommit,
          pinnedSha: legacyEvidence.pinnedSha,
          sourceOwnerSpecId: legacyEvidence.ownerSpecId,
          targetOwnerSpecId: legacyEvidence.targetOwnerSpec.spec_id,
          targetOwnerSpec: legacyEvidence.targetOwnerSpec as unknown as Record<string, unknown>,
          targetRuntimeRoot: legacyEvidence.targetRuntimeRoot,
          targetRuntime: legacyEvidence.targetRuntime,
        },
        assertRepairState: (current) => {
          const exact = legacyMaxTimeMigrationEvidence(current, resolvedSessionDir);
          if (!exact || exact.sourceStateSha256 !== legacyEvidence.sourceStateSha256
            || exact.ownerSpecId !== legacyEvidence.ownerSpecId
            || exact.targetOwnerSpec.spec_id !== legacyEvidence.targetOwnerSpec.spec_id
            || exact.targetRuntimeRoot !== legacyEvidence.targetRuntimeRoot
            || JSON.stringify(exact.targetRuntime) !== JSON.stringify(legacyEvidence.targetRuntime)
            || exact.prdSealHash !== legacyEvidence.prdSealHash
            || exact.startCommit !== legacyEvidence.startCommit
            || exact.pinnedSha !== legacyEvidence.pinnedSha) {
            throw new Error('Cannot migrate a legacy max_time session after its authenticated evidence changed.');
          }
        },
      },
    ));
    try {
      if (repair()) return reconcileSessionLivenessInternal(sessionDir, stateManager, nowMs, options);
    } catch (error) {
      const current = stateManager.read(statePath);
      const receipt = current.legacy_max_time_migration as Record<string, unknown> | null;
      if (error instanceof Error
        && error.message.includes('second autonomous budget rollover')
        && current.active === true
        && current.last_exit_reason === 'autonomous_budget_rollover'
        && receipt?.source_state_sha256 === legacyEvidence.sourceStateSha256
        && receipt?.rollover_intent_id === current.autonomous_budget_rollover_intent_id) {
        return reconcileSessionLivenessInternal(sessionDir, stateManager, nowMs, options);
      }
      throw error;
    } finally {
      stateManager.releaseLock(migrationFencePath);
    }
    state = stateManager.read(statePath);
  }
  if (state.active !== true) return { state, stale: false };

  const tmuxName = typeof state.tmux_session_name === 'string' ? state.tmux_session_name : '';
  const runnerMissing = state.tmux_mode === true && (
    !isProcessAlive(state.tmux_runner_pid)
    || (tmuxName !== '' && !tmuxSessionExists(tmuxName))
  );
  const maxMinutes = Number(state.max_time_minutes || 0);
  const startedMs = getRunStartEpoch(state) * 1000;
  const expired = maxMinutes > 0 && startedMs > 0 && nowMs - startedMs >= maxMinutes * 60_000;
  if (!runnerMissing && !expired) return { state, stale: false };

  if (expired && !rolloverIntentId) {
    // Cancellation and unsafe recovery state are authoritative. In particular,
    // never manufacture a new autonomous intent while cancellation or an
    // unowned child is being reconciled.
    if (state.recovery_required === true && !isProcessAlive(state.active_child_pid)) {
      return { state, stale: false };
    }
    if (state.tmux_mode !== true && !initialOwnerSpec) {
      state = stateManager.update(statePath, (current) => {
        if (current.active !== true || current.cancel_requested_at || current.cancelled === true
          || current.last_exit_reason === 'cancelled' || current.autonomous_budget_rollover_intent_id) return current;
        current.step = current.step === 'complete' ? current.step : 'blocked';
        current.recovery_required = true;
        current.recovery_kind = 'autonomous_owner_contract_invalid';
        current.recovery_reason = 'elapsed autonomous process session has no authenticated immutable owner specification';
        appendHistory(current, 'autonomous_owner_contract_invalid', current.current_ticket || undefined);
        return current;
      });
      return { state, stale: false };
    }
    const repair = (): boolean => Boolean(scheduleAutonomousBudgetRollover(
      stateManager,
      statePath,
      'max_time',
      {
        nowMs,
        ticketId: typeof state.current_ticket === 'string' ? state.current_ticket : null,
        repairMissingIntent: true,
        assertRepairState: initialOwnerSpec ? (current) => {
          const exact = validateAutonomousOwnerSpec(current.autonomous_owner_spec);
          if (!exact || exact.spec_id !== initialOwnerSpec.spec_id || exact.session_dir !== resolvedSessionDir) {
            throw new Error('Cannot repair an autonomous budget rollover after immutable owner state changed.');
          }
        } : undefined,
      },
    ));
    const winningRepair = (): boolean => {
      const current = stateManager.read(statePath);
      const intentId = typeof current.autonomous_budget_rollover_intent_id === 'string'
        ? current.autonomous_budget_rollover_intent_id : '';
      const pending = current.autonomous_budget_rollover_checkpoint_pending as Record<string, unknown> | null;
      return Boolean(intentId
        && current.active === true
        && current.last_exit_reason === 'autonomous_budget_rollover'
        && current.autonomous_budget_reason === 'max_time'
        && pending?.intent_id === intentId
        && Number(pending?.epoch) === Number(current.autonomous_budget_epoch)
        && pending?.reason === 'max_time');
    };
    const reconcileRepairRace = (): boolean => {
      try {
        return repair();
      } catch (error) {
        if (error instanceof Error
          && error.message.includes('second autonomous budget rollover')
          && winningRepair()) return true;
        throw error;
      }
    };
    if (reconcileRepairRace()) return reconcileSessionLivenessInternal(sessionDir, stateManager, nowMs);
    state = stateManager.read(statePath);
    if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled'
      || (state.recovery_required === true && !isProcessAlive(state.active_child_pid))) {
      return { state, stale: false };
    }
    const activeChildPid = isProcessAlive(state.active_child_pid) ? Number(state.active_child_pid) : null;
    const activeChildRecovery = activeChildPid ? recoverSessionOrphanState(sessionDir, state) : null;
    if (activeChildRecovery?.status === 'reaped' || activeChildRecovery?.status === 'not-running') {
      const observedIdentity = state.active_child_identity;
      stateManager.update(statePath, (current) => {
        if (Number(current.active_child_pid || 0) !== activeChildPid
          || JSON.stringify(current.active_child_identity ?? null) !== JSON.stringify(observedIdentity ?? null)) return current;
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.active_child_identity = null;
        current.active_child_controller_pid = null;
        return current;
      });
      if (reconcileRepairRace()) return { state: stateManager.read(statePath), stale: false };
      state = stateManager.read(statePath);
    }
  }

  const reason = runnerMissing ? 'runner_lost' : 'max_time';
  let orphanChildPid = isProcessAlive(state.active_child_pid) ? Number(state.active_child_pid) : null;
  const orphanRecovery = orphanChildPid
    ? recoverSessionOrphanState(sessionDir, state)
    : null;
  if (orphanRecovery?.status === 'reaped' || orphanRecovery?.status === 'not-running') {
    orphanChildPid = null;
  }
  const reconciled = stateManager.update(statePath, (current) => {
    if (current.active !== true) return current;
    current.active = false;
    current.tmux_runner_pid = null;
    current.worker_pid = null;
    current.active_child_pid = orphanChildPid;
    current.orphan_child_pid = orphanChildPid;
    current.orphan_recovery = orphanRecovery;
    if (!orphanChildPid) {
      current.active_child_kind = null;
      current.active_child_command = null;
    }
    current.last_exit_reason = orphanChildPid ? `${reason}_orphaned_child` : reason;
    current.step = current.step === 'complete' ? current.step : (orphanChildPid ? 'blocked' : 'paused');
    if (orphanChildPid) {
      current.recovery_required = true;
      current.recovery_reason = `runner disappeared while child pid ${orphanChildPid} remained unsafe to reap: ${orphanRecovery?.reason || 'ownership unknown'}`;
    } else {
      current.recovery_required = false;
      current.recovery_reason = null;
    }
    appendHistory(current, String(current.last_exit_reason), current.current_ticket || undefined);
    return current;
  });
  // A live orphan must remain mapped and discoverable. Returning stale=false keeps
  // resolveSessionForCwd from pruning the only recovery handle; cancel/status can
  // then surface the blocked session instead of silently abandoning a mutator.
  return { state: reconciled, stale: orphanChildPid === null };
}

export function reconcileSessionLiveness(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
): { state: PersistedState; stale: boolean } {
  return reconcileSessionLivenessInternal(sessionDir, stateManager, nowMs);
}

export function reconcileAllSessionLiveness(): Array<{ sessionDir: string; reason: string; state: PersistedState }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  const reconciled: Array<{ sessionDir: string; reason: string; state: PersistedState }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(getSessionsRoot(), entry.name);
    if (!fs.existsSync(getStatePath(sessionDir))) continue;
    try {
      const result = reconcileSessionLiveness(sessionDir);
      if (result.stale) {
        reconciled.push({ sessionDir, reason: String(result.state.last_exit_reason || 'inactive'), state: result.state });
      }
    } catch {
      // A corrupt session must not prevent reconciliation of the remaining sessions.
    }
  }
  return reconciled;
}

function anotherLiveSessionClaimsCwd(cwd: string, selectedSessionDir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true }); } catch { return false; }
  const selected = path.resolve(selectedSessionDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(getSessionsRoot(), entry.name);
    if (path.resolve(candidateDir) === selected || !fs.existsSync(getStatePath(candidateDir))) continue;
    try {
      const candidate = loadSessionState(candidateDir);
      if ((candidate.active === true || candidate.recovery_required === true)
        && getSessionMapCwds(candidate).some((alias) => normalizeSessionCwd(alias) === cwd)) return true;
    } catch {
      // Corrupt unrelated sessions do not grant authority to activate this one.
      return true;
    }
  }
  return false;
}

async function reconcileMappedSessionExclusively(
  cwd: string,
  sessionDir: string,
): Promise<{ state: PersistedState; stale: boolean }> {
  return withInProcessCwdQueue(cwd, async () => {
    const releaseLaunchReservation = acquireCwdReservationLocks([cwd]);
    try {
      return await withFilesystemCwdAuthority(cwd, () => withSessionMapLock(() => {
    const stillMapped = getSessionForCwd(cwd);
    const mappedState = loadSessionState(sessionDir);
    const exactAlias = getSessionMapCwds(mappedState)
      .some((candidate) => normalizeSessionCwd(candidate) === cwd);
    const exclusive = stillMapped !== null && path.resolve(stillMapped) === path.resolve(sessionDir)
      && exactAlias && !anotherLiveSessionClaimsCwd(cwd, sessionDir);
    return reconcileSessionLivenessInternal(sessionDir, undefined, Date.now(), {
      allowLegacyMaxTimeMigration: exclusive,
    });
      }));
    } finally {
      releaseLaunchReservation();
    }
  });
}

export async function resolveSessionForCwd(cwd: string, options: ResolveSessionForCwdOptions = {}): Promise<string | null> {
  const normalizedCwd = normalizeSessionCwd(cwd);
  const direct = getSessionForCwd(normalizedCwd);
  if (direct) {
    const mappedState = loadSessionState(direct);
    const exactAlias = getSessionMapCwds(mappedState)
      .some((candidate) => normalizeSessionCwd(candidate) === normalizedCwd);
    if (!exactAlias) {
      await removeSessionMapEntry(normalizedCwd, direct);
    } else {
      const reconciled = await reconcileMappedSessionExclusively(normalizedCwd, direct);
      if (reconciled.state.legacy_max_time_migration
        && reconciled.state.autonomous_owner_restoration) {
        ensureAutonomousOwnerRecoveryDaemon(
          direct,
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin'),
        );
      }
      if (!reconciled.stale || options.last) return direct;
    }
    await removeSessionMapEntry(normalizedCwd, direct);
  }
  if (options.last) {
    const sessionDir = findLastSessionForCwd(normalizedCwd);
    if (sessionDir) {
      const candidate = loadSessionState(sessionDir);
      if (!getSessionMapCwds(candidate)
        .some((alias) => normalizeSessionCwd(alias) === normalizedCwd)) return null;
      await updateSessionMap(normalizedCwd, sessionDir);
      const reconciled = await reconcileMappedSessionExclusively(normalizedCwd, sessionDir);
      if (reconciled.state.legacy_max_time_migration
        && reconciled.state.autonomous_owner_restoration) {
        ensureAutonomousOwnerRecoveryDaemon(
          sessionDir,
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin'),
        );
      }
      return sessionDir;
    }
  }
  return null;
}

export async function deactivateSession(
  sessionDir: string,
  reason: string = 'cancelled',
  options: { preserveMapping?: boolean } = {},
): Promise<PersistedState> {
  const state = isPipelineSession(sessionDir)
    ? cancelPipelineSession(sessionDir, { exitReason: reason }).state
    : new StateManager().update(
      getStatePath(sessionDir),
      (current) => {
        current.active = false;
        current.last_exit_reason = reason;
        current.cancel_requested_at = reason === 'cancelled' ? nowIso() : current.cancel_requested_at || null;
        appendHistory(current, 'inactive', current.current_ticket || undefined);
        return current;
      },
    );
  if (!options.preserveMapping) {
    for (const cwd of getSessionMapCwds(state)) {
      await removeSessionMapEntry(cwd, sessionDir);
    }
  }
  return state;
}

export function writeSessionFile(sessionDir: string, fileName: string, content: string): string {
  ensureDir(sessionDir);
  fs.writeFileSync(path.join(sessionDir, fileName), content);
  return path.join(sessionDir, fileName);
}
