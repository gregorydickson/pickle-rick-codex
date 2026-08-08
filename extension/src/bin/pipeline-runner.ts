#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPipelineContract, resolveNextPipelinePhase } from '../services/pipeline.js';
import { PipelineScopeError, resolvePipelineScope } from '../services/pipeline-scope.js';
import {
  beginPipelinePhase,
  cancelPipelineSession,
  ensurePipelineState,
  finishPipelinePhase,
} from '../services/pipeline-state.js';
import {
  preparePipelineAnatomyParkPhase,
  preparePipelineLoopPhaseSession,
  preparePipelineSzechuanSaucePhase,
} from '../services/pipeline-phase-setup.js';
import { readJsonFile } from '../services/pickle-utils.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager } from '../services/state-manager.js';
import { finalizeTerminalState } from '../services/state-terminal.js';
import { acquireSessionOperation } from '../services/session-operation.js';
import { runLoop } from './loop-runner.js';
import { runSequential } from './mux-runner.js';
import { runCitadel } from '../services/citadel.js';
import type { PipelineContract, PipelinePhase } from '../types/index.js';
import { isDurableOwnershipDrainError, startDurableRuntimeOwnership } from '../services/durable-runtime.js';
import { finalizeLiveSessionMigrationAfterHandoff } from '../services/live-session-migration.js';
import {
  enqueueCitadelRemediationResult,
  reconcileCitadelAttributionRepair,
  reconcileCitadelRemediation,
  repairCitadelAttribution,
} from '../services/citadel-remediation.js';

export { enqueueCitadelRemediation, reconcileCitadelRemediation } from '../services/citadel-remediation.js';

type PreparePipelineLoopPhase = Parameters<typeof preparePipelineLoopPhaseSession>[2];

interface RunPipelineOptions {
  onFailure?: string;
  assertDurableOwnership?: () => void;
  handoffRequestId?: string;
  targetRuntime?: import('../services/durable-supervisor.js').InstalledRuntimeDescriptor;
  runSequential?: typeof runSequential;
  runCitadel?: typeof runCitadel;
  repairCitadelAttribution?: typeof repairCitadelAttribution;
  [key: string]: unknown;
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

export function parsePipelineHandoffOptions(argv: string[]): Pick<RunPipelineOptions, 'handoffRequestId' | 'targetRuntime'> {
  const handoffRequestId = argv.find((arg) => arg.startsWith('--handoff-request='))?.split('=')[1];
  const encoded = argv.find((arg) => arg.startsWith('--target-runtime='))?.split('=')[1];
  return {
    handoffRequestId,
    targetRuntime: encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : undefined,
  };
}

function appendRunnerLog(sessionDir: string, message: string): void {
  const descriptor = getRunnerDescriptor('pipeline');
  fs.appendFileSync(
    path.join(sessionDir, descriptor.runnerLog),
    `[${new Date().toISOString()}] ${message}\n`,
    { mode: 0o600 },
  );
}

function phaseFailureMessage(phase: string, exitReason: string): string | null {
  return exitReason === 'success' ? null : `${phase} phase exited with ${exitReason}`;
}

function isBlockingExitReason(exitReason: string): boolean {
  return exitReason === 'verification-contract-failed'
    || exitReason === 'scope-violation'
    || String(exitReason).startsWith('preflight-');
}

export function pipelineExitFailed(exitReason: string): boolean {
  return exitReason !== 'success'
    && exitReason !== 'dependency_repair_scheduled'
    && exitReason !== 'citadel_attribution_repair_scheduled';
}

function readSessionExitReason(sessionDir: string): string {
  return (readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), {})?.last_exit_reason as string | undefined) || 'error';
}

function recordAttributionRepairWakeup(sessionDir: string): void {
  const exitReason = 'citadel_attribution_repair_scheduled';
  finishPipelinePhase(sessionDir, 'citadel', { exitReason });
  new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
    state.last_exit_reason = exitReason;
    state.step = 'paused';
    return state;
  });
}

async function runPipelinePhase(
  sessionDir: string,
  phase: PipelinePhase,
  runStartedAtMs: number,
  executePhase: () => Promise<string>,
): Promise<string> {
  beginPipelinePhase(sessionDir, phase, { runnerPid: process.pid, runStartedAtMs });
  try {
    const exitReason = await executePhase();
    if (exitReason === 'cancelled') {
      cancelPipelineSession(sessionDir, {
        phase,
        exitReason,
      });
    } else {
      finishPipelinePhase(sessionDir, phase, {
        exitReason,
        lastError: phaseFailureMessage(phase, exitReason),
      });
    }
    return exitReason;
  } catch (error) {
    const recordedExitReason = readSessionExitReason(sessionDir);
    if (recordedExitReason === 'cancelled') {
      cancelPipelineSession(sessionDir, {
        phase,
        exitReason: 'cancelled',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const phaseExitReason = error instanceof PipelineScopeError
      ? 'scope-violation'
      : isBlockingExitReason(recordedExitReason) ? recordedExitReason : 'error';
    finishPipelinePhase(sessionDir, phase, {
      exitReason: phaseExitReason,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runPipelineLoopPhase(
  sessionDir: string,
  phase: PipelinePhase,
  pipeline: PipelineContract,
  preparePhase: PreparePipelineLoopPhase,
  runStartedAtMs: number,
): Promise<string> {
  return await runPipelinePhase(sessionDir, phase, runStartedAtMs, async () => {
    const scope = resolvePipelineScope(sessionDir, pipeline);
    appendRunnerLog(sessionDir, `${phase} immutable scope (${scope.source}): ${scope.paths.join(', ')}`);
    await preparePipelineLoopPhaseSession(sessionDir, pipeline, preparePhase, scope.paths);
    await runLoop(sessionDir, {
      operationLeaseHeld: true,
      runStartedAtMs,
    });
    return readSessionExitReason(sessionDir);
  });
}

async function runPipelineWithLease(
  sessionDir: string,
  options: RunPipelineOptions = {},
  runStartedAtMs: number,
): Promise<string> {
  let exitReason = 'error';
  const runSequentialFn = options.runSequential ?? runSequential;
  const runCitadelFn = options.runCitadel ?? runCitadel;
  const repairAttributionFn = options.repairCitadelAttribution ?? repairCitadelAttribution;
  appendRunnerLog(sessionDir, getRunnerDescriptor('pipeline').runnerStartMarker);
  try {
    const pipeline = readPipelineContract(sessionDir);
    let pipelineState = ensurePipelineState(sessionDir, pipeline);
    if (reconcileCitadelRemediation(sessionDir)) {
      pipelineState = ensurePipelineState(sessionDir, pipeline);
      appendRunnerLog(sessionDir, 'Recovered pending Citadel remediation intent.');
    }
    if (reconcileCitadelAttributionRepair(sessionDir)) {
      options.assertDurableOwnership?.();
      const attribution = await repairAttributionFn(sessionDir, {
        timeoutMs: Number(options.timeoutMs) || undefined,
        assertDurableOwnership: options.assertDurableOwnership,
      });
      options.assertDurableOwnership?.();
      if (!attribution || attribution.kind === 'attribution_repair_scheduled') {
        recordAttributionRepairWakeup(sessionDir);
        appendRunnerLog(sessionDir, 'Citadel attribution repair remains durable; scheduled autonomous restart.');
        return 'citadel_attribution_repair_scheduled';
      }
      pipelineState = ensurePipelineState(sessionDir, pipeline);
      appendRunnerLog(sessionDir, `Citadel attribution resolved; narrow remediation enqueued for ${attribution.ticket_ids.join(', ')}.`);
    }
    let nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
    exitReason = 'success';
    while (nextPhase) {
      options.assertDurableOwnership?.();
      if (nextPhase === 'pickle') {
        exitReason = await runPipelinePhase(
          sessionDir,
          'pickle',
          runStartedAtMs,
          async () => await runSequentialFn(sessionDir, {
            ...options,
            runnerMode: 'pipeline',
            operationLeaseHeld: true,
            durableOwnershipHeld: options.assertDurableOwnership !== undefined,
            assertDurableOwnership: options.assertDurableOwnership,
            runStartedAtMs,
          }),
        );
      } else if (nextPhase === 'citadel') {
        exitReason = await runPipelinePhase(
          sessionDir,
          'citadel',
          runStartedAtMs,
          async () => await runCitadelFn(sessionDir, { assertDurableOwnership: options.assertDurableOwnership }),
        );
      } else if (nextPhase === 'anatomy-park') {
        exitReason = await runPipelineLoopPhase(
          sessionDir,
          'anatomy-park',
          pipeline,
          preparePipelineAnatomyParkPhase,
          runStartedAtMs,
        );
      } else if (nextPhase === 'szechuan-sauce') {
        exitReason = await runPipelineLoopPhase(
          sessionDir,
          'szechuan-sauce',
          pipeline,
          preparePipelineSzechuanSaucePhase,
          runStartedAtMs,
        );
      } else {
        throw new Error(`Unsupported pipeline phase: ${nextPhase}.`);
      }

      if (nextPhase === 'citadel' && exitReason === 'citadel-blocked') {
        options.assertDurableOwnership?.();
        const remediation = enqueueCitadelRemediationResult(sessionDir);
        options.assertDurableOwnership?.();
        if (remediation.kind === 'attribution_repair_scheduled') {
          const attribution = await repairAttributionFn(sessionDir, {
            timeoutMs: Number(options.timeoutMs) || undefined,
            assertDurableOwnership: options.assertDurableOwnership,
          });
          options.assertDurableOwnership?.();
          if (!attribution || attribution.kind === 'attribution_repair_scheduled') {
            recordAttributionRepairWakeup(sessionDir);
            appendRunnerLog(sessionDir, `Citadel refusal preserved at ${remediation.archive_path}; attribution repair scheduled.`);
            return 'citadel_attribution_repair_scheduled';
          }
          appendRunnerLog(sessionDir, `Citadel attribution resolved; narrow remediation enqueued for ${attribution.ticket_ids.join(', ')}.`);
        } else {
          appendRunnerLog(sessionDir, `Citadel refusal preserved at ${remediation.archive_path}; autonomous remediation enqueued.`);
        }
        exitReason = 'success';
        pipelineState = ensurePipelineState(sessionDir, pipeline);
        nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
        continue;
      }

      if (exitReason !== 'success') {
        return exitReason;
      }

      pipelineState = ensurePipelineState(sessionDir, pipeline);
      nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
      if (nextPhase == null) {
        return 'success';
      }
    }

    return 'success';
  } catch (error) {
    const recordedExitReason = readSessionExitReason(sessionDir);
    exitReason = error instanceof PipelineScopeError
      ? 'scope-violation'
      : recordedExitReason === 'cancelled' ? 'cancelled'
      : isBlockingExitReason(recordedExitReason) ? recordedExitReason : 'error';
    try {
      finalizeTerminalState(new StateManager(), path.join(sessionDir, 'state.json'), { exitReason });
    } catch (finalizeError) {
      throw new AggregateError(
        [error, finalizeError],
        'Pipeline failed and terminal state finalization did not complete.',
        { cause: finalizeError },
      );
    }
    throw error;
  } finally {
    appendRunnerLog(sessionDir, `pipeline-runner finished: ${exitReason}`);
  }
}

export async function runPipeline(sessionDir: string, options: RunPipelineOptions = {}): Promise<string> {
  const configuredRunStartedAtMs = Number(options.runStartedAtMs);
  const runStartedAtMs = Number.isFinite(configuredRunStartedAtMs) && configuredRunStartedAtMs > 0
    ? configuredRunStartedAtMs
    : Date.now();
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
      return await runPipelineWithLease(sessionDir, options, runStartedAtMs);
    } finally {
      releaseOperation();
    }
  }
  let ownership: ReturnType<typeof startDurableRuntimeOwnership> | null = null;
  let exitReason = 'error';
  try {
    ownership = startDurableRuntimeOwnership(sessionDir, {
      handoffRequestId: typeof options.handoffRequestId === 'string' ? options.handoffRequestId : undefined,
      targetRuntime: options.targetRuntime,
    });
    if (typeof options.handoffRequestId === 'string' && options.targetRuntime) {
      ownership.assertOwned();
      finalizeLiveSessionMigrationAfterHandoff(sessionDir, options.handoffRequestId, options.targetRuntime);
      ownership.assertOwned();
    }
    exitReason = await runPipelineWithLease(sessionDir, {
      ...options,
      onFailure: 'retry',
      assertDurableOwnership: ownership.assertOwned,
    }, runStartedAtMs);
    return exitReason;
  } catch (error) {
    if (isDurableOwnershipDrainError(error)) {
      exitReason = 'runtime_handoff';
      return exitReason;
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
    throw new Error('Usage: node bin/pipeline-runner.js <session-dir> [--on-failure=abort|skip|retry-once|retry]');
  }
  const exitReason = await runPipeline(sessionDir, {
    onFailure: parseFailureMode(argv),
    launchOwnerPid: parseLaunchOwnerPid(argv),
    runStartedAtMs: parseRunStartedAtMs(argv),
    ...parsePipelineHandoffOptions(argv),
  });
  if (pipelineExitFailed(exitReason)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
