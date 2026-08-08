import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import type { Ticket } from '../types/index.js';
import type { CodexSpawnResult } from '../types/index.js';
import type { WorkerLifecyclePhase } from './worker-lifecycle.js';

export type FailureDomain =
  | 'contract'
  | 'verification'
  | 'review'
  | 'conformance'
  | 'quality'
  | 'infrastructure';

export const AUTONOMOUS_FAILURE_TYPES = [
  'contract_invalid',
  'infrastructure_transient',
  'worker_transport',
  'artifact_invalid',
  'implementation_invalid',
  'verification_failed',
  'review_refused',
  'conformance_refused',
  'quality_failed',
  'completion_evidence_refused',
  'workspace_unsafe',
  'prd_contract_defect',
] as const;

export type AutonomousFailureType = (typeof AUTONOMOUS_FAILURE_TYPES)[number];

export type RecoveryHandler =
  | 'repair_contract'
  | 'repair_verification'
  | 'remediate_candidate'
  | 'repair_conformance_evidence'
  | 'repair_quality_regression'
  | 'repair_artifact'
  | 'repair_implementation'
  | 'repair_completion_evidence'
  | 'restart_executor'
  | 'reconstruct_workspace'
  | 'request_prd_revision';

export interface FailureRoute {
  failureType?: AutonomousFailureType;
  domain: FailureDomain;
  handler: RecoveryHandler;
  invalidate: string[];
  preserve: string[];
  schedulerState: 'repairing' | 'prd_revision_required';
}

export interface RecoveryStrategyInput {
  ticketId: string;
  domain: FailureDomain;
  handler: RecoveryHandler;
  checkpoint: string;
  inputHashes?: string[];
  constraints?: string[];
  materialApproach: string;
}

export interface RecoveryStrategyEpoch extends RecoveryStrategyInput {
  sequence: number;
  strategyHash: string;
  startedAt: string;
  trigger: 'failure' | 'retry_threshold' | 'time_threshold' | 'circuit_threshold';
}

interface RecoveryStrategyJournal {
  schema_version: 1;
  epochs: RecoveryStrategyEpoch[];
}

export interface ExecutionTelemetryEvent {
  sequence: number;
  ticket_id: string;
  phase: string;
  ticket_attempt: number;
  phase_attempt: number;
  recovery_epoch: number;
  strategy_hash: string | null;
  outcome: 'success' | 'failed' | 'cancelled' | 'timed_out';
  duration_ms: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
  productive_work: number;
  discarded_work: number;
  recorded_at: string;
}

interface ExecutionTelemetryJournal {
  schema_version: 1;
  events: ExecutionTelemetryEvent[];
  controls?: ExecutionControlTelemetry;
  unexpected_noncompletion_termination?: {
    schema_version: 1;
    reason: string;
    recorded_at: string;
  };
}

export interface ExecutionControlTelemetry {
  executor_restarts: number;
  checkpoints_reused: number;
  checkpoints_invalidated: number;
  post_seal_human_interventions: number;
  unexpected_terminal_exits: number;
}

export interface ExecutionTelemetrySummary {
  ticketAttempts: number;
  phaseAttempts: number;
  recoveryEpochs: number;
  failedCalls: number;
  successfulCalls: number;
  timedOutCalls: number;
  cancelledCalls: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  productiveWork: number;
  discardedWork: number;
  executorRestarts: number;
  checkpointsReused: number;
  checkpointsInvalidated: number;
  postSealHumanInterventions: number;
  unexpectedTerminalExits: number;
  autonomyScore: 0 | 1;
  reliabilityScore: 0 | 1;
  qualityScore: 0 | 1;
  unexpectedNoncompletionTermination: boolean;
}

const STRATEGY_FILE = 'recovery-strategies.json';
const TELEMETRY_FILE = 'execution-telemetry.json';

const DOMAIN_POLICIES: Record<FailureDomain, Omit<FailureRoute, 'domain'>> = {
  contract: {
    handler: 'repair_contract',
    invalidate: ['prepare', 'implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: [],
    schedulerState: 'repairing',
  },
  verification: {
    handler: 'repair_verification',
    invalidate: ['verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'candidate'],
    schedulerState: 'repairing',
  },
  review: {
    handler: 'remediate_candidate',
    invalidate: ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'rejected_candidate', 'review_evidence'],
    schedulerState: 'repairing',
  },
  conformance: {
    handler: 'repair_conformance_evidence',
    invalidate: ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'rejected_candidate', 'conformance_evidence'],
    schedulerState: 'repairing',
  },
  quality: {
    handler: 'repair_quality_regression',
    invalidate: ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'rejected_candidate', 'quality_evidence'],
    schedulerState: 'repairing',
  },
  infrastructure: {
    handler: 'restart_executor',
    invalidate: [],
    preserve: ['prepare', 'context', 'candidate', 'verification_evidence', 'review_evidence'],
    schedulerState: 'repairing',
  },
};

const TYPE_POLICIES: Record<AutonomousFailureType, FailureRoute> = {
  contract_invalid: { failureType: 'contract_invalid', ...DOMAIN_POLICIES.contract, domain: 'contract' },
  infrastructure_transient: { failureType: 'infrastructure_transient', ...DOMAIN_POLICIES.infrastructure, domain: 'infrastructure' },
  worker_transport: { failureType: 'worker_transport', ...DOMAIN_POLICIES.infrastructure, domain: 'infrastructure' },
  artifact_invalid: {
    failureType: 'artifact_invalid', domain: 'infrastructure', handler: 'repair_artifact',
    invalidate: ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'invalid_artifact_evidence'], schedulerState: 'repairing',
  },
  implementation_invalid: {
    failureType: 'implementation_invalid', domain: 'review', handler: 'repair_implementation',
    invalidate: ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['context', 'rejected_candidate', 'implementation_evidence'], schedulerState: 'repairing',
  },
  verification_failed: { failureType: 'verification_failed', ...DOMAIN_POLICIES.verification, domain: 'verification' },
  review_refused: { failureType: 'review_refused', ...DOMAIN_POLICIES.review, domain: 'review' },
  conformance_refused: { failureType: 'conformance_refused', ...DOMAIN_POLICIES.conformance, domain: 'conformance' },
  quality_failed: { failureType: 'quality_failed', ...DOMAIN_POLICIES.quality, domain: 'quality' },
  completion_evidence_refused: {
    failureType: 'completion_evidence_refused', domain: 'conformance', handler: 'repair_completion_evidence',
    invalidate: ['conformance', 'quality', 'promote'], preserve: ['context', 'candidate', 'verification_evidence', 'review_evidence'],
    schedulerState: 'repairing',
  },
  workspace_unsafe: {
    failureType: 'workspace_unsafe', domain: 'infrastructure', handler: 'reconstruct_workspace',
    invalidate: ['prepare', 'implement', 'verify', 'review', 'conformance', 'quality', 'promote'],
    preserve: ['prd_seal', 'context', 'salvage_evidence'], schedulerState: 'repairing',
  },
  prd_contract_defect: {
    failureType: 'prd_contract_defect', domain: 'contract', handler: 'request_prd_revision',
    invalidate: [], preserve: ['all_verified_checkpoints', 'proposed_prd_patch'], schedulerState: 'prd_revision_required',
  },
};

function readJournal<T>(filePath: string, empty: T): T {
  if (!fs.existsSync(filePath)) return empty;
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  return value;
}

function strategyPath(sessionDir: string): string {
  return path.join(sessionDir, STRATEGY_FILE);
}

function telemetryPath(sessionDir: string): string {
  return path.join(sessionDir, TELEMETRY_FILE);
}

export function classifyFailure(input: {
  kind?: string | null;
  phase?: WorkerLifecyclePhase | string | null;
  message?: string;
}): FailureDomain {
  return typedRecoveryRoute(classifyAutonomousFailure(input)).domain;
}

export function classifyAutonomousFailure(input: {
  kind?: string | null;
  phase?: WorkerLifecyclePhase | string | null;
  message?: string;
}): AutonomousFailureType {
  const kind = String(input.kind || '').toLowerCase();
  const phase = String(input.phase || '').toLowerCase();
  const message = String(input.message || '').toLowerCase();
  if (kind.includes('prd_contract_defect') || message.includes('contradictory prd')) return 'prd_contract_defect';
  if (kind.includes('workspace_unsafe') || message.includes('unsafe workspace')) return 'workspace_unsafe';
  if (kind.includes('completion_evidence') || kind.includes('oracle_refusal')
    || message.includes('completion evidence') || message.includes('oracle refusal')) return 'completion_evidence_refused';
  if (kind.includes('contract') || kind.includes('preflight') || message.includes('verification contract') || message.includes('preflight')) return 'contract_invalid';
  if (phase === 'review' || kind.includes('review') || message.includes('review requested changes')) return 'review_refused';
  if (phase === 'conformance' || kind.includes('conformance')) return 'conformance_refused';
  if (kind.includes('quality') || message.includes('quality-gate') || message.includes('quality gate')) return 'quality_failed';
  if (kind.includes('test') || kind.includes('verification_failed') || message.includes('verification command failed') || message.includes('verification-command-failed')) return 'verification_failed';
  if (kind.includes('artifact')) return 'artifact_invalid';
  if (kind.includes('implementation')) return 'implementation_invalid';
  if (kind.includes('transport') || message.includes('worker transport')) return 'worker_transport';
  return 'infrastructure_transient';
}

export function recoveryRoute(domain: FailureDomain): FailureRoute {
  return { domain, ...DOMAIN_POLICIES[domain] };
}

export function typedRecoveryRoute(failureType: AutonomousFailureType): FailureRoute {
  return structuredClone(TYPE_POLICIES[failureType]);
}

/** Production dispatch seam: callers classify once and retain the exact typed
 * handler instead of collapsing distinct failures back to a domain default. */
export function resolveAutonomousRecovery(input: {
  kind?: string | null;
  phase?: WorkerLifecyclePhase | string | null;
  message?: string;
}): FailureRoute {
  return typedRecoveryRoute(classifyAutonomousFailure(input));
}

export type RecoveryExecutionAction = RecoveryHandler;

export function recoveryExecutionAction(route: FailureRoute): RecoveryExecutionAction {
  return route.schedulerState === 'prd_revision_required' ? 'request_prd_revision' : route.handler;
}

export function materialStrategyHash(input: RecoveryStrategyInput): string {
  const canonical = {
    ticket_id: input.ticketId,
    domain: input.domain,
    handler: input.handler,
    checkpoint: input.checkpoint,
    input_hashes: [...(input.inputHashes || [])].sort(),
    constraints: [...(input.constraints || [])].sort(),
    material_approach: input.materialApproach.trim(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function beginRecoveryStrategyEpoch(
  sessionDir: string,
  input: RecoveryStrategyInput,
  trigger: RecoveryStrategyEpoch['trigger'],
): RecoveryStrategyEpoch {
  const filePath = strategyPath(sessionDir);
  const journal = readJournal<RecoveryStrategyJournal>(filePath, { schema_version: 1, epochs: [] });
  if (journal.schema_version !== 1 || !Array.isArray(journal.epochs)) throw new Error('recovery-strategy-corrupt');
  const strategyHash = materialStrategyHash(input);
  const previous = [...journal.epochs].reverse().find((epoch) => epoch.ticketId === input.ticketId);
  if (previous?.strategyHash === strategyHash) {
    throw new Error(`recovery-strategy-not-novel: ticket ${input.ticketId} repeated ${strategyHash}`);
  }
  const epoch: RecoveryStrategyEpoch = {
    ...input,
    sequence: journal.epochs.length + 1,
    strategyHash,
    startedAt: new Date().toISOString(),
    trigger,
  };
  atomicWriteJson(filePath, { schema_version: 1, epochs: [...journal.epochs, epoch] });
  return epoch;
}

export function readRecoveryStrategyEpochs(sessionDir: string): RecoveryStrategyEpoch[] {
  return readJournal<RecoveryStrategyJournal>(strategyPath(sessionDir), { schema_version: 1, epochs: [] }).epochs;
}

export function nextMaterialApproach(domain: FailureDomain, priorEpochs: number): string {
  const approaches: Record<FailureDomain, string[]> = {
    contract: ['recompile-structured-contract', 'repair-manifest-from-validator', 're-refine-contract-slice'],
    verification: ['isolate-failing-obligation', 'repair-candidate-from-diagnostic', 'rebuild-verification-fixture'],
    review: ['apply-review-findings-to-candidate', 'reduce-diff-and-reverify', 'reconstruct-candidate-from-approved-context'],
    conformance: ['bind-criteria-to-runner-evidence', 'repair-missing-obligation', 'rebuild-conformance-receipts'],
    quality: ['isolate-quality-delta', 'repair-new-regression', 'reconstruct-clean-quality-baseline'],
    infrastructure: ['restart-executor', 'reconstruct-workspace', 'revalidate-checkpoint-and-relaunch'],
  };
  return approaches[domain][priorEpochs % approaches[domain].length];
}

export function recordExecutionTelemetry(
  sessionDir: string,
  input: Omit<ExecutionTelemetryEvent, 'sequence' | 'recorded_at'>,
): ExecutionTelemetryEvent {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let event: ExecutionTelemetryEvent | null = null;
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
    event = { ...input, sequence: journal.events.length + 1, recorded_at: new Date().toISOString() };
    journal.events.push(event);
    return journal as unknown as Record<string, unknown>;
  }, { createDefault: () => ({ schema_version: 1, events: [] }) });
  if (!event) throw new Error('execution-telemetry-write-failed');
  return event;
}

export function recordModelCallTelemetry(
  sessionDir: string,
  input: {
    ticketId: string;
    phase: string;
    ticketAttempt: number;
    phaseAttempt: number;
    recoveryEpoch?: number;
    strategyHash?: string | null;
    result: CodexSpawnResult;
    outcome?: ExecutionTelemetryEvent['outcome'];
    productiveWork?: number;
    discardedWork?: number;
  },
): ExecutionTelemetryEvent {
  const outcome = input.outcome ?? (input.result.cancelled
    ? 'cancelled'
    : input.result.timedOut
      ? 'timed_out'
      : input.result.exitCode === 0 ? 'success' : 'failed');
  return recordExecutionTelemetry(sessionDir, {
    ticket_id: input.ticketId,
    phase: input.phase,
    ticket_attempt: input.ticketAttempt,
    phase_attempt: input.phaseAttempt,
    recovery_epoch: input.recoveryEpoch ?? 0,
    strategy_hash: input.strategyHash ?? null,
    outcome,
    duration_ms: input.result.durationMs,
    input_tokens: input.result.usage.input_tokens,
    cached_input_tokens: input.result.usage.cache_read_input_tokens,
    cache_creation_input_tokens: input.result.usage.cache_creation_input_tokens,
    output_tokens: input.result.usage.output_tokens,
    productive_work: input.productiveWork ?? (outcome === 'success' ? 1 : 0),
    discarded_work: input.discardedWork ?? (outcome === 'success' ? 0 : 1),
  });
}

const EMPTY_CONTROLS: ExecutionControlTelemetry = {
  executor_restarts: 0,
  checkpoints_reused: 0,
  checkpoints_invalidated: 0,
  post_seal_human_interventions: 0,
  unexpected_terminal_exits: 0,
};

export function recordExecutionControlTelemetry(
  sessionDir: string,
  delta: Partial<ExecutionControlTelemetry>,
): ExecutionControlTelemetry {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let controls = { ...EMPTY_CONTROLS };
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
    const prior = { ...EMPTY_CONTROLS, ...(journal.controls || {}) };
    controls = Object.fromEntries(Object.keys(EMPTY_CONTROLS).map((key) => {
      const name = key as keyof ExecutionControlTelemetry;
      return [name, Math.max(0, Number(prior[name] || 0) + Number(delta[name] || 0))];
    })) as unknown as ExecutionControlTelemetry;
    journal.controls = controls;
    return journal as unknown as Record<string, unknown>;
  }, { createDefault: () => ({ schema_version: 1, events: [], controls: EMPTY_CONTROLS }) });
  return controls;
}

/** Persist the zero-rule signal for a logical pipeline that stopped without
 * completing or receiving an explicit durable cancellation. Idempotent so a
 * signal handler and an outer fatal-error boundary cannot double count it. */
export function recordUnexpectedNoncompletionTermination(
  sessionDir: string,
  reason: string,
  options: { expectedSourceHandoffExit?: boolean } = {},
): boolean {
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  try {
    const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8')) as Record<string, unknown>;
    if (logical.terminal_state === 'completed' || logical.terminal_state === 'cancelled') return false;
    const handoffEvents = Array.isArray(logical.events)
      ? (logical.events as Array<Record<string, unknown>>).filter((event) => String(event.kind || '').startsWith('runtime_handoff_'))
      : [];
    const handoffKind = String(handoffEvents.at(-1)?.kind || '');
    if (options.expectedSourceHandoffExit
        && (handoffKind === 'runtime_handoff_released' || handoffKind === 'runtime_handoff_completed')) return false;
  } catch {
    // A missing/corrupt durable journal is itself unexpected non-completion.
  }
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let recorded = false;
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
    if (journal.unexpected_noncompletion_termination) return journal as unknown as Record<string, unknown>;
    const controls = { ...EMPTY_CONTROLS, ...(journal.controls || {}) };
    controls.unexpected_terminal_exits += 1;
    journal.controls = controls;
    journal.unexpected_noncompletion_termination = {
      schema_version: 1,
      reason: String(reason || 'unexpected non-completion termination'),
      recorded_at: new Date().toISOString(),
    };
    recorded = true;
    return journal as unknown as Record<string, unknown>;
  }, { createDefault: () => ({ schema_version: 1, events: [], controls: EMPTY_CONTROLS }) });
  return recorded;
}

export function executionTelemetrySummary(sessionDir: string, ticketId?: string): ExecutionTelemetrySummary {
  const journal = readJournal<ExecutionTelemetryJournal>(telemetryPath(sessionDir), { schema_version: 1, events: [] });
  const events = journal.events
    .filter((event) => !ticketId || event.ticket_id === ticketId);
  const controls = { ...EMPTY_CONTROLS, ...(journal.controls || {}) };
  const unexpectedNoncompletionTermination = Boolean(journal.unexpected_noncompletion_termination);
  const zeroedByUnexpectedTermination = unexpectedNoncompletionTermination || controls.unexpected_terminal_exits > 0;
  return {
    ticketAttempts: new Set(events.map((event) => `${event.ticket_id}\0${event.ticket_attempt}`)).size,
    phaseAttempts: events.length,
    recoveryEpochs: new Set(events.filter((event) => event.recovery_epoch > 0).map((event) => `${event.ticket_id}\0${event.recovery_epoch}`)).size,
    failedCalls: events.filter((event) => event.outcome === 'failed').length,
    successfulCalls: events.filter((event) => event.outcome === 'success').length,
    timedOutCalls: events.filter((event) => event.outcome === 'timed_out').length,
    cancelledCalls: events.filter((event) => event.outcome === 'cancelled').length,
    durationMs: events.reduce((sum, event) => sum + event.duration_ms, 0),
    inputTokens: events.reduce((sum, event) => sum + event.input_tokens, 0),
    cachedInputTokens: events.reduce((sum, event) => sum + event.cached_input_tokens, 0),
    cacheCreationInputTokens: events.reduce((sum, event) => sum + Number(event.cache_creation_input_tokens || 0), 0),
    outputTokens: events.reduce((sum, event) => sum + event.output_tokens, 0),
    productiveWork: events.reduce((sum, event) => sum + event.productive_work, 0),
    discardedWork: events.reduce((sum, event) => sum + event.discarded_work, 0),
    executorRestarts: controls.executor_restarts,
    checkpointsReused: controls.checkpoints_reused,
    checkpointsInvalidated: controls.checkpoints_invalidated,
    postSealHumanInterventions: controls.post_seal_human_interventions,
    unexpectedTerminalExits: controls.unexpected_terminal_exits,
    autonomyScore: controls.post_seal_human_interventions === 0 && !zeroedByUnexpectedTermination ? 1 : 0,
    reliabilityScore: zeroedByUnexpectedTermination ? 0 : 1,
    qualityScore: zeroedByUnexpectedTermination ? 0 : 1,
    unexpectedNoncompletionTermination,
  };
}

export type SchedulerDecision =
  | { kind: 'ticket'; ticketId: string }
  | { kind: 'diagnostic'; ticketId: string; task: string }
  | { kind: 'complete' };

export function planSchedulerContinuity(tickets: Ticket[], repairingTicketIds: ReadonlySet<string>): SchedulerDecision {
  const done = new Set(tickets.filter((ticket) => String(ticket.status).toLowerCase() === 'done').map((ticket) => ticket.id));
  const ready = tickets.find((ticket) => {
    const status = String(ticket.status || 'Todo').toLowerCase();
    const dependencies = Array.isArray(ticket.depends_on) ? ticket.depends_on : [];
    return !repairingTicketIds.has(ticket.id)
      && !['done', 'skipped', 'blocked'].includes(status)
      && dependencies.every((dependency) => done.has(dependency));
  });
  if (ready) return { kind: 'ticket', ticketId: ready.id };
  const repairing = tickets.find((ticket) => repairingTicketIds.has(ticket.id));
  if (repairing) return { kind: 'diagnostic', ticketId: repairing.id, task: 'diagnose-and-select-material-repair-strategy' };
  return tickets.every((ticket) => String(ticket.status).toLowerCase() === 'done')
    ? { kind: 'complete' }
    : { kind: 'diagnostic', ticketId: tickets[0]?.id || 'pipeline', task: 'repair-dependency-or-contract-blockage' };
}
