import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function getRuntimeRoot() {
  return path.resolve(new URL('..', import.meta.url).pathname);
}

export function ensureTmuxAvailable() {
  const result = spawnSync('tmux', ['-V'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error('tmux is required. Install it with `brew install tmux` or your package manager.');
  }
  return (result.stdout || result.stderr || '').trim();
}

export function tmuxSessionExists(sessionName, options = {}) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  return result.status === 0;
}

export function clearTmuxSession(sessionName, options = {}) {
  if (!tmuxSessionExists(sessionName, options)) return false;
  runTmux(['kill-session', '-t', sessionName], options);
  return true;
}

export function runTmux(args, options = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `tmux ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function runnerStarted(state, sessionName) {
  return state?.active === true
    && state?.tmux_session_name === sessionName
    && Number.isInteger(state?.tmux_runner_pid)
    && state.tmux_runner_pid > 0;
}

export async function waitForTmuxRunnerStart(sessionDir, sessionName, mode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const existingLogSizeBytes = options.existingLogSizeBytes ?? 0;
  const runnerLogName = mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log';
  const runnerLogMarker = mode === 'pickle' ? 'mux-runner started' : 'loop-runner started';
  const statePath = path.join(sessionDir, 'state.json');
  const runnerLogPath = path.join(sessionDir, runnerLogName);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (runnerStarted(readJson(statePath), sessionName)) {
      return;
    }
    if (fs.existsSync(runnerLogPath)) {
      const runnerLog = fs.readFileSync(runnerLogPath);
      const freshRunnerLog = runnerLog.subarray(Math.min(existingLogSizeBytes, runnerLog.length)).toString('utf8');
      if (freshRunnerLog.includes(runnerLogMarker)) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`tmux runner did not start for ${sessionName}`);
}
