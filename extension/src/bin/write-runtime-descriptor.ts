#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeInstalledRuntimeDescriptor } from '../services/runtime-descriptor.js';

export function writeRuntimeDescriptorCli(argv: string[]): void {
  const runtimeRoot = argv[0];
  if (!runtimeRoot) throw new Error('Usage: write-runtime-descriptor.js <runtime-root>');
  process.stdout.write(`${JSON.stringify(writeInstalledRuntimeDescriptor(path.resolve(runtimeRoot)))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeRuntimeDescriptorCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
