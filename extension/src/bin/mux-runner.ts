#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState, openCircuitBreaker } from '../services/circuit-breaker.js';
import { getRunStartEpoch, markRunStart } from '../services/session.js';
import { enterMuxRunnerPhase, exitMuxRunnerPhase } from '../services/pipeline-bootstrap.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  areTicketDependenciesSatisfied,
  normalizeTicketId,
  summarizeTickets,
  unresolvedTicketDependencies,
  updateTicketStatus,
} from '../services/tickets.js';
import { isPreflightError, isVerificationContractError } from '../services/verification-env.js';
import { scrubTicketWorkerMessages } from '../services/worker-output.js';
import {
  buildTicketRecoveryFailureIdentity,
  decideTicketRecovery,
  getTicketRecoveryLineageOccurrences,
  getTicketRecoveryUsage,
  MAX_ADAPTIVE_TICKET_FAILURES,
  recordTicketRecoveryFailure,
  type TicketFailureKind,
} from '../services/recovery-controller.js';
import { isWorkerLifecycleRefusalError } from '../services/worker-lifecycle.js';
import { acquireSessionOperation } from '../services/session-operation.js';
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
  if (!['abort', 'skip', 'retry-once', 'retry'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function parseLaunchOwnerPid(argv: string[]): number | null {
  const value = Number(argv.find((arg) => arg.startsWith('--launch-owner='))?.split('=')[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseRunStartedAtMs(argv: string[]): number | null {
  const value = Number(argv.find((arg) => arg.startsWith('--run-started-at='))?.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
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

async function runSequentialWithLease(
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
  enterMuxRunnerPhase(manager, statePath, {
    markRunStart,
    runStartedAtMs: Number(options.runStartedAtMs),
  });

  const summary = summarizeTickets(sessionDir);
  if (!summary.total) {
    exitReason = 'no_tickets';
    appendRunnerLog(sessionDir, runnerMode, 'no tickets found in refinement manifest');
  } else if (!summary.runnable.length) {
    exitReason = summary.done === summary.total ? 'success' : 'no_tickets';
    appendRunnerLog(
      sessionDir,
      runnerMode,
      `no runnable tickets found (done=${summary.done} blocked=${summary.blocked} skipped=${summary.skipped})`,
    );
  }

  const pendingTicketIds = new Set(
    summary.tickets
      .filter((ticket) => !['done', 'skipped', 'blocked'].includes(String(ticket.status || '').trim().toLowerCase()))
      .map((ticket) => normalizeTicketId(ticket.id, ticket.id)),
  );
  while (pendingTicketIds.size > 0 && exitReason === 'success') {
    const currentSummary = summarizeTickets(sessionDir);
    const ticket = currentSummary.tickets.find((candidate) => (
      pendingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
      && areTicketDependenciesSatisfied(candidate, currentSummary.tickets)
    ));
    if (!ticket) {
      failedTicketId = [...pendingTicketIds][0] || null;
      exitReason = 'error';
      const unresolved = currentSummary.tickets
        .filter((candidate) => pendingTicketIds.has(normalizeTicketId(candidate.id, candidate.id)))
        .map((candidate) => `${candidate.id}: ${unresolvedTicketDependencies(candidate, currentSummary.tickets).join(', ') || 'no satisfiable predecessor'}`);
      appendRunnerLog(sessionDir, runnerMode, `no dependency-runnable ticket remains (${unresolved.join('; ')})`);
      break;
    }
    pendingTicketIds.delete(normalizeTicketId(ticket.id, ticket.id));

    const ticketStopReason = shouldStop(manager.read(statePath));
    if (ticketStopReason) {
      exitReason = ticketStopReason;
      appendRunnerLog(sessionDir, runnerMode, `stopping before ticket ${ticket.id}: ${ticketStopReason}`);
      break;
    }

    let attempts = 0;
    const maxAttempts = failureMode === 'retry'
      ? Number.POSITIVE_INFINITY
      : failureMode === 'retry-once' ? 2 : 1;
    const unchangedLimit = Math.max(
      1,
      config.defaults.max_retry_attempts + 1,
      config.defaults.circuit_breaker.same_error_threshold,
    );
    const ticketFailureLimit = MAX_ADAPTIVE_TICKET_FAILURES;

    const decideRecovery = (
      failureKind: TicketFailureKind,
      message: string,
      error: unknown = null,
    ) => {
      let adaptiveExhausted = false;
      let adaptiveExitReason: 'circuit_open' | 'recovery_exhausted' = 'circuit_open';
      if (failureMode === 'retry') {
        const refusal = isWorkerLifecycleRefusalError(error) ? error : null;
        const identity = buildTicketRecoveryFailureIdentity({
          failureKind,
          message,
          phase: refusal?.phase || null,
          artifact: refusal?.artifact || null,
          evidencePath: refusal?.artifactPath || null,
          remediationIdentity: refusal?.remediationIdentity || null,
        });
        let event;
        try {
          event = recordTicketRecoveryFailure({
            sessionDir,
            ticketId: ticket.id,
            failureKind,
            identity,
          });
        } catch (historyError) {
          const reason = historyError instanceof Error ? historyError.message : String(historyError);
          manager.update(statePath, (current) => {
            current.recovery_required = true;
            current.recovery_kind = 'ticket_recovery_history';
            current.recovery_reason = reason;
            return current;
          });
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} recovery history failed closed: ${reason}`);
          return { action: 'abort' as const, exitReason: 'recovery_required', reason };
        }
        const lineageOccurrences = getTicketRecoveryLineageOccurrences(
          sessionDir,
          ticket.id,
          identity.signature,
        );
        const ticketFailureCount = getTicketRecoveryUsage(sessionDir, ticket.id).ticketFailureCount;
        const lineageExhausted = config.defaults.circuit_breaker.enabled
          && lineageOccurrences >= unchangedLimit;
        adaptiveExhausted = lineageExhausted || ticketFailureCount >= ticketFailureLimit;
        if (adaptiveExhausted) {
          if (ticketFailureCount >= ticketFailureLimit) {
            adaptiveExitReason = 'recovery_exhausted';
          } else if (lineageExhausted) {
            openCircuitBreaker(
              sessionDir,
              `ticket ${ticket.id} repeated recovery lineage ${identity.signature} ${lineageOccurrences} times`,
              identity.signature,
            );
          }
        }
        appendRunnerLog(
          sessionDir,
          runnerMode,
          `ticket ${ticket.id} recovery event ${event.sequence}: ${event.changed_lineage ? 'changed' : 'unchanged'} lineage, consecutive=${event.consecutive_same_lineage}/${unchangedLimit}, occurrences=${lineageOccurrences}/${unchangedLimit}, ticket=${ticketFailureCount}/${ticketFailureLimit}`,
        );
      }
      const latestState = manager.read(statePath);
      if (latestState.recovery_required) {
        return {
          action: 'abort' as const,
          exitReason: 'recovery_required',
          reason: String(latestState.recovery_reason || 'verified unsafe repository recovery state'),
        };
      }
      return decideTicketRecovery({
        failureKind,
        failureMode,
        attempt: attempts,
        maxAttempts,
        stopReason: shouldStop(latestState),
        circuitOpen: config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir)),
        failureExitReason: 'error',
        adaptiveExhausted,
        adaptiveExitReason,
      });
    };

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
      if (failureMode === 'retry') {
        try {
          const usage = getTicketRecoveryUsage(sessionDir, ticket.id);
          const lineageExhausted = config.defaults.circuit_breaker.enabled
            && usage.maxLineageOccurrences >= unchangedLimit;
          if (usage.ticketFailureCount >= ticketFailureLimit || lineageExhausted) {
            failedTicketId = ticket.id;
            const ticketBudgetExhausted = usage.ticketFailureCount >= ticketFailureLimit;
            exitReason = ticketBudgetExhausted ? 'recovery_exhausted' : 'circuit_open';
            const reason = ticketBudgetExhausted
              ? `ticket ${ticket.id} already exhausted its durable recovery budget ${usage.ticketFailureCount}/${ticketFailureLimit}`
              : `ticket ${ticket.id} already exhausted a durable recovery lineage ${usage.maxLineageOccurrences}/${unchangedLimit}`;
            if (!ticketBudgetExhausted) openCircuitBreaker(sessionDir, reason);
            appendRunnerLog(sessionDir, runnerMode, reason);
            break;
          }
        } catch (historyError) {
          failedTicketId = ticket.id;
          exitReason = 'recovery_required';
          const reason = historyError instanceof Error ? historyError.message : String(historyError);
          manager.update(statePath, (current) => {
            current.recovery_required = true;
            current.recovery_kind = 'ticket_recovery_history';
            current.recovery_reason = reason;
            return current;
          });
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} recovery history failed closed before dispatch: ${reason}`);
          break;
        }
      }

      attempts += 1;
      try {
        appendRunnerLog(
          sessionDir,
          runnerMode,
          `starting ticket ${ticket.id} attempt ${attempts}${Number.isFinite(maxAttempts) ? `/${maxAttempts}` : ' (adaptive)'}`,
        );
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
        const refusalMessage = `oracle refusal ${result.reason ?? result.status}`;
        const recovery = decideRecovery('oracle_refusal', refusalMessage);
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
        const failureMessage = error instanceof Error ? error.message : String(error);
        const recovery = decideRecovery('worker_failure', failureMessage, error);
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

export async function runSequential(
  sessionDir: string,
  options: RunSequentialOptions = {},
  deps: RunSequentialDeps = {},
): Promise<string> {
  const configuredRunStartedAtMs = Number(options.runStartedAtMs);
  const runStartedAtMs = Number.isFinite(configuredRunStartedAtMs) && configuredRunStartedAtMs > 0
    ? configuredRunStartedAtMs
    : Date.now();
  if (options.operationLeaseHeld === true) {
    return await runSequentialWithLease(sessionDir, { ...options, runStartedAtMs }, deps);
  }
  const launchOwnerPid = Number(options.launchOwnerPid);
  const releaseOperation = acquireSessionOperation(
    sessionDir,
    undefined,
    Number.isInteger(launchOwnerPid) && launchOwnerPid > 0 ? launchOwnerPid : null,
  );
  try {
    return await runSequentialWithLease(sessionDir, { ...options, runStartedAtMs }, deps);
  } finally {
    releaseOperation();
  }
}

async function main(argv: string[]): Promise<void> {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/mux-runner.js <session-dir> [--on-failure=abort|skip|retry-once|retry]');
  }
  const exitReason = await runSequential(sessionDir, {
    onFailure: parseFailureMode(argv),
    launchOwnerPid: parseLaunchOwnerPid(argv),
    runStartedAtMs: parseRunStartedAtMs(argv),
  });
  if (muxRunnerExitFailed(exitReason)) {
    process.exitCode = 1;
  }
}

export function muxRunnerExitFailed(exitReason: string): boolean {
  return (
    exitReason === 'error'
    || exitReason === 'no_tickets'
    || exitReason === 'invalid_session'
    || exitReason === 'verification-contract-failed'
    || exitReason === 'circuit_open'
    || exitReason === 'recovery_exhausted'
    || exitReason === 'recovery_required'
    || String(exitReason).startsWith('preflight-')
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
