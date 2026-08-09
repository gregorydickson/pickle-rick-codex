#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { assertCodexSucceeded, hasPromiseToken, runCodexExecMonitored } from '../services/codex.js';
import { loadConfig } from '../services/config.js';
import { recordIteration } from '../services/circuit-breaker.js';
import {
  amendCommitTrailer,
  commitExists,
  commitTrackedChanges,
  countCommitsSince,
  getHeadSha,
  getWorkingTreeStatus,
  hasTrackedWorkingTreeChanges,
  getWorkingTreeFingerprint,
  isGitRepo,
  isIndexClean,
  isWorkingTreeDirty,
  listChangedPathsSince,
  listUntrackedFiles,
  readCommitTrailer,
  resetGitIndex,
  stagePaths,
} from '../services/git-utils.js';
import { buildTicketPhasePrompt } from '../services/prompts.js';
import {
  archiveWorkerLifecycleRefusal,
  prepareWorkerLifecycleArtifact,
  readAndValidateWorkerLifecycleArtifact,
  simplificationRequired,
  workerLifecycleArtifactPath,
  WorkerLifecycleRefusalError,
  WORKER_LIFECYCLE_PHASES,
  type WorkerLifecycleArtifact,
  type WorkerLifecyclePhase,
} from '../services/worker-lifecycle.js';
import { recoverableHardReset } from '../services/recoverable-git.js';
import { assertAcPhaseBoundary } from '../services/ac-phase-gate.js';
import { evaluatePersistedTicketScope, persistTicketScope } from '../services/scope-contract.js';
import {
  captureQualityBaseline,
  captureWorkspaceSnapshot,
  changedPathsSinceSnapshot,
  evaluateWorkerQualityGate,
  assertQualityBaselineFresh,
  QualityBaselineError,
  persistFreshQualityBaseline,
  type QualityBaseline,
  type WorkerGateVerdict,
  type WorkspaceSnapshot,
} from '../services/execution-gate.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
import { appendHistory } from '../services/session.js';
import { recordExecutionControlTelemetry, recordModelCallTelemetry } from '../services/productive-autonomy.js';
import { lifecycleContextInputHash, readLifecycleContextCheckpoint, writeLifecycleContextCheckpoint } from '../services/lifecycle-checkpoints.js';
import {
  clearRejectedCandidateCheckpoint,
  persistRejectedCandidateCheckpoint,
  restoreRejectedCandidateCheckpoint,
} from '../services/candidate-recovery.js';
import { atomicWriteJson, readJsonFile } from '../services/pickle-utils.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  normalizeTicketId,
  readManifest,
  refinementTicketMaterializationPaths,
  restructureTicketFiles,
  restructureTicketFilesInTransaction,
  updateTicketStatus,
} from '../services/tickets.js';
import {
  beginRefinementRepositoryAdvance,
  buildReboundRefinementAcceptance,
  clearRefinementRepositoryAdvance,
  markRefinementRepositoryAdvanceVerified,
  refinementAcceptancePath,
  refinementRepositoryAdvancePath,
  refreshAcceptedRefinementRepositoryIdentity,
  type RefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { runTicketTransaction } from '../services/ticket-transaction.js';
import {
  evaluateCompletionEvidence,
  type CompletionDecision,
  type CompletionDecisionCtx,
} from '../services/ticket-completion-evidence.js';
import {
  assertTicketVerificationReady,
  assertVerificationStepSafe,
  isPreflightError,
  isVerificationContractError,
  normalizeVerificationSteps,
  verificationStepIdentity,
  verificationStepCommand,
  VerificationContractError,
} from '../services/verification-env.js';
import { recordRecoveryStrategyProgress, type RecoveryStrategyEpoch } from '../services/productive-autonomy.js';
import {
  assertTicketVerificationBoundToSeal,
  buildVerificationRepairReceipt,
  persistVerificationRepairReceipt,
  resolveSealedVerificationAuthorization,
  VERIFICATION_REPAIR_TRANSACTION_FILE,
  type VerificationRepairTransaction,
} from '../services/verification-seal-contract.js';
import {
  buildVerificationFailureSet,
  isPipelineSession,
  readTicketVerificationBaseline,
} from '../services/pipeline-state.js';
import type {
  CircuitIterationState,
  CodexSpawnResult,
  Config,
  ConfigVerificationInput,
  SuccessCheck,
  Ticket,
  VerificationEnvResult,
  VerificationFailure,
  VerificationStep,
} from '../types/index.js';

function phasePromiseToken(phase: string): string {
  return `${String(phase || '').toUpperCase()}_COMPLETE`;
}

function phaseSuccessCheck(phase: string, outputLastMessagePath: string): SuccessCheck {
  const token = phasePromiseToken(phase);
  return ({ stdout, lastMessage }) => {
    if (hasPromiseToken(lastMessage, token)) return true;
    if (hasPromiseToken(stdout, token)) return true;
    return Boolean(outputLastMessagePath && hasPromiseToken(
      fs.existsSync(outputLastMessagePath) ? fs.readFileSync(outputLastMessagePath, 'utf8') : '',
      token,
    ));
  };
}

function ticketHasVerificationContracts(ticket: Ticket | null | undefined): boolean {
  return Boolean(
    ticket?.freeze_contract
    || (Array.isArray(ticket?.output_artifacts) && ticket.output_artifacts.length > 0)
    || (Array.isArray(ticket?.proof_corpus) && ticket.proof_corpus.length > 0)
  );
}

function commandReferencesContractArtifacts(ticket: Ticket | null | undefined, command: string): boolean {
  const contractPaths = [
    ...(Array.isArray(ticket?.output_artifacts) ? ticket.output_artifacts : []),
    ...(Array.isArray(ticket?.proof_corpus) ? ticket.proof_corpus : []),
    ticket?.freeze_contract?.artifact_path,
  ].filter(Boolean);
  return contractPaths.some((artifactPath) => String(command || '').includes(String(artifactPath)));
}

function shouldClassifyVerificationContractFailure(ticket: Ticket | null | undefined, command: string): boolean {
  return ticketHasVerificationContracts(ticket) || commandReferencesContractArtifacts(ticket, command);
}

function safeErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    return stderr.trim();
  }
  if (Buffer.isBuffer(stderr)) {
    const text = stderr.toString('utf8').trim();
    if (text) return text;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

interface VerificationCommandErrorInput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failures?: VerificationFailure[];
}

export class VerificationCommandError extends Error {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failures: VerificationFailure[];

  constructor({ command, stdout, stderr, exitCode, failures }: VerificationCommandErrorInput) {
    const output = String(stderr || stdout || command).trim();
    super(`verification-command-failed: ${output || command}`);
    this.name = 'VerificationCommandError';
    this.command = command;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.failures = Array.isArray(failures) ? failures : [];
  }
}

export function isVerificationCommandError(error: unknown): error is VerificationCommandError {
  return error instanceof VerificationCommandError;
}

export function subtractBaselineFailures(
  sessionDir: string,
  ticketId: string,
  command: string,
  cwd: string,
  failures: VerificationFailure[],
): VerificationFailure[] {
  if (!isPipelineSession(sessionDir)) {
    return failures;
  }
  const baseline = readTicketVerificationBaseline(sessionDir, ticketId, command, { cwd });
  if (!baseline || !Array.isArray(baseline.failures) || baseline.failures.length === 0) {
    return failures;
  }
  const baselineIdentities = new Set(
    baseline.failures.map((failure) => String(failure?.identity || '').trim()).filter(Boolean),
  );
  return failures.filter((failure) => failure?.in_scope === true || !baselineIdentities.has(failure.identity));
}

function appendRunnerLog(sessionDir: string, runnerMode: string | null, message: string): void {
  if (!runnerMode) return;
  const descriptor = getRunnerDescriptor(runnerMode);
  fs.appendFileSync(
    path.join(sessionDir, descriptor.runnerLog),
    `[${new Date().toISOString()}] ${message}\n`,
    { mode: 0o600 },
  );
}

const MAX_READ_ONLY_LIFECYCLE_ARTIFACT_ATTEMPTS = 2;

function isLifecycleArtifactContractError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('worker-lifecycle-missing-artifact:')
    || message.startsWith('worker-lifecycle-invalid-artifact:');
}

function archiveLifecycleArtifactFailure(input: {
  sessionDir: string;
  ticketId: string;
  phase: WorkerLifecyclePhase;
  iteration: number;
  attempt: number;
  candidateArtifactPath: string;
  lastMessagePath: string;
  error: unknown;
}): void {
  const archiveDir = path.join(input.sessionDir, 'worker-lifecycle-failures', input.ticketId);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const prefix = `${input.phase}.iteration-${input.iteration}.attempt-${input.attempt}`;
  for (const [source, suffix] of [
    [input.candidateArtifactPath, 'artifact'],
    [input.lastMessagePath, 'last-message.txt'],
  ] as const) {
    try {
      const stat = fs.lstatSync(source);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576) {
        fs.copyFileSync(source, path.join(archiveDir, `${prefix}.${suffix}`));
      }
    } catch {
      // Missing or unsafe diagnostic evidence is described by the metadata below.
    }
  }
  atomicWriteJson(path.join(archiveDir, `${prefix}.json`), {
    schema_version: 1,
    ticket_id: input.ticketId,
    phase: input.phase,
    iteration: input.iteration,
    phase_attempt: input.attempt,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    archived_at: new Date().toISOString(),
  });
}

function normalizeCommitSubject(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function ticketTrailer(ticketId: string): string {
  return `Pickle-Ticket: ${ticketId}`;
}

function ticketCommitMessage(ticketId: string, ticket: Ticket | null | undefined): string {
  const subject = `pickle: ${ticketId} - ${normalizeCommitSubject(ticket?.title, 'completed ticket')}`;
  return `${subject}\n\n${ticketTrailer(ticketId)}`;
}

const TICKET_TRAILER_KEY = 'Pickle-Ticket';

interface ResolveCompletionCommitInput {
  workingDir: string;
  baselineHeadSha: string;
  autoCommitSha: string | null;
  ticketId: string;
}

export function resolveCompletionCommitSha({
  workingDir,
  baselineHeadSha,
  autoCommitSha,
  ticketId,
}: ResolveCompletionCommitInput): string | null {
  if (!isGitRepo(workingDir)) return null;

  // Auto-commit path: spawn-morty owns the commit, whose message already carries the trailer.
  if (autoCommitSha && autoCommitSha.length > 0) {
    if (autoCommitSha === baselineHeadSha) return null;
    return commitExists(workingDir, autoCommitSha) ? autoCommitSha : null;
  }

  // Worker self-commit path.
  const head = getHeadSha(workingDir);
  if (!head || head === baselineHeadSha) return null;
  if (!commitExists(workingDir, head)) return null;

  // Self-commit already carries the matching trailer: trust it, no new/amended commit.
  if (readCommitTrailer(workingDir, head, TICKET_TRAILER_KEY) === ticketId) {
    return head;
  }

  // Reconcile a missing/mismatched trailer by amending the tip — only when the window is a
  // single commit, the candidate is still HEAD (race guard), and the index is clean. Otherwise
  // preserve the verified work and stamp the resolvable candidate unchanged.
  if (countCommitsSince(workingDir, baselineHeadSha) !== 1) return head;
  if (getHeadSha(workingDir) !== head) return head;
  if (!isIndexClean(workingDir)) return head;

  return amendCommitTrailer(workingDir, head, `${TICKET_TRAILER_KEY}: ${ticketId}`) ?? head;
}

interface BuildCompletionCtxInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  startCommit: string | null;
  pinnedSha: string | null;
  workerGate: WorkerGateVerdict;
}

/**
 * The single completion decision seam. Ticket verification, the portable worker
 * quality gate, scope enforcement, and git attribution all converge here. The
 * oracle owns the durable completion pointer and the only Done-flip decision.
 */
function buildCompletionCtx({
  sessionDir,
  ticketId,
  workingDir,
  startCommit,
  pinnedSha,
  workerGate,
}: BuildCompletionCtxInput): CompletionDecisionCtx {
  return {
    sessionDir,
    ticketId,
    workingDir,
    startCommit,
    pinnedSha,
    decision: 'done-flip',
    workerGateVerdict: () => ({
      verdict: workerGate.verdict,
      computedVia: workerGate.computedVia,
    }),
  };
}

function repositoryMutationFingerprint(workingDir: string): string {
  return JSON.stringify({
    head: isGitRepo(workingDir) ? getHeadSha(workingDir) : null,
    status: isGitRepo(workingDir) ? getWorkingTreeStatus(workingDir) : null,
    files: getWorkingTreeFingerprint(workingDir),
  });
}

function repositoryRemediationIdentity(workingDir: string): string {
  return JSON.stringify({
    status: isGitRepo(workingDir) ? getWorkingTreeStatus(workingDir) : null,
    files: getWorkingTreeFingerprint(workingDir),
  });
}

function workerGateFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('scope-violation:')) return 'scope_violation';
  if (message.startsWith('worker-quality-gate-')) return 'quality_gate';
  if (message.startsWith('quality-baseline-mutation:')) return 'quality_gate';
  if (message.startsWith('pre-existing-dirt:')) return 'ownership_preflight';
  return 'command_failed';
}

interface WorkerMutationBoundary {
  head: string;
  fingerprint: string;
  untracked: string[];
  allowedPaths: string[];
}

function rejectedWorkerRef(sessionDir: string, ticketId: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `refs/pickle/rejected/${safe(path.basename(sessionDir))}/${safe(ticketId)}`;
}

function restoreRejectedWorkerMutation(
  workingDir: string,
  sessionDir: string,
  ticketId: string,
  boundary: WorkerMutationBoundary,
  runnerMode: string | null,
): string | null {
  if (!isGitRepo(workingDir) || repositoryMutationFingerprint(workingDir) === boundary.fingerprint) return null;
  const remediationIdentity = repositoryRemediationIdentity(workingDir);
  const changedPaths = listChangedPathsSince(workingDir, boundary.head)
    .filter((candidate) => !boundary.untracked.includes(candidate));
  const archive = recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: boundary.head,
    operation: `rejected-${ticketId}`,
    // The worker starts behind a clean mutation boundary, so every subsequent
    // changed path is operation-owned. allowedPaths is an acceptance policy,
    // not an ownership signal; filtering here strands out-of-scope worker dirt.
    ownedPaths: changedPaths,
    evidencePaths: changedPaths,
    headRecoveryRef: rejectedWorkerRef(sessionDir, ticketId),
    log: (message) => appendRunnerLog(sessionDir, runnerMode, message),
  });
  if (repositoryMutationFingerprint(workingDir) !== boundary.fingerprint) {
    throw new Error('worker-rollback-failed: rejected worker changes were anchored, but the original repository boundary was not restored');
  }
  const recoveryRef = archive.dirtyRef || archive.headRef;
  if (recoveryRef) {
    persistRejectedCandidateCheckpoint({ sessionDir, workingDir, ticketId, baseHead: boundary.head, recoveryRef });
  }
  return remediationIdentity;
}

interface AutoCommitDetachedTicketChangesInput {
  sessionDir: string;
  runnerMode: string | null;
  workingDir: string;
  tmuxMode: boolean;
  baselineTrackedClean: boolean;
  baselineUntrackedFiles: string[];
  ticketId: string;
  ticket: Ticket;
  config: Config;
  changedPaths: string[];
  assertDurableOwnership?: () => void;
}

function autoCommitDetachedTicketChanges({
  sessionDir,
  runnerMode,
  workingDir,
  tmuxMode,
  baselineTrackedClean,
  baselineUntrackedFiles,
  ticketId,
  ticket,
  config,
  changedPaths,
  assertDurableOwnership,
}: AutoCommitDetachedTicketChangesInput): string | null {
  if (!tmuxMode || !baselineTrackedClean || !isGitRepo(workingDir) || !isWorkingTreeDirty(workingDir)) {
    return null;
  }

  const currentUntrackedFiles = listUntrackedFiles(workingDir);
  const newUntrackedFiles = currentUntrackedFiles.filter((filePath) => !baselineUntrackedFiles.includes(filePath));
  if (!hasTrackedWorkingTreeChanges(workingDir) && newUntrackedFiles.length === 0) {
    return null;
  }

  appendRunnerLog(sessionDir, runnerMode, `no clean commit boundary detected for ${ticketId}; auto-committing ticket changes`);
  try {
    assertDurableOwnership?.();
    // Stage the already-fenced ticket delta only. Whole-tree staging here would
    // sweep in a concurrent/user or quality-command mutation after scope review.
    resetGitIndex(workingDir);
    stagePaths(workingDir, changedPaths);
    assertDurableOwnership?.();
    commitTrackedChanges(workingDir, ticketCommitMessage(ticketId, ticket));
    const head = getHeadSha(workingDir);
    appendRunnerLog(sessionDir, runnerMode, `ticket ${ticketId} auto-committed: ${head}`);
    logActivity({
      event: 'commit',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket: ticketId,
      commit_hash: head,
    }, { enabled: config.defaults.activity_logging });
    return head || null;
  } catch (error) {
    resetGitIndex(workingDir);
    appendRunnerLog(sessionDir, runnerMode, `ticket ${ticketId} auto-commit failed: ${safeErrorMessage(error)}`);
    throw new Error(`Ticket ${ticketId} completed but auto-commit failed: ${safeErrorMessage(error)}`, { cause: error });
  }
}

class CancellationError extends Error {
  constructor(message = 'Session cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

function readCurrentState(manager: StateManager, statePath: string): PersistedState {
  return manager.read(statePath);
}

function isSessionCancelled(manager: StateManager, statePath: string): boolean {
  return readCurrentState(manager, statePath).active === false;
}

function updateActiveChild(statePath: string, manager: StateManager, fields: Record<string, unknown>): void {
  if (Object.hasOwn(fields, 'active_child_pid')) {
    const pid = Number(fields.active_child_pid);
    const identity = Number.isInteger(pid) && pid > 0 ? captureSpawnedProcessIdentity(pid) : null;
    if (Number.isInteger(pid) && pid > 0 && !identity) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        // A short-lived deterministic command may finish before identity capture.
      }
      if (alive) throw new Error(`Could not persist a safe process identity for worker child ${pid}.`);
    }
    fields.active_child_identity = identity;
    fields.active_child_controller_pid = Number.isInteger(pid) && pid > 0 ? process.pid : null;
  }
  manager.update(statePath, (current) => {
    Object.assign(current, fields);
    return current;
  });
}

function terminateChild(child: ChildProcess | null | undefined, signal: NodeJS.Signals): void {
  const pid = Number(child?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  try {
    child?.kill(signal);
  } catch {
    // Ignore teardown failures.
  }
}

interface RunVerificationCommandOptions {
  step: VerificationStep;
  cwd: string;
  timeoutMs: number;
  manager: StateManager;
  statePath: string;
  env: Record<string, string | undefined>;
  isCancelled: () => boolean;
  onExit: () => void;
  allowedRoots?: string[];
}

async function runVerificationCommand({
  step,
  cwd,
  timeoutMs,
  manager,
  statePath,
  env,
  isCancelled,
  onExit,
  allowedRoots = [],
}: RunVerificationCommandOptions): Promise<void> {
  const stepCwd = assertVerificationStepSafe(step, { cwd, allowedRoots });
  const descriptor = verificationStepCommand(step);
  const command = descriptor.display;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let forcedByCancel = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: stepCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32',
    });

    try {
      updateActiveChild(statePath, manager, {
        active_child_pid: child.pid,
        active_child_kind: 'verification',
        active_child_command: command,
      });
    } catch (error) {
      terminateChild(child, 'SIGTERM');
      setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000).unref?.();
      reject(error);
      return;
    }

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      onExit();
    };

    const settle = (handler: (value?: unknown) => void, value?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    timeoutTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateChild(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateChild(child, 'SIGKILL');
          }
        }, 1_000).unref?.();
      }
    }, timeoutMs);

    cancelTimer = setInterval(() => {
      if (!isCancelled()) return;
      if (child.exitCode === null && child.signalCode === null) {
        forcedByCancel = true;
        terminateChild(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateChild(child, 'SIGKILL');
          }
        }, 1_000).unref?.();
      }
    }, 100);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => settle(reject, error));
    child.on('close', (code) => {
      if (forcedByCancel || isCancelled()) {
        settle(reject, new CancellationError());
        return;
      }
      if (code !== 0) {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        settle(reject, new VerificationCommandError({
          command,
          stdout,
          stderr,
          exitCode: code,
          failures: buildVerificationFailureSet({
            command,
            cwd: stepCwd,
            stdout,
            stderr,
            exitCode: code,
          }),
        }));
        return;
      }
      settle(resolve as (value?: unknown) => void, undefined);
    });
  });
}

interface RunTicketOptions {
  runnerMode?: string | null;
  timeoutMs?: number;
  ticketAttempt?: number;
  recoveryEpoch?: number;
  strategyHash?: string | null;
  recoveryStrategy?: RecoveryStrategyEpoch | null;
  assertDurableOwnership?: () => void;
  recordDurableCheckpoint?: (checkpoint: Record<string, unknown>) => void;
  resumeCheckpoint?: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface RunTicketResult {
  status: string;
  applied: boolean;
  reason?: string;
}

function durableCheckpointDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export async function repairTicketVerificationContract(
  sessionDir: string,
  ticketId: string,
  options: {
    strategy?: RecoveryStrategyEpoch | null;
    timeoutMs?: number;
    diagnosticOnly?: boolean;
    assertDurableOwnership?: () => void;
    afterMaterialization?: () => void;
  } = {},
): Promise<VerificationStep[]> {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  let ownershipDrainError: unknown = null;
  const assertOwnership = (): void => {
    if (ownershipDrainError) throw ownershipDrainError;
    options.assertDurableOwnership?.();
  };
  const shouldCancel = (): boolean => {
    if (isSessionCancelled(manager, statePath)) return true;
    try { assertOwnership(); return false; } catch (error) { ownershipDrainError = error; return true; }
  };
  assertOwnership();
  const state = manager.read(statePath);
  const workingDir = String(state.working_dir || '');
  const normalizedTicketId = normalizeTicketId(ticketId, ticketId);
  const rawManifest = readJsonFile<{ tickets?: Ticket[] }>(path.join(sessionDir, 'refinement_manifest.json'), {}) || {};
  const ticket = rawManifest.tickets?.find((entry) => normalizeTicketId(entry.id, entry.id) === normalizedTicketId);
  if (!ticket) throw new Error(`contract-repair-ticket-missing: ${ticketId}`);
  const manifestBefore = structuredClone(rawManifest) as { tickets: Ticket[] };
  const manifestBeforeIdentity = JSON.stringify(rawManifest);
  const sealedAuthorization = resolveSealedVerificationAuthorization(sessionDir, normalizedTicketId);
  if (fs.existsSync(path.join(sessionDir, 'prd.lock.json')) && !sealedAuthorization) {
    throw new Error(`contract-repair-sealed-verification-authorization-missing: ${normalizedTicketId}`);
  }
  const acceptanceIdentity = JSON.stringify(ticket.acceptance_criteria || []);
  const artifactPath = path.join(sessionDir, 'contract-repairs', `${normalizedTicketId}.json`);
  const lastMessagePath = path.join(sessionDir, `${normalizedTicketId}.contract-repair.last-message.txt`);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
  fs.rmSync(artifactPath, { force: true });
  const prompt = [
    'You are the autonomous verification contract repair worker.',
    `Session dir: ${sessionDir}`,
    `Working directory: ${workingDir}`,
    `Ticket ID: ${normalizedTicketId}`,
    `Contract repair artifact path: ${artifactPath}`,
    `Immutable acceptance criteria JSON: ${acceptanceIdentity}`,
    `Invalid verification representation: ${JSON.stringify(ticket.verification ?? ticket.verify ?? null)}`,
    `Authorized sealed verification steps JSON: ${JSON.stringify(sealedAuthorization?.authorized_steps ?? null)}`,
    options.strategy
      ? `Mandatory material repair strategy: ${options.strategy.materialApproach}; strategy hash ${options.strategy.strategyHash}.`
      : 'Mandatory material repair strategy: recompile-structured-contract.',
    'Inspect the repository only as needed to recover the intended deterministic verification semantics. Do not modify repository files, acceptance criteria, scope, dependencies, or any ticket field.',
    sealedAuthorization
      ? 'Your verification output must be exactly semantically identical to the authorized sealed verification steps. This is reconstruction, never replacement or weakening.'
      : 'This unsealed legacy session has no sealed verification authority; preserve the strongest deterministic semantics recoverable from the existing representation.',
    'Write one JSON object with schema_version: 1, ticket_id, verification (a non-empty array of structured process/package_script/shell steps), and rationale. Prefer process or package_script; shell requires a non-empty justification.',
    'Return <promise>CONTRACT_REPAIR_COMPLETE</promise> after writing the artifact.',
  ].join('\n\n');
  let result;
  try {
    result = await runCodexExecMonitored({
      execArgs: ['--sandbox', 'workspace-write'], cwd: workingDir, prompt,
      timeoutMs: options.timeoutMs || Number(state.worker_timeout_seconds || 900) * 1000,
      outputLastMessagePath: lastMessagePath, progressArtifactPaths: [artifactPath], addDirs: [sessionDir], inheritConfiguredAddDirs: false,
      successCheck: ({ stdout, lastMessage }) => hasPromiseToken(stdout, 'CONTRACT_REPAIR_COMPLETE') || hasPromiseToken(lastMessage, 'CONTRACT_REPAIR_COMPLETE'),
      onSpawn: (child) => updateActiveChild(statePath, manager, { active_child_pid: child.pid, active_child_kind: 'codex', active_child_command: 'contract-repair' }),
      cancelCheck: shouldCancel,
    });
    assertOwnership();
  } finally {
    if (!ownershipDrainError) {
      updateActiveChild(statePath, manager, { active_child_pid: null, active_child_kind: null, active_child_command: null });
    }
  }
  assertCodexSucceeded(result, `Verification contract repair failed for ${normalizedTicketId}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  if (artifact.schema_version !== 1 || artifact.ticket_id !== normalizedTicketId) throw new Error('contract-repair-invalid-artifact: identity mismatch');
  const steps = normalizeVerificationSteps(artifact.verification, sealedAuthorization ? {} : { cwd: workingDir });
  if (steps.length === 0) throw new Error('contract-repair-invalid-artifact: verification is empty');
  if (sealedAuthorization && verificationStepIdentity(steps) !== sealedAuthorization.authorized_identity) {
    throw new Error('contract-repair-invalid-artifact: verification weakens or changes the sealed deterministic obligation');
  }
  if (options.diagnosticOnly) return steps;
  assertOwnership();
  if (JSON.stringify(readJsonFile(path.join(sessionDir, 'refinement_manifest.json'), null)) !== manifestBeforeIdentity) {
    throw new Error('contract-repair-authoritative-manifest-drift-before-apply');
  }
  const currentAuthorization = resolveSealedVerificationAuthorization(sessionDir, normalizedTicketId);
  if (sealedAuthorization && (
    !currentAuthorization
    || currentAuthorization.seal_semantic_hash !== sealedAuthorization.seal_semantic_hash
    || currentAuthorization.sealed_verification_sha256 !== sealedAuthorization.sealed_verification_sha256
    || currentAuthorization.authorized_identity !== sealedAuthorization.authorized_identity
  )) {
    throw new Error('contract-repair-seal-drift-before-apply');
  }
  ticket.verification = steps;
  ticket.verify = steps.map((step) => verificationStepCommand(step).display).join(' && ');
  ticket.status = 'Todo';
  ticket.failure_kind = null;
  ticket.failure_reason = null;
  ticket.contract_repaired_at = new Date().toISOString();
  ticket.contract_repair_strategy_hash = options.strategy?.strategyHash || null;
  if (sealedAuthorization) {
    const receipt = buildVerificationRepairReceipt(
      sealedAuthorization,
      ticket.verification,
      options.strategy?.strategyHash || null,
    );
    const acceptancePath = refinementAcceptancePath(sessionDir);
    const acceptanceBefore = fs.existsSync(acceptancePath)
      ? readJsonFile<RefinementAcceptance>(acceptancePath, null)
      : null;
    if (fs.existsSync(acceptancePath) && !acceptanceBefore) {
      throw new Error('contract-repair-refinement-acceptance-invalid');
    }
    const repairedAcceptance = acceptanceBefore
      ? buildReboundRefinementAcceptance(sessionDir, rawManifest as { tickets: Ticket[] }, { workingDir })
      : null;
    const transaction: VerificationRepairTransaction = {
      schema_version: 1,
      status: 'prepared',
      ticket_id: normalizedTicketId,
      manifest_before: manifestBefore,
      repaired_manifest: rawManifest as { tickets: Ticket[] },
      receipt,
      ...(acceptanceBefore && repairedAcceptance
        ? { acceptance_before: acceptanceBefore, repaired_acceptance: repairedAcceptance }
        : {}),
      prepared_at: new Date().toISOString(),
    };
    atomicWriteJson(path.join(sessionDir, VERIFICATION_REPAIR_TRANSACTION_FILE), transaction);
    runTicketTransaction(
      sessionDir,
      'repair-sealed-verification-contract',
      [
        ...refinementTicketMaterializationPaths(sessionDir, transaction.repaired_manifest),
        ...(repairedAcceptance ? [acceptancePath] : []),
      ],
      () => {
        restructureTicketFilesInTransaction(sessionDir, transaction.repaired_manifest);
        if (repairedAcceptance) atomicWriteJson(acceptancePath, repairedAcceptance);
      },
    );
    options.afterMaterialization?.();
    persistVerificationRepairReceipt(sessionDir, receipt);
    fs.rmSync(path.join(sessionDir, VERIFICATION_REPAIR_TRANSACTION_FILE), { force: true });
  } else {
    restructureTicketFiles(sessionDir, rawManifest as { tickets: Ticket[] });
  }
  assertOwnership();
  const persisted = readManifest(sessionDir).tickets.find((entry) => normalizeTicketId(entry.id, entry.id) === normalizedTicketId);
  if (!persisted || JSON.stringify(persisted.acceptance_criteria || []) !== acceptanceIdentity) {
    throw new Error('contract-repair-acceptance-criteria-mutated');
  }
  if (verificationStepIdentity(normalizeVerificationSteps(persisted.verification, sealedAuthorization ? {} : { cwd: workingDir })) !== verificationStepIdentity(steps)) {
    throw new Error('contract-repair-round-trip-drift');
  }
  if (sealedAuthorization) assertTicketVerificationBoundToSeal(sessionDir, normalizedTicketId, workingDir);
  return steps;
}

export async function runTicket(sessionDir: string, ticketId: string, options: RunTicketOptions = {}): Promise<RunTicketResult> {
  let ownershipDrainError: unknown = null;
  const assertOwnership = (): void => {
    if (ownershipDrainError) throw ownershipDrainError;
    options.assertDurableOwnership?.();
  };
  assertOwnership();
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const manifest = readManifest(sessionDir);
  const config = loadConfig();
  const workingDir = state.working_dir as string;
  const tmuxMode = Boolean(state.tmux_mode);
  const runnerMode = options.runnerMode || null;
  const normalizedTicketId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  const shouldCancel = (): boolean => {
    if (isSessionCancelled(manager, statePath)) return true;
    try { assertOwnership(); return false; } catch (error) { ownershipDrainError = error; return true; }
  };
  const clearActiveChildIfOwned = (): void => {
    if (ownershipDrainError) return;
    updateActiveChild(statePath, manager, {
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });
  };
  const manifestTicket = manifest.tickets.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === normalizedTicketId);
  if (!manifestTicket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  try {
    assertTicketVerificationBoundToSeal(sessionDir, normalizedTicketId, workingDir);
  } catch (error) {
    throw new VerificationContractError({
      ticketId: normalizedTicketId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  let verificationSteps = normalizeVerificationSteps(manifestTicket.verification, {
    verify: manifestTicket.verify,
    cwd: workingDir,
  });
  if (verificationSteps.length === 0) {
    throw new Error(`ticket ${normalizedTicketId} has invalid verification manifest: expected one or more verification commands`);
  }
  const normalizedTicket: Ticket = {
    ...manifestTicket,
    verification: verificationSteps,
  };

  let verificationReady: VerificationEnvResult;
  let baselineFingerprint!: string;
  let baselineTrackedClean!: boolean;
  let baselineUntrackedFiles!: string[];
  let baselineHeadSha!: string;
  let workspaceBaseline!: WorkspaceSnapshot;
  let qualityBaseline!: QualityBaseline;
  let mutationBoundary: WorkerMutationBoundary | null = null;
  let validatedResumeCheckpoint: Record<string, unknown> | null = null;
  const supervisorCheckpointPresented = options.resumeCheckpoint?.kind === 'worker_phase'
    && normalizeTicketId(String(options.resumeCheckpoint.ticket_id || ''), '') === normalizedTicketId;
  const lifecycleArtifacts: WorkerLifecycleArtifact[] = [];
  const refusalPhases: WorkerLifecyclePhase[] = ['research_review', 'plan_review', 'review', 'conformance'];
  const remediationFeedback = refusalPhases
    .flatMap((phase) => {
      const artifactPath = workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase);
      if (!fs.existsSync(artifactPath)) return [];
      let artifact: WorkerLifecycleArtifact;
      try {
        artifact = readAndValidateWorkerLifecycleArtifact(
          artifactPath,
          phase,
          normalizedTicketId,
          normalizedTicket.acceptance_criteria || [],
        );
      } catch (error) {
        if (supervisorCheckpointPresented) return [];
        throw error;
      }
      return artifact.verdict === 'changes_requested'
        ? [{ artifact, mtimeMs: fs.statSync(artifactPath).mtimeMs }]
        : [];
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.artifact ?? null;

  function updateTicketAndClearAdvance(updates: Record<string, unknown>): void {
    assertOwnership();
    const advancePath = refinementRepositoryAdvancePath(sessionDir);
    updateTicketStatus(sessionDir, normalizedTicketId, updates, {
      transactionPaths: [advancePath],
      afterWrite: () => clearRefinementRepositoryAdvance(sessionDir),
    });
  }

  function finalizeSuccess(applied: boolean): RunTicketResult {
    assertOwnership();
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Done',
      completed_at: new Date().toISOString(),
      failure_reason: null,
      failure_kind: null,
      failed_at: null,
    }, {
      transactionPaths: [
        refinementAcceptancePath(sessionDir),
        refinementRepositoryAdvancePath(sessionDir),
        statePath,
      ],
      afterWrite: () => {
        refreshAcceptedRefinementRepositoryIdentity(sessionDir, workingDir);
        clearRefinementRepositoryAdvance(sessionDir);
        manager.update(statePath, (current) => {
          current.step = 'done';
          appendHistory(current, 'done', normalizedTicketId);
          return current;
        });
      },
    });
    clearRejectedCandidateCheckpoint(sessionDir, normalizedTicketId);
    try {
      recordRecoveryStrategyProgress(sessionDir, normalizedTicketId, 'ticket completion passed deterministic verification and completion evidence');
    } catch (error) {
      appendRunnerLog(
        sessionDir,
        runnerMode,
        `ticket ${normalizedTicketId} completed but recovery strategy progress could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      logActivity({
        event: 'ticket_completed',
        source: 'pickle',
        session: path.basename(sessionDir),
        ticket: normalizedTicketId,
      }, { enabled: config.defaults.activity_logging });
    } catch {
      // Durable completion already committed; activity telemetry is best effort.
    }

    return applied
      ? { status: 'done', applied: true }
      : { status: 'done', applied: false, reason: 'No diff generated.' };
  }

  function finalizeRefusal(applied: boolean, decision: CompletionDecision & { ok: false }): RunTicketResult {
    assertOwnership();
    // The oracle found no attributable completion evidence: do NOT flip Done and do
    // NOT stamp a completion_commit. Surface the refusal reason for the caller/logs.
    appendRunnerLog(
      sessionDir,
      runnerMode,
      `ticket ${normalizedTicketId} completion refused by oracle: ${decision.reason}`,
    );
    // Park the ticket with its verdict so an `on-failure=abort` run does not leave it
    // stuck at the start-of-try `In Progress` write (which resume treats as runnable
    // and summaries misreport). Mirrors the preflight-Todo path in the catch block.
    updateTicketAndClearAdvance({
      status: 'Todo',
      failed_at: new Date().toISOString(),
      failure_reason: `completion refused by oracle: ${decision.reason}`,
      failure_kind: 'completion_refused',
    });
    return { status: 'incomplete', applied, reason: decision.reason };
  }

  async function runDeterministicVerification(): Promise<void> {
    assertOwnership();
    manager.update(statePath, (current) => {
      current.step = 'verify';
      appendHistory(current, 'verify', normalizedTicketId);
      return current;
    });
    for (const step of verificationSteps) {
      assertOwnership();
      if (isSessionCancelled(manager, statePath)) throw new CancellationError();
      const command = verificationStepCommand(step).display;
      try {
        await runVerificationCommand({
          step, cwd: workingDir, timeoutMs: config.defaults.worker_timeout_seconds * 1000,
          manager, statePath, env: verificationReady.env, isCancelled: shouldCancel,
          onExit: clearActiveChildIfOwned,
          allowedRoots: [sessionDir],
        });
        assertOwnership();
      } catch (error) {
        assertOwnership();
        if (error instanceof VerificationCommandError) {
          const remainingFailures = subtractBaselineFailures(sessionDir, normalizedTicketId, command, workingDir, error.failures);
          if (remainingFailures.length === 0) continue;
          error.failures = remainingFailures;
        }
        if (!(error instanceof CancellationError) && shouldClassifyVerificationContractFailure(normalizedTicket, command) && !isPreflightError(error)) {
          throw new VerificationContractError({ ticketId: normalizedTicketId, command, message: `verification contract failed for ${command}: ${error instanceof Error ? error.message : String(error)}` });
        }
        throw error;
      }
    }
  }

  try {
    assertOwnership();
    verificationReady = assertTicketVerificationReady({
      ticket: normalizedTicket,
      // Config is a valid verification input at runtime; ConfigDefaults lacks
      // the index signature ConfigVerificationInput models, so widen via unknown.
      config: config as unknown as ConfigVerificationInput,
      cwd: workingDir,
      allowedRoots: [sessionDir],
    });
    if (verificationStepIdentity(verificationReady.steps) !== verificationStepIdentity(verificationSteps)) {
      throw new VerificationContractError({
        ticketId: normalizedTicketId,
        message: 'runtime verification representation differs from the preflight-validated manifest',
      });
    }
    verificationSteps = verificationReady.steps;
    const persistedQualityBaseline = manager.read(statePath).quality_baseline;
    const resume = options.resumeCheckpoint;
    if (resume?.schema_version === 1 && resume.kind === 'worker_phase'
      && normalizeTicketId(String(resume.ticket_id || ''), '') === normalizedTicketId
      && Number.isInteger(resume.lease_generation) && Number(resume.lease_generation) > 0
      && (!isGitRepo(workingDir) || !isWorkingTreeDirty(workingDir))
      && resume.repository_mutation_fingerprint === repositoryMutationFingerprint(workingDir)
      && resume.quality_baseline_digest === durableCheckpointDigest(persistedQualityBaseline)
      && resume.workspace_baseline && typeof resume.workspace_baseline === 'object'
      && !Array.isArray(resume.workspace_baseline)
      && Array.isArray(resume.baseline_untracked_files)
      && typeof resume.baseline_fingerprint === 'string'
      && typeof resume.baseline_tracked_clean === 'boolean') {
      const candidateBaseline = resume.workspace_baseline as unknown as WorkspaceSnapshot;
      const candidateMutationBoundary = resume.mutation_boundary as WorkerMutationBoundary | null;
      const candidateInputHash = lifecycleContextInputHash(normalizedTicket, candidateBaseline.headSha);
      const advance = readJsonFile<Record<string, unknown>>(refinementRepositoryAdvancePath(sessionDir), null);
      const artifactDigests = Array.isArray(resume.artifact_digests) ? resume.artifact_digests : [];
      const completedPhases = Array.isArray(resume.completed_phases) ? resume.completed_phases.map(String) : [];
      const allowedCheckpointPhases: WorkerLifecyclePhase[] = ['research', 'research_review', 'plan', 'plan_review'];
      const phasePrefixValid = completedPhases.length > 0
        && completedPhases.length <= allowedCheckpointPhases.length
        && JSON.stringify(completedPhases) === JSON.stringify(allowedCheckpointPhases.slice(0, completedPhases.length));
      const digestPhases = artifactDigests.map((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry) ? String((entry as Record<string, unknown>).phase || '') : ''
      ));
      const artifactsValid = artifactDigests.length > 0
        && JSON.stringify(digestPhases) === JSON.stringify(completedPhases)
        && artifactDigests.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        const phase = String(record.phase || '') as WorkerLifecyclePhase;
        const artifactPath = workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase);
        return typeof record.sha256 === 'string' && fs.existsSync(artifactPath)
          && fileDigest(artifactPath) === record.sha256;
        });
      if (candidateBaseline && typeof candidateBaseline.headSha === 'string'
        && candidateBaseline.files && typeof candidateBaseline.files === 'object'
        && resume.input_hash === candidateInputHash
        && candidateMutationBoundary && typeof candidateMutationBoundary.fingerprint === 'string'
        && candidateMutationBoundary.fingerprint === resume.repository_mutation_fingerprint
        && JSON.stringify(candidateBaseline) === JSON.stringify(captureWorkspaceSnapshot(workingDir))
        && resume.baseline_fingerprint === getWorkingTreeFingerprint(workingDir)
        && resume.baseline_tracked_clean === true
        && JSON.stringify(resume.baseline_untracked_files) === JSON.stringify(listUntrackedFiles(workingDir))
        && phasePrefixValid
        && artifactsValid
        && advance?.schema_version === 1 && advance.phase === 'started'
        && normalizeTicketId(String(advance.ticket_id || ''), '') === normalizedTicketId
        && advance.baseline_head_sha === candidateBaseline.headSha) {
        workspaceBaseline = structuredClone(candidateBaseline);
        mutationBoundary = structuredClone(candidateMutationBoundary);
        baselineHeadSha = candidateBaseline.headSha;
        baselineFingerprint = String(resume.baseline_fingerprint);
        baselineTrackedClean = Boolean(resume.baseline_tracked_clean);
        baselineUntrackedFiles = resume.baseline_untracked_files.map(String);
        qualityBaseline = assertQualityBaselineFresh(persistedQualityBaseline, workingDir);
        validatedResumeCheckpoint = resume;
      }
    }
    if (!validatedResumeCheckpoint) {
      if (isGitRepo(workingDir) && isWorkingTreeDirty(workingDir)) {
        throw new Error('pre-existing-dirt: worker requires a completely clean working tree; commit, stash, or remove existing tracked and untracked changes first');
      }
      baselineFingerprint = getWorkingTreeFingerprint(workingDir);
      baselineTrackedClean = !isGitRepo(workingDir) || !hasTrackedWorkingTreeChanges(workingDir);
      baselineUntrackedFiles = isGitRepo(workingDir) ? listUntrackedFiles(workingDir) : [];
      baselineHeadSha = isGitRepo(workingDir) ? getHeadSha(workingDir) : '';
      if (baselineHeadSha) {
        mutationBoundary = {
          head: baselineHeadSha,
          fingerprint: repositoryMutationFingerprint(workingDir),
          untracked: baselineUntrackedFiles,
          allowedPaths: [],
        };
      }
      workspaceBaseline = captureWorkspaceSnapshot(workingDir);
      const ticketScope = persistTicketScope(sessionDir, normalizedTicket, normalizedTicketId, workspaceBaseline.headSha);
      if (mutationBoundary) mutationBoundary.allowedPaths = ticketScope.declared_paths;
      assertOwnership();
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'In Progress',
        started_at: new Date().toISOString(),
        failure_reason: null,
        failure_kind: null,
        failed_at: null,
      }, {
        transactionPaths: [refinementRepositoryAdvancePath(sessionDir)],
        afterWrite: () => beginRefinementRepositoryAdvance({
          sessionDir,
          workingDir,
          ticketId: normalizedTicketId,
          requiresCleanCommit: tmuxMode,
        }),
      });
    }
    if (!validatedResumeCheckpoint) try {
      qualityBaseline = assertQualityBaselineFresh(persistedQualityBaseline, workingDir);
    } catch (error) {
      if (!(error instanceof QualityBaselineError) || error.kind === 'quality-baseline-write-failed') throw error;
      appendRunnerLog(sessionDir, runnerMode, `${error.message}; capturing a fresh session repository quality baseline`);
      const beforeQualityBaseline = repositoryMutationFingerprint(workingDir);
      qualityBaseline = await captureQualityBaseline(
        workingDir,
        config.defaults.worker_timeout_seconds * 1000,
        {
          isCancelled: shouldCancel,
          onSpawn: (pid, command) => updateActiveChild(statePath, manager, {
            active_child_pid: pid,
            active_child_kind: 'quality-baseline',
            active_child_command: command,
          }),
          onExit: clearActiveChildIfOwned,
        },
      );
      assertOwnership();
      if (isSessionCancelled(manager, statePath)) throw new CancellationError();
      if (repositoryMutationFingerprint(workingDir) !== beforeQualityBaseline) {
        throw new Error(
          'quality-baseline-mutation: repository quality commands modified the working tree, index, or HEAD while capturing the baseline',
          { cause: error },
        );
      }
      qualityBaseline = persistFreshQualityBaseline(
        qualityBaseline,
        workingDir,
        (value) => manager.update(statePath, (current) => {
          current.quality_baseline = value;
          return current;
        }),
        () => manager.read(statePath).quality_baseline,
      );
    }
    const restoredCandidateCheckpoint = restoreRejectedCandidateCheckpoint({
      sessionDir,
      workingDir,
      ticketId: normalizedTicketId,
      expectedBaseHead: baselineHeadSha,
      validateScope: (changedPaths) => {
        const verdict = evaluatePersistedTicketScope(
          sessionDir, normalizedTicket, normalizedTicketId, workspaceBaseline.headSha, workingDir, changedPaths,
        );
        if (!verdict.ok) throw new Error(`rejected-candidate-scope-violation: ${verdict.reason || verdict.violations.join(', ')}`);
      },
    });
    const restoredCandidate = restoredCandidateCheckpoint
      ? { ref: restoredCandidateCheckpoint.recovery_ref, changedPaths: restoredCandidateCheckpoint.changed_paths }
      : null;
    if (restoredCandidate) appendRunnerLog(sessionDir, runnerMode, `restored rejected candidate ${restoredCandidate.ref} for ${normalizedTicketId}`);
    updateActiveChild(statePath, manager, {
      worker_pid: process.pid,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });

    const contextInputHash = lifecycleContextInputHash(normalizedTicket, baselineHeadSha);
    const resumeCheckpoint = validatedResumeCheckpoint;
    const supervisorCheckpointRejected = supervisorCheckpointPresented && !validatedResumeCheckpoint;
    if (resumeCheckpoint?.schema_version === 1
      && resumeCheckpoint.kind === 'worker_phase'
      && normalizeTicketId(String(resumeCheckpoint.ticket_id || ''), '') === normalizedTicketId
      && resumeCheckpoint.input_hash === contextInputHash
      && Array.isArray(resumeCheckpoint.completed_phases)) {
      const completedPhases = resumeCheckpoint.completed_phases.map(String);
      const expectedPrefix = WORKER_LIFECYCLE_PHASES.slice(0, completedPhases.length);
      if (JSON.stringify(completedPhases) === JSON.stringify(expectedPrefix)) {
        try {
          for (const phase of expectedPrefix) {
            const artifact = readAndValidateWorkerLifecycleArtifact(
              workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase),
              phase,
              normalizedTicketId,
              normalizedTicket.acceptance_criteria || [],
            );
            if (artifact.verdict === 'changes_requested') throw new Error(`checkpoint contains refused ${phase}`);
            lifecycleArtifacts.push(artifact);
          }
          if (expectedPrefix.length > 0) {
            appendRunnerLog(sessionDir, runnerMode, `reused durable supervisor checkpoint through ${expectedPrefix.at(-1)}`);
            recordExecutionControlTelemetry(sessionDir, { checkpoints_reused: expectedPrefix.length });
          }
        } catch {
          lifecycleArtifacts.length = 0;
        }
      }
    }
    const cachedContext = readLifecycleContextCheckpoint(sessionDir, normalizedTicketId, contextInputHash);
    if (cachedContext && lifecycleArtifacts.length === 0 && !supervisorCheckpointRejected) {
      const expectedContextPhases: WorkerLifecyclePhase[] = ['research', 'research_review', 'plan', 'plan_review'];
      try {
        for (const phase of expectedContextPhases) {
          const artifact = cachedContext.artifacts.find((entry) => entry.phase === phase);
          if (!artifact) throw new Error(`checkpoint missing ${phase}`);
          if (artifact.schema_version !== 1 || artifact.ticket_id !== normalizedTicketId || !artifact.summary?.trim()) {
            throw new Error(`checkpoint contains invalid ${phase}`);
          }
          if (artifact.verdict === 'changes_requested') throw new Error(`checkpoint contains refused ${phase}`);
          lifecycleArtifacts.push(artifact);
        }
        appendRunnerLog(sessionDir, runnerMode, `reused content-addressed research/plan checkpoint ${cachedContext.digest}`);
        recordExecutionControlTelemetry(sessionDir, { checkpoints_reused: expectedContextPhases.length });
      } catch {
        lifecycleArtifacts.length = 0;
      }
    }

    for (const phase of WORKER_LIFECYCLE_PHASES) {
      assertOwnership();
      if (lifecycleArtifacts.some((artifact) => artifact.phase === phase)) continue;
      if (phase === 'simplify') {
        const review = lifecycleArtifacts.find((artifact) => artifact.phase === 'review');
        const required = simplificationRequired({
          complexityTier: normalizedTicket.complexity_tier,
          priority: normalizedTicket.priority,
          explicitlyRequired: normalizedTicket.simplification_required,
          changedPathCount: changedPathsSinceSnapshot(workingDir, workspaceBaseline).length,
          reviewFindings: review?.findings,
        });
        if (!required) {
          const skipped: WorkerLifecycleArtifact = {
            schema_version: 1,
            phase: 'simplify',
            ticket_id: normalizedTicketId,
            summary: 'Simplification skipped by the sealed risk, diff, and verified-finding policy.',
            skipped: true,
            verification: ['Policy evaluated after implementation review and required no simplification pass.'],
          };
          atomicWriteJson(workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase), skipped);
          lifecycleArtifacts.push(skipped);
          continue;
        }
      }
      if (isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      const artifactPath = workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase);
      const candidateParent = path.join(sessionDir, 'worker-lifecycle-candidates');
      const readOnlyPhase = ['research', 'research_review', 'plan', 'plan_review', 'review', 'conformance'].includes(phase);
      const phaseRepositoryBoundary = readOnlyPhase ? repositoryMutationFingerprint(workingDir) : null;
      const maxPhaseAttempts = readOnlyPhase ? MAX_READ_ONLY_LIFECYCLE_ARTIFACT_ATTEMPTS : 1;
      let acceptedArtifact: WorkerLifecycleArtifact | null = null;
      let artifactRecoveryFeedback: string | null = null;

      for (let phaseAttempt = 1; phaseAttempt <= maxPhaseAttempts; phaseAttempt += 1) {
        assertOwnership();
        const phaseState = manager.update(statePath, (current) => {
          current.current_ticket = normalizedTicketId;
          current.step = phase;
          current.iteration = (current.iteration as number) + 1;
          appendHistory(current, phase, normalizedTicketId);
          return current;
        });
        const phaseIteration = Number(phaseState.iteration);
        fs.mkdirSync(candidateParent, { recursive: true, mode: 0o700 });
        const candidateRoot = fs.mkdtempSync(path.join(candidateParent, `${normalizedTicketId}-${phase}-`));
        const candidateArtifactPath = path.join(candidateRoot, normalizedTicketId, `${phase}.json`);
        const lastMessagePath = path.join(sessionDir, `${normalizedTicketId}.${phase}.last-message.txt`);
        prepareWorkerLifecycleArtifact(candidateArtifactPath);
        let modelResult: CodexSpawnResult | null = null;
        let modelOutcome: 'success' | 'failed' | 'cancelled' | 'timed_out' = 'failed';
        try {
          const result = await runCodexExecMonitored({
            // Lifecycle artifacts authorize repository advancement. Pin the sandbox
            // contract instead of inheriting operator-configured escape hatches.
            execArgs: ['--sandbox', 'workspace-write'],
            cwd: workingDir,
            prompt: buildTicketPhasePrompt({
              phase,
              ticket: {
                ...normalizedTicket,
                verificationContract: verificationReady.contract,
              },
              sessionDir,
              workingDir,
              artifactPath: candidateArtifactPath,
              priorArtifacts: lifecycleArtifacts,
              remediationFeedback,
              artifactRecoveryFeedback,
              tmuxMode,
              recoveryStrategy: options.recoveryStrategy || null,
              restoredCandidate,
            }),
            timeoutMs: options.timeoutMs || config.defaults.worker_timeout_seconds * 1000,
            outputLastMessagePath: lastMessagePath,
            progressArtifactPaths: [candidateArtifactPath],
            addDirs: [candidateRoot],
            inheritConfiguredAddDirs: false,
            successCheck: phaseSuccessCheck(phase, lastMessagePath),
            successSignalGraceMs: 150,
            successPollMs: 50,
            onSpawn: (child) => {
              updateActiveChild(statePath, manager, {
                active_child_pid: child.pid,
                active_child_kind: 'codex',
                active_child_command: phase,
              });
            },
            cancelCheck: shouldCancel,
          });
          modelResult = result;
          assertOwnership();
          modelOutcome = result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'success' : 'failed';
          if (result.cancelled || isSessionCancelled(manager, statePath)) {
            throw new CancellationError();
          }
          assertCodexSucceeded(result, `Ticket ${normalizedTicketId} failed in ${phase}`);
          acceptedArtifact = readAndValidateWorkerLifecycleArtifact(
            candidateArtifactPath,
            phase,
            normalizedTicketId,
            normalizedTicket.acceptance_criteria || [],
          );
          assertAcPhaseBoundary(
            phase,
            acceptedArtifact,
            lifecycleArtifacts,
            normalizedTicket.acceptance_criteria || [],
          );
          if (phaseRepositoryBoundary !== null && repositoryMutationFingerprint(workingDir) !== phaseRepositoryBoundary) {
            throw new Error(`worker-lifecycle-read-only-mutation: ${phase} modified the repository`);
          }
          modelOutcome = 'success';
        } catch (error) {
          if (modelResult && modelOutcome === 'success') modelOutcome = 'failed';
          const artifactContractFailure = readOnlyPhase
            && isLifecycleArtifactContractError(error)
            && repositoryMutationFingerprint(workingDir) === phaseRepositoryBoundary;
          if (artifactContractFailure) {
            archiveLifecycleArtifactFailure({
              sessionDir,
              ticketId: normalizedTicketId,
              phase,
              iteration: phaseIteration,
              attempt: phaseAttempt,
              candidateArtifactPath,
              lastMessagePath,
              error,
            });
          }
          const mayRetryArtifact = artifactContractFailure && phaseAttempt < maxPhaseAttempts;
          if (!mayRetryArtifact) throw error;
          appendRunnerLog(
            sessionDir,
            runnerMode,
            `retrying read-only ${phase} artifact in place after attempt ${phaseAttempt}/${maxPhaseAttempts}: ${error instanceof Error ? error.message : String(error)}`,
          );
          artifactRecoveryFeedback = error instanceof Error ? error.message : String(error);
          acceptedArtifact = null;
          continue;
        } finally {
          if (modelResult) {
            recordModelCallTelemetry(sessionDir, {
              ticketId: normalizedTicketId,
              phase,
              ticketAttempt: Number(options.ticketAttempt || 1),
              phaseAttempt,
              recoveryEpoch: Number(options.recoveryEpoch || 0),
              strategyHash: options.strategyHash || null,
              result: modelResult,
              outcome: modelOutcome,
            });
          }
          clearActiveChildIfOwned();
          fs.rmSync(candidateRoot, { recursive: true, force: true });
          try { fs.rmdirSync(candidateParent); } catch { /* another phase candidate still exists */ }
        }
        break;
      }

      if (!acceptedArtifact) {
        throw new Error(`worker-lifecycle-invalid-artifact: ${phase} exhausted bounded artifact recovery`);
      }
      assertOwnership();
      atomicWriteJson(artifactPath, acceptedArtifact);
      if (acceptedArtifact.verdict === 'changes_requested') {
        const refusalPath = archiveWorkerLifecycleRefusal(
          sessionDir,
          normalizedTicketId,
          phase,
          acceptedArtifact,
        );
        throw new WorkerLifecycleRefusalError(phase, refusalPath, acceptedArtifact);
      }
      lifecycleArtifacts.push(acceptedArtifact);
      if (phase === 'plan_review') {
        assertOwnership();
        writeLifecycleContextCheckpoint(sessionDir, normalizedTicketId, contextInputHash, lifecycleArtifacts.slice(0, 4));
      }
      if (phase === 'implement') await runDeterministicVerification();
      if (['research', 'research_review', 'plan', 'plan_review'].includes(phase)) options.recordDurableCheckpoint?.({
        schema_version: 1,
        kind: 'worker_phase',
        ticket_id: normalizedTicketId,
        input_hash: contextInputHash,
        completed_phases: lifecycleArtifacts.map((entry) => entry.phase),
        completed_phase: phase,
        artifact_digests: lifecycleArtifacts.map((entry) => ({
          phase: entry.phase,
          sha256: fileDigest(workerLifecycleArtifactPath(sessionDir, normalizedTicketId, entry.phase)),
        })),
        repository_mutation_fingerprint: repositoryMutationFingerprint(workingDir),
        workspace_baseline: workspaceBaseline,
        mutation_boundary: mutationBoundary,
        baseline_fingerprint: baselineFingerprint,
        baseline_tracked_clean: baselineTrackedClean,
        baseline_untracked_files: baselineUntrackedFiles,
        quality_baseline_digest: durableCheckpointDigest(qualityBaseline),
      });
      assertOwnership();
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState);
    }

    assertOwnership();
    const changedPathsBeforeGate = changedPathsSinceSnapshot(workingDir, workspaceBaseline);
    const scopeVerdict = evaluatePersistedTicketScope(
      sessionDir,
      normalizedTicket,
      normalizedTicketId,
      workspaceBaseline.headSha,
      workingDir,
      changedPathsBeforeGate,
    );
    if (mutationBoundary) mutationBoundary.allowedPaths = scopeVerdict.allowedPaths;
    if (!scopeVerdict.ok) {
      throw new Error(`scope-violation: ${scopeVerdict.reason || scopeVerdict.violations.join(', ')}`);
    }

    const workerGate = await evaluateWorkerQualityGate(
      workingDir,
      qualityBaseline,
      config.defaults.worker_timeout_seconds * 1000,
      {
        isCancelled: shouldCancel,
        onSpawn: (pid, command) => updateActiveChild(statePath, manager, {
          active_child_pid: pid,
          active_child_kind: 'quality-gate',
          active_child_command: command,
        }),
        onExit: clearActiveChildIfOwned,
      },
    );
    assertOwnership();
    if (isSessionCancelled(manager, statePath)) throw new CancellationError();
    if (workerGate.verdict === 'red') {
      const failures = workerGate.failures.map((failure) => failure.command).join(', ');
      appendRunnerLog(sessionDir, runnerMode, `ticket ${normalizedTicketId} worker quality gate red: ${failures}`);
    }

    // Quality commands are arbitrary repository scripts and may mutate the tree.
    // Recompute the complete ticket delta after they run and fence it again.
    const postGateChangedPaths = changedPathsSinceSnapshot(workingDir, workspaceBaseline);
    const postGateScopeVerdict = evaluatePersistedTicketScope(
      sessionDir,
      normalizedTicket,
      normalizedTicketId,
      workspaceBaseline.headSha,
      workingDir,
      postGateChangedPaths,
    );
    if (mutationBoundary) mutationBoundary.allowedPaths = postGateScopeVerdict.allowedPaths;
    if (!postGateScopeVerdict.ok) {
      throw new Error(`scope-violation: ${postGateScopeVerdict.reason || postGateScopeVerdict.violations.join(', ')}`);
    }
    if (workerGate.verdict !== 'green') {
      const detail = workerGate.verdict === 'red'
        ? workerGate.failures.map((failure) => failure.command).join(', ') || 'unknown quality command'
        : 'repository declares no portable quality commands';
      throw new Error(`worker-quality-gate-${workerGate.verdict}: ${detail}`);
    }

    markRefinementRepositoryAdvanceVerified({
      sessionDir,
      workingDir,
      ticketId: normalizedTicketId,
      changedPaths: postGateChangedPaths,
    });

    assertOwnership();
    const autoCommitSha = autoCommitDetachedTicketChanges({
      sessionDir,
      runnerMode,
      workingDir,
      tmuxMode,
      baselineTrackedClean,
      baselineUntrackedFiles,
      ticketId: normalizedTicketId,
      ticket: normalizedTicket,
      config,
      changedPaths: postGateChangedPaths,
      assertDurableOwnership: assertOwnership,
    });

    // Reconcile the completion commit's Pickle-Ticket trailer (amends an untrailed
    // single-commit window in place) so the oracle's git-log scan can attribute the
    // worker's own work. The resolved sha is not stamped directly — the oracle owns
    // the pointer write via its promote-once persistEvidence (R-WDTF).
    resolveCompletionCommitSha({
      workingDir,
      baselineHeadSha,
      autoCommitSha,
      ticketId: normalizedTicketId,
    });
    assertOwnership();
    const applied = getWorkingTreeFingerprint(workingDir) !== baselineFingerprint;
    const decision = evaluateCompletionEvidence(buildCompletionCtx({
      sessionDir,
      ticketId: normalizedTicketId,
      workingDir,
      startCommit: typeof state.start_commit === 'string' ? state.start_commit : null,
      pinnedSha: typeof state.pinned_sha === 'string' ? state.pinned_sha : null,
      workerGate,
    }));
    if (decision.ok) {
      // The oracle accepted attributable evidence and, via its promote-once
      // persistEvidence, has already stamped completion_commit into the manifest and
      // the file (R-WDTF). Flip Done — the pointer survives the re-materialization.
      return finalizeSuccess(applied);
    }
    // The oracle refused. Gate on the refusal REASON, not HEAD-advancement: a positively
    // bad or dead pointer (foreign/baseline/unreachable) must never be claimed as
    // completion, even on a run that produced no new commit — HEAD-advancement would let a
    // pre-existing surviving stamp flip Done and defeat the R-OMA/baseline guards.
    if (decision.reason === 'no_evidence' && postGateChangedPaths.length === 0) {
      // A truly mutation-free audit/no-op is complete without a commit, but only after
      // ticket verification, scope evaluation, and the oracle's worker-gate rung passed.
      return finalizeSuccess(false);
    }
    // Mutating no-evidence runs, foreign/baseline/dead evidence, and red/unavailable
    // worker gates all fail closed.
    if (mutationBoundary) {
      restoreRejectedWorkerMutation(
        workingDir,
        sessionDir,
        normalizedTicketId,
        mutationBoundary,
        runnerMode,
      );
    }
    return finalizeRefusal(false, decision);
  } catch (error) {
    if (ownershipDrainError) throw ownershipDrainError;
    let handledError: unknown = error;
    let rollbackFailed = false;
    if (mutationBoundary) {
      try {
        const remediationIdentity = restoreRejectedWorkerMutation(
          workingDir,
          sessionDir,
          normalizedTicketId,
          mutationBoundary,
          runnerMode,
        );
        if (handledError instanceof WorkerLifecycleRefusalError) {
          handledError.remediationIdentity = remediationIdentity;
        }
      } catch (rollbackError) {
        rollbackFailed = true;
        handledError = new AggregateError(
          [error, rollbackError],
          `worker transaction failed and recovery did not restore the original boundary: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackFailed) {
      try {
        manager.update(statePath, (current) => {
          current.recovery_required = true;
          current.recovery_kind = 'ticket_repository';
          current.recovery_reason = handledError instanceof Error ? handledError.message : String(handledError);
          current.last_exit_reason = 'recovery_required';
          return current;
        });
      } catch {
        // Preserve the original rollback failure and its durable repository journal.
      }
      throw handledError;
    }
    if (handledError instanceof CancellationError) {
      updateTicketAndClearAdvance({
        status: 'Todo',
        cancelled_at: new Date().toISOString(),
      });
      throw error;
    }
    if (isPreflightError(handledError)) {
      updateTicketAndClearAdvance({
        status: 'Todo',
        failed_at: new Date().toISOString(),
        failure_reason: (handledError as Error).message,
        failure_kind: (handledError as { kind?: unknown }).kind,
      });
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
        error: (handledError as Error).message,
      });
      throw handledError;
    }
    if (isVerificationContractError(handledError)) {
      updateTicketAndClearAdvance({
        status: 'Blocked',
        failed_at: new Date().toISOString(),
        failure_reason: (handledError as Error).message,
        failure_kind: (handledError as { kind?: unknown }).kind,
      });
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
        error: (handledError as Error).message,
      });
      throw handledError;
    }
    updateTicketAndClearAdvance({
      status: 'Blocked',
      failed_at: new Date().toISOString(),
      failure_reason: handledError instanceof Error ? handledError.message : String(handledError),
      failure_kind: workerGateFailureKind(handledError),
    });
    recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
      error: handledError instanceof Error ? handledError.message : String(handledError),
    });
    throw handledError;
  } finally {
    try {
      assertOwnership();
      updateActiveChild(statePath, manager, {
        worker_pid: null,
        active_child_pid: null,
        active_child_kind: null,
        active_child_command: null,
      });
    } catch {
      // Preserve the immutable child/recovery handle for the new owner. A stale
      // worker must never erase state written by its replacement.
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const [sessionDir, ticketId] = argv;
  if (!sessionDir || !ticketId) {
    throw new Error('Usage: node bin/spawn-morty.js <session-dir> <ticket-id>');
  }
  const result = await runTicket(sessionDir, ticketId);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
