import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getRunnerDescriptor, type NormalizedRunnerDescriptor } from './runner-descriptors.js';
import { readJsonFile } from './pickle-utils.js';

export interface TmuxCallOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Trailing `-`-delimited segment: the session hash both names are keyed by. */
export function sessionHashOf(name: string): string {
  return name.slice(name.lastIndexOf('-') + 1);
}

/**
 * We may only drive the tmux session that hosts THIS session's monitor window.
 * `#S` answers "which tmux session is this PROCESS in" — the right answer only
 * when the runner was launched inside the session it manages. A runner that
 * inherits `$TMUX` from somewhere else would otherwise send-keys its pane
 * commands into a stranger's live pane.
 *
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir
 * they manage, so the two hashes agree exactly when the window is ours. Fail
 * CLOSED: a name we cannot tie to our own session dir is not ours to drive.
 * Ownership is derived from the pair alone — never resolved against the data
 * root — so it holds for a runner whose data root lacks the ambient session.
 */
export function isForeignTmuxSession(sessionName: string, sessionDir: string): boolean {
  return sessionHashOf(sessionName) !== sessionHashOf(path.basename(sessionDir));
}

export function assertOwnedTmuxSession(sessionName: string, sessionDir: string): void {
  if (isForeignTmuxSession(sessionName, sessionDir)) {
    throw new Error(`Refusing to mutate foreign tmux session ${sessionName}`);
  }
}

export function getRuntimeRoot(): string {
  return path.resolve(new URL('..', import.meta.url).pathname);
}

export function ensureTmuxAvailable(): string {
  const result = spawnSync('tmux', ['-V'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error('tmux is required. Install it with `brew install tmux` or your package manager.');
  }
  return (result.stdout || result.stderr || '').trim();
}

export function tmuxSessionExists(sessionName: string, options: TmuxCallOptions = {}): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  return result.status === 0;
}

export function killTmuxSession(sessionName: string, sessionDir: string, options: TmuxCallOptions = {}): void {
  assertOwnedTmuxSession(sessionName, sessionDir);
  runTmux(['kill-session', '-t', sessionName], options);
}

export function respawnOwnedTmuxPane(
  sessionName: string,
  sessionDir: string,
  paneTarget: string,
  command: string,
  options: TmuxCallOptions = {},
): void {
  assertOwnedTmuxSession(sessionName, sessionDir);
  runTmux(['respawn-pane', '-k', '-t', paneTarget, command], options);
}

export function clearTmuxSession(sessionName: string, sessionDir: string, options: TmuxCallOptions = {}): boolean {
  assertOwnedTmuxSession(sessionName, sessionDir);
  if (!tmuxSessionExists(sessionName, options)) return false;
  killTmuxSession(sessionName, sessionDir, options);
  return true;
}

export function runTmux(args: string[], options: TmuxCallOptions = {}): string {
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

interface RunnerStartedState {
  active?: boolean;
  tmux_session_name?: string;
  tmux_runner_pid?: number;
}

function runnerStarted(state: RunnerStartedState | null, sessionName: string): boolean {
  return Boolean(
    state?.active === true
      && state?.tmux_session_name === sessionName
      && Number.isInteger(state?.tmux_runner_pid)
      && (state?.tmux_runner_pid ?? 0) > 0,
  );
}

export interface WaitForTmuxRunnerStartOptions {
  timeoutMs?: number;
  intervalMs?: number;
  existingLogSizeBytes?: number;
}

export async function waitForTmuxRunnerStart(
  sessionDir: string,
  sessionName: string,
  mode: string,
  options: WaitForTmuxRunnerStartOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const existingLogSizeBytes = options.existingLogSizeBytes ?? 0;
  const descriptor: NormalizedRunnerDescriptor = getRunnerDescriptor(mode);
  const statePath = path.join(sessionDir, 'state.json');
  const runnerLogPath = path.join(sessionDir, descriptor.runnerLog);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (runnerStarted(readJsonFile<RunnerStartedState>(statePath), sessionName)) {
      return;
    }
    if (fs.existsSync(runnerLogPath)) {
      const runnerLog = fs.readFileSync(runnerLogPath);
      const freshRunnerLog = runnerLog.subarray(Math.min(existingLogSizeBytes, runnerLog.length)).toString('utf8');
      if (freshRunnerLog.includes(descriptor.runnerStartMarker)) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`tmux runner did not start for ${sessionName}`);
}
