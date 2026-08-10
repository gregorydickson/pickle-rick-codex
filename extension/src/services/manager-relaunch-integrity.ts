import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import { assertSupervisorLeaseFence, readLogicalPipeline } from './durable-supervisor.js';
import { readPipelineState } from './pipeline-state.js';

/** Telemetry/strategy threshold. It is deliberately not a terminal cap. */
export const CODEX_MANAGER_RELAUNCH_CAP = 10;
export const DECLARED_RUNNER_RELAUNCH_PATHS = Object.freeze([
  'pickle-tmux',
  'pickle-pipeline',
  'detached-loop',
] as const);
export type RunnerRelaunchPath = typeof DECLARED_RUNNER_RELAUNCH_PATHS[number];

interface RelaunchHistoryEntry {
  path: RunnerRelaunchPath;
  timestamp: string;
  recovery_epoch: number;
  recovery_route: ManagerRelaunchRecoveryRoute;
  strategy_hash: string | null;
}

type ManagerRelaunchRecoveryRoute =
  | 'standard_relaunch'
  | 'supervised_authority_reconstruction'
  | 'fenced_executor_takeover';

interface ManagerRelaunchRecoveryArtifact {
  schema_version: 1;
  recovery_epoch: number;
  trigger_count: number;
  route: Exclude<ManagerRelaunchRecoveryRoute, 'standard_relaunch'>;
  strategy_hash: string;
  integrity_key_id: string;
  previous_strategy_hash: string | null;
  authority_snapshot: Record<string, string | null>;
  ownership_snapshot: {
    active: boolean;
    tmux_runner_pid: number | null;
    worker_pid: number | null;
    active_child_pid: number | null;
  };
  execution_plan:
    | {
        kind: 'authority_reconstruction';
        ordered_authority_sources: string[];
        resume_boundary: ManagerResumeBoundary;
        pipeline_state_boundary: ManagerPipelineStateBoundary | null;
      }
    | {
        kind: 'executor_takeover';
        logical_pipeline_hash: string | null;
        logical_pipeline_id: string | null;
        observed_journal_tail_hash: string | null;
        observed_lease_generation: number | null;
        observed_lease_owner: string | null;
        observed_lease_token_hash: string | null;
        require_exclusive_launch_lock: true;
      };
  status: 'prepared' | 'active';
  prepared_at: string;
  activated_at?: string;
  execution_evidence_path?: string;
  execution_receipt_hash?: string;
  consumption_status_source?: 'authenticated_transition_journal';
}

interface ManagerResumeBoundary {
  step: string | null;
  current_ticket: string | null;
  pipeline_phase: string | null;
  pipeline_phase_index: number | null;
}

interface ManagerPipelineStateBoundary {
  schema_version: number;
  started_at: string;
  current_phase: string | null;
  current_phase_index: number | null;
  phase_statuses: Record<string, string>;
  session_history_length: number;
}

interface ManagerRelaunchExecutionEvidence {
  schema_version: 1;
  recovery_epoch: number;
  strategy_hash: string;
  kind: 'authority_reconstruction' | 'executor_takeover';
  activated_at: string;
  receipt_hash?: string;
  authenticated_authority_snapshot?: Record<string, string | null>;
  ordered_authority_sources?: string[];
  prepared_resume_boundary?: ManagerResumeBoundary;
  observed_resume_boundary?: ManagerResumeBoundary;
  restored_resume_boundary?: ManagerResumeBoundary;
  preserved_runtime_hash_before?: string;
  preserved_runtime_hash_after?: string;
  prepared_logical_pipeline_hash?: string | null;
  logical_pipeline_id?: string | null;
  observed_journal_tail_hash?: string | null;
  current_logical_pipeline_hash?: string | null;
  observed_lease_generation?: number | null;
  current_lease_generation?: number | null;
  observed_lease_owner?: string | null;
  current_lease_owner?: string | null;
  observed_lease_token_hash?: string | null;
  current_lease_token_hash?: string | null;
  predecessor_fenced?: true;
  exclusive_launch_lock_required?: true;
}

interface ManagerRelaunchTransitionJournalEntry {
  event: 'activated' | 'consumed';
  recovery_epoch: number;
  strategy_hash: string;
  kind: ManagerRelaunchExecutionEvidence['kind'];
  receipt_hash: string;
  protected_authority_hash: string;
  restored_boundary_hash: string | null;
  recorded_at: string;
  previous_auth_hash: string | null;
  auth_hash: string;
}

export interface RelaunchAuditViolation {
  statePath: string;
  count: number | null;
  cap: number;
  reason: string;
}

export interface RelaunchAuditResult {
  cap: number;
  checkedStatePaths: string[];
  violations: RelaunchAuditViolation[];
}

export function auditCodexManagerRelaunchCaps(sessionDir: string): RelaunchAuditResult {
  const statePath = path.join(sessionDir, 'state.json');
  const violations: RelaunchAuditViolation[] = [];
  const state = readJsonFile<Record<string, unknown>>(statePath, null);
  const rawCount = state?.manager_relaunch_count ?? 0;
  const count = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : null;
  if (!state) {
    violations.push({ statePath, count: null, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'state file is unreadable or absent' });
  } else if (count === null) {
    violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'manager_relaunch_count is not a non-negative integer' });
  }

  const history = state?.manager_relaunch_history;
  if (history !== undefined && !Array.isArray(history)) {
    violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'manager_relaunch_history is not an array' });
  } else if (Array.isArray(history)) {
    for (const entry of history) {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
      if (!value || !DECLARED_RUNNER_RELAUNCH_PATHS.includes(value.path as RunnerRelaunchPath)) {
        violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: `undeclared runner relaunch path: ${String(value?.path ?? '<invalid>')}` });
      }
    }
  }
  if (state && count !== null && count > CODEX_MANAGER_RELAUNCH_CAP) {
    const expectedEpoch = recoveryEpochForCount(count);
    const artifact = readJsonFile<ManagerRelaunchRecoveryArtifact>(
      path.join(sessionDir, 'manager-relaunch-recovery.json'),
      null,
    );
    const route = state.manager_relaunch_recovery_route;
    const strategyHash = state.manager_relaunch_strategy_hash;
    const integrityKey = readIntegrityKey(sessionDir, false);
    const expectedStrategyHash = artifact && integrityKey ? authenticate(integrityKey, {
      material_route: artifact.route,
      authority_snapshot: artifact.authority_snapshot,
      ownership_fence: artifact.ownership_snapshot,
      execution_plan: artifact.execution_plan,
      previous_strategy_hash: artifact.previous_strategy_hash,
    }) : null;
    if (state.manager_relaunch_recovery_epoch !== expectedEpoch
      || !['supervised_authority_reconstruction', 'fenced_executor_takeover'].includes(String(route))
      || typeof strategyHash !== 'string' || !/^[a-f0-9]{64}$/.test(strategyHash)
      || !artifact || artifact.schema_version !== 1 || artifact.recovery_epoch !== expectedEpoch
      || artifact.route !== route || artifact.strategy_hash !== strategyHash
      || !integrityKey || artifact.integrity_key_id !== sha256(integrityKey.toString('base64'))
      || artifact.strategy_hash !== expectedStrategyHash || !['prepared', 'active'].includes(artifact.status)
      || (artifact.status === 'prepared' && state.manager_relaunch_recovery_status !== 'prepared')) {
      violations.push({
        statePath,
        count,
        cap: CODEX_MANAGER_RELAUNCH_CAP,
        reason: 'manager relaunch recovery epoch or authenticated strategy artifact is invalid',
      });
    } else if (artifact.status === 'active') {
      const evidencePath = typeof artifact.execution_evidence_path === 'string'
        && path.basename(artifact.execution_evidence_path) === artifact.execution_evidence_path
        ? path.join(sessionDir, artifact.execution_evidence_path)
        : null;
      const evidence = evidencePath
        ? readJsonFile<ManagerRelaunchExecutionEvidence>(evidencePath, null)
        : null;
      if (!evidence || evidence.schema_version !== 1
        || artifact.consumption_status_source !== 'authenticated_transition_journal'
        || evidence.recovery_epoch !== artifact.recovery_epoch
        || evidence.strategy_hash !== artifact.strategy_hash
        || evidence.kind !== artifact.execution_plan.kind
        || !validRouteExecutionEvidence(sessionDir, state, artifact, evidence, integrityKey)) {
        violations.push({
          statePath,
          count,
          cap: CODEX_MANAGER_RELAUNCH_CAP,
          reason: 'active manager relaunch recovery lacks authenticated route execution evidence',
        });
      }
    }
  }
  return { cap: CODEX_MANAGER_RELAUNCH_CAP, checkedStatePaths: [statePath], violations };
}

function validConsumedPipelineStateEvolution(
  sessionDir: string,
  state: Record<string, unknown>,
  prepared: ManagerPipelineStateBoundary | null,
  consumedAt: string,
): boolean {
  if (!prepared) return false;
  try {
    const current = readPipelineState(sessionDir);
    const phases = Object.keys(prepared.phase_statuses);
    if (current.schema_version !== prepared.schema_version
      || current.started_at !== prepared.started_at
      || canonicalize(Object.keys(current.phase_statuses)) !== canonicalize(phases)
      || phases.some((phase) => prepared.phase_statuses[phase] === 'done' && current.phase_statuses[phase] !== 'done')) {
      return false;
    }
    const consumedMs = Date.parse(consumedAt);
    const history = Array.isArray(state.history) ? state.history as Array<Record<string, unknown>> : [];
    if (!Number.isFinite(consumedMs) || history.length < prepared.session_history_length) return false;
    const replayed = { ...prepared.phase_statuses };
    const causalHistory = history.slice(prepared.session_history_length).filter((entry) => {
      const timestamp = Date.parse(String(entry.timestamp || ''));
      return Number.isFinite(timestamp) && timestamp >= consumedMs
        && ['pipeline_phase_started', 'pipeline_phase_done', 'pipeline_phase_failed'].includes(String(entry.step));
    });
    if (causalHistory.length === 0) return false;
    const reaffirmedPhases = new Set<string>();
    for (const entry of causalHistory) {
      const phase = typeof entry.ticket === 'string' ? entry.ticket : '';
      if (!Object.hasOwn(replayed, phase)) return false;
      const expectedPhase = phases.find((candidate) => replayed[candidate] !== 'done') ?? null;
      if (phase !== expectedPhase) return false;
      if (entry.step === 'pipeline_phase_started') {
        if (!['todo', 'failed', 'running'].includes(replayed[phase])) return false;
        replayed[phase] = 'running';
        reaffirmedPhases.add(phase);
      } else {
        if (replayed[phase] !== 'running') return false;
        if (prepared.phase_statuses[phase] === 'running' && !reaffirmedPhases.has(phase)) return false;
        replayed[phase] = entry.step === 'pipeline_phase_done' ? 'done' : 'failed';
      }
    }
    if (canonicalize(replayed) !== canonicalize(current.phase_statuses)) return false;
    const expectedCurrent = phases.find((phase) => replayed[phase] !== 'done') ?? null;
    const expectedIndex = expectedCurrent === null ? null : phases.indexOf(expectedCurrent);
    return current.current_phase === expectedCurrent && current.current_phase_index === expectedIndex;
  } catch {
    return false;
  }
}

function validRouteExecutionEvidence(
  sessionDir: string,
  state: Record<string, unknown>,
  artifact: ManagerRelaunchRecoveryArtifact,
  evidence: ManagerRelaunchExecutionEvidence,
  integrityKey: Buffer,
): boolean {
  if (typeof evidence.receipt_hash !== 'string' || evidence.receipt_hash !== artifact.execution_receipt_hash) return false;
  const receiptMaterial = { ...evidence };
  delete receiptMaterial.receipt_hash;
  if (authenticate(integrityKey, receiptMaterial) !== evidence.receipt_hash) return false;
  const journal = Array.isArray(state.manager_relaunch_transition_journal)
    ? state.manager_relaunch_transition_journal as ManagerRelaunchTransitionJournalEntry[] : [];
  if (!validTransitionChain(integrityKey, journal)) return false;
  const transition = journal.find((entry) => entry?.strategy_hash === artifact.strategy_hash && entry.event === 'activated');
  const consumption = journal.find((entry) => entry?.strategy_hash === artifact.strategy_hash && entry.event === 'consumed');
  if (!transition || transition.recovery_epoch !== artifact.recovery_epoch
    || transition.kind !== evidence.kind || transition.receipt_hash !== evidence.receipt_hash
    || transition.protected_authority_hash !== artifact.authority_snapshot.state
    || artifact.activated_at !== evidence.activated_at
    || artifact.activated_at !== transition.recorded_at
    || artifact.activated_at !== state.manager_relaunch_recovery_activated_at
    || state.manager_relaunch_recovery_status !== (consumption ? 'consumed' : 'active')
    || (consumption
      ? state.manager_relaunch_recovery_consumed_at !== consumption.recorded_at
      : state.manager_relaunch_recovery_consumed_at != null)) return false;
  if (artifact.execution_plan.kind === 'authority_reconstruction') {
    const reconstructionPlan = artifact.execution_plan;
    const currentSnapshot = authoritySnapshot(sessionDir, state);
    if (canonicalize(evidence.prepared_resume_boundary) !== canonicalize(reconstructionPlan.resume_boundary)
      || canonicalize(evidence.restored_resume_boundary) !== canonicalize(reconstructionPlan.resume_boundary)
      || evidence.preserved_runtime_hash_before !== evidence.preserved_runtime_hash_after
      || transition.restored_boundary_hash !== sha256(reconstructionPlan.resume_boundary)
      || sha256(protectedState(state)) !== artifact.authority_snapshot.state
      || (!consumption
        && canonicalize(resumeBoundary(state)) !== canonicalize(reconstructionPlan.resume_boundary))
      || canonicalize(evidence.ordered_authority_sources)
        !== canonicalize(reconstructionPlan.ordered_authority_sources)) return false;
    return reconstructionPlan.ordered_authority_sources.every((source) => {
      if (evidence.authenticated_authority_snapshot?.[source] !== artifact.authority_snapshot[source]) return false;
      if (currentSnapshot[source] === artifact.authority_snapshot[source]) return true;
      return source === 'pipeline_state' && consumption !== undefined
        && validConsumedPipelineStateEvolution(
          sessionDir,
          state,
          reconstructionPlan.pipeline_state_boundary,
          consumption.recorded_at,
        );
    });
  }
  const takeoverPlan = artifact.execution_plan;
  if (evidence.predecessor_fenced !== true
    || evidence.exclusive_launch_lock_required !== true
    || evidence.observed_lease_generation !== takeoverPlan.observed_lease_generation
    || evidence.observed_lease_owner !== takeoverPlan.observed_lease_owner
    || evidence.observed_lease_token_hash !== takeoverPlan.observed_lease_token_hash
    || evidence.prepared_logical_pipeline_hash !== takeoverPlan.logical_pipeline_hash
    || evidence.logical_pipeline_id !== takeoverPlan.logical_pipeline_id
    || evidence.observed_journal_tail_hash !== takeoverPlan.observed_journal_tail_hash
    || evidence.current_lease_generation === null || evidence.current_lease_generation === undefined
    || evidence.observed_lease_generation === null || evidence.observed_lease_generation === undefined
    || evidence.current_lease_generation <= evidence.observed_lease_generation
    || evidence.current_lease_owner === evidence.observed_lease_owner
    || evidence.current_lease_token_hash === evidence.observed_lease_token_hash) return false;
  try {
    const logical = readLogicalPipeline(sessionDir);
    if (logical.pipeline_id !== takeoverPlan.logical_pipeline_id) return false;
    const observedIndex = takeoverPlan.observed_journal_tail_hash === null
      ? -1 : logical.events.findIndex((event) => event.event_hash === takeoverPlan.observed_journal_tail_hash);
    if (takeoverPlan.observed_journal_tail_hash !== null && observedIndex < 0) return false;
    return logical.events.slice(observedIndex + 1).some((event) => {
      const lease = event.details.lease as Record<string, unknown> | undefined;
      return (event.kind === 'lease_recovered' || event.kind === 'lease_acquired')
        && event.details.generation === evidence.current_lease_generation
        && event.details.owner_id === evidence.current_lease_owner
        && typeof lease?.token === 'string'
        && sha256(lease.token) === evidence.current_lease_token_hash;
    });
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function integrityKeyPath(sessionDir: string): string {
  const sessionsRoot = path.dirname(sessionDir);
  if (path.basename(sessionsRoot) === 'sessions') {
    return path.join(path.dirname(sessionsRoot), 'manager-relaunch-integrity.key');
  }
  // Isolated test/nonstandard roots still keep the key outside the session.
  return path.join(sessionsRoot, `.pickle-rick-manager-relaunch-integrity-${process.pid}.key`);
}

function readIntegrityKey(sessionDir: string, create: boolean): Buffer | null {
  const keyPath = integrityKeyPath(sessionDir);
  try {
    const stat = fs.lstatSync(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const key = fs.readFileSync(keyPath);
    return key.length === 32 ? key : null;
  } catch {
    if (!create) return null;
  }
  const key = crypto.randomBytes(32);
  try {
    const fd = fs.openSync(keyPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, key);
    fs.closeSync(fd);
    return key;
  } catch {
    return readIntegrityKey(sessionDir, false);
  }
}

function authenticate(key: Buffer, value: unknown): string {
  return crypto.createHmac('sha256', key).update(canonicalize(value)).digest('hex');
}

function authenticatedTransition(
  key: Buffer,
  entry: Omit<ManagerRelaunchTransitionJournalEntry, 'auth_hash'>,
): ManagerRelaunchTransitionJournalEntry {
  return { ...entry, auth_hash: authenticate(key, entry) };
}

function validTransitionChain(key: Buffer, journal: ManagerRelaunchTransitionJournalEntry[]): boolean {
  let previous: string | null = null;
  for (const entry of journal) {
    const { auth_hash: authHash, ...material } = entry;
    if (entry.previous_auth_hash !== previous || authHash !== authenticate(key, material)) return false;
    previous = authHash;
  }
  return true;
}

function fileHash(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function recoveryEpochForCount(count: number): number {
  return count <= 0 ? 1 : Math.floor((count - 1) / CODEX_MANAGER_RELAUNCH_CAP) + 1;
}

const RUNTIME_STATE_KEYS = new Set([
  'active', 'tmux_mode', 'tmux_runner_pid', 'tmux_session_name', 'tmux_runner_binding',
  'preserve_tmux_monitor', 'worker_pid', 'worker_identity', 'active_child_pid',
  'active_child_identity', 'active_child_identities', 'active_child_kind', 'active_child_command',
  'active_child_controller_pid', 'active_child_controller_identity', 'last_exit_reason',
  'max_iterations', 'max_time_minutes', 'history',
  'session_map_cwds', 'cancel_requested_at', 'cancel_reason',
]);

function resumeBoundary(state: Record<string, unknown>): ManagerResumeBoundary {
  return {
    step: typeof state.step === 'string' ? state.step : null,
    current_ticket: typeof state.current_ticket === 'string' ? state.current_ticket : null,
    pipeline_phase: typeof state.pipeline_phase === 'string' ? state.pipeline_phase : null,
    pipeline_phase_index: Number.isInteger(state.pipeline_phase_index)
      ? Number(state.pipeline_phase_index) : null,
  };
}

function runtimeSnapshot(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => RUNTIME_STATE_KEYS.has(key)));
}

const IMMUTABLE_AUTHORITY_STATE_KEYS = new Set([
  'schema_version', 'working_dir', 'session_dir', 'original_prompt', 'start_commit',
  'command_template', 'pipeline_mode', 'pipeline_phases', 'pipeline_total_phases',
]);

function protectedState(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => IMMUTABLE_AUTHORITY_STATE_KEYS.has(key)));
}

function pipelineStateBoundary(
  sessionDir: string,
  state: Record<string, unknown>,
): ManagerPipelineStateBoundary | null {
  try {
    const value = readPipelineState(sessionDir);
    return {
      schema_version: value.schema_version,
      started_at: value.started_at,
      current_phase: value.current_phase,
      current_phase_index: value.current_phase_index,
      phase_statuses: { ...value.phase_statuses },
      session_history_length: Array.isArray(state.history) ? state.history.length : 0,
    };
  } catch {
    return null;
  }
}

function authoritySnapshot(sessionDir: string, state: Record<string, unknown>): Record<string, string | null> {
  return {
    state: sha256(protectedState(state)),
    pipeline_contract: fileHash(path.join(sessionDir, 'pipeline.json')),
    logical_pipeline: fileHash(path.join(sessionDir, 'logical-pipeline.json')),
    pipeline_state: fileHash(path.join(sessionDir, 'pipeline-state.json')),
    refinement_manifest: fileHash(path.join(sessionDir, 'refinement_manifest.json')),
    legacy_adoption: fileHash(path.join(sessionDir, 'legacy-session-adoption.json')),
  };
}

function prepareRecoveryEpoch(
  sessionDir: string,
  state: Record<string, unknown>,
  recoveryEpoch: number,
  triggerCount: number,
  integrityKey: Buffer,
): ManagerRelaunchRecoveryArtifact {
  const hasLogicalPipeline = fileHash(path.join(sessionDir, 'logical-pipeline.json')) !== null;
  const route: ManagerRelaunchRecoveryArtifact['route'] = recoveryEpoch % 2 === 0 || !hasLogicalPipeline
    ? 'supervised_authority_reconstruction'
    : 'fenced_executor_takeover';
  const snapshot = authoritySnapshot(sessionDir, state);
  const ownership = {
    active: state.active === true,
    tmux_runner_pid: Number.isInteger(state.tmux_runner_pid) ? Number(state.tmux_runner_pid) : null,
    worker_pid: Number.isInteger(state.worker_pid) ? Number(state.worker_pid) : null,
    active_child_pid: Number.isInteger(state.active_child_pid) ? Number(state.active_child_pid) : null,
  };
  const previousStrategyHash = typeof state.manager_relaunch_strategy_hash === 'string'
    ? state.manager_relaunch_strategy_hash : null;
  const logical = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'logical-pipeline.json'), null);
  const logicalLease = logical?.lease && typeof logical.lease === 'object'
    ? logical.lease as Record<string, unknown> : null;
  const logicalEvents = Array.isArray(logical?.events) ? logical.events as Array<Record<string, unknown>> : [];
  const executionPlan: ManagerRelaunchRecoveryArtifact['execution_plan'] = route === 'supervised_authority_reconstruction'
    ? {
        kind: 'authority_reconstruction',
        ordered_authority_sources: Object.entries(snapshot)
          .filter(([name]) => name !== 'logical_pipeline')
          .filter(([, digest]) => digest !== null)
          .map(([name]) => name),
        resume_boundary: resumeBoundary(state),
        pipeline_state_boundary: pipelineStateBoundary(sessionDir, state),
      }
    : {
        kind: 'executor_takeover',
        logical_pipeline_hash: snapshot.logical_pipeline,
        logical_pipeline_id: typeof logical?.pipeline_id === 'string' ? logical.pipeline_id : null,
        observed_journal_tail_hash: typeof logicalEvents.at(-1)?.event_hash === 'string'
          ? String(logicalEvents.at(-1)?.event_hash) : null,
        observed_lease_generation: Number.isInteger(logical?.lease_generation)
          ? Number(logical?.lease_generation) : null,
        observed_lease_owner: typeof logicalLease?.owner_id === 'string' ? logicalLease.owner_id : null,
        observed_lease_token_hash: typeof logicalLease?.token === 'string' ? sha256(logicalLease.token) : null,
        require_exclusive_launch_lock: true,
      };
  const strategyHash = authenticate(integrityKey, {
    material_route: route,
    authority_snapshot: snapshot,
    ownership_fence: ownership,
    execution_plan: executionPlan,
    previous_strategy_hash: previousStrategyHash,
  });
  return {
    schema_version: 1,
    recovery_epoch: recoveryEpoch,
    trigger_count: triggerCount,
    route,
    strategy_hash: strategyHash,
    integrity_key_id: sha256(integrityKey.toString('base64')),
    previous_strategy_hash: previousStrategyHash,
    authority_snapshot: snapshot,
    ownership_snapshot: ownership,
    execution_plan: executionPlan,
    status: 'prepared',
    prepared_at: new Date().toISOString(),
  };
}

export function recordCodexManagerRelaunch(sessionDir: string, relaunchPath: RunnerRelaunchPath): number {
  if (!DECLARED_RUNNER_RELAUNCH_PATHS.includes(relaunchPath)) {
    throw new Error(`Undeclared Codex runner relaunch path: ${relaunchPath}`);
  }
  const audit = auditCodexManagerRelaunchCaps(sessionDir);
  if (audit.violations.length) {
    throw new Error(`Cannot relaunch Codex manager: ${audit.violations.map((item) => item.reason).join('; ')}`);
  }
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  let nextCount = 0;
  manager.update(statePath, (state) => {
    const current = Number(state.manager_relaunch_count || 0);
    if (!Number.isInteger(current) || current < 0) {
      throw new Error(`Codex manager relaunch count is invalid for ${sessionDir}`);
    }
    nextCount = current + 1;
    const priorEpoch = recoveryEpochForCount(current);
    const recoveryEpoch = recoveryEpochForCount(nextCount);
    let route = typeof state.manager_relaunch_recovery_route === 'string'
      ? state.manager_relaunch_recovery_route as ManagerRelaunchRecoveryRoute
      : 'standard_relaunch';
    let strategyHash = typeof state.manager_relaunch_strategy_hash === 'string'
      ? state.manager_relaunch_strategy_hash : null;
    if (recoveryEpoch > priorEpoch) {
      const integrityKey = readIntegrityKey(sessionDir, true);
      if (!integrityKey) throw new Error('Cannot create manager recovery integrity key outside the session directory.');
      const recovery = prepareRecoveryEpoch(sessionDir, state, recoveryEpoch, current, integrityKey);
      atomicWriteJson(path.join(sessionDir, 'manager-relaunch-recovery.json'), recovery);
      state.manager_relaunch_recovery_epoch = recoveryEpoch;
      state.manager_relaunch_recovery_route = recovery.route;
      state.manager_relaunch_strategy_hash = recovery.strategy_hash;
      state.manager_relaunch_recovery_status = 'prepared';
      state.manager_relaunch_recovery_activated_at = null;
      state.manager_relaunch_recovery_consumed_at = null;
      route = recovery.route;
      strategyHash = recovery.strategy_hash;
    } else {
      state.manager_relaunch_recovery_epoch ??= recoveryEpoch;
      state.manager_relaunch_recovery_route ??= route;
    }
    state.manager_relaunch_count = nextCount;
    const history = Array.isArray(state.manager_relaunch_history)
      ? state.manager_relaunch_history as unknown[]
      : [];
    history.push({
      path: relaunchPath,
      timestamp: new Date().toISOString(),
      recovery_epoch: recoveryEpoch,
      recovery_route: route,
      strategy_hash: strategyHash,
    } satisfies RelaunchHistoryEntry);
    state.manager_relaunch_history = history;
    return state;
  });
  return nextCount;
}

/** Activate the prepared route from inside the relaunched runner while its
 * session-operation/launch ownership is held. This validates the material
 * plan before normal runner startup and never clears an existing lease. */
export function activatePreparedManagerRelaunchRecovery(
  sessionDir: string,
): ManagerRelaunchRecoveryArtifact | null {
  const statePath = path.join(sessionDir, 'state.json');
  const state = readJsonFile<Record<string, unknown>>(statePath, null);
  if (!state || Number(state.manager_relaunch_recovery_epoch || 1) <= 1) return null;
  const audit = auditCodexManagerRelaunchCaps(sessionDir);
  if (audit.violations.length > 0) {
    throw new Error(`Cannot activate manager relaunch recovery: ${audit.violations.map(({ reason }) => reason).join('; ')}`);
  }
  const artifactPath = path.join(sessionDir, 'manager-relaunch-recovery.json');
  const artifact = readJsonFile<ManagerRelaunchRecoveryArtifact>(artifactPath, null);
  if (!artifact || artifact.strategy_hash !== state.manager_relaunch_strategy_hash) {
    throw new Error('Cannot activate manager relaunch recovery without its authenticated strategy artifact.');
  }
  const integrityKey = readIntegrityKey(sessionDir, false);
  if (!integrityKey || artifact.integrity_key_id !== sha256(integrityKey.toString('base64'))) {
    throw new Error('Cannot activate manager relaunch recovery without its external integrity key.');
  }
  if (artifact.status === 'active') return artifact;
  const activatedAt = artifact.activated_at ?? new Date().toISOString();
  let evidence: ManagerRelaunchExecutionEvidence;
  if (artifact.execution_plan.kind === 'authority_reconstruction') {
    const available = new Set(Object.entries(artifact.authority_snapshot)
      .filter(([, digest]) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
      .map(([name]) => name));
    if (artifact.execution_plan.ordered_authority_sources.some((source) => !available.has(source))) {
      throw new Error('Manager authority reconstruction plan references unauthenticated state.');
    }
    const currentSnapshot = authoritySnapshot(sessionDir, state);
    if (artifact.execution_plan.ordered_authority_sources.some(
      (source) => currentSnapshot[source] !== artifact.authority_snapshot[source],
    )) {
      throw new Error('Manager authority changed before supervised reconstruction could authenticate it.');
    }
    if (fs.existsSync(path.join(sessionDir, 'logical-pipeline.json'))) {
      const logical = readLogicalPipeline(sessionDir);
      if (!logical.lease) {
        throw new Error('Durable manager authority reconstruction requires newly acquired supervisor ownership.');
      }
      assertSupervisorLeaseFence(sessionDir, logical.lease.owner_id, logical.lease.token);
    }
    const observedBoundary = resumeBoundary(state);
    const runtimeHashBefore = sha256(runtimeSnapshot(state));
    const restoredState = new StateManager().update(statePath, (current) => {
      if (current.manager_relaunch_strategy_hash !== artifact.strategy_hash
        || sha256(protectedState(current)) !== artifact.authority_snapshot.state) {
        throw new Error('Manager authority changed during supervised reconstruction.');
      }
      const boundary = artifact.execution_plan.kind === 'authority_reconstruction'
        ? artifact.execution_plan.resume_boundary : null;
      if (!boundary) throw new Error('Manager authority reconstruction boundary is unavailable.');
      current.step = boundary.step;
      current.current_ticket = boundary.current_ticket;
      current.pipeline_phase = boundary.pipeline_phase;
      current.pipeline_phase_index = boundary.pipeline_phase_index;
      return current;
    });
    const restoredBoundary = resumeBoundary(restoredState);
    const runtimeHashAfter = sha256(runtimeSnapshot(restoredState));
    if (canonicalize(restoredBoundary) !== canonicalize(artifact.execution_plan.resume_boundary)
      || runtimeHashAfter !== runtimeHashBefore) {
      throw new Error('Manager authority reconstruction did not preserve runtime ownership at the prepared resume boundary.');
    }
    evidence = {
      schema_version: 1,
      recovery_epoch: artifact.recovery_epoch,
      strategy_hash: artifact.strategy_hash,
      kind: 'authority_reconstruction',
      activated_at: activatedAt,
      authenticated_authority_snapshot: authoritySnapshot(sessionDir, restoredState),
      ordered_authority_sources: artifact.execution_plan.ordered_authority_sources,
      prepared_resume_boundary: artifact.execution_plan.resume_boundary,
      observed_resume_boundary: observedBoundary,
      restored_resume_boundary: restoredBoundary,
      preserved_runtime_hash_before: runtimeHashBefore,
      preserved_runtime_hash_after: runtimeHashAfter,
    };
  } else {
    const takeoverPlan = artifact.execution_plan;
    if (takeoverPlan.require_exclusive_launch_lock !== true) {
      throw new Error('Manager executor takeover plan does not require exclusive launch ownership.');
    }
    const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
    const logical = readLogicalPipeline(sessionDir);
    const logicalLease = logical.lease;
    const currentLogicalHash = fileHash(logicalPath);
    const currentLeaseGeneration = logicalLease?.generation ?? null;
    const currentLeaseOwner = logicalLease?.owner_id ?? null;
    const currentLeaseTokenHash = logicalLease ? sha256(logicalLease.token) : null;
    const observedGeneration = takeoverPlan.observed_lease_generation;
    const observedTailIndex = takeoverPlan.observed_journal_tail_hash === null
      ? -1 : logical.events.findIndex((event) => event.event_hash === takeoverPlan.observed_journal_tail_hash);
    if (!logicalLease || observedGeneration === null
      || logical.pipeline_id !== takeoverPlan.logical_pipeline_id
      || (takeoverPlan.observed_journal_tail_hash !== null && observedTailIndex < 0)
      || currentLeaseGeneration === null || currentLeaseGeneration <= observedGeneration
      || currentLeaseOwner === takeoverPlan.observed_lease_owner
      || (takeoverPlan.observed_lease_token_hash !== null
        && currentLeaseTokenHash === takeoverPlan.observed_lease_token_hash)) {
      throw new Error('Manager executor takeover requires a new owner on a strictly newer fenced lease generation.');
    }
    assertSupervisorLeaseFence(sessionDir, logicalLease.owner_id, logicalLease.token);
    evidence = {
      schema_version: 1,
      recovery_epoch: artifact.recovery_epoch,
      strategy_hash: artifact.strategy_hash,
      kind: 'executor_takeover',
      activated_at: activatedAt,
      prepared_logical_pipeline_hash: takeoverPlan.logical_pipeline_hash,
      logical_pipeline_id: logical.pipeline_id,
      observed_journal_tail_hash: takeoverPlan.observed_journal_tail_hash,
      current_logical_pipeline_hash: currentLogicalHash,
      observed_lease_generation: takeoverPlan.observed_lease_generation,
      current_lease_generation: currentLeaseGeneration,
      observed_lease_owner: takeoverPlan.observed_lease_owner,
      current_lease_owner: currentLeaseOwner,
      observed_lease_token_hash: takeoverPlan.observed_lease_token_hash,
      current_lease_token_hash: currentLeaseTokenHash,
      predecessor_fenced: true,
      exclusive_launch_lock_required: true,
    };
  }
  evidence.receipt_hash = authenticate(integrityKey, evidence);
  const evidenceName = `manager-relaunch-recovery-epoch-${artifact.recovery_epoch}-${artifact.execution_plan.kind}.json`;
  atomicWriteJson(path.join(sessionDir, evidenceName), evidence);
  artifact.status = 'active';
  artifact.activated_at = activatedAt;
  artifact.execution_evidence_path = evidenceName;
  artifact.execution_receipt_hash = evidence.receipt_hash;
  artifact.consumption_status_source = 'authenticated_transition_journal';
  new StateManager().update(statePath, (current) => {
    if (current.manager_relaunch_strategy_hash !== artifact.strategy_hash) {
      throw new Error('Manager relaunch strategy changed before runner activation.');
    }
    current.manager_relaunch_recovery_status = 'active';
    current.manager_relaunch_recovery_activated_at = artifact.activated_at;
    const journal = Array.isArray(current.manager_relaunch_transition_journal)
      ? current.manager_relaunch_transition_journal as ManagerRelaunchTransitionJournalEntry[] : [];
    if (!validTransitionChain(integrityKey, journal)) {
      throw new Error('Manager relaunch transition journal authentication failed before activation.');
    }
    const previousAuthHash = journal.at(-1)?.auth_hash ?? null;
    journal.push(authenticatedTransition(integrityKey, {
      event: 'activated',
      recovery_epoch: artifact.recovery_epoch,
      strategy_hash: artifact.strategy_hash,
      kind: evidence.kind,
      receipt_hash: evidence.receipt_hash as string,
      protected_authority_hash: artifact.authority_snapshot.state as string,
      restored_boundary_hash: evidence.kind === 'authority_reconstruction'
        ? sha256(artifact.execution_plan.kind === 'authority_reconstruction'
          ? artifact.execution_plan.resume_boundary : null)
        : null,
      recorded_at: activatedAt,
      previous_auth_hash: previousAuthHash,
    }));
    current.manager_relaunch_transition_journal = journal;
    return current;
  });
  atomicWriteJson(artifactPath, artifact);
  return artifact;
}

/** Mark the authenticated recovery checkpoint as consumed after the runner has
 * entered its next owned phase. Later audit uses the durable transition journal
 * rather than mistaking legitimate scheduler movement for checkpoint drift. */
export function consumeManagerRelaunchRecovery(sessionDir: string): void {
  const artifactPath = path.join(sessionDir, 'manager-relaunch-recovery.json');
  const artifact = readJsonFile<ManagerRelaunchRecoveryArtifact>(artifactPath, null);
  if (!artifact || artifact.status !== 'active' || !artifact.execution_receipt_hash) return;
  const integrityKey = readIntegrityKey(sessionDir, false);
  if (!integrityKey || artifact.integrity_key_id !== sha256(integrityKey.toString('base64'))) {
    throw new Error('Manager relaunch recovery consumption requires its external integrity key.');
  }
  new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
    const journal = Array.isArray(state.manager_relaunch_transition_journal)
      ? state.manager_relaunch_transition_journal as ManagerRelaunchTransitionJournalEntry[] : [];
    if (!validTransitionChain(integrityKey, journal)) {
      throw new Error('Manager relaunch recovery transition journal authentication failed before consumption.');
    }
    const transition = journal.find((entry) => entry.strategy_hash === artifact.strategy_hash && entry.event === 'activated');
    if (!transition || transition.receipt_hash !== artifact.execution_receipt_hash) {
      throw new Error('Manager relaunch recovery cannot be consumed without its authenticated transition journal.');
    }
    const existingConsumption = journal.find(
      (entry) => entry.strategy_hash === artifact.strategy_hash && entry.event === 'consumed',
    );
    if (existingConsumption) {
      if (state.manager_relaunch_recovery_status !== 'consumed'
        || state.manager_relaunch_recovery_consumed_at !== existingConsumption.recorded_at) {
        throw new Error('Manager relaunch recovery consumption state diverges from its authenticated transition.');
      }
      return state;
    }
    if (state.manager_relaunch_recovery_status !== 'active'
      || state.manager_relaunch_recovery_consumed_at != null) {
      throw new Error('Manager relaunch recovery consumption state is not active and clean.');
    }
    const consumedAt = new Date().toISOString();
    {
      journal.push(authenticatedTransition(integrityKey, {
        event: 'consumed',
        recovery_epoch: artifact.recovery_epoch,
        strategy_hash: artifact.strategy_hash,
        kind: transition.kind,
        receipt_hash: transition.receipt_hash,
        protected_authority_hash: transition.protected_authority_hash,
        restored_boundary_hash: transition.restored_boundary_hash,
        recorded_at: consumedAt,
        previous_auth_hash: journal.at(-1)?.auth_hash ?? null,
      }));
    }
    state.manager_relaunch_recovery_status = 'consumed';
    state.manager_relaunch_recovery_consumed_at = consumedAt;
    state.manager_relaunch_transition_journal = journal;
    return state;
  });
}

export function auditDeclaredRunnerRelaunchCallsites(sourceRoot: string): string[] {
  const expected = new Map<string, RunnerRelaunchPath>([
    ['bin/pickle-tmux.ts', 'pickle-tmux'],
    ['bin/pickle-pipeline.ts', 'pickle-pipeline'],
    ['services/detached-launch.ts', 'detached-loop'],
  ]);
  const violations: string[] = [];
  const observed = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const relative = path.relative(sourceRoot, filePath).split(path.sep).join('/');
        if (relative === 'services/manager-relaunch-integrity.ts') continue;
        const text = fs.readFileSync(filePath, 'utf8');
        if (!text.includes('recordCodexManagerRelaunch(')) continue;
        observed.add(relative);
        const declared = expected.get(relative);
        if (!declared || !text.includes(`, '${declared}')`)) {
          violations.push(`undeclared or mismatched relaunch callsite: ${relative}`);
        }
      }
    }
  };
  walk(sourceRoot);
  for (const relative of expected.keys()) {
    if (!observed.has(relative)) violations.push(`missing declared relaunch callsite: ${relative}`);
  }
  return violations;
}
