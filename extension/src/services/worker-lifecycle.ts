import fs from 'node:fs';
import path from 'node:path';

export const WORKER_LIFECYCLE_PHASES = [
  'research',
  'research_review',
  'plan',
  'plan_review',
  'implement',
  'review',
  'simplify',
  'conformance',
] as const;

export type WorkerLifecyclePhase = typeof WORKER_LIFECYCLE_PHASES[number];

export interface WorkerLifecycleArtifact {
  schema_version: 1;
  phase: WorkerLifecyclePhase;
  ticket_id: string;
  summary: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function assertApprovedReview(artifact: Record<string, unknown>, phase: WorkerLifecyclePhase): void {
  if (artifact.verdict !== 'approved') {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} must record verdict "approved"`);
  }
  if (!nonEmptyStrings(artifact.evidence)) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} must include non-empty evidence`);
  }
}

export function workerLifecycleArtifactPath(
  sessionDir: string,
  ticketId: string,
  phase: WorkerLifecyclePhase,
): string {
  return path.join(sessionDir, 'worker-lifecycle', ticketId, `${phase}.json`);
}

export function prepareWorkerLifecycleArtifact(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.rmSync(filePath, { force: true });
}

export function readAndValidateWorkerLifecycleArtifact(
  filePath: string,
  phase: WorkerLifecyclePhase,
  ticketId: string,
  acceptanceCriteria: string[],
): WorkerLifecycleArtifact {
  if (!fs.existsSync(filePath)) {
    throw new Error(`worker-lifecycle-missing-artifact: ${phase} did not write ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} wrote invalid JSON to ${filePath}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} artifact must be a JSON object`);
  }
  if (parsed.schema_version !== 1 || parsed.phase !== phase || parsed.ticket_id !== ticketId) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} artifact identity does not match this ticket and phase`);
  }
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} artifact must include a non-empty summary`);
  }

  switch (phase) {
    case 'research':
      if (!nonEmptyStrings(parsed.evidence)) {
        throw new Error('worker-lifecycle-invalid-artifact: research must include non-empty evidence');
      }
      break;
    case 'research_review':
    case 'plan_review':
      assertApprovedReview(parsed, phase);
      break;
    case 'plan':
      if (!nonEmptyStrings(parsed.steps)) {
        throw new Error('worker-lifecycle-invalid-artifact: plan must include non-empty steps');
      }
      break;
    case 'implement':
      if (!Array.isArray(parsed.files_changed) || !nonEmptyStrings(parsed.verification)) {
        throw new Error('worker-lifecycle-invalid-artifact: implement must include files_changed and non-empty verification');
      }
      break;
    case 'review':
      assertApprovedReview(parsed, phase);
      if (parsed.implementation_reviewed !== true) {
        throw new Error('worker-lifecycle-invalid-artifact: review must confirm implementation_reviewed');
      }
      break;
    case 'simplify':
      if (!nonEmptyStrings(parsed.verification)) {
        throw new Error('worker-lifecycle-invalid-artifact: simplify must include non-empty verification');
      }
      break;
    case 'conformance': {
      if (parsed.verdict !== 'all_pass' || parsed.implementation_reviewed !== true) {
        throw new Error('worker-lifecycle-invalid-artifact: conformance must review the implementation and record all_pass');
      }
      const checks = Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : [];
      const actual = new Map<string, Record<string, unknown>>();
      for (const check of checks) {
        if (isRecord(check) && typeof check.criterion === 'string') actual.set(check.criterion, check);
      }
      const exactCoverage = checks.length === acceptanceCriteria.length
        && acceptanceCriteria.every((criterion) => {
          const check = actual.get(criterion);
          return check?.status === 'pass'
            && typeof check.evidence === 'string'
            && check.evidence.trim().length > 0;
        });
      if (!exactCoverage) {
        throw new Error('worker-lifecycle-invalid-artifact: conformance must pass every exact acceptance criterion with evidence');
      }
      break;
    }
  }
  return parsed as WorkerLifecycleArtifact;
}

export function serializeApprovedWorkerContext(artifacts: WorkerLifecycleArtifact[]): string {
  if (artifacts.length === 0) return 'No earlier lifecycle artifacts exist for this phase.';
  return artifacts
    .map((artifact) => `Approved ${artifact.phase} artifact:\n${JSON.stringify(artifact, null, 2)}`)
    .join('\n\n');
}
