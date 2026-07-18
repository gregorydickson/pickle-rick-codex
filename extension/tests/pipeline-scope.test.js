// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import { createPipelineContract, assertPipelineResumeCompatible } from '../services/pipeline.js';
import { buildLoopPrompt } from '../services/prompts.js';
import {
  PipelineScopeError,
  deriveCompletedTicketScope,
  enforceLoopMutationScope,
  resolvePipelineScope,
} from '../services/pipeline-scope.js';

function initRepo() {
  const repo = makeTempRoot('pickle-scope-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Pickle Scope Tests'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'scope@example.test'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/safe.ts'), 'safe\n');
  fs.writeFileSync(path.join(repo, 'docs/outside.md'), 'outside\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repo });
  return fs.realpathSync(repo);
}

function contract(workingDir, scope = []) {
  return createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    scope,
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    bootstrap_source: 'task',
    task: 'scope the optional loops',
  });
}

test('default pipeline scope is the union of completed ticket declared and changed paths', () => {
  const repo = initRepo();
  const session = makeTempRoot('pickle-scope-session-');
  writeJson(path.join(session, 'refinement_manifest.json'), {
    tickets: [
      { id: 'done-1', status: 'Done', allowed_paths: ['src', 'src/nested.ts'] },
      { id: 'todo-1', status: 'Todo', allowed_paths: ['docs'] },
    ],
  });
  writeJson(path.join(session, 'worker-lifecycle/done-1/implement.json'), {
    schema_version: 1,
    phase: 'implement',
    ticket_id: 'done-1',
    summary: 'changed proof',
    files_changed: ['tests/safe.test.ts'],
    verification: ['test'],
  });

  assert.deepEqual(deriveCompletedTicketScope(session), ['src', 'tests/safe.test.ts']);
  const resolved = resolvePipelineScope(session, contract(repo));
  assert.equal(resolved.source, 'completed-tickets');
  assert.deepEqual(resolved.paths, ['src', 'tests/safe.test.ts']);
});

test('pipeline scope is immutable on resume and resolved artifact drift fails closed', () => {
  const repo = initRepo();
  const session = makeTempRoot('pickle-scope-session-');
  const existing = contract(repo, ['src']);
  assert.throws(
    () => assertPipelineResumeCompatible(existing, contract(repo, ['docs'])),
    /Cannot change pipeline scope on resume/,
  );
  resolvePipelineScope(session, existing);
  writeJson(path.join(session, 'pipeline-scope.json'), {
    schema_version: 1,
    working_dir: repo,
    source: 'explicit',
    paths: ['docs'],
  });
  assert.throws(
    () => resolvePipelineScope(session, existing),
    (error) => error instanceof PipelineScopeError && error.code === 'PIPELINE_SCOPE_IMMUTABLE',
  );
});

test('out-of-scope optional-loop commit is archived, rolled back, and blocked', () => {
  const repo = initRepo();
  const session = makeTempRoot('pickle-scope-session-');
  const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'docs/outside.md'), 'violating edit\n');
  execFileSync('git', ['add', 'docs/outside.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'bad optional loop commit'], { cwd: repo });

  assert.throws(
    () => enforceLoopMutationScope({
      sessionDir: session,
      workingDir: repo,
      mode: 'szechuan-sauce',
      beforeHead,
      allowedPaths: ['src'],
    }),
    (error) => error instanceof PipelineScopeError && error.code === 'PIPELINE_SCOPE_VIOLATION',
  );
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), beforeHead);
  assert.equal(fs.readFileSync(path.join(repo, 'docs/outside.md'), 'utf8'), 'outside\n');
  const recoveryRef = `refs/pickle/optional-loop-recovery/${path.basename(session)}/szechuan-sauce`;
  assert.match(execFileSync('git', ['rev-parse', '--verify', recoveryRef], { cwd: repo, encoding: 'utf8' }), /^[0-9a-f]{40}\n$/);
});

test('pipeline scope rejects repository root and fails closed when no completed-ticket scope exists', () => {
  const repo = initRepo();
  assert.throws(() => contract(repo, ['.']), /Repository root/);
  const session = makeTempRoot('pickle-scope-session-');
  writeJson(path.join(session, 'refinement_manifest.json'), { tickets: [{ id: 'todo', status: 'Todo', allowed_paths: ['src'] }] });
  assert.throws(
    () => resolvePipelineScope(session, contract(repo)),
    (error) => error instanceof PipelineScopeError && error.code === 'PIPELINE_SCOPE_EMPTY',
  );
});

test('Szechuan prompt carries doctrine and the immutable precommit scope check', () => {
  const prompt = buildLoopPrompt({
    mode: 'szechuan-sauce',
    sessionDir: '/tmp/session',
    workingDir: '/tmp/repo',
    state: { iteration: 1, original_prompt: 'clean safely' },
    loopConfig: { target: '/tmp/repo', allowed_paths: ['src'], dry_run: false },
  });
  assert.match(prompt, /Phase 0 contract discovery/);
  assert.match(prompt, /P0 data loss\/security\/correctness catastrophe/);
  assert.match(prompt, /Drop findings below 80 confidence/);
  assert.match(prompt, /False positives to discard/);
  assert.match(prompt, /Diff hygiene/);
  assert.match(prompt, /Trap-door-as-test/);
  assert.match(prompt, /Immutable mutation scope: \["src"\]/);
  assert.match(prompt, /runtime will archive, roll back, and block/);
});
