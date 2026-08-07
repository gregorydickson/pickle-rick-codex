import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeErrorSignature } from './circuit-breaker.js';
import { atomicWriteJson } from './pickle-utils.js';
import type { WorkerLifecycleArtifact, WorkerLifecyclePhase } from './worker-lifecycle.js';

export type TicketFailureKind =
  | 'oracle_refusal'
  | 'worker_failure'
  | 'preflight'
  | 'verification_contract';

export type RecoveryAction = 'retry' | 'skip' | 'abort';

export interface TicketRecoveryInput {
  failureKind: TicketFailureKind;
  failureMode: string;
  attempt: number;
  maxAttempts: number;
  stopReason?: string | null;
  circuitOpen?: boolean;
  failureExitReason?: string;
  adaptiveExhausted?: boolean;
  adaptiveExitReason?: 'circuit_open' | 'recovery_exhausted';
}

export interface TicketRecoveryDecision {
  action: RecoveryAction;
  exitReason: string | null;
  reason: string;
}

export interface TicketRecoveryFailureIdentity {
  signature: string;
  phase: WorkerLifecyclePhase | null;
  evidencePath: string | null;
  remediationIdentity: string | null;
}

export interface TicketRecoveryEvent {
  sequence: number;
  ticket_id: string;
  failure_kind: TicketFailureKind;
  signature: string;
  phase: WorkerLifecyclePhase | null;
  evidence_path: string | null;
  remediation_identity: string | null;
  changed_lineage: boolean;
  consecutive_same_lineage: number;
  /** History-wide occurrence count for this ticket and failure signature. */
  lineage_occurrences?: number;
  /** Monotonic recovery failures consumed by this ticket. */
  ticket_failure_count?: number;
  recorded_at: string;
}

export interface TicketRecoveryUsage {
  ticketFailureCount: number;
  maxLineageOccurrences: number;
}

interface TicketRecoveryHistory {
  schema_version: 1;
  events: TicketRecoveryEvent[];
}

interface TicketRecoveryAuthorization {
  sequence: number;
  ticket_id: string;
  start_after_event: number;
  authorized_at: string;
  authorized_by?: 'operator' | 'runner';
  reason?: string;
}

interface TicketRecoveryAuthorizations {
  schema_version: 1;
  authorizations: TicketRecoveryAuthorization[];
}

const TICKET_RECOVERY_HISTORY_FILE = 'ticket-recovery-history.json';
const TICKET_RECOVERY_AUTHORIZATIONS_FILE = 'ticket-recovery-authorizations.json';
export const MAX_ADAPTIVE_TICKET_FAILURES = 25;

function normalizedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map(normalizeFindingIdentity)
      .sort()
    : [];
}

function normalizeFindingIdentity(value: unknown): string {
  return String(value || '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TIME>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/:\d+(?:-\d+)?/g, ':<LOC>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function buildTicketRecoveryFailureIdentity(input: {
  failureKind: TicketFailureKind;
  message: string;
  phase?: WorkerLifecyclePhase | null;
  artifact?: WorkerLifecycleArtifact | null;
  evidencePath?: string | null;
  remediationIdentity?: string | null;
}): TicketRecoveryFailureIdentity {
  const failedCriteria = Array.isArray(input.artifact?.acceptance_criteria)
    ? input.artifact.acceptance_criteria
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .filter((entry) => entry.status === 'fail')
      .map((entry) => normalizeFindingIdentity(entry.criterion))
      .sort()
    : [];
  const findings = normalizedStrings(input.artifact?.findings);
  const payload = {
    failure_kind: input.failureKind,
    phase: input.phase || null,
    verdict: typeof input.artifact?.verdict === 'string' ? input.artifact.verdict : null,
    findings,
    failed_criteria: failedCriteria,
    remediation_identity: input.remediationIdentity || null,
    fallback: findings.length === 0 && failedCriteria.length === 0
      ? normalizeErrorSignature(input.message)
      : null,
  };
  return {
    signature: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    phase: input.phase || null,
    evidencePath: input.evidencePath || null,
    remediationIdentity: input.remediationIdentity || null,
  };
}

function recoveryHistoryPath(sessionDir: string): string {
  return path.join(sessionDir, TICKET_RECOVERY_HISTORY_FILE);
}

function validateRecoveryHistory(value: unknown): TicketRecoveryHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ticket-recovery-corrupt: history must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1 || !Array.isArray(candidate.events)) {
    throw new Error('ticket-recovery-corrupt: unsupported history schema');
  }
  const failureKinds = new Set<TicketFailureKind>(['oracle_refusal', 'worker_failure', 'preflight', 'verification_contract']);
  const lifecyclePhases = new Set<WorkerLifecyclePhase>([
    'research', 'research_review', 'plan', 'plan_review', 'implement', 'review', 'simplify', 'conformance',
  ]);
  const latestByTicket = new Map<string, TicketRecoveryEvent>();
  const failuresByTicket = new Map<string, number>();
  const occurrencesByTicketLineage = new Map<string, number>();
  for (let index = 0; index < candidate.events.length; index += 1) {
    const event = candidate.events[index] as Record<string, unknown> | null;
    if (
      !event
      || event.sequence !== index + 1
      || typeof event.ticket_id !== 'string' || !event.ticket_id.trim()
      || !failureKinds.has(event.failure_kind as TicketFailureKind)
      || !/^[0-9a-f]{64}$/.test(String(event.signature || ''))
      || (event.phase !== null && !lifecyclePhases.has(event.phase as WorkerLifecyclePhase))
      || (event.evidence_path !== null && typeof event.evidence_path !== 'string')
      || (event.remediation_identity !== null && typeof event.remediation_identity !== 'string')
      || typeof event.changed_lineage !== 'boolean'
      || !Number.isInteger(event.consecutive_same_lineage)
      || Number(event.consecutive_same_lineage) < 1
      || typeof event.recorded_at !== 'string' || !Number.isFinite(Date.parse(event.recorded_at))
    ) {
      throw new Error(`ticket-recovery-corrupt: invalid event at index ${index}`);
    }
    const typedEvent = event as unknown as TicketRecoveryEvent;
    const previous = latestByTicket.get(typedEvent.ticket_id) || null;
    const expectedChanged = previous === null || previous.signature !== typedEvent.signature;
    const expectedConsecutive = expectedChanged ? 1 : previous.consecutive_same_lineage + 1;
    const ticketFailureCount = (failuresByTicket.get(typedEvent.ticket_id) || 0) + 1;
    const lineageKey = `${typedEvent.ticket_id}\0${typedEvent.signature}`;
    const lineageOccurrences = (occurrencesByTicketLineage.get(lineageKey) || 0) + 1;
    if (
      typedEvent.changed_lineage !== expectedChanged
      || typedEvent.consecutive_same_lineage !== expectedConsecutive
      || (typedEvent.ticket_failure_count !== undefined && typedEvent.ticket_failure_count !== ticketFailureCount)
      || (typedEvent.lineage_occurrences !== undefined && typedEvent.lineage_occurrences !== lineageOccurrences)
    ) {
      throw new Error(`ticket-recovery-corrupt: recovery counters regress at index ${index}`);
    }
    latestByTicket.set(typedEvent.ticket_id, typedEvent);
    failuresByTicket.set(typedEvent.ticket_id, ticketFailureCount);
    occurrencesByTicketLineage.set(lineageKey, lineageOccurrences);
  }
  return candidate as unknown as TicketRecoveryHistory;
}

function readRecoveryHistory(sessionDir: string): TicketRecoveryHistory {
  const filePath = recoveryHistoryPath(sessionDir);
  if (!fs.existsSync(filePath)) return { schema_version: 1, events: [] };
  try {
    return validateRecoveryHistory(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ticket-recovery-corrupt:')) throw error;
    throw new Error(
      `ticket-recovery-corrupt: history is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readRecoveryAuthorizations(sessionDir: string, historyLength: number): TicketRecoveryAuthorizations {
  const filePath = path.join(sessionDir, TICKET_RECOVERY_AUTHORIZATIONS_FILE);
  if (!fs.existsSync(filePath)) return { schema_version: 1, authorizations: [] };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (value.schema_version !== 1 || !Array.isArray(value.authorizations)) {
      throw new Error('ticket-recovery-corrupt: unsupported authorization schema');
    }
    let priorBoundary = -1;
    for (let index = 0; index < value.authorizations.length; index += 1) {
      const authorization = value.authorizations[index] as Record<string, unknown> | null;
      if (
        !authorization
        || authorization.sequence !== index + 1
        || typeof authorization.ticket_id !== 'string' || !authorization.ticket_id.trim()
        || !Number.isInteger(authorization.start_after_event)
        || Number(authorization.start_after_event) < priorBoundary
        || Number(authorization.start_after_event) > historyLength
        || typeof authorization.authorized_at !== 'string'
        || !Number.isFinite(Date.parse(authorization.authorized_at))
        || (authorization.authorized_by !== undefined && !['operator', 'runner'].includes(String(authorization.authorized_by)))
        || (authorization.reason !== undefined && (typeof authorization.reason !== 'string' || !authorization.reason.trim()))
      ) {
        throw new Error(`ticket-recovery-corrupt: invalid authorization at index ${index}`);
      }
      priorBoundary = Number(authorization.start_after_event);
    }
    return value as unknown as TicketRecoveryAuthorizations;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ticket-recovery-corrupt:')) throw error;
    throw new Error(
      `ticket-recovery-corrupt: authorizations are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function recordTicketRecoveryFailure(input: {
  sessionDir: string;
  ticketId: string;
  failureKind: TicketFailureKind;
  identity: TicketRecoveryFailureIdentity;
}): TicketRecoveryEvent {
  const history = readRecoveryHistory(input.sessionDir);
  const previous = [...history.events].reverse().find((event) => event.ticket_id === input.ticketId) || null;
  const priorTicketEvents = history.events.filter((event) => event.ticket_id === input.ticketId);
  const lineageOccurrences = priorTicketEvents.filter((event) => event.signature === input.identity.signature).length + 1;
  const changedLineage = previous === null || previous.signature !== input.identity.signature;
  const event: TicketRecoveryEvent = {
    sequence: history.events.length + 1,
    ticket_id: input.ticketId,
    failure_kind: input.failureKind,
    signature: input.identity.signature,
    phase: input.identity.phase,
    evidence_path: input.identity.evidencePath,
    remediation_identity: input.identity.remediationIdentity,
    changed_lineage: changedLineage,
    consecutive_same_lineage: changedLineage ? 1 : previous.consecutive_same_lineage + 1,
    lineage_occurrences: lineageOccurrences,
    ticket_failure_count: priorTicketEvents.length + 1,
    recorded_at: new Date().toISOString(),
  };
  const next: TicketRecoveryHistory = { schema_version: 1, events: [...history.events, event] };
  atomicWriteJson(recoveryHistoryPath(input.sessionDir), next);
  const persisted = readRecoveryHistory(input.sessionDir);
  const persistedEvent = persisted.events.at(-1);
  if (!persistedEvent || JSON.stringify(persistedEvent) !== JSON.stringify(event)) {
    throw new Error('ticket-recovery-corrupt: appended event failed read-back validation');
  }
  return event;
}

/**
 * Derive durable budget consumption from the append-only journal. Legacy v1
 * events without explicit counters remain fully accounted for on resume.
 */
export function getTicketRecoveryUsage(sessionDir: string, ticketId: string): TicketRecoveryUsage {
  const history = readRecoveryHistory(sessionDir);
  const authorizations = readRecoveryAuthorizations(sessionDir, history.events.length);
  const boundary = [...authorizations.authorizations]
    .reverse()
    .find((authorization) => authorization.ticket_id === ticketId)?.start_after_event ?? 0;
  const events = history.events.filter((event) => event.ticket_id === ticketId && event.sequence > boundary);
  const lineageCounts = new Map<string, number>();
  for (const event of events) {
    lineageCounts.set(event.signature, (lineageCounts.get(event.signature) || 0) + 1);
  }
  return {
    ticketFailureCount: events.length,
    maxLineageOccurrences: Math.max(0, ...lineageCounts.values()),
  };
}

export function getTicketRecoveryLineageOccurrences(
  sessionDir: string,
  ticketId: string,
  signature: string,
): number {
  const history = readRecoveryHistory(sessionDir);
  const authorizations = readRecoveryAuthorizations(sessionDir, history.events.length);
  const boundary = [...authorizations.authorizations]
    .reverse()
    .find((authorization) => authorization.ticket_id === ticketId)?.start_after_event ?? 0;
  return history.events.filter((event) => (
    event.ticket_id === ticketId
    && event.sequence > boundary
    && event.signature === signature
  )).length;
}

/** Start a new bounded recovery epoch without deleting prior failure evidence. */
export function authorizeTicketRecoveryEpoch(
  sessionDir: string,
  ticketId: string,
  options: { authorizedBy?: 'operator' | 'runner'; reason?: string } = {},
): TicketRecoveryAuthorization {
  const history = readRecoveryHistory(sessionDir);
  const authorizations = readRecoveryAuthorizations(sessionDir, history.events.length);
  const authorization: TicketRecoveryAuthorization = {
    sequence: authorizations.authorizations.length + 1,
    ticket_id: ticketId,
    start_after_event: history.events.length,
    authorized_at: new Date().toISOString(),
    authorized_by: options.authorizedBy || 'operator',
    reason: options.reason || 'explicit ticket retry',
  };
  const next: TicketRecoveryAuthorizations = {
    schema_version: 1,
    authorizations: [...authorizations.authorizations, authorization],
  };
  const filePath = path.join(sessionDir, TICKET_RECOVERY_AUTHORIZATIONS_FILE);
  atomicWriteJson(filePath, next);
  const persisted = readRecoveryAuthorizations(sessionDir, history.events.length).authorizations.at(-1);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(authorization)) {
    throw new Error('ticket-recovery-corrupt: authorization failed read-back validation');
  }
  return authorization;
}

/**
 * Safety/contract failures are terminal and global safeguards always win.
 * Explicit retry-once remains bounded for compatibility. The mux runner turns
 * safe adaptive exhaustion into a new durable strategy epoch before asking for
 * this terminal decision; callers that do not authorize an epoch still fail closed.
 */
export function decideTicketRecovery(input: TicketRecoveryInput): TicketRecoveryDecision {
  const failureExitReason = input.failureExitReason || 'error';
  if (input.circuitOpen) {
    return { action: 'abort', exitReason: 'circuit_open', reason: 'circuit breaker is OPEN' };
  }
  if (input.failureKind === 'preflight' || input.failureKind === 'verification_contract') {
    return { action: 'abort', exitReason: failureExitReason, reason: `${input.failureKind} failures are not retryable` };
  }
  if (input.stopReason === 'max_time' || input.stopReason === 'max_iterations') {
    return { action: 'abort', exitReason: failureExitReason, reason: `${input.stopReason} prevents recovery` };
  }
  if (input.failureMode === 'retry') {
    return input.adaptiveExhausted
      ? {
        action: 'abort',
        exitReason: input.adaptiveExitReason || 'circuit_open',
        reason: input.adaptiveExitReason === 'recovery_exhausted'
          ? 'durable ticket recovery budget exhausted'
          : 'recovery lineage exhausted the circuit safeguard',
      }
      : { action: 'retry', exitReason: null, reason: 'adaptive recovery remains safe' };
  }
  if (input.failureMode === 'retry-once' && input.attempt < input.maxAttempts) {
    return { action: 'retry', exitReason: null, reason: 'bounded retry available' };
  }
  if (input.failureMode === 'skip') {
    return { action: 'skip', exitReason: null, reason: 'configured to skip failed tickets' };
  }
  return { action: 'abort', exitReason: failureExitReason, reason: 'recovery attempts exhausted' };
}
