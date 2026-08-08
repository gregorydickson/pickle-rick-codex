import path from 'node:path';
import { atomicWriteJson, nowIso } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import {
  killTmuxSessionById,
  readTmuxRunnerBinding,
  runnerPaneCommandMatches,
  type TmuxRunnerBinding,
} from './tmux.js';

export type TerminalTmuxCleanupStatus = 'cleaned' | 'missing' | 'preserved' | 'not-terminal' | 'quarantined';

export interface TerminalTmuxCleanupResult {
  status: TerminalTmuxCleanupStatus;
  sessionName: string | null;
  reason: string;
}

export interface TerminalTmuxCleanupOptions {
  stateManager?: StateManager;
  readBinding?: (target: string) => TmuxRunnerBinding | null;
  killSessionId?: (sessionId: string) => void;
  beforeRecheck?: () => void;
  now?: () => string;
}

function recordCleanup(
  state: Record<string, unknown>,
  statePath: string,
  status: TerminalTmuxCleanupStatus,
  reason: string,
  at: string,
): void {
  state.tmux_cleanup_status = status;
  state.tmux_cleanup_reason = reason;
  state.tmux_cleanup_at = at;
  atomicWriteJson(statePath, state);
}

function persistedBinding(value: unknown, sessionName: string, sessionDir: string): TmuxRunnerBinding | null {
  if (!value || typeof value !== 'object') return null;
  const binding = value as Partial<TmuxRunnerBinding>;
  if (binding.schema_version !== 1
      || binding.session_name !== sessionName
      || typeof binding.session_id !== 'string' || !/^\$\d+$/.test(binding.session_id)
      || typeof binding.session_created !== 'string' || binding.session_created.length === 0
      || typeof binding.pane_id !== 'string' || !/^%\d+$/.test(binding.pane_id)
      || !Number.isInteger(binding.pane_pid) || Number(binding.pane_pid) <= 0
      || typeof binding.pane_start_command !== 'string') return null;
  try {
    if (!runnerPaneCommandMatches(binding.pane_start_command, sessionDir)) return null;
  } catch {
    return null;
  }
  return binding as TmuxRunnerBinding;
}

function sameBinding(left: TmuxRunnerBinding, right: TmuxRunnerBinding | null): boolean {
  return right !== null
    && left.session_name === right.session_name
    && left.session_id === right.session_id
    && left.session_created === right.session_created
    && left.pane_id === right.pane_id
    && left.pane_pid === right.pane_pid
    && left.pane_start_command === right.pane_start_command;
}

function quarantine(
  state: Record<string, unknown>,
  statePath: string,
  sessionDir: string,
  sessionName: string,
  reason: string,
  at: string,
): TerminalTmuxCleanupResult {
  atomicWriteJson(path.join(sessionDir, 'tmux-quarantine.json'), {
    tmux_session_name: sessionName,
    session_dir: sessionDir,
    reason,
    quarantined_at: at,
    action: 'left-running',
  });
  recordCleanup(state, statePath, 'quarantined', reason, at);
  return { status: 'quarantined', sessionName, reason };
}

/**
 * Remove only the immutable tmux session/pane binding persisted by its launcher.
 * The recorded pane is inspected twice while the state lock is held. A name is
 * diagnostic metadata only; it is never used as a destructive target.
 */
export function cleanupTerminalTmuxSession(
  sessionDir: string,
  options: TerminalTmuxCleanupOptions = {},
): TerminalTmuxCleanupResult {
  const resolvedSessionDir = path.resolve(sessionDir);
  const statePath = path.join(resolvedSessionDir, 'state.json');
  const stateManager = options.stateManager || new StateManager();
  stateManager.acquireLock(statePath);
  try {
    const state = stateManager.read(statePath);
    const sessionName = typeof state.tmux_session_name === 'string' && state.tmux_session_name
      ? state.tmux_session_name
      : null;
    const at = (options.now || nowIso)();

    if (state.active === true) {
      return { status: 'not-terminal', sessionName, reason: 'runtime state is still active' };
    }
    if (state.preserve_tmux_monitor === true) {
      recordCleanup(state, statePath, 'preserved', 'monitor persistence was explicitly requested', at);
      return { status: 'preserved', sessionName, reason: 'monitor persistence was explicitly requested' };
    }
    if (!sessionName) {
      return { status: 'missing', sessionName: null, reason: 'runtime state has no tmux session name' };
    }

    const binding = persistedBinding(state.tmux_runner_binding, sessionName, resolvedSessionDir);
    if (!binding) {
      return quarantine(state, statePath, resolvedSessionDir, sessionName,
        'runtime state has no valid immutable tmux runner binding', at);
    }
    const inspect = options.readBinding || readTmuxRunnerBinding;
    const initial = inspect(binding.pane_id);
    if (initial === null) {
      recordCleanup(state, statePath, 'missing', 'recorded immutable tmux pane was already absent', at);
      return { status: 'missing', sessionName, reason: 'recorded immutable tmux pane was already absent' };
    }
    if (!sameBinding(binding, initial) || !runnerPaneCommandMatches(initial.pane_start_command, resolvedSessionDir)) {
      return quarantine(state, statePath, resolvedSessionDir, sessionName,
        'recorded immutable tmux runner binding did not match the live pane', at);
    }

    options.beforeRecheck?.();
    const recheck = inspect(binding.pane_id);
    if (!sameBinding(binding, recheck)
        || !recheck
        || !runnerPaneCommandMatches(recheck.pane_start_command, resolvedSessionDir)) {
      return quarantine(state, statePath, resolvedSessionDir, sessionName,
        'immutable tmux runner binding changed before cleanup', at);
    }

    recordCleanup(state, statePath, 'cleaned', 'terminal immutable tmux session cleanup requested', at);
    (options.killSessionId || killTmuxSessionById)(binding.session_id);
    return { status: 'cleaned', sessionName, reason: 'terminal immutable tmux session removed' };
  } finally {
    stateManager.releaseLock(statePath);
  }
}
