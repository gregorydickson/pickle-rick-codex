#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { appendHistory, getRunStartEpoch, markRunStart } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { listTickets, summarizeTickets, updateTicketStatus } from '../lib/tickets.js';
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
    state.active = false;
    state.tmux_runner_pid = null;
    state.last_exit_reason = exitReason;
    if (exitReason === 'success') {
      state.current_ticket = null;
      state.step = 'complete';
      appendHistory(state, 'complete');
    } else {
      state.current_ticket = exitReason === 'error' ? failedTicketId || state.current_ticket || null : null;
      state.step = 'paused';
      if (exitReason === 'error') {
        appendHistory(state, 'failed', state.current_ticket || undefined);
      } else {
        appendHistory(state, exitReason);
      }
    }
    return state;
  });

  if (exitReason === 'success') {
    logActivity({
      event: 'epic_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
    }, { enabled: config.defaults.activity_logging });
  }

  appendRunnerLog(sessionDir, `mux-runner finished: ${exitReason}`);
  return exitReason;
}

async function main(argv) {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/mux-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  const exitReason = await runSequential(sessionDir, { onFailure: parseFailureMode(argv) });
  if (exitReason === 'error' || exitReason === 'no_tickets' || exitReason === 'invalid_session') {
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
