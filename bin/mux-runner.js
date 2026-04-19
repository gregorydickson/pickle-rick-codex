#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { getRunStartEpoch, markRunStart } from '../lib/session.js';
import { enterMuxRunnerPhase, exitMuxRunnerPhase } from '../lib/pipeline-bootstrap.js';
import { getRunnerDescriptor } from '../lib/runner-descriptors.js';
import { StateManager } from '../lib/state-manager.js';
import {
  areTicketDependenciesSatisfied,
  listTickets,
  summarizeTickets,
  unresolvedTicketDependencies,
  updateTicketStatus,
} from '../lib/tickets.js';
import { isPreflightError, isVerificationContractError } from '../lib/verification-env.js';
import { runTicket } from './spawn-morty.js';

function appendRunnerLog(sessionDir, mode, message) {
  const descriptor = getRunnerDescriptor(mode);
  const filePath = path.join(sessionDir, descriptor.runnerLog);
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
  const runnerMode = options.runnerMode || 'pickle';
  const runnerDescriptor = getRunnerDescriptor(runnerMode);
  const runnerLabel = runnerDescriptor.runnerStartMarker.replace(/\s+started$/, '');
  const config = loadConfig();
  let exitReason = 'success';
  let failedTicketId = null;

  appendRunnerLog(sessionDir, runnerMode, runnerDescriptor.runnerStartMarker);
  enterMuxRunnerPhase(manager, statePath, { markRunStart });

  const summary = summarizeTickets(sessionDir);
  if (!summary.total) {
    exitReason = 'no_tickets';
    appendRunnerLog(sessionDir, runnerMode, 'no tickets found in refinement manifest');
  } else if (!summary.runnable.length) {
    exitReason = 'no_tickets';
    appendRunnerLog(
      sessionDir,
      runnerMode,
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
      appendRunnerLog(sessionDir, runnerMode, `stopping before ticket ${ticket.id}: ${ticketStopReason}`);
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
      appendRunnerLog(sessionDir, runnerMode, `blocking ticket ${ticket.id}: unresolved dependencies ${unresolved.join(', ')}`);
      break;
    }

    let attempts = 0;
    const maxAttempts = failureMode === 'retry-once' ? 2 : 1;

    while (attempts < maxAttempts) {
      const latestState = manager.read(statePath);
      const stopReason = shouldStop(latestState);
      if (stopReason) {
        exitReason = stopReason;
        appendRunnerLog(sessionDir, runnerMode, `stopping during ticket ${ticket.id}: ${stopReason}`);
        break;
      }

      attempts += 1;
      try {
        appendRunnerLog(sessionDir, runnerMode, `starting ticket ${ticket.id} attempt ${attempts}/${maxAttempts}`);
        await runTicket(sessionDir, ticket.id, {
          ...options,
          runnerMode,
        });
        ticket.status = 'Done';
        appendRunnerLog(sessionDir, runnerMode, `completed ticket ${ticket.id}`);
        break;
      } catch (error) {
        const cancelled = manager.read(statePath).active === false;
        if (cancelled) {
          exitReason = manager.read(statePath).last_exit_reason || 'cancelled';
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} stopped: ${exitReason}`);
          break;
        }
        if (isPreflightError(error)) {
          failedTicketId = ticket.id;
          exitReason = error.kind;
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} preflight blocked: ${error.message}`);
          break;
        }
        if (isVerificationContractError(error)) {
          failedTicketId = ticket.id;
          exitReason = error.kind;
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} verification contract blocked: ${error.message}`);
          appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} stopping on ${ticket.id} without retry`);
          break;
        }
        appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} failed on attempt ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
        if (attempts < maxAttempts) {
          const retryStopReason = shouldStop(manager.read(statePath));
          if (retryStopReason === 'max_time' || retryStopReason === 'max_iterations') {
            failedTicketId = ticket.id;
            exitReason = 'error';
            appendRunnerLog(sessionDir, runnerMode, `not retrying ${ticket.id}: ${retryStopReason} would mask the current failure`);
            appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} aborting on ${ticket.id}`);
            break;
          }
          continue;
        }
        if (failureMode === 'skip') {
          ticket.status = 'Skipped';
          updateTicketStatus(sessionDir, ticket.id, { status: 'Skipped', skipped_at: new Date().toISOString() });
          appendRunnerLog(sessionDir, runnerMode, `skipping ticket ${ticket.id}`);
          break;
        }
        failedTicketId = ticket.id;
        exitReason = 'error';
        appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} aborting on ${ticket.id}`);
        break;
      }
    }

    if (exitReason !== 'success') {
      break;
    }
  }

  const finalReason = exitMuxRunnerPhase(manager, statePath, {
    exitReason,
    failedTicketId,
    deferTerminalState: runnerMode === 'pipeline',
  });

  if (finalReason === 'success') {
    logActivity({
      event: 'epic_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
    }, { enabled: config.defaults.activity_logging });
  }

  appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} finished: ${finalReason}`);
  return finalReason;
}

async function main(argv) {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/mux-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  const exitReason = await runSequential(sessionDir, { onFailure: parseFailureMode(argv) });
  if (
    exitReason === 'error'
    || exitReason === 'no_tickets'
    || exitReason === 'invalid_session'
    || exitReason === 'verification-contract-failed'
    || String(exitReason).startsWith('preflight-')
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
