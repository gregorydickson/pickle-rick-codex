#!/usr/bin/env node
import { setupSession } from '../services/setup-session.js';

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const { sessionDir } = await setupSession(argv);
  console.log(sessionDir);
}

main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
