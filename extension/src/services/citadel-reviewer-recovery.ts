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
import { deriveCitadelAcceptanceCriteria, type CitadelSystemBlockArtifact } from './citadel.js';
import { assertRecordedActiveChildRecovered, captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
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
  worktree_path?: string;
  worktree_checkpoint_head?: string;
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
  status: 'pending' | 'running' | 'resolved';
  shards: CriterionShardWork[];
  updated_at: string;
}

interface RecoveryOptions {
  timeoutMs?: number;
  assertDurableOwnership?: () => void;
  faultInjection?: (point: 'artifact-ready-before-resolution') => void;
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
class ReviewerRecoveryFault extends Error {}
class ReviewerRecoveryPending extends Error {}
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
      prior.status = 'interrupted';
      prior.error = 'Prior criterion shard worker ended before writing its candidate.';
      prior.completed_at = new Date().toISOString();
      journal.updated_at = prior.completed_at;
      atomicWriteJson(journalPath, journal);
    }
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-citadel-criterion-shard-'));
    const candidatePath = path.join(candidateDir, 'criterion-shard-result.json');
    const lastMessagePath = path.join(candidateDir, 'last-message.txt');
    const isolated = createDisposableDetachedWorktree(liveWorkingDir, 'pickle-citadel-criterion-shard-');
    const isolatedFingerprint = getWorkingTreeFingerprint(isolated.workingDir);
    const attempt: CriterionShardAttempt = {
      ordinal: shard.attempts.length + 1,
      status: 'started',
      candidate_path: candidatePath,
      worktree_path: isolated.workingDir,
      worktree_checkpoint_head: isolated.checkpointHead,
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
      const repositoryContext = criterionRepositoryContext(isolated.workingDir, block);
      if (repositoryContext.checkpointHead !== planRepositoryContext.checkpointHead) {
        throw new Error(`Criterion shard ${shard.shard_id} isolated checkpoint does not match its durable plan.`);
      }
      const prompt = [
        'You are the autonomous Citadel criterion-shard review worker.',
        `Review identity: ${state.review_identity}`,
        `Diagnostic identity: ${artifact.diagnostic_identity}`,
        `Shard plan identity: ${shardPlanIdentity}`,
        `Shard ID: ${shard.shard_id}`,
        `Exact acceptance criterion JSON: ${JSON.stringify(shard.criterion)}`,
        'Inspect the repository at the exact detached checkpoint before deciding this shard.',
        `Expected repository HEAD: ${repositoryContext.checkpointHead}`,
        `Immutable reviewed range: ${repositoryContext.reviewedRange}`,
        `Eligible repository paths JSON: ${JSON.stringify(repositoryContext.repositoryPaths)}`,
        `Deterministic checks JSON: ${JSON.stringify(block.checks)}`,
        `Write the strict shard result to: ${candidatePath}`,
        'Write exactly one JSON object with schema_version:1, shard_id, criterion, checkpoint_head, reviewed_range, status (pass or fail), evidence (non-empty string array), repository_paths (non-empty eligible path array), repository_evidence (non-empty array of exact {path,sha256,observation} objects derived from files you actually read), checks_cited (non-empty exact deterministic command array), and findings (array). Inspect the reviewed diff and cited repository files, hash their exact bytes with SHA-256, and record a concrete observation. Assess only this exact criterion. Do not write a Citadel report.',
        'Return <promise>CITADEL_CRITERION_SHARD_COMPLETE</promise> after writing the shard result.',
      ].join('\n\n');
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
        onSpawn: (child) => manager.update(statePath, (current) => {
          current.active_child_pid = child.pid;
          current.active_child_kind = 'codex';
          current.active_child_command = `citadel-criterion-shard-${shard.shard_id}`;
          current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
          current.active_child_controller_pid = process.pid;
          return current;
        }),
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
      attempt.status = 'rejected';
      attempt.error = error instanceof Error ? error.message : String(error);
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
          manager.update(statePath, (current) => {
            current.active_child_pid = null;
            current.active_child_kind = null;
            current.active_child_command = null;
            current.active_child_identity = null;
            current.active_child_controller_pid = null;
            return current;
          });
        }
      }
    }
  }
  journal.status = 'resolved';
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(journalPath, journal);
  const results = journal.shards.map((shard) => {
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
  atomicWriteJson(recoveryJournalPath(sessionDir), journal);
  state.recovery_epoch += 1;
  state.status = 'running';
  state.strategy_id = 'artifact-contract-reconstruction';
  state.strategy_hash = '';
  state.artifact_contract_recovery = {
    schema_version: 1,
    status: 'resolved',
    diagnostic_identity: artifact.diagnostic_identity,
    artifact_path: artifactPath,
    instruction: artifact.instruction.trim(),
    mechanism: artifact.mechanism,
    failed_candidate_hashes: artifact.failed_candidate_hashes,
    validator_invariants: artifact.validator_invariants,
    mechanism_history: journal.mechanism_history,
    runtime_artifacts: runtimeArtifacts,
    resolved_at: completedAt,
  };
  state.updated_at = completedAt;
  atomicWriteJson(path.join(sessionDir, 'citadel-review-state.json'), state);
  return { kind: 'resolved', diagnostic_identity: artifact.diagnostic_identity };
}

export async function repairCitadelReviewerArtifactContract(
  sessionDir: string,
  block: CitadelSystemBlockArtifact,
  options: {
    timeoutMs?: number;
    assertDurableOwnership?: () => void;
    faultInjection?: (point: 'artifact-ready-before-resolution') => void;
  } = {},
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
  const priorJournal = readJsonFile<ReviewerRecoveryJournal>(recoveryJournalPath(sessionDir), null);
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
  const mechanism = resumableMechanism ?? selectMechanism(state, usedMechanisms, priorRecovery);
  if (!mechanism) {
    return {
      kind: 'recovery_scheduled',
      diagnostic_identity: priorJournal?.diagnostic_identity || sha256({
        review_identity: state.review_identity,
        system_failure_identity: block.failure_identity,
        failed_candidate_hashes: failedCandidateHashes(state),
        validator_invariants: VALIDATOR_INVARIANTS,
        mechanisms_exhausted: [...usedMechanisms].sort(),
      }),
    };
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
      status: 'started',
      attempts: [],
      updated_at: new Date().toISOString(),
    };
  }
  const interrupted = journal.attempts.at(-1);
  if (interrupted?.status === 'started' && fs.existsSync(interrupted.candidate_path)) {
    try {
      const artifact = validateArtifact(
        readJsonFile(interrupted.candidate_path, null),
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
      return persistResolved(sessionDir, state, journal, artifact, runtimeArtifacts);
    } catch (error) {
      if (error instanceof ReviewerRecoveryFault) throw error;
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
    `Exact failed candidate hashes JSON: ${JSON.stringify(hashes)}`,
    `Exact validator invariants JSON: ${JSON.stringify(VALIDATOR_INVARIANTS)}`,
    `Persisted system evidence: ${block.evidence}`,
    `Write the strict recovery artifact to: ${candidatePath}`,
    'Write exactly one JSON object with schema_version, review_identity, diagnostic_identity, mechanism, failed_candidate_hashes, validator_invariants, instruction, and rationale. Echo every identity, hash, mechanism, and invariant exactly. The instruction must give a concrete reconstruction procedure grounded in the listed failed candidates and invariants.',
    'Return <promise>CITADEL_REVIEWER_CONTRACT_RECOVERY_COMPLETE</promise> after writing the artifact.',
  ].join('\n\n');
  const startedAt = Date.now();
  let preserveActiveChild = false;
  try {
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
      onSpawn: (child) => manager.update(statePath, (current) => {
        current.active_child_pid = child.pid;
        current.active_child_kind = 'codex';
        current.active_child_command = 'citadel-reviewer-contract-repair';
        current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
        current.active_child_controller_pid = process.pid;
        return current;
      }),
      cancelCheck: () => {
        try {
          options.assertDurableOwnership?.();
        } catch (error) {
          preserveActiveChild = true;
          throw error;
        }
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
    return persistResolved(sessionDir, state, journal, artifact, runtimeArtifacts);
  } catch (error) {
    if (error instanceof ReviewerRecoveryFault) throw error;
    if (error instanceof ReviewerRecoveryPending) {
      return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
    }
    const ownershipDrain = durableOwnershipDrainCause(error);
    if (ownershipDrain) {
      preserveActiveChild = true;
      throw ownershipDrain;
    }
    attempt.status = 'rejected';
    attempt.error = error instanceof Error ? error.message : String(error);
    attempt.completed_at = new Date().toISOString();
    journal.status = 'rejected';
    journal.updated_at = attempt.completed_at;
    atomicWriteJson(recoveryJournalPath(sessionDir), journal);
    return { kind: 'recovery_scheduled', diagnostic_identity: diagnosticIdentity };
  } finally {
    if (!preserveActiveChild) {
      try {
        manager.update(statePath, (current) => {
          current.active_child_pid = null;
          current.active_child_kind = null;
          current.active_child_command = null;
          current.active_child_identity = null;
          current.active_child_controller_pid = null;
          return current;
        });
      } catch {
        // Durable recovery identity remains available in the journal if state cleanup loses a race.
      }
    }
  }
}
