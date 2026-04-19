#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPipelineContract, resolveNextPipelinePhase } from '../lib/pipeline.js';
import { beginPipelinePhase, cancelPipelineSession, ensurePipelineState, finishPipelinePhase } from '../lib/pipeline-state.js';
import {
  preparePipelineAnatomyParkPhase,
  preparePipelineLoopPhaseSession,
  preparePipelineSzechuanSaucePhase,
} from '../lib/pipeline-phase-setup.js';
import { readJsonFile } from '../lib/pickle-utils.js';
import { getRunnerDescriptor } from '../lib/runner-descriptors.js';
import { runLoop } from './loop-runner.js';
import { runSequential } from './mux-runner.js';

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'abort';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function appendRunnerLog(sessionDir, message) {
  const descriptor = getRunnerDescriptor('pipeline');
  fs.appendFileSync(
    path.join(sessionDir, descriptor.runnerLog),
    `[${new Date().toISOString()}] ${message}\n`,
    { mode: 0o600 },
  );
}

function phaseFailureMessage(phase, exitReason) {
  return exitReason === 'success' ? null : `${phase} phase exited with ${exitReason}`;
}

function isBlockingExitReason(exitReason) {
  return exitReason === 'verification-contract-failed' || String(exitReason).startsWith('preflight-');
}

function readSessionExitReason(sessionDir) {
  return readJsonFile(path.join(sessionDir, 'state.json'), {})?.last_exit_reason || 'error';
}

async function runPipelinePhase(sessionDir, phase, executePhase) {
  beginPipelinePhase(sessionDir, phase);
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
    finishPipelinePhase(sessionDir, phase, {
      exitReason: 'error',
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runPipelineLoopPhase(sessionDir, phase, pipeline, preparePhase) {
  return await runPipelinePhase(sessionDir, phase, async () => {
    await preparePipelineLoopPhaseSession(sessionDir, pipeline, preparePhase);
    await runLoop(sessionDir);
    return readSessionExitReason(sessionDir);
  });
}

export async function runPipeline(sessionDir, options = {}) {
  const pipeline = readPipelineContract(sessionDir);
  let pipelineState = ensurePipelineState(sessionDir, pipeline);
  let nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
  let exitReason = 'success';

  appendRunnerLog(sessionDir, getRunnerDescriptor('pipeline').runnerStartMarker);
  try {
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
    exitReason = 'error';
    throw error;
  } finally {
    appendRunnerLog(sessionDir, `pipeline-runner finished: ${exitReason}`);
  }
}

async function main(argv) {
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
