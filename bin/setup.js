#!/usr/bin/env node
import { createSession } from '../lib/session.js';
import { loadConfig } from '../lib/config.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main(argv) {
  let maxIterations;
  let maxTimeMinutes;
  let workerTimeoutSeconds;
  const taskParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-iterations') {
      maxIterations = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--max-time') {
      maxTimeMinutes = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--worker-timeout') {
      workerTimeoutSeconds = Number(argv[index + 1]);
      index += 1;
    } else {
      taskParts.push(arg);
    }
  }

  const prompt = taskParts.join(' ').trim();
  if (!prompt) fail('No task specified');

  const config = loadConfig();
  const { sessionDir } = await createSession({
    prompt,
    overrides: {
      max_iterations: Number.isInteger(maxIterations) ? maxIterations : config.defaults.max_iterations,
      max_time_minutes: Number.isInteger(maxTimeMinutes) ? maxTimeMinutes : config.defaults.max_time_minutes,
      worker_timeout_seconds: Number.isInteger(workerTimeoutSeconds) ? workerTimeoutSeconds : config.defaults.worker_timeout_seconds,
    },
  });
  console.log(sessionDir);
}

main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
