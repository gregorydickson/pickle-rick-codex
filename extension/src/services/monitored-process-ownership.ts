import type { ChildProcess } from 'node:child_process';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  isPersistedProcessIdentityValid,
  reapRecordedLiveProcessGroup,
  reapRecordedProcessGroupFromMember,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { StateManager, type PersistedState } from './state-manager.js';

function sameIdentity(left: PersistedProcessIdentity, right: PersistedProcessIdentity): boolean {
  const strictCommand = left.strict_command !== false && right.strict_command !== false;
  return left.pid === right.pid
    && left.pgid === right.pgid
    && left.start_time === right.start_time
    && left.fingerprint === right.fingerprint
    && left.identity_version === right.identity_version
    && left.session_id === right.session_id
    && left.identity_kind === right.identity_kind
    && (!strictCommand || left.command_sha256 === right.command_sha256);
}

function processGroupAbsent(pgid: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function activeMonitoredProcessIdentities(state: PersistedState): PersistedProcessIdentity[] {
  if (!Array.isArray(state.active_child_identities)) return [];
  const identities = state.active_child_identities.filter(isPersistedProcessIdentityValid);
  if (identities.length !== state.active_child_identities.length) {
    throw new Error('Persisted monitored process identity ledger is invalid.');
  }
  return identities;
}

function exactLedgerMatches(
  state: PersistedState,
  expected: PersistedProcessIdentity[],
): boolean {
  const current = activeMonitoredProcessIdentities(state);
  return current.length === expected.length
    && current.every((identity, index) => sameIdentity(identity, expected[index]));
}

function allAbsent(identities: PersistedProcessIdentity[]): boolean {
  return identities.every((identity) => inspectProcessLivenessIdentity(identity) === 'not-running')
    && [...new Set(identities.map((identity) => identity.pgid))].every(processGroupAbsent);
}

function clearLedger(state: PersistedState): PersistedState {
  state.active_child_identities = [];
  state.active_child_pid = null;
  state.active_child_kind = null;
  state.active_child_command = null;
  state.active_child_identity = null;
  state.active_child_controller_pid = null;
  state.active_child_controller_identity = null;
  return state;
}

/** Reap a durable broker ledger left by a crashed controller. Evidence is
 * cleared only after every exact identity and every attested group is absent. */
export function recoverMonitoredProcessOwnership(
  manager: StateManager,
  statePath: string,
  options: { allowLiveController?: boolean } = {},
): void {
  const initialState = manager.read(statePath);
  const recorded = activeMonitoredProcessIdentities(initialState);
  if (recorded.length === 0) return;
  const controllerIdentity = isPersistedProcessIdentityValid(initialState.active_child_controller_identity)
    ? initialState.active_child_controller_identity : null;
  if (!options.allowLiveController && Number(initialState.active_child_controller_pid) !== process.pid) {
    if (controllerIdentity && inspectProcessLivenessIdentity(controllerIdentity) === 'matched') {
      throw new Error('Refusing to reap monitored processes owned by an exact live controller.');
    }
    // A legacy bare PID is not durable ownership evidence: PID reuse must not
    // permanently fence recovery of an otherwise exact child ledger.
  }
  const groups = new Map<number, PersistedProcessIdentity[]>();
  for (const identity of recorded) {
    const group = groups.get(identity.pgid) || [];
    group.push(identity);
    groups.set(identity.pgid, group);
  }
  for (const group of groups.values()) {
    const leader = group.find((identity) => identity.pid === identity.pgid);
    if (leader && inspectProcessLivenessIdentity(leader) === 'matched') {
      const result = reapRecordedLiveProcessGroup(leader);
      if (!['reaped', 'not-running'].includes(result.status)) {
        throw new Error(`Cannot recover monitored broker ${leader.pid}: ${result.reason}`);
      }
    }
    for (const identity of group) {
      const liveness = inspectProcessLivenessIdentity(identity);
      if (liveness === 'not-running') continue;
      if (liveness === 'reused') {
        throw new Error(`Cannot recover monitored process ${identity.pid}: immutable identity was reused.`);
      }
      const result = identity.pid === identity.pgid
        ? reapRecordedLiveProcessGroup(identity)
        : reapRecordedProcessGroupFromMember(identity);
      if (!['reaped', 'not-running'].includes(result.status)) {
        throw new Error(`Cannot recover monitored process ${identity.pid}: ${result.reason}`);
      }
    }
  }
  const absenceDeadline = Date.now() + 2_000;
  while (!allAbsent(recorded) && Date.now() < absenceDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!allAbsent(recorded)) {
    throw new Error('Cannot clear monitored process ownership: an attested process or group remains live.');
  }
  manager.update(statePath, (current) => {
    if (activeMonitoredProcessIdentities(current).length === 0) return clearLedger(current);
    if (!exactLedgerMatches(current, recorded)) {
      throw new Error('Monitored process ownership changed during recovery.');
    }
    return clearLedger(current);
  });
}

/** Recover the parallel refinement fan-out ledger with the same exact
 * identity/group guarantees as the generic monitored ledger. */
export function recoverRefinementProcessOwnership(
  manager: StateManager,
  statePath: string,
): void {
  const initialState = manager.read(statePath);
  const raw = Array.isArray(initialState.refinement_child_identities)
    ? initialState.refinement_child_identities : [];
  const recorded = raw.filter(isPersistedProcessIdentityValid);
  if (recorded.length !== raw.length) throw new Error('Persisted refinement process identity ledger is invalid.');
  if (recorded.length === 0) return;
  const controllerIdentity = isPersistedProcessIdentityValid(initialState.active_child_controller_identity)
    ? initialState.active_child_controller_identity : null;
  if (Number(initialState.active_child_controller_pid) !== process.pid
    && controllerIdentity && inspectProcessLivenessIdentity(controllerIdentity) === 'matched') {
    throw new Error('Refusing to reap refinement processes owned by an exact live controller.');
  }
  const groups = new Map<number, PersistedProcessIdentity[]>();
  for (const identity of recorded) groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
  for (const group of groups.values()) {
    const leader = group.find((identity) => identity.pid === identity.pgid);
    if (leader && inspectProcessLivenessIdentity(leader) === 'matched') {
      const result = reapRecordedLiveProcessGroup(leader);
      if (!['reaped', 'not-running'].includes(result.status)) {
        throw new Error(`Cannot recover refinement broker ${leader.pid}: ${result.reason}`);
      }
    }
    for (const identity of group) {
      const liveness = inspectProcessLivenessIdentity(identity);
      if (liveness === 'not-running') continue;
      if (liveness === 'reused') throw new Error(`Cannot recover refinement process ${identity.pid}: identity was reused.`);
      const result = identity.pid === identity.pgid
        ? reapRecordedLiveProcessGroup(identity) : reapRecordedProcessGroupFromMember(identity);
      if (!['reaped', 'not-running'].includes(result.status)) {
        throw new Error(`Cannot recover refinement process ${identity.pid}: ${result.reason}`);
      }
    }
  }
  const deadline = Date.now() + 2_000;
  while (!allAbsent(recorded) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!allAbsent(recorded)) throw new Error('Cannot clear refinement ownership: an attested process or group remains live.');
  manager.update(statePath, (current) => {
    const currentRaw = Array.isArray(current.refinement_child_identities)
      ? current.refinement_child_identities.filter(isPersistedProcessIdentityValid) : [];
    if (currentRaw.length !== recorded.length
      || !currentRaw.every((identity, index) => sameIdentity(identity, recorded[index]))) {
      throw new Error('Refinement process ownership changed during recovery.');
    }
    current.refinement_child_identities = [];
    return activeMonitoredProcessIdentities(current).length === 0 ? clearLedger(current) : current;
  });
}

export function clearActiveChildIfNoMonitoredOwnership(
  manager: StateManager,
  statePath: string,
  additionalFields: Record<string, unknown> = {},
): void {
  manager.update(statePath, (current) => {
    Object.assign(current, additionalFields);
    if (activeMonitoredProcessIdentities(current).length === 0) clearLedger(current);
    return current;
  });
}

export function monitoredProcessStateCallbacks(
  manager: StateManager,
  statePath: string,
  kind: string,
  command: string,
): {
  onSpawn: (child: ChildProcess, brokerIdentity: PersistedProcessIdentity) => void;
  onTargetSpawn: (brokerIdentity: PersistedProcessIdentity, targetIdentity: PersistedProcessIdentity) => void;
  onDescendants: (
    brokerIdentity: PersistedProcessIdentity,
    targetIdentity: PersistedProcessIdentity,
    descendantIdentities: PersistedProcessIdentity[],
  ) => void;
  onDrain: (
    brokerIdentity: PersistedProcessIdentity,
    targetIdentity: PersistedProcessIdentity,
    descendantIdentities: PersistedProcessIdentity[],
  ) => void;
} {
  return {
    onSpawn: (child, brokerIdentity) => {
      const controllerIdentity = captureProcessLivenessIdentity(process.pid);
      if (!controllerIdentity) throw new Error('Cannot attest monitored process controller identity.');
      manager.update(statePath, (current) => {
        const prior = activeMonitoredProcessIdentities(current);
        if (prior.length > 0 && !allAbsent(prior)) {
          throw new Error('Refusing to overwrite live monitored process ownership.');
        }
        current.active_child_identities = [brokerIdentity];
        if (Number(child.pid) !== brokerIdentity.pid) {
          throw new Error('Monitored broker child pid does not match its immutable identity.');
        }
        current.active_child_pid = brokerIdentity.pid;
        current.active_child_kind = kind;
        current.active_child_command = command;
        current.active_child_identity = brokerIdentity;
        current.active_child_controller_pid = process.pid;
        current.active_child_controller_identity = controllerIdentity;
        return current;
      });
    },
    onTargetSpawn: (brokerIdentity, targetIdentity) => {
      manager.update(statePath, (current) => {
        if (!exactLedgerMatches(current, [brokerIdentity])) {
          throw new Error('Cannot publish monitored target without its exact durable broker.');
        }
        current.active_child_identities = [brokerIdentity, targetIdentity];
        return current;
      });
    },
    onDescendants: (brokerIdentity, targetIdentity, descendantIdentities) => {
      manager.update(statePath, (current) => {
        const prior = activeMonitoredProcessIdentities(current);
        if (prior.length < 2 || !sameIdentity(prior[0], brokerIdentity)
          || !sameIdentity(prior[1], targetIdentity)) {
          throw new Error('Cannot publish monitored descendants without the exact durable broker and target.');
        }
        const next = [brokerIdentity, targetIdentity, ...descendantIdentities];
        if (prior.some((identity) => !next.some((candidate) => sameIdentity(identity, candidate)))) {
          throw new Error('Monitored descendant ledger updates must be monotonic until drain.');
        }
        current.active_child_identities = next;
        return current;
      });
    },
    onDrain: (brokerIdentity, targetIdentity, descendantIdentities) => {
      const drained = [brokerIdentity, targetIdentity, ...descendantIdentities];
      if (!allAbsent(drained)) {
        throw new Error('Cannot clear monitored process ownership before exact group drain.');
      }
      manager.update(statePath, (current) => {
        if (!exactLedgerMatches(current, drained)) {
          throw new Error('Monitored process ownership changed before drain persistence.');
        }
        return clearLedger(current);
      });
    },
  };
}
