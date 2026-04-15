#!/usr/bin/env node
import { setupSession } from '../lib/setup-session.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main(argv) {
  const { sessionDir } = await setupSession(argv);
  console.log(sessionDir);
}

main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
