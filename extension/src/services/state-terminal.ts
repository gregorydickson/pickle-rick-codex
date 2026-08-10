import { StateManager, type PersistedState } from './state-manager.js';

export interface TerminalFinalizeOptions {
  exitReason: string;
  deferExitReason?: boolean;
}

export function safeDeactivate(state: PersistedState): PersistedState {
  state.active = false;
  state.tmux_runner_pid = null;
  state.worker_pid = null;
  const monitoredLedgerPresent = (Array.isArray(state.active_child_identities)
    && state.active_child_identities.length > 0)
    || (Array.isArray(state.refinement_child_identities)
      && state.refinement_child_identities.length > 0);
  if (monitoredLedgerPresent) {
    state.recovery_required = true;
    state.recovery_kind = state.recovery_kind || 'monitored_process_ownership';
    state.recovery_reason = state.recovery_reason
      || 'Terminal finalization retained an undrained monitored process ledger.';
    state.orphan_child_pid = state.active_child_pid;
    return state;
  }
  state.active_child_pid = null;
  state.active_child_kind = null;
  state.active_child_command = null;
  state.active_child_identity = null;
  state.active_child_controller_pid = null;
  state.active_child_controller_identity = null;
  return state;
}

export function recordExitReason(state: PersistedState, requestedReason: string): string {
  const existing = typeof state.last_exit_reason === 'string' && state.last_exit_reason
    ? state.last_exit_reason
    : null;
  // Never let a late success overwrite abnormal evidence, and preserve an
  // explicit reason already written by cancellation/another terminal actor.
  const preserveExisting = existing !== null
    && existing !== 'success'
    && (state.active === false || requestedReason === 'success');
  const finalReason = preserveExisting ? existing : requestedReason;
  state.last_exit_reason = finalReason;
  return finalReason;
}

export function finalizeTerminalStateObject(
  state: PersistedState,
  options: TerminalFinalizeOptions,
): string {
  const previousReason = state.last_exit_reason;
  const finalReason = recordExitReason(state, options.exitReason);
  if (options.deferExitReason) state.last_exit_reason = previousReason;
  safeDeactivate(state);
  return finalReason;
}

export function finalizeTerminalState(
  manager: StateManager,
  statePath: string,
  options: TerminalFinalizeOptions,
): { state: PersistedState; exitReason: string } {
  let exitReason = options.exitReason;
  const state = manager.update(statePath, (current) => {
    exitReason = finalizeTerminalStateObject(current, options);
    return current;
  });
  return { state, exitReason };
}
