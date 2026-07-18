import type { WorkerLifecycleArtifact, WorkerLifecyclePhase } from './worker-lifecycle.js';

const REQUIRED_PRIOR: Partial<Record<WorkerLifecyclePhase, WorkerLifecyclePhase[]>> = {
  plan: ['research', 'research_review'],
  implement: ['plan', 'plan_review'],
  conformance: ['implement', 'review', 'simplify'],
};

export function assertAcPhaseBoundary(
  phase: WorkerLifecyclePhase,
  artifact: WorkerLifecycleArtifact,
  priorArtifacts: WorkerLifecycleArtifact[],
  acceptanceCriteria: string[],
): void {
  const seen = new Set(priorArtifacts.map((entry) => entry.phase));
  const missing = (REQUIRED_PRIOR[phase] || []).filter((required) => !seen.has(required));
  if (missing.length) throw new Error(`ac-phase-gate-failed: ${phase} missing lifecycle evidence: ${missing.join(', ')}`);
  if (phase !== 'conformance') return;
  const checks = Array.isArray(artifact.acceptance_criteria) ? artifact.acceptance_criteria : [];
  const exact = new Set(checks
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => entry.status === 'pass' && typeof entry.evidence === 'string' && entry.evidence.trim())
    .map((entry) => entry.criterion));
  if (checks.length !== acceptanceCriteria.length || acceptanceCriteria.some((criterion) => !exact.has(criterion))) {
    throw new Error('ac-phase-gate-failed: conformance lacks exact acceptance-criterion evidence');
  }
}
