import crypto from 'node:crypto';
import { appendHistory, markRunStart } from './session.js';
import type { PersistedState, StateManager } from './state-manager.js';
import { inspectProcessLivenessIdentity, type PersistedProcessIdentity } from './orphan-reaper.js';

export const AUTONOMOUS_BUDGET_ROLLOVER_REASON = 'autonomous_budget_rollover';
export const AUTONOMOUS_BUDGET_ROLLOVER_MAX_DELAY_MS = 30_000;
export const AUTONOMOUS_BUDGET_ROLLOVER_GRACE_MS = 60_000;

export type AutonomousBudgetReason = 'max_time' | 'max_iterations';

export interface AutonomousBudgetRolloverOptions {
  assertDurableOwnership?: () => void;
  recordDurableCheckpoint?: (checkpoint: Record<string, unknown>) => void;
  ticketId?: string | null;
  nowMs?: number;
  repairMissingIntent?: boolean;
  assertRepairState?: (state: PersistedState) => void;
}

interface AuthenticatedLegacyMaxTimeRolloverOptions extends AutonomousBudgetRolloverOptions {
  legacyInactiveMaxTimeMigration: {
    migrationId: string;
    sourceStateSha256: string;
    sourceHistoryLength: number;
    prdSealHash: string;
    startCommit: string;
    pinnedSha: string | null;
    sourceOwnerSpecId: string;
    targetOwnerSpecId: string;
    targetOwnerSpec: Record<string, unknown>;
    targetRuntimeRoot: string;
    targetRuntime: Record<string, unknown>;
  };
}

export interface AutonomousBudgetRollover {
  intentId: string;
  epoch: number;
  delayMs: number;
  wakeupAt: string;
  deadlineAt: string;
  checkpointRecorded: boolean;
}

interface DurableBudgetCheckpoint extends Record<string, unknown> {
  kind: string;
  receipt_id: string;
  intent_id: string;
  epoch: number;
}

function checkpointMatches(value: unknown, expected: DurableBudgetCheckpoint): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.receipt_id === expected.receipt_id
    && candidate.intent_id === expected.intent_id
    && candidate.epoch === expected.epoch
    && candidate.kind === expected.kind;
}

function validPersistedIdentity(value: unknown): value is PersistedProcessIdentity {
  const identity = value as PersistedProcessIdentity | null;
  return Boolean(identity && Number.isInteger(identity.pid) && identity.pid > 0
    && Number.isInteger(identity.pgid) && identity.pgid > 0
    && typeof identity.start_time === 'string' && identity.start_time
    && typeof identity.fingerprint === 'string' && identity.fingerprint);
}

function repairHasUnsafeActiveChild(state: PersistedState): boolean {
  const pid = Number(state.active_child_pid || 0);
  const identity = state.active_child_identity;
  if (validPersistedIdentity(identity)) {
    if (identity.pid !== pid || inspectProcessLivenessIdentity(identity) !== 'not-running') return true;
  } else if (identity) {
    return true;
  } else if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch { /* exact legacy pid is no longer live */ }
  }
  state.active_child_pid = null;
  state.active_child_kind = null;
  state.active_child_command = null;
  state.active_child_identity = null;
  state.active_child_controller_pid = null;
  return false;
}

function emitPendingCheckpoint(
  manager: StateManager,
  statePath: string,
  field: string,
  checkpoint: DurableBudgetCheckpoint,
  recordDurableCheckpoint: (checkpoint: Record<string, unknown>) => void,
): void {
  try {
    recordDurableCheckpoint(checkpoint);
  } catch (error) {
    manager.update(statePath, (current) => {
      if (checkpointMatches(current[field], checkpoint)) {
        current.autonomous_budget_checkpoint_error = error instanceof Error ? error.message : String(error);
      }
      return current;
    });
    throw error;
  }
  manager.update(statePath, (current) => {
    if (checkpointMatches(current[field], checkpoint)) {
      current[field] = null;
      current.autonomous_budget_checkpoint_error = null;
    }
    return current;
  });
}

function scheduleAutonomousBudgetRolloverInternal(
  manager: StateManager,
  statePath: string,
  reason: AutonomousBudgetReason,
  options: AutonomousBudgetRolloverOptions | AuthenticatedLegacyMaxTimeRolloverOptions = {},
): AutonomousBudgetRollover | null {
  options.assertDurableOwnership?.();
  const nowMs = options.nowMs ?? Date.now();
  const intentId = crypto.randomUUID();
  const scheduled: { rollover: AutonomousBudgetRollover | null; checkpoint: DurableBudgetCheckpoint | null } = {
    rollover: null,
    checkpoint: null,
  };
  manager.update(statePath, (current: PersistedState) => {
    // Cancellation is authoritative even if it races the caller's threshold read.
    const legacyMigration = 'legacyInactiveMaxTimeMigration' in options
      ? options.legacyInactiveMaxTimeMigration : null;
    if ((current.active !== true && !legacyMigration) || current.cancel_requested_at
      || current.cancelled === true || current.last_exit_reason === 'cancelled') return current;
    if (legacyMigration) {
      const history = Array.isArray(current.history) ? current.history : [];
      if (reason !== 'max_time' || current.active !== false || current.step !== 'paused'
        || current.last_exit_reason !== 'max_time' || current.completed_at
        || current.recovery_required === true || Number(current.orphan_child_pid || 0) > 0
        || Number(current.active_child_pid || 0) > 0
        || current.legacy_max_time_migration
        || history.length !== legacyMigration.sourceHistoryLength
        || (history.at(-1) as Record<string, unknown> | undefined)?.step !== 'max_time'
        || crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex')
          !== legacyMigration.sourceStateSha256
        || (current.autonomous_owner_spec as Record<string, unknown> | null)?.spec_id
          !== legacyMigration.sourceOwnerSpecId
        || legacyMigration.targetOwnerSpec.spec_id !== legacyMigration.targetOwnerSpecId
        || legacyMigration.targetOwnerSpec.session_dir !== current.session_dir
        || legacyMigration.targetOwnerSpec.working_dir !== current.working_dir
        || legacyMigration.targetOwnerSpec.runner_bin
          !== (current.autonomous_owner_spec as Record<string, unknown> | null)?.runner_bin) {
        throw new Error('Legacy max_time migration authority does not match the exact inactive source state.');
      }
    }
    const existingIntent = typeof current.autonomous_budget_rollover_intent_id === 'string'
      ? current.autonomous_budget_rollover_intent_id : '';
    if (existingIntent || (current.last_exit_reason === AUTONOMOUS_BUDGET_ROLLOVER_REASON
      && options.repairMissingIntent !== true)) {
      throw new Error('Cannot schedule a second autonomous budget rollover before consuming the current intent.');
    }
    const priorEpoch = Number(current.autonomous_budget_epoch || 0);
    if (!Number.isInteger(priorEpoch) || priorEpoch < 0) {
      throw new Error('Cannot repair an autonomous budget rollover with a corrupt epoch.');
    }
    if (options.repairMissingIntent === true) {
      options.assertRepairState?.(current);
      const restoration = current.autonomous_owner_restoration as { status?: unknown } | null;
      if (current.recovery_required === true || Number(current.orphan_child_pid || 0) > 0
        || repairHasUnsafeActiveChild(current)
        || current.autonomous_budget_rollover_checkpoint_pending
        || restoration?.status === 'pending' || restoration?.status === 'restoring') {
        if (current.autonomous_budget_rollover_checkpoint_pending
          || restoration?.status === 'pending' || restoration?.status === 'restoring') {
          throw new Error('Cannot repair an autonomous budget rollover with unbound recovery evidence.');
        }
        return current;
      }
    }
    const epoch = priorEpoch + 1;
    const delayMs = Math.min(
      AUTONOMOUS_BUDGET_ROLLOVER_MAX_DELAY_MS,
      250 * (2 ** Math.min(epoch - 1, 7)),
    );
    const wakeupAt = new Date(nowMs + delayMs).toISOString();
    const deadlineAt = new Date(nowMs + delayMs + AUTONOMOUS_BUDGET_ROLLOVER_GRACE_MS).toISOString();
    const currentIteration = Number(current.iteration || 0);
    const configuredLimit = Number(current.max_iterations || 0);
    const priorWindow = Number(current.autonomous_iteration_budget_window || 0);
    if (reason === 'max_iterations' && configuredLimit > 0) {
      const window = priorWindow > 0 ? priorWindow : Math.max(1, configuredLimit);
      current.autonomous_iteration_budget_window = window;
      current.max_iterations = currentIteration + window;
    }
    if (reason === 'max_time') {
      const configuredMinutes = Number(current.max_time_minutes || 0);
      const priorWindow = Number(current.autonomous_time_budget_window_minutes || 0);
      const window = priorWindow > 0 ? priorWindow : configuredMinutes;
      const nextWindow = Math.min(10_080, Math.max(1, window * 2));
      current.autonomous_time_budget_window_minutes = nextWindow;
      current.max_time_minutes = nextWindow;
    }
    if (legacyMigration) current.autonomous_owner_spec = legacyMigration.targetOwnerSpec;
    markRunStart(current, new Date(nowMs));
    current.active = true;
    current.last_exit_reason = AUTONOMOUS_BUDGET_ROLLOVER_REASON;
    current.autonomous_budget_epoch = epoch;
    current.autonomous_budget_rollover_intent_id = intentId;
    current.autonomous_budget_reason = reason;
    current.autonomous_relaunch_not_before = wakeupAt;
    current.autonomous_relaunch_deadline = deadlineAt;
    const durableCheckpoint: DurableBudgetCheckpoint = {
      kind: AUTONOMOUS_BUDGET_ROLLOVER_REASON,
      receipt_id: `autonomous-budget:scheduled:${intentId}`,
      intent_id: intentId,
      reason,
      epoch,
      wakeup_at: wakeupAt,
      current_ticket: options.ticketId || null,
      iteration: currentIteration,
    };
    current.autonomous_budget_rollover_checkpoint_pending = options.recordDurableCheckpoint
      || options.repairMissingIntent === true
      ? durableCheckpoint : null;
    if (legacyMigration) {
      const contract = {
        schema_version: 1,
        migration_id: legacyMigration.migrationId,
        source_state_sha256: legacyMigration.sourceStateSha256,
        source_history_length: legacyMigration.sourceHistoryLength,
        prd_seal_hash: legacyMigration.prdSealHash,
        start_commit: legacyMigration.startCommit,
        pinned_sha: legacyMigration.pinnedSha,
        source_owner_spec_id: legacyMigration.sourceOwnerSpecId,
        target_owner_spec_id: legacyMigration.targetOwnerSpecId,
        target_runtime_root: legacyMigration.targetRuntimeRoot,
        target_runtime: legacyMigration.targetRuntime,
        rollover_intent_id: intentId,
        rollover_epoch: epoch,
      };
      current.legacy_max_time_migration = {
        ...contract,
        contract_sha256: crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
        status: 'rollover_scheduled',
        created_at: new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
      };
      appendHistory(current, 'legacy_max_time_session_migrated', options.ticketId || undefined);
    }
    current.autonomous_budget_checkpoint_error = null;
    appendHistory(current, AUTONOMOUS_BUDGET_ROLLOVER_REASON, options.ticketId || undefined);
    scheduled.checkpoint = durableCheckpoint;
    scheduled.rollover = { intentId, epoch, delayMs, wakeupAt, deadlineAt, checkpointRecorded: false };
    return current;
  });
  const rollover = scheduled.rollover;
  const checkpoint = scheduled.checkpoint;
  if (!rollover || !checkpoint) return null;
  if (!options.recordDurableCheckpoint) {
    // A liveness repair has no live supervisor writer. Retain its exact receipt
    // for the replacement owner instead of claiming an external checkpoint.
    rollover.checkpointRecorded = options.repairMissingIntent !== true;
    return rollover;
  }
  try {
    emitPendingCheckpoint(manager, statePath, 'autonomous_budget_rollover_checkpoint_pending', checkpoint, options.recordDurableCheckpoint);
    rollover.checkpointRecorded = true;
  } catch {
    // The exact pending checkpoint remains durable for the replacement owner.
  }
  return rollover;
}

export function scheduleAutonomousBudgetRollover(
  manager: StateManager,
  statePath: string,
  reason: AutonomousBudgetReason,
  options: AutonomousBudgetRolloverOptions = {},
): AutonomousBudgetRollover | null {
  return scheduleAutonomousBudgetRolloverInternal(manager, statePath, reason, options);
}

export function scheduleAuthenticatedLegacyMaxTimeRollover(
  manager: StateManager,
  statePath: string,
  options: AuthenticatedLegacyMaxTimeRolloverOptions,
): AutonomousBudgetRollover | null {
  return scheduleAutonomousBudgetRolloverInternal(manager, statePath, 'max_time', options);
}

export function consumeAutonomousBudgetRollover(
  manager: StateManager,
  statePath: string,
  options: Pick<AutonomousBudgetRolloverOptions, 'assertDurableOwnership' | 'recordDurableCheckpoint'> = {},
): boolean {
  let state = manager.read(statePath);
  if (state.cancel_requested_at || state.cancelled === true
    || state.last_exit_reason === 'cancelled') return false;
  options.assertDurableOwnership?.();
  const scheduledPending = state.autonomous_budget_rollover_checkpoint_pending as DurableBudgetCheckpoint | null;
  if (scheduledPending && !options.recordDurableCheckpoint) return false;
  if (scheduledPending && options.recordDurableCheckpoint) {
    emitPendingCheckpoint(
      manager,
      statePath,
      'autonomous_budget_rollover_checkpoint_pending',
      scheduledPending,
      options.recordDurableCheckpoint,
    );
    state = manager.read(statePath);
    if (state.cancel_requested_at || state.cancelled === true
      || state.last_exit_reason === 'cancelled') return false;
  }
  const consumedPending = state.autonomous_budget_consumed_checkpoint_pending as DurableBudgetCheckpoint | null;
  if (consumedPending) {
    if (!options.recordDurableCheckpoint) return false;
    emitPendingCheckpoint(
      manager,
      statePath,
      'autonomous_budget_consumed_checkpoint_pending',
      consumedPending,
      options.recordDurableCheckpoint,
    );
    return true;
  }
  const intentId = typeof state.autonomous_budget_rollover_intent_id === 'string'
    ? state.autonomous_budget_rollover_intent_id : '';
  const epoch = Number(state.autonomous_budget_epoch || 0);
  if (state.active !== true || state.cancel_requested_at || state.cancelled === true
    || state.last_exit_reason === 'cancelled') return false;
  if (!intentId || !Number.isInteger(epoch) || epoch < 1) {
    if (!intentId && epoch === 0) return false;
    const alreadyConsumed = !intentId
      && Number(state.autonomous_budget_consumed_epoch || 0) === epoch
      && typeof state.autonomous_budget_consumed_intent_id === 'string';
    if (alreadyConsumed) return false;
    throw new Error('Autonomous budget rollover intent is incomplete or corrupt.');
  }
  let consumed = false;
  const checkpoint: DurableBudgetCheckpoint = {
    kind: 'autonomous_budget_rollover_consumed',
    receipt_id: `autonomous-budget:consumed:${intentId}`,
    intent_id: intentId,
    epoch,
  };
  manager.update(statePath, (current) => {
    if (current.autonomous_budget_rollover_intent_id !== intentId
      || Number(current.autonomous_budget_epoch || 0) !== epoch) return current;
    if (current.active !== true || current.cancel_requested_at || current.cancelled === true
      || current.last_exit_reason === 'cancelled') return current;
    current.autonomous_budget_consumed_epoch = epoch;
    current.autonomous_budget_consumed_intent_id = intentId;
    current.autonomous_budget_consumed_checkpoint_pending = options.recordDurableCheckpoint
      ? checkpoint : null;
    current.autonomous_budget_rollover_intent_id = null;
    current.autonomous_budget_checkpoint_error = null;
    current.autonomous_relaunch_not_before = null;
    current.autonomous_relaunch_deadline = null;
    const legacyMigration = current.legacy_max_time_migration as Record<string, unknown> | null;
    if (legacyMigration?.rollover_intent_id === intentId) {
      current.legacy_max_time_migration = {
        ...legacyMigration,
        status: 'rollover_consumed',
        updated_at: new Date().toISOString(),
      };
    }
    appendHistory(current, 'autonomous_budget_rollover_consumed');
    consumed = true;
    return current;
  });
  if (consumed && options.recordDurableCheckpoint) {
    emitPendingCheckpoint(
      manager,
      statePath,
      'autonomous_budget_consumed_checkpoint_pending',
      checkpoint,
      options.recordDurableCheckpoint,
    );
  }
  return consumed;
}
