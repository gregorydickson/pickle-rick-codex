import path from 'node:path';
import { StateManager } from './state-manager.js';
import { reconcileVerifiedRefinementRepositoryAdvance } from './refinement-artifacts.js';

/**
 * Restore only the repository boundary recorded by the active durable ticket
 * transaction. Refuse to guess at a commit when that journal is absent.
 */
export function reconstructWorkspaceFromDurableCheckpoint(
  sessionDir: string,
  assertDurableOwnership: () => void = () => {},
): string {
  assertDurableOwnership();
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const workingDir = String(state.working_dir || '');
  if (!workingDir) throw new Error('workspace-reconstruction-missing-working-directory');
  const result = reconcileVerifiedRefinementRepositoryAdvance(sessionDir, workingDir);
  assertDurableOwnership();
  if (!result.reconciled || !result.ticketId) {
    throw new Error('workspace-reconstruction-missing-durable-checkpoint');
  }
  manager.update(statePath, (current) => {
    current.recovery_required = false;
    current.recovery_kind = null;
    current.recovery_reason = null;
    if (current.last_exit_reason === 'recovery_required') current.last_exit_reason = null;
    return current;
  });
  assertDurableOwnership();
  return result.ticketId;
}
