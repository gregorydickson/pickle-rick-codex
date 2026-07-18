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
import { getHeadSha, isGitRepo } from './git-utils.js';
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
import { tmuxSessionExists } from './tmux.js';
import { reapOwnedOrphanProcessGroup } from './orphan-reaper.js';

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
    start_commit: isGitRepo(cwd) ? getHeadSha(cwd) : null,
    pinned_sha: isGitRepo(cwd) ? getHeadSha(cwd) : null,
    quality_baseline: null,
    manager_relaunch_count: 0,
    manager_relaunch_history: [],
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

function isProcessAlive(pid: unknown): boolean {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileSessionLiveness(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
): { state: PersistedState; stale: boolean } {
  const statePath = getStatePath(sessionDir);
  const state = stateManager.read(statePath);
  if (state.active !== true) return { state, stale: false };

  const tmuxName = typeof state.tmux_session_name === 'string' ? state.tmux_session_name : '';
  const runnerMissing = state.tmux_mode === true && (
    !isProcessAlive(state.tmux_runner_pid)
    || (tmuxName !== '' && !tmuxSessionExists(tmuxName))
  );
  const maxMinutes = Number(state.max_time_minutes || 0);
  const startedMs = getRunStartEpoch(state) * 1000;
  const expired = maxMinutes > 0 && startedMs > 0 && nowMs - startedMs >= maxMinutes * 60_000;
  if (!runnerMissing && !expired) return { state, stale: false };

  const reason = runnerMissing ? 'runner_lost' : 'max_time';
  let orphanChildPid = isProcessAlive(state.active_child_pid) ? Number(state.active_child_pid) : null;
  const orphanRecovery = orphanChildPid
    ? reapOwnedOrphanProcessGroup(sessionDir, orphanChildPid)
    : null;
  if (orphanRecovery?.status === 'reaped' || orphanRecovery?.status === 'not-running') {
    orphanChildPid = null;
  }
  const reconciled = stateManager.update(statePath, (current) => {
    if (current.active !== true) return current;
    current.active = false;
    current.tmux_runner_pid = null;
    current.worker_pid = null;
    current.active_child_pid = orphanChildPid;
    current.orphan_child_pid = orphanChildPid;
    current.orphan_recovery = orphanRecovery;
    if (!orphanChildPid) {
      current.active_child_kind = null;
      current.active_child_command = null;
    }
    current.last_exit_reason = orphanChildPid ? `${reason}_orphaned_child` : reason;
    current.step = current.step === 'complete' ? current.step : (orphanChildPid ? 'blocked' : 'paused');
    if (orphanChildPid) {
      current.recovery_required = true;
      current.recovery_reason = `runner disappeared while child pid ${orphanChildPid} remained unsafe to reap: ${orphanRecovery?.reason || 'ownership unknown'}`;
    } else {
      current.recovery_required = false;
      current.recovery_reason = null;
    }
    appendHistory(current, String(current.last_exit_reason), current.current_ticket || undefined);
    return current;
  });
  // A live orphan must remain mapped and discoverable. Returning stale=false keeps
  // resolveSessionForCwd from pruning the only recovery handle; cancel/status can
  // then surface the blocked session instead of silently abandoning a mutator.
  return { state: reconciled, stale: orphanChildPid === null };
}

export function reconcileAllSessionLiveness(): Array<{ sessionDir: string; reason: string; state: PersistedState }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  const reconciled: Array<{ sessionDir: string; reason: string; state: PersistedState }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(getSessionsRoot(), entry.name);
    if (!fs.existsSync(getStatePath(sessionDir))) continue;
    try {
      const result = reconcileSessionLiveness(sessionDir);
      if (result.stale) {
        reconciled.push({ sessionDir, reason: String(result.state.last_exit_reason || 'inactive'), state: result.state });
      }
    } catch {
      // A corrupt session must not prevent reconciliation of the remaining sessions.
    }
  }
  return reconciled;
}

export async function resolveSessionForCwd(cwd: string, options: ResolveSessionForCwdOptions = {}): Promise<string | null> {
  const normalizedCwd = normalizeSessionCwd(cwd);
  const direct = getSessionForCwd(normalizedCwd);
  if (direct) {
    const reconciled = reconcileSessionLiveness(direct);
    if (!reconciled.stale || options.last) return direct;
    await removeSessionMapEntry(normalizedCwd, direct);
  }
  if (options.last) {
    const sessionDir = findLastSessionForCwd(normalizedCwd);
    if (sessionDir) {
      await updateSessionMap(normalizedCwd, sessionDir);
      return sessionDir;
    }
  }
  return null;
}

export async function deactivateSession(
  sessionDir: string,
  reason: string = 'cancelled',
  options: { preserveMapping?: boolean } = {},
): Promise<PersistedState> {
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
  if (!options.preserveMapping) {
    for (const cwd of getSessionMapCwds(state)) {
      await removeSessionMapEntry(cwd, sessionDir);
    }
  }
  return state;
}

export function writeSessionFile(sessionDir: string, fileName: string, content: string): string {
  ensureDir(sessionDir);
  fs.writeFileSync(path.join(sessionDir, fileName), content);
  return path.join(sessionDir, fileName);
}
