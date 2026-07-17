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
  hasTrackedWorkingTreeChanges,
  getWorkingTreeFingerprint,
  isGitRepo,
  isIndexClean,
  isWorkingTreeDirty,
  listUntrackedFiles,
  readCommitTrailer,
  resetGitIndex,
  stageTrackedChangesAndNewPaths,
} from '../services/git-utils.js';
import { buildTicketPhasePrompt } from '../services/prompts.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { appendHistory } from '../services/session.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import { normalizeTicketId, readManifest, updateTicketStatus } from '../services/tickets.js';
import {
  evaluateCompletionEvidence,
  type CompletionDecision,
  type CompletionDecisionCtx,
} from '../services/ticket-completion-evidence.js';
import {
  assertTicketVerificationReady,
  isPreflightError,
  isVerificationContractError,
  normalizeVerificationCommands,
  VerificationContractError,
} from '../services/verification-env.js';
import {
  buildVerificationFailureSet,
  isPipelineSession,
  readTicketVerificationBaseline,
} from '../services/pipeline-state.js';
import type {
  CircuitIterationState,
  Config,
  ConfigVerificationInput,
  SuccessCheck,
  Ticket,
  VerificationEnvResult,
  VerificationFailure,
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
}

/**
 * The single completion decision seam. Codex has no worker gate and no session
 * baseline concept, so `decision:'attribution'` (never 'done-flip', which would
 * always refuse worker_gate_unavailable) with `startCommit/pinnedSha` explicitly
 * null. Routing through the oracle folds the pointer write into its promote-once
 * persistEvidence, so `completion_commit` lands in the manifest AND the file
 * (R-WDTF) — guaranteed, not order-dependent.
 */
function buildCompletionCtx({ sessionDir, ticketId, workingDir }: BuildCompletionCtxInput): CompletionDecisionCtx {
  return {
    sessionDir,
    ticketId,
    workingDir,
    startCommit: null,
    pinnedSha: null,
    decision: 'attribution',
  };
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
    stageTrackedChangesAndNewPaths(workingDir, newUntrackedFiles);
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
  command: string;
  cwd: string;
  timeoutMs: number;
  manager: StateManager;
  statePath: string;
  env: Record<string, string | undefined>;
}

async function runVerificationCommand({
  command,
  cwd,
  timeoutMs,
  manager,
  statePath,
  env,
}: RunVerificationCommandOptions): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let forcedByCancel = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32',
    });

    updateActiveChild(statePath, manager, {
      active_child_pid: child.pid,
      active_child_kind: 'verification',
      active_child_command: command,
    });

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
            cwd,
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
  const verificationCommands = normalizeVerificationCommands(manifestTicket.verification, {
    verify: manifestTicket.verify,
    cwd: workingDir,
  });
  if (verificationCommands.length === 0) {
    throw new Error(`ticket ${normalizedTicketId} has invalid verification manifest: expected one or more verification commands`);
  }
  const normalizedTicket: Ticket = {
    ...manifestTicket,
    verification: verificationCommands,
  };

  let verificationReady: VerificationEnvResult;
  let baselineFingerprint: string;
  let baselineTrackedClean: boolean;
  let baselineUntrackedFiles: string[];
  let baselineHeadSha: string;
  const phases = ['research', 'plan', 'implement', 'review', 'simplify'];

  function finalizeSuccess(applied: boolean): RunTicketResult {
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Done',
      completed_at: new Date().toISOString(),
      failure_reason: null,
      failure_kind: null,
      failed_at: null,
    });
    manager.update(statePath, (current) => {
      current.step = 'done';
      appendHistory(current, 'done', normalizedTicketId);
      return current;
    });
    logActivity({
      event: 'ticket_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket: normalizedTicketId,
    }, { enabled: config.defaults.activity_logging });

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
    return { status: 'incomplete', applied, reason: decision.reason };
  }

  try {
    verificationReady = assertTicketVerificationReady({
      ticket: normalizedTicket,
      // Config is a valid verification input at runtime; ConfigDefaults lacks
      // the index signature ConfigVerificationInput models, so widen via unknown.
      config: config as unknown as ConfigVerificationInput,
    });
    baselineFingerprint = getWorkingTreeFingerprint(workingDir);
    baselineTrackedClean = !isGitRepo(workingDir) || !hasTrackedWorkingTreeChanges(workingDir);
    baselineUntrackedFiles = isGitRepo(workingDir) ? listUntrackedFiles(workingDir) : [];
    baselineHeadSha = isGitRepo(workingDir) ? getHeadSha(workingDir) : '';
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'In Progress',
      started_at: new Date().toISOString(),
      failure_reason: null,
      failure_kind: null,
      failed_at: null,
    });
    updateActiveChild(statePath, manager, {
      worker_pid: process.pid,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });

    for (const phase of phases) {
      if (isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      manager.update(statePath, (current) => {
        current.current_ticket = normalizedTicketId;
        current.step = phase;
        current.iteration = (current.iteration as number) + 1;
        appendHistory(current, phase, normalizedTicketId);
        return current;
      });

      const result = await runCodexExecMonitored({
        cwd: workingDir,
        prompt: buildTicketPhasePrompt({
          phase,
          ticket: {
            ...normalizedTicket,
            verificationContract: verificationReady.contract,
          },
          sessionDir,
          workingDir,
          tmuxMode,
        }),
        timeoutMs: options.timeoutMs || config.defaults.worker_timeout_seconds * 1000,
        outputLastMessagePath: path.join(sessionDir, `${normalizedTicketId}.${phase}.last-message.txt`),
        addDirs: [sessionDir],
        successCheck: phaseSuccessCheck(phase, path.join(sessionDir, `${normalizedTicketId}.${phase}.last-message.txt`)),
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
      updateActiveChild(statePath, manager, {
        active_child_pid: null,
        active_child_kind: null,
        active_child_command: null,
      });
      if (result.cancelled || isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      assertCodexSucceeded(result, `Ticket ${normalizedTicketId} failed in ${phase}`);
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState);
    }

    for (const command of verificationCommands) {
      if (isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      try {
        await runVerificationCommand({
          command,
          cwd: workingDir,
          timeoutMs: config.defaults.worker_timeout_seconds * 1000,
          manager,
          statePath,
          env: verificationReady.env,
        });
      } catch (error) {
        if (error instanceof VerificationCommandError) {
          const remainingFailures = subtractBaselineFailures(
            sessionDir,
            normalizedTicketId,
            command,
            workingDir,
            error.failures,
          );
          if (remainingFailures.length === 0) {
            continue;
          }
          error.failures = remainingFailures;
        }
        if (
          !(error instanceof CancellationError)
          && shouldClassifyVerificationContractFailure(normalizedTicket, command)
          && !isPreflightError(error)
        ) {
          throw new VerificationContractError({
            ticketId: normalizedTicketId,
            command,
            message: `verification contract failed for ${command}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        throw error;
      }
    }

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
    }));
    if (decision.ok) {
      // The oracle accepted attributable evidence and, via its promote-once
      // persistEvidence, has already stamped completion_commit into the manifest and
      // the file (R-WDTF). Flip Done — the pointer survives the re-materialization.
      return finalizeSuccess(applied);
    }
    // The oracle refused. Withhold Done ONLY when a completion-commit candidate actually
    // exists — HEAD advanced past the session baseline, so there is a baseline/foreign/
    // phantom commit that must not be stamped or claimed as completion. A run that
    // produced no new commit has nothing to attribute and no phantom-stamp risk, so it
    // completes with a null completion_commit exactly as before.
    const committedCandidateExists =
      isGitRepo(workingDir) && baselineHeadSha.length > 0 && getHeadSha(workingDir) !== baselineHeadSha;
    if (committedCandidateExists) {
      return finalizeRefusal(applied, decision);
    }
    return finalizeSuccess(applied);
  } catch (error) {
    if (error instanceof CancellationError) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Todo',
        cancelled_at: new Date().toISOString(),
      });
      throw error;
    }
    if (isPreflightError(error)) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Todo',
        failed_at: new Date().toISOString(),
        failure_reason: (error as Error).message,
        failure_kind: (error as { kind?: unknown }).kind,
      });
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
        error: (error as Error).message,
      });
      throw error;
    }
    if (isVerificationContractError(error)) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Blocked',
        failed_at: new Date().toISOString(),
        failure_reason: (error as Error).message,
        failure_kind: (error as { kind?: unknown }).kind,
      });
      recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
        error: (error as Error).message,
      });
      throw error;
    }
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Blocked',
      failed_at: new Date().toISOString(),
      failure_reason: error instanceof Error ? error.message : String(error),
      failure_kind: 'command_failed',
    });
    recordIteration(sessionDir, manager.read(statePath) as unknown as CircuitIterationState, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
