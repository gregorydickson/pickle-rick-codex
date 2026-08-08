import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import type { Ticket } from '../types/index.js';
import type { CodexSpawnResult } from '../types/index.js';
import type { WorkerLifecyclePhase } from './worker-lifecycle.js';
import type { PersistedProcessIdentity } from './orphan-reaper.js';

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
  progress?: RecoveryStrategyProgress[];
}

export interface RecoveryStrategyProgress {
  sequence: number;
  ticketId: string;
  afterEpochSequence: number;
  evidence: string;
  recordedAt: string;
}

export interface MaterialRecoveryPlan {
  route: FailureRoute;
  materialApproach: string;
  inputHashes: string[];
}

export interface ExecutionTelemetryEvent {
  sequence: number;
  model_attempt_id?: number;
  ticket_id: string;
  phase: string;
  ticket_attempt: number;
  phase_attempt: number;
  recovery_epoch: number;
  strategy_hash: string | null;
  outcome: 'success' | 'failed' | 'cancelled' | 'timed_out';
  telemetry_status?: 'reported' | 'telemetry_unavailable';
  telemetry_failure?: 'completed_without_usage' | 'call_ended_without_usage' | null;
  duration_ms: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens: number | null;
  productive_work: number;
  discarded_work: number;
  recorded_at: string;
}

interface ExecutionTelemetryJournal {
  schema_version: 1;
  events: ExecutionTelemetryEvent[];
  next_model_attempt_id?: number;
  model_attempts?: ModelCallTelemetryReservation[];
  controls?: ExecutionControlTelemetry;
  unexpected_noncompletion_termination?: {
    schema_version: 1;
    reason: string;
    recorded_at: string;
  };
  expected_source_handoff_exit?: {
    schema_version: 1;
    request_id: string;
    executor_identity: PersistedProcessIdentity;
    recorded_at: string;
  };
}

export interface ModelCallTelemetryReservation {
  model_attempt_id: number;
  ticket_id: string;
  phase: string;
  ticket_attempt: number;
  phase_attempt: number;
  recovery_epoch: number;
  strategy_hash: string | null;
  status: 'started' | 'finalized';
  started_at: string;
  finalized_at?: string;
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
  const explicitFailureType = AUTONOMOUS_FAILURE_TYPES.find((failureType) => kind === failureType);
  if (explicitFailureType) return explicitFailureType;
  if (kind.includes('prd_contract_defect') || message.includes('contradictory prd')) return 'prd_contract_defect';
  if (kind.includes('workspace_unsafe') || message.includes('unsafe workspace')) return 'workspace_unsafe';
  if (kind.includes('completion_evidence') || kind.includes('oracle_refusal')
    || message.includes('completion evidence') || message.includes('oracle refusal')) return 'completion_evidence_refused';
  if (kind.includes('contract') || kind.includes('preflight') || message.includes('verification contract') || message.includes('preflight')) return 'contract_invalid';
  if (kind.includes('artifact')
    || message.includes('worker-lifecycle-missing-artifact')
    || message.includes('worker-lifecycle-invalid-artifact')) return 'artifact_invalid';
  if (kind.includes('implementation')) return 'implementation_invalid';
  if (kind.includes('quality') || message.includes('quality-gate') || message.includes('quality gate')) return 'quality_failed';
  if (kind.includes('test') || kind.includes('verification_failed') || message.includes('verification command failed') || message.includes('verification-command-failed')) return 'verification_failed';
  if (kind.includes('transport') || message.includes('worker transport')) return 'worker_transport';
  if (phase === 'review' || kind.includes('review') || message.includes('review requested changes')) return 'review_refused';
  if (phase === 'conformance' || kind.includes('conformance')) return 'conformance_refused';
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

function readRecoveryStrategyJournal(sessionDir: string): RecoveryStrategyJournal {
  const journal = readJournal<RecoveryStrategyJournal>(strategyPath(sessionDir), { schema_version: 1, epochs: [] });
  if (journal.schema_version !== 1 || !Array.isArray(journal.epochs) || (journal.progress !== undefined && !Array.isArray(journal.progress))) {
    throw new Error('recovery-strategy-corrupt');
  }
  for (let index = 0; index < journal.epochs.length; index += 1) {
    const epoch = journal.epochs[index];
    if (!epoch || epoch.sequence !== index + 1 || typeof epoch.ticketId !== 'string'
      || !/^[0-9a-f]{64}$/.test(String(epoch.strategyHash || ''))) throw new Error('recovery-strategy-corrupt');
  }
  const progressBoundaries = new Map<string, number>();
  for (let index = 0; index < (journal.progress || []).length; index += 1) {
    const event = journal.progress![index];
    const boundary = journal.epochs.find((epoch) => epoch.sequence === event?.afterEpochSequence);
    const previousBoundary = progressBoundaries.get(event?.ticketId || '') || 0;
    if (!event || event.sequence !== index + 1 || typeof event.ticketId !== 'string' || !event.ticketId.trim()
      || !boundary || boundary.ticketId !== event.ticketId || typeof event.evidence !== 'string' || !event.evidence.trim()
      || event.afterEpochSequence <= previousBoundary
      || typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))) {
      throw new Error('recovery-strategy-corrupt');
    }
    progressBoundaries.set(event.ticketId, event.afterEpochSequence);
  }
  return journal;
}

export function beginRecoveryStrategyEpoch(
  sessionDir: string,
  input: RecoveryStrategyInput,
  trigger: RecoveryStrategyEpoch['trigger'],
): RecoveryStrategyEpoch {
  const filePath = strategyPath(sessionDir);
  const journal = readRecoveryStrategyJournal(sessionDir);
  const strategyHash = materialStrategyHash(input);
  const progressBoundary = [...(journal.progress || [])]
    .reverse()
    .find((event) => event.ticketId === input.ticketId)?.afterEpochSequence ?? 0;
  const unresolved = journal.epochs.filter((epoch) => (
    epoch.ticketId === input.ticketId && epoch.sequence > progressBoundary
  ));
  if (unresolved.some((epoch) => epoch.strategyHash === strategyHash)) {
    throw new Error(`recovery-strategy-not-novel: ticket ${input.ticketId} reused unresolved strategy ${strategyHash}`);
  }
  const epoch: RecoveryStrategyEpoch = {
    ...input,
    sequence: journal.epochs.length + 1,
    strategyHash,
    startedAt: new Date().toISOString(),
    trigger,
  };
  atomicWriteJson(filePath, { ...journal, schema_version: 1, epochs: [...journal.epochs, epoch] });
  return epoch;
}

export function readRecoveryStrategyEpochs(sessionDir: string): RecoveryStrategyEpoch[] {
  return readRecoveryStrategyJournal(sessionDir).epochs;
}

export function readUnresolvedRecoveryStrategyEpochs(sessionDir: string, ticketId: string): RecoveryStrategyEpoch[] {
  const journal = readRecoveryStrategyJournal(sessionDir);
  const boundary = [...(journal.progress || [])]
    .reverse()
    .find((event) => event.ticketId === ticketId)?.afterEpochSequence ?? 0;
  return journal.epochs.filter((epoch) => epoch.ticketId === ticketId && epoch.sequence > boundary);
}

export function recordRecoveryStrategyProgress(
  sessionDir: string,
  ticketId: string,
  evidence: string,
): RecoveryStrategyProgress | null {
  const filePath = strategyPath(sessionDir);
  const journal = readRecoveryStrategyJournal(sessionDir);
  const latestEpoch = [...journal.epochs].reverse().find((epoch) => epoch.ticketId === ticketId);
  if (!latestEpoch) return null;
  const prior = [...(journal.progress || [])].reverse().find((event) => event.ticketId === ticketId);
  if (prior && prior.afterEpochSequence >= latestEpoch.sequence) return prior;
  const event: RecoveryStrategyProgress = {
    sequence: (journal.progress || []).length + 1,
    ticketId,
    afterEpochSequence: latestEpoch.sequence,
    evidence: evidence.trim() || 'verified ticket completion',
    recordedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, { ...journal, schema_version: 1, progress: [...(journal.progress || []), event] });
  const persisted = readRecoveryStrategyJournal(sessionDir).progress?.at(-1);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(event)) throw new Error('recovery-strategy-corrupt');
  return persisted;
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

/**
 * Select a durable strategy without ever cycling back into an unresolved hash.
 * The first three epochs retain the domain-specific fast paths. Exhausting
 * those paths escalates once through contract repair, then returns to the
 * original typed handler with the accumulated unresolved evidence as a new
 * causal input. Later diagnostic epochs remain unique because each one binds
 * the complete, growing set of prior strategy hashes.
 */
export function nextMaterialRecoveryPlan(
  route: FailureRoute,
  unresolvedEpochs: RecoveryStrategyEpoch[],
): MaterialRecoveryPlan {
  const inputHashes = unresolvedEpochs.map((epoch) => epoch.strategyHash);
  const priorEpochs = unresolvedEpochs.length;
  if (priorEpochs < 3) {
    return {
      route: structuredClone(route),
      materialApproach: nextMaterialApproach(route.domain, priorEpochs),
      inputHashes,
    };
  }
  if (priorEpochs === 3) {
    const contractRoute = typedRecoveryRoute('contract_invalid');
    return {
      route: contractRoute,
      materialApproach: route.domain === 'contract'
        ? 're-refine-contract-slice-from-unresolved-evidence'
        : `repair-contract-after-${route.failureType || route.domain}-strategy-exhaustion`,
      inputHashes,
    };
  }
  if (priorEpochs === 4) {
    return {
      route: structuredClone(route),
      materialApproach: `diagnose-cross-phase-causal-gap-after-contract-repair-${route.domain}`,
      inputHashes,
    };
  }
  return {
    route: structuredClone(route),
    materialApproach: `synthesize-novel-${route.domain}-strategy-from-${priorEpochs}-unresolved-epochs`,
    inputHashes,
  };
}

export function recordExecutionTelemetry(
  sessionDir: string,
  input: Omit<ExecutionTelemetryEvent, 'sequence' | 'recorded_at' | 'ticket_attempt' | 'phase_attempt'> & {
    ticket_attempt?: number;
    phase_attempt?: number;
  },
): ExecutionTelemetryEvent {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let event: ExecutionTelemetryEvent | null = null;
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
    const priorTicketAttempts = journal.events
      .filter((candidate) => candidate.ticket_id === input.ticket_id)
      .map((candidate) => Number(candidate.ticket_attempt || 0));
    const priorPhaseAttempts = journal.events
      .filter((candidate) => candidate.ticket_id === input.ticket_id && candidate.phase === input.phase)
      .map((candidate) => Number(candidate.phase_attempt || 0));
    const ticketAttempt = Number.isInteger(input.ticket_attempt) && Number(input.ticket_attempt) > 0
      ? Number(input.ticket_attempt) : Math.max(0, ...priorTicketAttempts) + 1;
    const phaseAttempt = Number.isInteger(input.phase_attempt) && Number(input.phase_attempt) > 0
      ? Number(input.phase_attempt) : Math.max(0, ...priorPhaseAttempts) + 1;
    const priorModelAttemptIds = journal.events.map((candidate) => Number(candidate.model_attempt_id || 0));
    const modelAttemptId = Math.max(
      Number(journal.next_model_attempt_id || 1),
      Math.max(0, ...priorModelAttemptIds) + 1,
    );
    journal.next_model_attempt_id = modelAttemptId + 1;
    event = {
      ...input,
      model_attempt_id: modelAttemptId,
      ticket_attempt: ticketAttempt,
      phase_attempt: phaseAttempt,
      sequence: Math.max(0, ...journal.events.map((candidate) => Number(candidate.sequence || 0))) + 1,
      recorded_at: new Date().toISOString(),
    };
    journal.events.push(event);
    return journal as unknown as Record<string, unknown>;
  }, { createDefault: () => ({ schema_version: 1, events: [] }) });
  if (!event) throw new Error('execution-telemetry-write-failed');
  return event;
}

export function reserveModelCallTelemetry(
  sessionDir: string,
  input: {
    ticketId: string;
    phase: string;
    ticketAttempt?: number;
    phaseAttempt?: number;
    recoveryEpoch?: number;
    strategyHash?: string | null;
  },
): ModelCallTelemetryReservation {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let reservation: ModelCallTelemetryReservation | null = null;
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
    journal.model_attempts = Array.isArray(journal.model_attempts) ? journal.model_attempts : [];
    const prior = [...journal.events, ...journal.model_attempts];
    const phaseAttempts = prior
      .filter((candidate) => candidate.ticket_id === input.ticketId && candidate.phase === input.phase)
      .map((candidate) => Number(candidate.phase_attempt || 0));
    const phaseAttempt = Number.isInteger(input.phaseAttempt) && Number(input.phaseAttempt) > 0
      ? Number(input.phaseAttempt) : Math.max(0, ...phaseAttempts) + 1;
    const ticketAttempt = Number.isInteger(input.ticketAttempt) && Number(input.ticketAttempt) > 0
      ? Number(input.ticketAttempt) : phaseAttempt;
    const priorIds = prior.map((candidate) => Number(candidate.model_attempt_id || 0));
    const modelAttemptId = Math.max(
      Number(journal.next_model_attempt_id || 1),
      Math.max(0, ...priorIds) + 1,
    );
    journal.next_model_attempt_id = modelAttemptId + 1;
    reservation = {
      model_attempt_id: modelAttemptId,
      ticket_id: input.ticketId,
      phase: input.phase,
      ticket_attempt: ticketAttempt,
      phase_attempt: phaseAttempt,
      recovery_epoch: input.recoveryEpoch ?? 0,
      strategy_hash: input.strategyHash ?? null,
      status: 'started',
      started_at: new Date().toISOString(),
    };
    journal.model_attempts.push(reservation);
    return journal as unknown as Record<string, unknown>;
  }, { createDefault: () => ({ schema_version: 1, events: [], model_attempts: [], next_model_attempt_id: 1 }) });
  if (!reservation) throw new Error('model-call-telemetry-reservation-failed');
  return reservation;
}

export function finalizeModelCallTelemetry(
  sessionDir: string,
  reservation: ModelCallTelemetryReservation,
  input: {
    result: CodexSpawnResult;
    outcome?: ExecutionTelemetryEvent['outcome'];
    productiveWork?: number;
    discardedWork?: number;
  },
): ExecutionTelemetryEvent {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  let event: ExecutionTelemetryEvent | null = null;
  stateManager.update(filePath, (raw) => {
    const journal = raw as unknown as ExecutionTelemetryJournal;
    if (journal.schema_version !== 1 || !Array.isArray(journal.events) || !Array.isArray(journal.model_attempts)) {
      throw new Error('execution-telemetry-corrupt');
    }
    const persisted = journal.model_attempts.find((candidate) => (
      candidate.model_attempt_id === reservation.model_attempt_id
    ));
    if (!persisted || persisted.status !== 'started') throw new Error('model-call-telemetry-reservation-missing');
    const outcome = input.outcome ?? (input.result.cancelled
      ? 'cancelled'
      : input.result.timedOut
        ? 'timed_out'
        : input.result.exitCode === 0 ? 'success' : 'failed');
    const usageReported = input.result.usageReported ?? Object.values(input.result.usage)
      .some((value) => Number(value) > 0);
    event = {
      sequence: Math.max(0, ...journal.events.map((candidate) => Number(candidate.sequence || 0))) + 1,
      model_attempt_id: persisted.model_attempt_id,
      ticket_id: persisted.ticket_id,
      phase: persisted.phase,
      ticket_attempt: persisted.ticket_attempt,
      phase_attempt: persisted.phase_attempt,
      recovery_epoch: persisted.recovery_epoch,
      strategy_hash: persisted.strategy_hash,
      outcome,
      telemetry_status: usageReported ? 'reported' : 'telemetry_unavailable',
      telemetry_failure: usageReported
        ? null
        : outcome === 'success' ? 'completed_without_usage' : 'call_ended_without_usage',
      duration_ms: input.result.durationMs,
      input_tokens: usageReported ? input.result.usage.input_tokens : null,
      cached_input_tokens: usageReported ? input.result.usage.cache_read_input_tokens : null,
      cache_creation_input_tokens: usageReported ? input.result.usage.cache_creation_input_tokens : null,
      output_tokens: usageReported ? input.result.usage.output_tokens : null,
      productive_work: input.productiveWork ?? (outcome === 'success' ? 1 : 0),
      discarded_work: input.discardedWork ?? (outcome === 'success' ? 0 : 1),
      recorded_at: new Date().toISOString(),
    };
    journal.events.push(event);
    persisted.status = 'finalized';
    persisted.finalized_at = event.recorded_at;
    return journal as unknown as Record<string, unknown>;
  });
  if (!event) throw new Error('model-call-telemetry-finalize-failed');
  return event;
}

export function recordModelCallTelemetry(
  sessionDir: string,
  input: {
    ticketId: string;
    phase: string;
    ticketAttempt?: number;
    phaseAttempt?: number;
    recoveryEpoch?: number;
    strategyHash?: string | null;
    result: CodexSpawnResult;
    outcome?: ExecutionTelemetryEvent['outcome'];
    productiveWork?: number;
    discardedWork?: number;
  },
): ExecutionTelemetryEvent {
  const reservation = reserveModelCallTelemetry(sessionDir, input);
  return finalizeModelCallTelemetry(sessionDir, reservation, input);
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

function acceptedSourceExitRequestId(
  logical: Record<string, unknown>,
  executorIdentity: PersistedProcessIdentity,
): string | null {
  const events = Array.isArray(logical.events) ? logical.events as Array<Record<string, unknown>> : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const completed = events[index];
    if (completed.kind !== 'runtime_handoff_completed') continue;
    const completedDetails = completed.details as Record<string, unknown> | undefined;
    const requestId = String(completedDetails?.request_id || '');
    const released = events.slice(0, index).reverse().find((event) => (
      event.kind === 'runtime_handoff_released'
      && (event.details as Record<string, unknown> | undefined)?.request_id === requestId
    ));
    const request = events.slice(0, index).reverse().find((event) => (
      event.kind === 'runtime_handoff_requested'
      && (event.details as Record<string, unknown> | undefined)?.request_id === requestId
    ));
    const releasedDetails = released?.details as Record<string, unknown> | undefined;
    const requestDetails = request?.details as Record<string, unknown> | undefined;
    const intent = releasedDetails?.source_exit_intent as Record<string, unknown> | undefined;
    const identity = intent?.owner_identity as PersistedProcessIdentity | undefined;
    if (!request || !identity || intent?.request_id !== requestId
        || intent.owner_id !== releasedDetails?.owner_id
        || JSON.stringify(intent.source_runtime) !== JSON.stringify(requestDetails?.source_runtime)
        || identity.pid !== executorIdentity.pid || identity.pgid !== executorIdentity.pgid
        || identity.start_time !== executorIdentity.start_time
        || identity.fingerprint !== executorIdentity.fingerprint) continue;
    return requestId;
  }
  return null;
}

/** Persist the zero-rule signal for a logical pipeline that stopped without
 * completing or receiving an explicit durable cancellation. Idempotent so a
 * signal handler and an outer fatal-error boundary cannot double count it. */
export function recordUnexpectedNoncompletionTermination(
  sessionDir: string,
  reason: string,
  options: {
    sourceExecutorIdentity?: PersistedProcessIdentity | null;
    consumeExpectedSourceHandoffExit?: boolean;
  } = {},
): boolean {
  const filePath = telemetryPath(sessionDir);
  const stateManager = new StateManager();
  if (options.consumeExpectedSourceHandoffExit) {
    let consumed = false;
    stateManager.update(filePath, (raw) => {
      const journal = raw as unknown as ExecutionTelemetryJournal;
      if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
      if (journal.expected_source_handoff_exit) {
        delete journal.expected_source_handoff_exit;
        consumed = true;
      }
      return journal as unknown as Record<string, unknown>;
    }, { createDefault: () => ({ schema_version: 1, events: [], controls: EMPTY_CONTROLS }) });
    if (consumed) return false;
  }
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  try {
    const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8')) as Record<string, unknown>;
    if (logical.terminal_state === 'completed' || logical.terminal_state === 'cancelled') return false;
    if (options.sourceExecutorIdentity) {
      const requestId = acceptedSourceExitRequestId(logical, options.sourceExecutorIdentity);
      if (requestId) {
        stateManager.update(filePath, (raw) => {
          const journal = raw as unknown as ExecutionTelemetryJournal;
          if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
          journal.expected_source_handoff_exit = {
            schema_version: 1,
            request_id: requestId,
            executor_identity: options.sourceExecutorIdentity as PersistedProcessIdentity,
            recorded_at: new Date().toISOString(),
          };
          return journal as unknown as Record<string, unknown>;
        }, { createDefault: () => ({ schema_version: 1, events: [], controls: EMPTY_CONTROLS }) });
        return false;
      }
    }
  } catch {
    // A missing/corrupt durable journal is itself unexpected non-completion.
  }
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
    inputTokens: events.reduce((sum, event) => sum + Number(event.input_tokens || 0), 0),
    cachedInputTokens: events.reduce((sum, event) => sum + Number(event.cached_input_tokens || 0), 0),
    cacheCreationInputTokens: events.reduce((sum, event) => sum + Number(event.cache_creation_input_tokens || 0), 0),
    outputTokens: events.reduce((sum, event) => sum + Number(event.output_tokens || 0), 0),
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
