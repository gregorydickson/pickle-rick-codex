#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refinePrd } from './spawn-refinement-team.js';
import { setupSession } from '../lib/setup-session.js';
import { appendHistory } from '../lib/session.js';
import { getSessionForCwd, removeSessionMapEntry, updateSessionMap } from '../lib/session-map.js';
import { StateManager } from '../lib/state-manager.js';
import { getNextRunnableTicket, summarizeTickets, updateTicketStatus } from '../lib/tickets.js';
import { clearTmuxSession, ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote } from '../lib/tmux.js';
import { assertTicketVerificationReady, isPreflightError } from '../lib/verification-env.js';
import { loadConfig } from '../lib/config.js';

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'retry-once';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function parseArgs(argv) {
  const parsed = {
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

function usage() {
  return [
    'Usage:',
    '  node bin/pickle-tmux.js --prd path/to/prd.md [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-tmux.js --bootstrap-from path/to/prd.md [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-tmux.js --resume [SESSION_DIR] [--resume-ready-only] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
  ].join('\n');
}

function firstMarkdownHeading(content, fallback) {
  const match = content.match(/^#\s+(.+)$/m);
  return (match?.[1] || fallback).trim();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launchLockPath(sessionDir) {
  return path.join(sessionDir, '.tmux-launch.lock');
}

function acquireLaunchLock(sessionDir) {
  const lockPath = launchLockPath(sessionDir);
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      const rawLock = fs.readFileSync(lockPath, 'utf8').trim();
      const lockPid = Number(rawLock);
      if (Number.isInteger(lockPid) && isProcessAlive(lockPid)) {
        throw new Error(`A tmux launch is already in progress for ${sessionDir}.`);
      }
      fs.rmSync(lockPath, { force: true });
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } else {
      throw error;
    }
  }
  fs.writeFileSync(fd, String(process.pid));
  return () => {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close failures during teardown.
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  };
}

function copyPrdIntoSession(sessionDir, prdSource) {
  const destination = path.join(sessionDir, 'prd.md');
  fs.copyFileSync(prdSource, destination);
  return destination;
}

async function createBootstrapSession(parsed) {
  const prdSource = path.resolve(parsed.prdPath);
  if (!fs.existsSync(prdSource)) {
    throw new Error(`PRD file not found: ${prdSource}`);
  }

  const prdText = fs.readFileSync(prdSource, 'utf8');
  const prompt = `Implement PRD: ${firstMarkdownHeading(prdText, path.basename(prdSource))}`;
  const args = ['--tmux', '--task', prompt];
  if (parsed.maxTime) args.push('--max-time', parsed.maxTime);
  if (parsed.workerTimeout) args.push('--worker-timeout', parsed.workerTimeout);

  const { sessionDir } = await setupSession(args, { updateSessionMap: false });
  copyPrdIntoSession(sessionDir, prdSource);

  const manager = new StateManager();
  manager.update(path.join(sessionDir, 'state.json'), (state) => {
    state.tmux_mode = true;
    state.active = false;
    state.max_iterations = 0;
    state.command_template = null;
    state.step = 'refine';
    appendHistory(state, 'tmux_bootstrap');
    return state;
  });

  return sessionDir;
}

async function resumeSession(parsed) {
  const args = parsed.resume === '__LAST__'
    ? ['--resume', '--tmux']
    : ['--resume', parsed.resume, '--tmux'];
  if (parsed.maxTime) args.push('--max-time', parsed.maxTime);
  if (parsed.workerTimeout) args.push('--worker-timeout', parsed.workerTimeout);
  const { sessionDir } = await setupSession(args, { updateSessionMap: false });

  const manager = new StateManager();
  manager.update(path.join(sessionDir, 'state.json'), (state) => {
    state.tmux_mode = true;
    state.active = false;
    state.max_iterations = 0;
    state.command_template = null;
    return state;
  });

  return sessionDir;
}

async function ensureSessionReadyForTmux(sessionDir, options = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`Invalid session: missing state.json in ${sessionDir}`);
  }

  const manager = new StateManager();
  const state = manager.read(statePath);
  const prdPath = path.join(sessionDir, 'prd.md');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

  if (!fs.existsSync(prdPath) && !options.resumeReadyOnly) {
    throw new Error(`Session is not bootstrapped for tmux: missing ${prdPath}. Start with --prd <path>.`);
  }

  if (!fs.existsSync(manifestPath)) {
    if (options.resumeReadyOnly) {
      throw new Error(`Session is not ready to resume: missing ${manifestPath}. Re-run without --resume-ready-only to refine first.`);
    }
    if (!fs.existsSync(prdPath)) {
      throw new Error(`Cannot refine this session because ${prdPath} is missing.`);
    }
    await refinePrd(sessionDir);
  }

  const summary = summarizeTickets(sessionDir);
  if (!summary.total) {
    throw new Error('Session is not runnable: refinement produced zero tickets.');
  }
  if (!summary.runnable.length) {
    throw new Error(`Session has no runnable tickets (done=${summary.done}, blocked=${summary.blocked}, skipped=${summary.skipped}).`);
  }

  const nextTicket = getNextRunnableTicket(sessionDir);
  if (nextTicket) {
    assertTicketVerificationReady({
      ticket: nextTicket,
      config: loadConfig(),
    });
  }

  return { state: manager.read(statePath), summary };
}

function recordPreflightBlocked(sessionDir, error) {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  manager.update(statePath, (current) => {
    current.active = false;
    current.tmux_runner_pid = null;
    current.tmux_session_name = null;
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.current_ticket = error.ticketId || current.current_ticket || null;
    current.step = 'blocked';
    current.last_exit_reason = error.kind;
    appendHistory(current, error.kind, current.current_ticket || undefined);
    return current;
  });
  if (error.ticketId) {
    updateTicketStatus(sessionDir, error.ticketId, {
      status: 'Todo',
      failed_at: new Date().toISOString(),
      failure_reason: error.message,
      failure_kind: error.kind,
    });
  }
}

function assertSessionNotRunning(sessionDir, state) {
  if (isProcessAlive(Number(state.tmux_runner_pid))) {
    throw new Error(`Session is already running under tmux runner pid ${state.tmux_runner_pid}.`);
  }
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log(usage());
    return;
  }

  ensureTmuxAvailable();
  const onFailure = parseFailureMode(argv);
  const parsed = parseArgs(argv);
  const sessionDir = parsed.prdPath
    ? await createBootstrapSession(parsed)
    : await resumeSession(parsed);
  const releaseLock = acquireLaunchLock(sessionDir);
  const runtimeRoot = getRuntimeRoot();
  let previousSessionDir = null;
  try {
    let state;
    let summary;
    try {
      ({ state, summary } = await ensureSessionReadyForTmux(sessionDir, { resumeReadyOnly: parsed.resumeReadyOnly }));
    } catch (error) {
      if (isPreflightError(error)) {
        recordPreflightBlocked(sessionDir, error);
      }
      throw error;
    }
    assertSessionNotRunning(sessionDir, state);
    previousSessionDir = getSessionForCwd(state.working_dir);
    await updateSessionMap(state.working_dir, sessionDir);
    const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');

    const manager = new StateManager();
    const statePath = path.join(sessionDir, 'state.json');
    let launchStarted = false;
    manager.update(statePath, (current) => {
      current.tmux_mode = true;
      current.active = false;
      current.max_iterations = 0;
      current.tmux_session_name = sessionName;
      current.last_exit_reason = null;
      appendHistory(current, 'tmux_launch_requested');
      return current;
    });

    try {
      clearTmuxSession(sessionName);
      runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir]);
      launchStarted = true;
      runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

      const runnerCommand = [
        'node',
        shellQuote(path.join(runtimeRoot, 'bin', 'mux-runner.js')),
        shellQuote(sessionDir),
        `--on-failure=${onFailure}`,
        ';',
        'echo',
        shellQuote(''),
        ';',
        'echo',
        shellQuote('Runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
        ';',
        'read',
      ].join(' ');

      runTmux(['send-keys', '-t', `${sessionName}:0`, runnerCommand, 'Enter']);
      const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, 'pickle'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: process.env,
      });
      if (monitorResult.status !== 0) {
        throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
      }
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
          await updateSessionMap(state.working_dir, previousSessionDir);
        } else {
          await removeSessionMapEntry(state.working_dir, sessionDir);
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
      `Runner Log: ${path.join(sessionDir, 'mux-runner.log')}`,
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
