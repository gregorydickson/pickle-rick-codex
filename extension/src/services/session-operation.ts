import fs from 'node:fs';
import path from 'node:path';
import { StateManager } from './state-manager.js';

export type ReleaseSessionOperation = () => void;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSessionOperation(
  sessionDir: string,
  message = `Another session operation is already running for session: ${sessionDir}`,
  allowedTmuxLaunchOwnerPid: number | null = null,
): ReleaseSessionOperation {
  const manager = new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  const leasePath = path.join(sessionDir, '.session-operation');
  assertNoForeignTmuxLaunch(sessionDir, allowedTmuxLaunchOwnerPid);
  try {
    manager.acquireLock(leasePath);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  try {
    assertNoForeignTmuxLaunch(sessionDir, allowedTmuxLaunchOwnerPid);
  } catch (error) {
    manager.releaseLock(leasePath);
    throw error;
  }
  return () => manager.releaseLock(leasePath);
}

export function assertSessionOperationAvailable(sessionDir: string): void {
  const release = acquireSessionOperation(sessionDir);
  release();
}

export function sessionOperationOwnerPid(sessionDir: string): number | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(sessionDir, '.session-operation.lock'), 'utf8'),
    ) as Record<string, unknown>;
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function assertNoForeignTmuxLaunch(
  sessionDir: string,
  allowedOwnerPid: number | null = null,
): void {
  try {
    const ownerPid = Number(fs.readFileSync(path.join(sessionDir, '.tmux-launch.lock'), 'utf8').trim());
    if (ownerPid !== process.pid && ownerPid !== allowedOwnerPid && processAlive(ownerPid)) {
      throw new Error(`A tmux launch is already in progress for session: ${sessionDir}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('A tmux launch is already in progress')) throw error;
  }
}
