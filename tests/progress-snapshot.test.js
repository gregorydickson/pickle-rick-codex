import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recordIteration, loadCircuitState } from '../lib/circuit-breaker.js';
import { captureProgressSnapshot, diffProgressSnapshot } from '../lib/progress-snapshot.js';
import { makeTempRoot } from './helpers.js';

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(repoDir) {
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.name', 'Pickle Rick']);
  runGit(repoDir, ['config', 'user.email', 'pickle-rick@local.invalid']);
}

function commitFile(repoDir, relativePath, content, message = 'baseline') {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  runGit(repoDir, ['add', relativePath]);
  runGit(repoDir, ['commit', '-m', message]);
}

test('progress snapshot detects tracked file content changes even when the porcelain class stays dirty', () => {
  const repoDir = makeTempRoot('pickle-rick-progress-repo-');
  const sessionDir = makeTempRoot('pickle-rick-progress-session-');
  initRepo(repoDir);
  commitFile(repoDir, 'index.js', 'export const value = 1;\n');

  const filePath = path.join(repoDir, 'index.js');
  fs.writeFileSync(filePath, 'export const value = 2;\n');
  const before = captureProgressSnapshot({
    sessionDir,
    workingDir: repoDir,
    mode: 'microverse',
    step: 'microverse',
  });

  fs.writeFileSync(filePath, 'export const value = 3;\n');
  const after = captureProgressSnapshot({
    sessionDir,
    workingDir: repoDir,
    mode: 'microverse',
    step: 'microverse',
  });

  assert.match(runGit(repoDir, ['status', '--porcelain']), /M index\.js/);
  assert.deepEqual(diffProgressSnapshot(before, after), ['worktree_fingerprint']);
});

test('progress snapshot detects canonical summary artifact changes for anatomy park and microverse', () => {
  const repoDir = makeTempRoot('pickle-rick-progress-repo-');
  initRepo(repoDir);
  commitFile(repoDir, 'README.md', '# baseline\n');

  const anatomySession = makeTempRoot('pickle-rick-anatomy-session-');
  const anatomyBefore = captureProgressSnapshot({
    sessionDir: anatomySession,
    workingDir: repoDir,
    mode: 'anatomy-park',
    step: 'anatomy-park',
  });
  fs.writeFileSync(path.join(anatomySession, 'anatomy-park-summary.json'), JSON.stringify({ finding: 'A' }, null, 2));
  const anatomyAfter = captureProgressSnapshot({
    sessionDir: anatomySession,
    workingDir: repoDir,
    mode: 'anatomy-park',
    step: 'anatomy-park',
  });
  assert.deepEqual(diffProgressSnapshot(anatomyBefore, anatomyAfter), ['progress_artifact:anatomy-park-summary.json']);

  const microverseSession = makeTempRoot('pickle-rick-microverse-session-');
  const microverseBefore = captureProgressSnapshot({
    sessionDir: microverseSession,
    workingDir: repoDir,
    mode: 'microverse',
    step: 'microverse',
  });
  fs.writeFileSync(path.join(microverseSession, 'microverse-summary.md'), '# Summary\n');
  const microverseAfter = captureProgressSnapshot({
    sessionDir: microverseSession,
    workingDir: repoDir,
    mode: 'microverse',
    step: 'microverse',
  });
  assert.deepEqual(diffProgressSnapshot(microverseBefore, microverseAfter), ['progress_artifact:microverse-summary.md']);
});

test('circuit breaker ignores iteration churn but resets on shared progress signals', () => {
  const repoDir = makeTempRoot('pickle-rick-progress-repo-');
  const sessionDir = makeTempRoot('pickle-rick-progress-session-');
  initRepo(repoDir);
  commitFile(repoDir, 'index.js', 'export const value = 1;\n');

  const filePath = path.join(repoDir, 'index.js');
  fs.writeFileSync(filePath, 'export const value = 2;\n');

  const baseState = {
    working_dir: repoDir,
    step: 'implement',
    current_ticket: 'ticket-1',
    iteration: 1,
    loop_mode: null,
  };

  recordIteration(sessionDir, baseState, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });

  const stalled = recordIteration(sessionDir, {
    ...baseState,
    iteration: 2,
  }, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });
  assert.equal(stalled.state, 'OPEN');

  fs.writeFileSync(filePath, 'export const value = 3;\n');
  const recovered = recordIteration(sessionDir, {
    ...baseState,
    iteration: 3,
  }, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });
  assert.equal(recovered.state, 'CLOSED');

  const circuitState = loadCircuitState(sessionDir);
  assert.ok(circuitState.last_snapshot.worktree_fingerprint);
});

test('circuit breaker treats anatomy park canonical summary changes as progress', () => {
  const repoDir = makeTempRoot('pickle-rick-progress-repo-');
  const sessionDir = makeTempRoot('pickle-rick-progress-session-');
  initRepo(repoDir);
  commitFile(repoDir, 'README.md', '# baseline\n');

  const state = {
    working_dir: repoDir,
    step: 'anatomy-park',
    current_ticket: null,
    iteration: 1,
    loop_mode: 'anatomy-park',
  };

  recordIteration(sessionDir, state, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });

  const first = recordIteration(sessionDir, {
    ...state,
    iteration: 2,
  }, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });
  assert.equal(first.state, 'OPEN');

  fs.writeFileSync(path.join(sessionDir, 'anatomy-park-summary.json'), JSON.stringify({ finding: 'A' }, null, 2));
  const second = recordIteration(sessionDir, {
    ...state,
    iteration: 3,
  }, {
    circuitBreakerConfig: { no_progress_threshold: 1, half_open_after: 1, same_error_threshold: 5 },
  });
  assert.equal(second.state, 'CLOSED');
});
