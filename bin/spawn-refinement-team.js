#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../lib/activity-logger.js';
import { assertCodexSucceeded, runCodexExecMonitored } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import {
  buildRefinementAnalystPrompt,
  buildRefinementSynthesisPrompt,
  buildRefinePrdPrompt,
} from '../lib/prompts.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { fallbackRefinePrd, readManifest, writeManifest, writeTicketFiles } from '../lib/tickets.js';

function hasPromiseToken(text, token) {
  return new RegExp(`<promise>\\s*${token}\\s*</promise>`).test(text || '');
}

function analystSpecs(sessionDir) {
  return [
    {
      role: 'requirements-gaps',
      focus: 'requirements completeness, missing acceptance criteria, and contradictory scope',
      analysisPath: path.join(sessionDir, 'analyst-requirements.md'),
      messagePath: path.join(sessionDir, 'analyst-requirements.last-message.txt'),
    },
    {
      role: 'codebase-integration',
      focus: 'integration points, likely file touch points, interfaces, and verification realism',
      analysisPath: path.join(sessionDir, 'analyst-codebase.md'),
      messagePath: path.join(sessionDir, 'analyst-codebase.last-message.txt'),
    },
    {
      role: 'risk-and-sequencing',
      focus: 'execution order, risk reduction, dependency handling, and ticket boundaries',
      analysisPath: path.join(sessionDir, 'analyst-risk.md'),
      messagePath: path.join(sessionDir, 'analyst-risk.last-message.txt'),
    },
  ];
}

async function runAnalyst(state, prdPath, spec, timeoutMs) {
  const result = await runCodexExecMonitored({
    cwd: state.working_dir,
    prompt: buildRefinementAnalystPrompt({
      role: spec.role,
      focus: spec.focus,
      prdPath,
      analysisPath: spec.analysisPath,
    }),
    timeoutMs,
    outputLastMessagePath: spec.messagePath,
    addDirs: [path.dirname(prdPath)],
    cleanupPaths: [spec.analysisPath],
    successCheck: ({ lastMessage }) =>
      fs.existsSync(spec.analysisPath) &&
      hasPromiseToken(lastMessage, 'ANALYST_COMPLETE'),
  });
  assertCodexSucceeded(result, `Refinement analyst failed: ${spec.role}`);
  return result;
}

async function runSynthesis(state, sessionDir, prdPath, timeoutMs) {
  const refinedPath = path.join(sessionDir, 'prd_refined.md');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const outputLastMessagePath = path.join(sessionDir, 'refine-prd.last-message.txt');
  const analystReports = analystSpecs(sessionDir).map((spec) => spec.analysisPath);
  const result = await runCodexExecMonitored({
    cwd: state.working_dir,
    prompt: buildRefinementSynthesisPrompt({ sessionDir, prdPath, analystReports }),
    timeoutMs,
    outputLastMessagePath,
    addDirs: [sessionDir],
    cleanupPaths: [refinedPath, manifestPath],
    successCheck: ({ lastMessage }) =>
      fs.existsSync(refinedPath) &&
      fs.existsSync(manifestPath) &&
      hasPromiseToken(lastMessage, 'REFINEMENT_COMPLETE'),
  });

  if (!fs.existsSync(refinedPath)) {
    // Preserve the previous truthful fallback if synthesis wrote nothing.
    fs.copyFileSync(prdPath, refinedPath);
  } else {
    assertCodexSucceeded(result, 'PRD refinement failed');
  }

  return result;
}

function sumUsage(results) {
  return results.reduce((acc, result) => {
    acc.input_tokens += Number(result?.usage?.input_tokens || 0);
    acc.output_tokens += Number(result?.usage?.output_tokens || 0);
    acc.cache_creation_input_tokens += Number(result?.usage?.cache_creation_input_tokens || 0);
    acc.cache_read_input_tokens += Number(result?.usage?.cache_read_input_tokens || 0);
    return acc;
  }, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
}

function appendRefineLog(sessionDir, message) {
  fs.appendFileSync(path.join(sessionDir, 'refine.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function markRefinePhase(manager, statePath, sessionDir, step, message) {
  manager.update(statePath, (current) => {
    current.step = step;
    return current;
  });
  appendRefineLog(sessionDir, message);
  console.error(`[refine] ${message}`);
}

export async function refinePrd(sessionDir, options = {}) {
  const prdPath = path.join(sessionDir, 'prd.md');
  if (!fs.existsSync(prdPath)) {
    throw new Error(`PRD not found: ${prdPath}`);
  }

  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const state = manager.read(statePath);
  const timeoutMs = options.timeoutMs || loadConfig().defaults.refinement_timeout_seconds * 1000;

  let analystResults = [];
  try {
    markRefinePhase(manager, statePath, sessionDir, 'refine:analysts', 'Starting analyst fanout.');
    analystResults = await Promise.all(
      analystSpecs(sessionDir).map((spec) => runAnalyst(state, prdPath, spec, timeoutMs)),
    );
    appendRefineLog(sessionDir, 'Analyst fanout complete.');
  } catch {
    // If analyst fanout fails, keep the prior single-pass refinement path as fallback.
    markRefinePhase(manager, statePath, sessionDir, 'refine:fallback', 'Analyst fanout failed. Falling back to single-pass refinement.');
    const fallbackPrompt = buildRefinePrdPrompt({ sessionDir, prdPath });
    const outputLastMessagePath = path.join(sessionDir, 'refine-prd.last-message.txt');
    const refinedPath = path.join(sessionDir, 'prd_refined.md');
    const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
    const fallbackResult = await runCodexExecMonitored({
      cwd: state.working_dir,
      prompt: fallbackPrompt,
      timeoutMs,
      outputLastMessagePath,
      addDirs: [sessionDir],
      cleanupPaths: [refinedPath, manifestPath],
      successCheck: ({ lastMessage }) =>
        fs.existsSync(refinedPath) &&
        fs.existsSync(manifestPath) &&
        hasPromiseToken(lastMessage, 'REFINEMENT_COMPLETE'),
    });
    analystResults = [fallbackResult];
  }

  markRefinePhase(manager, statePath, sessionDir, 'refine:synthesis', 'Starting refinement synthesis.');
  const synthesisResult = await runSynthesis(state, sessionDir, prdPath, timeoutMs);

  let manifest = readManifest(sessionDir);
  if (!manifest.tickets.length) {
    appendRefineLog(sessionDir, 'Synthesis manifest empty. Falling back to PRD table extraction.');
    manifest = fallbackRefinePrd(fs.readFileSync(prdPath, 'utf8'));
    writeManifest(sessionDir, manifest);
  }
  markRefinePhase(manager, statePath, sessionDir, 'refine:materialize', 'Materializing ticket files.');
  writeTicketFiles(sessionDir, manifest);

  if (!manifest.tickets.length) {
    throw new Error('Refinement produced zero tickets.');
  }

  manager.update(statePath, (current) => {
    current.step = 'research';
    appendHistory(current, 'refine');
    return current;
  });
  appendRefineLog(sessionDir, 'Refinement complete.');

  const config = loadConfig();
  const usage = sumUsage([...analystResults, synthesisResult]);
  logActivity({
    event: 'feature',
    source: 'pickle',
    session: path.basename(sessionDir),
    step: 'refine',
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
