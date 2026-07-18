import path from 'node:path';
import { atomicWriteJson, nowIso } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import { clearTmuxSession, isForeignTmuxSession } from './tmux.js';

export type TerminalTmuxCleanupStatus = 'cleaned' | 'missing' | 'preserved' | 'not-terminal' | 'quarantined';

export interface TerminalTmuxCleanupResult {
  status: TerminalTmuxCleanupStatus;
  sessionName: string | null;
  reason: string;
}

export interface TerminalTmuxCleanupOptions {
  stateManager?: StateManager;
  clearSession?: (sessionName: string, sessionDir: string) => boolean;
  now?: () => string;
}

function recordCleanup(
  stateManager: StateManager,
  statePath: string,
  status: TerminalTmuxCleanupStatus,
  reason: string,
  at: string,
): void {
  stateManager.update(statePath, (current) => {
    current.tmux_cleanup_status = status;
    current.tmux_cleanup_reason = reason;
    current.tmux_cleanup_at = at;
    return current;
  });
}

/**
 * Remove the exact tmux session recorded by a terminal runtime state. Ownership
 * must still match the session-dir hash. Anything ambiguous is reported inside
 * the session directory and deliberately left running for manual inspection.
 */
export function cleanupTerminalTmuxSession(
  sessionDir: string,
  options: TerminalTmuxCleanupOptions = {},
): TerminalTmuxCleanupResult {
  const resolvedSessionDir = path.resolve(sessionDir);
  const statePath = path.join(resolvedSessionDir, 'state.json');
  const stateManager = options.stateManager || new StateManager();
  const state = stateManager.read(statePath);
  const sessionName = typeof state.tmux_session_name === 'string' && state.tmux_session_name
    ? state.tmux_session_name
    : null;
  const at = (options.now || nowIso)();

  if (state.active === true) {
    return { status: 'not-terminal', sessionName, reason: 'runtime state is still active' };
  }
  if (state.preserve_tmux_monitor === true) {
    recordCleanup(stateManager, statePath, 'preserved', 'monitor persistence was explicitly requested', at);
    return { status: 'preserved', sessionName, reason: 'monitor persistence was explicitly requested' };
  }
  if (!sessionName) {
    return { status: 'missing', sessionName: null, reason: 'runtime state has no tmux session name' };
  }
  if (isForeignTmuxSession(sessionName, resolvedSessionDir)) {
    const reason = 'recorded tmux name does not prove ownership of this session directory';
    atomicWriteJson(path.join(resolvedSessionDir, 'tmux-quarantine.json'), {
      tmux_session_name: sessionName,
      session_dir: resolvedSessionDir,
      reason,
      quarantined_at: at,
      action: 'left-running',
    });
    recordCleanup(stateManager, statePath, 'quarantined', reason, at);
    return { status: 'quarantined', sessionName, reason };
  }

  // Persist intent before killing: this command commonly runs inside the tmux
  // session it owns, so successful cleanup can terminate this process promptly.
  recordCleanup(stateManager, statePath, 'cleaned', 'terminal owned tmux session cleanup requested', at);
  const removed = (options.clearSession || clearTmuxSession)(sessionName, resolvedSessionDir);
  return {
    status: removed ? 'cleaned' : 'missing',
    sessionName,
    reason: removed ? 'terminal owned tmux session removed' : 'owned tmux session was already absent',
  };
}
