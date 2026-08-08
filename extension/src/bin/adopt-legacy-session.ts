#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptActiveLegacyMuxSession,
  launchAdoptedLegacySession,
} from '../services/legacy-session-adoption.js';

interface Args {
  command: 'prepare' | 'launch';
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
}

function valueAfter(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return path.resolve(value);
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'prepare' && command !== 'launch') {
    throw new Error('Usage: adopt-legacy-session.js prepare --session-dir DIR --source-runtime-root DIR --target-runtime-root DIR | launch --session-dir DIR --target-runtime-root DIR');
  }
  return {
    command,
    sessionDir: valueAfter(argv, '--session-dir'),
    sourceRuntimeRoot: command === 'prepare' ? valueAfter(argv, '--source-runtime-root') : '',
    targetRuntimeRoot: valueAfter(argv, '--target-runtime-root'),
  };
}

export function runLegacyAdoptionCli(argv: string[]): void {
  const args = parseArgs(argv);
  const result = args.command === 'prepare'
    ? adoptActiveLegacyMuxSession(args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot)
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
