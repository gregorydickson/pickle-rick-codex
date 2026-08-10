#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCancellationRecoveryWatchdog } from '../services/autonomous-owner-recovery.js';

async function main(argv: string[]): Promise<void> {
  const sessionDir = argv.find((arg) => !arg.startsWith('--')) || '';
  if (!sessionDir) throw new Error('Usage: cancellation-recovery-watchdog <session-dir>');
  await runCancellationRecoveryWatchdog(
    sessionDir,
    path.dirname(fileURLToPath(import.meta.url)),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
