#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { assertCodexSucceeded, runCodexExecMonitored } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { buildRefinePrdPrompt } from '../lib/prompts.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { fallbackRefinePrd, readManifest, writeManifest, writeTicketFiles } from '../lib/tickets.js';

function hasPromiseToken(text, token) {
  return new RegExp(`<promise>\\s*${token}\\s*</promise>`).test(text || '');
}

export async function refinePrd(sessionDir, options = {}) {
  const prdPath = path.join(sessionDir, 'prd.md');
  if (!fs.existsSync(prdPath)) {
    throw new Error(`PRD not found: ${prdPath}`);
  }

  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const state = manager.read(statePath);
  const prompt = buildRefinePrdPrompt({ sessionDir, prdPath });
  const outputLastMessagePath = path.join(sessionDir, 'refine-prd.last-message.txt');
  const refinedPath = path.join(sessionDir, 'prd_refined.md');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const result = await runCodexExecMonitored({
    cwd: state.working_dir,
    prompt,
    timeoutMs: options.timeoutMs || loadConfig().defaults.refinement_timeout_seconds * 1000,
    outputLastMessagePath,
    addDirs: [sessionDir],
    successCheck: ({ lastMessage }) =>
      fs.existsSync(refinedPath) &&
      fs.existsSync(manifestPath) &&
      hasPromiseToken(lastMessage, 'REFINEMENT_COMPLETE'),
  });

  if (!fs.existsSync(refinedPath)) {
    fs.copyFileSync(prdPath, refinedPath);
  } else {
    assertCodexSucceeded(result, 'PRD refinement failed');
  }

  let manifest = readManifest(sessionDir);
  if (!manifest.tickets.length) {
    manifest = fallbackRefinePrd(fs.readFileSync(prdPath, 'utf8'));
    writeManifest(sessionDir, manifest);
  }
  writeTicketFiles(sessionDir, manifest);

  if (!manifest.tickets.length) {
    throw new Error('Refinement produced zero tickets.');
  }

  manager.update(statePath, (current) => {
    current.step = 'research';
    appendHistory(current, 'refine');
    return current;
  });

  const config = loadConfig();
  logActivity({
    event: 'feature',
    source: 'pickle',
    session: path.basename(sessionDir),
    step: 'refine',
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
    cache_read_input_tokens: result.usage.cache_read_input_tokens,
  }, { enabled: config.defaults.activity_logging });

  return manifest;
}

async function main(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    throw new Error('Usage: node bin/spawn-refinement-team.js <session-dir>');
  }
  const manifest = await refinePrd(sessionDir);
  console.log(JSON.stringify(manifest, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
