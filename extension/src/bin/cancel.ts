#!/usr/bin/env node
import { deactivateSession, getStatePath, loadSessionState, resolveSessionForCwd } from '../services/session.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  reapOwnedOrphanProcessGroup,
  isPersistedProcessIdentityValid,
  reapRecordedLiveProcessGroup,
  reapRecordedProcessGroupFromMember,
  inspectProcessLivenessIdentity,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import { recoverMonitoredProcessOwnership } from '../services/monitored-process-ownership.js';
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';
import { sessionOperationOwnerPid } from '../services/session-operation.js';
import fs from 'node:fs';
import path from 'node:path';
import { cancelLogicalPipelineByOperator, readLogicalPipeline } from '../services/durable-supervisor.js';

function runtimePids(state: PersistedState): number[] {
  const refinementPids = Array.isArray(state?.refinement_child_identities)
    ? state.refinement_child_identities.map((entry) => Number((entry as Record<string, unknown> | null)?.pid))
    : [];
  const monitoredPids = Array.isArray(state?.active_child_identities)
    ? state.active_child_identities.map((entry) => Number((entry as Record<string, unknown> | null)?.pid))
    : [];
  return [...new Set([
    Number(state?.active_child_pid),
    ...refinementPids,
    ...monitoredPids,
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
  const refinementIdentity = Array.isArray(state.refinement_child_identities)
    ? state.refinement_child_identities.find((entry) => Number((entry as Record<string, unknown> | null)?.pid) === pid)
    : null;
  const monitoredIdentity = Array.isArray(state.active_child_identities)
    ? state.active_child_identities.find((entry) => Number((entry as Record<string, unknown> | null)?.pid) === pid)
    : null;
  const value = monitoredIdentity || refinementIdentity || state.active_child_identity;
  if (!isPersistedProcessIdentityValid(value) || value.pid !== pid) return null;
  return value;
}

function hasLiveController(state: PersistedState): boolean {
  if (isPersistedProcessIdentityValid(state.active_child_controller_identity)
    && inspectProcessLivenessIdentity(state.active_child_controller_identity) === 'matched') return true;
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
  const liveController = hasLiveController(stateBeforeCancel) || Boolean(sessionOperationOwnerPid(resolved));
  const hasRecordedChild = pidsToSignal.some((pid) => persistedChildIdentity(stateBeforeCancel, pid));
  if (liveController || hasRecordedChild) {
    new StateManager().update(getStatePath(resolved), (current) => {
      current.active = false;
      current.last_exit_reason = 'cancelled';
      current.cancel_requested_at = new Date().toISOString();
      return current;
    });
  }
  let monitoredRecoveryError: Error | null = null;
  if (Array.isArray(stateBeforeCancel.active_child_identities)
    && stateBeforeCancel.active_child_identities.length > 0) {
    try {
      recoverMonitoredProcessOwnership(new StateManager(), getStatePath(resolved), { allowLiveController: true });
    } catch (error) {
      monitoredRecoveryError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const monitoredPids = new Set(Array.isArray(stateBeforeCancel.active_child_identities)
    ? stateBeforeCancel.active_child_identities.map((entry) => Number((entry as Record<string, unknown>)?.pid))
    : []);
  const recoveries = pidsToSignal.filter((pid) => !monitoredPids.has(pid)).map((pid) => {
    const identity = persistedChildIdentity(stateBeforeCancel, pid);
    return identity
      ? identity.pid === identity.pgid
        ? reapRecordedLiveProcessGroup(identity)
        : reapRecordedProcessGroupFromMember(identity)
      : reapOwnedOrphanProcessGroup(resolved, pid);
  });
  const unsafeRecovery = recoveries.find((result) => result.status === 'ambiguous' || result.status === 'signal-failed');
  const recoveryFailure = monitoredRecoveryError?.message || unsafeRecovery?.reason || null;

  await deactivateSession(resolved, recoveryFailure ? 'cancel_recovery_required' : 'cancelled', {
    preserveMapping: Boolean(recoveryFailure),
  });
  if (recoveryFailure) {
    new StateManager().update(getStatePath(resolved), (current) => {
      current.recovery_required = true;
      current.recovery_reason = recoveryFailure;
      current.orphan_child_pid = unsafeRecovery?.pid || current.active_child_pid;
      current.orphan_recovery = unsafeRecovery || { status: 'ambiguous', reason: recoveryFailure };
      return current;
    });
    console.log(`Cancellation blocked on recovery for ${resolved}: ${recoveryFailure}`);
    process.exitCode = 1;
    return;
  }
  const logicalPath = path.join(resolved, 'logical-pipeline.json');
  if (fs.existsSync(logicalPath) && readLogicalPipeline(resolved).terminal_state === null) {
    cancelLogicalPipelineByOperator(resolved, 'explicit pickle-cancel operator request');
  }
  cleanupTerminalTmuxSession(resolved);
  console.log(`Cancelled ${resolved}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
