import crypto from 'node:crypto';
import {
  acquireSupervisorLease,
  readLogicalPipeline,
  releaseSupervisorLease,
  renewSupervisorLease,
  terminateLogicalPipeline,
  watchdogRecoverSupervisor,
  type SupervisorLease,
} from './durable-supervisor.js';

export const DEFAULT_SUPERVISOR_LEASE_TTL_MS = 60_000;

export interface DurableRuntimeOwnership {
  readonly ownerId: string;
  lease(): SupervisorLease;
  assertOwned(): void;
  finish(exitReason: string): void;
}

interface RuntimeOwnershipOptions {
  ownerId?: string;
  ttlMs?: number;
  renewEveryMs?: number;
}

function ownerPid(ownerId: string): number | null {
  const match = ownerId.match(/^runner:(\d+):/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function executorAlive(ownerId: string): boolean {
  const pid = ownerPid(ownerId);
  return pid !== null && processAlive(pid);
}

export function startDurableRuntimeOwnership(
  sessionDir: string,
  options: RuntimeOwnershipOptions = {},
): DurableRuntimeOwnership {
  const ttlMs = options.ttlMs ?? DEFAULT_SUPERVISOR_LEASE_TTL_MS;
  const renewEveryMs = options.renewEveryMs ?? Math.max(100, Math.floor(ttlMs / 3));
  const ownerId = options.ownerId ?? `runner:${process.pid}:${crypto.randomUUID()}`;
  const current = readLogicalPipeline(sessionDir);
  if (current.control_state !== 'autonomous_execution' || current.terminal_state !== null) {
    throw new Error(`Logical pipeline is not runnable from ${current.control_state}/${String(current.terminal_state)}.`);
  }

  let activeLease: SupervisorLease;
  if (!current.lease) {
    activeLease = acquireSupervisorLease(sessionDir, { ownerId, ttlMs });
  } else {
    const recovery = watchdogRecoverSupervisor(sessionDir, { ownerId, ttlMs, executorAlive });
    if (!recovery.recovered || !recovery.lease || recovery.lease.owner_id !== ownerId) {
      throw new Error(`Logical pipeline is already owned by live executor ${current.lease.owner_id}.`);
    }
    activeLease = recovery.lease;
  }

  let renewalError: Error | null = null;
  let finished = false;
  const timer = setInterval(() => {
    try {
      activeLease = renewSupervisorLease(sessionDir, {
        ownerId,
        token: activeLease.token,
        ttlMs,
      });
    } catch (error) {
      renewalError = error instanceof Error ? error : new Error(String(error));
      clearInterval(timer);
    }
  }, renewEveryMs);
  timer.unref();

  const assertOwned = (): void => {
    if (renewalError) throw new Error(`Durable supervisor lease renewal failed: ${renewalError.message}`, { cause: renewalError });
    const state = readLogicalPipeline(sessionDir);
    if (!state.lease || state.lease.owner_id !== ownerId || state.lease.token !== activeLease.token) {
      throw new Error('Durable supervisor lease ownership changed during execution.');
    }
    if (Date.parse(state.lease.expires_at) <= Date.now()) throw new Error('Durable supervisor lease expired during execution.');
    activeLease = state.lease;
  };

  return {
    ownerId,
    lease: () => activeLease,
    assertOwned,
    finish(exitReason: string): void {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      assertOwned();
      if (exitReason === 'success') {
        terminateLogicalPipeline(sessionDir, 'completed', { ownerId, token: activeLease.token });
      } else if (exitReason === 'cancelled') {
        terminateLogicalPipeline(sessionDir, 'cancelled', { ownerId, token: activeLease.token });
      } else {
        releaseSupervisorLease(sessionDir, ownerId, activeLease.token);
      }
    },
  };
}
