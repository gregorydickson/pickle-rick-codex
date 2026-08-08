import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';

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

export interface SimplificationPolicyInput {
  complexityTier?: unknown;
  priority?: unknown;
  explicitlyRequired?: unknown;
  changedPathCount?: number;
  reviewFindings?: unknown;
}

export function simplificationRequired(input: SimplificationPolicyInput): boolean {
  if (input.explicitlyRequired === true) return true;
  const tier = String(input.complexityTier || '').trim().toLowerCase();
  const priority = String(input.priority || '').trim().toUpperCase();
  if (tier === 'high' || tier === 'critical' || priority === 'P0') return true;
  if (Number(input.changedPathCount || 0) >= 8) return true;
  const findings = Array.isArray(input.reviewFindings) ? input.reviewFindings : [];
  return findings.some((finding) => (
    typeof finding === 'string'
    && /\b(?:simplif(?:y|ication)|unnecessary complexity|duplication|dead code)\b/i.test(finding)
  ));
}

export interface WorkerLifecycleArtifact {
  schema_version: 1;
  phase: WorkerLifecyclePhase;
  ticket_id: string;
  summary: string;
  [key: string]: unknown;
}

export class WorkerLifecycleRefusalError extends Error {
  readonly kind = 'worker-lifecycle-refusal';
  readonly phase: WorkerLifecyclePhase;
  readonly artifactPath: string;
  readonly artifact: WorkerLifecycleArtifact;
  remediationIdentity: string | null = null;

  constructor(
    phase: WorkerLifecyclePhase,
    artifactPath: string,
    artifact: WorkerLifecycleArtifact,
  ) {
    super(`worker-lifecycle-refusal: ${phase} requested changes; evidence persisted at ${artifactPath}`);
    this.name = 'WorkerLifecycleRefusalError';
    this.phase = phase;
    this.artifactPath = artifactPath;
    this.artifact = artifact;
  }
}

export function isWorkerLifecycleRefusalError(error: unknown): error is WorkerLifecycleRefusalError {
  return error instanceof WorkerLifecycleRefusalError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function assertReviewVerdict(artifact: Record<string, unknown>, phase: WorkerLifecyclePhase): void {
  if (artifact.verdict !== 'approved' && artifact.verdict !== 'changes_requested') {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} must record verdict "approved" or "changes_requested"`);
  }
  if (!nonEmptyStrings(artifact.evidence)) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} must include non-empty evidence`);
  }
  if (artifact.verdict === 'changes_requested' && !nonEmptyStrings(artifact.findings)) {
    throw new Error(`worker-lifecycle-invalid-artifact: changes_requested ${phase} must include non-empty findings`);
  }
}

export function workerLifecycleArtifactPath(
  sessionDir: string,
  ticketId: string,
  phase: WorkerLifecyclePhase,
): string {
  return path.join(sessionDir, 'worker-lifecycle', ticketId, `${phase}.json`);
}

export function archiveWorkerLifecycleRefusal(
  sessionDir: string,
  ticketId: string,
  phase: WorkerLifecyclePhase,
  artifact: WorkerLifecycleArtifact,
): string {
  const archiveDir = path.join(sessionDir, 'worker-lifecycle-refusals', ticketId);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const priorSequences = fs.readdirSync(archiveDir)
    .map((name) => Number.parseInt(name.match(/^(\d+)-/)?.[1] || '', 10))
    .filter(Number.isSafeInteger);
  const sequence = (priorSequences.length > 0 ? Math.max(...priorSequences) : 0) + 1;
  const archivePath = path.join(archiveDir, `${String(sequence).padStart(4, '0')}-${phase}.json`);
  atomicWriteJson(archivePath, artifact);
  return archivePath;
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

  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
    throw new Error(`worker-lifecycle-invalid-artifact: ${phase} artifact must be a regular file no larger than 1 MiB`);
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
      assertReviewVerdict(parsed, phase);
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
      assertReviewVerdict(parsed, phase);
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
      if ((parsed.verdict !== 'all_pass' && parsed.verdict !== 'changes_requested') || parsed.implementation_reviewed !== true) {
        throw new Error('worker-lifecycle-invalid-artifact: conformance must review the implementation and record all_pass or changes_requested');
      }
      const checks = Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : [];
      const actual = new Map<string, Record<string, unknown>>();
      for (const check of checks) {
        if (isRecord(check) && typeof check.criterion === 'string') actual.set(check.criterion, check);
      }
      const exactCoverage = checks.length === acceptanceCriteria.length
        && acceptanceCriteria.every((criterion) => {
          const check = actual.get(criterion);
          return (check?.status === 'pass' || check?.status === 'fail')
            && typeof check.evidence === 'string'
            && check.evidence.trim().length > 0;
        });
      if (!exactCoverage) {
        throw new Error('worker-lifecycle-invalid-artifact: conformance must cover every exact acceptance criterion with pass/fail evidence');
      }
      const failedChecks = checks.filter((check) => isRecord(check) && check.status === 'fail');
      if (parsed.verdict === 'all_pass' && failedChecks.length > 0) {
        throw new Error('worker-lifecycle-invalid-artifact: all_pass conformance must pass every acceptance criterion');
      }
      if (parsed.verdict === 'changes_requested') {
        if (failedChecks.length === 0) {
          throw new Error('worker-lifecycle-invalid-artifact: changes_requested conformance must fail at least one acceptance criterion');
        }
        if (!nonEmptyStrings(parsed.findings)) {
          throw new Error('worker-lifecycle-invalid-artifact: changes_requested conformance must include non-empty findings');
        }
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
