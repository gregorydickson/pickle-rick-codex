// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDraftPrdPrompt,
  buildRefinePrdPrompt,
  buildRefinementAnalystPrompt,
  buildRefinementSynthesisPrompt,
} from '../services/prompts.js';

test('buildDraftPrdPrompt binds the task, destination, and completion contract', () => {
  const prompt = buildDraftPrdPrompt({
    task: 'Add deterministic recovery',
    sessionDir: '/sessions/pickle-7',
  });

  assert.match(prompt, /Write the PRD to \/sessions\/pickle-7\/prd\.md/);
  assert.match(prompt, /Task: Add deterministic recovery/);
  assert.match(prompt, /machine-checkable verification/);
  assert.match(prompt, /<promise>PRD_COMPLETE<\/promise>/);
  assert.match(prompt, /Stop immediately after writing the file/);
});

test('buildRefinePrdPrompt requires executable ticket and ambiguity contracts', () => {
  const prompt = buildRefinePrdPrompt({
    sessionDir: '/sessions/pickle-8',
    prdPath: '/inputs/source-prd.md',
  });

  assert.match(prompt, /Read \/inputs\/source-prd\.md/);
  assert.match(prompt, /Write \/sessions\/pickle-8\/prd_refined\.md/);
  assert.match(prompt, /Write \/sessions\/pickle-8\/refinement_manifest\.json/);
  assert.match(prompt, /non-empty allowed_paths array/);
  assert.match(prompt, /create an explicit contract-decision ticket first/);
  assert.match(prompt, /do not silently hard-code fixed-SHA enforcement/);
  assert.match(prompt, /Internal leaf-worker boundary: the refinement orchestrator is already running/);
  assert.match(prompt, /Do not launch another workflow, command, skill, or agent/);
  assert.match(prompt, /<promise>REFINEMENT_COMPLETE<\/promise>/);
});

test('buildRefinementAnalystPrompt scopes the analyst role and output', () => {
  const prompt = buildRefinementAnalystPrompt({
    role: 'verification analyst',
    focus: 'runnable acceptance criteria',
    prdPath: '/sessions/pickle-9/prd.md',
    analysisPath: '/sessions/pickle-9/analysis/verification.md',
  });

  assert.match(prompt, /Refinement analyst role: verification analyst/);
  assert.match(prompt, /Focus: runnable acceptance criteria/);
  assert.match(prompt, /Read \/sessions\/pickle-9\/prd\.md/);
  assert.match(prompt, /Write your analyst report to \/sessions\/pickle-9\/analysis\/verification\.md/);
  assert.match(prompt, /Findings, Recommended Changes, Verification Gaps, and Ticketing Notes/);
  assert.match(prompt, /Do not write the final manifest/);
  assert.match(prompt, /Internal leaf-worker boundary: the refinement orchestrator is already running/);
  assert.match(prompt, /<promise>ANALYST_COMPLETE<\/promise>/);
});

test('buildRefinementSynthesisPrompt preserves ordered reports and proof obligations', () => {
  const prompt = buildRefinementSynthesisPrompt({
    sessionDir: '/sessions/pickle-10',
    prdPath: '/sessions/pickle-10/prd.md',
    analystReports: ['/analysis/architecture.md', '/analysis/verification.md'],
  });

  assert.match(prompt, /Read \/sessions\/pickle-10\/prd\.md/);
  assert.match(prompt, /- \/analysis\/architecture\.md\n\n- \/analysis\/verification\.md/);
  assert.match(prompt, /Write \/sessions\/pickle-10\/prd_refined\.md/);
  assert.match(prompt, /Write \/sessions\/pickle-10\/refinement_manifest\.json/);
  assert.match(prompt, /verification_env, output_artifacts, proof_corpus, and freeze_contract/);
  assert.match(prompt, /Parity-style port work must preserve full mirrored proof obligations/);
  assert.match(prompt, /Internal leaf-worker boundary: the refinement orchestrator is already running/);
  assert.match(prompt, /<promise>REFINEMENT_COMPLETE<\/promise>/);
});
