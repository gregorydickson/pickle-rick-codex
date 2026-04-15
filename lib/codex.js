import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { safeErrorMessage } from './pickle-utils.js';

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

export function runCodexExec(options) {
  const { command, args } = buildCodexExecInvocation(options);

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.prompt,
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const lastMessage = options.outputLastMessagePath && fs.existsSync(options.outputLastMessagePath)
    ? fs.readFileSync(options.outputLastMessagePath, 'utf8')
    : '';

  return {
    command,
    args,
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: result.signal === 'SIGTERM' || result.signal === 'SIGKILL',
    lastMessage,
    usage: extractUsageFromJson(result.stdout),
  };
}

export async function runCodexExecMonitored(options) {
  const { command, args } = buildCodexExecInvocation(options);
  const stdoutChunks = [];
  const stderrChunks = [];
  const timeoutMs = options.timeoutMs ?? 900_000;
  const successSignalGraceMs = options.successSignalGraceMs ?? 750;
  const successPollMs = options.successPollMs ?? 250;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let successObserved = false;
    let successGraceTimer = null;
    let timeoutTimer = null;
    let pollTimer = null;
    let forcedAfterSuccess = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}) },
    });

    child.stdin.end(options.prompt ?? '');

    const cleanup = () => {
      if (successGraceTimer) clearTimeout(successGraceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
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

    const lastMessage = () =>
      options.outputLastMessagePath && fs.existsSync(options.outputLastMessagePath)
        ? fs.readFileSync(options.outputLastMessagePath, 'utf8')
        : '';

    const currentStdout = () => Buffer.concat(stdoutChunks).toString('utf8');
    const currentStderr = () => Buffer.concat(stderrChunks).toString('utf8');

    const checkForSuccess = () => {
      if (successObserved || typeof options.successCheck !== 'function') return;
      try {
        if (!options.successCheck({
          stdout: currentStdout(),
          stderr: currentStderr(),
          lastMessage: lastMessage(),
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
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, 1_000).unref?.();
        }
      }, successSignalGraceMs);
    };

    timeoutTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 1_000).unref?.();
      }
    }, timeoutMs);

    pollTimer = setInterval(checkForSuccess, successPollMs);

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
      const message = lastMessage();
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      finalize({
        exitCode: successObserved && forcedAfterSuccess ? 0 : code,
        stdout,
        stderr,
        timedOut: successObserved ? false : timedOut,
        lastMessage: message,
        usage: extractUsageFromJson(stdout),
        terminatedAfterSuccess: forcedAfterSuccess,
      });
    });
  });
}

export function assertCodexSucceeded(result, context = 'Codex execution failed') {
  if (result.exitCode === 0) return;
  throw new Error(`${context}: ${safeErrorMessage(result.stderr || result.stdout || result.exitCode)}`);
}
