// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  captureMetricIterationCheckpoint,
  classifyMetric,
  createMetricConvergenceState,
  measureMetric,
  readMetricConvergenceState,
  recordMetricIteration,
  revertMetricIteration,
  writeMetricConvergenceState,
} from '../services/metric-convergence.js';
import { makeTempRoot } from './helpers.js';
import { execFileSync } from 'node:child_process';

function measurement(score, command = 'printf 1') {
  return { command, score, raw: String(score), measured_at: new Date(0).toISOString() };
}

test('measureMetric executes the command and requires exactly one numeric score', () => {
  const cwd = makeTempRoot('pickle-metric-');
  assert.equal(measureMetric('printf "12.5"', { cwd }).score, 12.5);
  assert.throws(() => measureMetric('printf "score=12.5"', { cwd }), /exactly one finite numeric score/);
  assert.throws(() => measureMetric('exit 7', { cwd }), /exited 7/);
});

test('measureMetric rejects commands that mutate a git repository', () => {
  const cwd = makeTempRoot('pickle-metric-readonly-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
  assert.throws(
    () => measureMetric('printf mutation > metric-side-effect.txt; printf 1', { cwd }),
    /must be read-only/,
  );
});

test('classifyMetric respects direction and tolerance', () => {
  assert.equal(classifyMetric(11, 10, 'higher', 0), 'improved');
  assert.equal(classifyMetric(9, 10, 'higher', 0), 'regressed');
  assert.equal(classifyMetric(9, 10, 'lower', 0), 'improved');
  assert.equal(classifyMetric(10.05, 10, 'higher', 0.1), 'held');
});

test('metric state accepts improvements, records failed approaches, and round-trips atomically', () => {
  const sessionDir = makeTempRoot('pickle-metric-state-');
  const initial = createMetricConvergenceState(measurement(10), 'higher', 0);
  const improved = recordMetricIteration(initial, measurement(12), {
    iteration: 1,
    headBefore: 'aaaaaaa',
    headAfter: 'bbbbbbb',
  });
  assert.equal(improved.classification, 'improved');
  assert.equal(improved.state.best.score, 12);
  assert.equal(improved.state.stall_count, 0);

  const regressed = recordMetricIteration(improved.state, measurement(11), {
    iteration: 2,
    headBefore: 'bbbbbbb',
    headAfter: 'ccccccc',
  });
  assert.equal(regressed.classification, 'regressed');
  assert.equal(regressed.state.best.score, 12);
  assert.equal(regressed.state.stall_count, 1);
  assert.deepEqual(regressed.state.failed_approaches, [{
    iteration: 2,
    classification: 'regressed',
    head: 'ccccccc',
    score: 11,
  }]);

  writeMetricConvergenceState(sessionDir, regressed.state);
  assert.deepEqual(readMetricConvergenceState(sessionDir), regressed.state);
  assert.equal(fs.existsSync(path.join(sessionDir, 'microverse-metrics.json')), true);
});

test('metric checkpoint rollback restores commits and removes only iteration-created untracked files', () => {
  const cwd = makeTempRoot('pickle-metric-git-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const checkpoint = captureMetricIterationCheckpoint(cwd);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'regression\n');
  fs.writeFileSync(path.join(cwd, 'remove.txt'), 'iteration artifact\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'regression'], { cwd });
  revertMetricIteration(cwd, checkpoint, makeTempRoot('pickle-metric-session-'));
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.existsSync(path.join(cwd, 'remove.txt')), false);
  fs.writeFileSync(path.join(cwd, 'pre-existing.txt'), 'user data\n');
  assert.throws(() => captureMetricIterationCheckpoint(cwd), /completely clean/);
  assert.equal(fs.readFileSync(path.join(cwd, 'pre-existing.txt'), 'utf8'), 'user data\n');
});
