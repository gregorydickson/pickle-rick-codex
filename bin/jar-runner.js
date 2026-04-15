#!/usr/bin/env node
import { runSequential } from './mux-runner.js';

async function main(argv) {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/jar-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  await runSequential(sessionDir, {
    onFailure: argv.find((arg) => arg.startsWith('--on-failure='))?.split('=')[1] || 'abort',
  });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
