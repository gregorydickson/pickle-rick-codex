import fs from 'node:fs';
import path from 'node:path';
import { nowIso, atomicWriteJson, STATE_SCHEMA_VERSION } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import {
  buildPipelineStateMirror,
  PIPELINE_SCHEMA_VERSION,
  hasPipelineContract,
  readPipelineContract,
  resolveNextPipelinePhase,
  validatePipelineContract,
} from './pipeline.js';

const PHASE_STATUS_TODO = 'todo';
const PHASE_STATUS_RUNNING = 'running';
const PHASE_STATUS_DONE = 'done';
const PHASE_STATUS_CANCELLED = 'cancelled';
const PHASE_STATUS_FAILED = 'failed';

const PIPELINE_PHASE_STATUSES = new Set([
  PHASE_STATUS_TODO,
  PHASE_STATUS_RUNNING,
  PHASE_STATUS_DONE,
  PHASE_STATUS_CANCELLED,
  PHASE_STATUS_FAILED,
]);

export class PipelineStateError extends Error {
  constructor(message, code = 'PIPELINE_STATE_INVALID') {
    super(message);
    this.name = 'PipelineStateError';
    this.code = code;
  }
}

export function getPipelineStatePath(sessionDir) {
  return path.join(sessionDir, 'pipeline-state.json');
}

function getSessionStatePath(sessionDir) {
  return path.join(sessionDir, 'state.json');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildPhaseStatuses(phases) {
  return Object.fromEntries(phases.map((phase) => [phase, PHASE_STATUS_TODO]));
}

function phaseIndex(phases, phase) {
  return phases.indexOf(phase);
}

function clone(value) {
  return structuredClone(value);
}

function syncPipelineMirror(sessionState, pipeline, pipelineState) {
  Object.assign(sessionState, buildPipelineStateMirror(pipeline));
  sessionState.pipeline_mode = true;
  sessionState.pipeline_phase = pipelineState.current_phase ?? null;
  sessionState.pipeline_total_phases = pipeline.phases.length;
  sessionState.pipeline_phase_index = pipelineState.current_phase_index ?? null;
  return sessionState;
}

function appendHistoryEntry(sessionState, step, ticket = undefined) {
  sessionState.history ??= [];
  sessionState.history.push({
    step,
    ticket,
    timestamp: nowIso(),
  });
}

function clearRuntimeState(sessionState) {
  sessionState.active = false;
  sessionState.tmux_runner_pid = null;
  sessionState.worker_pid = null;
  sessionState.active_child_pid = null;
  sessionState.active_child_kind = null;
  sessionState.active_child_command = null;
}

function isBlockedExitReason(exitReason) {
  return exitReason === 'verification-contract-failed' || String(exitReason).startsWith('preflight-');
}

export function createInitialPipelineState(pipeline, now = nowIso()) {
  const contract = validatePipelineContract(pipeline);
  return {
    schema_version: PIPELINE_SCHEMA_VERSION,
    current_phase: resolveNextPipelinePhase(contract, { phase_statuses: buildPhaseStatuses(contract.phases) }),
    current_phase_index: 0,
    phase_statuses: buildPhaseStatuses(contract.phases),
    started_at: now,
    phase_started_at: null,
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
  };
}

export function validatePipelineState(pipeline, pipelineState) {
  const contract = validatePipelineContract(pipeline);
  if (!isPlainObject(pipelineState)) {
    throw new PipelineStateError('Pipeline state must be a JSON object.');
  }

  const phaseStatuses = {};
  for (const phase of contract.phases) {
    const status = String(pipelineState.phase_statuses?.[phase] || PHASE_STATUS_TODO).trim().toLowerCase();
    if (!PIPELINE_PHASE_STATUSES.has(status)) {
      throw new PipelineStateError(`Invalid pipeline phase status "${status}" for ${phase}.`);
    }
    phaseStatuses[phase] = status;
  }

  const currentPhase = resolveNextPipelinePhase(contract, { phase_statuses: phaseStatuses });
  if (currentPhase !== null && !contract.phases.includes(currentPhase)) {
    throw new PipelineStateError(`Unknown pipeline current phase "${currentPhase}".`);
  }

  const currentPhaseIndex = currentPhase == null ? null : phaseIndex(contract.phases, currentPhase);
  const schemaVersion = Number.isInteger(pipelineState.schema_version)
    ? pipelineState.schema_version
    : PIPELINE_SCHEMA_VERSION;
  if (schemaVersion > PIPELINE_SCHEMA_VERSION) {
    throw new PipelineStateError(
      `Pipeline state schema ${schemaVersion} is newer than supported ${PIPELINE_SCHEMA_VERSION}.`,
      'PIPELINE_STATE_SCHEMA_MISMATCH',
    );
  }

  return {
    schema_version: schemaVersion,
    current_phase: currentPhase,
    current_phase_index: currentPhaseIndex,
    phase_statuses: phaseStatuses,
    started_at: pipelineState.started_at || nowIso(),
    phase_started_at: pipelineState.phase_started_at || null,
    completed_at: pipelineState.completed_at || null,
    last_error: pipelineState.last_error || null,
    last_exit_reason: pipelineState.last_exit_reason || null,
  };
}

export function readPipelineState(sessionDir, stateManager = new StateManager(), pipeline = readPipelineContract(sessionDir)) {
  const filePath = getPipelineStatePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    throw new PipelineStateError(`Missing pipeline-state.json in ${sessionDir}.`, 'PIPELINE_STATE_MISSING');
  }
  return validatePipelineState(pipeline, stateManager.read(filePath));
}

export function ensurePipelineState(sessionDir, pipeline = readPipelineContract(sessionDir), stateManager = new StateManager()) {
  const filePath = getPipelineStatePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    const initial = createInitialPipelineState(pipeline);
    atomicWriteJson(filePath, initial);
  }
  const pipelineState = readPipelineState(sessionDir, stateManager, pipeline);
  const statePath = getSessionStatePath(sessionDir);
  if (fs.existsSync(statePath)) {
    stateManager.update(statePath, (sessionState) => syncPipelineMirror(sessionState, pipeline, pipelineState));
  }
  return pipelineState;
}

export function writePipelineState(
  sessionDir,
  pipelineState,
  options = {},
) {
  const stateManager = options.stateManager || new StateManager();
  const pipeline = options.pipeline || readPipelineContract(sessionDir);
  const normalizedPipelineState = validatePipelineState(pipeline, pipelineState);
  const pipelineStatePath = getPipelineStatePath(sessionDir);
  const statePath = getSessionStatePath(sessionDir);

  if (!fs.existsSync(statePath)) {
    atomicWriteJson(pipelineStatePath, normalizedPipelineState);
    return normalizedPipelineState;
  }

  if (!fs.existsSync(pipelineStatePath)) {
    atomicWriteJson(pipelineStatePath, normalizedPipelineState);
  }

  const orderedPaths = [statePath, pipelineStatePath].sort();
  const sessionStateIndex = orderedPaths.indexOf(statePath);
  const pipelineStateIndex = orderedPaths.indexOf(pipelineStatePath);
  const nextStates = stateManager.transaction(orderedPaths, (states) => {
    const mutableSessionState = clone(states[sessionStateIndex]);
    syncPipelineMirror(mutableSessionState, pipeline, normalizedPipelineState);
    mutableSessionState.schema_version ??= STATE_SCHEMA_VERSION;
    const updated = [...states];
    updated[sessionStateIndex] = mutableSessionState;
    updated[pipelineStateIndex] = normalizedPipelineState;
    return updated;
  });

  return nextStates[pipelineStateIndex];
}

export function isPipelineSession(sessionDir) {
  return hasPipelineContract(sessionDir);
}

export function transitionPipelineState(sessionDir, mutator, options = {}) {
  const stateManager = options.stateManager || new StateManager();
  const pipeline = options.pipeline || readPipelineContract(sessionDir);
  const statePath = getSessionStatePath(sessionDir);
  const pipelineStatePath = getPipelineStatePath(sessionDir);
  const orderedPaths = [statePath, pipelineStatePath].sort();
  const sessionStateIndex = orderedPaths.indexOf(statePath);
  const pipelineStateIndex = orderedPaths.indexOf(pipelineStatePath);
  ensurePipelineState(sessionDir, pipeline, stateManager);

  const nextStates = stateManager.transaction(
    orderedPaths,
    (states) => {
      const mutableSessionState = clone(states[sessionStateIndex]);
      const mutablePipelineState = validatePipelineState(pipeline, states[pipelineStateIndex]);
      mutator(mutablePipelineState, mutableSessionState, pipeline);
      const normalizedPipelineState = validatePipelineState(pipeline, mutablePipelineState);
      syncPipelineMirror(mutableSessionState, pipeline, normalizedPipelineState);
      mutableSessionState.schema_version ??= STATE_SCHEMA_VERSION;
      const updated = [...states];
      updated[sessionStateIndex] = mutableSessionState;
      updated[pipelineStateIndex] = normalizedPipelineState;
      return updated;
    },
  );

  return {
    state: nextStates[sessionStateIndex],
    pipelineState: nextStates[pipelineStateIndex],
    pipeline,
  };
}

export function beginPipelinePhase(sessionDir, phase, options = {}) {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    if (!pipeline.phases.includes(phase)) {
      throw new PipelineStateError(`Unknown pipeline phase "${phase}".`, 'PIPELINE_PHASE_INVALID');
    }
    pipelineState.current_phase = phase;
    pipelineState.current_phase_index = phaseIndex(pipeline.phases, phase);
    pipelineState.phase_statuses[phase] = PHASE_STATUS_RUNNING;
    pipelineState.phase_started_at = options.startedAt || nowIso();
    pipelineState.last_error = null;
    pipelineState.last_exit_reason = null;
    pipelineState.completed_at = null;
    sessionState.pipeline_mode = true;
    sessionState.step = phase;
    appendHistoryEntry(sessionState, phase, sessionState.current_ticket || undefined);
  }, options);
}

export function finishPipelinePhase(sessionDir, phase, options = {}) {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    if (!pipeline.phases.includes(phase)) {
      throw new PipelineStateError(`Unknown pipeline phase "${phase}".`, 'PIPELINE_PHASE_INVALID');
    }
    pipelineState.phase_statuses[phase] = options.exitReason === 'success'
      ? PHASE_STATUS_DONE
      : PHASE_STATUS_FAILED;
    pipelineState.last_exit_reason = options.exitReason || 'success';
    pipelineState.last_error = options.lastError || null;
    const nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
    pipelineState.current_phase = nextPhase;
    pipelineState.current_phase_index = nextPhase == null ? null : phaseIndex(pipeline.phases, nextPhase);
    pipelineState.phase_started_at = null;
    if (nextPhase == null && (options.exitReason || 'success') === 'success') {
      pipelineState.completed_at = options.completedAt || nowIso();
    }
    clearRuntimeState(sessionState);
    sessionState.last_exit_reason = options.exitReason || 'success';
    sessionState.pipeline_mode = true;
    if ((options.exitReason || 'success') === 'success') {
      sessionState.current_ticket = null;
      sessionState.step = nextPhase ?? 'complete';
    } else if (isBlockedExitReason(options.exitReason || '')) {
      sessionState.current_ticket = options.failedTicketId || sessionState.current_ticket || null;
      sessionState.step = 'blocked';
    } else {
      sessionState.current_ticket = options.exitReason === 'error'
        ? options.failedTicketId || sessionState.current_ticket || null
        : null;
      sessionState.step = 'paused';
    }
    appendHistoryEntry(
      sessionState,
      (options.exitReason || 'success') === 'success' ? 'pipeline_phase_done' : 'pipeline_phase_failed',
      sessionState.current_ticket || undefined,
    );
    if (nextPhase == null && (options.exitReason || 'success') === 'success') {
      appendHistoryEntry(sessionState, 'complete');
    }
  }, options);
}

export function cancelPipelineSession(sessionDir, options = {}) {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    const interruptedPhase = options.phase
      || pipelineState.current_phase
      || resolveNextPipelinePhase(pipeline, pipelineState)
      || pipeline.phases[0]
      || null;
    const cancelledAt = options.cancelledAt || nowIso();

    if (interruptedPhase && pipeline.phases.includes(interruptedPhase)) {
      pipelineState.current_phase = interruptedPhase;
      pipelineState.current_phase_index = phaseIndex(pipeline.phases, interruptedPhase);
      if (pipelineState.phase_statuses[interruptedPhase] !== PHASE_STATUS_DONE) {
        pipelineState.phase_statuses[interruptedPhase] = PHASE_STATUS_CANCELLED;
      }
    }

    pipelineState.last_exit_reason = options.exitReason || 'cancelled';
    pipelineState.last_error = options.lastError || null;
    pipelineState.completed_at = null;
    clearRuntimeState(sessionState);
    sessionState.last_exit_reason = options.exitReason || 'cancelled';
    sessionState.cancel_requested_at = cancelledAt;
    sessionState.pipeline_mode = true;
    appendHistoryEntry(sessionState, 'inactive', sessionState.current_ticket || undefined);
  }, options);
}
