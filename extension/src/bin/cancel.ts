#!/usr/bin/env node
import { deactivateSession, getStatePath, loadSessionState, resolveSessionForCwd } from '../services/session.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  reapOwnedOrphanProcessGroup,
  reapRecordedLiveProcessGroup,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';

function runtimePids(state: PersistedState): number[] {
  return [...new Set([
    Number(state?.active_child_pid),
  ].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}

function processAlive(pid: unknown): boolean {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function persistedChildIdentity(state: PersistedState, pid: number): PersistedProcessIdentity | null {
  const value = state.active_child_identity;
  if (!value || typeof value !== 'object') return null;
  const identity = value as Record<string, unknown>;
  if (
    Number(identity.pid) !== pid
    || !Number.isInteger(Number(identity.pgid))
    || typeof identity.start_time !== 'string'
    || !identity.start_time
    || typeof identity.fingerprint !== 'string'
    || !identity.fingerprint
  ) return null;
  return {
    pid,
    pgid: Number(identity.pgid),
    start_time: identity.start_time,
    fingerprint: identity.fingerprint,
  };
}

function hasLiveController(state: PersistedState): boolean {
  if (processAlive(state.active_child_controller_pid)) return true;
  return state.active === true && (
    processAlive(state.worker_pid) || processAlive(state.tmux_runner_pid)
  );
}

async function main(argv: string[]): Promise<void> {
  let cwd = process.cwd();
  let sessionDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--session-dir') {
      sessionDir = argv[index + 1];
      index += 1;
    }
  }

  const resolved = sessionDir || await resolveSessionForCwd(cwd, { last: true });
  if (!resolved) {
    console.log('No session to cancel.');
    return;
  }

  const stateBeforeCancel = loadSessionState(resolved);
  const pidsToSignal = runtimePids(stateBeforeCancel);
  const liveController = hasLiveController(stateBeforeCancel);
  const hasRecordedLiveChild = liveController && pidsToSignal.some((pid) => persistedChildIdentity(stateBeforeCancel, pid));
  if (hasRecordedLiveChild) {
    new StateManager().update(getStatePath(resolved), (current) => {
      current.active = false;
      current.last_exit_reason = 'cancelled';
      current.cancel_requested_at = new Date().toISOString();
      return current;
    });
  }
  const recoveries = pidsToSignal.map((pid) => {
    const identity = persistedChildIdentity(stateBeforeCancel, pid);
    return liveController && identity
      ? reapRecordedLiveProcessGroup(identity)
      : reapOwnedOrphanProcessGroup(resolved, pid);
  });
  const unsafeRecovery = recoveries.find((result) => result.status === 'ambiguous' || result.status === 'signal-failed');

  await deactivateSession(resolved, unsafeRecovery ? 'cancel_recovery_required' : 'cancelled', {
    preserveMapping: Boolean(unsafeRecovery),
  });
  if (unsafeRecovery) {
    new StateManager().update(getStatePath(resolved), (current) => {
      current.recovery_required = true;
      current.recovery_reason = unsafeRecovery.reason;
      current.orphan_child_pid = unsafeRecovery.pid;
      current.orphan_recovery = unsafeRecovery;
      return current;
    });
    console.log(`Cancellation blocked on recovery for ${resolved}: ${unsafeRecovery.reason}`);
    process.exitCode = 1;
    return;
  }
  cleanupTerminalTmuxSession(resolved);
  console.log(`Cancelled ${resolved}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
