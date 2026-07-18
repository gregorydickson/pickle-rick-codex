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
  pgid: number;
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
  const metadata = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (metadata.status !== 0 || !metadata.stdout.trim()) return null;
  const match = metadata.stdout.trim().match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  const pgid = Number(match[1]);
  if (match[2].startsWith('Z')) return null;
  const startTime = match[3].trim();
  const commandResult = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (commandResult.status !== 0 || !commandResult.stdout.trim()) return null;
  const command = commandResult.stdout.trim();
  const argv = readProcArgv(pid);
  return {
    pid,
    pgid,
    startTime,
    argv,
    command,
    fingerprint: crypto.createHash('sha256').update(`${pid}\0${pgid}\0${startTime}`).digest('hex'),
  };
}

export function captureProcessIdentity(pid: number): PersistedProcessIdentity | null {
  const identity = inspectProcess(pid);
  if (!identity || identity.pgid !== identity.pid) return null;
  return {
    pid: identity.pid,
    pgid: identity.pgid,
    start_time: identity.startTime,
    fingerprint: identity.fingerprint,
  };
}

export function captureSpawnedProcessIdentity(pid: number, attempts: number = 5): PersistedProcessIdentity | null {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const identity = captureProcessIdentity(pid);
    if (identity) return identity;
    if (attempt + 1 < attempts) waitSync(10);
  }
  return null;
}

function matchesPersistedIdentity(expected: PersistedProcessIdentity, current: ProcessIdentity | null): boolean {
  return Boolean(
    current
      && current.pid === expected.pid
      && current.pgid === expected.pgid
      && current.startTime === expected.start_time
      && current.fingerprint === expected.fingerprint
      && current.pgid === current.pid,
  );
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
    return { status: 'reaped', pid: persisted.pid, pgid: persisted.pgid, reason: 'recorded process group received TERM then KILL', signals };
  } catch (error) {
    return { status: 'signal-failed', pid: persisted.pid, pgid: persisted.pgid, reason: error instanceof Error ? error.message : String(error), signals };
  }
}

export function recoverSessionOrphanState(sessionDir: string, state: Record<string, unknown>): OrphanReapResult | null {
  const pid = Number(state.orphan_child_pid || state.active_child_pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
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
