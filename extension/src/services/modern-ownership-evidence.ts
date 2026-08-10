import type { PersistedState } from './state-manager.js';

const DURABLE_MODERN_AUTHORITY_FIELDS = [
  'active_child_controller_identity', 'autonomous_supervisor_identity', 'autonomous_supervisor_ready_receipt',
  'autonomous_owner_spec', 'autonomous_owner_restoration', 'autonomous_owner_handoff_transaction',
  'autonomous_owner_recovery_daemon_identity', 'cancellation_recovery_watchdog_identity',
  'cancellation_recovery_watchdog_arm',
  'cancellation_recovery_runtime_binding', 'cancellation_recovery',
  'orphan_recovery', 'artifact_contract_recovery',
  'autonomous_budget_rollover_checkpoint_pending', 'autonomous_budget_consumed_checkpoint_pending',
] as const;

const ZEROABLE_AUTHORITY_FIELDS = [
  'active_child_controller_pid', 'autonomous_supervisor_pid',
  'autonomous_owner_recovery_daemon_pid', 'cancellation_recovery_watchdog_pid',
  'manager_relaunch_recovery_epoch',
] as const;

const EMPTY_STRING_AUTHORITY_FIELDS = [
  'cancellation_recovery_watchdog_arm_id', 'recovery_kind', 'recovery_reason',
  'autonomous_owner_recovery_suspended_for_handoff', 'cancel_requested_at',
  'manager_relaunch_recovery_route', 'manager_relaunch_recovery_status',
  'manager_relaunch_recovery_activated_at', 'manager_relaunch_recovery_consumed_at',
  'autonomous_budget_rollover_intent_id', 'autonomous_budget_consumed_intent_id',
  'autonomous_budget_checkpoint_error', 'legacy_adoption_supervisor_challenge',
] as const;

function nullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function emptyOptionalLedger(value: unknown): boolean {
  return nullish(value) || (Array.isArray(value) && value.length === 0);
}

function falseOrAbsent(value: unknown): boolean {
  return nullish(value) || value === false;
}

function zeroOrAbsent(value: unknown): boolean {
  return nullish(value) || value === 0;
}

function emptyStringOrAbsent(value: unknown): boolean {
  return nullish(value) || value === '';
}

/**
 * Detects durable modern ownership, recovery, or cancellation evidence that a
 * legacy transition has no authority to discard or reinterpret. Malformed
 * values are evidence too: only the exact legacy-empty representations pass.
 */
export function modernOwnershipEvidence(state: PersistedState): string[] {
  const evidence: string[] = DURABLE_MODERN_AUTHORITY_FIELDS
    .filter((field) => !nullish(state[field]));
  evidence.push(...ZEROABLE_AUTHORITY_FIELDS.filter((field) => !zeroOrAbsent(state[field])));
  evidence.push(...EMPTY_STRING_AUTHORITY_FIELDS.filter((field) => !emptyStringOrAbsent(state[field])));
  if (!emptyOptionalLedger(state.active_child_identities)) evidence.push('active_child_identities');
  if (!emptyOptionalLedger(state.refinement_child_identities)) evidence.push('refinement_child_identities');
  if (!falseOrAbsent(state.recovery_required)) evidence.push('recovery_required');
  if (!falseOrAbsent(state.autonomous_owner_recovery_suspended)) {
    evidence.push('autonomous_owner_recovery_suspended');
  }
  if (!falseOrAbsent(state.cancelled)) evidence.push('cancelled');
  if (!nullish(state.orphan_child_pid) && state.orphan_child_pid !== 0) evidence.push('orphan_child_pid');
  if (state.last_exit_reason === 'cancelled') evidence.push('last_exit_reason');
  return evidence;
}

export function assertNoModernOwnershipEvidence(state: PersistedState, message: string): void {
  const evidence = modernOwnershipEvidence(state);
  if (evidence.length > 0) throw new Error(`${message} Evidence: ${evidence.join(', ')}.`);
}
