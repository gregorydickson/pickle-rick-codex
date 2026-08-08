#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState, openCircuitBreaker, resetCircuitBreaker } from '../services/circuit-breaker.js';
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
  authorizeTicketRecoveryEpoch,
  decideTicketRecovery,
  getTicketRecoveryLineageOccurrences,
  getTicketRecoveryUsage,
  MAX_ADAPTIVE_TICKET_FAILURES,
  recordTicketRecoveryFailure,
  type TicketFailureKind,
} from '../services/recovery-controller.js';
import { isWorkerLifecycleRefusalError } from '../services/worker-lifecycle.js';
import { acquireSessionOperation } from '../services/session-operation.js';
import {
  beginRecoveryStrategyEpoch,
  classifyFailure,
  executionTelemetrySummary,
  nextMaterialApproach,
  planSchedulerContinuity,
  readRecoveryStrategyEpochs,
  recordExecutionControlTelemetry,
  recoveryRoute,
  type FailureDomain,
} from '../services/productive-autonomy.js';
import { runTicket } from './spawn-morty.js';
import { startDurableRuntimeOwnership } from '../services/durable-runtime.js';

interface RunSequentialOptions {
  onFailure?: string;
  runnerMode?: string;
  timeoutMs?: number;
  durableOwnershipHeld?: boolean;
  assertDurableOwnership?: () => void;
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
  const failureMode = options.durableOwnershipHeld === true ? 'retry' : options.onFailure || 'abort';
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
  let scheduledDiagnosticTicketId: string | null = null;
  if (!summary.total) {
    exitReason = 'no_tickets';
    appendRunnerLog(sessionDir, runnerMode, 'no tickets found in refinement manifest');
  } else if (!summary.runnable.length) {
    if (summary.done !== summary.total && failureMode === 'retry') {
      const repairing = new Set(summary.tickets
        .filter((candidate) => String(candidate.status).toLowerCase() === 'blocked')
        .map((candidate) => candidate.id));
      const decision = planSchedulerContinuity(summary.tickets, repairing);
      if (decision.kind === 'diagnostic' && decision.ticketId !== 'pipeline') {
        scheduledDiagnosticTicketId = normalizeTicketId(decision.ticketId, decision.ticketId);
        updateTicketStatus(sessionDir, decision.ticketId, {
          status: 'Todo',
          recovery_task: decision.task,
          recovery_scheduled_at: new Date().toISOString(),
        });
        appendRunnerLog(sessionDir, runnerMode, `all tickets blocked; scheduled ${decision.task} for ${decision.ticketId}`);
      } else {
        exitReason = 'no_tickets';
      }
    } else {
      exitReason = summary.done === summary.total ? 'success' : 'no_tickets';
    }
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
  if (scheduledDiagnosticTicketId) pendingTicketIds.add(scheduledDiagnosticTicketId);
  const repairingTicketIds = new Set<string>();
  while (pendingTicketIds.size > 0 && exitReason === 'success') {
    options.assertDurableOwnership?.();
    const currentSummary = summarizeTickets(sessionDir);
    const runnable = (candidate: typeof currentSummary.tickets[number]): boolean => (
      pendingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
      && areTicketDependenciesSatisfied(candidate, currentSummary.tickets)
    );
    const ticket = currentSummary.tickets.find((candidate) => (
      runnable(candidate) && !repairingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
    )) || currentSummary.tickets.find(runnable);
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
    repairingTicketIds.delete(normalizeTicketId(ticket.id, ticket.id));

    const ticketStopReason = shouldStop(manager.read(statePath));
    if (ticketStopReason && failureMode !== 'retry') {
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
    let activeStrategyHash: string | null = null;
    let activeRecoveryEpoch = readRecoveryStrategyEpochs(sessionDir)
      .filter((epoch) => epoch.ticketId === ticket.id).length;
    let latestFailureDomain: FailureDomain = 'infrastructure';
    let yieldToScheduler = false;

    const startAutomaticRecoveryEpoch = (
      reason: string,
      trigger: 'failure' | 'retry_threshold' | 'time_threshold' | 'circuit_threshold' = 'retry_threshold',
    ): boolean => {
      try {
        const route = recoveryRoute(latestFailureDomain);
        recordExecutionControlTelemetry(sessionDir, { checkpoints_invalidated: route.invalidate.length });
        const priorEpochs = readRecoveryStrategyEpochs(sessionDir).filter((epoch) => epoch.ticketId === ticket.id).length;
        const strategy = beginRecoveryStrategyEpoch(sessionDir, {
          ticketId: ticket.id,
          domain: latestFailureDomain,
          handler: route.handler,
          checkpoint: route.invalidate[0] || 'executor',
          constraints: [reason],
          materialApproach: nextMaterialApproach(latestFailureDomain, priorEpochs),
        }, trigger);
        const authorization = authorizeTicketRecoveryEpoch(sessionDir, ticket.id, {
          authorizedBy: 'runner',
          reason,
        });
        activeStrategyHash = strategy.strategyHash;
        activeRecoveryEpoch = strategy.sequence;
        resetCircuitBreaker(sessionDir, `automatic recovery epoch ${authorization.sequence} for ${ticket.id}`);
        appendRunnerLog(
          sessionDir,
          runnerMode,
          `ticket ${ticket.id} ${reason}; continuing in automatic recovery epoch ${authorization.sequence} strategy=${strategy.strategyHash}`,
        );
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        manager.update(statePath, (current) => {
          current.recovery_required = true;
          current.recovery_kind = 'ticket_recovery_history';
          current.recovery_reason = detail;
          return current;
        });
        appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} could not start an automatic recovery epoch: ${detail}`);
        return false;
      }
    };

    const renewThresholdWindow = (reason: string): void => {
      manager.update(statePath, (current) => {
        markRunStart(current);
        if (reason === 'max_iterations' && Number(current.max_iterations) > 0) {
          current.max_iterations = Number(current.iteration || 0) + Number(current.max_iterations);
        }
        return current;
      });
    };

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
        latestFailureDomain = classifyFailure({
          kind: failureKind,
          phase: refusal?.phase || manager.read(statePath).step as string | undefined,
          message,
        });
        const route = recoveryRoute(latestFailureDomain);
        let event;
        try {
          event = recordTicketRecoveryFailure({
            sessionDir,
            ticketId: ticket.id,
            failureKind,
            identity,
            route,
            strategyHash: activeStrategyHash,
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
        yieldToScheduler = currentSummary.tickets.some((candidate) => (
          normalizeTicketId(candidate.id, candidate.id) !== normalizeTicketId(ticket.id, ticket.id)
          && pendingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
          && areTicketDependenciesSatisfied(candidate, currentSummary.tickets)
        ));
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
      const stopReason = shouldStop(latestState);
      if (adaptiveExhausted && !stopReason) {
        const reason = adaptiveExitReason === 'recovery_exhausted'
          ? `exhausted durable recovery budget ${ticketFailureLimit}/${ticketFailureLimit}`
          : `exhausted recovery lineage window ${unchangedLimit}/${unchangedLimit}`;
        if (!startAutomaticRecoveryEpoch(reason, adaptiveExitReason === 'circuit_open' ? 'circuit_threshold' : 'retry_threshold')) {
          return {
            action: 'abort' as const,
            exitReason: 'recovery_required',
            reason: String(manager.read(statePath).recovery_reason || 'automatic recovery epoch failed'),
          };
        }
        adaptiveExhausted = false;
      }
      return decideTicketRecovery({
        failureKind,
        failureMode,
        attempt: attempts,
        maxAttempts,
        stopReason,
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
        if (
          failureMode === 'retry'
          && (stopReason === 'max_time' || stopReason === 'max_iterations')
          && startAutomaticRecoveryEpoch(`crossed ${stopReason} strategy threshold`, 'time_threshold')
        ) {
          renewThresholdWindow(stopReason);
          continue;
        }
        exitReason = stopReason;
        appendRunnerLog(sessionDir, runnerMode, `stopping during ticket ${ticket.id}: ${stopReason}`);
        break;
      }
      if (config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir))) {
        if (failureMode === 'retry' && startAutomaticRecoveryEpoch('reached an OPEN circuit strategy boundary')) {
          continue;
        }
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
            const ticketBudgetExhausted = usage.ticketFailureCount >= ticketFailureLimit;
            const reason = ticketBudgetExhausted
              ? `already exhausted durable recovery budget ${usage.ticketFailureCount}/${ticketFailureLimit}`
              : `already exhausted recovery lineage ${usage.maxLineageOccurrences}/${unchangedLimit}`;
            if (startAutomaticRecoveryEpoch(reason)) continue;
            failedTicketId = ticket.id;
            exitReason = 'recovery_required';
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
        options.assertDurableOwnership?.();
        const result = await runTicketFn(sessionDir, ticket.id, {
          ...options,
          runnerMode,
          ticketAttempt: attempts,
          recoveryEpoch: activeRecoveryEpoch,
          strategyHash: activeStrategyHash,
        });
        options.assertDurableOwnership?.();
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
          if (yieldToScheduler) {
            const normalized = normalizeTicketId(ticket.id, ticket.id);
            pendingTicketIds.add(normalized);
            repairingTicketIds.add(normalized);
            appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} entered repair; yielding to dependency-ready work`);
            break;
          }
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
          if (failureMode === 'retry') {
            const recovery = decideRecovery('preflight', (error as Error).message, error);
            if (recovery.action === 'retry') {
              if (yieldToScheduler) {
                const normalized = normalizeTicketId(ticket.id, ticket.id);
                pendingTicketIds.add(normalized);
                repairingTicketIds.add(normalized);
                break;
              }
              appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} preflight routed to autonomous contract repair`);
              continue;
            }
          }
          failedTicketId = ticket.id;
          exitReason = (error as { kind: string }).kind;
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} preflight blocked: ${(error as Error).message}`);
          break;
        }
        if (isVerificationContractError(error)) {
          if (failureMode === 'retry') {
            const recovery = decideRecovery('verification_contract', (error as Error).message, error);
            if (recovery.action === 'retry') {
              if (yieldToScheduler) {
                const normalized = normalizeTicketId(ticket.id, ticket.id);
                pendingTicketIds.add(normalized);
                repairingTicketIds.add(normalized);
                break;
              }
              appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} verification contract routed to autonomous contract repair`);
              continue;
            }
          }
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
          if (yieldToScheduler) {
            const normalized = normalizeTicketId(ticket.id, ticket.id);
            pendingTicketIds.add(normalized);
            repairingTicketIds.add(normalized);
            appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} entered repair; yielding to dependency-ready work`);
            break;
          }
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
  const telemetry = executionTelemetrySummary(sessionDir);
  appendRunnerLog(
    sessionDir,
    runnerMode,
    `telemetry ticket_attempts=${telemetry.ticketAttempts} phase_attempts=${telemetry.phaseAttempts} recovery_epochs=${telemetry.recoveryEpochs} productive=${telemetry.productiveWork} discarded=${telemetry.discardedWork}`,
  );
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
  const durableRuntime = fs.existsSync(path.join(sessionDir, 'prd.lock.json'))
    && fs.existsSync(path.join(sessionDir, 'logical-pipeline.json'));
  if (!durableRuntime) {
    try {
      return await runSequentialWithLease(sessionDir, { ...options, runStartedAtMs }, deps);
    } finally {
      releaseOperation();
    }
  }
  let ownership: ReturnType<typeof startDurableRuntimeOwnership> | null = null;
  let exitReason = 'error';
  try {
    ownership = startDurableRuntimeOwnership(sessionDir);
    exitReason = await runSequentialWithLease(sessionDir, {
      ...options,
      onFailure: 'retry',
      durableOwnershipHeld: true,
      assertDurableOwnership: ownership.assertOwned,
      runStartedAtMs,
    }, deps);
    return exitReason;
  } finally {
    try {
      ownership?.finish(exitReason);
    } finally {
      releaseOperation();
    }
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
