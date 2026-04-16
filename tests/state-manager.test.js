import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateManager } from '../lib/state-manager.js';
import { makeTempRoot } from './helpers.js';

function defaultState(sessionDir) {
  return {
    active: true,
    working_dir: sessionDir,
    step: 'prd',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 10,
    worker_timeout_seconds: 30,
    start_time_epoch: 0,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-15T00:00:00.000Z',
    session_dir: sessionDir,
  };
}

test('StateManager readOrReinitialize backs up corrupt state and rewrites defaults', () => {
  const tempRoot = makeTempRoot();
  const statePath = path.join(tempRoot, 'state.json');
  fs.writeFileSync(statePath, '{invalid json');
  const manager = new StateManager();

  const state = manager.readOrReinitialize(statePath, () => defaultState(tempRoot));
  assert.equal(state.step, 'prd');
  const backups = fs.readdirSync(tempRoot).filter((fileName) => fileName.startsWith('state.json.corrupt.'));
  assert.equal(backups.length, 1);
});

test('StateManager read hydrates missing schema_version without rewriting the file', () => {
  const tempRoot = makeTempRoot();
  const statePath = path.join(tempRoot, 'state.json');
  const originalContent = JSON.stringify(defaultState(tempRoot), null, 2);
  fs.writeFileSync(statePath, originalContent);

  const manager = new StateManager();
  const state = manager.read(statePath);

  assert.equal(state.schema_version, 1);
  assert.equal(fs.readFileSync(statePath, 'utf8'), originalContent);
});

test('StateManager update steals stale lock files', () => {
  const tempRoot = makeTempRoot();
  const statePath = path.join(tempRoot, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(defaultState(tempRoot)));
  const lockPath = `${statePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: 0 }));
  const manager = new StateManager({ staleLockThresholdMs: 1 });

  const updated = manager.update(statePath, (state) => {
    state.iteration = 1;
    return state;
  });

  assert.equal(updated.iteration, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test('StateManager transaction rolls back all files when mutation fails', () => {
  const tempRoot = makeTempRoot();
  const firstPath = path.join(tempRoot, 'first.json');
  const secondPath = path.join(tempRoot, 'second.json');
  fs.writeFileSync(firstPath, JSON.stringify({ id: 'first', value: 1 }));
  fs.writeFileSync(secondPath, JSON.stringify({ id: 'second', value: 2 }));

  const manager = new StateManager({ acquireTimeoutMs: 100 });

  assert.throws(
    () => manager.transaction([firstPath, secondPath], () => {
      throw new Error('boom');
    }),
    (error) => error.code === 'WRITE_FAILED',
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(firstPath, 'utf8')), { id: 'first', value: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(secondPath, 'utf8')), { id: 'second', value: 2 });
  assert.equal(fs.existsSync(`${firstPath}.lock`), false);
  assert.equal(fs.existsSync(`${secondPath}.lock`), false);
});
