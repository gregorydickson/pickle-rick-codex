#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { getCodexVersion } from '../services/codex.js';
import { loadConfig } from '../services/config.js';

const REQUIRED_EXEC_FLAGS = ['--cd', '--json', '--add-dir', '--output-last-message'];

try {
  const config = loadConfig();
  const help = spawnSync(config.runtime.command, ['exec', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (help.error || help.status !== 0) {
    throw new Error(String(help.stderr || help.error?.message || 'codex exec --help failed').trim());
  }
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  const missingFlags = REQUIRED_EXEC_FLAGS.filter((flag) => !helpText.includes(flag));
  if (missingFlags.length > 0) {
    throw new Error(`Codex exec is missing required runtime flags: ${missingFlags.join(', ')}`);
  }
  console.log(JSON.stringify({
    validation_date: new Date().toISOString(),
    codex_version: getCodexVersion(),
    guaranteed_path: 'codex exec --full-auto',
    exec_capabilities: Object.fromEntries(REQUIRED_EXEC_FLAGS.map((flag) => [flag, true])),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
