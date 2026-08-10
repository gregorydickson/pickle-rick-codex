import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCodexSucceeded,
  CodexCancelCheckError,
  hasPromiseToken,
  runCodexExecMonitored,
} from './codex.js';
import {
  citadelSystemBlockFailureIdentity,
  deriveCitadelAcceptanceCriteria,
  type CitadelSystemBlockArtifact,
} from './citadel.js';
import { assertRecordedActiveChildRecovered } from './orphan-reaper.js';
import { atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import {
  monitoredProcessStateCallbacks,
  recoverMonitoredProcessOwnership,
} from './monitored-process-ownership.js';
import { isDurableOwnershipDrainError } from './durable-runtime.js';
import { createDisposableDetachedWorktree } from './disposable-worktree.js';
import { getHeadSha, getWorkingTreeFingerprint } from './git-utils.js';

type RecoveryMechanism = 'schema_scaffold_replay' | 'evidence_bundle_reconstruction'
  | 'criterion_sharded_reconstruction';

interface ReviewerAttempt {
  ordinal: number;
  status: 'started' | 'interrupted' | 'rejected' | 'resolved';
  candidate_path: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  strategy_epoch?: number;
  strategy_id?: string;
  strategy_instruction?: string;
  strategy_material_hash?: string;
  input_identity?: string;
}

interface ReviewerRecoveryJournal {
  schema_version: 1;
  review_identity: string;
  diagnostic_identity: string;
  mechanism: RecoveryMechanism;
  failed_candidate_hashes: string[];
  validator_invariants: string[];
  mechanism_history: RecoveryMechanism[];
  status: 'started' | 'interrupted' | 'rejected' | 'resolved';
  attempts: ReviewerAttempt[];
  resolution?: {
    artifact_path: string;
    instruction: string;
    runtime_artifacts: RuntimeArtifacts;
    runtime_manifest_sha256: string;
    resolved_at: string;
  };
  strategy_epoch?: number;
  updated_at: string;
}

interface DiagnosticArtifact {
  schema_version: 1;
  review_identity: string;
  diagnostic_identity: string;
  mechanism: RecoveryMechanism;
  failed_candidate_hashes: string[];
  validator_invariants: string[];
  instruction: string;
  rationale: string;
}

interface RuntimeArtifacts {
  schema_version: 1;
  mechanism: RecoveryMechanism;
  scaffold_path: string | null;
  evidence_bundle_path: string | null;
  criterion_shard_bundle_path: string | null;
  manifest_path: string;
  validator_path: string;
  validator_command: string;
}

interface CriterionShardResult {
  schema_version: 1;
  shard_id: string;
  criterion: string;
  checkpoint_head: string;
  reviewed_range: string;
  status: 'pass' | 'fail';
  evidence: string[];
  repository_paths: string[];
  repository_evidence: Array<{ path: string; sha256: string; observation: string }>;
  checks_cited: string[];
  findings: unknown[];
}

interface CriterionShardAttempt {
  ordinal: number;
  status: 'started' | 'interrupted' | 'rejected' | 'resolved';
  candidate_path: string;
  candidate_sha256: string | null;
  worktree_path?: string;
  worktree_checkpoint_head?: string;
  strategy_id: string;
  strategy_material_hash: string;
  evidence_route: string;
  strategy_epoch: number;
  strategy_instruction: string;
  strategy_artifact_path: string | null;
  strategy_artifact_sha256: string | null;
  started_at: string;
  completed_at?: string;
  error?: string;
}

interface CriterionShardWork {
  shard_id: string;
  criterion: string;
  status: 'pending' | 'running' | 'resolved';
  result_path: string;
  result_sha256: string | null;
  attempts: CriterionShardAttempt[];
}

interface CriterionShardJournal {
  schema_version: 1;
  review_identity: string;
  diagnostic_identity: string;
  shard_plan_identity: string;
  bounded_strategy_limit: number;
  replan_after_attempt: number;
  status: 'pending' | 'running' | 'resolved';
  shards: CriterionShardWork[];
  updated_at: string;
}

interface RecoveryOptions {
  timeoutMs?: number;
  assertDurableOwnership?: () => void;
  faultInjection?: (point: 'artifact-ready-before-resolution' | 'journal-resolved-before-state'
    | 'resolved-after-persist' | 'controller-strategy-ready-before-child') => void;
}

interface ReviewState extends Record<string, unknown> {
  schema_version: 1;
  review_identity: string;
  recovery_epoch: number;
  strategy_id: string;
  status: string;
  attempts: Array<Record<string, unknown>>;
}

export type CitadelReviewerRecoveryResult = {
  kind: 'resolved' | 'recovery_scheduled';
  diagnostic_identity: string;
};

const MECHANISMS: RecoveryMechanism[] = [
  'schema_scaffold_replay',
  'evidence_bundle_reconstruction',
  'criterion_sharded_reconstruction',
];
const BOUNDED_CRITERION_SHARD_STRATEGY_LIMIT = 3;
const CRITERION_SHARD_STRATEGY_INSTRUCTIONS = {
  direct_repository_evidence: 'Read the eligible changed files directly, hash their bytes, and construct the shard result from repository evidence.',
  runtime_citation_scaffold: 'Complete the runtime-provided citation scaffold only after independently checking every preseeded repository identity.',
  authenticated_diff_inventory_two_pass: 'First audit the authenticated diff inventory against the repository; then perform an independent criterion decision pass and serialize only the audited result.',
  failure_bound_evidence_replan: 'Use the authenticated rejection ledger to avoid every prior material approach, re-derive evidence from exact repository bytes, and produce a new independently checked result.',
} as const;

function expectedCriterionShardStrategy(ordinal: number): {
  id: keyof typeof CRITERION_SHARD_STRATEGY_INSTRUCTIONS;
  route: string;
  epoch: number;
  instruction: string;
} {
  if (ordinal === 1) return {
    id: 'direct_repository_evidence', route: 'direct_review', epoch: 1,
    instruction: CRITERION_SHARD_STRATEGY_INSTRUCTIONS.direct_repository_evidence,
  };
  if (ordinal === 2) return {
    id: 'runtime_citation_scaffold', route: 'preseeded_citation', epoch: 1,
    instruction: CRITERION_SHARD_STRATEGY_INSTRUCTIONS.runtime_citation_scaffold,
  };
  if (ordinal === 3) return {
    id: 'authenticated_diff_inventory_two_pass', route: 'diff_inventory', epoch: 1,
    instruction: CRITERION_SHARD_STRATEGY_INSTRUCTIONS.authenticated_diff_inventory_two_pass,
  };
  return {
    id: 'failure_bound_evidence_replan', route: 'replanned_evidence_inventory', epoch: ordinal - 3,
    instruction: CRITERION_SHARD_STRATEGY_INSTRUCTIONS.failure_bound_evidence_replan,
  };
}
class ReviewerRecoveryFault extends Error {}
class ReviewerRecoveryPending extends Error {}
class ReviewerRecoveryIntegrityError extends Error {}
const VALIDATOR_INVARIANTS = [
  'The candidate is exactly one JSON object with only the canonical Citadel report keys.',
  'reviewed_range exactly matches the immutable requested git range.',
  'acceptance_criteria_checked exactly covers every required sealed acceptance criterion.',
  'findings is an array and every finding contains every required typed field.',
  'Every critical or high finding has non-empty ticket_ids, acceptance_criteria, and paths.',
  'An approve verdict requires the exact durable approval token after artifact validation.',
];

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function durableOwnershipDrainCause(error: unknown): Error | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (isDurableOwnershipDrainError(current)) return current;
    if (current instanceof CodexCancelCheckError) {
      current = current.cause;
      continue;
    }
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }
  return null;
}

function recoveryJournalPath(sessionDir: string): string {
  return path.join(sessionDir, 'citadel-reviewer-contract-recovery.json');
}

function readReviewState(sessionDir: string): ReviewState {
  const state = readJsonFile<ReviewState>(path.join(sessionDir, 'citadel-review-state.json'), null);
  if (!state || state.schema_version !== 1 || typeof state.review_identity !== 'string'
    || !Number.isInteger(state.recovery_epoch) || !Array.isArray(state.attempts)) {
    throw new Error('Citadel reviewer contract recovery requires a valid durable review state.');
  }
  return state;
}

function failedCandidateHashes(state: ReviewState): string[] {
  const hashes = state.attempts
    .filter((attempt) => ['rejected', 'interrupted'].includes(String(attempt.status)))
    .map((attempt) => {
      if (typeof attempt.candidate_hash === 'string' && /^[a-f0-9]{64}$/.test(attempt.candidate_hash)) {
        return attempt.candidate_hash;
      }
      return sha256({
        ordinal: attempt.ordinal,
        status: attempt.status,
        validation_error: attempt.validation_error,
        candidate_path: attempt.candidate_path,
      });
    });
  if (hashes.length === 0) throw new Error('Citadel reviewer recovery has no failed candidate evidence.');
  return [...new Set(hashes)];
}

function selectMechanism(
  state: ReviewState,
  used: Set<RecoveryMechanism>,
  priorRecovery: Record<string, unknown> | undefined,
): RecoveryMechanism | null {
  const failures = state.attempts.map((attempt) => String(attempt.validation_error || '')).join('\n');
  const preferred = /schema|json|field|key|array|required|coverage/i.test(failures)
    ? MECHANISMS
    : [...MECHANISMS].reverse();
  const unused = preferred.find((mechanism) => !used.has(mechanism));
  if (unused) return unused;
  const priorHashes = Array.isArray(priorRecovery?.failed_candidate_hashes)
    ? priorRecovery.failed_candidate_hashes : [];
  const currentHashes = failedCandidateHashes(state);
  return currentHashes.some((hash) => !priorHashes.includes(hash))
    ? 'criterion_sharded_reconstruction' : null;
}

function diagnosticContext(
  state: ReviewState,
  block: CitadelSystemBlockArtifact,
  mechanism: RecoveryMechanism,
) {
  const hashes = failedCandidateHashes(state);
  const diagnosticIdentity = sha256({
    review_identity: state.review_identity,
    system_failure_identity: block.failure_identity,
    evidence: block.evidence,
    checks: block.checks,
    mechanism,
    failed_candidate_hashes: hashes,
    validator_invariants: VALIDATOR_INVARIANTS,
  });
  return { mechanism, hashes, diagnosticIdentity };
}

function controllerCanonicalStrategy(
  sessionDir: string,
  state: ReviewState,
  block: CitadelSystemBlockArtifact,
  diagnosticIdentity: string,
  hashes: string[],
  strategyEpoch: number,
  priorAttempts: ReviewerAttempt[],
) {
  const strategyId = 'controller_canonical_synthesis';
  const strategyInstruction = `Deterministically synthesize the canonical criterion-sharded diagnostic for outer strategy epoch ${strategyEpoch}, then independently validate every criterion shard.`;
  const priorLedgerRoot = sha256(priorAttempts.map((entry) => ({
    ordinal: entry.ordinal,
    status: entry.status,
    strategy_epoch: entry.strategy_epoch ?? null,
    strategy_id: entry.strategy_id ?? null,
    strategy_instruction: entry.strategy_instruction ?? null,
    strategy_material_hash: entry.strategy_material_hash ?? null,
    input_identity: entry.input_identity ?? null,
    error: entry.error ?? null,
    completed_at: entry.completed_at ?? null,
  })));
  const inputIdentity = sha256({
    review_identity: state.review_identity,
    failure_identity: block.failure_identity,
    ordered_failed_candidate_hashes: hashes,
    validator_invariants: VALIDATOR_INVARIANTS,
    prior_ledger_root: priorLedgerRoot,
    mechanism: 'criterion_sharded_reconstruction',
    strategy_epoch: strategyEpoch,
  });
  const materialHash = sha256({ strategyId, strategyInstruction, inputIdentity });
  const candidatePath = path.join(
    sessionDir,
    'citadel-reviewer-contract-repairs',
    'controller-strategies',
    `${diagnosticIdentity}-epoch-${strategyEpoch}.json`,
  );
  const artifact: DiagnosticArtifact = {
    schema_version: 1,
    review_identity: state.review_identity,
    diagnostic_identity: diagnosticIdentity,
    mechanism: 'criterion_sharded_reconstruction',
    failed_candidate_hashes: hashes,
    validator_invariants: [...VALIDATOR_INVARIANTS],
    instruction: strategyInstruction,
    rationale: `Trusted controller synthesis ${materialHash} advances exhausted outer recovery without weakening the canonical validator.`,
  };
  return { strategyId, strategyInstruction, priorLedgerRoot, inputIdentity, materialHash, candidatePath, artifact };
}

function validateArtifact(value: unknown, expected: {
  reviewIdentity: string;
  diagnosticIdentity: string;
  mechanism: RecoveryMechanism;
  hashes: string[];
}): DiagnosticArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Citadel reviewer contract diagnostic must be one JSON object.');
  }
  const record = value as Record<string, unknown>;
  const keys = [
    'schema_version', 'review_identity', 'diagnostic_identity', 'mechanism',
    'failed_candidate_hashes', 'validator_invariants', 'instruction', 'rationale',
  ];
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('Citadel reviewer contract diagnostic keys do not match the strict schema.');
  }
  if (record.schema_version !== 1 || record.review_identity !== expected.reviewIdentity
    || record.diagnostic_identity !== expected.diagnosticIdentity || record.mechanism !== expected.mechanism
    || JSON.stringify(record.failed_candidate_hashes) !== JSON.stringify(expected.hashes)
    || JSON.stringify(record.validator_invariants) !== JSON.stringify(VALIDATOR_INVARIANTS)
    || typeof record.instruction !== 'string' || !record.instruction.trim()
    || typeof record.rationale !== 'string' || !record.rationale.trim()) {
    throw new Error('Citadel reviewer contract diagnostic is not bound to the failed candidates and validator invariants.');
  }
  return record as unknown as DiagnosticArtifact;
}

function validateCriterionShard(
  value: unknown,
  shardId: string,
  criterion: string,
  expected: {
    checkpointHead: string;
    reviewedRange: string;
    repositoryPaths: string[];
    checks: string[];
    workingDir: string;
  },
): CriterionShardResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Criterion shard result must be one JSON object.');
  }
  const record = value as Record<string, unknown>;
  const keys = [
    'schema_version', 'shard_id', 'criterion', 'checkpoint_head', 'reviewed_range',
    'status', 'evidence', 'repository_paths', 'repository_evidence', 'checks_cited', 'findings',
  ];
  const repositoryEvidence = Array.isArray(record.repository_evidence)
    ? record.repository_evidence : [];
  const resultRepositoryPaths = Array.isArray(record.repository_paths)
    ? record.repository_paths : [];
  const validRepositoryEvidence = repositoryEvidence.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join('\0') !== ['observation', 'path', 'sha256'].sort().join('\0')
      || typeof item.path !== 'string' || !expected.repositoryPaths.includes(item.path)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.observation !== 'string' || item.observation.trim().length < 20) return false;
    const resolvedPath = path.resolve(expected.workingDir, item.path);
    const root = `${path.resolve(expected.workingDir)}${path.sep}`;
    if (!resolvedPath.startsWith(root)) return false;
    try {
      const stat = fs.lstatSync(resolvedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      return crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex') === item.sha256;
    } catch {
      return false;
    }
  });
  const findings = Array.isArray(record.findings) ? record.findings : [];
  const validFindings = findings.every((finding) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
    const item = finding as Record<string, unknown>;
    const required = [
      'severity', 'title', 'evidence', 'file', 'line', 'recommendation',
      'ticket_ids', 'acceptance_criteria', 'paths',
    ];
    return required.every((key) => Object.hasOwn(item, key))
      && typeof item.title === 'string' && Boolean(item.title.trim())
      && typeof item.evidence === 'string' && Boolean(item.evidence.trim())
      && Array.isArray(item.ticket_ids) && Array.isArray(item.acceptance_criteria) && Array.isArray(item.paths);
  });
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')
    || record.schema_version !== 1 || record.shard_id !== shardId || record.criterion !== criterion
    || record.checkpoint_head !== expected.checkpointHead || record.reviewed_range !== expected.reviewedRange
    || !['pass', 'fail'].includes(String(record.status))
    || !Array.isArray(record.evidence) || record.evidence.length === 0
    || !record.evidence.every((entry) => typeof entry === 'string' && entry.trim())
    || resultRepositoryPaths.length === 0
    || !resultRepositoryPaths.every((entry) => typeof entry === 'string' && expected.repositoryPaths.includes(entry))
    || repositoryEvidence.length === 0 || validRepositoryEvidence.length !== repositoryEvidence.length
    || !validRepositoryEvidence.some((entry) => (
      typeof (entry as Record<string, unknown>).path === 'string'
      && resultRepositoryPaths.includes((entry as Record<string, unknown>).path)
    ))
    || !Array.isArray(record.checks_cited) || record.checks_cited.length === 0
    || !record.checks_cited.every((entry) => typeof entry === 'string' && expected.checks.includes(entry))
    || !Array.isArray(record.findings) || !validFindings
    || (record.status === 'fail' && findings.length === 0)) {
    throw new Error(`Criterion shard ${shardId} is not a strict evidence-bound result.`);
  }
  return record as unknown as CriterionShardResult;
}

function criterionRepositoryContext(
  workingDir: string,
  block: CitadelSystemBlockArtifact,
): {
  checkpointHead: string;
  reviewedRange: string;
  repositoryPaths: string[];
  checks: string[];
  workingDir: string;
} {
  const checkpointHead = getHeadSha(workingDir);
  let repositoryPaths: string[];
  try {
    repositoryPaths = execFileSync('git', ['diff', '--name-only', block.reviewed_range], {
      cwd: workingDir, encoding: 'utf8', timeout: 30_000,
    }).split('\n').map((entry) => entry.trim()).filter(Boolean);
  } catch {
    throw new Error(`Criterion shard cannot inspect immutable reviewed range ${block.reviewed_range}.`);
  }
  if (repositoryPaths.length === 0) {
    repositoryPaths = execFileSync('git', ['ls-files'], {
      cwd: workingDir, encoding: 'utf8', timeout: 30_000,
    }).split('\n').map((entry) => entry.trim()).filter(Boolean);
  }
  const checks = block.checks.map((check) => check.command).filter(Boolean);
  if (!checkpointHead || repositoryPaths.length === 0 || checks.length === 0) {
    throw new Error('Criterion shard requires an exact repository checkpoint, inspectable paths, and deterministic checks.');
  }
  return { checkpointHead, reviewedRange: block.reviewed_range, repositoryPaths, checks, workingDir };
}

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function freezeCriterionShardCandidate(candidatePath: string): string | null {
  if (!fs.existsSync(candidatePath)) return null;
  const stat = fs.lstatSync(candidatePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Criterion shard candidate must be a regular non-symlink file before transition.');
  }
  const digest = fileSha256(candidatePath);
  fs.chmodSync(candidatePath, 0o400);
  return digest;
}

function recordCriterionShardCandidateDigest(attempt: CriterionShardAttempt): void {
  const digest = freezeCriterionShardCandidate(attempt.candidate_path);
  if (attempt.candidate_sha256 !== null && attempt.candidate_sha256 !== digest) {
    throw new Error('Criterion shard candidate changed after its transition digest was recorded.');
  }
  attempt.candidate_sha256 = digest;
}

interface CriterionShardExecutionStrategy {
  id: string;
  route: string;
  epoch: number;
  instruction: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  materialHash: string;
}

function createCriterionShardStrategy(
  shard: CriterionShardWork,
  candidateDir: string,
  repositoryContext: ReturnType<typeof criterionRepositoryContext>,
): CriterionShardExecutionStrategy {
  const strategyOrdinal = shard.attempts.length;
  const rejectedCandidates = shard.attempts
    .filter((attempt) => attempt.status === 'rejected')
    .map((attempt) => ({
      ordinal: attempt.ordinal,
      strategy_id: attempt.strategy_id,
      material_hash: attempt.strategy_material_hash,
      candidate_sha256: attempt.candidate_sha256,
      error: attempt.error || null,
    }));
  const fileInventory = repositoryContext.repositoryPaths.map((repositoryPath) => ({
    path: repositoryPath,
    sha256: fileSha256(path.join(repositoryContext.workingDir, repositoryPath)),
  }));
  const { id, route, epoch, instruction } = expectedCriterionShardStrategy(strategyOrdinal + 1);
  let artifactPayload: Record<string, unknown> | null = null;
  if (id === 'runtime_citation_scaffold') {
    artifactPayload = {
      schema_version: 1,
      artifact_kind: 'criterion_citation_scaffold',
      shard_id: shard.shard_id,
      criterion: shard.criterion,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      eligible_repository_evidence: fileInventory,
      eligible_checks: repositoryContext.checks,
      required_observation: '<concrete observation from exact file bytes>',
    };
  } else if (id === 'authenticated_diff_inventory_two_pass') {
    const diff = execFileSync('git', ['diff', '--binary', repositoryContext.reviewedRange], {
      cwd: repositoryContext.workingDir,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    artifactPayload = {
      schema_version: 1,
      artifact_kind: 'authenticated_diff_inventory',
      shard_id: shard.shard_id,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      diff_sha256: crypto.createHash('sha256').update(diff).digest('hex'),
      files: fileInventory,
      deterministic_checks: repositoryContext.checks,
    };
  } else if (id === 'failure_bound_evidence_replan') {
    artifactPayload = {
      schema_version: 1,
      artifact_kind: 'criterion_evidence_replan',
      shard_id: shard.shard_id,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      evidence_inventory: fileInventory,
      deterministic_checks: repositoryContext.checks,
      rejected_candidates: rejectedCandidates,
      replan_epoch: epoch,
    };
  }
  const artifactPath = artifactPayload
    ? path.join(candidateDir, `${id}.json`) : null;
  if (artifactPath) {
    atomicWriteJson(artifactPath, artifactPayload);
    fs.chmodSync(artifactPath, 0o400);
  }
  const artifactSha256 = artifactPath ? fileSha256(artifactPath) : null;
  const materialHash = sha256({
    id,
    route,
    epoch,
    instruction,
    artifact_sha256: artifactSha256,
    checkpoint_head: repositoryContext.checkpointHead,
    reviewed_range: repositoryContext.reviewedRange,
    shard_id: shard.shard_id,
    criterion: shard.criterion,
  });
  if (shard.attempts.some((attempt) => attempt.strategy_material_hash === materialHash)) {
    throw new Error(`Criterion shard ${shard.shard_id} refused to repeat strategy material ${materialHash}.`);
  }
  return { id, route, epoch, instruction, artifactPath, artifactSha256, materialHash };
}

function validatePersistedCriterionShardStrategy(
  shard: CriterionShardWork,
  attempt: CriterionShardAttempt,
  repositoryContext: ReturnType<typeof criterionRepositoryContext>,
  artifactDir: string,
): void {
  const expectedStrategy = expectedCriterionShardStrategy(attempt.ordinal);
  if (attempt.strategy_id !== expectedStrategy.id || attempt.evidence_route !== expectedStrategy.route
    || attempt.strategy_epoch !== expectedStrategy.epoch
    || attempt.strategy_instruction !== expectedStrategy.instruction) {
    throw new Error(`Criterion shard ${shard.shard_id} has invalid persisted strategy identity.`);
  }
  const candidatePath = path.resolve(attempt.candidate_path);
  const durableAttemptRoot = `${path.resolve(artifactDir, 'criterion-shard-attempts')}${path.sep}`;
  if (!candidatePath.startsWith(durableAttemptRoot)) {
    throw new Error(`Criterion shard ${shard.shard_id} candidate is not session-durable.`);
  }
  if (fs.existsSync(candidatePath)) {
    const candidateStat = fs.lstatSync(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()
      || typeof attempt.candidate_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(attempt.candidate_sha256)
      || fileSha256(candidatePath) !== attempt.candidate_sha256) {
      throw new Error(`Criterion shard ${shard.shard_id} candidate transition digest or durable file contract changed.`);
    }
  } else if (attempt.candidate_sha256 !== null) {
    throw new Error(`Criterion shard ${shard.shard_id} lost its transition-time candidate bytes.`);
  }
  const fileInventory = repositoryContext.repositoryPaths.map((repositoryPath) => ({
    path: repositoryPath,
    sha256: fileSha256(path.join(repositoryContext.workingDir, repositoryPath)),
  }));
  let expectedArtifact: Record<string, unknown> | null = null;
  if (expectedStrategy.id === 'runtime_citation_scaffold') {
    expectedArtifact = {
      schema_version: 1,
      artifact_kind: 'criterion_citation_scaffold',
      shard_id: shard.shard_id,
      criterion: shard.criterion,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      eligible_repository_evidence: fileInventory,
      eligible_checks: repositoryContext.checks,
      required_observation: '<concrete observation from exact file bytes>',
    };
  } else if (expectedStrategy.id === 'authenticated_diff_inventory_two_pass') {
    const diff = execFileSync('git', ['diff', '--binary', repositoryContext.reviewedRange], {
      cwd: repositoryContext.workingDir,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    expectedArtifact = {
      schema_version: 1,
      artifact_kind: 'authenticated_diff_inventory',
      shard_id: shard.shard_id,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      diff_sha256: crypto.createHash('sha256').update(diff).digest('hex'),
      files: fileInventory,
      deterministic_checks: repositoryContext.checks,
    };
  } else if (expectedStrategy.id === 'failure_bound_evidence_replan') {
    expectedArtifact = {
      schema_version: 1,
      artifact_kind: 'criterion_evidence_replan',
      shard_id: shard.shard_id,
      checkpoint_head: repositoryContext.checkpointHead,
      reviewed_range: repositoryContext.reviewedRange,
      evidence_inventory: fileInventory,
      deterministic_checks: repositoryContext.checks,
      rejected_candidates: shard.attempts
        .filter((prior) => prior.ordinal < attempt.ordinal && prior.status === 'rejected')
        .map((prior) => ({
          ordinal: prior.ordinal,
          strategy_id: prior.strategy_id,
          material_hash: prior.strategy_material_hash,
          candidate_sha256: prior.candidate_sha256,
          error: prior.error || null,
        })),
      replan_epoch: expectedStrategy.epoch,
    };
  }
  if (attempt.strategy_artifact_path === null) {
    if (expectedArtifact !== null || attempt.strategy_artifact_sha256 !== null) {
      throw new Error(`Criterion shard ${shard.shard_id} direct strategy artifact contract is invalid.`);
    }
  } else {
    const artifactPath = path.resolve(attempt.strategy_artifact_path);
    const candidateRoot = `${path.resolve(path.dirname(attempt.candidate_path))}${path.sep}`;
    if (!artifactPath.startsWith(candidateRoot) || typeof attempt.strategy_artifact_sha256 !== 'string') {
      throw new Error(`Criterion shard ${shard.shard_id} strategy artifact path is not attempt-local.`);
    }
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()
      || fileSha256(artifactPath) !== attempt.strategy_artifact_sha256) {
      throw new Error(`Criterion shard ${shard.shard_id} strategy artifact authentication failed.`);
    }
    if (JSON.stringify(readJsonFile<Record<string, unknown>>(artifactPath, null))
      !== JSON.stringify(expectedArtifact)) {
      throw new Error(`Criterion shard ${shard.shard_id} strategy artifact semantics changed.`);
    }
  }
  const expectedMaterialHash = sha256({
    id: attempt.strategy_id,
    route: attempt.evidence_route,
    epoch: attempt.strategy_epoch,
    instruction: attempt.strategy_instruction,
    artifact_sha256: attempt.strategy_artifact_sha256,
    checkpoint_head: repositoryContext.checkpointHead,
    reviewed_range: repositoryContext.reviewedRange,
    shard_id: shard.shard_id,
    criterion: shard.criterion,
  });
  if (attempt.strategy_material_hash !== expectedMaterialHash) {
    throw new Error(`Criterion shard ${shard.shard_id} strategy material identity is not authentic.`);
  }
}

function cleanupPersistedCriterionWorktree(liveWorkingDir: string, attempt: CriterionShardAttempt): void {
  if (!attempt.worktree_path) return;
  const workingDir = path.resolve(attempt.worktree_path);
  const parent = path.dirname(workingDir);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!parent.startsWith(tempRoot)
    || !path.basename(parent).startsWith('pickle-citadel-criterion-shard-')
    || path.basename(workingDir) !== 'repository') {
    throw new Error('Refusing to clean an untrusted persisted criterion-shard worktree path.');
  }
  try {
    execFileSync('git', ['worktree', 'remove', '--force', workingDir], {
      cwd: liveWorkingDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    if (fs.existsSync(workingDir)) throw error;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

async function executeCriterionShards(
  sessionDir: string,
  state: ReviewState,
  block: CitadelSystemBlockArtifact,
  artifact: DiagnosticArtifact,
  artifactDir: string,
  options: RecoveryOptions,
  manager: StateManager,
  statePath: string,
): Promise<{ bundlePath: string; shardPlanIdentity: string }> {
  const criteria = deriveCitadelAcceptanceCriteria(sessionDir);
  if (criteria.length === 0) throw new Error('Criterion-sharded recovery requires acceptance criteria.');
  const liveWorkingDir = String(manager.read(statePath).working_dir || '');
  if (!liveWorkingDir) throw new Error('Criterion-sharded recovery requires the session working_dir.');
  const planRepositoryContext = criterionRepositoryContext(liveWorkingDir, block);
  const shardPlanIdentity = sha256({
    review_identity: state.review_identity,
    diagnostic_identity: artifact.diagnostic_identity,
    checkpoint_head: planRepositoryContext.checkpointHead,
    reviewed_range: block.reviewed_range,
    repository_paths: planRepositoryContext.repositoryPaths,
    deterministic_checks: planRepositoryContext.checks,
    acceptance_criteria: criteria,
    failed_candidate_hashes: artifact.failed_candidate_hashes,
    validator_invariants: artifact.validator_invariants,
  });
  const journalPath = path.join(artifactDir, 'criterion-shard-journal.json');
  let journal = readJsonFile<CriterionShardJournal>(journalPath, null);
  if (!journal || journal.shard_plan_identity !== shardPlanIdentity) {
    journal = {
      schema_version: 1,
      review_identity: state.review_identity,
      diagnostic_identity: artifact.diagnostic_identity,
      shard_plan_identity: shardPlanIdentity,
      bounded_strategy_limit: BOUNDED_CRITERION_SHARD_STRATEGY_LIMIT,
      replan_after_attempt: BOUNDED_CRITERION_SHARD_STRATEGY_LIMIT,
      status: 'pending',
      shards: criteria.map((criterion, index) => ({
        shard_id: `criterion-${index + 1}`,
        criterion,
        status: 'pending',
        result_path: path.join(artifactDir, `criterion-${index + 1}-result.json`),
        result_sha256: null,
        attempts: [],
      })),
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(journalPath, journal);
  }
  for (const shard of journal.shards) {
    if (shard.status === 'resolved') {
      try {
        if (!shard.result_sha256 || fileSha256(shard.result_path) !== shard.result_sha256) {
          throw new Error(`Criterion shard ${shard.shard_id} result digest changed after resolution.`);
        }
        validateCriterionShard(
          readJsonFile(shard.result_path, null), shard.shard_id, shard.criterion, planRepositoryContext,
        );
        continue;
      } catch {
        shard.status = 'pending';
        shard.result_sha256 = null;
        journal.status = 'pending';
        journal.updated_at = new Date().toISOString();
        atomicWriteJson(journalPath, journal);
      }
    }
    const prior = shard.attempts.at(-1);
    if (prior?.status === 'started' && fs.existsSync(prior.candidate_path)) {
      try {
        cleanupPersistedCriterionWorktree(liveWorkingDir, prior);
        recordCriterionShardCandidateDigest(prior);
        journal.updated_at = new Date().toISOString();
        atomicWriteJson(journalPath, journal);
        validatePersistedCriterionShardStrategy(shard, prior, planRepositoryContext, artifactDir);
        const recovered = validateCriterionShard(
          readJsonFile(prior.candidate_path, null), shard.shard_id, shard.criterion, planRepositoryContext,
        );
        atomicWriteJson(shard.result_path, recovered);
        fs.chmodSync(shard.result_path, 0o400);
        shard.result_sha256 = fileSha256(shard.result_path);
        prior.status = 'resolved';
        prior.completed_at = new Date().toISOString();
        shard.status = 'resolved';
        journal.updated_at = prior.completed_at;
        atomicWriteJson(journalPath, journal);
        continue;
      } catch (error) {
        prior.status = 'rejected';
        prior.error = error instanceof Error ? error.message : String(error);
        prior.completed_at = new Date().toISOString();
      }
    } else if (prior?.status === 'started') {
      cleanupPersistedCriterionWorktree(liveWorkingDir, prior);
      prior.candidate_sha256 = null;
      prior.status = 'interrupted';
      prior.error = 'Prior criterion shard worker ended before writing its candidate.';
      prior.completed_at = new Date().toISOString();
      journal.updated_at = prior.completed_at;
      atomicWriteJson(journalPath, journal);
    }
    const attemptOrdinal = shard.attempts.length + 1;
    const candidateDir = fs.mkdtempSync(path.join(ensureDir(path.join(
      artifactDir, 'criterion-shard-attempts', shard.shard_id,
    )), `attempt-${attemptOrdinal}-`));
    const candidatePath = path.join(candidateDir, 'criterion-shard-result.json');
    const lastMessagePath = path.join(candidateDir, 'last-message.txt');
    const isolated = createDisposableDetachedWorktree(liveWorkingDir, 'pickle-citadel-criterion-shard-');
    const isolatedFingerprint = getWorkingTreeFingerprint(isolated.workingDir);
    let repositoryContext: ReturnType<typeof criterionRepositoryContext>;
    let strategy: CriterionShardExecutionStrategy;
    try {
      repositoryContext = criterionRepositoryContext(isolated.workingDir, block);
      if (repositoryContext.checkpointHead !== planRepositoryContext.checkpointHead) {
        throw new Error(`Criterion shard ${shard.shard_id} isolated checkpoint does not match its durable plan.`);
      }
      for (const priorAttempt of shard.attempts) {
        validatePersistedCriterionShardStrategy(
          shard, priorAttempt, repositoryContext, artifactDir,
        );
      }
      strategy = createCriterionShardStrategy(shard, candidateDir, repositoryContext);
    } catch (error) {
      isolated.cleanup();
      throw error;
    }
    const attempt: CriterionShardAttempt = {
      ordinal: attemptOrdinal,
      status: 'started',
      candidate_path: candidatePath,
      candidate_sha256: null,
      worktree_path: isolated.workingDir,
      worktree_checkpoint_head: isolated.checkpointHead,
      strategy_id: strategy.id,
      strategy_material_hash: strategy.materialHash,
      evidence_route: strategy.route,
      strategy_epoch: strategy.epoch,
      strategy_instruction: strategy.instruction,
      strategy_artifact_path: strategy.artifactPath,
      strategy_artifact_sha256: strategy.artifactSha256,
      started_at: new Date().toISOString(),
    };
    shard.attempts.push(attempt);
    shard.status = 'running';
    journal.status = 'running';
    journal.updated_at = attempt.started_at;
    atomicWriteJson(journalPath, journal);
    let preserveActiveChild = false;
    const startedAt = Date.now();
    try {
      const prompt = [
        'You are the autonomous Citadel criterion-shard review worker.',
        `Review identity: ${state.review_identity}`,
        `Diagnostic identity: ${artifact.diagnostic_identity}`,
        `Shard plan identity: ${shardPlanIdentity}`,
        `Shard ID: ${shard.shard_id}`,
        `Exact acceptance criterion JSON: ${JSON.stringify(shard.criterion)}`,
        `Execution strategy ID: ${strategy.id}`,
        `Evidence route: ${strategy.route}`,
        `Strategy epoch: ${strategy.epoch}`,
        `Strategy material hash: ${strategy.materialHash}`,
        `Materially distinct execution instruction: ${strategy.instruction}`,
        `Authenticated strategy artifact: ${strategy.artifactPath || 'none; use direct repository inspection'}`,
        `Authenticated strategy artifact SHA-256: ${strategy.artifactSha256 || 'none'}`,
        'Inspect the repository at the exact detached checkpoint before deciding this shard.',
        `Expected repository HEAD: ${repositoryContext.checkpointHead}`,
        `Immutable reviewed range: ${repositoryContext.reviewedRange}`,
        `Eligible repository paths JSON: ${JSON.stringify(repositoryContext.repositoryPaths)}`,
        `Deterministic checks JSON: ${JSON.stringify(block.checks)}`,
        `Write the strict shard result to: ${candidatePath}`,
        'Write exactly one JSON object with schema_version:1, shard_id, criterion, checkpoint_head, reviewed_range, status (pass or fail), evidence (non-empty string array), repository_paths (non-empty eligible path array), repository_evidence (non-empty array of exact {path,sha256,observation} objects derived from files you actually read), checks_cited (non-empty exact deterministic command array), and findings (array). Inspect the reviewed diff and cited repository files, hash their exact bytes with SHA-256, and record a concrete observation. Assess only this exact criterion. Do not write a Citadel report.',
        'Return <promise>CITADEL_CRITERION_SHARD_COMPLETE</promise> after writing the shard result.',
      ].join('\n\n');
      recoverMonitoredProcessOwnership(manager, statePath);
      const result = await runCodexExecMonitored({
        telemetry: { sessionDir, ticketId: shard.shard_id, phase: 'citadel_criterion_shard_repair' },
        execArgs: ['--sandbox', 'workspace-write', '--skip-git-repo-check'],
        cwd: isolated.workingDir,
        prompt,
        timeoutMs: options.timeoutMs || 900_000,
        outputLastMessagePath: lastMessagePath,
        progressArtifactPaths: [candidatePath],
        addDirs: [candidateDir],
        inheritConfiguredAddDirs: false,
        successCheck: ({ stdout, lastMessage }) => hasPromiseToken(stdout, 'CITADEL_CRITERION_SHARD_COMPLETE')
          || hasPromiseToken(lastMessage, 'CITADEL_CRITERION_SHARD_COMPLETE'),
        ...monitoredProcessStateCallbacks(
          manager,
          statePath,
          'codex',
          `citadel-criterion-shard-${shard.shard_id}`,
        ),
        cancelCheck: () => {
          try { options.assertDurableOwnership?.(); } catch (error) {
            preserveActiveChild = true;
            throw error;
          }
          const cancelledAt = Date.parse(String(manager.read(statePath).cancel_requested_at || ''));
          return Number.isFinite(cancelledAt) && cancelledAt >= startedAt;
        },
      });
      options.assertDurableOwnership?.();
      assertCodexSucceeded(result, `Citadel criterion shard ${shard.shard_id} failed`);
      recordCriterionShardCandidateDigest(attempt);
      journal.updated_at = new Date().toISOString();
      atomicWriteJson(journalPath, journal);
      if (strategy.artifactPath && fileSha256(strategy.artifactPath) !== strategy.artifactSha256) {
        throw new Error(`Criterion shard ${shard.shard_id} modified its authenticated strategy artifact.`);
      }
      if (getHeadSha(isolated.workingDir) !== isolated.checkpointHead
        || getWorkingTreeFingerprint(isolated.workingDir) !== isolatedFingerprint) {
        throw new Error(`Criterion shard ${shard.shard_id} modified its detached review checkpoint.`);
      }
      const shardResult = validateCriterionShard(
        readJsonFile(candidatePath, null), shard.shard_id, shard.criterion, repositoryContext,
      );
      atomicWriteJson(shard.result_path, shardResult);
      fs.chmodSync(shard.result_path, 0o400);
      shard.result_sha256 = fileSha256(shard.result_path);
      attempt.status = 'resolved';
      attempt.completed_at = new Date().toISOString();
      shard.status = 'resolved';
      journal.updated_at = attempt.completed_at;
      atomicWriteJson(journalPath, journal);
    } catch (error) {
      const ownershipDrain = durableOwnershipDrainCause(error);
      if (ownershipDrain) {
        preserveActiveChild = true;
        throw ownershipDrain;
      }
      try {
        recordCriterionShardCandidateDigest(attempt);
      } catch (candidateError) {
        attempt.error = candidateError instanceof Error ? candidateError.message : String(candidateError);
      }
      attempt.status = 'rejected';
      attempt.error ||= error instanceof Error ? error.message : String(error);
      attempt.completed_at = new Date().toISOString();
      shard.status = 'pending';
      journal.status = 'pending';
      journal.updated_at = attempt.completed_at;
      atomicWriteJson(journalPath, journal);
      throw new ReviewerRecoveryPending(`Criterion shard ${shard.shard_id} remains pending.`);
    } finally {
      if (!preserveActiveChild) {
        try {
          isolated.assertLiveUnchanged();
        } finally {
          isolated.cleanup();
        }
      }
    }
  }
  journal.status = 'resolved';
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(journalPath, journal);
  const results = journal.shards.map((shard) => {
    const materialHashes = shard.attempts.map((attempt) => attempt.strategy_material_hash);
    if (materialHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
      || new Set(materialHashes).size !== materialHashes.length) {
      throw new Error(`Criterion shard ${shard.shard_id} repeated or lost a persisted strategy identity.`);
    }
    const resolvedAttempt = shard.attempts.findLast((attempt) => attempt.status === 'resolved');
    if (!resolvedAttempt) throw new Error(`Criterion shard ${shard.shard_id} has no resolved strategy attempt.`);
    for (const attempt of shard.attempts) {
      validatePersistedCriterionShardStrategy(shard, attempt, planRepositoryContext, artifactDir);
    }
    if (!shard.result_sha256 || fileSha256(shard.result_path) !== shard.result_sha256) {
      throw new Error(`Criterion shard ${shard.shard_id} result changed before bundle assembly.`);
    }
    return validateCriterionShard(
      readJsonFile(shard.result_path, null), shard.shard_id, shard.criterion, planRepositoryContext,
    );
  });
  const bundlePath = path.join(artifactDir, 'criterion-shard-bundle.json');
  atomicWriteJson(bundlePath, {
    schema_version: 1,
    review_identity: state.review_identity,
    diagnostic_identity: artifact.diagnostic_identity,
    shard_plan_identity: shardPlanIdentity,
    bounded_strategy_limit: BOUNDED_CRITERION_SHARD_STRATEGY_LIMIT,
    replan_after_attempt: BOUNDED_CRITERION_SHARD_STRATEGY_LIMIT,
    checkpoint_head: planRepositoryContext.checkpointHead,
    reviewed_range: block.reviewed_range,
    repository_paths: planRepositoryContext.repositoryPaths,
    acceptance_criteria: criteria,
    deterministic_checks: block.checks,
    failed_candidate_hashes: artifact.failed_candidate_hashes,
    validator_invariants: artifact.validator_invariants,
    result_files: journal.shards.map((shard) => ({
      shard_id: shard.shard_id,
      path: shard.result_path,
      sha256: shard.result_sha256,
    })),
    strategy_executions: journal.shards.map((shard) => ({
      shard_id: shard.shard_id,
      attempts: shard.attempts.map((attempt) => ({
        ordinal: attempt.ordinal,
        strategy_id: attempt.strategy_id,
        evidence_route: attempt.evidence_route,
        strategy_epoch: attempt.strategy_epoch,
        strategy_instruction: attempt.strategy_instruction,
        strategy_material_hash: attempt.strategy_material_hash,
        strategy_artifact: attempt.strategy_artifact_path ? {
          path: attempt.strategy_artifact_path,
          sha256: attempt.strategy_artifact_sha256,
        } : null,
        candidate: attempt.candidate_sha256 ? {
          path: attempt.candidate_path,
          sha256: attempt.candidate_sha256,
        } : null,
        status: attempt.status,
        error: attempt.error || null,
      })),
    })),
    results,
  });
  fs.chmodSync(bundlePath, 0o400);
  return { bundlePath, shardPlanIdentity };
}

async function materializeRuntimeArtifacts(
  sessionDir: string,
  state: ReviewState,
  block: CitadelSystemBlockArtifact,
  artifact: DiagnosticArtifact,
  options: RecoveryOptions,
  manager: StateManager,
  statePath: string,
): Promise<RuntimeArtifacts> {
  const artifactDir = ensureDir(path.join(
    sessionDir,
    'citadel-reviewer-contract-runtime',
    artifact.diagnostic_identity,
  ));
  const criteria = deriveCitadelAcceptanceCriteria(sessionDir);
  const scaffoldPath = artifact.mechanism === 'schema_scaffold_replay'
    ? path.join(artifactDir, 'citadel-report-scaffold.json') : null;
  const evidenceBundlePath = artifact.mechanism === 'evidence_bundle_reconstruction'
    ? path.join(artifactDir, 'evidence-bundle.json') : null;
  const criterionShards = artifact.mechanism === 'criterion_sharded_reconstruction'
    ? await executeCriterionShards(
      sessionDir, state, block, artifact, artifactDir, options, manager, statePath,
    ) : null;
  const validatorPath = path.join(artifactDir, 'validate-citadel-candidate.mjs');
  const manifestPath = path.join(artifactDir, 'runtime-manifest.json');
  if (scaffoldPath) {
    atomicWriteJson(scaffoldPath, {
      schema_version: 1,
      verdict: '<approve-or-block>',
      reviewed_range: block.reviewed_range,
      acceptance_criteria_checked: criteria,
      findings: [],
      generated_at: '<ISO-8601 timestamp>',
    });
    fs.chmodSync(scaffoldPath, 0o400);
  }
  if (evidenceBundlePath) {
    atomicWriteJson(evidenceBundlePath, {
      schema_version: 1,
      review_identity: state.review_identity,
      diagnostic_identity: artifact.diagnostic_identity,
      reviewed_range: block.reviewed_range,
      acceptance_criteria: criteria,
      deterministic_checks: block.checks,
      failed_candidate_hashes: artifact.failed_candidate_hashes,
      validation_failures: state.attempts.map((attempt) => ({
        ordinal: attempt.ordinal,
        candidate_hash: attempt.candidate_hash || null,
        validation_error: attempt.validation_error || null,
      })),
      validator_invariants: artifact.validator_invariants,
    });
    fs.chmodSync(evidenceBundlePath, 0o400);
  }
  const validatorSource = [
    "import fs from 'node:fs';",
    `const expectedRange = ${JSON.stringify(block.reviewed_range)};`,
    `const expectedCriteria = ${JSON.stringify(criteria)};`,
    "const candidatePath = process.argv[2];",
    "if (!candidatePath) throw new Error('candidate path required');",
    "const value = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));",
    "const keys = ['acceptance_criteria_checked','findings','generated_at','reviewed_range','schema_version','verdict'];",
    "if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('candidate must be an object');",
    "if (Object.keys(value).sort().join('\\0') !== keys.sort().join('\\0')) throw new Error('canonical report keys required');",
    "if (value.schema_version !== 1 || !['approve','block'].includes(value.verdict)) throw new Error('schema/version verdict invalid');",
    "if (value.reviewed_range !== expectedRange) throw new Error('reviewed range drift');",
    "if (JSON.stringify(value.acceptance_criteria_checked) !== JSON.stringify(expectedCriteria)) throw new Error('criteria coverage drift');",
    "if (!Array.isArray(value.findings)) throw new Error('findings must be an array');",
    "for (const finding of value.findings) {",
    "  const required = ['acceptance_criteria','evidence','file','line','paths','recommendation','severity','ticket_ids','title'];",
    "  if (!finding || Array.isArray(finding) || typeof finding !== 'object' || required.some((key) => !Object.hasOwn(finding, key))) throw new Error('finding schema invalid');",
    "  if (['critical','high'].includes(finding.severity) && (!finding.ticket_ids?.length || !finding.acceptance_criteria?.length || !finding.paths?.length)) throw new Error('blocking finding attribution missing');",
    "}",
  ].join('\n');
  fs.writeFileSync(validatorPath, `${validatorSource}\n`, { mode: 0o500 });
  fs.chmodSync(validatorPath, 0o500);
  const fileSha = (filePath: string | null): string | null => filePath
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : null;
  atomicWriteJson(manifestPath, {
    schema_version: 1,
    mechanism: artifact.mechanism,
    diagnostic_identity: artifact.diagnostic_identity,
    scaffold: scaffoldPath ? { path: scaffoldPath, sha256: fileSha(scaffoldPath) } : null,
    evidence_bundle: evidenceBundlePath
      ? { path: evidenceBundlePath, sha256: fileSha(evidenceBundlePath) } : null,
    criterion_shards: criterionShards
      ? {
          path: criterionShards.bundlePath,
          sha256: fileSha(criterionShards.bundlePath),
          shard_plan_identity: criterionShards.shardPlanIdentity,
        }
      : null,
    validator: { path: validatorPath, sha256: fileSha(validatorPath) },
  });
  fs.chmodSync(manifestPath, 0o400);
  return {
    schema_version: 1,
    mechanism: artifact.mechanism,
    scaffold_path: scaffoldPath,
    evidence_bundle_path: evidenceBundlePath,
    criterion_shard_bundle_path: criterionShards?.bundlePath ?? null,
    manifest_path: manifestPath,
    validator_path: validatorPath,
    validator_command: `node ${JSON.stringify(validatorPath)} <candidate-path>`,
  };
}

function persistResolved(
  sessionDir: string,
  state: ReviewState,
  journal: ReviewerRecoveryJournal,
  artifact: DiagnosticArtifact,
  runtimeArtifacts: RuntimeArtifacts,
  options: RecoveryOptions,
): CitadelReviewerRecoveryResult {
  const artifactPath = path.join(
    ensureDir(path.join(sessionDir, 'citadel-reviewer-contract-repairs')),
    `${artifact.diagnostic_identity}.json`,
  );
  atomicWriteJson(artifactPath, artifact);
  const completedAt = new Date().toISOString();
  const activeAttempt = journal.attempts.at(-1);
  if (activeAttempt) {
    activeAttempt.status = 'resolved';
    activeAttempt.completed_at = completedAt;
  }
  journal.status = 'resolved';
  journal.updated_at = completedAt;
  journal.resolution = {
    artifact_path: artifactPath,
    instruction: artifact.instruction.trim(),
    runtime_artifacts: runtimeArtifacts,
    runtime_manifest_sha256: fileSha256(runtimeArtifacts.manifest_path),
    resolved_at: completedAt,
  };
  atomicWriteJson(recoveryJournalPath(sessionDir), journal);
  try {
    options.faultInjection?.('journal-resolved-before-state');
  } catch (error) {
    throw new ReviewerRecoveryFault('Injected failure after reviewer recovery journal resolution.', { cause: error });
  }
  return projectResolvedReviewerState(sessionDir, state, journal, artifact);
}

function projectResolvedReviewerState(
  sessionDir: string,
  state: ReviewState,
  journal: ReviewerRecoveryJournal,
  artifact: DiagnosticArtifact,
): CitadelReviewerRecoveryResult {
  const resolution = journal.resolution;
  if (!resolution) throw new Error('Resolved Citadel reviewer journal lacks its durable resolution projection.');
  state.recovery_epoch += 1;
  state.status = 'running';
  state.strategy_id = 'artifact-contract-reconstruction';
  state.strategy_hash = '';
  state.artifact_contract_recovery = {
    schema_version: 1,
    status: 'resolved',
    diagnostic_identity: artifact.diagnostic_identity,
    artifact_path: resolution.artifact_path,
    instruction: resolution.instruction,
    mechanism: artifact.mechanism,
    failed_candidate_hashes: artifact.failed_candidate_hashes,
    validator_invariants: artifact.validator_invariants,
    mechanism_history: journal.mechanism_history,
    runtime_artifacts: resolution.runtime_artifacts,
    runtime_manifest_sha256: resolution.runtime_manifest_sha256,
    resolved_at: resolution.resolved_at,
  };
  state.updated_at = resolution.resolved_at;
  atomicWriteJson(path.join(sessionDir, 'citadel-review-state.json'), state);
  return { kind: 'resolved', diagnostic_identity: artifact.diagnostic_identity };
}

function validateResolvedRuntimeArtifacts(
  sessionDir: string,
  diagnosticIdentity: string,
  mechanism: RecoveryMechanism,
  runtime: RuntimeArtifacts,
): void {
  const artifactDir = path.join(sessionDir, 'citadel-reviewer-contract-runtime', diagnosticIdentity);
  const expected = {
    manifest: path.join(artifactDir, 'runtime-manifest.json'),
    validator: path.join(artifactDir, 'validate-citadel-candidate.mjs'),
    scaffold: mechanism === 'schema_scaffold_replay' ? path.join(artifactDir, 'citadel-report-scaffold.json') : null,
    evidence: mechanism === 'evidence_bundle_reconstruction' ? path.join(artifactDir, 'evidence-bundle.json') : null,
  };
  if (runtime.schema_version !== 1 || runtime.mechanism !== mechanism
    || runtime.manifest_path !== expected.manifest || runtime.validator_path !== expected.validator
    || runtime.scaffold_path !== expected.scaffold || runtime.evidence_bundle_path !== expected.evidence
    || runtime.validator_command !== `node ${JSON.stringify(expected.validator)} <candidate-path>`) {
    throw new Error('Resolved Citadel reviewer runtime artifact projection is invalid.');
  }
  const manifest = readJsonFile<Record<string, unknown>>(expected.manifest, null);
  const fileBindingValid = (binding: unknown, expectedPath: string | null): boolean => {
    if (expectedPath === null) return binding === null;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
    const record = binding as Record<string, unknown>;
    return record.path === expectedPath && record.sha256 === fileSha256(expectedPath);
  };
  if (!manifest || manifest.schema_version !== 1 || manifest.mechanism !== mechanism
    || manifest.diagnostic_identity !== diagnosticIdentity
    || !fileBindingValid(manifest.scaffold, expected.scaffold)
    || !fileBindingValid(manifest.evidence_bundle, expected.evidence)
    || !fileBindingValid(manifest.validator, expected.validator)) {
    throw new Error('Resolved Citadel reviewer runtime manifest is stale or unauthenticated.');
  }
  const criterion = manifest.criterion_shards as Record<string, unknown> | null;
  if (mechanism === 'criterion_sharded_reconstruction') {
    if (!runtime.criterion_shard_bundle_path || !fileBindingValid(criterion, runtime.criterion_shard_bundle_path)) {
      throw new Error('Resolved Citadel reviewer criterion shard bundle is unauthenticated.');
    }
  } else if (criterion !== null || runtime.criterion_shard_bundle_path !== null) {
    throw new Error('Resolved Citadel reviewer runtime has an unexpected criterion shard bundle.');
  }
}

function authenticateResolvedCitadelReviewerArtifactContract(
  sessionDir: string,
  block: CitadelSystemBlockArtifact,
): CitadelReviewerRecoveryResult | { kind: 'fresh_epoch' } | null {
  const state = readReviewState(sessionDir);
  const recovery = state.artifact_contract_recovery as Record<string, unknown> | undefined;
  let journal = readJsonFile<ReviewerRecoveryJournal>(recoveryJournalPath(sessionDir), null);
  const recoveryResolved = recovery?.status === 'resolved';
  const journalResolved = journal?.status === 'resolved';
  if (block.code !== 'reviewer_artifact_strategy_exhausted'
    || block.recovery_action !== 'repair_reviewer_artifact_contract'
    || block.failure_identity !== citadelSystemBlockFailureIdentity(block)) {
    throw new Error('Citadel reviewer recovery system block identity is unauthenticated.');
  }
  if (journal && !journalResolved && journal.review_identity === state.review_identity) {
    const currentHashes = failedCandidateHashes(state);
    const activeAttempt = journal.attempts.at(-1);
    if (journal.schema_version !== 1
      || !['started', 'interrupted', 'rejected'].includes(journal.status)
      || !activeAttempt || activeAttempt.status !== journal.status
      || !Number.isInteger(journal.strategy_epoch ?? 0) || Number(journal.strategy_epoch ?? 0) < 0
      || journal.mechanism_history.length === 0 || journal.mechanism_history.at(-1) !== journal.mechanism
      || journal.mechanism_history.some((entry) => !MECHANISMS.includes(entry))
      || !MECHANISMS.includes(journal.mechanism)
      || JSON.stringify(journal.failed_candidate_hashes) !== JSON.stringify(currentHashes)
      || JSON.stringify(journal.validator_invariants) !== JSON.stringify(VALIDATOR_INVARIANTS)
      || diagnosticContext(state, block, journal.mechanism).diagnosticIdentity !== journal.diagnostic_identity) {
      throw new Error('Pending Citadel reviewer recovery journal is stale or unauthenticated.');
    }
    return null;
  }
  if (!recoveryResolved && !journalResolved) return null;
  const mechanism = (recoveryResolved ? recovery.mechanism : journal?.mechanism) as RecoveryMechanism;
  if (!MECHANISMS.includes(mechanism)) throw new Error('Resolved Citadel reviewer recovery mechanism is invalid.');
  const hashes = failedCandidateHashes(state);
  const priorHashes = (recoveryResolved ? recovery.failed_candidate_hashes : journal?.failed_candidate_hashes) as unknown;
  if (!Array.isArray(priorHashes) || priorHashes.some((value) => typeof value !== 'string')) {
    throw new Error('Resolved Citadel reviewer recovery failed-candidate history is invalid.');
  }
  if (JSON.stringify(priorHashes) !== JSON.stringify(hashes)) {
    if (hashes.length > priorHashes.length && priorHashes.every((hash, index) => hashes[index] === hash)) {
      return { kind: 'fresh_epoch' };
    }
    throw new Error('Resolved Citadel reviewer recovery evidence does not match the current failed candidates.');
  }
  const { diagnosticIdentity } = diagnosticContext(state, block, mechanism);
  if (!journal || journal.diagnostic_identity !== diagnosticIdentity) {
    if (state.status === 'diagnostic_scheduled') return { kind: 'fresh_epoch' };
    throw new Error('Resolved Citadel reviewer recovery is not bound to the current diagnostic block.');
  }
  const artifactPath = path.join(
    sessionDir, 'citadel-reviewer-contract-repairs', `${diagnosticIdentity}.json`,
  );
  const artifact = validateArtifact(readJsonFile(artifactPath, null), {
    reviewIdentity: state.review_identity,
    diagnosticIdentity,
    mechanism,
    hashes,
  });
  const activeAttempt = journal?.attempts.at(-1);
  if (!journal || journal.schema_version !== 1 || journal.review_identity !== state.review_identity
    || journal.diagnostic_identity !== diagnosticIdentity || journal.mechanism !== mechanism
    || journal.status !== 'resolved' || activeAttempt?.status !== 'resolved'
    || activeAttempt.completed_at !== journal.updated_at
    || JSON.stringify(journal.failed_candidate_hashes) !== JSON.stringify(hashes)
    || JSON.stringify(journal.validator_invariants) !== JSON.stringify(VALIDATOR_INVARIANTS)
    || journal.mechanism_history.length === 0 || journal.mechanism_history.at(-1) !== mechanism
    || journal.mechanism_history.some((entry) => !MECHANISMS.includes(entry))) {
    throw new Error('Resolved Citadel reviewer recovery evidence is stale or internally inconsistent.');
  }
  if (!journal.resolution && recoveryResolved) {
    const runtime = recovery.runtime_artifacts as RuntimeArtifacts | undefined;
    if (!runtime || typeof recovery.artifact_path !== 'string' || typeof recovery.instruction !== 'string'
      || typeof recovery.resolved_at !== 'string') {
      throw new Error('Legacy resolved Citadel reviewer recovery cannot be upgraded safely.');
    }
    const candidateResolution = {
      artifact_path: recovery.artifact_path,
      instruction: recovery.instruction,
      runtime_artifacts: runtime,
      runtime_manifest_sha256: '',
      resolved_at: recovery.resolved_at,
    };
    if (candidateResolution.artifact_path !== artifactPath
      || candidateResolution.instruction !== artifact.instruction.trim()
      || candidateResolution.resolved_at !== journal.updated_at) {
      throw new Error('Legacy resolved Citadel reviewer projection is stale or unauthenticated.');
    }
    validateResolvedRuntimeArtifacts(sessionDir, diagnosticIdentity, mechanism, runtime);
    candidateResolution.runtime_manifest_sha256 = fileSha256(runtime.manifest_path);
    if (recovery.schema_version !== 1 || recovery.diagnostic_identity !== diagnosticIdentity
      || recovery.artifact_path !== artifactPath || recovery.instruction !== artifact.instruction.trim()
      || recovery.mechanism !== mechanism
      || JSON.stringify(recovery.failed_candidate_hashes) !== JSON.stringify(hashes)
      || JSON.stringify(recovery.validator_invariants) !== JSON.stringify(VALIDATOR_INVARIANTS)
      || JSON.stringify(recovery.mechanism_history) !== JSON.stringify(journal.mechanism_history)
      || JSON.stringify(recovery.runtime_artifacts) !== JSON.stringify(runtime)
      || recovery.resolved_at !== candidateResolution.resolved_at) {
      throw new Error('Legacy resolved Citadel reviewer state is stale or internally inconsistent.');
    }
    journal = { ...journal, resolution: candidateResolution };
    atomicWriteJson(recoveryJournalPath(sessionDir), journal);
  }
  const resolution = journal.resolution;
  if (!resolution || resolution.artifact_path !== artifactPath
    || resolution.instruction !== artifact.instruction.trim()
    || resolution.resolved_at !== journal.updated_at
    || !/^[a-f0-9]{64}$/.test(resolution.runtime_manifest_sha256)
    || resolution.runtime_manifest_sha256 !== fileSha256(resolution.runtime_artifacts.manifest_path)) {
    throw new Error('Resolved Citadel reviewer journal projection is stale or incomplete.');
  }
  validateResolvedRuntimeArtifacts(sessionDir, diagnosticIdentity, mechanism, resolution.runtime_artifacts);
  if (!recoveryResolved) return projectResolvedReviewerState(sessionDir, state, journal, artifact);
  const legacyManifestHashMissing = recovery.runtime_manifest_sha256 === undefined;
  if (recovery.schema_version !== 1 || recovery.diagnostic_identity !== diagnosticIdentity
    || recovery.artifact_path !== artifactPath || recovery.instruction !== artifact.instruction.trim()
    || recovery.mechanism !== mechanism
    || JSON.stringify(recovery.failed_candidate_hashes) !== JSON.stringify(hashes)
    || JSON.stringify(recovery.validator_invariants) !== JSON.stringify(VALIDATOR_INVARIANTS)
    || JSON.stringify(recovery.mechanism_history) !== JSON.stringify(journal.mechanism_history)
    || JSON.stringify(recovery.runtime_artifacts) !== JSON.stringify(resolution.runtime_artifacts)
    || (!legacyManifestHashMissing && recovery.runtime_manifest_sha256 !== resolution.runtime_manifest_sha256)
    || recovery.resolved_at !== resolution.resolved_at) {
    throw new Error('Resolved Citadel reviewer state projection is stale or internally inconsistent.');
  }
  if (legacyManifestHashMissing) {
    recovery.runtime_manifest_sha256 = resolution.runtime_manifest_sha256;
    state.artifact_contract_recovery = recovery;
    atomicWriteJson(path.join(sessionDir, 'citadel-review-state.json'), state);
  }
  return { kind: 'resolved', diagnostic_identity: diagnosticIdentity };
}

function persistResolvedWithFaultBoundary(
  sessionDir: string,
  state: ReviewState,
  journal: ReviewerRecoveryJournal,
  artifact: DiagnosticArtifact,
  runtimeArtifacts: RuntimeArtifacts,
  options: RecoveryOptions,
): CitadelReviewerRecoveryResult {
  const resolved = persistResolved(sessionDir, state, journal, artifact, runtimeArtifacts, options);
  try {
    options.faultInjection?.('resolved-after-persist');
  } catch (error) {
    throw new ReviewerRecoveryFault('Injected failure after reviewer recovery resolution was persisted.', { cause: error });
  }
  return resolved;
}

export async function repairCitadelReviewerArtifactContract(
  sessionDir: string,
  block: CitadelSystemBlockArtifact,
  options: RecoveryOptions = {},
): Promise<CitadelReviewerRecoveryResult> {
  if (block.code !== 'reviewer_artifact_strategy_exhausted'
    || block.recovery_action !== 'repair_reviewer_artifact_contract') {
    throw new Error('Citadel reviewer contract recovery received an incompatible system block.');
  }
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  assertRecordedActiveChildRecovered(sessionDir, manager);
  options.assertDurableOwnership?.();
  const state = readReviewState(sessionDir);
  const authenticatedResolved = authenticateResolvedCitadelReviewerArtifactContract(sessionDir, block);
  if (authenticatedResolved?.kind === 'resolved') return authenticatedResolved;
  const freshEpoch = authenticatedResolved?.kind === 'fresh_epoch';
  const priorJournal = freshEpoch ? null : readJsonFile<ReviewerRecoveryJournal>(recoveryJournalPath(sessionDir), null);
  // A strict extension starts a new diagnostic transaction and never resumes the old journal attempt.
  // Retain only the bounded mechanism history so new evidence cannot reset all safeguards forever.
  const priorRecovery = state.artifact_contract_recovery as Record<string, unknown> | undefined;
  const resumableMechanism = priorJournal?.review_identity === state.review_identity
    && ['started', 'interrupted'].includes(priorJournal.status)
    && ['started', 'interrupted'].includes(String(priorJournal.attempts.at(-1)?.status))
    ? priorJournal.mechanism : null;
  const journalHistory = priorJournal?.review_identity === state.review_identity
    ? priorJournal.mechanism_history || [] : [];
  const usedMechanisms = new Set<RecoveryMechanism>([
    ...journalHistory.filter((entry) => entry !== resumableMechanism),
    ...(Array.isArray(priorRecovery?.mechanism_history)
      ? priorRecovery.mechanism_history.filter((entry): entry is RecoveryMechanism => MECHANISMS.includes(entry as RecoveryMechanism))
      : []),
    ...(MECHANISMS.includes(priorRecovery?.mechanism as RecoveryMechanism)
      ? [priorRecovery?.mechanism as RecoveryMechanism] : []),
  ]);
  let mechanism = resumableMechanism ?? selectMechanism(state, usedMechanisms, priorRecovery);
  let strategyEpoch = Number(priorJournal?.strategy_epoch || 0);
  let controllerCanonicalSynthesis = false;
  if (!mechanism) {
    mechanism = 'criterion_sharded_reconstruction';
    strategyEpoch += 1;
    controllerCanonicalSynthesis = true;
  }
  const { hashes, diagnosticIdentity } = diagnosticContext(state, block, mechanism);
  const resolved = state.artifact_contract_recovery as Record<string, unknown> | undefined;
  if (resolved?.status === 'resolved' && resolved.diagnostic_identity === diagnosticIdentity) {
    return { kind: 'resolved', diagnostic_identity: diagnosticIdentity };
  }
  let journal = priorJournal;
  if (!journal || journal.diagnostic_identity !== diagnosticIdentity) {
    journal = {
      schema_version: 1,
      review_identity: state.review_identity,
      diagnostic_identity: diagnosticIdentity,
      mechanism,
      failed_candidate_hashes: hashes,
      validator_invariants: [...VALIDATOR_INVARIANTS],
      mechanism_history: [...new Set([...usedMechanisms, mechanism])],
      strategy_epoch: strategyEpoch,
      status: 'started',
      attempts: [],
      updated_at: new Date().toISOString(),
    };
  }
  journal.strategy_epoch = strategyEpoch;
  const interrupted = journal.attempts.at(-1);
  if (interrupted?.status === 'started' && fs.existsSync(interrupted.candidate_path)) {
    try {
      const candidateValue = readJsonFile(interrupted.candidate_path, null);
      if (interrupted.strategy_id === 'controller_canonical_synthesis') {
        const epoch = Number(interrupted.strategy_epoch);
        const expected = controllerCanonicalStrategy(
          sessionDir, state, block, diagnosticIdentity, hashes, epoch, journal.attempts.slice(0, -1),
        );
        if (!Number.isInteger(epoch) || epoch <= 0 || journal.strategy_epoch !== epoch
          || mechanism !== 'criterion_sharded_reconstruction'
          || interrupted.candidate_path !== expected.candidatePath
          || interrupted.strategy_instruction !== expected.strategyInstruction
          || interrupted.input_identity !== expected.inputIdentity
          || interrupted.strategy_material_hash !== expected.materialHash
          || JSON.stringify(candidateValue) !== JSON.stringify(expected.artifact)) {
          throw new ReviewerRecoveryIntegrityError(
            'Persisted controller recovery strategy or candidate does not match its canonical material identity.',
          );
        }
      }
      const artifact = validateArtifact(
        candidateValue,
        { reviewIdentity: state.review_identity, diagnosticIdentity, mechanism, hashes },
      );
      try {
        options.faultInjection?.('artifact-ready-before-resolution');
      } catch (error) {
        throw new ReviewerRecoveryFault('Injected failure before reviewer recovery resolution.', { cause: error });
      }
      const runtimeArtifacts = await materializeRuntimeArtifacts(
        sessionDir, state, block, artifact, options, manager, statePath,
      );
      return persistResolvedWithFaultBoundary(sessionDir, state, journal, artifact, runtimeArtifacts, options);
    } catch (error) {
      if (error instanceof ReviewerRecoveryFault || error instanceof ReviewerRecoveryIntegrityError) throw error;
      if (error instanceof ReviewerRecoveryPending) {
        return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
      }
      const ownershipDrain = durableOwnershipDrainCause(error);
      if (ownershipDrain) throw ownershipDrain;
      interrupted.status = 'rejected';
      interrupted.error = error instanceof Error ? error.message : String(error);
      interrupted.completed_at = new Date().toISOString();
    }
  } else if (interrupted?.status === 'started') {
    interrupted.status = 'interrupted';
    interrupted.error = 'Prior reviewer contract recovery worker ended before writing its candidate artifact.';
    interrupted.completed_at = new Date().toISOString();
    journal.status = 'interrupted';
    journal.updated_at = interrupted.completed_at;
    atomicWriteJson(recoveryJournalPath(sessionDir), journal);
  }
  if (controllerCanonicalSynthesis) {
    const canonical = controllerCanonicalStrategy(
      sessionDir, state, block, diagnosticIdentity, hashes, strategyEpoch, journal.attempts,
    );
    const { strategyId, strategyInstruction, inputIdentity, materialHash, candidatePath, artifact } = canonical;
    if (journal.attempts.some((entry) => entry.strategy_material_hash === materialHash)) {
      throw new Error('Citadel reviewer outer recovery refused an identical material strategy replay.');
    }
    ensureDir(path.dirname(candidatePath));
    const attempt: ReviewerAttempt = {
      ordinal: journal.attempts.length + 1,
      status: 'started',
      candidate_path: candidatePath,
      started_at: new Date().toISOString(),
      strategy_epoch: strategyEpoch,
      strategy_id: strategyId,
      strategy_instruction: strategyInstruction,
      strategy_material_hash: materialHash,
      input_identity: inputIdentity,
    };
    journal.attempts.push(attempt);
    journal.status = 'started';
    journal.updated_at = attempt.started_at;
    atomicWriteJson(recoveryJournalPath(sessionDir), journal);
    atomicWriteJson(candidatePath, artifact);
    try {
      options.faultInjection?.('controller-strategy-ready-before-child');
    } catch (error) {
      throw new ReviewerRecoveryFault('Injected failure after controller recovery strategy persistence.', { cause: error });
    }
    try {
      const runtimeArtifacts = await materializeRuntimeArtifacts(
        sessionDir, state, block, artifact, options, manager, statePath,
      );
      return persistResolvedWithFaultBoundary(sessionDir, state, journal, artifact, runtimeArtifacts, options);
    } catch (error) {
      if (error instanceof ReviewerRecoveryPending) {
        return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
      }
      const ownershipDrain = durableOwnershipDrainCause(error);
      if (ownershipDrain) throw ownershipDrain;
      attempt.status = 'rejected';
      attempt.error = error instanceof Error ? error.message : String(error);
      attempt.completed_at = new Date().toISOString();
      journal.status = 'rejected';
      journal.updated_at = attempt.completed_at;
      atomicWriteJson(recoveryJournalPath(sessionDir), journal);
      return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
    }
  }
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-citadel-reviewer-contract-'));
  const candidatePath = path.join(candidateDir, 'reviewer-contract-recovery.json');
  const lastMessagePath = path.join(candidateDir, 'last-message.txt');
  const attempt: ReviewerAttempt = {
    ordinal: journal.attempts.length + 1,
    status: 'started',
    candidate_path: candidatePath,
    started_at: new Date().toISOString(),
  };
  journal.attempts.push(attempt);
  journal.status = 'started';
  journal.updated_at = attempt.started_at;
  atomicWriteJson(recoveryJournalPath(sessionDir), journal);
  const prompt = [
    'You are the autonomous Citadel reviewer artifact-contract recovery worker.',
    `Review identity: ${state.review_identity}`,
    `Diagnostic identity: ${diagnosticIdentity}`,
    `Closed recovery mechanism: ${mechanism}`,
    `Autonomous recovery strategy epoch: ${strategyEpoch}`,
    `Exact failed candidate hashes JSON: ${JSON.stringify(hashes)}`,
    `Exact validator invariants JSON: ${JSON.stringify(VALIDATOR_INVARIANTS)}`,
    `Persisted system evidence: ${block.evidence}`,
    `Write the strict recovery artifact to: ${candidatePath}`,
    'Write exactly one JSON object with schema_version, review_identity, diagnostic_identity, mechanism, failed_candidate_hashes, validator_invariants, instruction, and rationale. Echo every identity, hash, mechanism, and invariant exactly. The instruction must give a concrete reconstruction procedure grounded in the listed failed candidates and invariants.',
    'Return <promise>CITADEL_REVIEWER_CONTRACT_RECOVERY_COMPLETE</promise> after writing the artifact.',
  ].join('\n\n');
  const startedAt = Date.now();
  try {
    recoverMonitoredProcessOwnership(manager, statePath);
    const result = await runCodexExecMonitored({
      telemetry: { sessionDir, ticketId: 'citadel-reviewer-contract', phase: 'citadel_reviewer_contract_repair' },
      execArgs: ['--sandbox', 'workspace-write', '--skip-git-repo-check'],
      cwd: candidateDir,
      prompt,
      timeoutMs: options.timeoutMs || 900_000,
      outputLastMessagePath: lastMessagePath,
      progressArtifactPaths: [candidatePath],
      addDirs: [],
      inheritConfiguredAddDirs: false,
      successCheck: ({ stdout, lastMessage }) => (
        hasPromiseToken(stdout, 'CITADEL_REVIEWER_CONTRACT_RECOVERY_COMPLETE')
        || hasPromiseToken(lastMessage, 'CITADEL_REVIEWER_CONTRACT_RECOVERY_COMPLETE')
      ),
      ...monitoredProcessStateCallbacks(manager, statePath, 'codex', 'citadel-reviewer-contract-repair'),
      cancelCheck: () => {
        options.assertDurableOwnership?.();
        const cancelledAt = Date.parse(String(manager.read(statePath).cancel_requested_at || ''));
        return Number.isFinite(cancelledAt) && cancelledAt >= startedAt;
      },
    });
    options.assertDurableOwnership?.();
    assertCodexSucceeded(result, 'Citadel reviewer artifact-contract recovery failed');
    const artifact = validateArtifact(
      readJsonFile(candidatePath, null),
      { reviewIdentity: state.review_identity, diagnosticIdentity, mechanism, hashes },
    );
    try {
      options.faultInjection?.('artifact-ready-before-resolution');
    } catch (error) {
      throw new ReviewerRecoveryFault('Injected failure before reviewer recovery resolution.', { cause: error });
    }
    const runtimeArtifacts = await materializeRuntimeArtifacts(
      sessionDir, state, block, artifact, options, manager, statePath,
    );
    return persistResolvedWithFaultBoundary(sessionDir, state, journal, artifact, runtimeArtifacts, options);
  } catch (error) {
    if (error instanceof ReviewerRecoveryFault) throw error;
    if (error instanceof ReviewerRecoveryPending) {
      return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
    }
    const ownershipDrain = durableOwnershipDrainCause(error);
    if (ownershipDrain) {
      throw ownershipDrain;
    }
    attempt.status = 'rejected';
    attempt.error = error instanceof Error ? error.message : String(error);
    attempt.completed_at = new Date().toISOString();
    journal.status = 'rejected';
    journal.updated_at = attempt.completed_at;
    atomicWriteJson(recoveryJournalPath(sessionDir), journal);
    return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
  }
}
