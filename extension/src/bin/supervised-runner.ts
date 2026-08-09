#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abortExpiredRuntimeHandoff, hasPendingRuntimeHandoff, readLogicalPipeline } from '../services/durable-supervisor.js';
import {
  reconcileInterruptedModelCallTelemetry,
  recordUnexpectedNoncompletionTermination,
} from '../services/productive-autonomy.js';
import {
  assertRecordedActiveChildRecovered,
  captureProcessLivenessIdentity,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';
import { reconcileValidatedCitadelTelemetry } from '../services/citadel.js';
import {
  ensureAutonomousOwnerRecoveryDaemon,
  reconcileAutonomousOwnerHandoffTransaction,
  registerAutonomousOwnerSpec,
} from '../services/autonomous-owner-recovery.js';

const ALLOWED_RUNNERS = new Set(['mux-runner.js', 'pipeline-runner.js', 'loop-runner.js']);

function appendLog(sessionDir: string, message: string): void {
  fs.appendFileSync(path.join(sessionDir, 'supervisor.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initializeAutonomousOwnerRecovery(
  sessionDir: string,
  runnerBin: string,
  forwarded: string[],
  runtimeBin: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const spec = registerAutonomousOwnerSpec(
        sessionDir,
        runnerBin,
        forwarded,
        undefined,
        path.join(runtimeBin, 'supervised-runner.js'),
      );
      if (spec) ensureAutonomousOwnerRecoveryDaemon(sessionDir, runtimeBin);
      return;
    } catch (error) {
      if (!(error instanceof Error)
        || !error.message.includes('without an exact tmux runner binding')
        || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

export function recordSupervisorSignalTermination(
  sessionDir: string,
  reason: string,
  acceptingHandoff: boolean,
  executorIdentity: PersistedProcessIdentity | null = null,
): boolean {
  return recordUnexpectedNoncompletionTermination(sessionDir, reason, {
    sourceExecutorIdentity: acceptingHandoff ? null : executorIdentity,
  });
}

export function supervisedRunnerDecision(
  sessionDir: string,
  nowMs = Date.now(),
): 'restart' | 'wait_for_budget' | 'wait_for_prd' | 'wait_for_handoff' | 'completed' | 'cancelled' {
  abortExpiredRuntimeHandoff(sessionDir);
  const logical = readLogicalPipeline(sessionDir);
  if (logical.terminal_state === 'completed') return 'completed';
  if (logical.terminal_state === 'cancelled') return 'cancelled';
  if (hasPendingRuntimeHandoff(sessionDir)) return 'wait_for_handoff';
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  const budgetWakeupMs = Date.parse(String(state.autonomous_relaunch_not_before || ''));
  if (state.active === true && state.last_exit_reason === 'autonomous_budget_rollover'
    && Number.isFinite(budgetWakeupMs) && budgetWakeupMs > nowMs) return 'wait_for_budget';
  return logical.control_state === 'prd_revision_required' ? 'wait_for_prd' : 'restart';
}

export async function runSupervisedRunner(
  sessionDir: string,
  runnerBin: string,
  runnerArgs: string[],
  testOptions: {
    runnerPath?: string;
    restartDelayMs?: number;
    onExecutorIdentity?: (identity: PersistedProcessIdentity | null) => void;
  } = {},
): Promise<number> {
  if (!ALLOWED_RUNNERS.has(runnerBin) || path.basename(runnerBin) !== runnerBin) {
    throw new Error(`Unsupported supervised runner: ${runnerBin}.`);
  }
  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const runnerPath = testOptions.runnerPath || path.join(runtimeBin, runnerBin);
  let acceptingHandoff = runnerArgs.some((arg) => arg.startsWith('--handoff-request='));
  let effectiveRunnerArgs = [...runnerArgs];
  let restartCount = 0;

  while (true) {
    if (acceptingHandoff && !hasPendingRuntimeHandoff(sessionDir)) {
      const handoffRecovery = reconcileAutonomousOwnerHandoffTransaction(sessionDir);
      if (handoffRecovery === 'rolled_back') return 1;
      const handoffState = new StateManager().read(path.join(sessionDir, 'state.json'));
      if (handoffState.autonomous_owner_recovery_suspended === true) {
        await delay(1_000);
        continue;
      }
      if (handoffState.recovery_required === true) return 1;
      effectiveRunnerArgs = effectiveRunnerArgs.filter((arg) => (
        !arg.startsWith('--handoff-request=') && !arg.startsWith('--target-runtime=')
      ));
      acceptingHandoff = false;
    }
    if (!acceptingHandoff) ensureAutonomousOwnerRecoveryDaemon(sessionDir, runtimeBin);
    const before = supervisedRunnerDecision(sessionDir);
    if (before === 'completed') return 0;
    if (before === 'cancelled') return 130;
    if (before === 'wait_for_budget' || before === 'wait_for_prd'
      || (before === 'wait_for_handoff' && !acceptingHandoff)) {
      await delay(1_000);
      continue;
    }

    appendLog(sessionDir, `launching ${runnerBin} executor restart=${restartCount}`);
    const child = spawn(process.execPath, [runnerPath, sessionDir, ...effectiveRunnerArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    testOptions.onExecutorIdentity?.(child.pid ? captureProcessLivenessIdentity(child.pid) : null);
    const exitCode = await waitForExit(child);
    assertRecordedActiveChildRecovered(sessionDir, new StateManager());
    reconcileValidatedCitadelTelemetry(sessionDir);
    reconcileInterruptedModelCallTelemetry(sessionDir, {
      reason: 'supervised_executor_exit',
      sourceOwnerId: child.pid ? `process:${child.pid}` : null,
    });
    const decision = supervisedRunnerDecision(sessionDir);
    appendLog(sessionDir, `${runnerBin} exited code=${exitCode}; decision=${decision}`);
    if (decision === 'completed') return 0;
    if (decision === 'cancelled') return 130;
    restartCount += 1;
    await delay(testOptions.restartDelayMs ?? Math.min(30_000, 250 * (2 ** Math.min(restartCount, 7))));
  }
}

async function main(argv: string[]): Promise<void> {
  const runnerArg = argv.find((arg) => arg.startsWith('--runner-bin='));
  const runnerBin = runnerArg?.slice('--runner-bin='.length) || '';
  const sessionDir = argv.find((arg) => !arg.startsWith('--')) || '';
  if (!sessionDir || !runnerBin) {
    throw new Error('Usage: node bin/supervised-runner.js <session-dir> --runner-bin=mux-runner.js|pipeline-runner.js|loop-runner.js [runner args]');
  }
  const forwarded = argv.filter((arg) => arg !== sessionDir && arg !== runnerArg);
  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const acceptingHandoff = forwarded.some((arg) => arg.startsWith('--handoff-request='));
  if (!acceptingHandoff) {
    await initializeAutonomousOwnerRecovery(sessionDir, runnerBin, forwarded, runtimeBin);
  }
  let executorIdentity: PersistedProcessIdentity | null = null;
  const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      try {
        recordSupervisorSignalTermination(sessionDir, `supervisor received ${signal}`, acceptingHandoff, executorIdentity);
      } finally {
        process.exit(signalExitCodes[signal] || 1);
      }
    });
  }
  process.exitCode = await runSupervisedRunner(sessionDir, runnerBin, forwarded, {
    onExecutorIdentity: (identity) => { executorIdentity = identity; },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const sessionDir = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
    try {
      if (sessionDir) recordUnexpectedNoncompletionTermination(sessionDir, `supervisor fatal error: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // Preserve the original fatal exit even if its telemetry journal is damaged.
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
