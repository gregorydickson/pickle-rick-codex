import crypto from 'node:crypto';
import {
  acquireSupervisorLease,
  acceptRuntimeHandoff,
  recordSupervisorCheckpoint,
  readLogicalPipeline,
  releaseSupervisorLease,
  renewSupervisorLease,
  terminateLogicalPipeline,
  watchdogRecoverSupervisor,
  type SupervisorLease,
  type InstalledRuntimeDescriptor,
} from './durable-supervisor.js';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';

export const DEFAULT_SUPERVISOR_LEASE_TTL_MS = 60_000;

export class DurableOwnershipDrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableOwnershipDrainError';
  }
}

export function isDurableOwnershipDrainError(error: unknown): error is DurableOwnershipDrainError {
  return error instanceof DurableOwnershipDrainError;
}

export interface DurableRuntimeOwnership {
  readonly ownerId: string;
  lease(): SupervisorLease;
  resumeCheckpoint(): Record<string, unknown> | null;
  recordCheckpoint(checkpoint: Record<string, unknown>): void;
  assertOwned(): void;
  finish(exitReason: string): void;
}

interface RuntimeOwnershipOptions {
  ownerId?: string;
  ttlMs?: number;
  renewEveryMs?: number;
  handoffRequestId?: string;
  targetRuntime?: InstalledRuntimeDescriptor;
}

function ownerPid(ownerId: string): number | null {
  const match = ownerId.match(/^runner:(\d+):/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function executorAlive(ownerId: string, identity?: PersistedProcessIdentity): boolean {
  const pid = ownerPid(ownerId);
  if (pid === null) return false;
  // Legacy leases lack immutable identity. Never declare an unexpired legacy
  // owner dead solely because the new field is absent; wait for lease expiry.
  if (!identity) return processAlive(pid);
  if (identity.pid !== pid) return false;
  return inspectProcessLivenessIdentity(identity) === 'matched';
}

export function startDurableRuntimeOwnership(
  sessionDir: string,
  options: RuntimeOwnershipOptions = {},
): DurableRuntimeOwnership {
  const ttlMs = options.ttlMs ?? DEFAULT_SUPERVISOR_LEASE_TTL_MS;
  const renewEveryMs = options.renewEveryMs ?? Math.max(100, Math.floor(ttlMs / 3));
  const ownerId = options.ownerId ?? `runner:${process.pid}:${crypto.randomUUID()}`;
  const ownerIdentity = captureProcessLivenessIdentity(process.pid);
  if (!ownerIdentity) throw new Error('Cannot capture immutable durable runner process identity.');
  const current = readLogicalPipeline(sessionDir);
  if (current.control_state !== 'autonomous_execution' || current.terminal_state !== null) {
    throw new Error(`Logical pipeline is not runnable from ${current.control_state}/${String(current.terminal_state)}.`);
  }

  let activeLease: SupervisorLease;
  let recoveredCheckpoint: Record<string, unknown> | null = null;
  if (!current.lease && options.handoffRequestId && options.targetRuntime) {
    activeLease = acceptRuntimeHandoff(
      sessionDir,
      options.handoffRequestId,
      ownerId,
      ttlMs,
      options.targetRuntime,
      { ownerIdentity },
    ).lease;
  } else if (!current.lease) {
    activeLease = acquireSupervisorLease(sessionDir, { ownerId, ttlMs, ownerIdentity });
  } else {
    const recovery = watchdogRecoverSupervisor(sessionDir, { ownerId, ttlMs, ownerIdentity, executorAlive });
    if (!recovery.recovered || !recovery.lease || recovery.lease.owner_id !== ownerId) {
      throw new Error(`Logical pipeline is already owned by live executor ${current.lease.owner_id}.`);
    }
    activeLease = recovery.lease;
    const checkpointGeneration = Number(recovery.resume_checkpoint?.lease_generation);
    recoveredCheckpoint = Number.isInteger(checkpointGeneration)
      && checkpointGeneration > 0
      && checkpointGeneration < activeLease.generation
      ? recovery.resume_checkpoint
      : null;
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
    if (renewalError) throw new DurableOwnershipDrainError(`Durable supervisor lease renewal failed: ${renewalError.message}`);
    const state = readLogicalPipeline(sessionDir);
    if (!state.lease || state.lease.owner_id !== ownerId || state.lease.token !== activeLease.token) {
      throw new DurableOwnershipDrainError('Durable supervisor lease ownership changed during execution.');
    }
    if (Date.parse(state.lease.expires_at) <= Date.now()) throw new DurableOwnershipDrainError('Durable supervisor lease expired during execution.');
    activeLease = state.lease;
  };

  return {
    ownerId,
    lease: () => activeLease,
    resumeCheckpoint: () => recoveredCheckpoint,
    recordCheckpoint(checkpoint: Record<string, unknown>): void {
      assertOwned();
      recordSupervisorCheckpoint(sessionDir, ownerId, activeLease.token, checkpoint);
    },
    assertOwned,
    finish(exitReason: string): void {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      const current = readLogicalPipeline(sessionDir);
      if (current.control_state === 'prd_revision_required') return;
      if (exitReason === 'runtime_handoff'
        && (!current.lease || current.lease.owner_id !== ownerId || current.lease.token !== activeLease.token)) return;
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
