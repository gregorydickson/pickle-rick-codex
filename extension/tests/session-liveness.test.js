// @tier: fast
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { reconcileSessionLiveness } from '../services/session.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
import { makeTempRoot, writeJson } from './helpers.js';

function state(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/project',
    step: 'implement',
    iteration: 1,
    max_iterations: 25,
    max_time_minutes: 480,
    worker_timeout_seconds: 900,
    start_time_epoch: 1_700_000_000,
    run_start_time_epoch: 1_700_000_000,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2023-11-14T22:13:20.000Z',
    session_dir: '/tmp/session',
    schema_version: 1,
    ...overrides,
  };
}

test('reconcileSessionLiveness demotes a tmux session whose runner is gone', () => {
  const sessionDir = makeTempRoot('pickle-liveness-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, state({ session_dir: sessionDir, tmux_mode: true, tmux_runner_pid: 999_999_999 }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, true);
  assert.equal(result.state.active, false);
  assert.equal(result.state.last_exit_reason, 'runner_lost');
  assert.equal(result.state.step, 'paused');
});

test('reconcileSessionLiveness expires an over-time non-tmux session but preserves a current one', () => {
  const expiredDir = makeTempRoot('pickle-liveness-expired-');
  writeJson(path.join(expiredDir, 'state.json'), state({ session_dir: expiredDir, max_time_minutes: 1 }));
  const expired = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_000);
  assert.equal(expired.stale, true);
  assert.equal(expired.state.last_exit_reason, 'max_time');

  const currentDir = makeTempRoot('pickle-liveness-current-');
  writeJson(path.join(currentDir, 'state.json'), state({ session_dir: currentDir, max_time_minutes: 10 }));
  const current = reconcileSessionLiveness(currentDir, undefined, 1_700_000_120_000);
  assert.equal(current.stale, false);
  assert.equal(current.state.active, true);
  assert.equal(fs.existsSync(path.join(currentDir, 'state.json')), true);
});

test('reconcileSessionLiveness blocks and preserves discoverability for a live orphan child', () => {
  const sessionDir = makeTempRoot('pickle-liveness-orphan-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: process.pid,
    active_child_kind: 'codex',
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.last_exit_reason, 'runner_lost_orphaned_child');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.active_child_pid, process.pid);
  assert.equal(result.state.orphan_child_pid, process.pid);
});

test('reconcileSessionLiveness reaps an identity-matched lifecycle child using a nested candidate add-dir', () => {
  const sessionDir = makeTempRoot('pickle-liveness-identity-orphan-');
  const candidateDir = path.join(sessionDir, 'worker-lifecycle-candidates', 'ticket-implement');
  fs.mkdirSync(candidateDir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--add-dir', candidateDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const identity = captureSpawnedProcessIdentity(Number(child.pid));
  assert.ok(identity);
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: child.pid,
    active_child_kind: 'codex',
    active_child_identity: identity,
  }));
  try {
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
    assert.equal(result.stale, true);
    assert.equal(result.state.active, false);
    assert.equal(result.state.last_exit_reason, 'runner_lost');
    assert.equal(result.state.recovery_required, false);
    assert.equal(result.state.orphan_child_pid, null);
  } finally {
    try { process.kill(-Number(child.pid), 'SIGKILL'); } catch {}
  }
});
