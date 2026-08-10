import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cancelLogicalPipelineByOperator, readLogicalPipeline } from './durable-supervisor.js';
import {
  inspectProcessLivenessIdentity,
  isPersistedProcessIdentityValid,
  reapRecordedLiveProcessGroup,
  reapRecordedProcessGroupFromMember,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { sessionOperationOwnerPid } from './session-operation.js';
import { StateManager, type PersistedState } from './state-manager.js';

export interface CancellationRecoveryIntent {
  schema_version: 1;
  intent_id: string;
  status: 'pending' | 'ownership_quiescent' | 'completed';
  identities: PersistedProcessIdentity[];
  attempt: number;
  epoch: number;
  not_before: string;
  last_error: string | null;
}

function identityKey(identity: PersistedProcessIdentity): string {
  return `${identity.pid}:${identity.pgid}:${identity.start_time}:${identity.fingerprint}`;
}

export function cancellationChildIdentities(state: PersistedState): PersistedProcessIdentity[] {
  const values = [
    ...(Array.isArray(state.refinement_child_identities) ? state.refinement_child_identities : []),
    ...(Array.isArray(state.active_child_identities) ? state.active_child_identities : []),
    state.active_child_identity,
  ];
  return [...new Map(values.filter(isPersistedProcessIdentityValid)
    .map((identity) => [identityKey(identity), identity])).values()];
}

function childLedgerIsValid(state: PersistedState): boolean {
  const ledgers = [state.refinement_child_identities, state.active_child_identities];
  if (ledgers.some((ledger) => ledger !== undefined && ledger !== null
    && (!Array.isArray(ledger) || !ledger.every(isPersistedProcessIdentityValid)))) return false;
  return state.active_child_identity == null || isPersistedProcessIdentityValid(state.active_child_identity);
}

export function createCancellationRecoveryIntent(
  identities: Iterable<PersistedProcessIdentity>,
  nowMs = Date.now(),
): CancellationRecoveryIntent {
  return {
    schema_version: 1,
    intent_id: crypto.randomUUID(),
    status: 'pending',
    identities: [...new Map([...identities].map((identity) => [identityKey(identity), identity])).values()],
    attempt: 0,
    epoch: 1,
    not_before: new Date(nowMs).toISOString(),
    last_error: null,
  };
}

export function cancellationRecoveryIntent(value: unknown): CancellationRecoveryIntent | null {
  const intent = value as CancellationRecoveryIntent | null;
  if (!intent || intent.schema_version !== 1 || typeof intent.intent_id !== 'string' || intent.intent_id.length === 0
    || !['pending', 'ownership_quiescent', 'completed'].includes(intent.status)
    || !Array.isArray(intent.identities) || !intent.identities.every(isPersistedProcessIdentityValid)
    || new Set(intent.identities.map(identityKey)).size !== intent.identities.length
    || !Number.isInteger(intent.attempt) || intent.attempt < 0
    || !Number.isInteger(intent.epoch) || intent.epoch < 1
    || typeof intent.not_before !== 'string' || !Number.isFinite(Date.parse(intent.not_before))
    || (intent.last_error !== null && typeof intent.last_error !== 'string')) return null;
  return intent;
}

export function mergeCancellationRecoveryIntent(
  value: unknown,
  identities: Iterable<PersistedProcessIdentity>,
  nowMs = Date.now(),
): CancellationRecoveryIntent {
  if (value != null && !cancellationRecoveryIntent(value)) {
    throw new Error('Refusing to replace a corrupt cancellation recovery intent.');
  }
  const existing = cancellationRecoveryIntent(value);
  if (!existing) return createCancellationRecoveryIntent(identities, nowMs);
  const merged = new Map(existing.identities.map((identity) => [identityKey(identity), identity]));
  for (const identity of identities) merged.set(identityKey(identity), identity);
  const extended = merged.size !== existing.identities.length;
  return {
    ...existing,
    identities: [...merged.values()],
    status: extended ? 'pending' : existing.status,
    ...(extended ? { not_before: new Date(nowMs).toISOString(), last_error: null } : {}),
  };
}

export function activateCancellationRecoveryIntent(
  value: unknown,
  identities: Iterable<PersistedProcessIdentity>,
  intentId: string,
  nowMs = Date.now(),
): CancellationRecoveryIntent {
  if (!intentId) throw new Error('Cancellation recovery activation requires an exact prepared intent id.');
  const existing = cancellationRecoveryIntent(value);
  if (value != null && !existing) throw new Error('Refusing to activate over a corrupt cancellation recovery intent.');
  if (existing && existing.intent_id !== intentId) {
    throw new Error('Cancellation recovery activation does not match the prepared intent.');
  }
  if (existing) return mergeCancellationRecoveryIntent(existing, identities, nowMs);
  return { ...createCancellationRecoveryIntent(identities, nowMs), intent_id: intentId };
}

export function hasPendingCancellationRecovery(state: PersistedState): boolean {
  const intent = cancellationRecoveryIntent(state.cancellation_recovery);
  return state.recovery_kind === 'cancellation_ownership'
    ? !intent || intent.status !== 'completed'
    : Boolean(intent && intent.status !== 'completed');
}

function groupAbsent(pgid: number, identities: PersistedProcessIdentity[]): boolean {
  if (process.platform === 'win32') {
    return identities.every((identity) => inspectProcessLivenessIdentity(identity) === 'not-running');
  }
  try { process.kill(-pgid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  const inspected = spawnSync('ps', ['-ww', '-axo', 'pgid=', '-o', 'state='], { encoding: 'utf8', timeout: 5_000 });
  if (inspected.status !== 0) return false;
  const members = inspected.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/, 2))
    .filter(([group]) => Number(group) === pgid);
  return members.length === 0 || members.every(([, state]) => state.startsWith('Z'));
}

function controllerStillOwns(sessionDir: string, state: PersistedState): boolean {
  const identity = isPersistedProcessIdentityValid(state.active_child_controller_identity)
    ? state.active_child_controller_identity : null;
  if (identity && inspectProcessLivenessIdentity(identity) === 'matched') return true;
  const pid = Number(state.active_child_controller_pid);
  return Number.isInteger(pid) && pid > 0 && sessionOperationOwnerPid(sessionDir) === pid;
}

function retryDelayMs(epoch: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(Math.max(0, epoch - 1), 7)));
}

export function reconcileCancellationRecovery(
  sessionDir: string,
  manager: StateManager = new StateManager(),
  nowMs = Date.now(),
  options: { beforeFinalClear?: () => void } = {},
): 'noop' | 'pending' | 'completed' {
  const statePath = path.join(sessionDir, 'state.json');
  let state = manager.read(statePath);
  let intent = cancellationRecoveryIntent(state.cancellation_recovery);
  if (!intent) {
    if (state.recovery_kind !== 'cancellation_ownership') return 'noop';
    manager.update(statePath, (current) => {
      current.recovery_required = true;
      current.recovery_reason = 'cancellation recovery intent is corrupt or missing';
      return current;
    });
    return 'pending';
  }
  if (intent.status === 'completed') return 'noop';
  if (Date.parse(intent.not_before) > nowMs) return 'pending';
  if (!childLedgerIsValid(state)) {
    manager.update(statePath, (current) => {
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = 'cancellation child ownership ledger is corrupt';
      return current;
    });
    return 'pending';
  }

  const merged = new Map(intent.identities.map((identity) => [identityKey(identity), identity]));
  for (const identity of cancellationChildIdentities(state)) merged.set(identityKey(identity), identity);
  if (merged.size !== intent.identities.length) {
    state = manager.update(statePath, (current) => {
      const exact = cancellationRecoveryIntent(current.cancellation_recovery);
      if (!exact || exact.intent_id !== intent?.intent_id
        || (exact.status !== 'pending' && exact.status !== 'ownership_quiescent')) return current;
      exact.identities = [...merged.values()];
      exact.status = 'pending';
      exact.attempt = 0;
      exact.not_before = new Date(nowMs).toISOString();
      exact.last_error = null;
      current.cancellation_recovery = exact;
      return current;
    });
    intent = cancellationRecoveryIntent(state.cancellation_recovery);
    if (!intent) return 'noop';
  }

  let error = '';
  if (controllerStillOwns(sessionDir, state)) {
    error = 'waiting for exact live controller to finish cancellation';
  } else {
    const groups = new Map<number, PersistedProcessIdentity[]>();
    for (const identity of intent.identities) groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
    for (const [pgid, identities] of groups) {
      if (groupAbsent(pgid, identities)) continue;
      const matched = identities.filter((identity) => inspectProcessLivenessIdentity(identity) === 'matched');
      const authority = matched.find((identity) => identity.pid === identity.pgid) || matched[0];
      if (!authority) {
        error = `process group ${pgid} remains live without an exact signal authority`;
        break;
      }
      const result = authority.pid === authority.pgid
        ? reapRecordedLiveProcessGroup(authority) : reapRecordedProcessGroupFromMember(authority);
      if (!['reaped', 'not-running'].includes(result.status) || !groupAbsent(pgid, identities)) {
        error = result.status === 'reaped' || result.status === 'not-running'
          ? `process group ${pgid} remains live after exact recovery` : result.reason;
        break;
      }
    }
  }

  if (error) {
    manager.update(statePath, (current) => {
      const exact = cancellationRecoveryIntent(current.cancellation_recovery);
      if (!exact || exact.intent_id !== intent?.intent_id
        || (exact.status !== 'pending' && exact.status !== 'ownership_quiescent')) return current;
      exact.status = 'pending';
      exact.attempt += 1;
      if (exact.attempt % 5 === 0) exact.epoch += 1;
      exact.not_before = new Date(nowMs + retryDelayMs(exact.epoch)).toISOString();
      exact.last_error = error;
      current.cancellation_recovery = exact;
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = error;
      return current;
    });
    return 'pending';
  }

  manager.update(statePath, (current) => {
    const exact = cancellationRecoveryIntent(current.cancellation_recovery);
    if (!exact || exact.intent_id !== intent?.intent_id || exact.status !== 'pending') return current;
    const latest = cancellationChildIdentities(current);
    const known = new Set(exact.identities.map(identityKey));
    if (latest.some((identity) => !known.has(identityKey(identity)))) return current;
    const groups = new Map<number, PersistedProcessIdentity[]>();
    for (const identity of exact.identities) groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
    if ([...groups].some(([pgid, identities]) => !groupAbsent(pgid, identities))) return current;
    exact.status = 'ownership_quiescent';
    exact.last_error = null;
    current.cancellation_recovery = exact;
    return current;
  });
  state = manager.read(statePath);
  intent = cancellationRecoveryIntent(state.cancellation_recovery);
  if (!intent || intent.status !== 'ownership_quiescent') return 'pending';
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  if (fs.existsSync(logicalPath) && readLogicalPipeline(sessionDir).terminal_state === null) {
    cancelLogicalPipelineByOperator(sessionDir, 'autonomous completion of explicit cancellation recovery');
  }
  options.beforeFinalClear?.();
  const finalized = manager.update(statePath, (current) => {
    const exact = cancellationRecoveryIntent(current.cancellation_recovery);
    if (!exact || exact.intent_id !== intent?.intent_id || exact.status !== 'ownership_quiescent') return current;
    if (!childLedgerIsValid(current)) {
      exact.status = 'pending';
      exact.not_before = new Date(nowMs).toISOString();
      exact.last_error = 'cancellation child ownership ledger is corrupt';
      current.cancellation_recovery = exact;
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = exact.last_error;
      return current;
    }
    const latest = cancellationChildIdentities(current);
    const known = new Map(exact.identities.map((identity) => [identityKey(identity), identity]));
    for (const identity of latest) known.set(identityKey(identity), identity);
    const groups = new Map<number, PersistedProcessIdentity[]>();
    for (const identity of known.values()) groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
    if (controllerStillOwns(sessionDir, current)
      || known.size !== exact.identities.length
      || [...groups].some(([pgid, identities]) => !groupAbsent(pgid, identities))) {
      exact.identities = [...known.values()];
      exact.status = 'pending';
      exact.not_before = new Date(nowMs).toISOString();
      exact.last_error = 'ownership changed during cancellation finalization';
      current.cancellation_recovery = exact;
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = exact.last_error;
      return current;
    }
    current.refinement_child_identities = [];
    current.active_child_identities = [];
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.active_child_identity = null;
    current.active_child_controller_pid = null;
    current.active_child_controller_identity = null;
    current.recovery_required = false;
    current.recovery_kind = null;
    current.recovery_reason = null;
    current.orphan_child_pid = null;
    current.orphan_recovery = null;
    exact.status = 'completed';
    current.cancellation_recovery = exact;
    return current;
  });
  return cancellationRecoveryIntent(finalized.cancellation_recovery)?.status === 'completed'
    ? 'completed' : 'pending';
}
