#!/usr/bin/env node
import { deactivateSession, getStatePath, loadSessionState, resolveSessionForCwd } from '../services/session.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  reapOwnedOrphanProcessGroup,
  isPersistedProcessIdentityValid,
  reapRecordedLiveProcessGroup,
  reapRecordedProcessGroupFromMember,
  inspectProcessLivenessIdentity,
  type OrphanReapResult,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';
import { sessionOperationOwnerPid } from '../services/session-operation.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  activateCancellationRecoveryIntent,
  mergeCancellationRecoveryIntent,
  reconcileCancellationRecovery,
} from '../services/cancellation-recovery.js';
import {
  ensureAutonomousOwnerRecoveryDaemon,
  prepareCancellationRecoveryWatchdog,
} from '../services/autonomous-owner-recovery.js';

const COOPERATIVE_DRAIN_TIMEOUT_MS = process.env.PICKLE_TEST_MODE === '1'
  ? Math.max(50, Math.min(Number(process.env.PICKLE_TEST_CANCEL_DRAIN_TIMEOUT_MS || 10_000), 10_000))
  : 10_000;
const COOPERATIVE_DRAIN_POLL_MS = 50;
const groupDrainWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupMembers(pgid: number): Array<{ pid: number; state: string }> | null {
  const inspected = spawnSync('ps', ['-ww', '-axo', 'pid=', '-o', 'pgid=', '-o', 'state='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (inspected.status !== 0) return null;
  return inspected.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/, 3))
    .filter(([, group]) => Number(group) === pgid)
    .map(([pid, , state]) => ({ pid: Number(pid), state }));
}

function processGroupAbsent(pgid: number, identities: PersistedProcessIdentity[]): boolean {
  if (process.platform === 'win32') {
    return identities.every((identity) => inspectProcessLivenessIdentity(identity) === 'not-running');
  }
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  const members = processGroupMembers(pgid);
  return members !== null && (members.length === 0 || members.every(({ state }) => state.startsWith('Z')));
}

function childIdentities(state: PersistedState): PersistedProcessIdentity[] {
  const values = [
    ...(Array.isArray(state.refinement_child_identities) ? state.refinement_child_identities : []),
    ...(Array.isArray(state.active_child_identities) ? state.active_child_identities : []),
    state.active_child_identity,
  ];
  const identities = values.filter(isPersistedProcessIdentityValid);
  return [...new Map(identities.map((identity) => [
    `${identity.pid}:${identity.pgid}:${identity.start_time}:${identity.fingerprint}`,
    identity,
  ])).values()];
}

function rememberChildIdentities(
  known: Map<string, PersistedProcessIdentity>,
  state: PersistedState,
): void {
  for (const identity of childIdentities(state)) {
    known.set(`${identity.pid}:${identity.pgid}:${identity.start_time}:${identity.fingerprint}`, identity);
  }
}

function controllerOwnsShutdown(sessionDir: string, state: PersistedState): boolean {
  const identity = isPersistedProcessIdentityValid(state.active_child_controller_identity)
    ? state.active_child_controller_identity : null;
  if (identity && inspectProcessLivenessIdentity(identity) === 'matched') return true;
  const controllerPid = Number(state.active_child_controller_pid);
  return Number.isInteger(controllerPid) && controllerPid > 0
    && sessionOperationOwnerPid(sessionDir) === controllerPid;
}

function rememberedGroupsAbsent(known: Map<string, PersistedProcessIdentity>): boolean {
  const groups = new Map<number, PersistedProcessIdentity[]>();
  for (const identity of known.values()) {
    groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
  }
  return [...groups].every(([pgid, identities]) => processGroupAbsent(pgid, identities));
}

function waitForProcessGroupAbsence(pgid: number, identities: PersistedProcessIdentity[]): boolean {
  const deadline = Date.now() + 5_000;
  while (!processGroupAbsent(pgid, identities) && Date.now() < deadline) {
    Atomics.wait(groupDrainWaitBuffer, 0, 0, 25);
  }
  return processGroupAbsent(pgid, identities);
}

async function waitForCooperativeDrain(
  sessionDir: string,
  known: Map<string, PersistedProcessIdentity>,
): Promise<PersistedState> {
  const deadline = Date.now() + COOPERATIVE_DRAIN_TIMEOUT_MS;
  let current = loadSessionState(sessionDir);
  while (controllerOwnsShutdown(sessionDir, current) && Date.now() < deadline) {
    rememberChildIdentities(known, current);
    await sleep(COOPERATIVE_DRAIN_POLL_MS);
    current = loadSessionState(sessionDir);
  }
  rememberChildIdentities(known, current);
  return current;
}

function recoverRememberedGroups(
  known: Map<string, PersistedProcessIdentity>,
): OrphanReapResult | null {
  const groups = new Map<number, PersistedProcessIdentity[]>();
  for (const identity of known.values()) {
    groups.set(identity.pgid, [...(groups.get(identity.pgid) || []), identity]);
  }
  for (const [pgid, identities] of groups) {
    if (processGroupAbsent(pgid, identities)) continue;
    const matched = identities.filter((identity) => inspectProcessLivenessIdentity(identity) === 'matched');
    const authority = matched.find((identity) => identity.pid === identity.pgid) || matched[0];
    if (!authority) {
      // The cooperative owner may have reaped the exact recorded members just
      // before exiting while the kernel is still retiring their group. Give
      // that already-authorized drain a bounded chance to become observable;
      // never signal a numeric PGID without a currently matched authority.
      if (waitForProcessGroupAbsence(pgid, identities)) continue;
      return {
        status: 'ambiguous',
        pid: identities[0].pid,
        pgid,
        reason: `process group ${pgid} remains live without an exact signal authority`,
        signals: [],
      };
    }
    const result = authority.pid === authority.pgid
      ? reapRecordedLiveProcessGroup(authority)
      : reapRecordedProcessGroupFromMember(authority);
    if (!waitForProcessGroupAbsence(pgid, identities) && !processGroupAbsent(pgid, identities)) {
      return result.status === 'reaped' || result.status === 'not-running'
        ? {
          status: 'ambiguous',
          pid: result.pid,
          pgid,
          reason: `process group ${pgid} remained live after recovery (${JSON.stringify(processGroupMembers(pgid))})`,
          signals: result.signals,
        }
        : result;
    }
  }
  return null;
}

async function settleDurableCancellation(sessionDir: string): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const outcome = reconcileCancellationRecovery(sessionDir, new StateManager(), Date.now() + 60_000);
    if (outcome === 'completed' || outcome === 'noop') return true;
    await sleep(25);
  }
  return false;
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
  const knownIdentities = new Map<string, PersistedProcessIdentity>();
  rememberChildIdentities(knownIdentities, stateBeforeCancel);
  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const preparedRecoveryIntentId = await prepareCancellationRecoveryWatchdog(
    resolved,
    runtimeBin,
    undefined,
    process.env.PICKLE_TEST_MODE === '1' ? {
      readinessTimeoutMs: Number(process.env.PICKLE_TEST_CANCEL_WATCHDOG_READY_TIMEOUT_MS || 5_000),
      armTimeoutMs: Number(process.env.PICKLE_TEST_CANCEL_WATCHDOG_ARM_TIMEOUT_MS || 10_000),
    } : {},
  );
  if (process.env.PICKLE_TEST_MODE === '1'
    && process.env.PICKLE_TEST_CANCEL_KILL_PREPARED_WATCHDOG === '1') {
    const prepared = loadSessionState(resolved).cancellation_recovery_watchdog_identity;
    if (!isPersistedProcessIdentityValid(prepared)
      || inspectProcessLivenessIdentity(prepared) !== 'matched') {
      throw new Error('Prepared cancellation watchdog was not exactly live at the injected crash seam.');
    }
    process.kill(prepared.pid, 'SIGKILL');
  }
  if (process.env.PICKLE_TEST_MODE === '1'
    && process.env.PICKLE_TEST_CANCEL_CRASH_BEFORE_INTENT === '1') process.kill(process.pid, 'SIGKILL');
  new StateManager().update(getStatePath(resolved), (current) => {
    rememberChildIdentities(knownIdentities, current);
    current.active = false;
    current.last_exit_reason = 'cancelled';
    current.cancel_requested_at = new Date().toISOString();
    current.cancellation_recovery = preparedRecoveryIntentId
      ? activateCancellationRecoveryIntent(
        current.cancellation_recovery,
        knownIdentities.values(),
        preparedRecoveryIntentId,
      )
      : mergeCancellationRecoveryIntent(current.cancellation_recovery, knownIdentities.values());
    if (preparedRecoveryIntentId) {
      const arm = current.cancellation_recovery_watchdog_arm as Record<string, unknown> | null;
      if (!arm || arm.arm_id !== preparedRecoveryIntentId || arm.status !== 'prepared') {
        throw new Error('Cancellation recovery watchdog readiness changed before atomic activation.');
      }
      current.cancellation_recovery_watchdog_arm = {
        ...arm,
        status: 'activated',
        activated_at: new Date().toISOString(),
      };
    }
    current.recovery_kind = 'cancellation_ownership';
    return current;
  });
  if (process.env.PICKLE_TEST_MODE === '1'
    && process.env.PICKLE_TEST_CANCEL_CRASH_AFTER_INTENT === '1') process.kill(process.pid, 'SIGKILL');
  let current = await waitForCooperativeDrain(resolved, knownIdentities);
  let unsafeRecovery: OrphanReapResult | null = null;
  if (controllerOwnsShutdown(resolved, current)
    && (childIdentities(current).length > 0 || !rememberedGroupsAbsent(knownIdentities))) {
    unsafeRecovery = {
      status: 'ambiguous',
      pid: Number(current.active_child_controller_pid) || 0,
      pgid: null,
      reason: 'exact live controller did not complete cooperative cancellation before the recovery deadline',
      signals: [],
    };
  } else {
    let ownershipCleared = false;
    for (let pass = 0; pass < 20 && !unsafeRecovery && !ownershipCleared; pass += 1) {
      current = loadSessionState(resolved);
      rememberChildIdentities(knownIdentities, current);
      if (controllerOwnsShutdown(resolved, current)) {
        unsafeRecovery = {
          status: 'ambiguous',
          pid: Number(current.active_child_controller_pid) || 0,
          pgid: null,
          reason: 'a live controller resumed child publication during cancellation recovery',
          signals: [],
        };
        break;
      }
      unsafeRecovery = recoverRememberedGroups(knownIdentities);
      if (unsafeRecovery) break;
      const recordedPids = new Set([...knownIdentities.values()].map((identity) => identity.pid));
      for (const pid of runtimePids(current).filter((value) => !recordedPids.has(value))) {
        const result = reapOwnedOrphanProcessGroup(resolved, pid);
        if (result.status === 'ambiguous' || result.status === 'signal-failed') {
          unsafeRecovery = result;
          break;
        }
      }
      if (unsafeRecovery) break;
      const knownBeforeCommit = new Set(knownIdentities.keys());
      new StateManager().update(getStatePath(resolved), (latest) => {
        const latestIdentities = childIdentities(latest);
        rememberChildIdentities(knownIdentities, latest);
        const ledgerStable = latestIdentities.every((identity) => knownBeforeCommit.has(
          `${identity.pid}:${identity.pgid}:${identity.start_time}:${identity.fingerprint}`,
        ));
        const recorded = new Set([...knownIdentities.values()].map((identity) => identity.pid));
        const unownedLivePid = runtimePids(latest)
          .some((pid) => !recorded.has(pid) && processAlive(pid));
        if (!ledgerStable || controllerOwnsShutdown(resolved, latest)
          || !rememberedGroupsAbsent(knownIdentities) || unownedLivePid) return latest;
        latest.refinement_child_identities = [];
        latest.active_child_identities = [];
        latest.active_child_pid = null;
        latest.active_child_kind = null;
        latest.active_child_command = null;
        latest.active_child_identity = null;
        latest.active_child_controller_pid = null;
        latest.active_child_controller_identity = null;
        ownershipCleared = true;
        return latest;
      });
    }
    if (!unsafeRecovery && !ownershipCleared) {
      unsafeRecovery = {
        status: 'ambiguous',
        pid: Number(current.active_child_pid) || 0,
        pgid: null,
        reason: 'child ownership did not converge to a stable empty ledger during cancellation recovery',
        signals: [],
      };
    }
  }
  const recoveryFailure = unsafeRecovery?.reason || null;

  await deactivateSession(resolved, recoveryFailure ? 'cancel_recovery_required' : 'cancelled', {
    preserveMapping: Boolean(recoveryFailure),
  });
  if (recoveryFailure) {
    new StateManager().update(getStatePath(resolved), (current) => {
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = recoveryFailure;
      current.orphan_child_pid = unsafeRecovery?.pid || current.active_child_pid;
      current.orphan_recovery = unsafeRecovery;
      const merged = mergeCancellationRecoveryIntent(current.cancellation_recovery, knownIdentities.values());
      current.cancellation_recovery = {
        ...merged,
        status: 'pending',
        not_before: new Date().toISOString(),
        last_error: recoveryFailure,
      };
      return current;
    });
    ensureAutonomousOwnerRecoveryDaemon(resolved, runtimeBin);
    console.log(`Cancellation blocked on recovery for ${resolved}: ${recoveryFailure}`);
    process.exitCode = 1;
    return;
  }
  if (process.env.PICKLE_TEST_MODE === '1'
    && process.env.PICKLE_TEST_CANCEL_FORCE_FINAL_BACKOFF === '1') {
    new StateManager().update(getStatePath(resolved), (current) => {
      const intent = current.cancellation_recovery as Record<string, unknown> | null;
      if (!intent) return current;
      current.cancellation_recovery = {
        ...intent,
        status: 'pending',
        not_before: new Date(Date.now() + 30_000).toISOString(),
        last_error: 'injected final convergence backoff',
      };
      current.recovery_required = true;
      current.recovery_kind = 'cancellation_ownership';
      current.recovery_reason = 'injected final convergence backoff';
      return current;
    });
  }
  if (!await settleDurableCancellation(resolved)) {
    ensureAutonomousOwnerRecoveryDaemon(resolved, runtimeBin);
    console.log(`Cancellation remains under autonomous recovery for ${resolved}.`);
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
