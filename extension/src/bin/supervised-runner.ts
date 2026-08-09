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

const ALLOWED_RUNNERS = new Set(['mux-runner.js', 'pipeline-runner.js']);

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

export function supervisedRunnerDecision(sessionDir: string): 'restart' | 'wait_for_prd' | 'wait_for_handoff' | 'completed' | 'cancelled' {
  abortExpiredRuntimeHandoff(sessionDir);
  const logical = readLogicalPipeline(sessionDir);
  if (logical.terminal_state === 'completed') return 'completed';
  if (logical.terminal_state === 'cancelled') return 'cancelled';
  if (hasPendingRuntimeHandoff(sessionDir)) return 'wait_for_handoff';
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
  const acceptingHandoff = runnerArgs.some((arg) => arg.startsWith('--handoff-request='));
  let restartCount = 0;

  while (true) {
    const before = supervisedRunnerDecision(sessionDir);
    if (before === 'completed') return 0;
    if (before === 'cancelled') return 130;
    if (before === 'wait_for_prd' || (before === 'wait_for_handoff' && !acceptingHandoff)) {
      await delay(1_000);
      continue;
    }

    appendLog(sessionDir, `launching ${runnerBin} executor restart=${restartCount}`);
    const child = spawn(process.execPath, [runnerPath, sessionDir, ...runnerArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    testOptions.onExecutorIdentity?.(child.pid ? captureProcessLivenessIdentity(child.pid) : null);
    const exitCode = await waitForExit(child);
    assertRecordedActiveChildRecovered(sessionDir, new StateManager());
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
    throw new Error('Usage: node bin/supervised-runner.js <session-dir> --runner-bin=mux-runner.js|pipeline-runner.js [runner args]');
  }
  const forwarded = argv.filter((arg) => arg !== sessionDir && arg !== runnerArg);
  const acceptingHandoff = forwarded.some((arg) => arg.startsWith('--handoff-request='));
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
