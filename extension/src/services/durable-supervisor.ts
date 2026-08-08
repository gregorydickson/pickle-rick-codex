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

interface AcquireLeaseOptions extends ClockOptions {
  ownerId: string;
  ttlMs: number;
}

interface RenewLeaseOptions extends AcquireLeaseOptions {
  token: string;
}

export interface WatchdogRecoveryOptions extends AcquireLeaseOptions {
  executorAlive?: (ownerId: string) => boolean;
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
      case 'executor_lost':
        executorRestartCount += 1;
        break;
      case 'checkpoint_recorded':
        break;
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

function createLease(ownerId: string, ttlMs: number, generation: number, nowMs: number): SupervisorLease {
  requireNonEmpty(ownerId, 'lease owner');
  validateLeaseTtl(ttlMs);
  return {
    owner_id: ownerId,
    token: crypto.randomUUID(),
    generation,
    acquired_at: iso(nowMs),
    renewed_at: iso(nowMs),
    expires_at: iso(nowMs + ttlMs),
  };
}

function validateLeaseTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Lease TTL must be positive.');
}

export function acquireSupervisorLease(sessionDir: string, options: AcquireLeaseOptions): SupervisorLease {
  let acquired: SupervisorLease | null = null;
  mutate(sessionDir, (state) => {
    if (state.control_state !== 'autonomous_execution') throw new Error('Supervisor lease requires autonomous execution.');
    const nowMs = options.nowMs ?? Date.now();
    if (state.lease && Date.parse(state.lease.expires_at) > nowMs) {
      throw new Error(`Supervisor lease is held by ${state.lease.owner_id}.`);
    }
    const expiredOwner = state.lease?.owner_id ?? null;
    if (expiredOwner) {
      appendEvent(state, 'executor_lost', { owner_id: expiredOwner, reason: 'expired_lease' }, nowMs);
      state.executor_restart_count += 1;
    }
    const generation = state.lease_generation + 1;
    acquired = createLease(options.ownerId, options.ttlMs, generation, nowMs);
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

export function recordSupervisorCheckpoint(
  sessionDir: string,
  ownerId: string,
  token: string,
  checkpoint: Record<string, unknown>,
  options: ClockOptions = {},
): LogicalPipelineState {
  return mutate(sessionDir, (state) => {
    const nowMs = options.nowMs ?? Date.now();
    if (!state.lease || state.lease.owner_id !== ownerId || state.lease.token !== token) {
      throw new Error('Only the active supervisor lease may checkpoint.');
    }
    if (Date.parse(state.lease.expires_at) <= nowMs) {
      throw new Error('Expired supervisor lease cannot checkpoint.');
    }
    appendEvent(state, 'checkpoint_recorded', { checkpoint }, nowMs);
  });
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
    const nowMs = options.nowMs ?? Date.now();
    const previous = current.lease;
    const expired = previous ? Date.parse(previous.expires_at) <= nowMs : false;
    const dead = previous && options.executorAlive ? !options.executorAlive(previous.owner_id) : false;
    if (previous && !expired && !dead) return;
    reason = previous ? (expired ? 'expired_lease' : 'dead_executor') : 'missing_lease';
    resumeCheckpoint = latestCheckpoint(current);
    if (previous) {
      appendEvent(current, 'executor_lost', { owner_id: previous.owner_id, reason }, nowMs);
      current.executor_restart_count += 1;
    }
    const generation = current.lease_generation + 1;
    current.lease = createLease(options.ownerId, options.ttlMs, generation, nowMs);
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

export function terminateLogicalPipeline(
  sessionDir: string,
  terminalState: string,
  options: ClockOptions = {},
): LogicalPipelineState {
  if (!(LOGICAL_PIPELINE_TERMINAL_STATES as readonly string[]).includes(terminalState)) {
    throw new Error(`Unexpected terminal state ${terminalState}; autonomy, reliability, and quality scores are zero.`);
  }
  return mutate(sessionDir, (state) => {
    appendEvent(state, `pipeline_${terminalState}`, { terminal_state: terminalState }, options.nowMs ?? Date.now());
    state.terminal_state = terminalState as LogicalPipelineTerminalState;
    state.lease = null;
  });
}
