import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { loadConfig } from './config.js';
import { getHeadSha, getWorkingTreeStatus } from './git-utils.js';

export function normalizeErrorSignature(input) {
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

export function freshCircuitState() {
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

export function captureProgressSnapshot(state) {
  return {
    head_sha: getHeadSha(state.working_dir),
    worktree_status: getWorkingTreeStatus(state.working_dir),
    step: state.step || null,
    current_ticket: state.current_ticket || null,
    history_length: Array.isArray(state.history) ? state.history.length : 0,
    iteration: Number(state.iteration || 0),
  };
}

export function loadCircuitState(sessionDir) {
  const filePath = path.join(sessionDir, 'circuit_breaker.json');
  const parsed = readJsonFile(filePath, null);
  if (!parsed || typeof parsed !== 'object') {
    return freshCircuitState();
  }
  return { ...freshCircuitState(), ...parsed };
}

export function saveCircuitState(sessionDir, circuitState) {
  atomicWriteJson(path.join(sessionDir, 'circuit_breaker.json'), circuitState);
}

function recordTransition(circuitState, nextState, reason) {
  if (circuitState.state === nextState) return;
  const timestamp = new Date().toISOString();
  circuitState.history.push({
    from: circuitState.state,
    to: nextState,
    timestamp,
    reason,
  });
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

function snapshotsDiffer(previous, next) {
  if (!previous) return true;
  return [
    previous.head_sha !== next.head_sha,
    previous.worktree_status !== next.worktree_status,
    previous.step !== next.step,
    previous.current_ticket !== next.current_ticket,
    previous.history_length !== next.history_length,
  ].some(Boolean);
}

export function recordIteration(sessionDir, state, options = {}) {
  const config = loadConfig();
  const circuitConfig = {
    ...config.defaults.circuit_breaker,
    ...(options.circuitBreakerConfig || {}),
  };
  const circuitState = loadCircuitState(sessionDir);
  const snapshot = captureProgressSnapshot(state);
  const progress = snapshotsDiffer(circuitState.last_snapshot, snapshot);
  const errorSignature = options.error ? normalizeErrorSignature(options.error) : null;

  if (progress) {
    circuitState.consecutive_no_progress = 0;
    circuitState.consecutive_same_error = 0;
    circuitState.last_error_signature = errorSignature;
    recordTransition(circuitState, 'CLOSED', 'progress detected');
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
