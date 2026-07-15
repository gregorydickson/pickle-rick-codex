#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLaunchLock } from '../services/detached-launch.js';
import { appendHistory } from '../services/session.js';
import { getSessionForCwd, removeSessionMapEntry, updateSessionMap } from '../services/session-map.js';
import {
  assertBootstrapSessionNotRunning,
  ensureBootstrapSessionReady,
  isProcessAlive,
  materializeBootstrapSession,
  recordBootstrapPreflightBlocked,
  resolveBootstrapResumeSessionDir,
} from '../services/pipeline-bootstrap.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import { clearTmuxSession, ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote, waitForTmuxRunnerStart } from '../services/tmux.js';
import { isPreflightError, type PreflightError } from '../services/verification-env.js';
import type { TicketSummary } from '../services/tickets.js';

interface PickleTmuxArgs {
  resume: string | null;
  prdPath: string | null;
  resumeReadyOnly: boolean;
  maxTime: string | null;
  workerTimeout: string | null;
}

function parseFailureMode(argv: string[]): string {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'retry-once';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function parseArgs(argv: string[]): PickleTmuxArgs {
  const parsed: PickleTmuxArgs = {
    resume: null,
    prdPath: null,
    resumeReadyOnly: false,
    maxTime: null,
    workerTimeout: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--resume') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        parsed.resume = next;
        index += 1;
      } else {
        parsed.resume = '__LAST__';
      }
    } else if (arg === '--prd' || arg === '--bootstrap-from') {
      parsed.prdPath = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--resume-ready-only') {
      parsed.resumeReadyOnly = true;
    } else if (arg === '--max-time') {
      parsed.maxTime = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--worker-timeout') {
      parsed.workerTimeout = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--help' || arg.startsWith('--on-failure=')) {
      continue;
    } else if (arg === '--max-iterations') {
      throw new Error('pickle-tmux no longer supports --max-iterations. Detached tmux runs are unbounded in this POC.');
    } else if (!arg.startsWith('--')) {
      throw new Error('pickle-tmux now requires either --prd <path> or --resume [session-dir].');
    }
  }

  if (parsed.prdPath && parsed.resume) {
    throw new Error('Use either --prd/--bootstrap-from or --resume, not both.');
  }
  if (!parsed.prdPath && !parsed.resume) {
    throw new Error('Usage requires either --prd <path> to bootstrap from a PRD or --resume [session-dir] to relaunch an existing session.');
  }
  return parsed;
}

function usage(): string {
  return [
    'Usage:',
    '  node bin/pickle-tmux.js --prd path/to/prd.md [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-tmux.js --bootstrap-from path/to/prd.md [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-tmux.js --resume [SESSION_DIR] [--resume-ready-only] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
  ].join('\n');
}

function markAbruptRunnerLossBeforeResume(sessionDir: string | null, manager: StateManager = new StateManager()): void {
  if (!sessionDir) {
    return;
  }
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const runnerPid = Number(state.tmux_runner_pid);
  if (state.active !== true || !Number.isInteger(runnerPid) || runnerPid <= 0 || isProcessAlive(runnerPid)) {
    return;
  }

  manager.update(statePath, (current) => {
    current.active = false;
    current.tmux_runner_pid = null;
    current.tmux_session_name = null;
    current.worker_pid = null;
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.last_exit_reason = 'runner_lost';
    current.step = 'paused';
    appendHistory(current, 'runner_lost', current.current_ticket || undefined);
    return current;
  });
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log(usage());
    return;
  }

  ensureTmuxAvailable();
  const onFailure = parseFailureMode(argv);
  const parsed = parseArgs(argv);
  const resumeSessionDir = resolveBootstrapResumeSessionDir(parsed.resume);
  if (parsed.resume) {
    if (!resumeSessionDir) {
      throw new Error('No session found to resume.');
    }
    markAbruptRunnerLossBeforeResume(resumeSessionDir);
  }
  assertBootstrapSessionNotRunning(resumeSessionDir);
  const sessionDir = await materializeBootstrapSession({
    prdPath: parsed.prdPath,
    resume: parsed.resume ?? undefined,
    maxTime: parsed.maxTime,
    workerTimeout: parsed.workerTimeout,
  });
  const releaseLock = acquireLaunchLock(sessionDir);
  const runtimeRoot = getRuntimeRoot();
  let previousSessionDir: string | null;
  try {
    let state: PersistedState;
    let summary: TicketSummary;
    try {
      ({ state, summary } = await ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: parsed.resumeReadyOnly }));
    } catch (error) {
      if (isPreflightError(error)) {
        recordBootstrapPreflightBlocked(sessionDir, error as PreflightError);
      }
      throw error;
    }
    assertBootstrapSessionNotRunning(sessionDir);
    previousSessionDir = getSessionForCwd(state.working_dir as string);
    await updateSessionMap(state.working_dir as string, sessionDir);
    const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const runnerDescriptor = getRunnerDescriptor('pickle');

    const manager = new StateManager();
    const statePath = path.join(sessionDir, 'state.json');
    const runnerLogPath = path.join(sessionDir, runnerDescriptor.runnerLog);
    const existingLogSizeBytes = fs.existsSync(runnerLogPath) ? fs.statSync(runnerLogPath).size : 0;
    let launchStarted = false;
    manager.update(statePath, (current) => {
      current.tmux_mode = true;
      current.active = false;
      current.max_iterations = 0;
      current.tmux_runner_pid = null;
      current.tmux_session_name = sessionName;
      current.last_exit_reason = null;
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.worker_pid = null;
      appendHistory(current, 'tmux_launch_requested');
      return current;
    });

    try {
      clearTmuxSession(sessionName);
      runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir as string]);
      launchStarted = true;
      runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

      const runnerCommand = [
        'node',
        shellQuote(path.join(runtimeRoot, 'bin', runnerDescriptor.runnerBin)),
        shellQuote(sessionDir),
        `--on-failure=${onFailure}`,
        ';',
        'status=$?',
        ';',
        'echo',
        shellQuote(''),
        ';',
        'echo',
        shellQuote('Runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
        ';',
        'exit',
        '$status',
      ].join(' ');

      runTmux(['set-option', '-w', '-t', `${sessionName}:0`, 'remain-on-exit', 'on']);
      runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0`, `bash -lc ${shellQuote(runnerCommand)}`]);
      const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, runnerDescriptor.monitorMode], {
        encoding: 'utf8',
        timeout: 30_000,
        env: process.env,
      });
      if (monitorResult.status !== 0) {
        throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
      }
      await waitForTmuxRunnerStart(sessionDir, sessionName, runnerDescriptor.mode, { existingLogSizeBytes });
    } catch (error) {
      if (launchStarted) {
        try {
          runTmux(['kill-session', '-t', sessionName]);
        } catch {
          // Best-effort cleanup for partially created tmux sessions.
        }
      }
      manager.update(statePath, (current) => {
        current.active = false;
        current.tmux_runner_pid = null;
        current.tmux_session_name = null;
        current.worker_pid = null;
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.last_exit_reason = 'launch_failed';
        appendHistory(current, 'tmux_launch_failed', current.current_ticket || undefined);
        return current;
      });
      try {
        if (previousSessionDir) {
          await updateSessionMap(state.working_dir as string, previousSessionDir);
        } else {
          await removeSessionMapEntry(state.working_dir as string, sessionDir);
        }
      } catch {
        // Best-effort map rollback for failed tmux launches.
      }
      throw error;
    }

    console.log([
      'Pickle Rick tmux mode launched.',
      `Session: ${sessionName}`,
      `Attach: tmux attach -t ${sessionName}`,
      'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
      `Runnable Tickets: ${summary.runnable.length} (done=${summary.done} blocked=${summary.blocked} skipped=${summary.skipped})`,
      `Cancel: node ${path.join(runtimeRoot, 'bin', 'cancel.js')} --session-dir ${sessionDir}`,
      `State: ${path.join(sessionDir, 'state.json')}`,
      `Runner Log: ${path.join(sessionDir, runnerDescriptor.runnerLog)}`,
    ].join('\n'));
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
