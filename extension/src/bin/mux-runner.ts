#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState, openCircuitBreaker, resetCircuitBreaker } from '../services/circuit-breaker.js';
import { appendHistory, getRunStartEpoch, markRunStart } from '../services/session.js';
import { capturePipelineVerificationBaselines, enterMuxRunnerPhase, exitMuxRunnerPhase } from '../services/pipeline-bootstrap.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import {
  areTicketDependenciesSatisfied,
  normalizeTicketId,
  summarizeTickets,
  unresolvedTicketDependencies,
  updateTicketStatus,
} from '../services/tickets.js';
import { isPreflightError, isVerificationContractError, normalizeVerificationSteps } from '../services/verification-env.js';
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
  classifyAutonomousFailure,
  executionTelemetrySummary,
  nextMaterialRecoveryPlan,
  nextMaterialApproach,
  planSchedulerContinuity,
  readUnresolvedRecoveryStrategyEpochs,
  recordExecutionControlTelemetry,
  recoveryRoute,
  recoveryExecutionAction,
  resolveAutonomousRecovery,
  type FailureDomain,
  type FailureRoute,
  type RecoveryStrategyEpoch,
} from '../services/productive-autonomy.js';
import { isVerificationCommandError, repairTicketVerificationContract, runTicket } from './spawn-morty.js';
import { isDurableOwnershipDrainError, startDurableRuntimeOwnership } from '../services/durable-runtime.js';
import { assertRecordedActiveChildRecovered } from '../services/orphan-reaper.js';
import { activatePreparedManagerRelaunchRecovery, consumeManagerRelaunchRecovery } from '../services/manager-relaunch-integrity.js';
import { readCitadelSystemBlock, runCitadel } from '../services/citadel.js';
import {
  consumeDeterministicCheckFailure,
  runDeterministicRecoveryDiagnostic,
} from '../services/citadel-deterministic-recovery.js';
import { repairCitadelReviewerArtifactContract } from '../services/citadel-reviewer-recovery.js';
import { requestPrdRevision } from '../services/durable-supervisor.js';
import { finalizeLiveSessionMigrationAfterHandoff } from '../services/live-session-migration.js';
import {
  fenceAutonomousOwnerRecoveryForHandoff,
  releaseAutonomousOwnerRecoveryHandoffFence,
  transferAutonomousOwnerRecoveryForAcceptedHandoff,
} from '../services/autonomous-owner-recovery.js';
import {
  enqueueCitadelRemediationResult,
  reconcileCitadelAttributionRepair,
  reconcileCitadelRemediation,
  repairCitadelAttribution,
} from '../services/citadel-remediation.js';
import { reconstructWorkspaceFromDurableCheckpoint } from '../services/workspace-reconstruction.js';
import { legacyContractRepairPending, markLegacyContractRepairComplete } from '../services/legacy-session-adoption.js';
import {
  inspectTicketDependencyGraph,
  reconcileDependencyRepairTransaction,
  repairTicketDependencyContract,
  DependencyRepairIsolationError,
  type DependencyGraphInspection,
} from '../services/dependency-contract-repair.js';
import {
  AUTONOMOUS_BUDGET_ROLLOVER_REASON,
  consumeAutonomousBudgetRollover,
  scheduleAutonomousBudgetRollover,
} from '../services/autonomous-budget.js';
import {
  assertTicketVerificationBoundToSeal,
  reconcileVerificationRepairTransaction,
} from '../services/verification-seal-contract.js';

interface RunSequentialOptions {
  onFailure?: string;
  runnerMode?: string;
  timeoutMs?: number;
  durableOwnershipHeld?: boolean;
  assertDurableOwnership?: () => void;
  recordDurableCheckpoint?: (checkpoint: Record<string, unknown>) => void;
  resumeCheckpoint?: Record<string, unknown> | null;
  handoffRequestId?: string;
  targetRuntime?: import('../services/durable-supervisor.js').InstalledRuntimeDescriptor;
  holdActiveForReleaseGate?: boolean;
  [key: string]: unknown;
}

interface RunSequentialDeps {
  runTicket?: typeof runTicket;
  repairTicketVerificationContract?: typeof repairTicketVerificationContract;
  repairTicketDependencyContract?: typeof repairTicketDependencyContract;
  runCitadel?: typeof runCitadel;
  repairCitadelAttribution?: typeof repairCitadelAttribution;
  repairCitadelReviewerArtifactContract?: typeof repairCitadelReviewerArtifactContract;
  runDeterministicRecoveryDiagnostic?: typeof runDeterministicRecoveryDiagnostic;
}

export { AUTONOMOUS_BUDGET_ROLLOVER_REASON } from '../services/autonomous-budget.js';

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

function resumeStrategyExhaustionAfterUpgrade(
  manager: StateManager,
  statePath: string,
): boolean {
  let resumed = false;
  manager.update(statePath, (state) => {
    if (state.recovery_required === true
      && state.recovery_kind === 'ticket_recovery_history'
      && String(state.recovery_reason || '').startsWith('recovery-strategy-not-novel:')) {
      state.recovery_required = false;
      state.recovery_kind = null;
      state.recovery_reason = null;
      appendHistory(state, 'strategy_exhaustion_resumed', (state.current_ticket as string | null) || undefined);
      resumed = true;
    }
    return state;
  });
  return resumed;
}

async function runSequentialWithLease(
  sessionDir: string,
  options: RunSequentialOptions = {},
  deps: RunSequentialDeps = {},
): Promise<string> {
  const runTicketFn = deps.runTicket ?? runTicket;
  const repairContractFn = deps.repairTicketVerificationContract ?? repairTicketVerificationContract;
  const repairDependencyContractFn = deps.repairTicketDependencyContract ?? repairTicketDependencyContract;
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
  // A SIGKILL can leave a detached worker process group alive. Reap the exact
  // captured identity before runner startup clears its recovery handle.
  assertRecordedActiveChildRecovered(sessionDir, manager);
  consumeAutonomousBudgetRollover(manager, statePath, {
    assertDurableOwnership: options.assertDurableOwnership,
    recordDurableCheckpoint: options.recordDurableCheckpoint,
  });
  enterMuxRunnerPhase(manager, statePath, {
    markRunStart,
    runStartedAtMs: Number(options.runStartedAtMs),
  });
  consumeManagerRelaunchRecovery(sessionDir);
  if (resumeStrategyExhaustionAfterUpgrade(manager, statePath)) {
    appendRunnerLog(sessionDir, runnerMode, 'resumed obsolete strategy-exhaustion stop through autonomous escalation');
  }

  const reconciledDependencyTransaction = reconcileDependencyRepairTransaction(sessionDir);
  if (reconciledDependencyTransaction) {
    appendRunnerLog(sessionDir, runnerMode, `dependency repair transaction ${reconciledDependencyTransaction} before scheduler dispatch`);
  }
  const reconciledVerificationTransaction = reconcileVerificationRepairTransaction(sessionDir);
  if (reconciledVerificationTransaction) {
    appendRunnerLog(sessionDir, runnerMode, `verification repair transaction ${reconciledVerificationTransaction} before scheduler dispatch`);
  }
  const pendingReviewerRecovery = readCitadelSystemBlock(sessionDir);
  if (pendingReviewerRecovery?.recovery_action === 'repair_reviewer_artifact_contract') {
    const recovery = await (deps.repairCitadelReviewerArtifactContract ?? repairCitadelReviewerArtifactContract)(
      sessionDir,
      pendingReviewerRecovery,
      { timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership },
    );
    if (recovery.kind === 'recovery_scheduled') {
      exitReason = 'citadel_system_recovery_scheduled';
      exitMuxRunnerPhase(manager, statePath, { exitReason });
      return exitReason;
    }
    appendRunnerLog(sessionDir, runnerMode, `resolved durable Citadel reviewer contract diagnostic ${recovery.diagnostic_identity}`);
  }

  let dependencyInspection = inspectTicketDependencyGraph(sessionDir);
  const completeAdoptedVerificationRepair = (ticketId: string): void => {
    const adoptionPending = legacyContractRepairPending(sessionDir, ticketId);
    const repairedSummary = summarizeTickets(sessionDir);
    const baselines = capturePipelineVerificationBaselines(sessionDir, {
      state: manager.read(statePath),
      summary: repairedSummary,
      config,
    });
    const repairedTicketBaseline = baselines && Object.entries(baselines.by_ticket).find(([candidateId]) => (
      normalizeTicketId(candidateId, candidateId) === normalizeTicketId(ticketId, ticketId)
    ))?.[1];
    if (adoptionPending && (!repairedTicketBaseline || Object.keys(repairedTicketBaseline).length === 0)) {
      throw new Error(`adopted-verification-repair-baseline-missing: ${ticketId}`);
    }
    markLegacyContractRepairComplete(sessionDir);
    appendRunnerLog(sessionDir, runnerMode, `captured repaired verification baseline and completed legacy repair for ${ticketId}`);
  };
  let summary;
  try {
    summary = summarizeTickets(sessionDir);
  } catch (error) {
    if (failureMode !== 'retry' || !isVerificationContractError(error)) throw error;
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8')) as { tickets?: Array<{ id?: string }> };
    const invalidTicket = raw.tickets?.find((entry) => {
      try {
        const candidate = entry as { verification?: unknown; verify?: unknown };
        normalizeVerificationSteps(candidate.verification, { verify: candidate.verify });
        return false;
      } catch (candidateError) {
        return isVerificationContractError(candidateError);
      }
    });
    if (!invalidTicket?.id) throw error;
    const ticketId = normalizeTicketId(String(invalidTicket.id), 'contract-repair');
    const route = recoveryRoute('contract');
    const priorEpochs = readUnresolvedRecoveryStrategyEpochs(sessionDir, ticketId).length;
    const strategy = beginRecoveryStrategyEpoch(sessionDir, {
      ticketId, domain: 'contract', handler: route.handler, checkpoint: route.invalidate[0] || 'prepare',
      constraints: [(error as Error).message], materialApproach: nextMaterialApproach('contract', priorEpochs),
    }, 'failure');
    await repairContractFn(sessionDir, ticketId, { strategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
    if (legacyContractRepairPending(sessionDir, ticketId)) completeAdoptedVerificationRepair(ticketId);
    appendRunnerLog(sessionDir, runnerMode, `repaired invalid verification contract for ${ticketId} before scheduler dispatch`);
    summary = summarizeTickets(sessionDir);
  }
  let scheduledDiagnosticTicketId: string | null = null;
  let scheduledDiagnosticTask: string | null = null;
  const scheduleDependencyDiagnostic = (
    currentSummary: typeof summary,
    inspection: DependencyGraphInspection,
  ): boolean => {
    const selected = inspection.repair_ticket_ids.find((ticketId) => currentSummary.tickets.some((ticket) => (
      normalizeTicketId(ticket.id, ticket.id) === ticketId
      && !['done', 'skipped'].includes(String(ticket.status || '').trim().toLowerCase())
    )));
    if (!selected) return false;
    scheduledDiagnosticTicketId = selected;
    scheduledDiagnosticTask = 'repair-dependency-or-contract-blockage';
    updateTicketStatus(sessionDir, selected, {
      status: 'Todo',
      recovery_task: scheduledDiagnosticTask,
      recovery_scheduled_at: new Date().toISOString(),
      recovery_dependency_findings: inspection.findings,
    });
    appendRunnerLog(sessionDir, runnerMode, `scheduled dependency graph contract repair for ${selected}: ${inspection.findings.join('; ')}`);
    return true;
  };
  const persistDependencyWakeup = (ticketId: string, findings: string[], reason: string): void => {
    updateTicketStatus(sessionDir, ticketId, {
      status: 'Todo',
      recovery_task: 'repair-dependency-or-contract-blockage',
      recovery_wakeup_at: new Date().toISOString(),
      recovery_unresolved_dependencies: findings,
      dependency_repair_failure: reason,
    });
    manager.update(statePath, (current) => {
      appendHistory(current, 'dependency_repair_wakeup_persisted', ticketId);
      return current;
    });
    exitReason = 'dependency_repair_scheduled';
    appendRunnerLog(sessionDir, runnerMode, `dependency graph repair for ${ticketId} scheduled a durable wakeup: ${reason}`);
  };
  if (!summary.total) {
    exitReason = 'no_tickets';
    appendRunnerLog(sessionDir, runnerMode, 'no tickets found in refinement manifest');
  } else if (!summary.runnable.length) {
    if (summary.done !== summary.total && failureMode === 'retry') {
      if (dependencyInspection.findings.length > 0
        && scheduleDependencyDiagnostic(summary, dependencyInspection)) {
        appendRunnerLog(sessionDir, runnerMode, 'all tickets blocked by an invalid dependency graph; scheduled dedicated graph repair');
      } else {
        const repairing = new Set(summary.tickets
          .filter((candidate) => String(candidate.status).toLowerCase() === 'blocked')
          .map((candidate) => candidate.id));
        const dependencyReadyRepairing = new Set(summary.tickets
          .filter((candidate) => (
            repairing.has(candidate.id)
            && areTicketDependenciesSatisfied(candidate, summary.tickets)
          ))
          .map((candidate) => candidate.id));
        const decision = planSchedulerContinuity(
          summary.tickets,
          dependencyReadyRepairing.size > 0 ? dependencyReadyRepairing : repairing,
        );
        if (decision.kind === 'diagnostic' && decision.ticketId !== 'pipeline') {
          scheduledDiagnosticTicketId = normalizeTicketId(decision.ticketId, decision.ticketId);
          const diagnosticTicket = summary.tickets.find((ticket) => (
            normalizeTicketId(ticket.id, ticket.id) === scheduledDiagnosticTicketId
          ));
          scheduledDiagnosticTask = diagnosticTicket
            && unresolvedTicketDependencies(diagnosticTicket, summary.tickets).length > 0
            ? 'repair-dependency-or-contract-blockage'
            : decision.task;
          updateTicketStatus(sessionDir, decision.ticketId, {
            status: 'Todo',
            recovery_task: scheduledDiagnosticTask,
            recovery_scheduled_at: new Date().toISOString(),
          });
          appendRunnerLog(sessionDir, runnerMode, `all tickets blocked; scheduled ${scheduledDiagnosticTask} for ${decision.ticketId}`);
        } else {
          exitReason = 'no_tickets';
        }
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
  ticketLoop: while (pendingTicketIds.size > 0 && exitReason === 'success') {
    options.assertDurableOwnership?.();
    const currentSummary = summarizeTickets(sessionDir);
    dependencyInspection = inspectTicketDependencyGraph(sessionDir);
    const invalidDependencyTickets = new Set(dependencyInspection.repair_ticket_ids);
    const runnable = (candidate: typeof currentSummary.tickets[number]): boolean => (
      pendingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
      && (
        scheduledDiagnosticTicketId === normalizeTicketId(candidate.id, candidate.id)
        || (!invalidDependencyTickets.has(normalizeTicketId(candidate.id, candidate.id))
          && areTicketDependenciesSatisfied(candidate, currentSummary.tickets))
      )
    );
    const ticket = currentSummary.tickets.find((candidate) => (
      runnable(candidate) && !repairingTicketIds.has(normalizeTicketId(candidate.id, candidate.id))
    )) || currentSummary.tickets.find(runnable);
    if (!ticket) {
      if (failureMode === 'retry' && dependencyInspection.findings.length > 0
        && scheduleDependencyDiagnostic(currentSummary, dependencyInspection)) {
        pendingTicketIds.add(scheduledDiagnosticTicketId!);
        continue;
      }
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
      if (options.durableOwnershipHeld === true
        && (ticketStopReason === 'max_time' || ticketStopReason === 'max_iterations')) {
        const rollover = scheduleAutonomousBudgetRollover(manager, statePath, ticketStopReason, {
          assertDurableOwnership: options.assertDurableOwnership,
          recordDurableCheckpoint: options.recordDurableCheckpoint,
          ticketId: ticket.id,
        });
        exitReason = rollover ? AUTONOMOUS_BUDGET_ROLLOVER_REASON : 'cancelled';
        if (rollover) appendRunnerLog(
          sessionDir,
          runnerMode,
          `ticket ${ticket.id} crossed ${ticketStopReason}; persisted autonomous budget epoch ${rollover.epoch} and requested replacement after ${rollover.delayMs}ms checkpoint=${rollover.checkpointRecorded ? 'recorded' : 'reconcile-on-replacement'}`,
        );
      } else {
        exitReason = ticketStopReason;
        appendRunnerLog(sessionDir, runnerMode, `stopping before ticket ${ticket.id}: ${ticketStopReason}`);
      }
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
    const priorTicketStrategies = readUnresolvedRecoveryStrategyEpochs(sessionDir, ticket.id);
    let activeStrategy: RecoveryStrategyEpoch | null = priorTicketStrategies.at(-1) || null;
    let activeStrategyHash: string | null = activeStrategy?.strategyHash || null;
    let activeRecoveryEpoch = priorTicketStrategies.length;
    let latestFailureDomain: FailureDomain = 'infrastructure';
    let latestFailureRoute: FailureRoute = recoveryRoute('infrastructure');
    let pendingContractRepair = legacyContractRepairPending(sessionDir, ticket.id);
    let yieldToScheduler = false;

    const selectRecoveryStrategy = (
      reason: string,
      trigger: 'failure' | 'retry_threshold' | 'time_threshold' | 'circuit_threshold' = 'retry_threshold',
    ): RecoveryStrategyEpoch | null => {
      try {
        const priorStrategies = readUnresolvedRecoveryStrategyEpochs(sessionDir, ticket.id);
        const plan = nextMaterialRecoveryPlan(latestFailureRoute, priorStrategies);
        const route = plan.route;
        const executionAction = recoveryExecutionAction(route);
        if (executionAction === 'request_prd_revision') {
          requestPrdRevision(
            sessionDir,
            reason,
            `Review and repair ${route.failureType || route.domain} before resuming autonomous execution.`,
          );
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} paused for explicit PRD revision approval`);
          return null;
        }
        if (executionAction === 'restart_executor') {
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} selected an isolated worker executor restart`);
        }
        pendingContractRepair = executionAction === 'repair_contract';
        recordExecutionControlTelemetry(sessionDir, { checkpoints_invalidated: route.invalidate.length });
        const strategy = beginRecoveryStrategyEpoch(sessionDir, {
          ticketId: ticket.id,
          domain: route.domain,
          handler: route.handler,
          checkpoint: route.invalidate[0] || 'executor',
          inputHashes: plan.inputHashes,
          constraints: [reason],
          materialApproach: plan.materialApproach,
        }, trigger);
        activeStrategyHash = strategy.strategyHash;
        activeStrategy = strategy;
        activeRecoveryEpoch = strategy.sequence;
        if (executionAction === 'reconstruct_workspace') {
          const reconstructedTicket = reconstructWorkspaceFromDurableCheckpoint(
            sessionDir,
            options.assertDurableOwnership,
          );
          appendRunnerLog(sessionDir, runnerMode, `reconstructed durable workspace checkpoint for ${reconstructedTicket}`);
        }
        return strategy;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        manager.update(statePath, (current) => {
          current.recovery_required = true;
          current.recovery_kind = 'ticket_recovery_history';
          current.recovery_reason = detail;
          return current;
        });
        appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} could not select a recovery strategy: ${detail}`);
        return null;
      }
    };

    const startAutomaticRecoveryEpoch = (
      reason: string,
      trigger: 'failure' | 'retry_threshold' | 'time_threshold' | 'circuit_threshold' = 'retry_threshold',
    ): boolean => {
      try {
        const strategy = selectRecoveryStrategy(reason, trigger);
        if (!strategy) return false;
        const authorization = authorizeTicketRecoveryEpoch(sessionDir, ticket.id, { authorizedBy: 'runner', reason });
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

    const scheduleBudgetRollover = (reason: 'max_time' | 'max_iterations'): boolean => {
      const rollover = scheduleAutonomousBudgetRollover(manager, statePath, reason, {
        assertDurableOwnership: options.assertDurableOwnership,
        recordDurableCheckpoint: options.recordDurableCheckpoint,
        ticketId: ticket.id,
      });
      if (!rollover) return false;
      appendRunnerLog(
        sessionDir,
        runnerMode,
        `ticket ${ticket.id} crossed ${reason}; persisted autonomous budget epoch ${rollover.epoch} and requested replacement after ${rollover.delayMs}ms checkpoint=${rollover.checkpointRecorded ? 'recorded' : 'reconcile-on-replacement'}`,
      );
      return true;
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
        latestFailureRoute = resolveAutonomousRecovery({
          kind: failureKind,
          phase: refusal?.phase || manager.read(statePath).step as string | undefined,
          message,
        });
        latestFailureDomain = latestFailureRoute.domain;
        const route = latestFailureRoute;
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
        if (!adaptiveExhausted && activeStrategy?.domain !== latestFailureDomain
          && !selectRecoveryStrategy(`typed ${classifyAutonomousFailure({ kind: failureKind, phase: refusal?.phase || null, message })} recovery`, 'failure')) {
          return { action: 'abort' as const, exitReason: 'recovery_required', reason: 'material strategy selection failed' };
        }
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
      if (options.durableOwnershipHeld === true
        && (stopReason === 'max_time' || stopReason === 'max_iterations')) {
        if (!scheduleBudgetRollover(stopReason)) return {
          action: 'abort' as const,
          exitReason: 'cancelled',
          reason: 'operator cancellation won the autonomous budget rollover race',
        };
        return {
          action: 'abort' as const,
          exitReason: AUTONOMOUS_BUDGET_ROLLOVER_REASON,
          reason: `scheduled autonomous replacement after ${stopReason}`,
        };
      }
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
      const dependencyDiagnosticAttempt = scheduledDiagnosticTicketId === normalizeTicketId(ticket.id, ticket.id)
        && scheduledDiagnosticTask === 'repair-dependency-or-contract-blockage';
      const stopReason = shouldStop(latestState);
      if (stopReason) {
        if (options.durableOwnershipHeld === true
          && (stopReason === 'max_time' || stopReason === 'max_iterations')) {
          exitReason = scheduleBudgetRollover(stopReason)
            ? AUTONOMOUS_BUDGET_ROLLOVER_REASON : 'cancelled';
          break;
        }
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
      if (!dependencyDiagnosticAttempt
        && config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir))) {
        if (failureMode === 'retry' && startAutomaticRecoveryEpoch('reached an OPEN circuit strategy boundary')) {
          continue;
        }
        failedTicketId = ticket.id;
        exitReason = 'circuit_open';
        appendRunnerLog(sessionDir, runnerMode, `refusing ticket ${ticket.id}: circuit breaker is OPEN`);
        break;
      }
      if (failureMode === 'retry' && !dependencyDiagnosticAttempt) {
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
        if (pendingContractRepair) {
          options.assertDurableOwnership?.();
          const adoptedRepairPending = legacyContractRepairPending(sessionDir, ticket.id);
          let alreadyRepaired = false;
          if (adoptedRepairPending) {
            try {
              assertTicketVerificationBoundToSeal(
                sessionDir,
                ticket.id,
                String(manager.read(statePath).working_dir || ''),
              );
              alreadyRepaired = true;
            } catch {
              // The exact seal-bound receipt is the only authority for skipping an adopted restart repair.
            }
          }
          if (!alreadyRepaired) {
            await repairContractFn(sessionDir, ticket.id, { strategy: activeStrategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
          }
          if (adoptedRepairPending) completeAdoptedVerificationRepair(ticket.id);
          pendingContractRepair = false;
          options.assertDurableOwnership?.();
        }
        if (scheduledDiagnosticTicketId === normalizeTicketId(ticket.id, ticket.id)) {
          if (!startAutomaticRecoveryEpoch('all-blocked diagnostic repair', 'failure')) {
            throw new Error('diagnostic-repair-strategy-unavailable');
          }
          const dependencyDiagnostic = scheduledDiagnosticTask === 'repair-dependency-or-contract-blockage';
          if (dependencyDiagnostic) {
            await repairDependencyContractFn(sessionDir, ticket.id, { strategy: activeStrategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
          } else {
            await repairContractFn(sessionDir, ticket.id, { strategy: activeStrategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
          }
          pendingContractRepair = false;
          appendRunnerLog(sessionDir, runnerMode, `executed diagnostic contract repair for ${ticket.id}`);
          if (dependencyDiagnostic) {
            const repairedSummary = summarizeTickets(sessionDir);
            const repairedInspection = inspectTicketDependencyGraph(sessionDir);
            if (repairedInspection.findings.length > 0) {
              persistDependencyWakeup(ticket.id, repairedInspection.findings, 'validated worker result left an invalid dependency graph');
              break;
            }
            scheduledDiagnosticTicketId = null;
            scheduledDiagnosticTask = null;
            pendingTicketIds.add(normalizeTicketId(ticket.id, ticket.id));
            for (const candidate of repairedSummary.tickets) {
              if (!['done', 'skipped', 'blocked'].includes(String(candidate.status || '').trim().toLowerCase())) {
                pendingTicketIds.add(normalizeTicketId(candidate.id, candidate.id));
              }
            }
            continue ticketLoop;
          }
          scheduledDiagnosticTicketId = null;
          scheduledDiagnosticTask = null;
        }
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
          recoveryStrategy: activeStrategy,
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
        if (isDurableOwnershipDrainError(error)) {
          exitReason = 'runtime_handoff';
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} drained for runtime handoff`);
          break;
        }
        let catchState;
        try {
          catchState = manager.read(statePath);
        } catch (stateError) {
          if (error instanceof DependencyRepairIsolationError) throw error;
          throw stateError;
        }
        const cancelled = catchState.active === false;
        if (cancelled) {
          exitReason = (catchState.last_exit_reason as string | null) || 'cancelled';
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} stopped: ${exitReason}`);
          break;
        }
        if (error instanceof DependencyRepairIsolationError) throw error;
        if (scheduledDiagnosticTicketId === normalizeTicketId(ticket.id, ticket.id)
          && scheduledDiagnosticTask === 'repair-dependency-or-contract-blockage') {
          const failureMessage = error instanceof Error ? error.message : String(error);
          decideRecovery('worker_failure', `dependency repair failed: ${failureMessage}`, error);
          const inspection = inspectTicketDependencyGraph(sessionDir);
          persistDependencyWakeup(ticket.id, inspection.findings.length > 0 ? inspection.findings : [failureMessage], failureMessage);
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
              await repairContractFn(sessionDir, ticket.id, { strategy: activeStrategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
              pendingContractRepair = false;
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
              await repairContractFn(sessionDir, ticket.id, { strategy: activeStrategy, timeoutMs: options.timeoutMs, assertDurableOwnership: options.assertDurableOwnership });
              pendingContractRepair = false;
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
        if (isVerificationCommandError(error)) {
          appendRunnerLog(sessionDir, runnerMode, `ticket ${ticket.id} typed verification failure: ${(error as Error).message}`);
          const recovery = decideRecovery('verification_failed', (error as Error).message, error);
          if (recovery.action === 'retry') {
            if (yieldToScheduler) {
              const normalized = normalizeTicketId(ticket.id, ticket.id);
              pendingTicketIds.add(normalized);
              repairingTicketIds.add(normalized);
              break;
            }
            continue;
          }
          failedTicketId = ticket.id;
          exitReason = recovery.exitReason || 'error';
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

  const holdActiveForReleaseGate = options.holdActiveForReleaseGate === true && exitReason === 'success';
  const preserveActiveForRuntimeHandoff = exitReason === 'runtime_handoff';
  const preserveActiveForBudgetRollover = exitReason === AUTONOMOUS_BUDGET_ROLLOVER_REASON;
  const finalReason = holdActiveForReleaseGate || preserveActiveForRuntimeHandoff || preserveActiveForBudgetRollover
    ? exitReason
    : exitMuxRunnerPhase(manager, statePath, {
      exitReason,
      failedTicketId,
      deferTerminalState: runnerMode === 'pipeline',
    });

  if (finalReason === 'success' && !holdActiveForReleaseGate) {
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
  const repairAttributionFn = deps.repairCitadelAttribution ?? repairCitadelAttribution;
  const repairVerificationContractFn = deps.repairTicketVerificationContract ?? repairTicketVerificationContract;
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
      activatePreparedManagerRelaunchRecovery(sessionDir);
      return await runSequentialWithLease(sessionDir, { ...options, runStartedAtMs }, deps);
    } finally {
      releaseOperation();
    }
  }
  let ownership: ReturnType<typeof startDurableRuntimeOwnership> | null = null;
  let exitReason = 'error';
  let releaseGateHeld = false;
  try {
    const handoffRequestId = typeof options.handoffRequestId === 'string' ? options.handoffRequestId : undefined;
    if (handoffRequestId && options.targetRuntime) {
      fenceAutonomousOwnerRecoveryForHandoff(
        sessionDir, handoffRequestId, 'mux-runner.js', [],
        path.dirname(fileURLToPath(import.meta.url)), options.targetRuntime,
      );
    }
    try {
      ownership = startDurableRuntimeOwnership(sessionDir, {
        handoffRequestId,
        targetRuntime: options.targetRuntime,
      });
    } catch (error) {
      if (handoffRequestId) releaseAutonomousOwnerRecoveryHandoffFence(sessionDir, handoffRequestId);
      throw error;
    }
    if (handoffRequestId && process.env.PICKLE_TEST_MODE === '1'
      && process.env.PICKLE_TEST_HANDOFF_CRASH_AFTER_ACQUIRE === '1') {
      process.kill(process.pid, 'SIGKILL');
    }
    activatePreparedManagerRelaunchRecovery(sessionDir);
    if (typeof options.handoffRequestId === 'string' && options.targetRuntime) {
      ownership.assertOwned();
      finalizeLiveSessionMigrationAfterHandoff(sessionDir, options.handoffRequestId, options.targetRuntime);
      ownership.assertOwned();
      transferAutonomousOwnerRecoveryForAcceptedHandoff(
        sessionDir,
        'mux-runner.js',
        [],
        path.dirname(fileURLToPath(import.meta.url)),
      );
    }
    ownership.assertOwned();
    if (reconcileCitadelRemediation(sessionDir)) {
      ownership.assertOwned();
      appendRunnerLog(sessionDir, options.runnerMode || 'pickle', 'Recovered pending Citadel remediation intent.');
    }
    while (true) {
      exitReason = await runSequentialWithLease(sessionDir, {
        ...options,
        onFailure: 'retry',
        durableOwnershipHeld: true,
        assertDurableOwnership: ownership.assertOwned,
        recordDurableCheckpoint: ownership.recordCheckpoint,
        resumeCheckpoint: ownership.resumeCheckpoint(),
        runStartedAtMs,
        holdActiveForReleaseGate: options.runnerMode !== 'pipeline',
      }, deps);
      if (exitReason !== 'success' || options.runnerMode === 'pipeline') break;

      if (reconcileCitadelAttributionRepair(sessionDir)) {
        ownership.assertOwned();
        const attribution = await repairAttributionFn(sessionDir, {
          timeoutMs: options.timeoutMs,
          assertDurableOwnership: ownership.assertOwned,
        });
        ownership.assertOwned();
        if (!attribution || attribution.kind === 'attribution_repair_scheduled') {
          exitReason = 'citadel_attribution_repair_scheduled';
          exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
          appendRunnerLog(sessionDir, options.runnerMode || 'pickle', 'Citadel attribution repair remains durable; scheduled autonomous restart.');
          break;
        }
        appendRunnerLog(sessionDir, options.runnerMode || 'pickle', `Citadel attribution resolved; narrow remediation enqueued for ${attribution.ticket_ids.join(', ')}.`);
        continue;
      }

      releaseGateHeld = true;
      ownership.assertOwned();
      const citadelExit = await (deps.runCitadel ?? runCitadel)(sessionDir, {
        assertDurableOwnership: ownership.assertOwned,
      });
      ownership.assertOwned();
      if (citadelExit === 'citadel-blocked') {
        const remediation = enqueueCitadelRemediationResult(sessionDir);
        if (remediation.kind === 'attribution_repair_scheduled') {
          const attribution = await repairAttributionFn(sessionDir, {
            timeoutMs: options.timeoutMs,
            assertDurableOwnership: ownership.assertOwned,
          });
          ownership.assertOwned();
          if (!attribution || attribution.kind === 'attribution_repair_scheduled') {
            exitReason = 'citadel_attribution_repair_scheduled';
            exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
            appendRunnerLog(sessionDir, options.runnerMode || 'pickle', `Citadel refusal preserved at ${remediation.archive_path}; attribution repair scheduled.`);
            releaseGateHeld = false;
            break;
          }
          appendRunnerLog(sessionDir, options.runnerMode || 'pickle', `Citadel attribution resolved; narrow remediation enqueued for ${attribution.ticket_ids.join(', ')}.`);
        } else {
          appendRunnerLog(sessionDir, options.runnerMode || 'pickle', `Citadel refusal preserved at ${remediation.archive_path}; autonomous remediation enqueued.`);
        }
        exitReason = 'success';
        releaseGateHeld = false;
        continue;
      }
      if (citadelExit === 'citadel-system-blocked') {
        const systemBlock = readCitadelSystemBlock(sessionDir);
        if (!systemBlock) throw new Error('Citadel system block result is missing its typed recovery artifact.');
        appendRunnerLog(
          sessionDir,
          options.runnerMode || 'pickle',
          `Citadel system block ${systemBlock.code} selected ${systemBlock.recovery_action}; attempt ${systemBlock.bounded_attempt}/2 in recovery epoch ${systemBlock.recovery_epoch}.`,
        );
        releaseGateHeld = false;
        if (systemBlock.recovery_action === 'request_prd_revision') {
          exitReason = 'prd_revision_required';
          exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
          requestPrdRevision(sessionDir, systemBlock.evidence, systemBlock.recommendation);
          break;
        }
        if (systemBlock.recovery_action === 'repair_verification_contract') {
          for (const ticketId of systemBlock.recovery_ticket_ids) {
            const priorEpochs = readUnresolvedRecoveryStrategyEpochs(sessionDir, ticketId).length;
            const route = recoveryRoute('contract');
            const strategy = beginRecoveryStrategyEpoch(sessionDir, {
              ticketId,
              domain: 'contract',
              handler: route.handler,
              checkpoint: route.invalidate[0] || 'prepare',
              constraints: [systemBlock.evidence],
              materialApproach: nextMaterialApproach('contract', priorEpochs),
            }, 'failure');
            await repairVerificationContractFn(sessionDir, ticketId, {
              strategy,
              timeoutMs: options.timeoutMs,
              assertDurableOwnership: ownership.assertOwned,
            });
            ownership.assertOwned();
            appendRunnerLog(
              sessionDir,
              options.runnerMode || 'pickle',
              `Citadel material verification-contract recovery rebuilt ${ticketId} with strategy ${strategy.materialApproach}.`,
            );
          }
          exitReason = 'success';
          continue;
        }
        if (systemBlock.recovery_action === 'repair_reviewer_artifact_contract') {
          const recovery = await (deps.repairCitadelReviewerArtifactContract ?? repairCitadelReviewerArtifactContract)(
            sessionDir,
            systemBlock,
            { timeoutMs: options.timeoutMs, assertDurableOwnership: ownership.assertOwned },
          );
          ownership.assertOwned();
          if (recovery.kind === 'recovery_scheduled') {
            exitReason = 'citadel_system_recovery_scheduled';
            exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
            break;
          }
          appendRunnerLog(
            sessionDir,
            options.runnerMode || 'pickle',
            `Resolved Citadel reviewer contract diagnostic ${recovery.diagnostic_identity}; retrying the release gate.`,
          );
          exitReason = 'success';
          continue;
        }
        if (systemBlock.next_action === 'retry_phase') continue;
        const deterministicRecovery = consumeDeterministicCheckFailure(sessionDir, systemBlock);
        if (deterministicRecovery.kind === 'diagnostic_recovery_scheduled') {
          const diagnostic = await (deps.runDeterministicRecoveryDiagnostic ?? runDeterministicRecoveryDiagnostic)(
            sessionDir,
            { timeoutMs: options.timeoutMs, assertDurableOwnership: ownership.assertOwned },
          );
          ownership.assertOwned();
          appendRunnerLog(
            sessionDir,
            options.runnerMode || 'pickle',
            diagnostic.kind === 'resolved'
              ? `Deterministic diagnostic mapped recovery to ${diagnostic.ticket_ids.join(', ')}.`
              : `Deterministic diagnostic retained a bounded retry: ${diagnostic.reason}`,
          );
        }
        appendRunnerLog(
          sessionDir,
          options.runnerMode || 'pickle',
          deterministicRecovery.kind === 'verification_repair_scheduled'
            ? `Scheduled ${deterministicRecovery.strategy_id} for exact deterministic-check owner ${deterministicRecovery.ticket_id}.`
            : `Scheduled autonomous ${deterministicRecovery.strategy_id}: ${deterministicRecovery.reason}`,
        );
        exitReason = 'citadel_system_recovery_scheduled';
        exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
        break;
      }
      exitReason = citadelExit;
      exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
      releaseGateHeld = false;
      break;
    }
    return exitReason;
  } catch (error) {
    if (isDurableOwnershipDrainError(error)) {
      exitReason = 'runtime_handoff';
      return exitReason;
    }
    if (releaseGateHeld) {
      exitMuxRunnerPhase(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason: 'error' });
    }
    throw error;
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
    handoffRequestId: argv.find((arg) => arg.startsWith('--handoff-request='))?.split('=')[1],
    targetRuntime: (() => {
      const encoded = argv.find((arg) => arg.startsWith('--target-runtime='))?.split('=')[1];
      return encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : undefined;
    })(),
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
    || exitReason === 'citadel-blocked'
    || String(exitReason).startsWith('preflight-')
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
