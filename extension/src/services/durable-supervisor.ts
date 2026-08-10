import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir } from './pickle-utils.js';
import {
  type CreatePrdSealInput,
  readPrdSeal,
  replacePrdSealAfterRevision,
} from './prd-seal.js';
import { StateManager } from './state-manager.js';
import {
  assertRecordedActiveChildRecovered,
  inspectProcessLivenessIdentity,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { assertCitadelReleaseApproval, reconcileValidatedCitadelTelemetry } from './citadel.js';
import { reconcileInterruptedModelCallTelemetry } from './productive-autonomy.js';

export const LOGICAL_PIPELINE_SCHEMA_VERSION = 1;
export const LOGICAL_PIPELINE_FILE_NAME = 'logical-pipeline.json';
export const LOGICAL_PIPELINE_TERMINAL_STATES = ['completed', 'cancelled'] as const;
export const LOGICAL_PIPELINE_CONTROL_STATES = [
  'prd_development',
  'autonomous_execution',
  'prd_revision_required',
] as const;

export type LogicalPipelineTerminalState = (typeof LOGICAL_PIPELINE_TERMINAL_STATES)[number];
export type LogicalPipelineControlState = (typeof LOGICAL_PIPELINE_CONTROL_STATES)[number];

export interface SupervisorLease {
  owner_id: string;
  token: string;
  generation: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  owner_identity?: PersistedProcessIdentity;
}

export interface InstalledRuntimeDescriptor {
  runtime_id: string;
  version: string;
  build_hash: string;
  min_state_schema: number;
  max_state_schema: number;
}

export interface RuntimeHandoffResult {
  request_id: string;
  lease: SupervisorLease;
  resume_checkpoint: Record<string, unknown>;
  state: LogicalPipelineState;
}

export interface RuntimeHandoffSourceExitIntent {
  request_id: string;
  owner_id: string;
  owner_identity: PersistedProcessIdentity;
  source_runtime: InstalledRuntimeDescriptor;
}

export class SupervisorCheckpointIntegrityError extends Error {
  constructor(receiptId: string) {
    super(`Supervisor checkpoint receipt ${receiptId} conflicts with its durable payload.`);
    this.name = 'SupervisorCheckpointIntegrityError';
  }
}

export interface LogicalPipelineEvent {
  sequence: number;
  event_id: string;
  kind: string;
  occurred_at: string;
  previous_hash: string | null;
  event_hash: string;
  details: Record<string, unknown>;
}

export interface LogicalPipelineState {
  schema_version: number;
  pipeline_id: string;
  control_state: LogicalPipelineControlState;
  terminal_state: LogicalPipelineTerminalState | null;
  prd_seal_hash: string | null;
  lease: SupervisorLease | null;
  lease_generation: number;
  executor_restart_count: number;
  events: LogicalPipelineEvent[];
}

interface ClockOptions {
  nowMs?: number;
}

interface TerminalOptions extends ClockOptions {
  ownerId?: string;
  token?: string;
}

interface AcquireLeaseOptions extends ClockOptions {
  ownerId: string;
  ttlMs: number;
  ownerIdentity?: PersistedProcessIdentity;
}

interface RenewLeaseOptions extends AcquireLeaseOptions {
  token: string;
}

export interface WatchdogRecoveryOptions extends AcquireLeaseOptions {
  executorAlive?: (ownerId: string, identity?: PersistedProcessIdentity) => boolean;
}

export interface WatchdogRecoveryResult {
  recovered: boolean;
  reason: 'healthy' | 'missing_lease' | 'expired_lease' | 'dead_executor';
  state: LogicalPipelineState;
  lease: SupervisorLease | null;
  resume_checkpoint: Record<string, unknown> | null;
}

const manager = new StateManager({ acquireTimeoutMs: 5_000, staleLockThresholdMs: 30_000 });

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function statePath(sessionDir: string): string {
  return path.join(sessionDir, LOGICAL_PIPELINE_FILE_NAME);
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function reconcileLostExecutorTelemetry(
  sessionDir: string,
  lease: SupervisorLease,
  reason: string,
  nowMs: number,
): void {
  if (fs.existsSync(path.join(sessionDir, 'state.json'))) {
    assertRecordedActiveChildRecovered(sessionDir, new StateManager());
  }
  reconcileValidatedCitadelTelemetry(sessionDir);
  reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason,
    sourceOwnerId: lease.owner_id,
    leaseGeneration: lease.generation,
    now: new Date(nowMs),
  });
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid logical pipeline: ${field} must be a non-empty string.`);
  }
}

function hashEvent(event: Omit<LogicalPipelineEvent, 'event_hash'>): string {
  return sha256(canonicalize(event));
}

function appendEvent(
  state: LogicalPipelineState,
  kind: string,
  details: Record<string, unknown>,
  nowMs: number,
): void {
  if (state.terminal_state !== null) throw new Error('Logical pipeline is already terminal.');
  const previous = state.events.at(-1) ?? null;
  const withoutHash: Omit<LogicalPipelineEvent, 'event_hash'> = {
    sequence: state.events.length + 1,
    event_id: crypto.randomUUID(),
    kind,
    occurred_at: iso(nowMs),
    previous_hash: previous?.event_hash ?? null,
    details,
  };
  state.events.push({ ...withoutHash, event_hash: hashEvent(withoutHash) });
}

function validateLease(value: unknown): SupervisorLease | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid logical pipeline lease.');
  const lease = value as SupervisorLease;
  requireNonEmpty(lease.owner_id, 'lease.owner_id');
  requireNonEmpty(lease.token, 'lease.token');
  requireNonEmpty(lease.acquired_at, 'lease.acquired_at');
  requireNonEmpty(lease.renewed_at, 'lease.renewed_at');
  requireNonEmpty(lease.expires_at, 'lease.expires_at');
  if (!Number.isInteger(lease.generation) || lease.generation < 1) throw new Error('Invalid logical pipeline lease generation.');
  if (!Number.isFinite(Date.parse(lease.expires_at))) throw new Error('Invalid logical pipeline lease expiry.');
  if (lease.owner_identity !== undefined) {
    const identity = lease.owner_identity;
    if (!identity || identity.pid <= 0 || identity.pgid <= 0
      || !identity.start_time || !identity.fingerprint) {
      throw new Error('Invalid logical pipeline lease process identity.');
    }
  }
  return lease;
}

function replayJournal(events: LogicalPipelineEvent[]): Omit<LogicalPipelineState, 'schema_version' | 'events'> {
  let pipelineId = '';
  let controlState: LogicalPipelineControlState = 'prd_development';
  let terminalState: LogicalPipelineTerminalState | null = null;
  let prdSealHash: string | null = null;
  let lease: SupervisorLease | null = null;
  let leaseGeneration = 0;
  let executorRestartCount = 0;

  for (const [index, event] of events.entries()) {
    if (terminalState !== null) throw new Error('Logical pipeline journal continues after a terminal event.');
    switch (event.kind) {
      case 'pipeline_created':
        if (index !== 0) throw new Error('Logical pipeline creation must be the first journal event.');
        requireNonEmpty(event.details.pipeline_id, 'pipeline_created.pipeline_id');
        pipelineId = event.details.pipeline_id;
        break;
      case 'prd_sealed':
        requireNonEmpty(event.details.semantic_hash, 'prd_sealed.semantic_hash');
        controlState = 'autonomous_execution';
        prdSealHash = event.details.semantic_hash;
        break;
      case 'prd_revision_requested':
        controlState = 'prd_revision_required';
        lease = null;
        break;
      case 'lease_acquired':
      case 'lease_recovered':
      case 'lease_renewed': {
        const eventLease = validateLease(event.details.lease);
        if (!eventLease) throw new Error(`${event.kind} must persist its lease.`);
        lease = eventLease;
        leaseGeneration = eventLease.generation;
        break;
      }
      case 'lease_released':
        lease = null;
        break;
      case 'executor_lost':
        executorRestartCount += 1;
        break;
      case 'checkpoint_recorded':
      case 'legacy_session_adopted':
      case 'runtime_handoff_requested':
        break;
      case 'runtime_handoff_aborted':
        lease = null;
        break;
      case 'runtime_handoff_released':
        lease = null;
        break;
      case 'runtime_handoff_completed': {
        const eventLease = validateLease(event.details.lease);
        if (!eventLease) throw new Error('runtime_handoff_completed must persist its lease.');
        lease = eventLease;
        leaseGeneration = eventLease.generation;
        break;
      }
      case 'pipeline_completed':
        terminalState = 'completed';
        lease = null;
        break;
      case 'pipeline_cancelled':
        terminalState = 'cancelled';
        lease = null;
        break;
      default:
        throw new Error(`Unknown logical pipeline journal event: ${event.kind}.`);
    }
  }
  return {
    pipeline_id: pipelineId,
    control_state: controlState,
    terminal_state: terminalState,
    prd_seal_hash: prdSealHash,
    lease,
    lease_generation: leaseGeneration,
    executor_restart_count: executorRestartCount,
  };
}

export function validateLogicalPipelineState(value: unknown): LogicalPipelineState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid logical pipeline state.');
  const state = value as LogicalPipelineState;
  if (state.schema_version !== LOGICAL_PIPELINE_SCHEMA_VERSION) throw new Error('Unsupported logical pipeline schema version.');
  requireNonEmpty(state.pipeline_id, 'pipeline_id');
  if (!(LOGICAL_PIPELINE_CONTROL_STATES as readonly unknown[]).includes(state.control_state)) {
    throw new Error(`Invalid logical pipeline control state: ${String(state.control_state)}.`);
  }
  if (state.terminal_state !== null && !(LOGICAL_PIPELINE_TERMINAL_STATES as readonly unknown[]).includes(state.terminal_state)) {
    throw new Error(`Invalid logical pipeline terminal state: ${String(state.terminal_state)}.`);
  }
  if (state.control_state === 'autonomous_execution') requireNonEmpty(state.prd_seal_hash, 'prd_seal_hash');
  if (!Number.isInteger(state.executor_restart_count) || state.executor_restart_count < 0) {
    throw new Error('Invalid logical pipeline executor restart count.');
  }
  if (!Number.isInteger(state.lease_generation) || state.lease_generation < 0) {
    throw new Error('Invalid logical pipeline lease generation.');
  }
  const lease = validateLease(state.lease);
  if (lease && lease.generation !== state.lease_generation) throw new Error('Logical pipeline lease generation drift.');
  if (state.terminal_state !== null && state.lease !== null) throw new Error('Terminal logical pipeline cannot retain a lease.');
  if (!Array.isArray(state.events) || state.events.length === 0) throw new Error('Invalid logical pipeline journal.');
  let previousHash: string | null = null;
  for (const [index, event] of state.events.entries()) {
    if (event.sequence !== index + 1 || event.previous_hash !== previousHash) throw new Error('Logical pipeline journal chain is broken.');
    requireNonEmpty(event.event_id, `events[${index}].event_id`);
    requireNonEmpty(event.kind, `events[${index}].kind`);
    requireNonEmpty(event.occurred_at, `events[${index}].occurred_at`);
    const { event_hash: eventHash, ...withoutHash } = event;
    if (eventHash !== hashEvent(withoutHash)) throw new Error('Logical pipeline journal event hash mismatch.');
    previousHash = eventHash;
  }
  if (state.terminal_state !== null && state.events.at(-1)?.kind !== `pipeline_${state.terminal_state}`) {
    throw new Error('Logical pipeline terminal state is not journaled.');
  }
  const projection = replayJournal(state.events);
  const persistedProjection = {
    pipeline_id: state.pipeline_id,
    control_state: state.control_state,
    terminal_state: state.terminal_state,
    prd_seal_hash: state.prd_seal_hash,
    lease: state.lease,
    lease_generation: state.lease_generation,
    executor_restart_count: state.executor_restart_count,
  };
  if (canonicalize(projection) !== canonicalize(persistedProjection)) {
    throw new Error('Logical pipeline projection diverges from its authoritative journal.');
  }
  return state;
}

function readAt(filePath: string): LogicalPipelineState {
  return validateLogicalPipelineState(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
}

function mutate(
  sessionDir: string,
  operation: (state: LogicalPipelineState) => void,
): LogicalPipelineState {
  const filePath = statePath(sessionDir);
  manager.acquireLock(filePath);
  try {
    const state = readAt(filePath);
    operation(state);
    validateLogicalPipelineState(state);
    atomicWriteJson(filePath, state);
    return readAt(filePath);
  } finally {
    manager.releaseLock(filePath);
  }
}

export function createLogicalPipeline(sessionDir: string, pipelineId: string, options: ClockOptions = {}): LogicalPipelineState {
  requireNonEmpty(pipelineId, 'pipeline_id');
  ensureDir(sessionDir);
  const filePath = statePath(sessionDir);
  manager.acquireLock(filePath);
  try {
    if (fs.existsSync(filePath)) throw new Error(`Logical pipeline already exists: ${pipelineId}.`);
    const nowMs = options.nowMs ?? Date.now();
    const state: LogicalPipelineState = {
      schema_version: LOGICAL_PIPELINE_SCHEMA_VERSION,
      pipeline_id: pipelineId,
      control_state: 'prd_development',
      terminal_state: null,
      prd_seal_hash: null,
      lease: null,
      lease_generation: 0,
      executor_restart_count: 0,
      events: [],
    };
    appendEvent(state, 'pipeline_created', { pipeline_id: pipelineId, control_state: 'prd_development' }, nowMs);
    atomicWriteJson(filePath, state);
    return readAt(filePath);
  } finally {
    manager.releaseLock(filePath);
  }
}

export function readLogicalPipeline(sessionDir: string): LogicalPipelineState {
  return readAt(statePath(sessionDir));
}

export function beginAutonomousExecution(sessionDir: string, options: ClockOptions = {}): LogicalPipelineState {
  const seal = readPrdSeal(sessionDir);
  return mutate(sessionDir, (state) => {
    if (state.control_state !== 'prd_development') {
      throw new Error(`Cannot seal PRD from ${state.control_state}.`);
    }
    state.control_state = 'autonomous_execution';
    state.prd_seal_hash = seal.semantic_hash;
    appendEvent(state, 'prd_sealed', { semantic_hash: seal.semantic_hash }, options.nowMs ?? Date.now());
  });
}

export function recordLegacySessionAdoption(
  sessionDir: string,
  details: {
    migration_content_hash: string;
    source_runtime: InstalledRuntimeDescriptor;
    target_runtime: InstalledRuntimeDescriptor;
    target_runtime_supersessions?: Array<Record<string, unknown>>;
    resume_checkpoint: Record<string, unknown>;
    legacy_owner: Record<string, unknown>;
  },
  options: ClockOptions = {},
): LogicalPipelineState {
  requireNonEmpty(details.migration_content_hash, 'legacy adoption migration hash');
  validateRuntime(details.source_runtime);
  validateRuntime(details.target_runtime);
  return mutate(sessionDir, (state) => {
    if (state.control_state !== 'autonomous_execution' || state.terminal_state !== null) {
      throw new Error('Legacy adoption requires nonterminal autonomous execution.');
    }
    if (state.lease !== null) throw new Error('Legacy adoption cannot fabricate or replace a source lease.');
    if (state.events.some((event) => event.kind === 'legacy_session_adopted')) {
      throw new Error('Legacy session has already been adopted.');
    }
    appendEvent(state, 'legacy_session_adopted', { ...details }, options.nowMs ?? Date.now());
  });
}

export function recordLegacySessionAdoptionSupersession(
  sessionDir: string,
  details: {
    prior_adoption_record_sha256: string;
    prior_migration_content_hash: string;
    migration_content_hash: string;
    source_runtime: InstalledRuntimeDescriptor;
    target_runtime: InstalledRuntimeDescriptor;
    target_runtime_supersessions: Array<Record<string, unknown>>;
    resume_checkpoint: Record<string, unknown>;
    legacy_owner: Record<string, unknown>;
    validation_session_dir: string;
    validation_approval_sha256: string;
    validation_report_sha256: string;
  },
  options: ClockOptions = {},
): LogicalPipelineState {
  requireNonEmpty(details.prior_adoption_record_sha256, 'prior adoption record hash');
  requireNonEmpty(details.prior_migration_content_hash, 'prior migration hash');
  requireNonEmpty(details.migration_content_hash, 'replacement migration hash');
  validateRuntime(details.source_runtime);
  validateRuntime(details.target_runtime);
  return mutate(sessionDir, (state) => {
    if (state.control_state !== 'autonomous_execution' || state.terminal_state !== null || state.lease !== null) {
      throw new Error('Legacy adoption supersession requires nonterminal unleased autonomous execution.');
    }
    const prior = [...state.events].reverse().find((event) => event.kind === 'legacy_session_adopted');
    if (!prior || prior.details.migration_content_hash !== details.prior_migration_content_hash) {
      throw new Error('Legacy adoption supersession does not extend the latest authenticated adoption epoch.');
    }
    appendEvent(state, 'legacy_session_adopted', { ...details }, options.nowMs ?? Date.now());
  });
}

export function approvePrdRevision(
  sessionDir: string,
  input: CreatePrdSealInput,
  options: ClockOptions = {},
): LogicalPipelineState {
  return mutate(sessionDir, (state) => {
    if (state.control_state !== 'prd_revision_required') {
      throw new Error('A revised PRD can only be approved from prd_revision_required.');
    }
    const seal = replacePrdSealAfterRevision(sessionDir, input);
    state.control_state = 'autonomous_execution';
    state.prd_seal_hash = seal.semantic_hash;
    appendEvent(state, 'prd_sealed', { semantic_hash: seal.semantic_hash }, options.nowMs ?? Date.now());
  });
}

export function requestPrdRevision(
  sessionDir: string,
  evidence: string,
  proposedPatch: string,
  options: ClockOptions = {},
): LogicalPipelineState {
  requireNonEmpty(evidence, 'revision evidence');
  requireNonEmpty(proposedPatch, 'proposed PRD patch');
  return mutate(sessionDir, (state) => {
    if (state.control_state !== 'autonomous_execution') throw new Error('PRD revision can only be requested during autonomous execution.');
    state.control_state = 'prd_revision_required';
    state.lease = null;
    appendEvent(state, 'prd_revision_requested', { evidence, proposed_patch: proposedPatch }, options.nowMs ?? Date.now());
  });
}

function createLease(
  ownerId: string,
  ttlMs: number,
  generation: number,
  nowMs: number,
  ownerIdentity?: PersistedProcessIdentity,
): SupervisorLease {
  requireNonEmpty(ownerId, 'lease owner');
  validateLeaseTtl(ttlMs);
  return {
    owner_id: ownerId,
    token: crypto.randomUUID(),
    generation,
    acquired_at: iso(nowMs),
    renewed_at: iso(nowMs),
    expires_at: iso(nowMs + ttlMs),
    ...(ownerIdentity ? { owner_identity: ownerIdentity } : {}),
  };
}

function pendingRuntimeHandoff(state: LogicalPipelineState): LogicalPipelineEvent | null {
  const completed = new Set(state.events
    .filter((event) => event.kind === 'runtime_handoff_completed' || event.kind === 'runtime_handoff_aborted')
    .map((event) => String(event.details.request_id)));
  return [...state.events].reverse().find((event) => event.kind === 'runtime_handoff_requested'
    && !completed.has(String(event.details.request_id))) ?? null;
}

export function hasPendingRuntimeHandoff(sessionDir: string): boolean {
  return pendingRuntimeHandoff(readLogicalPipeline(sessionDir)) !== null;
}

function validateLeaseTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Lease TTL must be positive.');
}

export function acquireSupervisorLease(sessionDir: string, options: AcquireLeaseOptions): SupervisorLease {
  let acquired: SupervisorLease | null = null;
  mutate(sessionDir, (state) => {
    if (state.control_state !== 'autonomous_execution') throw new Error('Supervisor lease requires autonomous execution.');
    if (pendingRuntimeHandoff(state)) {
      throw new Error('Supervisor lease acquisition is reserved for the pending runtime handoff target.');
    }
    const nowMs = options.nowMs ?? Date.now();
    if (state.lease && Date.parse(state.lease.expires_at) > nowMs) {
      throw new Error(`Supervisor lease is held by ${state.lease.owner_id}.`);
    }
    const expiredLease = state.lease;
    if (expiredLease) {
      reconcileLostExecutorTelemetry(sessionDir, expiredLease, 'expired_lease', nowMs);
      appendEvent(state, 'executor_lost', { owner_id: expiredLease.owner_id, reason: 'expired_lease' }, nowMs);
      state.executor_restart_count += 1;
    }
    const generation = state.lease_generation + 1;
    acquired = createLease(options.ownerId, options.ttlMs, generation, nowMs, options.ownerIdentity);
    state.lease = acquired;
    state.lease_generation = generation;
    appendEvent(state, generation === 1 ? 'lease_acquired' : 'lease_recovered', {
      owner_id: options.ownerId,
      generation,
      reason: generation === 1 ? 'initial' : 'expired_lease',
      lease: acquired,
    }, nowMs);
  });
  if (!acquired) throw new Error('Supervisor lease acquisition failed.');
  return acquired;
}

export function renewSupervisorLease(sessionDir: string, options: RenewLeaseOptions): SupervisorLease {
  let renewed: SupervisorLease | null = null;
  mutate(sessionDir, (state) => {
    validateLeaseTtl(options.ttlMs);
    const nowMs = options.nowMs ?? Date.now();
    const current = state.lease;
    if (!current || current.owner_id !== options.ownerId || current.token !== options.token) {
      throw new Error('Supervisor lease ownership changed.');
    }
    if (Date.parse(current.expires_at) <= nowMs) throw new Error('Supervisor lease expired before renewal.');
    renewed = { ...current, renewed_at: iso(nowMs), expires_at: iso(nowMs + options.ttlMs) };
    state.lease = renewed;
    appendEvent(state, 'lease_renewed', {
      owner_id: current.owner_id,
      generation: current.generation,
      lease: renewed,
    }, nowMs);
  });
  if (!renewed) throw new Error('Supervisor lease renewal failed.');
  return renewed;
}

function assertLeaseFence(
  state: LogicalPipelineState,
  ownerId: string,
  token: string,
  nowMs: number,
): SupervisorLease {
  const lease = state.lease;
  if (!lease || lease.owner_id !== ownerId || lease.token !== token) {
    throw new Error('Supervisor lease fence rejected stale ownership.');
  }
  if (Date.parse(lease.expires_at) <= nowMs) throw new Error('Expired supervisor lease fence.');
  return lease;
}

export function assertSupervisorLeaseFence(
  sessionDir: string,
  ownerId: string,
  token: string,
  options: ClockOptions = {},
): SupervisorLease {
  const state = readLogicalPipeline(sessionDir);
  return assertLeaseFence(state, ownerId, token, options.nowMs ?? Date.now());
}

export function recordSupervisorCheckpoint(
  sessionDir: string,
  ownerId: string,
  token: string,
  checkpoint: Record<string, unknown>,
  options: ClockOptions = {},
): LogicalPipelineState {
  return mutate(sessionDir, (state) => {
    const nowMs = options.nowMs ?? Date.now();
    let lease: SupervisorLease;
    try {
      lease = assertLeaseFence(state, ownerId, token, nowMs);
    } catch (error) {
      throw new Error(`Only the active supervisor lease may checkpoint: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const receiptId = typeof checkpoint.receipt_id === 'string' ? checkpoint.receipt_id : '';
    const matchingReceipts = receiptId ? state.events.filter((event) => (
      event.kind === 'checkpoint_recorded'
      && (event.details.checkpoint as Record<string, unknown> | undefined)?.receipt_id === receiptId
    )) : [];
    if (matchingReceipts.length > 0) {
      const withoutLeaseGeneration = (value: Record<string, unknown>): Record<string, unknown> => {
        const payload = { ...value };
        delete payload.lease_generation;
        return payload;
      };
      const incoming = canonicalize(withoutLeaseGeneration(checkpoint));
      const exact = matchingReceipts.every((event) => {
        const durable = event.details.checkpoint as Record<string, unknown>;
        return canonicalize(withoutLeaseGeneration(durable)) === incoming;
      });
      if (!exact) throw new SupervisorCheckpointIntegrityError(receiptId);
      return;
    }
    appendEvent(state, 'checkpoint_recorded', {
      checkpoint: { ...checkpoint, lease_generation: lease.generation },
    }, nowMs);
  });
}

function validateRuntime(runtime: InstalledRuntimeDescriptor): void {
  requireNonEmpty(runtime.runtime_id, 'runtime.runtime_id');
  requireNonEmpty(runtime.version, 'runtime.version');
  requireNonEmpty(runtime.build_hash, 'runtime.build_hash');
  if (!Number.isInteger(runtime.min_state_schema) || !Number.isInteger(runtime.max_state_schema)
    || runtime.min_state_schema < 1 || runtime.max_state_schema < runtime.min_state_schema) {
    throw new Error('Invalid installed runtime state-schema compatibility range.');
  }
}

function handoffRequest(state: LogicalPipelineState, requestId: string): LogicalPipelineEvent {
  const request = [...state.events].reverse().find((event) => (
    event.kind === 'runtime_handoff_requested' && event.details.request_id === requestId
  ));
  if (!request) throw new Error(`Unknown runtime handoff request: ${requestId}.`);
  if (state.events.some((event) => event.kind === 'runtime_handoff_completed' && event.details.request_id === requestId)) {
    throw new Error(`Runtime handoff request already completed: ${requestId}.`);
  }
  if (state.events.some((event) => event.kind === 'runtime_handoff_aborted' && event.details.request_id === requestId)) {
    throw new Error(`Runtime handoff request was aborted: ${requestId}.`);
  }
  return request;
}

export function abortExpiredRuntimeHandoff(
  sessionDir: string,
  timeoutMs = 60_000,
  options: ClockOptions = {},
): boolean {
  let aborted = false;
  mutate(sessionDir, (state) => {
    const request = pendingRuntimeHandoff(state);
    if (!request) return;
    const nowMs = options.nowMs ?? Date.now();
    if (nowMs - Date.parse(request.occurred_at) < timeoutMs) return;
    if (state.lease) {
      const expired = Date.parse(state.lease.expires_at) <= nowMs;
      const identityDead = state.lease.owner_identity
        ? inspectProcessLivenessIdentity(state.lease.owner_identity) !== 'matched'
        : false;
      if (!expired && !identityDead) return;
      reconcileLostExecutorTelemetry(
        sessionDir,
        state.lease,
        expired ? 'expired_lease_during_handoff' : 'dead_source_during_handoff',
        nowMs,
      );
      appendEvent(state, 'executor_lost', {
        owner_id: state.lease.owner_id,
        reason: expired ? 'expired_lease_during_handoff' : 'dead_source_during_handoff',
      }, nowMs);
      state.executor_restart_count += 1;
      state.lease = null;
    }
    appendEvent(state, 'runtime_handoff_aborted', {
      request_id: request.details.request_id,
      reason: 'target_accept_timeout',
    }, nowMs);
    aborted = true;
  });
  return aborted;
}

export function requestRuntimeHandoff(
  sessionDir: string,
  ownerId: string,
  token: string,
  sourceRuntime: InstalledRuntimeDescriptor,
  targetRuntime: InstalledRuntimeDescriptor,
  checkpoint: Record<string, unknown>,
  options: ClockOptions = {},
): string {
  validateRuntime(sourceRuntime);
  validateRuntime(targetRuntime);
  const requestId = crypto.randomUUID();
  mutate(sessionDir, (state) => {
    const nowMs = options.nowMs ?? Date.now();
    const lease = assertLeaseFence(state, ownerId, token, nowMs);
    if (pendingRuntimeHandoff(state)) {
      throw new Error('A runtime handoff request is already pending.');
    }
    appendEvent(state, 'runtime_handoff_requested', {
      request_id: requestId,
      source_runtime: sourceRuntime,
      target_runtime: targetRuntime,
      checkpoint,
      lease_generation: lease.generation,
    }, nowMs);
  });
  return requestId;
}

export function releaseRuntimeHandoffLease(
  sessionDir: string,
  ownerId: string,
  token: string,
  requestId: string,
  options: ClockOptions = {},
): LogicalPipelineState {
  return mutate(sessionDir, (state) => {
    const nowMs = options.nowMs ?? Date.now();
    const lease = assertLeaseFence(state, ownerId, token, nowMs);
    const request = handoffRequest(state, requestId);
    appendEvent(state, 'runtime_handoff_released', {
      request_id: requestId,
      owner_id: ownerId,
      lease_generation: lease.generation,
      ...(lease.owner_identity ? {
        source_exit_intent: {
          request_id: requestId,
          owner_id: ownerId,
          owner_identity: lease.owner_identity,
          source_runtime: request.details.source_runtime,
        },
      } : {}),
    }, nowMs);
    state.lease = null;
  });
}

export function acceptRuntimeHandoff(
  sessionDir: string,
  requestId: string,
  ownerId: string,
  ttlMs: number,
  targetRuntime: InstalledRuntimeDescriptor,
  options: ClockOptions & { ownerIdentity?: PersistedProcessIdentity } = {},
): RuntimeHandoffResult {
  validateRuntime(targetRuntime);
  let lease: SupervisorLease | null = null;
  let checkpoint: Record<string, unknown> | null = null;
  const state = mutate(sessionDir, (current) => {
    const nowMs = options.nowMs ?? Date.now();
    const request = handoffRequest(current, requestId);
    if (canonicalize(request.details.target_runtime) !== canonicalize(targetRuntime)) {
      throw new Error('Target runtime does not match the durable handoff request.');
    }
    if (current.lease && Date.parse(current.lease.expires_at) > nowMs) {
      throw new Error(`Runtime handoff is fenced by live owner ${current.lease.owner_id}.`);
    }
    if (current.lease) {
      reconcileLostExecutorTelemetry(sessionDir, current.lease, 'expired_lease', nowMs);
      appendEvent(current, 'executor_lost', { owner_id: current.lease.owner_id, reason: 'expired_lease' }, nowMs);
      current.executor_restart_count += 1;
    }
    checkpoint = request.details.checkpoint as Record<string, unknown>;
    const generation = current.lease_generation + 1;
    lease = createLease(ownerId, ttlMs, generation, nowMs, options.ownerIdentity);
    current.lease = lease;
    current.lease_generation = generation;
    appendEvent(current, 'runtime_handoff_completed', {
      request_id: requestId,
      target_runtime: targetRuntime,
      resume_checkpoint: checkpoint,
      lease,
    }, nowMs);
  });
  if (!lease || !checkpoint) throw new Error('Runtime handoff did not produce a lease and checkpoint.');
  return { request_id: requestId, lease, resume_checkpoint: checkpoint, state };
}

function latestCheckpoint(state: LogicalPipelineState): Record<string, unknown> | null {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const value = state.events[index].details.checkpoint;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

export function watchdogRecoverSupervisor(
  sessionDir: string,
  options: WatchdogRecoveryOptions,
): WatchdogRecoveryResult {
  let reason: WatchdogRecoveryResult['reason'] = 'healthy';
  let resumeCheckpoint: Record<string, unknown> | null = null;
  const state = mutate(sessionDir, (current) => {
    if (current.control_state !== 'autonomous_execution') throw new Error('Watchdog recovery requires autonomous execution.');
    if (pendingRuntimeHandoff(current)) {
      throw new Error('Watchdog recovery is reserved for the pending runtime handoff target.');
    }
    const nowMs = options.nowMs ?? Date.now();
    const previous = current.lease;
    const expired = previous ? Date.parse(previous.expires_at) <= nowMs : false;
    const dead = previous && options.executorAlive
      ? !options.executorAlive(previous.owner_id, previous.owner_identity)
      : false;
    if (previous && !expired && !dead) return;
    reason = previous ? (expired ? 'expired_lease' : 'dead_executor') : 'missing_lease';
    resumeCheckpoint = latestCheckpoint(current);
    if (previous) {
      reconcileLostExecutorTelemetry(sessionDir, previous, reason, nowMs);
      appendEvent(current, 'executor_lost', { owner_id: previous.owner_id, reason }, nowMs);
      current.executor_restart_count += 1;
    }
    const generation = current.lease_generation + 1;
    current.lease = createLease(options.ownerId, options.ttlMs, generation, nowMs, options.ownerIdentity);
    current.lease_generation = generation;
    appendEvent(current, 'lease_recovered', {
      owner_id: options.ownerId,
      generation,
      reason,
      resume_checkpoint: resumeCheckpoint,
      lease: current.lease,
    }, nowMs);
  });
  return {
    recovered: reason !== 'healthy',
    reason,
    state,
    lease: state.lease,
    resume_checkpoint: resumeCheckpoint,
  };
}

export function releaseSupervisorLease(
  sessionDir: string,
  ownerId: string,
  token: string,
  options: ClockOptions = {},
): LogicalPipelineState {
  return mutate(sessionDir, (state) => {
    if (!state.lease || state.lease.owner_id !== ownerId || state.lease.token !== token) {
      throw new Error('Supervisor lease ownership changed before release.');
    }
    state.lease = null;
    appendEvent(state, 'lease_released', { owner_id: ownerId }, options.nowMs ?? Date.now());
  });
}

export function terminateLogicalPipeline(
  sessionDir: string,
  terminalState: string,
  options: TerminalOptions = {},
): LogicalPipelineState {
  if (!(LOGICAL_PIPELINE_TERMINAL_STATES as readonly string[]).includes(terminalState)) {
    throw new Error(`Unexpected terminal state ${terminalState}; autonomy, reliability, and quality scores are zero.`);
  }
  return mutate(sessionDir, (state) => {
    if (!state.lease) {
      throw new Error('Logical pipeline termination requires an active supervisor lease.');
    }
    if (state.lease.owner_id !== options.ownerId || state.lease.token !== options.token) {
      throw new Error('Only the active supervisor lease may terminate the logical pipeline.');
    }
    if (terminalState === 'completed') assertCitadelReleaseApproval(sessionDir);
    appendEvent(state, `pipeline_${terminalState}`, { terminal_state: terminalState }, options.nowMs ?? Date.now());
    state.terminal_state = terminalState as LogicalPipelineTerminalState;
    state.lease = null;
  });
}

export function cancelLogicalPipelineByOperator(
  sessionDir: string,
  reason: string,
  options: ClockOptions = {},
): LogicalPipelineState {
  requireNonEmpty(reason, 'operator cancellation reason');
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const migrationFencePath = path.join(resolvedSessionDir, '.legacy-max-time-migration-fence');
  manager.acquireLock(migrationFencePath);
  try {
    return mutate(resolvedSessionDir, (state) => {
    // The legacy session cancellation marker is persisted before the durable
    // journal is sealed. A live executor can observe that marker and win the
    // race by sealing the same cancelled terminal state under its lease. Treat
    // that exact terminal result as an idempotent success; every other terminal
    // state remains immutable and must fail closed.
    if (state.terminal_state === 'cancelled') return;
    if (state.terminal_state !== null) {
      throw new Error(`Logical pipeline is already terminal: ${state.terminal_state}.`);
    }
    appendEvent(state, 'pipeline_cancelled', {
      terminal_state: 'cancelled',
      operator_initiated: true,
      reason,
      previous_owner_id: state.lease?.owner_id ?? null,
    }, options.nowMs ?? Date.now());
    state.terminal_state = 'cancelled';
    state.lease = null;
    });
  } finally {
    manager.releaseLock(migrationFencePath);
  }
}
