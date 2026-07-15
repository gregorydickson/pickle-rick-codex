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
import { cancelPipelineSession, isPipelineSession } from './pipeline-state.js';
import {
  findLastSessionForCwd,
  getSessionForCwd,
  pruneSessionMap,
  removeSessionMapEntry,
  updateSessionMap,
} from './session-map.js';
import { StateManager } from './state-manager.js';
import type { PersistedState } from './state-manager.js';
import type { Config } from '../types/index.js';

export interface SessionResult {
  sessionDir: string;
  state: PersistedState;
}

interface CreateInitialStateArgs {
  cwd: string;
  prompt: string;
  sessionDir: string;
  config?: Config;
  overrides?: Record<string, unknown>;
}

interface CreateSessionArgs {
  cwd?: string;
  prompt: string;
  overrides?: Record<string, unknown>;
  updateMap?: boolean;
}

interface ResolveSessionForCwdOptions {
  last?: boolean;
}

export function getStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'state.json');
}

export function createInitialState({
  cwd,
  prompt,
  sessionDir,
  config = loadConfig(),
  overrides = {},
}: CreateInitialStateArgs): PersistedState {
  const now = new Date();
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const state: PersistedState = {
    active: true,
    working_dir: cwd,
    step: 'prd',
    iteration: 0,
    max_iterations: config.defaults.max_iterations,
    max_time_minutes: config.defaults.max_time_minutes,
    worker_timeout_seconds: config.defaults.worker_timeout_seconds,
    start_time_epoch: epochSeconds,
    original_prompt: prompt,
    current_ticket: null,
    history: [],
    started_at: now.toISOString(),
    run_start_time_epoch: epochSeconds,
    run_started_at: now.toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    tmux_mode: false,
    command_template: null,
    session_map_cwds: [cwd],
    pipeline_mode: false,
    pipeline_phase: null,
    pipeline_total_phases: null,
    pipeline_phase_index: null,
    pipeline_working_dir: null,
    pipeline_target: null,
    pipeline_bootstrap_source: null,
    pipeline_bootstrap_prd: null,
    pipeline_task: null,
    pipeline_phases: null,
    pipeline_skip_flags: null,
    ...overrides,
  };
  if (state.active === false) {
    state.run_start_time_epoch = null;
    state.run_started_at = null;
  }
  return state;
}

export async function createSession({
  cwd = process.cwd(),
  prompt,
  overrides = {},
  updateMap = true,
}: CreateSessionArgs): Promise<SessionResult> {
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
  if (updateMap) {
    await updateSessionMap(cwd, sessionDir);
  }
  await pruneSessionMap();
  logActivity({
    event: 'session_start',
    source: 'pickle',
    session: sessionId,
    original_prompt: prompt,
  }, { enabled: config.defaults.activity_logging });

  return { sessionDir, state };
}

export function loadSessionState(sessionDir: string, stateManager: StateManager = new StateManager()): PersistedState {
  return stateManager.read(getStatePath(sessionDir));
}

export function readOrInitSessionState(
  sessionDir: string,
  createDefault: () => PersistedState,
  stateManager: StateManager = new StateManager(),
): PersistedState {
  return stateManager.readOrReinitialize(getStatePath(sessionDir), createDefault);
}

export function appendHistory(state: PersistedState, step: string, ticket?: unknown): void {
  state.history ??= [];
  (state.history as unknown[]).push({
    step,
    ticket,
    timestamp: nowIso(),
  });
}

export function getRunStartEpoch(state: PersistedState): number {
  const preciseIso = state.run_started_at || (
    state.active === false && state.last_exit_reason == null
      ? null
      : state.started_at
  );
  if (typeof preciseIso === 'string') {
    const parsed = Date.parse(preciseIso);
    if (Number.isFinite(parsed)) {
      return parsed / 1000;
    }
  }
  if (state.run_start_time_epoch != null) {
    return Number(state.run_start_time_epoch || 0);
  }
  if (state.active === false && state.last_exit_reason == null) {
    return 0;
  }
  return Number(state.start_time_epoch || 0);
}

export function markRunStart(state: PersistedState, now: Date = new Date()): PersistedState {
  state.run_start_time_epoch = Math.floor(now.getTime() / 1000);
  state.run_started_at = now.toISOString();
  return state;
}

export function normalizeSessionCwd(cwd: string): string {
  if (typeof cwd !== 'string' || !cwd) {
    return cwd;
  }
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function getSessionMapCwds(state: PersistedState): string[] {
  const values: string[] = [];
  const pushUnique = (value: unknown): void => {
    if (typeof value !== 'string' || !value) {
      return;
    }
    if (!values.includes(value)) {
      values.push(value);
    }
  };

  if (Array.isArray(state?.session_map_cwds)) {
    state.session_map_cwds.forEach(pushUnique);
  }
  pushUnique(state?.working_dir);
  return values;
}

export async function resolveSessionForCwd(cwd: string, options: ResolveSessionForCwdOptions = {}): Promise<string | null> {
  const normalizedCwd = normalizeSessionCwd(cwd);
  const direct = getSessionForCwd(normalizedCwd);
  if (direct) return direct;
  if (options.last) {
    const sessionDir = findLastSessionForCwd(normalizedCwd);
    if (sessionDir) {
      await updateSessionMap(normalizedCwd, sessionDir);
      return sessionDir;
    }
  }
  return null;
}

export async function deactivateSession(sessionDir: string, reason: string = 'cancelled'): Promise<PersistedState> {
  const state = isPipelineSession(sessionDir)
    ? cancelPipelineSession(sessionDir, { exitReason: reason }).state
    : new StateManager().update(
      getStatePath(sessionDir),
      (current) => {
        current.active = false;
        current.last_exit_reason = reason;
        current.cancel_requested_at = reason === 'cancelled' ? nowIso() : current.cancel_requested_at || null;
        appendHistory(current, 'inactive', current.current_ticket || undefined);
        return current;
      },
    );
  for (const cwd of getSessionMapCwds(state)) {
    await removeSessionMapEntry(cwd, sessionDir);
  }
  return state;
}

export function writeSessionFile(sessionDir: string, fileName: string, content: string): string {
  ensureDir(sessionDir);
  fs.writeFileSync(path.join(sessionDir, fileName), content);
  return path.join(sessionDir, fileName);
}
