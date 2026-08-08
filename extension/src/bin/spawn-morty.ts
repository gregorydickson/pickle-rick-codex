#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
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
import { atomicWriteJson } from '../services/pickle-utils.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import { normalizeTicketId, readManifest, updateTicketStatus } from '../services/tickets.js';
import {
  beginRefinementRepositoryAdvance,
  clearRefinementRepositoryAdvance,
  markRefinementRepositoryAdvanceVerified,
  refinementAcceptancePath,
  refinementRepositoryAdvancePath,
  refreshAcceptedRefinementRepositoryIdentity,
} from '../services/refinement-artifacts.js';
import {
  evaluateCompletionEvidence,
  type CompletionDecision,
  type CompletionDecisionCtx,
} from '../services/ticket-completion-evidence.js';
import {
  assertTicketVerificationReady,
  isPreflightError,
  isVerificationContractError,
  normalizeVerificationSteps,
  verificationStepCommand,
  VerificationContractError,
} from '../services/verification-env.js';
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

class VerificationCommandError extends Error {
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
  recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: boundary.head,
    operation: `rejected-${ticketId}`,
    preserveUntracked: boundary.untracked,
    headRecoveryRef: rejectedWorkerRef(sessionDir, ticketId),
    log: (message) => appendRunnerLog(sessionDir, runnerMode, message),
  });
  if (repositoryMutationFingerprint(workingDir) !== boundary.fingerprint) {
    throw new Error('worker-rollback-failed: rejected worker changes were anchored, but the original repository boundary was not restored');
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
    // Stage the already-fenced ticket delta only. Whole-tree staging here would
    // sweep in a concurrent/user or quality-command mutation after scope review.
    resetGitIndex(workingDir);
    stagePaths(workingDir, changedPaths);
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
}

async function runVerificationCommand({
  step,
  cwd,
  timeoutMs,
  manager,
  statePath,
  env,
}: RunVerificationCommandOptions): Promise<void> {
  const descriptor = verificationStepCommand(step);
  const command = descriptor.display;
  const stepCwd = step.cwd ? path.resolve(cwd, step.cwd) : cwd;
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
      updateActiveChild(statePath, manager, {
        active_child_pid: null,
        active_child_kind: null,
        active_child_command: null,
      });
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
      if (!isSessionCancelled(manager, statePath)) return;
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
      if (forcedByCancel || isSessionCancelled(manager, statePath)) {
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
  [key: string]: unknown;
}

interface RunTicketResult {
  status: string;
  applied: boolean;
  reason?: string;
}

export async function runTicket(sessionDir: string, ticketId: string, options: RunTicketOptions = {}): Promise<RunTicketResult> {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const manifest = readManifest(sessionDir);
  const config = loadConfig();
  const workingDir = state.working_dir as string;
  const tmuxMode = Boolean(state.tmux_mode);
  const runnerMode = options.runnerMode || null;
  const normalizedTicketId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  const manifestTicket = manifest.tickets.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === normalizedTicketId);
  if (!manifestTicket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  const verificationSteps = normalizeVerificationSteps(manifestTicket.verification, {
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
  let baselineFingerprint: string;
  let baselineTrackedClean: boolean;
  let baselineUntrackedFiles: string[];
  let baselineHeadSha: string;
  let workspaceBaseline: WorkspaceSnapshot;
  let qualityBaseline: QualityBaseline;
  let mutationBoundary: WorkerMutationBoundary | null = null;
  const lifecycleArtifacts: WorkerLifecycleArtifact[] = [];
  const refusalPhases: WorkerLifecyclePhase[] = ['research_review', 'plan_review', 'review', 'conformance'];
  const remediationFeedback = refusalPhases
    .flatMap((phase) => {
      const artifactPath = workerLifecycleArtifactPath(sessionDir, normalizedTicketId, phase);
      if (!fs.existsSync(artifactPath)) return [];
      const artifact = readAndValidateWorkerLifecycleArtifact(
        artifactPath,
        phase,
        normalizedTicketId,
        normalizedTicket.acceptance_criteria || [],
      );
      return artifact.verdict === 'changes_requested'
        ? [{ artifact, mtimeMs: fs.statSync(artifactPath).mtimeMs }]
        : [];
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.artifact ?? null;

  function updateTicketAndClearAdvance(updates: Record<string, unknown>): void {
    const advancePath = refinementRepositoryAdvancePath(sessionDir);
    updateTicketStatus(sessionDir, normalizedTicketId, updates, {
      transactionPaths: [advancePath],
      afterWrite: () => clearRefinementRepositoryAdvance(sessionDir),
    });
  }

  function finalizeSuccess(applied: boolean): RunTicketResult {
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
    manager.update(statePath, (current) => {
      current.step = 'verify';
      appendHistory(current, 'verify', normalizedTicketId);
      return current;
    });
    for (const step of verificationSteps) {
      if (isSessionCancelled(manager, statePath)) throw new CancellationError();
      const command = verificationStepCommand(step).display;
      try {
        await runVerificationCommand({ step, cwd: workingDir, timeoutMs: config.defaults.worker_timeout_seconds * 1000, manager, statePath, env: verificationReady.env });
      } catch (error) {
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
    verificationReady = assertTicketVerificationReady({
      ticket: normalizedTicket,
      // Config is a valid verification input at runtime; ConfigDefaults lacks
      // the index signature ConfigVerificationInput models, so widen via unknown.
      config: config as unknown as ConfigVerificationInput,
      cwd: workingDir,
    });
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
      };
    }
    workspaceBaseline = captureWorkspaceSnapshot(workingDir);
    persistTicketScope(sessionDir, normalizedTicket, normalizedTicketId, workspaceBaseline.headSha);
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
    const persistedQualityBaseline = manager.read(statePath).quality_baseline;
    try {
      qualityBaseline = assertQualityBaselineFresh(persistedQualityBaseline, workingDir);
    } catch (error) {
      if (!(error instanceof QualityBaselineError) || error.kind === 'quality-baseline-write-failed') throw error;
      appendRunnerLog(sessionDir, runnerMode, `${error.message}; capturing a fresh session repository quality baseline`);
      const beforeQualityBaseline = repositoryMutationFingerprint(workingDir);
      qualityBaseline = await captureQualityBaseline(
        workingDir,
        config.defaults.worker_timeout_seconds * 1000,
        {
          isCancelled: () => isSessionCancelled(manager, statePath),
          onSpawn: (pid, command) => updateActiveChild(statePath, manager, {
            active_child_pid: pid,
            active_child_kind: 'quality-baseline',
            active_child_command: command,
          }),
          onExit: () => updateActiveChild(statePath, manager, {
            active_child_pid: null,
            active_child_kind: null,
            active_child_command: null,
          }),
        },
      );
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
    updateActiveChild(statePath, manager, {
      worker_pid: process.pid,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });

    const contextInputHash = lifecycleContextInputHash(normalizedTicket, baselineHeadSha);
    const cachedContext = readLifecycleContextCheckpoint(sessionDir, normalizedTicketId, contextInputHash);
    if (cachedContext) {
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
      if (lifecycleArtifacts.some((artifact) => artifact.phase === phase)) continue;
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
            cancelCheck: () => isSessionCancelled(manager, statePath),
          });
          modelResult = result;
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
          updateActiveChild(statePath, manager, {
            active_child_pid: null,
            active_child_kind: null,
            active_child_command: null,
          });
          fs.rmSync(candidateRoot, { recursive: true, force: true });
          try { fs.rmdirSync(candidateParent); } catch { /* another phase candidate still exists */ }
        }
        break;
      }

      if (!acceptedArtifact) {
        throw new Error(`worker-lifecycle-invalid-artifact: ${phase} exhausted bounded artifact recovery`);
      }
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
        writeLifecycleContextCheckpoint(sessionDir, normalizedTicketId, contextInputHash, lifecycleArtifacts.slice(0, 4));
      }
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState);
      if (phase === 'implement') await runDeterministicVerification();
    }

    const changedPathsBeforeGate = changedPathsSinceSnapshot(workingDir, workspaceBaseline);
    const scopeVerdict = evaluatePersistedTicketScope(
      sessionDir,
      normalizedTicket,
      normalizedTicketId,
      workspaceBaseline.headSha,
      workingDir,
      changedPathsBeforeGate,
    );
    if (!scopeVerdict.ok) {
      throw new Error(`scope-violation: ${scopeVerdict.reason || scopeVerdict.violations.join(', ')}`);
    }

    const workerGate = await evaluateWorkerQualityGate(
      workingDir,
      qualityBaseline,
      config.defaults.worker_timeout_seconds * 1000,
      {
        isCancelled: () => isSessionCancelled(manager, statePath),
        onSpawn: (pid, command) => updateActiveChild(statePath, manager, {
          active_child_pid: pid,
          active_child_kind: 'quality-gate',
          active_child_command: command,
        }),
        onExit: () => updateActiveChild(statePath, manager, {
          active_child_pid: null,
          active_child_kind: null,
          active_child_command: null,
        }),
      },
    );
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
    updateActiveChild(statePath, manager, {
      worker_pid: null,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });
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
