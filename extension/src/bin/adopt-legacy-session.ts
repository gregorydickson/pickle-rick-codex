#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  adoptActiveLegacyMuxSession,
  launchAdoptedLegacySession,
  runtimeRootMatchesDescriptor,
} from '../services/legacy-session-adoption.js';
import type { InstalledRuntimeDescriptor } from '../services/durable-supervisor.js';

interface Args {
  command: 'prepare' | 'launch' | 'watch';
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function chooseLegacyLaunchRuntime(
  canonicalRuntimeRoot: string,
  fallbackRuntimeRoot: string,
  targetRuntime: InstalledRuntimeDescriptor,
  options: { timeoutMs?: number; intervalMs?: number; now?: () => number; wait?: (milliseconds: number) => void } = {},
): { runtimeRoot: string; fallback: boolean } {
  const timeoutMs = options.timeoutMs ?? Number(process.env.PICKLE_ADOPTION_CANONICAL_WAIT_MS || 30_000);
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now || Date.now;
  const wait = options.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    if (runtimeRootMatchesDescriptor(canonicalRuntimeRoot, targetRuntime)) {
      return { runtimeRoot: canonicalRuntimeRoot, fallback: false };
    }
    if (now() >= deadline) return { runtimeRoot: fallbackRuntimeRoot, fallback: true };
    wait(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
}

function valueAfter(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return path.resolve(value);
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'prepare' && command !== 'launch' && command !== 'watch') {
    throw new Error('Usage: adopt-legacy-session.js prepare|watch --session-dir DIR --source-runtime-root DIR --target-runtime-root DIR | launch --session-dir DIR --target-runtime-root DIR');
  }
  return {
    command,
    sessionDir: valueAfter(argv, '--session-dir'),
    sourceRuntimeRoot: command !== 'launch' ? valueAfter(argv, '--source-runtime-root') : '',
    targetRuntimeRoot: valueAfter(argv, '--target-runtime-root'),
  };
}

export function runLegacyAdoptionCli(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.command === 'watch') {
    for (;;) {
      try {
        const adopted = adoptActiveLegacyMuxSession(args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot, { startWatchdog: () => undefined });
        const selected = chooseLegacyLaunchRuntime(
          args.sourceRuntimeRoot,
          args.targetRuntimeRoot,
          adopted.target_runtime,
        );
        const result = launchAdoptedLegacySession(args.sessionDir, selected.runtimeRoot);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      } catch {
        Atomics.wait(waitBuffer, 0, 0, 250);
      }
    }
  }
  const result = args.command === 'prepare'
    ? adoptActiveLegacyMuxSession(args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot, {
      startWatchdog: (sessionDir, sourceRoot, targetRoot) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--session-dir', sessionDir,
          '--source-runtime-root', sourceRoot, '--target-runtime-root', targetRoot], {
          detached: true, stdio: 'ignore', env: process.env,
        });
        child.unref();
      },
    })
    : launchAdoptedLegacySession(args.sessionDir, args.targetRuntimeRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runLegacyAdoptionCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
