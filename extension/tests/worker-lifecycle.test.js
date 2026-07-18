// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile } from '../services/pickle-utils.js';
import { WORKER_LIFECYCLE_PHASES } from '../services/worker-lifecycle.js';
import { createFakeCodex, makeTempRoot, prependPath, repoRoot, runNode, writeJson } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setupLifecycleRun(env) {
  const projectDir = makeTempRoot('pickle-worker-lifecycle-project-');
  git(projectDir, ['init']);
  git(projectDir, ['config', 'user.name', 'Lifecycle Tests']);
  git(projectDir, ['config', 'user.email', 'lifecycle@example.test']);
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\n');
  git(projectDir, ['add', 'feature.txt']);
  git(projectDir, ['commit', '-m', 'base']);
  const baseline = git(projectDir, ['rev-parse', 'HEAD']);
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'causal worker lifecycle'], {
    env,
    cwd: projectDir,
  }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.active = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'R1',
      title: 'Causal lifecycle ticket',
      description: 'Carry approved research and planning into implementation.',
      acceptance_criteria: ['The implementation consumes approved lifecycle artifacts.'],
      verification: ['node -e "process.exit(0)"'],
      allowed_paths: ['feature.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  return { projectDir, sessionDir, baseline };
}

test('worker lifecycle persists eight validated phases and reads approved research and plan into implement', () => {
  const fakeBin = makeTempRoot('pickle-worker-lifecycle-bin-');
  createFakeCodex(fakeBin);
  const promptLog = makeTempRoot('pickle-worker-lifecycle-prompts-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: makeTempRoot(),
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
    FAKE_LIFECYCLE_PROMPT_LOG: promptLog,
  });
  const { projectDir, sessionDir, baseline } = setupLifecycleRun(env);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  assert.notEqual(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  const artifactDir = path.join(sessionDir, 'worker-lifecycle', 'r1');
  for (const phase of WORKER_LIFECYCLE_PHASES) {
    const artifact = JSON.parse(fs.readFileSync(path.join(artifactDir, `${phase}.json`), 'utf8'));
    assert.equal(artifact.phase, phase);
    assert.equal(artifact.ticket_id, 'r1');
  }
  const implementPrompt = fs.readFileSync(path.join(promptLog, 'implement.prompt.txt'), 'utf8');
  assert.match(implementPrompt, /approved research marker/);
  assert.match(implementPrompt, /approved plan marker/);
  assert.match(implementPrompt, /Approved research_review artifact/);
  assert.match(implementPrompt, /Approved plan_review artifact/);
  assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
});

for (const [label, envFlag, phase, expected] of [
  ['missing', 'FAKE_LIFECYCLE_MISSING_PHASE', 'plan', /worker-lifecycle-missing-artifact/],
  ['invalid', 'FAKE_LIFECYCLE_INVALID_PHASE', 'plan_review', /worker-lifecycle-invalid-artifact/],
]) {
  test(`worker lifecycle fails closed on a ${label} pre-implementation artifact`, () => {
    const fakeBin = makeTempRoot(`pickle-worker-lifecycle-${label}-bin-`);
    createFakeCodex(fakeBin);
    const env = prependPath(fakeBin, {
      PICKLE_DATA_ROOT: makeTempRoot(),
      FAKE_CODEX_MUTATE_FILE: 'feature.txt',
      FAKE_CODEX_APPEND_TEXT: 'must-not-run\n',
      [envFlag]: phase,
    });
    const { projectDir, sessionDir, baseline } = setupLifecycleRun(env);

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir }),
      expected,
    );

    assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
    assert.equal(git(projectDir, ['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8'), 'base\n');
    const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
    assert.equal(ticket.status, 'Blocked');
    assert.match(String(ticket.frontmatter.failure_reason), expected);
    assert.ok(!fs.existsSync(path.join(sessionDir, 'worker-lifecycle', 'r1', 'implement.json')));
  });
}
