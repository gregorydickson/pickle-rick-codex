// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopPrompt } from '../services/prompts.js';

const baseArgs = {
  sessionDir: '/sessions/pickle-1',
  workerArtifactDir: '/artifacts/worker-1',
  workingDir: '/repos/project',
  state: {
    original_prompt: 'Improve the runtime',
    iteration: 3,
    max_iterations: 12,
  },
};

test('buildLoopPrompt emits the measured microverse experiment contract', () => {
  const prompt = buildLoopPrompt({
    ...baseArgs,
    mode: 'microverse',
    loopConfig: {
      task: 'Raise deterministic coverage',
      metric: 'npm run coverage',
      direction: 'higher',
      target: 90,
      target_relation: 'gt',
      stall_limit: 4,
      experiment_id: 'exp-0042',
      experiment_artifact_path: '/artifacts/worker-1/experiment.json',
      experiment_memory: '{"rejected":[]}',
      convergence_level: 'family-shift',
    },
  });

  assert.match(prompt, /Loop mode: microverse/);
  assert.match(prompt, /Metric command: npm run coverage/);
  assert.match(prompt, /Runtime target: best score gt 90/);
  assert.match(prompt, /Current experiment ID: exp-0042/);
  assert.match(prompt, /Before modifying the repository, write \/artifacts\/worker-1\/experiment\.json/);
  assert.match(prompt, /Compact experiment memory:\n\{"rejected":\[\]\}/);
  assert.match(prompt, /Research convergence intervention: family-shift/);
  assert.match(prompt, /runtime—not the worker—measures this command/i);
  assert.doesNotMatch(prompt, /Severity rubric:/);
});

test('buildLoopPrompt emits scoped szechuan cleanup constraints', () => {
  const prompt = buildLoopPrompt({
    ...baseArgs,
    mode: 'szechuan-sauce',
    loopConfig: {
      target: 'extension/services',
      focus: 'duplication',
      domain: 'KISS',
      allowed_paths: ['extension/services/prompts.js'],
      dry_run: false,
    },
  });

  assert.match(prompt, /Target: extension\/services/);
  assert.match(prompt, /Focus: duplication/);
  assert.match(prompt, /Domain principles: KISS/);
  assert.match(prompt, /Immutable mutation scope: \["extension\/services\/prompts\.js"\]/);
  assert.match(prompt, /Fix exactly one highest-value code quality issue/);
  assert.match(prompt, /Before committing, inspect every staged and unstaged path/);
  assert.match(prompt, /szechuan-sauce-summary\.json/);
});

test('buildLoopPrompt emits read-only anatomy review instructions', () => {
  const prompt = buildLoopPrompt({
    ...baseArgs,
    mode: 'anatomy-park',
    loopConfig: {
      target: 'session lifecycle',
      allowed_paths: [],
      dry_run: true,
    },
  });

  assert.match(prompt, /Target: session lifecycle/);
  assert.match(prompt, /Dry run: review and catalog findings only/);
  assert.match(prompt, /Trace data flow through the subsystem/);
  assert.match(prompt, /Clean passes must produce zero commits/);
  assert.match(prompt, /anatomy-park-summary\.json/);
  assert.doesNotMatch(prompt, /Immutable mutation scope:/);
});

test('buildLoopPrompt keeps the common contract for an unrecognized mode', () => {
  const prompt = buildLoopPrompt({
    ...baseArgs,
    mode: 'custom-loop',
    workerArtifactDir: '',
    state: {
      original_prompt: 'Inspect the project',
    },
    loopConfig: {},
  });

  assert.match(prompt, /Loop mode: custom-loop/);
  assert.match(prompt, /Worker artifact dir: \/sessions\/pickle-1/);
  assert.match(prompt, /Iteration: 0 \/ unlimited/);
  assert.match(prompt, /return <promise>CONTINUE<\/promise>/);
  assert.match(prompt, /return <promise>LOOP_COMPLETE<\/promise>/);
  assert.doesNotMatch(prompt, /Metric command:|Severity rubric:|Trace data flow/);
});
