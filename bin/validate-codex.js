#!/usr/bin/env node
import { getCodexVersion } from '../lib/codex.js';

try {
  console.log(JSON.stringify({
    validation_date: new Date().toISOString(),
    codex_version: getCodexVersion(),
    guaranteed_path: 'codex exec --full-auto',
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
