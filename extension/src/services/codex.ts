import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { finalizeModelCallTelemetry, reserveModelCallTelemetry } from './productive-autonomy.js';
import { loadConfig } from './config.js';
import { safeErrorMessage } from './pickle-utils.js';
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

  constructor(cause: unknown) {
    super(`Codex cancellation check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CodexCancelCheckError';
    this.cause = cause;
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

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
  cancelCheck,
}: RunSpawnedCommandOptions): Promise<CodexSpawnResult> {
  const startedAt = Date.now();
  const absoluteDeadlineMs = startedAt + timeoutMs;
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
    let progressSignature = '';

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
    });

    const cleanup = (): void => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (cancelTimer) clearInterval(cancelTimer);
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

    const scheduleTermination = (
      signal: NodeJS.Signals,
      followupSignal: NodeJS.Signals | null = null,
      delayMs: number = 1_000,
    ): void => {
      terminateProcessTree(child, signal);
      if (!followupSignal) return;
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateProcessTree(child, followupSignal);
        }
      }, delayMs).unref?.();
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
      scheduleTermination('SIGTERM', 'SIGKILL');
      return true;
    };

    const armSuccessTermination = (): void => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      const usage = inspectCodexUsage(currentStdout());
      jsonStreamObserved ||= detectOutputFormat(currentStdout()) === 'stream-json';
      const awaitingTerminalUsage = awaitUsageOnSuccess && jsonStreamObserved
        && !usage.reported && !usage.turnCompleted;
      const drainReserveMs = 250;
      const graceMs = awaitingTerminalUsage
        ? Math.min(usageCompletionGraceMs, Math.max(0, absoluteDeadlineMs - Date.now() - drainReserveMs))
        : successSignalGraceMs;
      successGraceTimer = setTimeout(() => {
        if (!successTerminationSent && requestTermination('success')) {
          successTerminationSent = true;
        }
      }, graceMs);
    };

    const observeProgress = (): void => {
      const signature = currentProgressSignature();
      if (signature === progressSignature) return;
      progressSignature = signature;
      if (successObserved && !successTerminationSent) armSuccessTermination();
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

    timeoutTimer = setTimeout(() => {
      if (terminationCause === null && child.exitCode === null && child.signalCode === null) {
        const successWasObserved = successObserved;
        if (!successWasObserved) checkForSuccess();
        if (!successWasObserved && successObserved) {
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
        if (terminationCause !== null) return;
        let cancelled: boolean;
        try {
          cancelled = cancelCheck();
        } catch (error) {
          const typedError = new CodexCancelCheckError(error);
          requestTermination('cancel-check-error', typedError);
          return;
        }
        if (!cancelled) return;
        requestTermination('cancel');
      }, 100);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytesSeen += chunk.length;
      stdoutBytesRetained = appendBoundedChunk(stdoutChunks, chunk, stdoutBytesRetained);
      checkForSuccess();
    });

    child.stderr.on('data', (chunk: Buffer) => {
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
      cleanup();
      const flushStarted = Date.now();
      let stableSignature = currentProgressSignature();
      const flushQuietMs = Math.max(50, Math.min(successSignalGraceMs, 250));
      const finalizeAfterFlush = (): void => {
        const nextSignature = currentProgressSignature();
        if (nextSignature !== stableSignature && Date.now() - flushStarted < 1_000) {
          stableSignature = nextSignature;
          setTimeout(finalizeAfterFlush, flushQuietMs);
          return;
        }
        const stdout = currentStdout();
        const stderr = currentStderr();
        const message = readLastMessage(outputLastMessagePath);
        const outputFormat = detectOutputFormat(stdout);
        const usage = inspectCodexUsage(stdout);
        if (cancelCheckError) {
          settled = true;
          cleanup();
          reject(cancelCheckError);
          return;
        }
        finalize({
          exitCode: terminationCause === 'cancel'
            ? 130
            : terminationCause === 'timeout'
              ? 124
              : successObserved
                ? 0
                : (code ?? (signal ? 1 : 0)),
          stdout,
          stderr,
          timedOut: terminationCause === 'timeout',
          durationMs: Date.now() - startedAt,
          lastMessage: message,
          usage: usage.usage as CodexUsage,
          usageReported: usage.reported,
          terminatedAfterSuccess: terminationCause === 'success',
          cancelled: terminationCause === 'cancel',
          outputFormat,
          assistantContent: extractAssistantContent(stdout),
          toolCalls: collectCodexToolCalls(stdout),
        });
      };
      setTimeout(finalizeAfterFlush, flushQuietMs);
    });

    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A short-lived command may exit before the prompt has finished writing.
      // Its process exit remains authoritative; an EPIPE on stdin is only the
      // expected consequence of the child closing its read end first.
      if (error.code === 'EPIPE') return;
      if (settled) return;
      cleanup();
      terminateProcessTree(child, 'SIGTERM');
      reject(error);
    });

    try {
      onSpawn?.(child);
    } catch (error) {
      cleanup();
      terminateProcessTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 1_000);
      killTimer.unref?.();
      child.stdin.destroy();
      reject(error);
      return;
    }
    child.stdin.end(input ?? '');
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
      cancelCheck: options.cancelCheck,
      awaitUsageOnSuccess: args.includes('--json'),
    });
  } catch (error) {
    if (options.telemetry && reservation) {
      finalizeModelCallTelemetry(options.telemetry.sessionDir, reservation, {
        result: {
          command, args, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error),
          timedOut: false, durationMs: Date.now() - telemetryStartedAt, lastMessage: '',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          usageReported: false, terminatedAfterSuccess: false, cancelled: false,
          outputFormat: 'plain-text', assistantContent: '', toolCalls: [],
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
