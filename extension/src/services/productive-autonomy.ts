import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';
import type { Ticket } from '../types/index.js';
import type { WorkerLifecyclePhase } from './worker-lifecycle.js';

export type FailureDomain =
  | 'contract'
  | 'verification'
  | 'review'
  | 'conformance'
  | 'quality'
  | 'infrastructure';

export type RecoveryHandler =
  | 'repair_contract'
  | 'repair_verification'
  | 'remediate_candidate'
  | 'repair_conformance_evidence'
  | 'repair_quality_regression'
  | 'restart_executor'
  | 'reconstruct_workspace';

export interface FailureRoute {
  domain: FailureDomain;
  handler: RecoveryHandler;
  invalidate: string[];
  preserve: string[];
  schedulerState: 'repairing';
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
  output_tokens: number;
  productive_work: number;
  discarded_work: number;
  recorded_at: string;
}

interface ExecutionTelemetryJournal {
  schema_version: 1;
  events: ExecutionTelemetryEvent[];
}

export interface ExecutionTelemetrySummary {
  ticketAttempts: number;
  phaseAttempts: number;
  recoveryEpochs: number;
  failedCalls: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  productiveWork: number;
  discardedWork: number;
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
  const kind = String(input.kind || '').toLowerCase();
  const phase = String(input.phase || '').toLowerCase();
  const message = String(input.message || '').toLowerCase();
  if (kind.includes('contract') || kind.includes('preflight') || message.includes('verification contract') || message.includes('preflight')) return 'contract';
  if (phase === 'review' || kind.includes('review') || message.includes('review requested changes')) return 'review';
  if (phase === 'conformance' || kind.includes('conformance')) return 'conformance';
  if (kind.includes('quality') || message.includes('quality-gate') || message.includes('quality gate')) return 'quality';
  if (kind.includes('test') || kind.includes('verification_failed') || message.includes('verification command failed')) return 'verification';
  return 'infrastructure';
}

export function recoveryRoute(domain: FailureDomain): FailureRoute {
  return { domain, ...DOMAIN_POLICIES[domain] };
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
  const journal = readJournal<ExecutionTelemetryJournal>(filePath, { schema_version: 1, events: [] });
  if (journal.schema_version !== 1 || !Array.isArray(journal.events)) throw new Error('execution-telemetry-corrupt');
  const event: ExecutionTelemetryEvent = {
    ...input,
    sequence: journal.events.length + 1,
    recorded_at: new Date().toISOString(),
  };
  atomicWriteJson(filePath, { schema_version: 1, events: [...journal.events, event] });
  return event;
}

export function executionTelemetrySummary(sessionDir: string, ticketId?: string): ExecutionTelemetrySummary {
  const events = readJournal<ExecutionTelemetryJournal>(telemetryPath(sessionDir), { schema_version: 1, events: [] }).events
    .filter((event) => !ticketId || event.ticket_id === ticketId);
  return {
    ticketAttempts: new Set(events.map((event) => `${event.ticket_id}\0${event.ticket_attempt}`)).size,
    phaseAttempts: events.length,
    recoveryEpochs: new Set(events.filter((event) => event.recovery_epoch > 0).map((event) => `${event.ticket_id}\0${event.recovery_epoch}`)).size,
    failedCalls: events.filter((event) => event.outcome !== 'success').length,
    durationMs: events.reduce((sum, event) => sum + event.duration_ms, 0),
    inputTokens: events.reduce((sum, event) => sum + event.input_tokens, 0),
    cachedInputTokens: events.reduce((sum, event) => sum + event.cached_input_tokens, 0),
    outputTokens: events.reduce((sum, event) => sum + event.output_tokens, 0),
    productiveWork: events.reduce((sum, event) => sum + event.productive_work, 0),
    discardedWork: events.reduce((sum, event) => sum + event.discarded_work, 0),
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
