#!/usr/bin/env node
import { checkReadiness } from '../services/readiness.js';

function parseArgs(argv: string[]): { sessionDir: string; json: boolean } {
  let sessionDir = '';
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--session-dir') {
      sessionDir = argv[index + 1] || '';
      index += 1;
    } else if (!arg.startsWith('--') && !sessionDir) sessionDir = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!sessionDir) throw new Error('Usage: node bin/check-readiness.js --session-dir <session-dir> [--json]');
  return { sessionDir, json };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const report = checkReadiness(args.sessionDir);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Readiness: ${report.ready ? 'READY' : 'BLOCKED'}`);
    console.log(`Session: ${report.session_dir}`);
    for (const item of report.findings) {
      console.log(`[${item.severity.toUpperCase()}] ${item.code}: ${item.evidence}`);
    }
  }
  if (!report.ready) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
