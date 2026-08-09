#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function main(argv: string[]): void {
  const runtimeBin = path.dirname(fileURLToPath(import.meta.url));
  const sessionDir = argv.find((arg) => !arg.startsWith('--')) || '';
  const runnerArg = argv.find((arg) => arg.startsWith('--runner-bin='));
  if (!sessionDir || !runnerArg) {
    throw new Error('Usage: recovered-supervisor-owner <session-dir> --runner-bin=<runner> [runner args]');
  }
  const supervisor = spawnSync(process.execPath, [
    path.join(runtimeBin, 'supervised-runner.js'),
    sessionDir,
    runnerArg,
    ...argv.filter((arg) => arg !== sessionDir && arg !== runnerArg),
  ], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  spawnSync(process.execPath, [path.join(runtimeBin, 'terminal-tmux-cleanup.js'), sessionDir], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit',
  });
  process.exitCode = supervisor.status ?? (supervisor.signal ? 128 : 1);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
