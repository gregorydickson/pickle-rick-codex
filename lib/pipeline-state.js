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

const VERIFICATION_BASELINE_SCHEMA_VERSION = 1;

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

function tokenizeShellWords(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function packageManagerCommandCwd(tokens, cwd) {
  let commandCwd = cwd || process.cwd();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'test') break;
    if ((token === '-C' || token === '--dir' || token === '--cwd' || token === '--prefix') && tokens[index + 1]) {
      commandCwd = path.resolve(commandCwd, tokens[index + 1]);
      index += 1;
      continue;
    }
    const inlineMatch = token.match(/^(?:--dir|--cwd|--prefix)=(.+)$/);
    if (inlineMatch) {
      commandCwd = path.resolve(commandCwd, inlineMatch[1]);
    }
  }
  return commandCwd;
}

function extractPackageManagerTestTargets(tokens, cwd) {
  const packageManager = tokens[0];
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(packageManager)) {
    return [];
  }

  const testIndex = tokens.indexOf('test');
  const separatorIndex = tokens.indexOf('--');
  if (testIndex === -1 || separatorIndex === -1 || separatorIndex <= testIndex) {
    return [];
  }

  const commandCwd = packageManagerCommandCwd(tokens, cwd);
  const targets = [];
  for (let index = separatorIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === '&&' || token.startsWith('-')) continue;
    const comparableTarget = path.isAbsolute(token)
      ? normalizeComparablePath(token, cwd)
      : normalizeComparablePath(path.resolve(commandCwd, token), cwd);
    targets.push(comparableTarget);
  }
  return targets.filter(Boolean);
}

function normalizeComparablePath(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const absolute = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  const relative = path.relative(cwd || process.cwd(), absolute).replaceAll(path.sep, '/');
  if (!relative || relative === '') return absolute.replaceAll(path.sep, '/');
  if (!relative.startsWith('../')) return relative;
  return absolute.replaceAll(path.sep, '/');
}

function uniqueFailures(failures) {
  const seen = new Set();
  const unique = [];
  for (const failure of failures) {
    const identity = String(failure?.identity || '').trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    unique.push({
      identity,
      file: failure?.file || null,
      testName: failure?.testName || null,
      in_scope: failure?.in_scope === true,
      source: failure?.source || 'unknown',
    });
  }
  return unique;
}

function isPathWithinVerificationScope(filePath, scope) {
  if (!filePath || !Array.isArray(scope?.targets) || scope.targets.length === 0) {
    return false;
  }
  return scope.targets.some((target) => filePath === target || filePath.startsWith(`${target}/`));
}

function normalizeFailurePath(filePath, cwd, commandCwd = cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return null;
  }
  if (path.isAbsolute(filePath)) {
    return normalizeComparablePath(filePath, cwd);
  }
  return normalizeComparablePath(path.resolve(commandCwd || cwd || process.cwd(), filePath), cwd);
}

function parseNodeTestFailures(output, cwd, scope, commandCwd = cwd) {
  const lines = String(output || '').split(/\r?\n/);
  const failures = [];
  let inFailuresSection = false;
  let pendingFile = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inFailuresSection) {
      if (trimmed === '✖ failing tests:' || trimmed === 'failing tests:') {
        inFailuresSection = true;
      }
      continue;
    }

    if (!trimmed) {
      pendingFile = null;
      continue;
    }

    const fileMatch = trimmed.match(/^test at (.+?):\d+:\d+$/);
    if (fileMatch) {
      pendingFile = normalizeFailurePath(fileMatch[1], cwd, commandCwd);
      continue;
    }

    const nameMatch = trimmed.match(/^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/);
    if (pendingFile && nameMatch) {
      const testName = nameMatch[1].trim();
      failures.push({
        identity: `${pendingFile}::${testName}`,
        file: pendingFile,
        testName,
        in_scope: isPathWithinVerificationScope(pendingFile, scope),
        source: 'node-test',
      });
      pendingFile = null;
    }
  }

  return uniqueFailures(failures);
}

export function buildVerificationCommandScope(command, cwd = process.cwd()) {
  const normalizedCommand = String(command || '').trim();
  const tokens = tokenizeShellWords(normalizedCommand);
  const scope = {
    key: `command:${normalizedCommand}`,
    kind: 'command',
    command: normalizedCommand,
    targets: [],
  };

  if (tokens[0] !== 'node' || !tokens.includes('--test')) {
    const packageManagerTargets = extractPackageManagerTestTargets(tokens, cwd);
    if (packageManagerTargets.length === 0) {
      return scope;
    }
    return {
      key: `package-test:${packageManagerTargets.join('|')}`,
      kind: 'package-test',
      command: normalizedCommand,
      targets: packageManagerTargets,
    };
  }

  const testIndex = tokens.indexOf('--test');
  const targets = [];
  for (let index = testIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--test-name-pattern' || token === '--test-reporter' || token === '--test-reporter-destination') {
      index += 1;
      continue;
    }
    if (token.startsWith('--test-name-pattern=')
      || token.startsWith('--test-reporter=')
      || token.startsWith('--test-reporter-destination=')) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    targets.push(normalizeComparablePath(token, cwd));
  }

  if (targets.length === 0) {
    return scope;
  }

  return {
    key: `node-test:${targets.join('|')}`,
    kind: 'node-test',
    command: normalizedCommand,
    targets,
  };
}

export function buildVerificationFailureSet({
  command,
  cwd = process.cwd(),
  stdout = '',
  stderr = '',
  exitCode = 0,
}) {
  if (exitCode === 0) {
    return [];
  }
  const scope = buildVerificationCommandScope(command, cwd);
  const tokens = tokenizeShellWords(String(command || '').trim());
  const commandCwd = scope.kind === 'package-test'
    ? packageManagerCommandCwd(tokens, cwd)
    : cwd;
  const parsed = parseNodeTestFailures(`${stdout || ''}\n${stderr || ''}`, cwd, scope, commandCwd);
  if (parsed.length > 0) {
    return parsed;
  }
  return uniqueFailures([{
    identity: `command:${String(command || '').trim()}`,
    file: null,
    testName: null,
    in_scope: true,
    source: 'command-exit',
  }]);
}

function normalizeVerificationBaselineCommandMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const entries = {};
  for (const [scopeKey, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const command = typeof entry.command === 'string' && entry.command.trim()
      ? entry.command
      : typeof entry.scope?.command === 'string' && entry.scope.command.trim()
        ? entry.scope.command
        : String(scopeKey).replace(/^command:/, '');
    const normalizedScope = buildVerificationCommandScope(command);
    const failures = uniqueFailures(Array.isArray(entry.failures) ? entry.failures : []);
    const normalizedKey = normalizedScope.key;
    const normalizedEntry = {
      command: command || normalizedScope.command,
      scope: {
        key: normalizedKey,
        kind: typeof entry.scope?.kind === 'string' ? entry.scope.kind : normalizedScope.kind,
        command: command || normalizedScope.command,
        targets: Array.isArray(entry.scope?.targets) ? entry.scope.targets.filter(Boolean) : normalizedScope.targets,
      },
      failures,
    };
    if (!entries[normalizedKey] || scopeKey === normalizedKey) {
      entries[normalizedKey] = normalizedEntry;
    }
  }
  return entries;
}

function normalizeVerificationBaselines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      schema_version: VERIFICATION_BASELINE_SCHEMA_VERSION,
      captured_at: null,
      by_ticket: {},
    };
  }

  const byTicket = {};
  for (const [ticketId, ticketBaselines] of Object.entries(value.by_ticket || {})) {
    byTicket[ticketId] = normalizeVerificationBaselineCommandMap(ticketBaselines);
  }

  return {
    schema_version: Number.isInteger(value.schema_version)
      ? value.schema_version
      : VERIFICATION_BASELINE_SCHEMA_VERSION,
    captured_at: value.captured_at || null,
    by_ticket: byTicket,
  };
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
    verification_baselines: normalizeVerificationBaselines(null),
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
    verification_baselines: normalizeVerificationBaselines(pipelineState.verification_baselines),
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
    const exitReason = options.exitReason || 'success';
    pipelineState.phase_statuses[phase] = exitReason === 'success'
      ? PHASE_STATUS_DONE
      : PHASE_STATUS_FAILED;
    pipelineState.last_exit_reason = exitReason;
    pipelineState.last_error = options.lastError || null;
    const nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
    pipelineState.current_phase = nextPhase;
    pipelineState.current_phase_index = nextPhase == null ? null : phaseIndex(pipeline.phases, nextPhase);
    pipelineState.phase_started_at = null;
    if (nextPhase == null && exitReason === 'success') {
      pipelineState.completed_at = options.completedAt || nowIso();
    }
    clearRuntimeState(sessionState);
    sessionState.last_exit_reason = exitReason;
    sessionState.pipeline_mode = true;
    if (exitReason === 'success') {
      sessionState.current_ticket = null;
      sessionState.step = nextPhase ?? 'complete';
    } else if (isBlockedExitReason(exitReason)) {
      sessionState.current_ticket = options.failedTicketId || sessionState.current_ticket || null;
      sessionState.step = 'blocked';
    } else {
      sessionState.current_ticket = exitReason === 'error'
        ? options.failedTicketId || sessionState.current_ticket || null
        : null;
      sessionState.step = 'paused';
    }
    appendHistoryEntry(
      sessionState,
      exitReason === 'success' ? 'pipeline_phase_done' : 'pipeline_phase_failed',
      sessionState.current_ticket || undefined,
    );
    if (nextPhase == null && exitReason === 'success') {
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

export function readVerificationBaselines(sessionDir, stateManager = new StateManager(), pipeline = readPipelineContract(sessionDir)) {
  const pipelineState = readPipelineState(sessionDir, stateManager, pipeline);
  return normalizeVerificationBaselines(pipelineState.verification_baselines);
}

export function writeVerificationBaselines(sessionDir, verificationBaselines, options = {}) {
  return transitionPipelineState(sessionDir, (pipelineState) => {
    pipelineState.verification_baselines = normalizeVerificationBaselines(verificationBaselines);
  }, options).pipelineState.verification_baselines;
}

export function readTicketVerificationBaseline(sessionDir, ticketId, command, options = {}) {
  const baselines = readVerificationBaselines(
    sessionDir,
    options.stateManager || new StateManager(),
    options.pipeline,
  );
  const scope = buildVerificationCommandScope(command, options.cwd || process.cwd());
  return baselines.by_ticket?.[ticketId]?.[scope.key] || null;
}
