#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLegacyAdoptionExecutorSupervisor } from '../services/legacy-adoption-executor-supervisor.js';

function valueAfter(argv: string[], name: string, optional = false): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';
  if (!value || value.startsWith('--')) {
    if (optional) return '';
    throw new Error(`Missing value for ${name}.`);
  }
  return path.resolve(value);
}

export function runLegacyAdoptionExecutorSupervisorCli(argv: string[]): void {
  const sessionDir = valueAfter(argv, '--session-dir');
  const sourceRuntimeRoot = valueAfter(argv, '--source-runtime-root');
  const targetRuntimeRoot = valueAfter(argv, '--target-runtime-root');
  const validationSessionDir = valueAfter(argv, '--validation-session', true);
  const result = runLegacyAdoptionExecutorSupervisor({
    sessionDir, sourceRuntimeRoot, targetRuntimeRoot,
    ...(validationSessionDir ? { validationSessionDir } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runLegacyAdoptionExecutorSupervisorCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
