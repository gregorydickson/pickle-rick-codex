import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureConfigFile, loadConfig } from './config.js';
import { logActivity } from './activity-logger.js';
import {
  atomicWriteJson,
  atomicWriteFile,
  ensureDir,
  getSessionsRoot,
  nowIso,
} from './pickle-utils.js';
import {
  commitExists,
  commitIsAncestorWithPathsUnchanged,
  getHeadSha,
  getWorkingTreeStatus,
  isGitRepo,
  isIndexClean,
} from './git-utils.js';
import { cancelPipelineSession, isPipelineSession, readPipelineState } from './pipeline-state.js';
import { readPipelineContract } from './pipeline.js';
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
import { inspectProcessLivenessIdentity, isPersistedProcessIdentityValid, recoverSessionOrphanState, type PersistedProcessIdentity } from './orphan-reaper.js';
import {
  activeMonitoredProcessIdentities,
  recoverMonitoredProcessOwnership,
  recoverRefinementProcessOwnership,
} from './monitored-process-ownership.js';
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
import {
  beginAutonomousExecution,
  createLogicalPipeline,
  readLogicalPipeline,
} from './durable-supervisor.js';
import { describeInstalledRuntime } from './runtime-descriptor.js';
import { acquireCwdReservationLocks } from './detached-launch.js';
import { recoverInterruptedTicketTransaction, runTicketTransaction } from './ticket-transaction.js';
import { validateRefinementAcceptance, writeRefinementAcceptance } from './refinement-artifacts.js';
import { validateAdvancedLoopConfig } from './readiness.js';
import {
  getCitadelRepositoryFingerprint,
  validateCitadelRecoveryEvidence,
  type CitadelRecoveryAuthority,
} from './citadel.js';

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
    active_child_identities: [],
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
  ownerSpecId: string | null;
  targetOwnerSpec: AutonomousOwnerSpec;
  targetRuntimeRoot: string;
  targetRuntime: Record<string, unknown>;
  executionProfile: LegacyExecutionProfile;
  logicalPipelineId: string;
  logicalPipelineBootstrap: 'create' | 'seal' | null;
  refinementBootstrap: boolean;
}

interface LegacyExecutionProfile extends Record<string, unknown> {
  schema_version: 1;
  runner_mode: 'pickle' | 'pipeline' | 'loop';
  runner_bin: 'mux-runner.js' | 'pipeline-runner.js' | 'loop-runner.js';
  runner_args: string[];
  working_dir: string;
  failure_policy: 'durable_retry';
  derivation: 'sealed_standard_session' | 'sealed_pipeline_session' | 'validated_advanced_loop_config';
  loop_config_sha256: string | null;
  source_artifacts: Array<{ path: string; sha256: string }>;
  repository_head: string;
  release_fingerprint: string;
  citadel_recovery_authority: CitadelRecoveryAuthority | null;
}

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourceArtifacts(sessionDir: string, relativePaths: string[]): Array<{ path: string; sha256: string }> {
  return [...new Set(relativePaths)].sort().map((relativePath) => ({
    path: relativePath,
    sha256: fileSha256(path.join(sessionDir, relativePath)),
  }));
}

function deriveLegacyExecutionProfile(
  state: PersistedState,
  sessionDir: string,
  workingDir: string,
  allowTerminalCompletion = false,
): LegacyExecutionProfile | null {
  const loopConfigPath = path.join(sessionDir, 'loop_config.json');
  const hasLoopConfig = fs.existsSync(loopConfigPath);
  const hasPipeline = fs.existsSync(path.join(sessionDir, 'pipeline.json'));
  const hasPipelineState = fs.existsSync(path.join(sessionDir, 'pipeline-state.json'));
  const hasManifest = fs.existsSync(path.join(sessionDir, 'refinement_manifest.json'));
  if (fs.existsSync(path.join(sessionDir, 'legacy-session-adoption.json'))
    || fs.existsSync(path.join(sessionDir, 'legacy-session-adoption-transaction.json'))
    || hasPipeline !== hasPipelineState
    || (hasLoopConfig && (hasPipeline || hasManifest || state.pipeline_mode === true))) return null;
  const repositoryHead = getHeadSha(workingDir);
  const releaseFingerprint = getCitadelRepositoryFingerprint(workingDir);
  if (hasLoopConfig) {
    try {
      const bytes = fs.readFileSync(loopConfigPath);
      const validation = validateAdvancedLoopConfig(sessionDir, workingDir);
      const migratedLoop = ((state.legacy_max_time_migration as Record<string, unknown> | null)
        ?.execution_profile as Record<string, unknown> | undefined)?.runner_mode === 'loop';
      if (!validation.advanced || !validation.config
        || validation.findings.some((finding) => finding.severity === 'error')
        || (state.tmux_mode !== true && !migratedLoop)) return null;
      return {
        schema_version: 1,
        runner_mode: 'loop',
        runner_bin: 'loop-runner.js',
        runner_args: [],
        working_dir: workingDir,
        failure_policy: 'durable_retry',
        derivation: 'validated_advanced_loop_config',
        loop_config_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        source_artifacts: sourceArtifacts(sessionDir, ['loop_config.json']),
        repository_head: repositoryHead,
        release_fingerprint: releaseFingerprint,
        citadel_recovery_authority: null,
      };
    } catch {
      return null;
    }
  }
  if (hasPipeline || hasPipelineState || state.pipeline_mode === true) {
    if (!hasPipeline || !hasPipelineState || state.pipeline_mode !== true) return null;
    try {
      const pipeline = readPipelineContract(sessionDir);
      const pipelineState = readPipelineState(sessionDir, undefined, pipeline);
      if (fs.realpathSync(pipeline.working_dir) !== workingDir
        || (pipelineState.completed_at && !allowTerminalCompletion)
        || pipelineState.last_exit_reason === 'cancelled') return null;
    } catch {
      return null;
    }
    return {
      schema_version: 1,
      runner_mode: 'pipeline',
      runner_bin: 'pipeline-runner.js',
      runner_args: ['--on-failure=retry'],
      working_dir: workingDir,
      failure_policy: 'durable_retry',
      derivation: 'sealed_pipeline_session',
      loop_config_sha256: null,
      source_artifacts: sourceArtifacts(sessionDir, ['pipeline.json', 'pipeline-state.json']),
      repository_head: repositoryHead,
      release_fingerprint: releaseFingerprint,
      citadel_recovery_authority: null,
    };
  }
  try {
    if (!hasManifest || state.pipeline_mode === true
      || (fs.existsSync(path.join(sessionDir, 'citadel-release-approval.json'))
        && !state.legacy_max_time_migration)) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8')) as Record<string, unknown>;
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.tickets)
      || manifest.tickets.length === 0
      || manifest.tickets.some((ticket) => !ticket || typeof ticket !== 'object' || Array.isArray(ticket)
        || typeof (ticket as Record<string, unknown>).id !== 'string'
        || !(ticket as Record<string, unknown>).id
        || typeof (ticket as Record<string, unknown>).title !== 'string'
        || !(ticket as Record<string, unknown>).title
        || typeof (ticket as Record<string, unknown>).status !== 'string')) return null;
    const seal = readPrdSeal(sessionDir);
    const scope = Array.isArray(seal.scope_and_ownership) ? seal.scope_and_ownership : [];
    const sealedTicketIds = new Set(scope.flatMap((entry) => {
      const ticketId = entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).ticket_id : null;
      return typeof ticketId === 'string' && ticketId ? [ticketId] : [];
    }));
    const manifestIds = (manifest.tickets as Array<Record<string, unknown>>)
      .map((ticket) => String(ticket.id));
    if (sealedTicketIds.size === 0 || new Set(manifestIds).size !== manifestIds.length
      || manifestIds.some((ticketId) => !sealedTicketIds.has(ticketId))) return null;
  } catch {
    return null;
  }
  let citadelAuthority: CitadelRecoveryAuthority;
  try {
    const hasRefinedPrd = fs.existsSync(path.join(sessionDir, 'prd_refined.md'));
    const hasRefinementAcceptance = fs.existsSync(path.join(sessionDir, 'refinement-acceptance.json'));
    if (hasRefinedPrd !== hasRefinementAcceptance) return null;
    const managedLegacyEvolution = (state.legacy_max_time_migration as Record<string, unknown> | null)?.status
      === 'rollover_consumed';
    if (hasRefinedPrd && !managedLegacyEvolution && !validateRefinementAcceptance(sessionDir, {
      workingDir,
      verifyRepository: true,
    }).ok) return null;
    const migratedProfile = (state.legacy_max_time_migration as Record<string, unknown> | null)
      ?.execution_profile as LegacyExecutionProfile | undefined;
    citadelAuthority = validateCitadelRecoveryEvidence(
      sessionDir,
      workingDir,
      state as Record<string, unknown>,
      managedLegacyEvolution && migratedProfile?.runner_mode === 'pickle'
        ? { allowRepositoryDescendantOf: migratedProfile.repository_head }
        : {},
    );
  } catch {
    return null;
  }
  return {
    schema_version: 1,
    runner_mode: 'pickle',
    runner_bin: 'mux-runner.js',
    runner_args: ['--on-failure=retry'],
    working_dir: workingDir,
    failure_policy: 'durable_retry',
    derivation: 'sealed_standard_session',
    loop_config_sha256: null,
    source_artifacts: sourceArtifacts(sessionDir, ['refinement_manifest.json']),
    repository_head: repositoryHead,
    release_fingerprint: releaseFingerprint,
    citadel_recovery_authority: citadelAuthority,
  };
}

function executionProfileStillAuthorized(
  expected: LegacyExecutionProfile,
  state: PersistedState,
  sessionDir: string,
  allowManagedEvolution: boolean,
  terminalCompleted: boolean,
): boolean {
  let current: LegacyExecutionProfile | null;
  try {
    current = deriveLegacyExecutionProfile(
      state,
      sessionDir,
      String(state.working_dir || ''),
      terminalCompleted,
    );
  } catch {
    return false;
  }
  if (!current
    || current.runner_mode !== expected.runner_mode
    || current.runner_bin !== expected.runner_bin
    || JSON.stringify(current.runner_args) !== JSON.stringify(expected.runner_args)
    || current.working_dir !== expected.working_dir
    || current.derivation !== expected.derivation
    || (!allowManagedEvolution && current.repository_head !== expected.repository_head)
    || (!allowManagedEvolution && current.release_fingerprint !== expected.release_fingerprint)
    || (allowManagedEvolution
      && !commitIsAncestorWithPathsUnchanged(current.working_dir, expected.repository_head, []))) return false;
  const immutablePaths = expected.runner_mode === 'pipeline'
    ? new Set(allowManagedEvolution ? ['pipeline.json'] : ['pipeline.json', 'pipeline-state.json'])
    : expected.runner_mode === 'pickle' && allowManagedEvolution
      ? new Set<string>()
      : new Set(expected.source_artifacts.map((entry) => entry.path));
  const expectedImmutable = expected.source_artifacts.filter((entry) => immutablePaths.has(entry.path));
  const currentImmutable = current.source_artifacts.filter((entry) => immutablePaths.has(entry.path));
  if (JSON.stringify(currentImmutable) !== JSON.stringify(expectedImmutable)) return false;
  if (expected.runner_mode !== 'pickle') return true;
  const sourceCitadel = expected.citadel_recovery_authority;
  const liveCitadel = current.citadel_recovery_authority;
  return Boolean(sourceCitadel && liveCitadel
    && (allowManagedEvolution || liveCitadel.repository_head === sourceCitadel.repository_head)
    && (allowManagedEvolution || liveCitadel.release_fingerprint === sourceCitadel.release_fingerprint)
    && liveCitadel.reviewed_range === sourceCitadel.reviewed_range
    && (allowManagedEvolution || liveCitadel.manifest_sha256 === sourceCitadel.manifest_sha256)
    && liveCitadel.verification_hash === sourceCitadel.verification_hash
    && liveCitadel.acceptance_criteria_hash === sourceCitadel.acceptance_criteria_hash);
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
    execution_profile: transaction.execution_profile,
    logical_pipeline_id: transaction.logical_pipeline_id,
    rollover_intent_id: transaction.rollover_intent_id,
    rollover_epoch: transaction.rollover_epoch,
  };
  if (transaction.contract_sha256 !== crypto.createHash('sha256')
    .update(JSON.stringify(contract)).digest('hex')) return false;
  const consumed = transaction.status === 'rollover_consumed';
  const stateClaimsCompletion = state.step === 'complete' || Boolean(state.completed_at)
    || state.last_exit_reason === 'completed';
  let logical: ReturnType<typeof readLogicalPipeline>;
  try { logical = readLogicalPipeline(sessionDir); } catch { return false; }
  const managedSupervisorIdentity = state.autonomous_supervisor_identity as PersistedProcessIdentity | null;
  const completionMismatch = stateClaimsCompletion !== (logical.terminal_state === 'completed');
  const managedSupervisorActive = validPersistedProcessIdentity(managedSupervisorIdentity)
    && inspectProcessLivenessIdentity(managedSupervisorIdentity) === 'matched';
  const managedSupervisorFinalizing = completionMismatch && managedSupervisorActive;
  const terminalCompleted = stateClaimsCompletion && logical.terminal_state === 'completed';
  if (completionMismatch && !managedSupervisorFinalizing) return false;
  const boundIntent = consumed
    ? state.autonomous_budget_consumed_intent_id : state.autonomous_budget_rollover_intent_id;
  const transactionEpoch = Number(transaction.rollover_epoch);
  const currentEpoch = Number(state.autonomous_budget_epoch);
  const consumedBindingInvalid = consumed && (
    !Number.isInteger(transactionEpoch) || transactionEpoch < 1
    || !Number.isInteger(currentEpoch) || currentEpoch < transactionEpoch
    || (currentEpoch === transactionEpoch && transaction.rollover_intent_id !== boundIntent)
  );
  if ((!consumed && (transaction.rollover_intent_id !== boundIntent
      || transactionEpoch !== currentEpoch))
    || consumedBindingInvalid
    || (!terminalCompleted && transaction.target_owner_spec_id
      !== (state.autonomous_owner_spec as Record<string, unknown> | null)?.spec_id)
    || transaction.start_commit !== state.start_commit
    || transaction.pinned_sha !== (state.pinned_sha ?? null)) return false;
  const profile = transaction.execution_profile as LegacyExecutionProfile | null;
  const targetOwner = state.autonomous_owner_spec as Record<string, unknown> | null;
  const managedChildIdentity = state.active_child_identity as PersistedProcessIdentity | null;
  const managedExecutorActive = consumed
    && typeof state.current_ticket === 'string' && Boolean(state.current_ticket)
    && ['research', 'research_review', 'plan', 'plan_review', 'implement', 'verify', 'review', 'simplify', 'conformance']
      .includes(String(state.step || ''))
    && isProcessAlive(state.worker_pid)
    && validPersistedProcessIdentity(managedSupervisorIdentity)
    && inspectProcessLivenessIdentity(managedSupervisorIdentity) === 'matched';
  const managedChildActive = consumed
    && validPersistedProcessIdentity(managedChildIdentity)
    && inspectProcessLivenessIdentity(managedChildIdentity) === 'matched'
    && Number(state.active_child_controller_pid) === Number(state.worker_pid)
    && isProcessAlive(state.worker_pid);
  const profileAuthorized = Boolean(profile) && (managedChildActive || managedExecutorActive || managedSupervisorActive
    || executionProfileStillAuthorized(profile as LegacyExecutionProfile, state, sessionDir, consumed, terminalCompleted));
  if (!profile || profile.schema_version !== 1
    || profile.working_dir !== state.working_dir
    || !['pickle', 'pipeline', 'loop'].includes(String(profile.runner_mode))
    || profile.failure_policy !== 'durable_retry'
    || !['sealed_standard_session', 'sealed_pipeline_session', 'validated_advanced_loop_config']
      .includes(String(profile.derivation))
    || (profile.runner_mode === 'pickle' && (profile.runner_bin !== 'mux-runner.js'
      || profile.derivation !== 'sealed_standard_session'))
    || (profile.runner_mode === 'pipeline' && (profile.runner_bin !== 'pipeline-runner.js'
      || profile.derivation !== 'sealed_pipeline_session'))
    || (profile.runner_mode === 'loop' && (profile.runner_bin !== 'loop-runner.js'
      || profile.derivation !== 'validated_advanced_loop_config'
      || !/^[a-f0-9]{64}$/.test(String(profile.loop_config_sha256 || ''))))
    || (!terminalCompleted && profile.runner_bin !== targetOwner?.runner_bin)
    || (!terminalCompleted
      && JSON.stringify(profile.runner_args) !== JSON.stringify(targetOwner?.runner_args))
    || !Array.isArray(profile.source_artifacts)
    || typeof profile.repository_head !== 'string'
    || typeof profile.release_fingerprint !== 'string'
    || typeof transaction.logical_pipeline_id !== 'string'
    || !profileAuthorized) return false;
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
    return logical.pipeline_id === transaction.logical_pipeline_id
      && logical.control_state === 'autonomous_execution'
      && (logical.terminal_state === null
        || ((terminalCompleted || managedSupervisorFinalizing)
          && logical.terminal_state === 'completed'))
      && logical.prd_seal_hash === seal.semantic_hash
      && JSON.stringify(describeInstalledRuntime(transaction.target_runtime_root))
        === JSON.stringify(transaction.target_runtime);
  } catch {
    return false;
  }
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validPersistedProcessIdentity(value: unknown): value is PersistedProcessIdentity {
  return isPersistedProcessIdentityValid(value);
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
  if (state.active_child_identity || state.orphan_recovery) return null;
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
  if (getWorkingTreeStatus(workingDir) !== '' || !isIndexClean(workingDir)
    || !commitIsAncestorWithPathsUnchanged(workingDir, startCommit, [])
    || (pinnedSha !== null && !commitIsAncestorWithPathsUnchanged(workingDir, pinnedSha, []))) return null;

  const owner = validateAutonomousOwnerSpec(state.autonomous_owner_spec);
  if (state.autonomous_owner_spec != null
    && (!owner || owner.session_dir !== resolvedSessionDir || owner.working_dir !== workingDir)) return null;
  if (owner?.owner_mode === 'process') {
    try { authenticateProcessOwnerRuntime(owner); } catch { return null; }
  }
  const executionProfile = deriveLegacyExecutionProfile(state, resolvedSessionDir, workingDir);
  if (!executionProfile) return null;
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
      executionProfile.runner_bin,
      executionProfile.runner_args,
      runtimeBin,
    );
  } catch {
    return null;
  }
  const supervisorIdentity = state.autonomous_supervisor_identity as PersistedProcessIdentity | null;
  if (state.autonomous_supervisor_pid != null || supervisorIdentity != null) {
    if (!validPersistedProcessIdentity(supervisorIdentity)
      || Number(state.autonomous_supervisor_pid) !== supervisorIdentity.pid
      || inspectProcessLivenessIdentity(supervisorIdentity) === 'matched'
      || isProcessGroupAlive(supervisorIdentity.pgid)) return null;
  }
  const daemonIdentity = state.autonomous_owner_recovery_daemon_identity as PersistedProcessIdentity | null;
  if (state.autonomous_owner_recovery_daemon_pid != null || daemonIdentity != null) {
    if (!validPersistedProcessIdentity(daemonIdentity)
      || Number(state.autonomous_owner_recovery_daemon_pid) !== daemonIdentity.pid
      || inspectProcessLivenessIdentity(daemonIdentity) === 'matched'
      || isProcessGroupAlive(daemonIdentity.pgid)) return null;
  }
  const legacyTmuxName = owner?.owner_mode === 'tmux'
    ? owner.tmux_session_name : (typeof state.tmux_session_name === 'string' ? state.tmux_session_name : '');
  if ((legacyTmuxName && tmuxSessionExists(legacyTmuxName)) || isProcessAlive(state.tmux_runner_pid)) return null;
  const history = Array.isArray(state.history) ? state.history as Array<Record<string, unknown>> : [];
  const terminal = history.at(-1);
  if (!terminal || terminal.step !== 'max_time' || typeof terminal.timestamp !== 'string'
    || !Number.isFinite(Date.parse(terminal.timestamp))
    || history.some((entry) => ['cancelled', 'complete', 'completed'].includes(String(entry?.step || '')))) return null;

  try {
    const prd = fs.readFileSync(path.join(resolvedSessionDir, 'prd.md'), 'utf8');
    const seal = readPrdSeal(resolvedSessionDir);
    assertPrdSealMatchesPrd(seal, prd);
    if (fs.realpathSync(seal.repository.working_directory) !== workingDir) return null;
    const sourceStateSha256 = sha256Json(state);
    const bootstrapPipelineId = `legacy-max-time-${sourceStateSha256.slice(0, 24)}`;
    let logicalPipelineId = bootstrapPipelineId;
    let logicalPipelineBootstrap: 'create' | 'seal' | null = null;
    try {
      const logical = readLogicalPipeline(resolvedSessionDir);
      logicalPipelineId = logical.pipeline_id;
      if (!owner && logical.pipeline_id !== bootstrapPipelineId) return null;
      if (logical.control_state === 'prd_development' && logical.terminal_state === null
        && logical.prd_seal_hash === null && logical.pipeline_id === bootstrapPipelineId) {
        logicalPipelineBootstrap = 'seal';
      } else if (logical.control_state !== 'autonomous_execution' || logical.terminal_state !== null
        || logical.prd_seal_hash !== seal.semantic_hash) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      logicalPipelineBootstrap = 'create';
    }
    return {
      sourceStateSha256,
      sourceHistoryLength: history.length,
      prdSealHash: seal.semantic_hash,
      startCommit,
      pinnedSha,
      ownerSpecId: owner?.spec_id ?? null,
      targetOwnerSpec,
      targetRuntimeRoot,
      targetRuntime,
      executionProfile,
      logicalPipelineId,
      logicalPipelineBootstrap,
      refinementBootstrap: executionProfile.runner_mode === 'pickle'
        && !fs.existsSync(path.join(resolvedSessionDir, 'prd_refined.md')),
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
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  if (options.allowLegacyMaxTimeMigration) {
    // A process may have died after writing one half of the state/logical bootstrap.
    // Recover the durable reverse journal before interpreting either file. The
    // transaction primitive preserves cancellation requests that raced prepare.
    recoverInterruptedTicketTransaction(resolvedSessionDir);
  }
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
  if (state.legacy_max_time_migration
    && !validLegacyMaxTimeMigrationTransaction(state.legacy_max_time_migration, state, resolvedSessionDir)) {
    state = stateManager.update(statePath, (current) => {
      if (current.cancel_requested_at || current.cancelled === true) return current;
      current.active = false;
      current.step = 'blocked';
      current.completed_at = null;
      current.recovery_required = true;
      current.recovery_kind = 'legacy_max_time_migration_corrupt';
      current.recovery_reason = 'legacy max_time migration transaction failed its content hash';
      current.autonomous_owner_recovery_suspended = true;
      appendHistory(current, 'legacy_max_time_migration_corrupt');
      return current;
    });
    return { state, stale: false };
  }
  if (state.step === 'complete' || state.completed_at || state.last_exit_reason === 'completed') {
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
    try {
      const repaired = runTicketTransaction(
        resolvedSessionDir,
        'legacy-max-time-bootstrap',
        [
          statePath,
          path.join(resolvedSessionDir, 'logical-pipeline.json'),
          path.join(resolvedSessionDir, 'prd_refined.md'),
          path.join(resolvedSessionDir, 'refinement-acceptance.json'),
        ],
        () => {
          let exactEvidence = legacyMaxTimeMigrationEvidence(stateManager.read(statePath), resolvedSessionDir);
          if (!exactEvidence
            || exactEvidence.sourceStateSha256 !== legacyEvidence.sourceStateSha256
            || exactEvidence.ownerSpecId !== legacyEvidence.ownerSpecId) {
            throw new Error('Cannot migrate a legacy max_time session after its authenticated evidence changed.');
          }
          if (exactEvidence.refinementBootstrap) {
            atomicWriteFile(
              path.join(resolvedSessionDir, 'prd_refined.md'),
              fs.readFileSync(path.join(resolvedSessionDir, 'prd.md'), 'utf8'),
            );
            writeRefinementAcceptance(resolvedSessionDir, { workingDir: exactEvidence.executionProfile.working_dir });
          }
          if (exactEvidence.logicalPipelineBootstrap === 'create') {
            createLogicalPipeline(resolvedSessionDir, exactEvidence.logicalPipelineId, { nowMs });
            beginAutonomousExecution(resolvedSessionDir, { nowMs: nowMs + 1 });
          } else if (exactEvidence.logicalPipelineBootstrap === 'seal') {
            beginAutonomousExecution(resolvedSessionDir, { nowMs: nowMs + 1 });
          }
          exactEvidence = legacyMaxTimeMigrationEvidence(stateManager.read(statePath), resolvedSessionDir);
          if (!exactEvidence || exactEvidence.logicalPipelineBootstrap !== null
            || exactEvidence.sourceStateSha256 !== legacyEvidence.sourceStateSha256
            || exactEvidence.ownerSpecId !== legacyEvidence.ownerSpecId) {
            throw new Error('Cannot migrate a legacy max_time session after logical bootstrap evidence changed.');
          }
          return Boolean(scheduleAuthenticatedLegacyMaxTimeRollover(
            stateManager,
            statePath,
            {
              nowMs,
              ticketId: typeof state.current_ticket === 'string' ? state.current_ticket : null,
              repairMissingIntent: true,
              legacyInactiveMaxTimeMigration: {
                migrationId: crypto.randomUUID(),
                sourceStateSha256: exactEvidence.sourceStateSha256,
                sourceHistoryLength: exactEvidence.sourceHistoryLength,
                prdSealHash: exactEvidence.prdSealHash,
                startCommit: exactEvidence.startCommit,
                pinnedSha: exactEvidence.pinnedSha,
                sourceOwnerSpecId: exactEvidence.ownerSpecId,
                targetOwnerSpecId: exactEvidence.targetOwnerSpec.spec_id,
                targetOwnerSpec: exactEvidence.targetOwnerSpec as unknown as Record<string, unknown>,
                targetRuntimeRoot: exactEvidence.targetRuntimeRoot,
                targetRuntime: exactEvidence.targetRuntime,
                executionProfile: exactEvidence.executionProfile,
                logicalPipelineId: exactEvidence.logicalPipelineId,
              },
              assertRepairState: (current) => {
                const exact = legacyMaxTimeMigrationEvidence(current, resolvedSessionDir);
                if (!exact || exact.sourceStateSha256 !== exactEvidence.sourceStateSha256
                  || exact.ownerSpecId !== exactEvidence.ownerSpecId
                  || exact.targetOwnerSpec.spec_id !== exactEvidence.targetOwnerSpec.spec_id
                  || exact.targetRuntimeRoot !== exactEvidence.targetRuntimeRoot
                  || JSON.stringify(exact.targetRuntime) !== JSON.stringify(exactEvidence.targetRuntime)
                  || JSON.stringify(exact.executionProfile) !== JSON.stringify(exactEvidence.executionProfile)
                  || exact.logicalPipelineId !== exactEvidence.logicalPipelineId
                  || exact.logicalPipelineBootstrap !== null
                  || exact.prdSealHash !== exactEvidence.prdSealHash
                  || exact.startCommit !== exactEvidence.startCommit
                  || exact.pinnedSha !== exactEvidence.pinnedSha) {
                  throw new Error('Cannot migrate a legacy max_time session after its authenticated evidence changed.');
                }
              },
            },
          ));
        },
      );
      if (repaired) return reconcileSessionLivenessInternal(sessionDir, stateManager, nowMs, options);
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

  // The compatibility pid identifies only the broker. A dead broker can leave
  // an exact guardian or detached descendant ledger behind, so reconcile the
  // complete durable ownership record before classifying this session stale.
  try {
    if (Array.isArray(state.refinement_child_identities)
      && state.refinement_child_identities.length > 0) {
      recoverRefinementProcessOwnership(stateManager, statePath);
      state = stateManager.read(statePath);
    }
    if (activeMonitoredProcessIdentities(state).length > 0) {
      recoverMonitoredProcessOwnership(stateManager, statePath);
      state = stateManager.read(statePath);
    }
  } catch (error) {
    state = stateManager.update(statePath, (current) => {
      current.active = false;
      current.step = current.step === 'complete' ? current.step : 'blocked';
      current.last_exit_reason = runnerMissing ? 'runner_lost_orphaned_child' : 'max_time_orphaned_child';
      current.recovery_required = true;
      current.recovery_kind = 'monitored_process_ownership';
      current.recovery_reason = error instanceof Error ? error.message : String(error);
      current.orphan_child_pid = current.active_child_pid;
      appendHistory(current, String(current.last_exit_reason), current.current_ticket || undefined);
      return current;
    });
    return { state, stale: false };
  }

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
        current.active_child_controller_identity = null;
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
