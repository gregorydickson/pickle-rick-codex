import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { StateManager } from './state-manager.js';

export type OrphanReapStatus = 'not-running' | 'reaped' | 'ambiguous' | 'signal-failed';

export interface OrphanReapResult {
  status: OrphanReapStatus;
  pid: number;
  pgid: number | null;
  reason: string;
  signals: NodeJS.Signals[];
}

export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  pgid: number;
  sessionId: number;
  startTime: string;
  argv: string[] | null;
  command: string | null;
  fingerprint: string;
}

export interface PersistedProcessIdentity {
  pid: number;
  pgid: number;
  start_time: string;
  fingerprint: string;
  identity_version?: 2;
  session_id?: number;
  command_sha256?: string;
  identity_kind?: 'managed' | 'descendant';
  strict_command?: boolean;
}

export interface OrphanReaperOptions {
  termGraceMs?: number;
  inspect?: (pid: number) => ProcessIdentity | null;
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => void;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function waitSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, Math.max(0, milliseconds));
}

function readProcArgv(pid: number): string[] | null {
  try {
    const payload = fs.readFileSync(`/proc/${pid}/cmdline`);
    return payload.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function inspectProcess(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const metadata = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'pgid=', '-o', 'sess=', '-o', 'state=', '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (metadata.status !== 0 || !metadata.stdout.trim()) return null;
  const match = metadata.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  const parentPid = Number(match[1]);
  const pgid = Number(match[2]);
  const sessionId = Number(match[3]);
  if (match[4].startsWith('Z')) return null;
  const startTime = match[5].trim();
  const commandResult = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (commandResult.status !== 0 || !commandResult.stdout.trim()) return null;
  const command = commandResult.stdout.trim();
  const commandSha256 = crypto.createHash('sha256').update(command).digest('hex');
  const argv = readProcArgv(pid);
  return {
    pid,
    parentPid,
    pgid,
    sessionId,
    startTime,
    argv,
    command,
    fingerprint: crypto.createHash('sha256')
      .update(`v2\0${pid}\0${pgid}\0${sessionId}\0${startTime}\0${commandSha256}`).digest('hex'),
  };
}

function structuralFingerprint(identity: Pick<ProcessIdentity, 'pid' | 'pgid' | 'sessionId' | 'startTime'>): string {
  return crypto.createHash('sha256')
    .update(`v2-descendant\0${identity.pid}\0${identity.pgid}\0${identity.sessionId}\0${identity.startTime}`).digest('hex');
}

function persistIdentity(
  identity: ProcessIdentity,
  options: { identityKind?: 'managed' | 'descendant'; strictCommand?: boolean } = {},
): PersistedProcessIdentity {
  const identityKind = options.identityKind || 'managed';
  const strictCommand = options.strictCommand ?? identityKind !== 'descendant';
  return {
    pid: identity.pid,
    pgid: identity.pgid,
    start_time: identity.startTime,
    fingerprint: strictCommand ? identity.fingerprint : structuralFingerprint(identity),
    identity_version: 2,
    session_id: identity.sessionId,
    command_sha256: crypto.createHash('sha256').update(identity.command || '').digest('hex'),
    identity_kind: identityKind,
    strict_command: strictCommand,
  };
}

function identityMatches(expected: PersistedProcessIdentity, current: ProcessIdentity | null): boolean {
  if (!current || current.pid !== expected.pid || current.pgid !== expected.pgid
    || current.startTime !== expected.start_time) return false;
  if (expected.identity_version === 2) {
    if (current.sessionId !== expected.session_id) return false;
    return expected.strict_command === false || expected.identity_kind === 'descendant'
      ? structuralFingerprint(current) === expected.fingerprint
      : current.fingerprint === expected.fingerprint;
  }
  if (current.fingerprint === expected.fingerprint) return true;
  const legacy = crypto.createHash('sha256')
    .update(`${current.pid}\0${current.pgid}\0${current.startTime}`).digest('hex');
  return legacy === expected.fingerprint;
}

export function isPersistedProcessIdentityValid(value: unknown): value is PersistedProcessIdentity {
  const identity = value as PersistedProcessIdentity | null;
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0
    || !Number.isInteger(identity.pgid) || identity.pgid <= 0
    || typeof identity.start_time !== 'string' || !identity.start_time
    || typeof identity.fingerprint !== 'string') return false;
  if (identity.identity_version === 2) {
    if (!Number.isInteger(identity.session_id) || Number(identity.session_id) < 0
      || !/^[a-f0-9]{64}$/.test(String(identity.command_sha256 || ''))) return false;
    if (identity.identity_kind !== undefined && !['managed', 'descendant'].includes(identity.identity_kind)) return false;
    if (identity.strict_command !== undefined && typeof identity.strict_command !== 'boolean') return false;
    const expectedFingerprint = identity.strict_command === false || identity.identity_kind === 'descendant'
      ? crypto.createHash('sha256')
        .update(`v2-descendant\0${identity.pid}\0${identity.pgid}\0${identity.session_id}\0${identity.start_time}`).digest('hex')
      : crypto.createHash('sha256')
        .update(`v2\0${identity.pid}\0${identity.pgid}\0${identity.session_id}\0${identity.start_time}\0${identity.command_sha256}`)
        .digest('hex');
    return identity.fingerprint === expectedFingerprint;
  }
  return identity.fingerprint === crypto.createHash('sha256')
    .update(`${identity.pid}\0${identity.pgid}\0${identity.start_time}`).digest('hex');
}

export function captureProcessIdentity(pid: number): PersistedProcessIdentity | null {
  const identity = inspectProcess(pid);
  if (!identity || identity.pgid !== identity.pid) return null;
  return persistIdentity(identity);
}

/** Capture immutable liveness identity for a process without requiring it to
 * lead its process group. This is for leases/locks, never group signalling. */
export function captureProcessLivenessIdentity(
  pid: number,
  options: { identityKind?: 'managed' | 'descendant' } = {},
): PersistedProcessIdentity | null {
  const identity = inspectProcess(pid);
  if (!identity) return null;
  return persistIdentity(identity, options);
}

export function inspectProcessLivenessIdentity(
  persisted: PersistedProcessIdentity,
): 'not-running' | 'matched' | 'reused' {
  const current = inspectProcess(persisted.pid);
  if (!current) return 'not-running';
  return identityMatches(persisted, current) ? 'matched' : 'reused';
}

export function captureSpawnedProcessIdentity(
  pid: number,
  attempts: number = 5,
  expectedParentPid: number = process.pid,
  options: { strictCommand?: boolean } = {},
): PersistedProcessIdentity | null {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const observed = inspectProcess(pid);
    if (observed && observed.pgid === observed.pid && observed.parentPid === expectedParentPid) {
      return persistIdentity(observed, options);
    }
    if (observed && observed.parentPid !== expectedParentPid) return null;
    if (attempt + 1 < attempts) waitSync(10);
  }
  return null;
}

function matchesPersistedIdentity(expected: PersistedProcessIdentity, current: ProcessIdentity | null): boolean {
  return Boolean(
    identityMatches(expected, current)
      && current
      && current.pgid === current.pid,
  );
}

export function inspectRecordedLiveProcessIdentity(
  persisted: PersistedProcessIdentity,
): 'not-running' | 'matched' | 'ambiguous' {
  const current = inspectProcess(persisted.pid);
  if (!current) return 'not-running';
  return matchesPersistedIdentity(persisted, current) ? 'matched' : 'ambiguous';
}

function ownsSession(identity: ProcessIdentity, sessionDir: string): boolean {
  if (identity.pgid !== identity.pid) return false;
  const exactSessions = new Set([path.resolve(sessionDir), fs.realpathSync(sessionDir)]);
  if (identity.argv) {
    for (let index = 0; index < identity.argv.length; index += 1) {
      const arg = identity.argv[index];
      if (arg === '--add-dir' && exactSessions.has(identity.argv[index + 1])) return true;
      if ([...exactSessions].some((candidate) => arg === `--add-dir=${candidate}`)) return true;
    }
    return false;
  }
  // `ps command` is not a lossless argv representation. Paths containing
  // whitespace therefore remain ambiguous instead of being guessed at.
  if ([...exactSessions].some((candidate) => /\s/.test(candidate)) || !identity.command) return false;
  return [...exactSessions].some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)--add-dir(?:=|\\s+)${escaped}(?=\\s|$)`).test(identity.command || '');
  });
}

function sameOwnedIdentity(
  expected: ProcessIdentity,
  current: ProcessIdentity | null,
  sessionDir: string,
): boolean {
  return Boolean(
    current
      && current.fingerprint === expected.fingerprint
      && ownsSession(current, sessionDir),
  );
}

export function reapOwnedOrphanProcessGroup(
  sessionDir: string,
  pid: number,
  options: OrphanReaperOptions = {},
): OrphanReapResult {
  const inspect = options.inspect || inspectProcess;
  const signalGroup = options.signalGroup || ((pgid, signal) => process.kill(-pgid, signal));
  const wait = options.wait || waitSync;
  const initial = inspect(pid);
  if (!initial) {
    return { status: 'not-running', pid, pgid: null, reason: 'process is no longer running', signals: [] };
  }
  if (!ownsSession(initial, sessionDir)) {
    return { status: 'ambiguous', pid, pgid: initial.pgid, reason: 'argv does not prove exact session ownership', signals: [] };
  }

  const beforeTerm = inspect(pid);
  if (!beforeTerm) {
    return { status: 'not-running', pid, pgid: initial.pgid, reason: 'process exited before TERM', signals: [] };
  }
  if (!sameOwnedIdentity(initial, beforeTerm, sessionDir)) {
    return { status: 'ambiguous', pid, pgid: beforeTerm?.pgid || null, reason: 'process identity changed before TERM', signals: [] };
  }
  const signals: NodeJS.Signals[] = [];
  try {
    signalGroup(initial.pgid, 'SIGTERM');
    signals.push('SIGTERM');
  } catch (error) {
    return { status: 'signal-failed', pid, pgid: initial.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }

  wait(options.termGraceMs ?? 500);
  const beforeKill = inspect(pid);
  if (!beforeKill) {
    return { status: 'reaped', pid, pgid: initial.pgid, reason: 'process group exited after TERM', signals };
  }
  if (!sameOwnedIdentity(initial, beforeKill, sessionDir)) {
    return { status: 'ambiguous', pid, pgid: beforeKill.pgid, reason: 'process identity changed before KILL', signals };
  }
  try {
    signalGroup(initial.pgid, 'SIGKILL');
    signals.push('SIGKILL');
    wait(50);
    return { status: 'reaped', pid, pgid: initial.pgid, reason: 'owned process group received TERM then KILL', signals };
  } catch (error) {
    return { status: 'signal-failed', pid, pgid: initial.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }
}

/**
 * Reap a child whose immutable process identity was captured by a controller
 * that is still alive. Unlike orphan recovery, this does not require argv
 * ownership because shells and deterministic checks do not carry --add-dir.
 */
export function reapRecordedLiveProcessGroup(
  persisted: PersistedProcessIdentity,
  options: OrphanReaperOptions = {},
): OrphanReapResult {
  const inspect = options.inspect || inspectProcess;
  const signalGroup = options.signalGroup || ((pgid, signal) => process.kill(-pgid, signal));
  const wait = options.wait || waitSync;
  const initial = inspect(persisted.pid);
  if (!initial) {
    return { status: 'not-running', pid: persisted.pid, pgid: null, reason: 'process is no longer running', signals: [] };
  }
  if (!matchesPersistedIdentity(persisted, initial)) {
    return { status: 'ambiguous', pid: persisted.pid, pgid: initial.pgid, reason: 'live child identity does not match the spawn record', signals: [] };
  }
  const beforeTerm = inspect(persisted.pid);
  if (!beforeTerm) {
    return { status: 'not-running', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded process exited before TERM', signals: [] };
  }
  if (!matchesPersistedIdentity(persisted, beforeTerm)) {
    return { status: 'ambiguous', pid: persisted.pid, pgid: beforeTerm?.pgid || null, reason: 'process identity changed before TERM', signals: [] };
  }
  const signals: NodeJS.Signals[] = [];
  try {
    signalGroup(persisted.pgid, 'SIGTERM');
    signals.push('SIGTERM');
  } catch (error) {
    wait(50);
    if (!inspect(persisted.pid)) {
      return { status: 'reaped', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded process exited during TERM race', signals };
    }
    return { status: 'signal-failed', pid: persisted.pid, pgid: persisted.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }
  wait(options.termGraceMs ?? 500);
  const beforeKill = inspect(persisted.pid);
  if (!beforeKill) {
    return { status: 'reaped', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded process group exited after TERM', signals };
  }
  if (!matchesPersistedIdentity(persisted, beforeKill)) {
    return { status: 'ambiguous', pid: persisted.pid, pgid: beforeKill.pgid, reason: 'process identity changed before KILL', signals };
  }
  try {
    signalGroup(persisted.pgid, 'SIGKILL');
    signals.push('SIGKILL');
    wait(50);
    return { status: 'reaped', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded process group received TERM then KILL', signals };
  } catch (error) {
    return { status: 'signal-failed', pid: persisted.pid, pgid: persisted.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }
}

/** Recover a recorded process group through an immutable non-leader member.
 * This is the fail-closed fallback for a broker that disappeared before its
 * target. It deliberately uses immediate KILL: a TERM grace could remove the
 * sole immutable member and destroy the authority needed to reap stubborn
 * descendants in the same group. */
export function reapRecordedProcessGroupFromMember(
  persisted: PersistedProcessIdentity,
  options: OrphanReaperOptions = {},
): OrphanReapResult {
  const inspect = options.inspect || inspectProcess;
  const signalGroup = options.signalGroup || ((pgid, signal) => process.kill(-pgid, signal));
  const wait = options.wait || waitSync;
  const matchesMember = (current: ProcessIdentity | null): boolean => Boolean(
    identityMatches(persisted, current),
  );
  const initial = inspect(persisted.pid);
  if (!initial) {
    return { status: 'not-running', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded group member is no longer running', signals: [] };
  }
  if (!matchesMember(initial)) {
    return { status: 'ambiguous', pid: persisted.pid, pgid: initial.pgid, reason: 'recorded group member identity changed', signals: [] };
  }
  const beforeKill = inspect(persisted.pid);
  if (!matchesMember(beforeKill)) {
    return { status: 'ambiguous', pid: persisted.pid, pgid: beforeKill?.pgid || null, reason: 'recorded group member identity changed before KILL', signals: [] };
  }
  const signals: NodeJS.Signals[] = [];
  try {
    signalGroup(persisted.pgid, 'SIGKILL');
    signals.push('SIGKILL');
    wait(50);
    return { status: 'reaped', pid: persisted.pid, pgid: persisted.pgid, reason: 'exact live group member authorized immediate KILL', signals };
  } catch (error) {
    return { status: 'signal-failed', pid: persisted.pid, pgid: persisted.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }
}

export function recoverSessionOrphanState(sessionDir: string, state: Record<string, unknown>): OrphanReapResult | null {
  const pid = Number(state.orphan_child_pid || state.active_child_pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rawIdentity = state.active_child_identity;
  if (rawIdentity && typeof rawIdentity === 'object') {
    const identity = rawIdentity as Partial<PersistedProcessIdentity>;
    if (
      identity.pid === pid
      && Number.isInteger(identity.pgid)
      && Number(identity.pgid) > 0
      && typeof identity.start_time === 'string'
      && typeof identity.fingerprint === 'string'
    ) {
      return reapRecordedLiveProcessGroup(identity as PersistedProcessIdentity);
    }
    return {
      status: 'ambiguous',
      pid,
      pgid: null,
      reason: 'persisted child identity is invalid or does not match the orphan pid',
      signals: [],
    };
  }
  // Legacy sessions predate immutable spawn identities. Keep their narrower
  // argv-based ownership proof as the only fallback.
  return reapOwnedOrphanProcessGroup(path.resolve(sessionDir), pid);
}

export function assertSessionOrphanRecovered(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
): OrphanReapResult | null {
  const statePath = path.join(sessionDir, 'state.json');
  const state = stateManager.read(statePath);
  if (state.recovery_required !== true && !state.orphan_child_pid) return null;
  const result = recoverSessionOrphanState(sessionDir, state);
  if (!result || (result.status !== 'reaped' && result.status !== 'not-running')) {
    stateManager.update(statePath, (current) => {
      current.recovery_required = true;
      current.recovery_reason = result?.reason || 'orphan ownership is not provable';
      current.orphan_recovery = result;
      return current;
    });
    throw new Error(`Session recovery required: ${result?.reason || 'orphan ownership is not provable'}`);
  }
  stateManager.update(statePath, (current) => {
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.orphan_child_pid = null;
    current.recovery_required = false;
    current.recovery_reason = null;
    current.orphan_recovery = result;
    return current;
  });
  return result;
}

export function assertRecordedActiveChildRecovered(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
): OrphanReapResult | null {
  const statePath = path.join(sessionDir, 'state.json');
  const state = stateManager.read(statePath);
  const rawLedger = Array.isArray(state.active_child_identities) ? state.active_child_identities : [];
  if (rawLedger.length > 0) {
    if (!rawLedger.every(isPersistedProcessIdentityValid)) {
      throw new Error('Session recovery required: monitored process identity ledger is invalid');
    }
    const ledger = rawLedger as PersistedProcessIdentity[];
    const groups = new Map<number, PersistedProcessIdentity[]>();
    for (const entry of ledger) groups.set(entry.pgid, [...(groups.get(entry.pgid) || []), entry]);
    let recovered = false;
    for (const group of groups.values()) {
      const leader = group.find((entry) => entry.pid === entry.pgid);
      if (leader && inspectProcessLivenessIdentity(leader) === 'matched') {
        const leaderResult = reapRecordedLiveProcessGroup(leader);
        if (!['reaped', 'not-running'].includes(leaderResult.status)) {
          throw new Error(`Session recovery required: ${leaderResult.reason}`);
        }
        recovered ||= leaderResult.status === 'reaped';
      }
      for (const entry of group) {
        const liveness = inspectProcessLivenessIdentity(entry);
        if (liveness === 'not-running') continue;
        if (liveness === 'reused') throw new Error('Session recovery required: monitored process identity was reused');
        const memberResult = entry.pid === entry.pgid
          ? reapRecordedLiveProcessGroup(entry) : reapRecordedProcessGroupFromMember(entry);
        if (!['reaped', 'not-running'].includes(memberResult.status)) {
          throw new Error(`Session recovery required: ${memberResult.reason}`);
        }
        recovered ||= memberResult.status === 'reaped';
      }
      if (group.some((entry) => inspectProcessLivenessIdentity(entry) !== 'not-running')
        || (() => {
          if (process.platform === 'win32') return false;
          try { process.kill(-group[0].pgid, 0); return true; } catch { return false; }
        })()) {
        throw new Error('Session recovery required: monitored process group remains live after exact recovery');
      }
    }
    stateManager.update(statePath, (current) => {
      const currentLedger = Array.isArray(current.active_child_identities)
        ? current.active_child_identities as PersistedProcessIdentity[] : [];
      if (JSON.stringify(currentLedger) !== JSON.stringify(ledger)) {
        throw new Error('Session recovery required: monitored process ownership changed during recovery');
      }
      current.active_child_identities = [];
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.active_child_identity = null;
      current.active_child_controller_pid = null;
      current.active_child_controller_identity = null;
      current.orphan_child_pid = null;
      current.recovery_required = false;
      current.recovery_reason = null;
      return current;
    });
    return {
      status: recovered ? 'reaped' : 'not-running',
      pid: ledger[0].pid,
      pgid: ledger[0].pgid,
      reason: recovered ? 'monitored process ledger was reaped' : 'monitored process ledger was already absent',
      signals: [],
    };
  }
  const pid = Number(state.active_child_pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rawIdentity = state.active_child_identity;
  const identity = rawIdentity && typeof rawIdentity === 'object'
    ? rawIdentity as Partial<PersistedProcessIdentity>
    : null;
  let result: OrphanReapResult;
  if (
    identity
    && identity.pid === pid
    && Number.isInteger(identity.pgid)
    && Number(identity.pgid) > 0
    && typeof identity.start_time === 'string'
    && typeof identity.fingerprint === 'string'
  ) {
    result = reapRecordedLiveProcessGroup(identity as PersistedProcessIdentity);
  } else if (!inspectProcess(pid)) {
    result = { status: 'not-running', pid, pgid: null, reason: 'recorded child is no longer running', signals: [] };
  } else {
    result = { status: 'ambiguous', pid, pgid: null, reason: 'live child has no valid immutable spawn identity', signals: [] };
  }
  if (result.status !== 'reaped' && result.status !== 'not-running') {
    stateManager.update(statePath, (current) => {
      current.recovery_required = true;
      current.recovery_reason = result.reason;
      current.orphan_child_pid = pid;
      current.orphan_recovery = result;
      return current;
    });
    throw new Error(`Session recovery required: ${result.reason}`);
  }
  stateManager.update(statePath, (current) => {
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.active_child_identity = null;
    current.active_child_identities = [];
    current.active_child_controller_pid = null;
    current.active_child_controller_identity = null;
    current.orphan_child_pid = null;
    current.recovery_required = false;
    current.recovery_reason = null;
    current.orphan_recovery = result;
    return current;
  });
  return result;
}
