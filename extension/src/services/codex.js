import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { safeErrorMessage } from './pickle-utils.js';

export function hasPromiseToken(text, token) {
  return new RegExp(`<promise>\\s*${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/promise>`).test(String(text || ''));
}

function extractUsageFromJson(stdout) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = parsed.usage || parsed.response?.usage || parsed.result?.usage || null;
      if (!candidate || typeof candidate !== 'object') continue;
      usage.input_tokens += Number(candidate.input_tokens || 0);
      usage.output_tokens += Number(candidate.output_tokens || 0);
      usage.cache_creation_input_tokens += Number(candidate.cache_creation_input_tokens || 0);
      usage.cache_read_input_tokens += Number(candidate.cache_read_input_tokens || 0);
    } catch {
      // Ignore non-JSON or unknown events.
    }
  }

  return usage;
}

function removeStaleOutputs(paths = []) {
  for (const filePath of new Set(paths.filter(Boolean))) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

function readLastMessage(filePath) {
  return filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
}

function terminateProcessTree(child, signal) {
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
  successCheck,
  successSignalGraceMs = 750,
  successPollMs = 250,
  cleanupPaths = [],
  onSpawn,
  cancelCheck,
}) {
  removeStaleOutputs([...cleanupPaths, outputLastMessagePath]);

  const stdoutChunks = [];
  const stderrChunks = [];

  return await new Promise((resolve, reject) => {
    let settled = false;
    let successObserved = false;
    let successGraceTimer = null;
    let timeoutTimer = null;
    let pollTimer = null;
    let cancelTimer = null;
    let forcedAfterSuccess = false;
    let forcedByCancel = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
    });

    onSpawn?.(child);
    child.stdin.end(input ?? '');

    const cleanup = () => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (cancelTimer) clearInterval(cancelTimer);
    };

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        command,
        args,
        ...result,
      });
    };

    const currentStdout = () => Buffer.concat(stdoutChunks).toString('utf8');
    const currentStderr = () => Buffer.concat(stderrChunks).toString('utf8');

    const scheduleTermination = (signal, followupSignal = null, delayMs = 1_000) => {
      terminateProcessTree(child, signal);
      if (!followupSignal) return;
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateProcessTree(child, followupSignal);
        }
      }, delayMs).unref?.();
    };

    const checkForSuccess = () => {
      if (successObserved || typeof successCheck !== 'function') return;
      try {
        if (!successCheck({
          stdout: currentStdout(),
          stderr: currentStderr(),
          lastMessage: readLastMessage(outputLastMessagePath),
        })) {
          return;
        }
      } catch {
        return;
      }

      successObserved = true;
      successGraceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          forcedAfterSuccess = true;
          scheduleTermination('SIGTERM', 'SIGKILL');
        }
      }, successSignalGraceMs);
    };

    timeoutTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
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

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      checkForSuccess();
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      checkForSuccess();
    });

    child.on('error', (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });

    child.on('close', (code, signal) => {
      const stdout = currentStdout();
      const stderr = currentStderr();
      const message = readLastMessage(outputLastMessagePath);
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      finalize({
        exitCode: forcedByCancel
          ? 130
          : successObserved
            ? 0
            : (code ?? (signal ? 1 : 0)),
        stdout,
        stderr,
        timedOut: successObserved || forcedByCancel ? false : timedOut,
        lastMessage: message,
        usage: extractUsageFromJson(stdout),
        terminatedAfterSuccess: forcedAfterSuccess,
        cancelled: forcedByCancel,
      });
    });
  });
}

export function getCodexVersion() {
  const config = loadConfig();
  const result = spawnSync(config.runtime.command, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to determine Codex version');
  }
  return result.stdout.trim();
}

function buildCodexExecInvocation(options) {
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
    args.push('--model', options.model || config.runtime.model);
  }
  if (config.runtime.json_output !== false || options.json) {
    args.push('--json');
  }

  const addDirs = [...(config.runtime.add_dirs || []), ...(options.addDirs || [])];
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }

  if (options.outputLastMessagePath) {
    args.push('--output-last-message', options.outputLastMessagePath);
  }

  args.push('-');

  return { command, args };
}

export async function runCommand(options) {
  return await runSpawnedCommand(options);
}

export async function runCodexExec(options) {
  const { command, args } = buildCodexExecInvocation(options);
  return await runSpawnedCommand({
    command,
    args,
    cwd: options.cwd,
    input: options.prompt,
    timeoutMs: options.timeoutMs,
    env: options.env,
    outputLastMessagePath: options.outputLastMessagePath,
    cleanupPaths: options.cleanupPaths,
    onSpawn: options.onSpawn,
    cancelCheck: options.cancelCheck,
  });
}

export async function runCodexExecMonitored(options) {
  const { command, args } = buildCodexExecInvocation(options);
  return await runSpawnedCommand({
    command,
    args,
    cwd: options.cwd,
    input: options.prompt,
    timeoutMs: options.timeoutMs,
    env: options.env,
    outputLastMessagePath: options.outputLastMessagePath,
    successCheck: options.successCheck,
    successSignalGraceMs: options.successSignalGraceMs,
    successPollMs: options.successPollMs,
    cleanupPaths: options.cleanupPaths,
    onSpawn: options.onSpawn,
    cancelCheck: options.cancelCheck,
  });
}

export function assertCodexSucceeded(result, context = 'Codex execution failed') {
  if (result.exitCode === 0) return;
  throw new Error(`${context}: ${safeErrorMessage(result.stderr || result.stdout || result.exitCode)}`);
}
