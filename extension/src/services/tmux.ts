import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './pickle-utils.js';

export interface TmuxCallOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface TmuxRunnerBinding {
  schema_version: 1;
  session_name: string;
  session_id: string;
  session_created: string;
  pane_id: string;
  pane_pid: number;
  pane_start_command: string;
}

export function runnerPaneCommandMatches(command: string, sessionDir: string): boolean {
  const sessionAliases = [...new Set([path.resolve(sessionDir), fs.realpathSync(sessionDir)])];
  return sessionAliases.some((candidate) => command.includes(candidate))
    && /(?:supervised-runner|mux-runner|pipeline-runner|loop-runner)\.js(?:\s|['"]|$)/.test(command);
}

export function readTmuxRunnerBinding(target: string, options: TmuxCallOptions = {}): TmuxRunnerBinding | null {
  try {
    const raw = runTmux(['display-message', '-p', '-t', target,
      '#{session_name}\t#{session_id}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_start_command}'], options);
    const [sessionName, sessionId, created, paneId, rawPid, ...command] = raw.split('\t');
    const panePid = Number(rawPid);
    if (!sessionName || !sessionId || !created || !paneId || !Number.isInteger(panePid) || panePid <= 0) return null;
    return { schema_version: 1, session_name: sessionName, session_id: sessionId, session_created: created,
      pane_id: paneId, pane_pid: panePid, pane_start_command: command.join('\t') };
  } catch {
    return null;
  }
}

export function captureOwnedTmuxRunnerBinding(
  sessionName: string,
  sessionDir: string,
  options: TmuxCallOptions = {},
): TmuxRunnerBinding {
  assertOwnedTmuxSession(sessionName, sessionDir);
  const binding = readTmuxRunnerBinding(`${sessionName}:0`, options);
  if (!binding || binding.session_name !== sessionName || !runnerPaneCommandMatches(binding.pane_start_command, sessionDir)) {
    throw new Error('tmux runner pane does not match the exact session controller command.');
  }
  return binding;
}

export function killTmuxSessionById(sessionId: string, options: TmuxCallOptions = {}): void {
  if (!/^\$\d+$/.test(sessionId)) throw new Error('Refusing invalid immutable tmux session id.');
  runTmux(['kill-session', '-t', sessionId], options);
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
  runner_starting?: boolean;
  tmux_session_name?: string;
  tmux_runner_pid?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runnerStarted(state: RunnerStartedState | null, sessionName: string): boolean {
  const runnerPid = Number(state?.tmux_runner_pid);
  return Boolean(
    (state?.active === true || state?.runner_starting === true)
      && state?.tmux_session_name === sessionName
      && Number.isInteger(runnerPid)
      && runnerPid > 0
      && processAlive(runnerPid),
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
  _mode: string,
  options: WaitForTmuxRunnerStartOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const statePath = path.join(sessionDir, 'state.json');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (runnerStarted(readJsonFile<RunnerStartedState>(statePath), sessionName)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`tmux runner did not start for ${sessionName}`);
}
