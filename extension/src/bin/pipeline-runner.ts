#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPipelineContract, resolveNextPipelinePhase } from '../services/pipeline.js';
import { PipelineScopeError, resolvePipelineScope } from '../services/pipeline-scope.js';
import {
  beginPipelinePhase,
  cancelPipelineSession,
  ensurePipelineState,
  finishPipelinePhase,
  resetPipelineForAutonomousRemediation,
} from '../services/pipeline-state.js';
import {
  preparePipelineAnatomyParkPhase,
  preparePipelineLoopPhaseSession,
  preparePipelineSzechuanSaucePhase,
} from '../services/pipeline-phase-setup.js';
import { atomicWriteJson, ensureDir, readJsonFile } from '../services/pickle-utils.js';
import { getRunnerDescriptor } from '../services/runner-descriptors.js';
import { StateManager } from '../services/state-manager.js';
import { finalizeTerminalState } from '../services/state-terminal.js';
import { acquireSessionOperation } from '../services/session-operation.js';
import { runLoop } from './loop-runner.js';
import { runSequential } from './mux-runner.js';
import { runCitadel } from '../services/citadel.js';
import type { PipelineContract, PipelinePhase } from '../types/index.js';
import { startDurableRuntimeOwnership } from '../services/durable-runtime.js';
import { readManifest, updateTicketStatus } from '../services/tickets.js';

type PreparePipelineLoopPhase = Parameters<typeof preparePipelineLoopPhaseSession>[2];

interface RunPipelineOptions {
  onFailure?: string;
  assertDurableOwnership?: () => void;
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
  return exitReason !== 'success';
}

function readSessionExitReason(sessionDir: string): string {
  return (readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), {})?.last_exit_reason as string | undefined) || 'error';
}

export function enqueueCitadelRemediation(sessionDir: string): string {
  const report = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'citadel-report.json'), null);
  if (!report) throw new Error('Citadel refusal did not persist a remediation report.');
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const summary = findings
    .map((finding) => String((finding as Record<string, unknown>)?.title || '').trim())
    .filter(Boolean)
    .join('; ') || 'Citadel release gate refused the candidate.';
  const archiveDir = ensureDir(path.join(sessionDir, 'citadel-remediation'));
  const archivePath = path.join(archiveDir, `citadel-report-${Date.now()}-${crypto.randomUUID()}.json`);
  atomicWriteJson(archivePath, report);

  const tickets = readManifest(sessionDir).tickets;
  const affected = tickets.filter((ticket) => String(ticket.status || '').trim().toLowerCase() === 'done');
  if (affected.length === 0) throw new Error('Citadel refusal has no completed ticket to remediate.');
  atomicWriteJson(path.join(sessionDir, 'citadel-remediation-pending.json'), {
    schema_version: 1,
    archive_path: archivePath,
    ticket_ids: affected.map((ticket) => ticket.id),
    summary,
  });
  reconcileCitadelRemediation(sessionDir);
  return archivePath;
}

export function reconcileCitadelRemediation(sessionDir: string): boolean {
  const pendingPath = path.join(sessionDir, 'citadel-remediation-pending.json');
  const pending = readJsonFile<Record<string, unknown>>(pendingPath, null);
  if (!pending) return false;
  if (pending.schema_version !== 1 || !Array.isArray(pending.ticket_ids) || typeof pending.summary !== 'string') {
    throw new Error('Citadel remediation intent is invalid.');
  }
  for (const ticketId of pending.ticket_ids) {
    updateTicketStatus(sessionDir, String(ticketId), {
      status: 'Todo',
      recovery_task: `Remediate preserved Citadel findings: ${pending.summary}`,
      citadel_report: pending.archive_path,
      citadel_remediation_enqueued_at: new Date().toISOString(),
    });
  }
  resetPipelineForAutonomousRemediation(sessionDir, pending.summary);
  fs.rmSync(pendingPath, { force: true });
  return true;
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
  appendRunnerLog(sessionDir, getRunnerDescriptor('pipeline').runnerStartMarker);
  try {
    const pipeline = readPipelineContract(sessionDir);
    let pipelineState = ensurePipelineState(sessionDir, pipeline);
    if (reconcileCitadelRemediation(sessionDir)) {
      pipelineState = ensurePipelineState(sessionDir, pipeline);
      appendRunnerLog(sessionDir, 'Recovered pending Citadel remediation intent.');
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
          async () => await runSequential(sessionDir, {
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
          async () => await runCitadel(sessionDir),
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
        const archivePath = enqueueCitadelRemediation(sessionDir);
        appendRunnerLog(sessionDir, `Citadel refusal preserved at ${archivePath}; autonomous remediation enqueued.`);
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
    ownership = startDurableRuntimeOwnership(sessionDir);
    exitReason = await runPipelineWithLease(sessionDir, {
      ...options,
      onFailure: 'retry',
      assertDurableOwnership: ownership.assertOwned,
    }, runStartedAtMs);
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
    throw new Error('Usage: node bin/pipeline-runner.js <session-dir> [--on-failure=abort|skip|retry-once|retry]');
  }
  const exitReason = await runPipeline(sessionDir, {
    onFailure: parseFailureMode(argv),
    launchOwnerPid: parseLaunchOwnerPid(argv),
    runStartedAtMs: parseRunStartedAtMs(argv),
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
