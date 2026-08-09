import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CitadelSystemBlockArtifact } from './citadel.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { assertCodexSucceeded, runCodexExecMonitored } from './codex.js';
import { hasPipelineContract } from './pipeline.js';
import { resetPipelineForAutonomousRemediation } from './pipeline-state.js';
import { normalizeTicketId, readManifest, updateTicketStatus } from './tickets.js';
import { normalizeVerificationSteps, verificationStepCommand } from './verification-env.js';
import type { CodexSpawnResult } from '../types/index.js';
import { createDisposableDetachedWorktree } from './disposable-worktree.js';
import { assertRecordedActiveChildRecovered } from './orphan-reaper.js';
import { StateManager } from './state-manager.js';

const RECOVERY_FILE = 'citadel-deterministic-recovery.json';
const STRATEGIES = [
  ['replay-exact-obligation', 'Replay the exact failed obligation from its preserved command and diagnostic output.'],
  ['isolate-failing-obligation', 'Isolate the failed obligation from unrelated verification steps before repairing it.'],
  ['rebuild-verification-fixture', 'Rebuild the verification fixture and deterministic prerequisites named by the diagnostic.'],
  ['repair-candidate-from-diagnostic', 'Repair the candidate directly from the preserved command output, then rerun the same obligation.'],
  ['verification-contract-repair', 'Use the sealed verification-contract repair path without weakening the deterministic obligation.'],
] as const;

interface RecoveryAttempt {
  strategy_id: string;
  strategy_hash: string;
  ticket_id: string;
  scheduled_at: string;
}

interface RecoveryJournal {
  schema_version: 1;
  failure_identity: string;
  evidence: string;
  failed_checks: CitadelSystemBlockArtifact['checks'];
  attempts: RecoveryAttempt[];
  diagnostic_attempts?: Array<{
    ordinal: number;
    strategy_id: string;
    strategy_hash: string;
    status: 'started' | 'interrupted' | 'rejected' | 'resolved';
    error?: string;
    artifact_path: string;
    attempted_at: string;
  }>;
  resolved_mappings?: DeterministicDiagnosticMapping[];
  status: 'scheduled' | 'diagnostic_scheduled';
  diagnostic_reason?: string;
  updated_at: string;
}

interface DeterministicDiagnosticMapping {
  ticket_id: string;
  check_commands: string[];
  acceptance_criteria: string[];
  paths: string[];
  rationale: string;
}

export type DeterministicRecoveryResult =
  | { kind: 'verification_repair_scheduled'; ticket_id: string; strategy_id: string; strategy_hash: string }
  | { kind: 'diagnostic_recovery_scheduled'; reason: string; strategy_id: string; strategy_hash: string };

export type DeterministicDiagnosticResult =
  | { kind: 'resolved'; ticket_ids: string[] }
  | { kind: 'retry_scheduled'; reason: string };

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function recoveryIdentity(block: CitadelSystemBlockArtifact): string {
  return hash({
    code: block.code,
    reviewed_range: block.reviewed_range,
    evidence: block.evidence,
    checks: block.checks.map(({ command, status, exit_code, output }) => ({ command, status, exit_code, output })),
  });
}

export function consumeDeterministicCheckFailure(
  sessionDir: string,
  block: CitadelSystemBlockArtifact,
): DeterministicRecoveryResult {
  if (block.code !== 'deterministic_check_failed') {
    const reason = `Unsupported Citadel system recovery code: ${block.code}`;
    const strategyId = 'diagnose-unsupported-system-recovery';
    return { kind: 'diagnostic_recovery_scheduled', reason, strategy_id: strategyId, strategy_hash: hash({ strategyId, reason }) };
  }
  const identity = recoveryIdentity(block);
  const journalPath = path.join(sessionDir, RECOVERY_FILE);
  const prior = readJsonFile<RecoveryJournal>(journalPath, null);
  const journal: RecoveryJournal = prior?.schema_version === 1 && prior.failure_identity === identity
    ? prior
    : {
        schema_version: 1,
        failure_identity: identity,
        evidence: block.evidence,
        failed_checks: structuredClone(block.checks),
        attempts: [],
        status: 'scheduled',
        updated_at: new Date().toISOString(),
      };
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  const workingDir = String(state?.working_dir || process.cwd());
  const failedCommands = new Set(block.checks.filter((check) => check.status === 'failed').map((check) => check.command));
  const ticketCommands = readManifest(sessionDir).tickets.map((ticket) => {
    const steps = normalizeVerificationSteps(ticket.verification, { verify: ticket.verify, cwd: workingDir });
    return { ticket, commands: new Set(steps.map((step) => verificationStepCommand(step).display)) };
  });
  const ownersByCommand = [...failedCommands].map((command) => ticketCommands
    .filter(({ commands }) => commands.has(command))
    .map(({ ticket }) => ticket));
  const exclusiveOwnerId = ownersByCommand.length > 0
    && ownersByCommand.every((owners) => owners.length === 1)
    && new Set(ownersByCommand.map(([owner]) => normalizeTicketId(owner.id, owner.id))).size === 1
    ? normalizeTicketId(ownersByCommand[0][0].id, ownersByCommand[0][0].id)
    : null;
  const owners = exclusiveOwnerId
    ? [ownersByCommand[0][0]]
    : [...new Map(ownersByCommand.flat().map((ticket) => [normalizeTicketId(ticket.id, ticket.id), ticket])).values()];
  if (!exclusiveOwnerId) {
    const reason = ownersByCommand.some((commandOwners) => commandOwners.length === 0)
      ? 'At least one failed deterministic command has no ticket owner.'
      : 'Failed deterministic commands do not map exclusively to one common ticket owner.';
    const priorHashes = journal.attempts.map((attempt) => attempt.strategy_hash);
    const strategyId = `diagnose-check-ownership-${journal.attempts.length + 1}`;
    const strategyHash = hash({
      material_approach: strategyId,
      failure_identity: identity,
      unresolved_strategy_hashes: priorHashes,
    });
    journal.attempts.push({
      strategy_id: strategyId,
      strategy_hash: strategyHash,
      ticket_id: 'unattributed-deterministic-check',
      scheduled_at: new Date().toISOString(),
    });
    journal.status = 'diagnostic_scheduled';
    journal.diagnostic_reason = reason;
    journal.updated_at = new Date().toISOString();
    atomicWriteJson(journalPath, journal);
    return { kind: 'diagnostic_recovery_scheduled', reason, strategy_id: strategyId, strategy_hash: strategyHash };
  }
  const used = new Set(journal.attempts.map((attempt) => attempt.strategy_id));
  const strategy = STRATEGIES.find(([id]) => !used.has(id));
  if (!strategy) {
    const reason = 'All direct ticket recovery strategies are exhausted; schedule a cross-phase diagnostic from preserved evidence.';
    const strategyId = `diagnose-cross-phase-causal-gap-${journal.attempts.length + 1}`;
    const strategyHash = hash({
      material_approach: strategyId,
      failure_identity: identity,
      unresolved_strategy_hashes: journal.attempts.map((attempt) => attempt.strategy_hash),
    });
    journal.attempts.push({
      strategy_id: strategyId,
      strategy_hash: strategyHash,
      ticket_id: normalizeTicketId(owners[0].id, owners[0].id),
      scheduled_at: new Date().toISOString(),
    });
    journal.status = 'diagnostic_scheduled';
    journal.diagnostic_reason = reason;
    journal.updated_at = new Date().toISOString();
    atomicWriteJson(journalPath, journal);
    return { kind: 'diagnostic_recovery_scheduled', reason, strategy_id: strategyId, strategy_hash: strategyHash };
  }
  const [strategyId, materialApproach] = strategy;
  const strategyHash = hash({ material_approach: { id: strategyId, instruction: materialApproach }, failure_identity: identity });
  const ticketId = normalizeTicketId(owners[0].id, owners[0].id);
  const recoveryTask = [
    'Repair the exact Citadel deterministic verification failure without weakening its obligation.',
    `Failure identity: ${identity}`,
    `Material recovery strategy: ${strategyId} (${strategyHash}) — ${materialApproach}`,
    `Exact failed checks: ${JSON.stringify(block.checks)}`,
    `Exact Citadel evidence: ${block.evidence}`,
  ].join('\n');
  updateTicketStatus(sessionDir, ticketId, {
    status: 'Todo',
    failure_kind: 'verification_failed',
    failure_reason: block.evidence,
    recovery_task: recoveryTask,
    citadel_system_failure_identity: identity,
    citadel_deterministic_recovery_strategy: { id: strategyId, hash: strategyHash },
  });
  journal.attempts.push({
    strategy_id: strategyId,
    strategy_hash: strategyHash,
    ticket_id: ticketId,
    scheduled_at: new Date().toISOString(),
  });
  journal.status = 'scheduled';
  delete journal.diagnostic_reason;
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(journalPath, journal);
  if (hasPipelineContract(sessionDir)) {
    resetPipelineForAutonomousRemediation(sessionDir, block.evidence);
  }
  return { kind: 'verification_repair_scheduled', ticket_id: ticketId, strategy_id: strategyId, strategy_hash: strategyHash };
}

function validateDiagnosticArtifact(
  value: unknown,
  journal: RecoveryJournal,
  sessionDir: string,
): DeterministicDiagnosticMapping[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('diagnostic artifact must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join('\0') !== ['failure_identity', 'mappings', 'schema_version'].sort().join('\0')
    || raw.schema_version !== 1 || raw.failure_identity !== journal.failure_identity || !Array.isArray(raw.mappings)) {
    throw new Error('diagnostic artifact schema or failure identity is invalid');
  }
  const tickets = readManifest(sessionDir).tickets;
  const failedCommands = new Set(journal.failed_checks.filter((check) => check.status === 'failed').map((check) => check.command));
  const covered = new Set<string>();
  const mappings = raw.mappings.map((entry, index): DeterministicDiagnosticMapping => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`diagnostic mapping ${index} must be an object`);
    const mapping = entry as Record<string, unknown>;
    if (Object.keys(mapping).sort().join('\0')
      !== ['acceptance_criteria', 'check_commands', 'paths', 'rationale', 'ticket_id'].sort().join('\0')) {
      throw new Error(`diagnostic mapping ${index} schema is invalid`);
    }
    const ticketId = normalizeTicketId(String(mapping.ticket_id || ''), String(mapping.ticket_id || ''));
    const ticket = tickets.find((candidate) => normalizeTicketId(candidate.id, candidate.id) === ticketId);
    const strings = (field: string): string[] => {
      const fieldValue = mapping[field];
      if (!Array.isArray(fieldValue) || fieldValue.length === 0
        || !fieldValue.every((item) => typeof item === 'string' && item.trim())) {
        throw new Error(`diagnostic mapping ${index} ${field} must be a non-empty string array`);
      }
      return [...new Set(fieldValue.map((item) => String(item).trim()))];
    };
    if (!ticket) throw new Error(`diagnostic mapping ${index} references an unknown ticket`);
    const checkCommands = strings('check_commands');
    const acceptanceCriteria = strings('acceptance_criteria');
    const paths = strings('paths');
    const rationale = typeof mapping.rationale === 'string' ? mapping.rationale.trim() : '';
    if (!rationale || checkCommands.some((command) => !failedCommands.has(command))) {
      throw new Error(`diagnostic mapping ${index} rationale or command attribution is invalid`);
    }
    const ticketCriteria = new Set(ticket.acceptance_criteria || []);
    const ticketPaths = new Set(ticket.allowed_paths || []);
    if (acceptanceCriteria.some((criterion) => !ticketCriteria.has(criterion))
      || paths.some((ownedPath) => !ticketPaths.has(ownedPath))) {
      throw new Error(`diagnostic mapping ${index} exceeds the ticket's criteria or path ownership`);
    }
    checkCommands.forEach((command) => covered.add(command));
    return { ticket_id: ticketId, check_commands: checkCommands, acceptance_criteria: acceptanceCriteria, paths, rationale };
  });
  if (mappings.length === 0 || [...failedCommands].some((command) => !covered.has(command))) {
    throw new Error('diagnostic mappings must cover every failed deterministic command');
  }
  return mappings;
}

export async function runDeterministicRecoveryDiagnostic(
  sessionDir: string,
  options: {
    timeoutMs?: number;
    runCodex?: typeof runCodexExecMonitored;
    assertDurableOwnership?: () => void;
  } = {},
): Promise<DeterministicDiagnosticResult> {
  const journalPath = path.join(sessionDir, RECOVERY_FILE);
  const journal = readJsonFile<RecoveryJournal>(journalPath, null);
  if (!journal || journal.status !== 'diagnostic_scheduled') {
    throw new Error('deterministic diagnostic recovery intent is not scheduled');
  }
  journal.diagnostic_attempts = Array.isArray(journal.diagnostic_attempts) ? journal.diagnostic_attempts : [];
  const stateManager = new StateManager();
  assertRecordedActiveChildRecovered(sessionDir, stateManager);
  for (const priorAttempt of journal.diagnostic_attempts) {
    if (priorAttempt.status === 'started') {
      priorAttempt.status = 'interrupted';
      priorAttempt.error = 'Diagnostic controller exited before the attempt completed.';
    }
  }
  atomicWriteJson(journalPath, journal);
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  const liveWorkingDir = String(state?.working_dir || process.cwd());
  const contracts = readManifest(sessionDir).tickets.map((ticket) => ({
    ticket_id: normalizeTicketId(ticket.id, ticket.id),
    acceptance_criteria: ticket.acceptance_criteria || [],
    allowed_paths: ticket.allowed_paths || [],
  }));
  let lastError = journal.diagnostic_attempts.at(-1)?.error || journal.diagnostic_reason || 'unattributed deterministic failure';
  for (let boundedAttempt = 1; boundedAttempt <= 2; boundedAttempt += 1) {
    options.assertDurableOwnership?.();
    const ordinal = journal.diagnostic_attempts.length + 1;
    const strategyId = `strict-evidence-attribution-${ordinal}`;
    const strategyHash = hash({
      material_approach: strategyId,
      failure_identity: journal.failure_identity,
      prior_errors: journal.diagnostic_attempts.map((attempt) => attempt.error || ''),
    });
    const attemptDir = path.join(sessionDir, 'citadel-deterministic-diagnostics', `${journal.failure_identity.slice(0, 12)}-${ordinal}`);
    fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(attemptDir, 'mapping.json');
    fs.rmSync(artifactPath, { force: true });
    const attemptRecord: NonNullable<RecoveryJournal['diagnostic_attempts']>[number] = {
      ordinal,
      strategy_id: strategyId,
      strategy_hash: strategyHash,
      status: 'started',
      artifact_path: artifactPath,
      attempted_at: new Date().toISOString(),
    };
    journal.diagnostic_attempts.push(attemptRecord);
    journal.updated_at = new Date().toISOString();
    atomicWriteJson(journalPath, journal);
    const isolated = createDisposableDetachedWorktree(liveWorkingDir, 'pickle-citadel-diagnostic-');
    const prompt = [
      'You are the deterministic Citadel recovery attribution worker. Do not modify repository or session authority files.',
      `Failure identity: ${journal.failure_identity}`,
      `Exact failed checks and output: ${JSON.stringify(journal.failed_checks)}`,
      `Exact Citadel evidence: ${journal.evidence}`,
      `Candidate ticket contracts: ${JSON.stringify(contracts)}`,
      `Material diagnostic strategy: ${strategyId} (${strategyHash}). Prior failure: ${lastError}`,
      `Write diagnostic mapping artifact: ${artifactPath}`,
      'Write exactly schema_version, failure_identity, mappings. Every mapping requires ticket_id, check_commands, acceptance_criteria, paths, rationale. Use only exact candidate contract values and cover every failed command.',
    ].join('\n\n');
    let ownershipError: unknown = null;
    try {
      const result: CodexSpawnResult = await (options.runCodex ?? runCodexExecMonitored)({
        cwd: isolated.workingDir,
        prompt,
        timeoutMs: options.timeoutMs || 900_000,
        progressArtifactPaths: [artifactPath],
        addDirs: [attemptDir],
        inheritConfiguredAddDirs: false,
        onSpawn: (child, identity) => {
          stateManager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'codex';
            current.active_child_command = `citadel-deterministic-diagnostic-${ordinal}`;
            current.active_child_identity = identity;
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        cancelCheck: () => {
          const current = stateManager.read(path.join(sessionDir, 'state.json'));
          if (current.last_exit_reason === 'cancelled' || current.cancel_requested_at) return true;
          try { options.assertDurableOwnership?.(); return false; } catch (error) { ownershipError = error; return true; }
        },
      });
      if (ownershipError) throw ownershipError;
      options.assertDurableOwnership?.();
      assertCodexSucceeded(result, 'Deterministic recovery diagnostic failed');
      const stat = fs.lstatSync(artifactPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error('diagnostic artifact must be a regular file no larger than 1 MiB');
      }
      const mappings = validateDiagnosticArtifact(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), journal, sessionDir);
      for (const mapping of mappings) {
        updateTicketStatus(sessionDir, mapping.ticket_id, {
          status: 'Todo',
          failure_kind: 'verification_failed',
          failure_reason: journal.evidence,
          recovery_task: [
            'Repair the exact mapped deterministic failure without weakening its obligation.',
            `Failure identity: ${journal.failure_identity}`,
            `Mapped commands: ${JSON.stringify(mapping.check_commands)}`,
            `Mapped acceptance criteria: ${JSON.stringify(mapping.acceptance_criteria)}`,
            `Mapped paths: ${JSON.stringify(mapping.paths)}`,
            `Diagnostic rationale: ${mapping.rationale}`,
            `Exact checks: ${JSON.stringify(journal.failed_checks)}`,
          ].join('\n'),
        });
      }
      attemptRecord.status = 'resolved';
      journal.resolved_mappings = mappings;
      journal.status = 'scheduled';
      delete journal.diagnostic_reason;
      journal.updated_at = new Date().toISOString();
      atomicWriteJson(journalPath, journal);
      if (hasPipelineContract(sessionDir)) resetPipelineForAutonomousRemediation(sessionDir, journal.evidence);
      return { kind: 'resolved', ticket_ids: [...new Set(mappings.map((mapping) => mapping.ticket_id))] };
    } catch (error) {
      if (ownershipError) throw ownershipError;
      lastError = error instanceof Error ? error.message : String(error);
      attemptRecord.status = 'rejected';
      attemptRecord.error = lastError;
      journal.updated_at = new Date().toISOString();
      atomicWriteJson(journalPath, journal);
    } finally {
      try {
        isolated.cleanup();
      } finally {
        try {
          isolated.assertLiveUnchanged();
        } finally {
          if (!ownershipError) {
            stateManager.update(path.join(sessionDir, 'state.json'), (current) => {
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
  }
  return { kind: 'retry_scheduled', reason: lastError };
}
