import fs from 'node:fs';
import path from 'node:path';
import { refinePrd } from '../bin/spawn-refinement-team.js';
import { setupSession } from './setup-session.js';
import { appendHistory } from './session.js';
import { findLastSessionForCwd, getSessionForCwd } from './session-map.js';
import { StateManager } from './state-manager.js';
import { getNextRunnableTicket, summarizeTickets, updateTicketStatus } from './tickets.js';
import { assertTicketVerificationReady } from './verification-env.js';
import { loadConfig } from './config.js';
import { readJsonFile } from './pickle-utils.js';

export function firstMarkdownHeading(content, fallback) {
  const match = content.match(/^#\s+(.+)$/m);
  return (match?.[1] || fallback).trim();
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveBootstrapResumeSessionDir(resumeTarget, cwd = fs.realpathSync(process.cwd())) {
  if (!resumeTarget) {
    return null;
  }
  if (resumeTarget !== '__LAST__') {
    return resumeTarget;
  }
  return getSessionForCwd(cwd) || findLastSessionForCwd(cwd);
}

export function assertBootstrapSessionNotRunning(sessionDir) {
  if (!sessionDir) {
    return;
  }
  const state = readJsonFile(path.join(sessionDir, 'state.json'), null);
  if (isProcessAlive(Number(state?.tmux_runner_pid))) {
    throw new Error(`Session is already running under tmux runner pid ${state.tmux_runner_pid}.`);
  }
}

export function copyPrdIntoSession(sessionDir, prdSource) {
  const destination = path.join(sessionDir, 'prd.md');
  fs.copyFileSync(prdSource, destination);
  return destination;
}

function renderTaskBootstrapPrd(taskPrompt) {
  const normalizedPrompt = String(taskPrompt || '').trim();
  if (!normalizedPrompt) {
    throw new Error('Task prompt is required to materialize a bootstrap PRD.');
  }
  const titleSource = normalizedPrompt.split(/\r?\n/).find((line) => line.trim()) || 'Pipeline Task';
  const title = firstMarkdownHeading(normalizedPrompt, titleSource);
  return `# ${title}\n\n## Summary\n${normalizedPrompt}\n`;
}

export function writeTaskPrdIntoSession(sessionDir, taskPrompt) {
  const destination = path.join(sessionDir, 'prd.md');
  fs.writeFileSync(destination, renderTaskBootstrapPrd(taskPrompt));
  return destination;
}

function buildBootstrapSetupArgs({ taskPrompt, maxTime, workerTimeout }) {
  const args = ['--tmux', '--task', taskPrompt];
  if (maxTime) args.push('--max-time', maxTime);
  if (workerTimeout) args.push('--worker-timeout', workerTimeout);
  return args;
}

export async function createBootstrapSession({
  prdPath = null,
  taskPrompt = null,
  maxTime = null,
  workerTimeout = null,
  cwd = process.cwd(),
} = {}) {
  if (prdPath && taskPrompt) {
    throw new Error('Create a bootstrap session from either a PRD or a task prompt, not both.');
  }
  if (!prdPath && !taskPrompt) {
    throw new Error('A PRD path or task prompt is required to create a bootstrap session.');
  }

  let prdSource = null;
  let effectiveTaskPrompt = String(taskPrompt || '').trim();

  if (prdPath) {
    prdSource = path.resolve(prdPath);
    if (!fs.existsSync(prdSource)) {
      throw new Error(`PRD file not found: ${prdSource}`);
    }
    const prdText = fs.readFileSync(prdSource, 'utf8');
    effectiveTaskPrompt = `Implement PRD: ${firstMarkdownHeading(prdText, path.basename(prdSource))}`;
  }

  const { sessionDir } = await setupSession(
    buildBootstrapSetupArgs({ taskPrompt: effectiveTaskPrompt, maxTime, workerTimeout }),
    { updateSessionMap: false, cwd },
  );

  if (prdSource) {
    copyPrdIntoSession(sessionDir, prdSource);
  } else {
    writeTaskPrdIntoSession(sessionDir, effectiveTaskPrompt);
  }

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

export async function resumeBootstrapSession({
  resume = '__LAST__',
  maxTime = null,
  workerTimeout = null,
  cwd = process.cwd(),
} = {}) {
  const args = resume === '__LAST__'
    ? ['--resume', '--tmux']
    : ['--resume', resume, '--tmux'];
  if (maxTime) args.push('--max-time', maxTime);
  if (workerTimeout) args.push('--worker-timeout', workerTimeout);

  const { sessionDir } = await setupSession(args, { updateSessionMap: false, cwd });

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

export async function materializeBootstrapSession(options = {}) {
  if (options.resume) {
    return resumeBootstrapSession(options);
  }
  return createBootstrapSession(options);
}

export async function ensureBootstrapSessionReady(sessionDir, options = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`Invalid session: missing state.json in ${sessionDir}`);
  }

  const manager = new StateManager();
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

export async function materializeRunnableBootstrapSession(options = {}) {
  const sessionDir = await materializeBootstrapSession(options);
  const ready = await ensureBootstrapSessionReady(sessionDir, {
    resumeReadyOnly: options.resumeReadyOnly,
  });
  return { sessionDir, ...ready };
}

export function recordBootstrapPreflightBlocked(sessionDir, error) {
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

export function enterMuxRunnerPhase(manager, statePath, options = {}) {
  return manager.update(statePath, (state) => {
    state.active = true;
    state.tmux_runner_pid = options.runnerPid || process.pid;
    state.last_exit_reason = null;
    state.cancel_requested_at = null;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    state.worker_pid = null;
    options.markRunStart?.(state);
    appendHistory(state, 'runner_start', state.current_ticket || undefined);
    return state;
  });
}

export function exitMuxRunnerPhase(manager, statePath, {
  exitReason,
  failedTicketId = null,
  deferTerminalState = false,
}) {
  let finalReason = exitReason;
  const state = manager.update(statePath, (current) => {
    finalReason = current.active === false && current.last_exit_reason
      ? current.last_exit_reason
      : exitReason;
    current.active = false;
    current.tmux_runner_pid = null;
    current.worker_pid = null;
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    if (deferTerminalState) {
      return current;
    }
    current.last_exit_reason = finalReason;
    if (finalReason === 'success') {
      current.current_ticket = null;
      current.step = 'complete';
      appendHistory(current, 'complete');
    } else {
      const blocked = finalReason === 'verification-contract-failed' || String(finalReason).startsWith('preflight-');
      current.current_ticket = finalReason === 'error' || blocked
        ? failedTicketId || current.current_ticket || null
        : null;
      current.step = blocked ? 'blocked' : 'paused';
      if (finalReason === 'error') {
        appendHistory(current, 'failed', current.current_ticket || undefined);
      } else if (blocked) {
        appendHistory(current, finalReason, current.current_ticket || undefined);
      } else {
        appendHistory(current, finalReason);
      }
    }
    return current;
  });
  return deferTerminalState ? finalReason : state.last_exit_reason;
}
