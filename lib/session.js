import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigFile, loadConfig } from './config.js';
import { logActivity } from './activity-logger.js';
import {
  atomicWriteJson,
  ensureDir,
  getSessionsRoot,
  nowIso,
} from './pickle-utils.js';
import {
  findLastSessionForCwd,
  getSessionForCwd,
  pruneSessionMap,
  removeSessionMapEntry,
  updateSessionMap,
} from './session-map.js';
import { StateManager } from './state-manager.js';

export function getStatePath(sessionDir) {
  return path.join(sessionDir, 'state.json');
}

export function createInitialState({
  cwd,
  prompt,
  sessionDir,
  config = loadConfig(),
  overrides = {},
}) {
  const now = new Date();
  return {
    active: true,
    working_dir: cwd,
    step: 'prd',
    iteration: 0,
    max_iterations: config.defaults.max_iterations,
    max_time_minutes: config.defaults.max_time_minutes,
    worker_timeout_seconds: config.defaults.worker_timeout_seconds,
    start_time_epoch: Math.floor(now.getTime() / 1000),
    original_prompt: prompt,
    current_ticket: null,
    history: [],
    started_at: now.toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    tmux_mode: false,
    command_template: null,
    ...overrides,
  };
}

export async function createSession({
  cwd = process.cwd(),
  prompt,
  overrides = {},
}) {
  ensureConfigFile();
  const config = loadConfig();
  const sessionId = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
  const sessionDir = path.join(getSessionsRoot(), sessionId);
  ensureDir(sessionDir);

  const state = createInitialState({
    cwd,
    prompt,
    sessionDir,
    config,
    overrides,
  });

  atomicWriteJson(getStatePath(sessionDir), state);
  await updateSessionMap(cwd, sessionDir);
  await pruneSessionMap();
  logActivity({
    event: 'session_start',
    source: 'pickle',
    session: sessionId,
    original_prompt: prompt,
  }, { enabled: config.defaults.activity_logging });

  return { sessionDir, state };
}

export function loadSessionState(sessionDir, stateManager = new StateManager()) {
  return stateManager.read(getStatePath(sessionDir));
}

export function readOrInitSessionState(sessionDir, createDefault, stateManager = new StateManager()) {
  return stateManager.readOrReinitialize(getStatePath(sessionDir), createDefault);
}

export function appendHistory(state, step, ticket) {
  state.history ??= [];
  state.history.push({
    step,
    ticket,
    timestamp: nowIso(),
  });
}

export async function resolveSessionForCwd(cwd, options = {}) {
  const direct = getSessionForCwd(cwd);
  if (direct) return direct;
  if (options.last) {
    const sessionDir = findLastSessionForCwd(cwd);
    if (sessionDir) {
      await updateSessionMap(cwd, sessionDir);
      return sessionDir;
    }
  }
  return null;
}

export async function deactivateSession(sessionDir, reason = 'cancelled') {
  const manager = new StateManager();
  const statePath = getStatePath(sessionDir);
  const state = manager.update(
    statePath,
    (current) => {
      current.active = false;
      current.last_exit_reason = reason;
      appendHistory(current, 'inactive', current.current_ticket || undefined);
      return current;
    },
  );
  await removeSessionMapEntry(state.working_dir);
  return state;
}

export function writeSessionFile(sessionDir, fileName, content) {
  ensureDir(sessionDir);
  fs.writeFileSync(path.join(sessionDir, fileName), content);
  return path.join(sessionDir, fileName);
}
