#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { appendHistory, getRunStartEpoch, markRunStart } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import {
  areTicketDependenciesSatisfied,
  listTickets,
  summarizeTickets,
  unresolvedTicketDependencies,
  updateTicketStatus,
} from '../lib/tickets.js';
import { isPreflightError } from '../lib/verification-env.js';
import { runTicket } from './spawn-morty.js';

function appendRunnerLog(sessionDir, message) {
  const filePath = path.join(sessionDir, 'mux-runner.log');
  fs.appendFileSync(filePath, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'abort';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function shouldStop(state) {
  if (state.active === false) {
    return state.last_exit_reason || 'cancelled';
  }
  if (Number.isInteger(state.max_iterations) && state.max_iterations > 0 && state.iteration >= state.max_iterations) {
    return 'max_iterations';
  }
  if (Number.isFinite(state.max_time_minutes) && state.max_time_minutes > 0) {
    const elapsedMinutes = (Date.now() / 1000 - getRunStartEpoch(state)) / 60;
    if (elapsedMinutes >= state.max_time_minutes) {
      return 'max_time';
    }
  }
  return null;
}

export async function runSequential(sessionDir, options = {}) {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const failureMode = options.onFailure || 'abort';
  const config = loadConfig();
  let exitReason = 'success';
  let failedTicketId = null;

  appendRunnerLog(sessionDir, 'mux-runner started');
  manager.update(statePath, (state) => {
    state.active = true;
    state.tmux_runner_pid = process.pid;
    state.last_exit_reason = null;
    state.cancel_requested_at = null;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    state.worker_pid = null;
    markRunStart(state);
    appendHistory(state, 'runner_start', state.current_ticket || undefined);
    return state;
  });

  const summary = summarizeTickets(sessionDir);
  if (!summary.total) {
    exitReason = 'no_tickets';
    appendRunnerLog(sessionDir, 'no tickets found in refinement manifest');
  } else if (!summary.runnable.length) {
    exitReason = 'no_tickets';
    appendRunnerLog(
      sessionDir,
      `no runnable tickets found (done=${summary.done} blocked=${summary.blocked} skipped=${summary.skipped})`,
    );
  }

  const executionTickets = listTickets(sessionDir);
  for (const ticket of executionTickets.length ? executionTickets : summary.tickets) {
    if (exitReason !== 'success') break;
    if (ticket.status === 'Done' || ticket.status === 'Skipped' || ticket.status === 'Blocked') continue;

    const ticketStopReason = shouldStop(manager.read(statePath));
    if (ticketStopReason) {
      exitReason = ticketStopReason;
      appendRunnerLog(sessionDir, `stopping before ticket ${ticket.id}: ${ticketStopReason}`);
      break;
    }

    const currentTickets = listTickets(sessionDir);
    const currentTicket = currentTickets.find((entry) => entry.id === ticket.id) || ticket;
    if (!areTicketDependenciesSatisfied(currentTicket, currentTickets)) {
      const unresolved = unresolvedTicketDependencies(currentTicket, currentTickets);
      failedTicketId = ticket.id;
      exitReason = 'error';
      updateTicketStatus(sessionDir, ticket.id, {
        status: 'Blocked',
        failed_at: new Date().toISOString(),
        failure_reason: `Unresolved dependencies: ${unresolved.join(', ')}`,
      });
      appendRunnerLog(sessionDir, `blocking ticket ${ticket.id}: unresolved dependencies ${unresolved.join(', ')}`);
      break;
    }

    let attempts = 0;
    const maxAttempts = failureMode === 'retry-once' ? 2 : 1;

    while (attempts < maxAttempts) {
      const latestState = manager.read(statePath);
      const stopReason = shouldStop(latestState);
      if (stopReason) {
        exitReason = stopReason;
        appendRunnerLog(sessionDir, `stopping during ticket ${ticket.id}: ${stopReason}`);
        break;
      }

      attempts += 1;
      try {
        appendRunnerLog(sessionDir, `starting ticket ${ticket.id} attempt ${attempts}/${maxAttempts}`);
        await runTicket(sessionDir, ticket.id, options);
        ticket.status = 'Done';
        appendRunnerLog(sessionDir, `completed ticket ${ticket.id}`);
        break;
      } catch (error) {
        const cancelled = manager.read(statePath).active === false;
        if (cancelled) {
          exitReason = manager.read(statePath).last_exit_reason || 'cancelled';
          appendRunnerLog(sessionDir, `ticket ${ticket.id} stopped: ${exitReason}`);
          break;
        }
        if (isPreflightError(error)) {
          failedTicketId = ticket.id;
          exitReason = error.kind;
          appendRunnerLog(sessionDir, `ticket ${ticket.id} preflight blocked: ${error.message}`);
          break;
        }
        appendRunnerLog(sessionDir, `ticket ${ticket.id} failed on attempt ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
        if (attempts < maxAttempts) {
          const retryStopReason = shouldStop(manager.read(statePath));
          if (retryStopReason === 'max_time' || retryStopReason === 'max_iterations') {
            failedTicketId = ticket.id;
            exitReason = 'error';
            appendRunnerLog(sessionDir, `not retrying ${ticket.id}: ${retryStopReason} would mask the current failure`);
            appendRunnerLog(sessionDir, `mux-runner aborting on ${ticket.id}`);
            break;
          }
          continue;
        }
        if (failureMode === 'skip') {
          ticket.status = 'Skipped';
          updateTicketStatus(sessionDir, ticket.id, { status: 'Skipped', skipped_at: new Date().toISOString() });
          appendRunnerLog(sessionDir, `skipping ticket ${ticket.id}`);
          break;
        }
        failedTicketId = ticket.id;
        exitReason = 'error';
        appendRunnerLog(sessionDir, `mux-runner aborting on ${ticket.id}`);
        break;
      }
    }

    if (exitReason !== 'success') {
      break;
    }
  }

  manager.update(statePath, (state) => {
    const finalReason = state.active === false && state.last_exit_reason
      ? state.last_exit_reason
      : exitReason;
    state.active = false;
    state.tmux_runner_pid = null;
    state.worker_pid = null;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    state.last_exit_reason = finalReason;
    if (finalReason === 'success') {
      state.current_ticket = null;
      state.step = 'complete';
      appendHistory(state, 'complete');
    } else {
      state.current_ticket = finalReason === 'error' || String(finalReason).startsWith('preflight-')
        ? failedTicketId || state.current_ticket || null
        : null;
      state.step = String(finalReason).startsWith('preflight-') ? 'blocked' : 'paused';
      if (finalReason === 'error') {
        appendHistory(state, 'failed', state.current_ticket || undefined);
      } else if (String(finalReason).startsWith('preflight-')) {
        appendHistory(state, finalReason, state.current_ticket || undefined);
      } else {
        appendHistory(state, finalReason);
      }
    }
    return state;
  });

  if (manager.read(statePath).last_exit_reason === 'success') {
    logActivity({
      event: 'epic_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
    }, { enabled: config.defaults.activity_logging });
  }

  appendRunnerLog(sessionDir, `mux-runner finished: ${manager.read(statePath).last_exit_reason}`);
  return manager.read(statePath).last_exit_reason;
}

async function main(argv) {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/mux-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  const exitReason = await runSequential(sessionDir, { onFailure: parseFailureMode(argv) });
  if (exitReason === 'error' || exitReason === 'no_tickets' || exitReason === 'invalid_session' || String(exitReason).startsWith('preflight-')) {
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
