import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalizeModelCallTelemetry, reserveModelCallTelemetry } from './productive-autonomy.js';
import { loadConfig } from './config.js';
import { safeErrorMessage } from './pickle-utils.js';
import {
  captureProcessLivenessIdentity,
  captureSpawnedProcessIdentity,
  inspectProcessLivenessIdentity,
  isPersistedProcessIdentityValid,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import {
  collectCodexToolCalls,
  detectOutputFormat,
  extractAssistantContent,
  inspectCodexUsage,
} from './classifier-utils.js';
import type {
  CodexExecOptions,
  CodexSpawnResult,
  CodexUsage,
  RunSpawnedCommandOptions,
  SuccessCheckContext,
} from '../types/index.js';
import {
  BROKER_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS,
  CONTROLLER_BROKER_FORCE_KILL_TIMEOUT_MS,
  MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS,
  MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS,
  POST_CLOSE_ATTESTATION_WINDOW_MS,
} from './monitored-process-protocol.js';

export class AddDirOutsideSandboxError extends Error {
  readonly addDir: string;
  readonly sandboxRoot: string;

  constructor(addDir: string, sandboxRoot: string) {
    super(`Codex --add-dir is outside the test sandbox: ${addDir} (sandbox: ${sandboxRoot})`);
    this.name = 'AddDirOutsideSandboxError';
    this.addDir = addDir;
    this.sandboxRoot = sandboxRoot;
  }
}

export class CodexCancelCheckError extends Error {
  readonly code = 'CODEX_CANCEL_CHECK_FAILED';
  override readonly cause: unknown;
  result: CodexSpawnResult | null = null;

  constructor(cause: unknown) {
    super(`Codex cancellation check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CodexCancelCheckError';
    this.cause = cause;
  }

  attachResult(result: CodexSpawnResult): void {
    this.result = result;
  }
}

function canonicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  let existing = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...suffix);
  } catch {
    return resolved;
  }
}

/** Test harnesses must never grant Codex write access outside the OS temp sandbox. */
export function assertAddDirsUnderTmpdirIfTestMode(
  addDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
  tmpRoot: string = os.tmpdir(),
): void {
  if (env.PICKLE_TEST_MODE !== '1') return;
  const sandboxRoot = canonicalPath(tmpRoot);
  for (const addDir of addDirs) {
    const candidate = canonicalPath(addDir);
    const relative = path.relative(sandboxRoot, candidate);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) continue;
    throw new AddDirOutsideSandboxError(addDir, sandboxRoot);
  }
}

export function hasPromiseToken(text: unknown, token: unknown): boolean {
  return new RegExp(`<promise>\\s*${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/promise>`).test(String(text || ''));
}

function removeStaleOutputs(paths: string[] = []): void {
  for (const filePath of new Set(paths.filter(Boolean))) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

function readLastMessage(filePath: string): string {
  return filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
}

function terminateUnreleasedBroker(child: ChildProcess, signal: NodeJS.Signals): void {
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
    child.kill(signal);
  } catch {
    // Ignore teardown failures.
  }
}

function commandDigest(command: string, args: string[], cwd?: string): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ command, args, cwd: cwd || null }))
    .digest('hex');
}

function sameIdentity(left: PersistedProcessIdentity | null, right: unknown): boolean {
  if (!left || !right || typeof right !== 'object') return false;
  const candidate = right as Partial<PersistedProcessIdentity>;
  return candidate.pid === left.pid
    && candidate.pgid === left.pgid
    && candidate.start_time === left.start_time
    && candidate.fingerprint === left.fingerprint;
}

export function isAuthenticatedBrokerOnlyShutdownLedger(
  launchAttested: boolean,
  targetIdentity: PersistedProcessIdentity | null,
  rawTargetIdentity: unknown,
  rawDescendantIdentities: unknown,
  cause: unknown,
): boolean {
  const permittedCause = typeof cause === 'string' && [
    'target-stop-attestation-failed',
    'target-identity-attestation-failed',
    'target-spawn-error',
    'broker-SIGTERM',
    'broker-SIGINT',
    'broker-SIGHUP',
    'controller-disconnect',
  ].includes(cause);
  return !launchAttested && !targetIdentity && rawTargetIdentity === null
    && Array.isArray(rawDescendantIdentities) && rawDescendantIdentities.length === 0
    && permittedCause;
}

function sameIdentityLedger(left: PersistedProcessIdentity[], right: unknown): boolean {
  return Array.isArray(right) && left.length === right.length
    && left.every((identity, index) => sameIdentity(identity, right[index]));
}

function processGroupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function runSpawnedCommand({
  command,
  args = [],
  cwd,
  input = '',
  timeoutMs = 900_000,
  env = {},
  outputLastMessagePath = '',
  progressArtifactPaths = [],
  successCheck,
  successSignalGraceMs = 750,
  successPollMs = 250,
  awaitUsageOnSuccess = false,
  usageCompletionGraceMs = 5_000,
  cleanupPaths = [],
  onSpawn,
  onTargetSpawn,
  onDescendants,
  onDrain,
  captureSpawnedIdentity = captureSpawnedProcessIdentity,
  cancelCheck,
}: RunSpawnedCommandOptions): Promise<CodexSpawnResult> {
  let startedAt = Date.now();
  let absoluteDeadlineMs = startedAt + timeoutMs;
  removeStaleOutputs([...cleanupPaths, outputLastMessagePath]);

  const maxCapturedStreamBytes = 4 * 1024 * 1024;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytesSeen = 0;
  let stderrBytesSeen = 0;
  let stdoutBytesRetained = 0;
  let stderrBytesRetained = 0;

  const appendBoundedChunk = (chunks: Buffer[], chunk: Buffer, retained: number): number => {
    chunks.push(Buffer.from(chunk));
    let retainedBytes = retained + chunk.length;
    while (retainedBytes > maxCapturedStreamBytes && chunks.length > 0) {
      const overflow = retainedBytes - maxCapturedStreamBytes;
      if (chunks[0].length <= overflow) {
        retainedBytes -= chunks.shift()!.length;
      } else {
        chunks[0] = chunks[0].subarray(overflow);
        retainedBytes -= overflow;
      }
    }
    return retainedBytes;
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let successObserved = false;
    let successGraceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let terminationCause: 'success' | 'cancel' | 'timeout' | 'cancel-check-error' | null = null;
    let cancelCheckError: CodexCancelCheckError | null = null;
    let successTerminationSent = false;
    let jsonStreamObserved = false;
    let nonterminalProgressAfterSuccess = false;
    let latestNonterminalArtifactProgressAtMs = 0;
    let nonterminalStreamProgressEvents = 0;
    let latestStreamProgressAtMs = 0;
    let observedStreamBytes = 0;
    let observedArtifactSignature = '';
    let progressSignature = '';
    let controlsArmed = false;
    let brokerIdentity: PersistedProcessIdentity | null = null;
    let targetIdentity: PersistedProcessIdentity | null = null;
    let descendantIdentities: PersistedProcessIdentity[] = [];
    let brokerDrainAttested = false;
    let launchAttested = false;
    let releaseAttested = false;
    let shutdownAckObserved = false;
    let brokerOnlyShutdownAttested = false;
    let authenticatedShutdownAck: {
      cause: string;
      targetIdentity: PersistedProcessIdentity | null;
      descendantIdentities: PersistedProcessIdentity[];
    } | null = null;
    let brokerShutdownCause = '';
    let targetOutcome: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let protocolFailure = '';
    let launchDeliveryFailure = '';
    let releaseDeliveryFailure = '';
    let shutdownDeliveryFailure = '';
    let shutdownReleaseDeliveryFailure = '';
    let targetPublicationError: Error | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;
    let shutdownProgressSequence = 0;
    let shutdownProgressCause = '';
    let shutdownProgressObservationCount = -1;
    let shutdownProgressSnapshotDigest = '';
    let identicalShutdownProgressObservations = 0;
    let shutdownProgressEpoch = -1;
    const shutdownProgressDigests = new Set<string>();
    const testProtocolTiming = env.PICKLE_TEST_MODE === '1';
    const boundedTestTiming = (name: string, fallback: number): number => testProtocolTiming
      ? Math.max(100, Math.min(Number(env[name] || fallback), fallback)) : fallback;
    const controllerForceKillTimeoutMs = boundedTestTiming(
      'PICKLE_TEST_CONTROLLER_FORCE_KILL_TIMEOUT_MS', CONTROLLER_BROKER_FORCE_KILL_TIMEOUT_MS,
    );
    const convergenceProgressStallTimeoutMs = boundedTestTiming(
      'PICKLE_TEST_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS', BROKER_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS,
    );
    const launchId = crypto.randomUUID();
    const launchCommandDigest = commandDigest(command, args, cwd);

    const brokerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/monitored-process-broker.js');
    const child = spawn(process.execPath, [brokerPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as const,
      env: process.env,
      detached: process.platform !== 'win32',
    });

    const sendBrokerControl = (
      message: Record<string, unknown>,
      authorityObserved: () => boolean,
      recordUnacknowledgedFailure: (error: Error) => void,
    ): boolean => {
      const recordFailure = (error: unknown): void => {
        // IPC can report EPIPE after the broker consumed a message and
        // published its identity-bound acknowledgement. Only that protocol
        // evidence supersedes the transport failure.
        if (authorityObserved()) return;
        recordUnacknowledgedFailure(error instanceof Error ? error : new Error(String(error)));
      };
      if (!child.connected || typeof child.send !== 'function') {
        recordFailure(new Error('Monitored process broker IPC channel is disconnected.'));
        return false;
      }
      try {
        child.send(message, (error) => {
          if (error) recordFailure(error);
        });
        return true;
      } catch (error) {
        recordFailure(error);
        return false;
      }
    };

    const cleanup = (): void => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };

    const finalize = (result: Omit<CodexSpawnResult, 'command' | 'args'>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        command,
        args,
        ...result,
      });
    };

    const currentStdout = (): string => Buffer.concat(stdoutChunks).toString('utf8');
    const currentStderr = (): string => Buffer.concat(stderrChunks).toString('utf8');
    const observedArtifactPaths = [...new Set([outputLastMessagePath, ...progressArtifactPaths].filter(Boolean))];
    const currentProgressSignature = (): string => JSON.stringify({
      stdout: stdoutBytesSeen,
      stderr: stderrBytesSeen,
      artifacts: observedArtifactPaths.map((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          return [filePath, stat.size, stat.mtimeMs];
        } catch {
          return [filePath, -1, -1];
        }
      }),
    });
    const currentArtifactSignature = (): string => JSON.stringify(observedArtifactPaths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return [filePath, stat.size, stat.mtimeMs];
      } catch {
        return [filePath, -1, -1];
      }
    }));
    const currentArtifactTimestampMs = (): number => observedArtifactPaths.reduce((latest, filePath) => {
      try {
        return Math.max(latest, fs.statSync(filePath).mtimeMs);
      } catch {
        return latest;
      }
    }, 0);

    const signalAttestedGroup = (signal: NodeJS.Signals): boolean => {
      if (!brokerIdentity) return false;
      const brokerLiveness = inspectProcessLivenessIdentity(brokerIdentity);
      const targetLiveness = targetIdentity ? inspectProcessLivenessIdentity(targetIdentity) : 'not-running';
      // A numeric PGID is safe only while at least one immutable member still
      // proves ownership. PID reuse is never treated as absence or authority.
      if (brokerLiveness !== 'matched'
        && !(targetIdentity?.pgid === brokerIdentity.pgid && targetLiveness === 'matched')) return false;
      try {
        if (process.platform !== 'win32') process.kill(-brokerIdentity.pgid, signal);
        else if (brokerLiveness === 'matched') child.kill(signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };

    const armBrokerFallback = (delayMs: number): void => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        if (!shutdownAckObserved || processGroupAlive(brokerIdentity?.pgid || 0)) {
          signalAttestedGroup('SIGKILL');
        }
      }, delayMs);
      fallbackTimer.unref?.();
    };

    const requestBrokerShutdown = (cause: string): void => {
      sendBrokerControl(
        { type: 'terminate', launch_id: launchId, cause, grace_ms: 500 },
        () => shutdownAckObserved,
        (error) => {
          shutdownDeliveryFailure = `Monitored broker termination delivery failed: ${safeErrorMessage(error)}`;
        },
      );
      // Do not let an expired controller timer run before a queued IPC ack and
      // destroy the broker's authenticated ledger. The broker gets its full
      // release/fallback budget first; this is only the final wedged-broker
      // safeguard after that autonomous path should already have drained.
      armBrokerFallback(controllerForceKillTimeoutMs);
    };

    const requestTermination = (
      cause: NonNullable<typeof terminationCause>,
      error: CodexCancelCheckError | null = null,
    ): boolean => {
      if (terminationCause !== null || child.exitCode !== null || child.signalCode !== null) return false;
      terminationCause = cause;
      cancelCheckError = error;
      if (successGraceTimer) clearTimeout(successGraceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      requestBrokerShutdown(cause);
      return true;
    };

    const armSuccessTermination = (afterNonterminalProgress = false): void => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      const usage = inspectCodexUsage(currentStdout());
      jsonStreamObserved ||= detectOutputFormat(currentStdout()) === 'stream-json';
      const awaitingTerminalUsage = awaitUsageOnSuccess && jsonStreamObserved
        && !usage.reported && !usage.turnCompleted;
      const requestedGraceMs = awaitingTerminalUsage ? usageCompletionGraceMs : successSignalGraceMs;
      const armedAtMs = Date.now();
      const drainReserveMs = 250;
      const terminalUsageObserved = usage.reported || usage.turnCompleted;
      const reservedDrainMs = terminalUsageObserved && !afterNonterminalProgress ? drainReserveMs : 0;
      const requestedSuccessGraceDeadlineMs = armedAtMs + requestedGraceMs;
      if (afterNonterminalProgress && requestedSuccessGraceDeadlineMs >= absoluteDeadlineMs) return;
      const graceMs = Math.min(
        requestedGraceMs,
        Math.max(0, absoluteDeadlineMs - armedAtMs - reservedDrainMs),
      );
      successGraceTimer = setTimeout(() => {
        if (!successTerminationSent && requestTermination('success')) {
          successTerminationSent = true;
        }
      }, graceMs);
    };

    const observeProgress = (): void => {
      const signature = currentProgressSignature();
      if (signature === progressSignature) return;
      const streamBytes = stdoutBytesSeen + stderrBytesSeen;
      const artifactSignature = currentArtifactSignature();
      const streamChanged = streamBytes !== observedStreamBytes;
      const artifactsChanged = artifactSignature !== observedArtifactSignature;
      observedStreamBytes = streamBytes;
      observedArtifactSignature = artifactSignature;
      progressSignature = signature;
      if (successObserved && !successTerminationSent) {
        const usage = inspectCodexUsage(currentStdout());
        const nonterminalProgress = !usage.reported && !usage.turnCompleted;
        if (nonterminalProgress) {
          nonterminalProgressAfterSuccess = true;
          if (streamChanged) nonterminalStreamProgressEvents += 1;
          if (artifactsChanged) {
            latestNonterminalArtifactProgressAtMs = Math.max(
              latestNonterminalArtifactProgressAtMs,
              currentArtifactTimestampMs(),
            );
          }
        }
        armSuccessTermination(nonterminalProgress);
      }
    };

    const checkForSuccess = (): void => {
      observeProgress();
      if (successObserved || typeof successCheck !== 'function') return;
      const ctx: SuccessCheckContext = {
        stdout: currentStdout(),
        stderr: currentStderr(),
        lastMessage: readLastMessage(outputLastMessagePath),
        outputFormat: detectOutputFormat(currentStdout()),
        assistantContent: extractAssistantContent(currentStdout()),
        toolCalls: collectCodexToolCalls(currentStdout()),
      };
      try {
        if (!successCheck(ctx)) {
          return;
        }
      } catch {
        return;
      }

      successObserved = true;
      progressSignature = currentProgressSignature();
      armSuccessTermination();
    };

    const checkForCancellation = (): boolean => {
      if (terminationCause !== null || typeof cancelCheck !== 'function') return terminationCause !== null;
      let cancelled: boolean;
      try {
        cancelled = cancelCheck();
      } catch (error) {
        const typedError = new CodexCancelCheckError(error);
        const accepted = requestTermination('cancel-check-error', typedError);
        if (!accepted && terminationCause === null
          && (child.exitCode !== null || child.signalCode !== null)) {
          // The process can exit before stdio closes. A control-state failure
          // observed in that drain window must not be silently downgraded to
          // the child's otherwise-successful exit.
          terminationCause = 'cancel-check-error';
          cancelCheckError = typedError;
          cleanup();
        }
        return true;
      }
      if (!cancelled) return false;
      requestTermination('cancel');
      return true;
    };

    const armExecutionControls = (): void => {
      if (controlsArmed || settled) return;
      controlsArmed = true;
      startedAt = Date.now();
      absoluteDeadlineMs = startedAt + timeoutMs;
      timeoutTimer = setTimeout(() => {
        if (terminationCause === null && child.exitCode === null && child.signalCode === null) {
          // Cancellation and an unreadable cancellation source are ownership
          // decisions, so sample them at the immutable timeout boundary before
          // classifying the same delayed event-loop turn as an ordinary timeout.
          if (checkForCancellation()) return;
          if (!successObserved) checkForSuccess();
          const usage = inspectCodexUsage(currentStdout());
          const terminalUsageObserved = usage.reported || usage.turnCompleted;
          const recentProgressThresholdMs = absoluteDeadlineMs - successSignalGraceMs;
          const nonterminalProgressStillActive = nonterminalProgressAfterSuccess && (
            latestNonterminalArtifactProgressAtMs > recentProgressThresholdMs
            || (nonterminalStreamProgressEvents > 1 && latestStreamProgressAtMs > recentProgressThresholdMs)
          );
          if (successObserved
            && (terminalUsageObserved || !nonterminalProgressStillActive)) {
            if (successGraceTimer) clearTimeout(successGraceTimer);
            if (!successTerminationSent && requestTermination('success')) {
              successTerminationSent = true;
            }
            return;
          }
          requestTermination('timeout');
        }
      }, timeoutMs);

      if (typeof successCheck === 'function') {
        pollTimer = setInterval(checkForSuccess, successPollMs);
        checkForSuccess();
      }

      if (typeof cancelCheck === 'function') {
        cancelTimer = setInterval(() => {
          checkForCancellation();
        }, 100);
      }
    };

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const record = message as Record<string, unknown>;
      if (record.launch_id !== launchId) return; // stale/foreign IPC is inert

      const bound = record.command_digest === launchCommandDigest
        && sameIdentity(brokerIdentity, record.broker_identity);

      const persistDescendantLedger = (raw: unknown): boolean => {
        if (!brokerIdentity || !targetIdentity || !Array.isArray(raw)) return false;
        const merged = [...descendantIdentities];
        for (const rawIdentity of raw) {
          if (!rawIdentity || typeof rawIdentity !== 'object') return false;
          const candidate = rawIdentity as PersistedProcessIdentity;
          if (!isPersistedProcessIdentityValid(candidate)) return false;
          const liveness = inspectProcessLivenessIdentity(candidate);
          // Exit between broker observation and controller delivery is benign;
          // a live mismatch is PID reuse and must fail closed.
          if (liveness === 'reused') return false;
          const existingPid = merged.find((identity) => identity.pid === candidate.pid);
          if (existingPid && !sameIdentity(existingPid, candidate)) return false;
          if (!merged.some((identity) => identity.fingerprint === candidate.fingerprint)
            && candidate.fingerprint !== targetIdentity.fingerprint
            && candidate.fingerprint !== brokerIdentity.fingerprint) merged.push(candidate);
        }
        try {
          onDescendants?.(brokerIdentity, targetIdentity, merged);
        } catch (error) {
          targetPublicationError = error instanceof Error ? error : new Error(String(error));
          requestBrokerShutdown('descendant-publication-failed');
          return false;
        }
        descendantIdentities = merged;
        return true;
      };
      if (record.type === 'launched') {
        if (!bound || !brokerIdentity || !record.target_identity || typeof record.target_identity !== 'object') {
          protocolFailure = 'Monitored process broker launch attestation failed.';
          requestBrokerShutdown('launch-attestation-failed');
          return;
        }
        const candidate = record.target_identity as PersistedProcessIdentity;
        const independentlyCaptured = captureProcessLivenessIdentity(Number(candidate.pid));
        if (!independentlyCaptured || !sameIdentity(independentlyCaptured, candidate)
          || candidate.pgid !== brokerIdentity.pgid) {
          protocolFailure = 'Monitored target identity or process-group binding could not be verified.';
          requestBrokerShutdown('target-attestation-failed');
          return;
        }
        if (targetIdentity) {
          if (!sameIdentity(targetIdentity, candidate)) {
            protocolFailure = 'Monitored process broker sent conflicting target attestations.';
            requestBrokerShutdown('conflicting-target-attestation');
          }
          return;
        }
        targetIdentity = independentlyCaptured;
        launchAttested = true;
        try {
          onTargetSpawn?.(brokerIdentity, independentlyCaptured);
        } catch (error) {
          targetPublicationError = error instanceof Error ? error : new Error(String(error));
          requestBrokerShutdown('target-publication-failed');
          return;
        }
        if (process.platform === 'win32') {
          releaseAttested = true;
          armExecutionControls();
        } else {
          sendBrokerControl(
            { type: 'release', launch_id: launchId, command_digest: launchCommandDigest },
            () => releaseAttested,
            (error) => {
              releaseDeliveryFailure = `Monitored target release failed: ${safeErrorMessage(error)}`;
              protocolFailure = releaseDeliveryFailure;
              requestBrokerShutdown('target-release-failed');
            },
          );
        }
        return;
      }

      if (record.type === 'released') {
        if (!bound || !targetIdentity || !sameIdentity(targetIdentity, record.target_identity)) {
          protocolFailure = 'Monitored target release attestation failed.';
          requestBrokerShutdown('release-attestation-failed');
          return;
        }
        releaseAttested = true;
        if (protocolFailure === releaseDeliveryFailure) protocolFailure = '';
        releaseDeliveryFailure = '';
        armExecutionControls();
        return;
      }

      if (record.type === 'descendants') {
        if (!bound || !targetIdentity || !sameIdentity(targetIdentity, record.target_identity)
          || !persistDescendantLedger(record.descendant_identities)) {
          protocolFailure = 'Monitored descendant ledger update failed attestation.';
          requestBrokerShutdown('descendant-attestation-failed');
        }
        return;
      }

      if (record.type === 'shutdown_progress') {
        const envelopeValid = bound && targetIdentity && sameIdentity(targetIdentity, record.target_identity)
          && typeof record.cause === 'string' && record.cause.length > 0
          && Number.isInteger(record.sequence) && Number(record.sequence) === shutdownProgressSequence + 1
          && typeof record.stage === 'string' && record.stage.length > 0
          && Number.isInteger(record.epoch) && Number(record.epoch) >= 0
          && Number.isInteger(record.observation_count) && Number(record.observation_count) >= 0
          && (!shutdownProgressCause || shutdownProgressCause === record.cause);
        if (!envelopeValid) return;
        const observationCount = Number(record.observation_count);
        const epoch = Number(record.epoch);
        const digest = typeof record.snapshot_digest === 'string'
          && /^[a-f0-9]{64}$/.test(record.snapshot_digest) ? record.snapshot_digest : '';
        const initialAuthority = shutdownProgressSequence === 0 && observationCount === 0
          && epoch === 0 && record.stage === 'shutdown-started' && record.snapshot_digest === null;
        const revisitsPriorState = Boolean(digest) && shutdownProgressDigests.has(digest)
          && digest !== shutdownProgressSnapshotDigest;
        const nextIdenticalCount = digest && digest === shutdownProgressSnapshotDigest
          ? identicalShutdownProgressObservations + 1 : 1;
        const materialObservation = observationCount > shutdownProgressObservationCount
          && epoch >= shutdownProgressEpoch && Boolean(digest) && !revisitsPriorState
          && nextIdenticalCount <= MIN_TARGET_STOP_ATTESTATION_OBSERVATIONS;
        if (!initialAuthority && !materialObservation) return;
        shutdownProgressSequence = Number(record.sequence);
        shutdownProgressCause = String(record.cause);
        shutdownProgressObservationCount = observationCount;
        shutdownProgressEpoch = epoch;
        if (digest) {
          identicalShutdownProgressObservations = nextIdenticalCount;
          shutdownProgressSnapshotDigest = digest;
          shutdownProgressDigests.add(digest);
        }
        armBrokerFallback(convergenceProgressStallTimeoutMs);
        return;
      }

      if (record.type === 'shutdown_ack') {
        if (shutdownAckObserved) {
          const exactDuplicate = bound && authenticatedShutdownAck
            && record.cause === authenticatedShutdownAck.cause
            && (authenticatedShutdownAck.targetIdentity
              ? sameIdentity(authenticatedShutdownAck.targetIdentity, record.target_identity)
              : record.target_identity === null)
            && sameIdentityLedger(authenticatedShutdownAck.descendantIdentities, record.descendant_identities);
          if (exactDuplicate) return;
          protocolFailure = 'Monitored process broker sent a conflicting shutdown attestation.';
          return;
        }
        const brokerOnlyShutdown = isAuthenticatedBrokerOnlyShutdownLedger(
          launchAttested,
          targetIdentity,
          record.target_identity,
          record.descendant_identities,
          record.cause,
        );
        const targetBound = targetIdentity
          ? sameIdentity(targetIdentity, record.target_identity)
          : brokerOnlyShutdown;
        if (!bound || typeof record.cause !== 'string' || !record.cause || !targetBound) {
          protocolFailure = 'Monitored process broker shutdown attestation failed.';
          return;
        }
        if (brokerOnlyShutdown) {
          brokerOnlyShutdownAttested = true;
        } else if (!persistDescendantLedger(record.descendant_identities)) {
          protocolFailure = 'Monitored descendant shutdown ledger was malformed or conflicted.';
          return;
        }
        shutdownAckObserved = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        brokerShutdownCause = record.cause;
        authenticatedShutdownAck = {
          cause: record.cause,
          targetIdentity,
          descendantIdentities: [...descendantIdentities],
        };
        targetOutcome = {
          code: typeof record.target_exit_code === 'number' ? record.target_exit_code : null,
          signal: typeof record.target_signal === 'string' ? record.target_signal as NodeJS.Signals : null,
        };
        sendBrokerControl(
          { type: 'shutdown_release', launch_id: launchId, command_digest: launchCommandDigest },
          () => child.exitCode !== null || child.signalCode !== null,
          (error) => {
            // The broker's bounded self-drain can still prove quiescence, but
            // retain the transport failure until that exact proof arrives.
            shutdownReleaseDeliveryFailure = `Monitored broker shutdown release delivery failed: ${safeErrorMessage(error)}`;
          },
        );
        // The pre-ack semantic-progress lease ends here. A distinct bounded
        // post-ack watchdog now covers immediate release delivery and exact
        // group drain; a broker wedged after publishing authority is reaped.
        armBrokerFallback(controllerForceKillTimeoutMs);
      }
    });

    child.stdout!.on('data', (chunk: Buffer) => {
      latestStreamProgressAtMs = Date.now();
      stdoutBytesSeen += chunk.length;
      stdoutBytesRetained = appendBoundedChunk(stdoutChunks, chunk, stdoutBytesRetained);
      checkForSuccess();
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      latestStreamProgressAtMs = Date.now();
      stderrBytesSeen += chunk.length;
      stderrBytesRetained = appendBoundedChunk(stderrChunks, chunk, stderrBytesRetained);
      checkForSuccess();
    });

    child.on('error', (error: Error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // The child can publish its authoritative success artifact and exit
      // between polling intervals. Its exit stops all further work, so one
      // final evaluation cannot extend the deadline or accept a live process.
      // Never re-evaluate after timeout/cancellation: shutdown handlers may
      // write drain artifacts that did not exist at the decision boundary.
      if (terminationCause === null && !successObserved) checkForSuccess();
      cleanup();
      const flushStarted = Date.now();
      // One immutable identity observation can require two `ps` calls. The old
      // two-second window could therefore expire during its first exact
      // observation and reject a broker that had already drained. Cover the
      // broker kill fallback plus both bounded `ps` calls, and always permit a
      // second observation when the first still sees a live identity/group.
      const attestationDeadline = Date.now() + POST_CLOSE_ATTESTATION_WINDOW_MS;
      let attestationObservations = 0;
      let stableSignature = currentProgressSignature();
      const flushQuietMs = Math.max(50, Math.min(successSignalGraceMs, 250));
      const finalizeAfterFlush = (): void => {
        const nextSignature = currentProgressSignature();
        if (nextSignature !== stableSignature && Date.now() - flushStarted < 1_000) {
          stableSignature = nextSignature;
          setTimeout(finalizeAfterFlush, flushQuietMs);
          return;
        }
        attestationObservations += 1;
        const brokerLiveness = brokerIdentity
          ? inspectProcessLivenessIdentity(brokerIdentity) : 'not-running';
        const targetLiveness = targetIdentity
          ? inspectProcessLivenessIdentity(targetIdentity) : 'not-running';
        const descendantLiveness = descendantIdentities.map(inspectProcessLivenessIdentity);
        if (!launchAttested && launchDeliveryFailure && !protocolFailure) {
          protocolFailure = launchDeliveryFailure;
        }
        if (!shutdownAckObserved && shutdownDeliveryFailure && !protocolFailure) {
          protocolFailure = shutdownDeliveryFailure;
        }
        const attestedGroups = new Set([brokerIdentity?.pgid,
          ...descendantIdentities.map((identity) => identity.pgid)].filter((pgid): pgid is number => Boolean(pgid)));
        const groupLiveness = [...attestedGroups].map((pgid) => ({ pgid, alive: processGroupAlive(pgid) }));
        const groupsAbsent = groupLiveness.every(({ alive }) => !alive);
        const identitiesAbsent = brokerLiveness === 'not-running' && targetLiveness === 'not-running'
          && descendantLiveness.every((liveness) => liveness === 'not-running');
        if (attestationObservations < MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS) {
          setTimeout(finalizeAfterFlush, 25);
          return;
        }
        if (shutdownAckObserved && identitiesAbsent && groupsAbsent && !protocolFailure
          && brokerIdentity && (targetIdentity || brokerOnlyShutdownAttested)) {
          brokerDrainAttested = true;
        } else if ((brokerLiveness === 'matched' || targetLiveness === 'matched'
          || descendantLiveness.includes('matched'))
          && (attestationObservations < MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS
            || Date.now() < attestationDeadline)) {
          setTimeout(finalizeAfterFlush, 25);
          return;
        } else if (!groupsAbsent
          && (attestationObservations < MIN_POST_CLOSE_ATTESTATION_OBSERVATIONS
            || Date.now() < attestationDeadline)) {
          setTimeout(finalizeAfterFlush, 25);
          return;
        }
        if (brokerDrainAttested && brokerIdentity) {
          try {
            onDrain?.(brokerIdentity, targetIdentity, descendantIdentities);
          } catch (error) {
            protocolFailure = `Monitored process drain persistence failed: ${safeErrorMessage(error)}`;
            brokerDrainAttested = false;
          }
        }
        const stdout = currentStdout();
        const stderr = currentStderr();
        const message = readLastMessage(outputLastMessagePath);
        const outputFormat = detectOutputFormat(stdout);
        const usage = inspectCodexUsage(stdout);
        const unattestedBrokerClose = controlsArmed && !brokerDrainAttested;
        const targetExitedBeforeTimeout = terminationCause === 'timeout'
          && shutdownAckObserved
          && (brokerShutdownCause === 'target-exit' || /^target-SIG[A-Z0-9]+$/.test(brokerShutdownCause))
          && Boolean(targetOutcome && (targetOutcome.code !== null || targetOutcome.signal !== null));
        const effectiveTerminationCause = targetExitedBeforeTimeout ? null : terminationCause;
        const drainFailureDiagnostic = unattestedBrokerClose ? JSON.stringify({
          shutdown_ack_observed: shutdownAckObserved,
          broker_shutdown_cause: brokerShutdownCause || null,
          launch_attested: launchAttested,
          release_attested: releaseAttested,
          broker_identity_persisted: Boolean(brokerIdentity),
          target_identity_persisted: Boolean(targetIdentity),
          broker_liveness: brokerLiveness,
          target_liveness: targetLiveness,
          descendant_liveness: descendantLiveness,
          group_liveness: groupLiveness,
          protocol_failure: protocolFailure || null,
          shutdown_delivery_failure: shutdownDeliveryFailure || null,
          shutdown_release_delivery_failure: shutdownReleaseDeliveryFailure || null,
          target_outcome: targetOutcome,
          broker_close: { code, signal },
          termination_cause: terminationCause,
          effective_termination_cause: effectiveTerminationCause,
          attestation_observations: attestationObservations,
        }) : '';
        const naturalExitCode = targetOutcome?.code ?? (targetOutcome?.signal ? 1 : (code ?? (signal ? 1 : 0)));
        const result: Omit<CodexSpawnResult, 'command' | 'args'> = {
          exitCode: effectiveTerminationCause === 'cancel'
            ? 130
            : effectiveTerminationCause === 'timeout'
              ? 124
              : successObserved && !unattestedBrokerClose && !protocolFailure
                ? 0
                : protocolFailure || targetPublicationError || unattestedBrokerClose
                  ? 1
                  : naturalExitCode,
          stdout,
          stderr: [stderr, protocolFailure,
            unattestedBrokerClose ? 'Monitored process broker closed without an exact quiescent target attestation.' : '',
            drainFailureDiagnostic ? `Monitored process drain diagnostic: ${drainFailureDiagnostic}` : '',
            !brokerDrainAttested ? shutdownReleaseDeliveryFailure : '',
            targetPublicationError?.message || '',
          ].filter(Boolean).join('\n'),
          timedOut: effectiveTerminationCause === 'timeout',
          durationMs: Date.now() - startedAt,
          lastMessage: message,
          usage: usage.usage as CodexUsage,
          usageReported: usage.reported,
          terminatedAfterSuccess: effectiveTerminationCause === 'success',
          cancelled: effectiveTerminationCause === 'cancel',
          outputFormat,
          assistantContent: extractAssistantContent(stdout),
          toolCalls: collectCodexToolCalls(stdout),
          drainAttested: brokerDrainAttested,
          shutdownCause: brokerShutdownCause || null,
          requestedTerminationCause: terminationCause,
          effectiveTerminationCause,
          targetOutcome,
          processIdentities: { broker: brokerIdentity, target: targetIdentity, descendants: descendantIdentities },
        };
        if (targetPublicationError) {
          settled = true;
          cleanup();
          reject(targetPublicationError);
          return;
        }
        if (cancelCheckError) {
          settled = true;
          cleanup();
          cancelCheckError.attachResult({ command, args, ...result });
          reject(cancelCheckError);
          return;
        }
        finalize(result);
      };
      setTimeout(finalizeAfterFlush, flushQuietMs);
    });

    child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
      // A short-lived command may exit before the prompt has finished writing.
      // Its process exit remains authoritative; an EPIPE on stdin is only the
      // expected consequence of the child closing its read end first.
      if (error.code === 'EPIPE') return;
      if (settled) return;
      targetPublicationError = error;
      requestBrokerShutdown('stdin-error');
    });

    try {
      const capturedBrokerIdentity = captureSpawnedIdentity(Number(child.pid));
      if (!capturedBrokerIdentity) {
        throw new Error('Could not capture immutable monitored process broker identity.');
      }
      brokerIdentity = capturedBrokerIdentity;
      onSpawn?.(child, capturedBrokerIdentity);
      sendBrokerControl({
        type: 'launch',
        launch_id: launchId,
        command_digest: launchCommandDigest,
        command,
        args,
        cwd,
        env: { ...process.env, ...env },
      }, () => launchAttested, (error) => {
        // Do not reject from this transport callback. The broker may already
        // have consumed the request and queued its authenticated `launched`
        // response before closing the channel. Its identity-bound response or
        // eventual process close decides the outcome.
        launchDeliveryFailure = `Monitored broker launch delivery failed: ${safeErrorMessage(error)}`;
      });
    } catch (error) {
      cleanup();
      terminateUnreleasedBroker(child, 'SIGTERM');
      const killTimer = setTimeout(() => terminateUnreleasedBroker(child, 'SIGKILL'), 1_000);
      killTimer.unref?.();
      child.stdin!.destroy();
      reject(error);
      return;
    }
    child.stdin!.end(input ?? '');
  });
}

export function getCodexVersion(): string {
  const config = loadConfig();
  const result: SpawnSyncReturns<string> = spawnSync(config.runtime.command, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to determine Codex version');
  }
  return result.stdout.trim();
}

function buildCodexExecInvocation(options: CodexExecOptions): { command: string; args: string[] } {
  const config = loadConfig();
  const command = options.command || config.runtime.command;
  const args = ['exec', ...(options.execArgs ?? config.runtime.exec_args ?? ['--sandbox', 'workspace-write'])];

  if (options.cwd) {
    args.push('--cd', options.cwd);
  }
  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (config.runtime.model || options.model) {
    args.push('--model', options.model || config.runtime.model || '');
  }
  if (config.runtime.json_output !== false || options.json) {
    args.push('--json');
  }

  const configuredAddDirs = options.inheritConfiguredAddDirs === false
    ? []
    : (config.runtime.add_dirs || []);
  const addDirs = [...configuredAddDirs, ...(options.addDirs || [])];
  assertAddDirsUnderTmpdirIfTestMode(addDirs);
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }

  if (options.outputLastMessagePath) {
    args.push('--output-last-message', options.outputLastMessagePath);
  }

  args.push('-');

  return { command, args };
}

export async function runCommand(options: RunSpawnedCommandOptions): Promise<CodexSpawnResult> {
  return await runSpawnedCommand(options);
}

export async function runCodexExec(options: CodexExecOptions): Promise<CodexSpawnResult> {
  const { command, args } = buildCodexExecInvocation(options);
  return await runSpawnedCommand({
    command,
    args,
    cwd: options.cwd,
    input: options.prompt,
    timeoutMs: options.timeoutMs,
    env: options.env,
    outputLastMessagePath: options.outputLastMessagePath,
    progressArtifactPaths: options.progressArtifactPaths,
    cleanupPaths: options.cleanupPaths,
    onSpawn: options.onSpawn,
    onTargetSpawn: options.onTargetSpawn,
    onDescendants: options.onDescendants,
    onDrain: options.onDrain,
    captureSpawnedIdentity: options.captureSpawnedIdentity,
    cancelCheck: options.cancelCheck,
    awaitUsageOnSuccess: args.includes('--json'),
  });
}

export async function runCodexExecMonitored(options: CodexExecOptions): Promise<CodexSpawnResult> {
  const { command, args } = buildCodexExecInvocation(options);
  const telemetryStartedAt = Date.now();
  const reservation = options.telemetry
    ? reserveModelCallTelemetry(options.telemetry.sessionDir, options.telemetry) : null;
  let result: CodexSpawnResult;
  try {
    result = await runSpawnedCommand({
      command,
      args,
      cwd: options.cwd,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      env: options.env,
      outputLastMessagePath: options.outputLastMessagePath,
      progressArtifactPaths: options.progressArtifactPaths,
      successCheck: options.successCheck,
      successSignalGraceMs: options.successSignalGraceMs,
      successPollMs: options.successPollMs,
      cleanupPaths: options.cleanupPaths,
      onSpawn: options.onSpawn,
      onTargetSpawn: options.onTargetSpawn,
      onDescendants: options.onDescendants,
      onDrain: options.onDrain,
      captureSpawnedIdentity: options.captureSpawnedIdentity,
      cancelCheck: options.cancelCheck,
      awaitUsageOnSuccess: args.includes('--json'),
    });
  } catch (error) {
    if (options.telemetry && reservation) {
      const capturedResult = error instanceof CodexCancelCheckError ? error.result : null;
      finalizeModelCallTelemetry(options.telemetry.sessionDir, reservation, {
        result: capturedResult ?? {
          command, args, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error),
          timedOut: false, durationMs: Date.now() - telemetryStartedAt, lastMessage: '',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          usageReported: false, terminatedAfterSuccess: false, cancelled: false,
          outputFormat: 'plain-text', assistantContent: '', toolCalls: [],
          drainAttested: false,
          processIdentities: { broker: null, target: null, descendants: [] },
        },
        outcome: 'failed',
      });
    }
    throw error;
  }
  if (options.telemetry && reservation) {
    finalizeModelCallTelemetry(options.telemetry.sessionDir, reservation, { result });
  }
  return result;
}

export function assertCodexSucceeded(result: CodexSpawnResult, context: string = 'Codex execution failed'): void {
  if (result.exitCode === 0) return;
  throw new Error(`${context}: ${safeErrorMessage(result.stderr || result.stdout || result.exitCode)}`);
}
