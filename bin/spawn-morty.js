#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../lib/activity-logger.js';
import { assertCodexSucceeded, runCodexExecMonitored } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { recordIteration } from '../lib/circuit-breaker.js';
import { getWorkingTreeFingerprint } from '../lib/git-utils.js';
import { buildTicketPhasePrompt } from '../lib/prompts.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { normalizeTicketId, readManifest, updateTicketStatus } from '../lib/tickets.js';
import { assertTicketVerificationReady, isPreflightError } from '../lib/verification-env.js';

function splitVerificationCommands(ticket) {
  if (Array.isArray(ticket.verification)) return ticket.verification;
  if (typeof ticket.verify === 'string' && ticket.verify.trim()) {
    return ticket.verify.split('&&').map((item) => item.trim()).filter(Boolean);
  }
  return ['npm test'];
}

class CancellationError extends Error {
  constructor(message = 'Session cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

function readCurrentState(manager, statePath) {
  return manager.read(statePath);
}

function isSessionCancelled(manager, statePath) {
  return readCurrentState(manager, statePath).active === false;
}

function updateActiveChild(statePath, manager, fields) {
  manager.update(statePath, (current) => {
    Object.assign(current, fields);
    return current;
  });
}

function terminateChild(child, signal) {
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

async function runVerificationCommand({ command, cwd, timeoutMs, manager, statePath, env }) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer = null;
    let cancelTimer = null;
    let forcedByCancel = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32',
    });

    updateActiveChild(statePath, manager, {
      active_child_pid: child.pid,
      active_child_kind: 'verification',
      active_child_command: command,
    });

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      updateActiveChild(statePath, manager, {
        active_child_pid: null,
        active_child_kind: null,
        active_child_command: null,
      });
    };

    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    timeoutTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateChild(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateChild(child, 'SIGKILL');
          }
        }, 1_000).unref?.();
      }
    }, timeoutMs);

    cancelTimer = setInterval(() => {
      if (!isSessionCancelled(manager, statePath)) return;
      if (child.exitCode === null && child.signalCode === null) {
        forcedByCancel = true;
        terminateChild(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateChild(child, 'SIGKILL');
          }
        }, 1_000).unref?.();
      }
    }, 100);

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => settle(reject, error));
    child.on('close', (code) => {
      if (forcedByCancel || isSessionCancelled(manager, statePath)) {
        settle(reject, new CancellationError());
        return;
      }
      if (code !== 0) {
        const output = Buffer.concat(stderrChunks).toString('utf8') || Buffer.concat(stdoutChunks).toString('utf8');
        settle(reject, new Error(`verification-command-failed: ${output || command}`));
        return;
      }
      settle(resolve, undefined);
    });
  });
}

export async function runTicket(sessionDir, ticketId, options = {}) {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const manifest = readManifest(sessionDir);
  const normalizedTicketId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  const manifestTicket = manifest.tickets.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === normalizedTicketId);
  if (!manifestTicket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }

  const config = loadConfig();
  const workingDir = state.working_dir;
  let verificationReady = null;
  let baselineFingerprint = '';
  const phases = ['research', 'plan', 'implement', 'review', 'simplify'];

  try {
    verificationReady = assertTicketVerificationReady({
      ticket: manifestTicket,
      config,
    });
    baselineFingerprint = getWorkingTreeFingerprint(workingDir);
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'In Progress',
      started_at: new Date().toISOString(),
      failure_reason: null,
      failure_kind: null,
      failed_at: null,
    });
    updateActiveChild(statePath, manager, {
      worker_pid: process.pid,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });

    for (const phase of phases) {
      if (isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      manager.update(statePath, (current) => {
        current.current_ticket = normalizedTicketId;
        current.step = phase;
        current.iteration += 1;
        appendHistory(current, phase, normalizedTicketId);
        return current;
      });

      const result = await runCodexExecMonitored({
        cwd: workingDir,
        prompt: buildTicketPhasePrompt({
          phase,
          ticket: {
            ...manifestTicket,
            verificationContract: verificationReady.contract,
          },
          sessionDir,
          workingDir,
        }),
        timeoutMs: options.timeoutMs || config.defaults.worker_timeout_seconds * 1000,
        outputLastMessagePath: path.join(sessionDir, `${normalizedTicketId}.${phase}.last-message.txt`),
        addDirs: [sessionDir],
        onSpawn: (child) => {
          updateActiveChild(statePath, manager, {
            active_child_pid: child.pid,
            active_child_kind: 'codex',
            active_child_command: phase,
          });
        },
        cancelCheck: () => isSessionCancelled(manager, statePath),
      });
      updateActiveChild(statePath, manager, {
        active_child_pid: null,
        active_child_kind: null,
        active_child_command: null,
      });
      if (result.cancelled || isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      assertCodexSucceeded(result, `Ticket ${normalizedTicketId} failed in ${phase}`);
      recordIteration(sessionDir, manager.read(statePath));
    }

    for (const command of splitVerificationCommands(manifestTicket)) {
      if (isSessionCancelled(manager, statePath)) {
        throw new CancellationError();
      }
      await runVerificationCommand({
        command,
        cwd: workingDir,
        timeoutMs: config.defaults.worker_timeout_seconds * 1000,
        manager,
        statePath,
        env: verificationReady.env,
      });
    }

    if (getWorkingTreeFingerprint(workingDir) === baselineFingerprint) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Done',
        completed_at: new Date().toISOString(),
        failure_reason: null,
        failure_kind: null,
        failed_at: null,
      });
      return { status: 'done', applied: false, reason: 'No diff generated.' };
    }
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Done',
      completed_at: new Date().toISOString(),
      failure_reason: null,
      failure_kind: null,
      failed_at: null,
    });
    manager.update(statePath, (current) => {
      current.step = 'done';
      appendHistory(current, 'done', normalizedTicketId);
      return current;
    });

    logActivity({
      event: 'ticket_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket: normalizedTicketId,
    }, { enabled: config.defaults.activity_logging });

    return { status: 'done', applied: true };
  } catch (error) {
    if (error instanceof CancellationError) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Todo',
        cancelled_at: new Date().toISOString(),
      });
      throw error;
    }
    if (isPreflightError(error)) {
      updateTicketStatus(sessionDir, normalizedTicketId, {
        status: 'Todo',
        failed_at: new Date().toISOString(),
        failure_reason: error.message,
        failure_kind: error.kind,
      });
      recordIteration(sessionDir, manager.read(statePath), {
        error: error.message,
      });
      throw error;
    }
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Blocked',
      failed_at: new Date().toISOString(),
      failure_reason: error instanceof Error ? error.message : String(error),
      failure_kind: 'command_failed',
    });
    recordIteration(sessionDir, manager.read(statePath), {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    updateActiveChild(statePath, manager, {
      worker_pid: null,
      active_child_pid: null,
      active_child_kind: null,
      active_child_command: null,
    });
  }
}

async function main(argv) {
  const [sessionDir, ticketId] = argv;
  if (!sessionDir || !ticketId) {
    throw new Error('Usage: node bin/spawn-morty.js <session-dir> <ticket-id>');
  }
  const result = await runTicket(sessionDir, ticketId);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
