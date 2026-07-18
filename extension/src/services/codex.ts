import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { loadConfig } from './config.js';
import { safeErrorMessage } from './pickle-utils.js';
import {
  collectCodexToolCalls,
  detectOutputFormat,
  extractAssistantContent,
  extractCodexUsage,
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
  cleanupPaths = [],
  onSpawn,
  cancelCheck,
}: RunSpawnedCommandOptions): Promise<CodexSpawnResult> {
  removeStaleOutputs([...cleanupPaths, outputLastMessagePath]);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise((resolve, reject) => {
    let settled = false;
    let successObserved = false;
    let successGraceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let forcedAfterSuccess = false;
    let forcedByCancel = false;
    let forcedByTimeout = false;
    let progressSignature = '';

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
    });

    onSpawn?.(child);
    child.stdin.end(input ?? '');

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
      stdout: stdoutChunks.reduce((total, chunk) => total + chunk.length, 0),
      stderr: stderrChunks.reduce((total, chunk) => total + chunk.length, 0),
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

    const armSuccessTermination = (): void => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      successGraceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          forcedAfterSuccess = true;
          scheduleTermination('SIGTERM', 'SIGKILL');
        }
      }, successSignalGraceMs);
    };

    const observeProgress = (): void => {
      const signature = currentProgressSignature();
      if (signature === progressSignature) return;
      progressSignature = signature;
      if (successObserved) armSuccessTermination();
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
      if (child.exitCode === null && child.signalCode === null) {
        forcedByTimeout = true;
        scheduleTermination('SIGTERM', 'SIGKILL');
      }
    }, timeoutMs);

    if (typeof successCheck === 'function') {
      pollTimer = setInterval(checkForSuccess, successPollMs);
      checkForSuccess();
    }

    if (typeof cancelCheck === 'function') {
      cancelTimer = setInterval(() => {
        if (!cancelCheck()) return;
        if (child.exitCode === null && child.signalCode === null) {
          forcedByCancel = true;
          scheduleTermination('SIGTERM', 'SIGKILL');
        }
      }, 100);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
      checkForSuccess();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
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
        finalize({
          exitCode: forcedByCancel
            ? 130
            : forcedByTimeout
              ? 124
              : successObserved
                ? 0
                : (code ?? (signal ? 1 : 0)),
          stdout,
          stderr,
          timedOut: forcedByTimeout,
          lastMessage: message,
          usage: extractCodexUsage(stdout) as CodexUsage,
          terminatedAfterSuccess: forcedAfterSuccess,
          cancelled: forcedByCancel,
          outputFormat,
          assistantContent: extractAssistantContent(stdout),
          toolCalls: collectCodexToolCalls(stdout),
        });
      };
      setTimeout(finalizeAfterFlush, flushQuietMs);
    });
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
  const args = ['exec', ...(config.runtime.exec_args || ['--full-auto'])];

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

  const addDirs = [...(config.runtime.add_dirs || []), ...(options.addDirs || [])];
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
  });
}

export async function runCodexExecMonitored(options: CodexExecOptions): Promise<CodexSpawnResult> {
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
    successCheck: options.successCheck,
    successSignalGraceMs: options.successSignalGraceMs,
    successPollMs: options.successPollMs,
    cleanupPaths: options.cleanupPaths,
    onSpawn: options.onSpawn,
    cancelCheck: options.cancelCheck,
  });
}

export function assertCodexSucceeded(result: CodexSpawnResult, context: string = 'Codex execution failed'): void {
  if (result.exitCode === 0) return;
  throw new Error(`${context}: ${safeErrorMessage(result.stderr || result.stdout || result.exitCode)}`);
}
