#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalPipeline } from '../services/durable-supervisor.js';

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

export function supervisedRunnerDecision(sessionDir: string): 'restart' | 'wait_for_prd' | 'completed' | 'cancelled' {
  const logical = readLogicalPipeline(sessionDir);
  if (logical.terminal_state === 'completed') return 'completed';
  if (logical.terminal_state === 'cancelled') return 'cancelled';
  return logical.control_state === 'prd_revision_required' ? 'wait_for_prd' : 'restart';
}

export async function runSupervisedRunner(
  sessionDir: string,
  runnerBin: string,
  runnerArgs: string[],
  testOptions: { runnerPath?: string; restartDelayMs?: number } = {},
): Promise<number> {
  if (!ALLOWED_RUNNERS.has(runnerBin) || path.basename(runnerBin) !== runnerBin) {
    throw new Error(`Unsupported supervised runner: ${runnerBin}.`);
  }
  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const runnerPath = testOptions.runnerPath || path.join(runtimeBin, runnerBin);
  let restartCount = 0;

  while (true) {
    const before = supervisedRunnerDecision(sessionDir);
    if (before === 'completed') return 0;
    if (before === 'cancelled') return 130;
    if (before === 'wait_for_prd') {
      await delay(1_000);
      continue;
    }

    appendLog(sessionDir, `launching ${runnerBin} executor restart=${restartCount}`);
    const child = spawn(process.execPath, [runnerPath, sessionDir, ...runnerArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    const exitCode = await waitForExit(child);
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
  process.exitCode = await runSupervisedRunner(sessionDir, runnerBin, forwarded);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
