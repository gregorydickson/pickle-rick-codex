#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../lib/activity-logger.js';
import { assertCodexSucceeded, runCodexExecMonitored } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { buildDraftPrdPrompt } from '../lib/prompts.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';

function hasPromiseToken(text, token) {
  return new RegExp(`<promise>\\s*${token}\\s*</promise>`).test(text || '');
}

function writeFallbackPrd(prdPath, task) {
  const fallback = [
    '# PRD',
    '',
    '## Summary',
    task,
    '',
    '## Goals',
    '- Implement the requested work safely.',
    '',
    '## Non-Goals',
    '- Unsupported native Codex internals.',
    '',
    '## Verification',
    '- `npm test`',
    '',
  ].join('\n');
  fs.writeFileSync(prdPath, fallback);
}

export async function draftPrd(sessionDir, task, options = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const state = manager.read(statePath);
  const prdPath = path.join(sessionDir, 'prd.md');
  const outputLastMessagePath = path.join(sessionDir, 'draft-prd.last-message.txt');
  const prompt = buildDraftPrdPrompt({ task, sessionDir });
  const result = await runCodexExecMonitored({
    cwd: state.working_dir,
    prompt,
    timeoutMs: options.timeoutMs || 900_000,
    outputLastMessagePath,
    addDirs: [sessionDir],
    successCheck: ({ lastMessage }) =>
      fs.existsSync(prdPath) && hasPromiseToken(lastMessage, 'PRD_COMPLETE'),
  });

  if (!fs.existsSync(prdPath)) {
    writeFallbackPrd(prdPath, task);
  } else {
    assertCodexSucceeded(result, 'PRD drafting failed');
  }

  manager.update(statePath, (current) => {
    current.step = 'refine';
    appendHistory(current, 'prd');
    return current;
  });

  const config = loadConfig();
  logActivity({
    event: 'feature',
    source: 'pickle',
    session: path.basename(sessionDir),
    step: 'prd',
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
    cache_read_input_tokens: result.usage.cache_read_input_tokens,
  }, { enabled: config.defaults.activity_logging });

  return { prdPath, result };
}

async function main(argv) {
  const sessionDir = argv[0];
  const task = argv.slice(1).join(' ').trim();
  if (!sessionDir || !task) {
    throw new Error('Usage: node bin/draft-prd.js <session-dir> <task>');
  }
  await draftPrd(sessionDir, task);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
