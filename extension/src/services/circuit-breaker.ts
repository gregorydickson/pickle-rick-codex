import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { loadConfig } from './config.js';
import { captureProgressSnapshot, diffProgressSnapshot } from './progress-snapshot.js';
import type {
  CircuitBreakerConfig,
  CircuitHistoryEntry,
  CircuitIterationState,
  CircuitState,
  CircuitStateName,
  ProgressMode,
  ProgressSnapshot,
  RecordIterationOptions,
} from '../types/index.js';

export function normalizeErrorSignature(input: unknown): string {
  return String(input || '')
    .replace(/\/[\w./-]+/g, '<PATH>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TIME>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\d+:\d+/g, '<LOC>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/** Explicit discovery diagnostics are information gained, not repeated execution failures. */
export function isConstraintDiscoverySignature(input: unknown): boolean {
  const value = String(input || '').trim().toLowerCase();
  return /^(?:(?:constraint[-_ ]discovery|discovered constraint)\s*:|\[constraint[-_ ]discovery\](?:\s|:))/.test(value);
}

export function freshCircuitState(): CircuitState {
  return {
    state: 'CLOSED',
    last_change: new Date().toISOString(),
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_snapshot: null,
    total_opens: 0,
    reason: '',
    opened_at: null,
    history: [],
  };
}

export function loadCircuitState(sessionDir: string): CircuitState {
  const filePath = path.join(sessionDir, 'circuit_breaker.json');
  const parsed = readJsonFile<Record<string, unknown>>(filePath, null);
  if (!parsed || typeof parsed !== 'object') {
    return freshCircuitState();
  }
  return { ...freshCircuitState(), ...parsed } as CircuitState;
}

export function saveCircuitState(sessionDir: string, circuitState: CircuitState): void {
  atomicWriteJson(path.join(sessionDir, 'circuit_breaker.json'), circuitState);
}

export function canExecute(circuitState: CircuitState): boolean {
  return circuitState.state !== 'OPEN';
}

function recordTransition(circuitState: CircuitState, nextState: CircuitStateName, reason: string): void {
  if (circuitState.state === nextState) return;
  const timestamp = new Date().toISOString();
  const entry: CircuitHistoryEntry = {
    from: circuitState.state,
    to: nextState,
    timestamp,
    reason,
  };
  circuitState.history.push(entry);
  circuitState.state = nextState;
  circuitState.last_change = timestamp;
  circuitState.reason = nextState === 'CLOSED' ? '' : reason;
  if (nextState === 'OPEN') {
    circuitState.total_opens += 1;
    circuitState.opened_at = timestamp;
  }
  if (nextState === 'CLOSED') {
    circuitState.opened_at = null;
  }
}

export function resetCircuitBreaker(sessionDir: string, reason = 'manual reset'): CircuitState {
  const circuitState = loadCircuitState(sessionDir);
  if (circuitState.state === 'CLOSED') return circuitState;

  circuitState.consecutive_no_progress = 0;
  circuitState.consecutive_same_error = 0;
  circuitState.last_error_signature = null;
  circuitState.last_snapshot = null;
  recordTransition(circuitState, 'CLOSED', reason);
  saveCircuitState(sessionDir, circuitState);
  return circuitState;
}

export function recordIteration(
  sessionDir: string,
  state: CircuitIterationState,
  options: RecordIterationOptions = {},
): CircuitState {
  const config = loadConfig();
  const circuitConfig: CircuitBreakerConfig = {
    ...config.defaults.circuit_breaker,
    ...(options.circuitBreakerConfig || {}),
  };
  const circuitState = loadCircuitState(sessionDir);
  const snapshot = captureProgressSnapshot({
    sessionDir,
    workingDir: state.working_dir,
    mode: (state.loop_mode || null) as ProgressMode,
    step: state.step,
    currentTicket: state.current_ticket,
  });
  const progressReasons = diffProgressSnapshot(
    circuitState.last_snapshot as ProgressSnapshot | null,
    snapshot,
  ).filter((reason) => reason !== 'initial_snapshot');
  const progress = progressReasons.length > 0;
  const errorSignature = options.error ? normalizeErrorSignature(options.error) : null;
  const constraintDiscovered = isConstraintDiscoverySignature(options.error);

  if (progress || constraintDiscovered) {
    circuitState.consecutive_no_progress = 0;
    circuitState.consecutive_same_error = 0;
    circuitState.last_error_signature = errorSignature;
    recordTransition(circuitState, 'CLOSED', constraintDiscovered ? 'constraint discovered' : 'progress detected');
  } else {
    circuitState.consecutive_no_progress += 1;
    if (errorSignature && errorSignature === circuitState.last_error_signature) {
      circuitState.consecutive_same_error += 1;
    } else if (errorSignature) {
      circuitState.consecutive_same_error = 1;
      circuitState.last_error_signature = errorSignature;
    }

    if (
      circuitState.consecutive_no_progress >= circuitConfig.no_progress_threshold ||
      circuitState.consecutive_same_error >= circuitConfig.same_error_threshold
    ) {
      recordTransition(circuitState, 'OPEN', options.error || 'circuit breaker opened');
    } else if (
      circuitState.consecutive_no_progress >= circuitConfig.half_open_after ||
      circuitState.consecutive_same_error >= circuitConfig.half_open_after
    ) {
      recordTransition(circuitState, 'HALF_OPEN', options.error || 'progress stalled');
    }
  }

  circuitState.last_snapshot = snapshot;
  saveCircuitState(sessionDir, circuitState);
  return circuitState;
}
