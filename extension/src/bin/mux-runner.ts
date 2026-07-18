#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState } from '../services/circuit-breaker.js';
import { getRunStartEpoch, markRunStart } from '../services/session.js';
import { enterMuxRunnerPhase, exitMuxRunnerPhase } from '../services/pipeline-bootstrap.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  areTicketDependenciesSatisfied,
  listTickets,
  normalizeTicketId,
  summarizeTickets,
  unresolvedTicketDependencies,
  updateTicketStatus,
} from '../services/tickets.js';
import { isPreflightError, isVerificationContractError } from '../services/verification-env.js';
import { scrubTicketWorkerMessages } from '../services/worker-output.js';
import { decideTicketRecovery } from '../services/recovery-controller.js';
import { runTicket } from './spawn-morty.js';

interface RunSequentialOptions {
  onFailure?: string;
  runnerMode?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

interface RunSequentialDeps {
  runTicket?: typeof runTicket;
}

function appendRunnerLog(sessionDir: string, mode: string, message: string): void {
  const descriptor = getRunnerDescriptor(mode);
  const filePath = path.join(sessionDir, descriptor.runnerLog);
  fs.appendFileSync(filePath, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function parseFailureMode(argv: string[]): string {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'abort';
  const mode = modeArg.split('=')[1] ?? '';
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function shouldStop(state: PersistedState): string | null {
  if (state.active === false) {
    return (state.last_exit_reason as string | null) || 'cancelled';
  }
  if (Number.isInteger(state.max_iterations) && (state.max_iterations as number) > 0 && (state.iteration as number) >= (state.max_iterations as number)) {
    return 'max_iterations';
  }
  if (Number.isFinite(state.max_time_minutes) && (state.max_time_minutes as number) > 0) {
    const elapsedMinutes = (Date.now() / 1000 - getRunStartEpoch(state)) / 60;
    if (elapsedMinutes >= (state.max_time_minutes as number)) {
      return 'max_time';
    }
  }
  return null;
}

export async function runSequential(
  sessionDir: string,
  options: RunSequentialOptions = {},
  deps: RunSequentialDeps = {},
): Promise<string> {
  const runTicketFn = deps.runTicket ?? runTicket;
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const failureMode = options.onFailure || 'abort';
  const runnerMode = options.runnerMode || 'pickle';
  const runnerDescriptor = getRunnerDescriptor(runnerMode);
  const runnerLabel = runnerDescriptor.runnerStartMarker.replace(/\s+started$/, '');
  const config = loadConfig();
  let exitReason = 'success';
  let failedTicketId: string | null = null;

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
      if (config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir))) {
        failedTicketId = ticket.id;
        exitReason = 'circuit_open';
        appendRunnerLog(sessionDir, runnerMode, `refusing ticket ${ticket.id}: circuit breaker is OPEN`);
        break;
      }

      attempts += 1;
      try {
        appendRunnerLog(sessionDir, runnerMode, `starting ticket ${ticket.id} attempt ${attempts}/${maxAttempts}`);
        const result = await runTicketFn(sessionDir, ticket.id, {
          ...options,
          runnerMode,
        });
        if (result.status === 'done') {
          scrubTicketWorkerMessages(sessionDir, normalizeTicketId(ticket.id, ticket.id));
          ticket.status = 'Done';
          appendRunnerLog(sessionDir, runnerMode, `completed ticket ${ticket.id}`);
          break;
        }
        // The oracle refused this ticket's completion (non-throwing): the ticket is NOT
        // Done. Route it through the same failure-mode handling as a genuine failure so a
        // ticket is only ever marked Done when the oracle accepted it.
        appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} not completed: oracle refusal ${result.reason ?? result.status}`);
        const recovery = decideTicketRecovery({
          failureKind: 'oracle_refusal',
          failureMode,
          attempt: attempts,
          maxAttempts,
          stopReason: shouldStop(manager.read(statePath)),
          circuitOpen: config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir)),
        });
        if (recovery.action === 'retry') {
          continue;
        }
        if (recovery.action === 'skip') {
          ticket.status = 'Skipped';
          updateTicketStatus(sessionDir, ticket.id, { status: 'Skipped', skipped_at: new Date().toISOString() });
          appendRunnerLog(sessionDir, runnerMode, `skipping ticket ${ticket.id}`);
          break;
        }
        failedTicketId = ticket.id;
        exitReason = recovery.exitReason || 'error';
        appendRunnerLog(sessionDir, runnerMode, `recovery stopped for ${ticket.id}: ${recovery.reason}`);
        appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} aborting on ${ticket.id}`);
        break;
      } catch (error) {
        const cancelled = manager.read(statePath).active === false;
        if (cancelled) {
          exitReason = (manager.read(statePath).last_exit_reason as string | null) || 'cancelled';
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} stopped: ${exitReason}`);
          break;
        }
        if (isPreflightError(error)) {
          failedTicketId = ticket.id;
          exitReason = (error as { kind: string }).kind;
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} preflight blocked: ${(error as Error).message}`);
          break;
        }
        if (isVerificationContractError(error)) {
          failedTicketId = ticket.id;
          exitReason = (error as { kind: string }).kind;
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} verification contract blocked: ${(error as Error).message}`);
          appendRunnerLog(sessionDir, runnerMode, `${runnerLabel} stopping on ${ticket.id} without retry`);
          break;
        }
        appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} failed on attempt ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
        const recovery = decideTicketRecovery({
          failureKind: 'worker_failure',
          failureMode,
          attempt: attempts,
          maxAttempts,
          stopReason: shouldStop(manager.read(statePath)),
          circuitOpen: config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir)),
        });
        if (recovery.action === 'retry') {
          continue;
        }
        if (recovery.action === 'skip') {
          ticket.status = 'Skipped';
          updateTicketStatus(sessionDir, ticket.id, { status: 'Skipped', skipped_at: new Date().toISOString() });
          appendRunnerLog(sessionDir, runnerMode, `skipping ticket ${ticket.id}`);
          break;
        }
        failedTicketId = ticket.id;
        exitReason = recovery.exitReason || 'error';
        appendRunnerLog(sessionDir, runnerMode, `recovery stopped for ${ticket.id}: ${recovery.reason}`);
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

async function main(argv: string[]): Promise<void> {
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
    || exitReason === 'circuit_open'
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
