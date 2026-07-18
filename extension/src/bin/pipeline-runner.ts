#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPipelineContract, resolveNextPipelinePhase } from '../services/pipeline.js';
import { PipelineScopeError, resolvePipelineScope } from '../services/pipeline-scope.js';
import { beginPipelinePhase, cancelPipelineSession, ensurePipelineState, finishPipelinePhase } from '../services/pipeline-state.js';
import {
  preparePipelineAnatomyParkPhase,
  preparePipelineLoopPhaseSession,
  preparePipelineSzechuanSaucePhase,
} from '../services/pipeline-phase-setup.js';
import { readJsonFile } from '../services/pickle-utils.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager } from '../services/state-manager.js';
import { finalizeTerminalState } from '../services/state-terminal.js';
import { runLoop } from './loop-runner.js';
import { runSequential } from './mux-runner.js';
import { runCitadel } from '../services/citadel.js';
import type { PipelineContract, PipelinePhase } from '../types/index.js';

type PreparePipelineLoopPhase = Parameters<typeof preparePipelineLoopPhaseSession>[2];

interface RunPipelineOptions {
  onFailure?: string;
  [key: string]: unknown;
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

function readSessionExitReason(sessionDir: string): string {
  return (readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), {})?.last_exit_reason as string | undefined) || 'error';
}

async function runPipelinePhase(sessionDir: string, phase: PipelinePhase, executePhase: () => Promise<string>): Promise<string> {
  beginPipelinePhase(sessionDir, phase, { runnerPid: process.pid });
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
): Promise<string> {
  return await runPipelinePhase(sessionDir, phase, async () => {
    const scope = resolvePipelineScope(sessionDir, pipeline);
    appendRunnerLog(sessionDir, `${phase} immutable scope (${scope.source}): ${scope.paths.join(', ')}`);
    await preparePipelineLoopPhaseSession(sessionDir, pipeline, preparePhase, scope.paths);
    await runLoop(sessionDir);
    return readSessionExitReason(sessionDir);
  });
}

export async function runPipeline(sessionDir: string, options: RunPipelineOptions = {}): Promise<string> {
  let exitReason = 'error';
  appendRunnerLog(sessionDir, getRunnerDescriptor('pipeline').runnerStartMarker);
  try {
    const pipeline = readPipelineContract(sessionDir);
    let pipelineState = ensurePipelineState(sessionDir, pipeline);
    let nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
    exitReason = 'success';
    while (nextPhase) {
      if (nextPhase === 'pickle') {
        exitReason = await runPipelinePhase(
          sessionDir,
          'pickle',
          async () => await runSequential(sessionDir, {
            ...options,
            runnerMode: 'pipeline',
          }),
        );
      } else if (nextPhase === 'citadel') {
        exitReason = await runPipelinePhase(
          sessionDir,
          'citadel',
          async () => await runCitadel(sessionDir),
        );
      } else if (nextPhase === 'anatomy-park') {
        exitReason = await runPipelineLoopPhase(
          sessionDir,
          'anatomy-park',
          pipeline,
          preparePipelineAnatomyParkPhase,
        );
      } else if (nextPhase === 'szechuan-sauce') {
        exitReason = await runPipelineLoopPhase(
          sessionDir,
          'szechuan-sauce',
          pipeline,
          preparePipelineSzechuanSaucePhase,
        );
      } else {
        throw new Error(`Unsupported pipeline phase: ${nextPhase}.`);
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

async function main(argv: string[]): Promise<void> {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/pipeline-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  const exitReason = await runPipeline(sessionDir, { onFailure: parseFailureMode(argv) });
  if (
    exitReason === 'error'
    || exitReason === 'no_tickets'
    || exitReason === 'invalid_session'
    || isBlockingExitReason(exitReason)
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
