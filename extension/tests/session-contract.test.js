// @tier: fast

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendHistory,
  createInitialState,
  deactivateSession,
  getRunStartEpoch,
  getSessionMapCwds,
  getStatePath,
  loadSessionState,
  markRunStart,
  normalizeSessionCwd,
  readOrInitSessionState,
  reconcileAllSessionLiveness,
  resolveSessionForCwd,
  writeSessionFile,
} from '../services/session.js';
import {
  getSessionForCwd,
  updateSessionMap,
} from '../services/session-map.js';

const DEFAULTS = {
  max_iterations: 25,
  max_time_minutes: 480,
  worker_timeout_seconds: 900,
};

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionState(sessionDir, cwd, overrides = {}) {
  return {
    active: false,
    working_dir: cwd,
    step: 'paused',
    current_ticket: null,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    start_time_epoch: 1_767_225_600,
    run_started_at: null,
    run_start_time_epoch: null,
    max_time_minutes: 480,
    session_dir: sessionDir,
    schema_version: 1,
    ...overrides,
  };
}

async function withDataRoot(callback) {
  const previous = process.env.PICKLE_DATA_ROOT;
  const dataRoot = makeTempDir('pickle-session-contract-data-');
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return await callback(dataRoot);
  } finally {
    if (previous === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previous;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('session state helpers preserve run identity, timing, aliases, and history', () => {
  const cwd = makeTempDir('pickle-session-contract-project-');
  const sessionDir = makeTempDir('pickle-session-contract-session-');
  const initial = createInitialState({
    cwd,
    prompt: 'contract task',
    sessionDir,
    config: { defaults: DEFAULTS },
    overrides: { active: false, session_map_cwds: [cwd, '', cwd, '/legacy'] },
  });

  assert.equal(initial.active, false);
  assert.equal(initial.run_started_at, null);
  assert.equal(initial.run_start_time_epoch, null);
  assert.equal(initial.start_commit, null);
  assert.equal(initial.pinned_sha, null);
  assert.deepEqual(getSessionMapCwds(initial), [cwd, '/legacy']);
  assert.deepEqual(getSessionMapCwds({ working_dir: '/only' }), ['/only']);

  const now = new Date('2026-07-18T12:34:56.789Z');
  assert.equal(markRunStart(initial, now), initial);
  assert.equal(initial.run_started_at, now.toISOString());
  assert.equal(initial.run_start_time_epoch, Math.floor(now.getTime() / 1000));
  assert.equal(getRunStartEpoch(initial), now.getTime() / 1000);
  assert.equal(getRunStartEpoch({ run_started_at: 'invalid', run_start_time_epoch: '42' }), 42);
  assert.equal(getRunStartEpoch({ active: false, started_at: '2020-01-01T00:00:00.000Z' }), 0);
  assert.equal(getRunStartEpoch({ started_at: 'invalid', start_time_epoch: 7 }), 7);

  appendHistory(initial, 'verify', 'TICKET-7');
  assert.equal(initial.history.at(-1).step, 'verify');
  assert.equal(initial.history.at(-1).ticket, 'TICKET-7');
  assert.equal(Number.isFinite(Date.parse(initial.history.at(-1).timestamp)), true);

  assert.equal(normalizeSessionCwd(cwd), cwd);
  assert.equal(normalizeSessionCwd(''), '');
  assert.equal(normalizeSessionCwd(null), null);
  assert.equal(normalizeSessionCwd(path.join(cwd, 'missing', '..')), cwd);
});

test('session state and auxiliary files persist through the public filesystem API', () => {
  const sessionDir = makeTempDir('pickle-session-contract-files-');
  const statePath = getStatePath(sessionDir);
  const state = sessionState(sessionDir, '/project');
  writeJson(statePath, state);

  assert.deepEqual(loadSessionState(sessionDir), state);
  const notePath = writeSessionFile(sessionDir, 'note.txt', 'durable note');
  assert.equal(notePath, path.join(sessionDir, 'note.txt'));
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'durable note');

  const missingDir = path.join(sessionDir, 'reinitialized');
  const initialized = readOrInitSessionState(missingDir, () => ({ active: false, marker: 'default' }));
  assert.deepEqual(initialized, { active: false, marker: 'default', schema_version: 1 });
  assert.deepEqual(loadSessionState(missingDir), initialized);
});

test('reconcileAllSessionLiveness discovers stale sessions and isolates corrupt entries', async () => {
  await withDataRoot(async (dataRoot) => {
    assert.deepEqual(reconcileAllSessionLiveness(), []);

    const sessionsRoot = path.join(dataRoot, 'sessions');
    const expiredDir = path.join(sessionsRoot, 'expired');
    const currentDir = path.join(sessionsRoot, 'current');
    writeJson(getStatePath(expiredDir), sessionState(expiredDir, '/expired', {
      active: true,
      step: 'implement',
      started_at: '2020-01-01T00:00:00.000Z',
      start_time_epoch: 1_577_836_800,
      max_time_minutes: 1,
    }));
    writeJson(getStatePath(currentDir), sessionState(currentDir, '/current'));
    fs.mkdirSync(path.join(sessionsRoot, 'missing-state'), { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, 'not-a-directory'), 'ignored');
    fs.mkdirSync(path.join(sessionsRoot, 'corrupt'), { recursive: true });
    fs.writeFileSync(getStatePath(path.join(sessionsRoot, 'corrupt')), '{invalid');

    const results = reconcileAllSessionLiveness();
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionDir, expiredDir);
    assert.equal(results[0].reason, 'max_time');
    assert.equal(results[0].state.active, false);
    assert.equal(loadSessionState(currentDir).active, false);
  });
});

test('resolveSessionForCwd keeps live mappings, prunes stale ones, and restores history', async () => {
  await withDataRoot(async (dataRoot) => {
    const cwd = makeTempDir('pickle-session-contract-resolve-');
    const sessionsRoot = path.join(dataRoot, 'sessions');
    const directDir = path.join(sessionsRoot, 'direct');
    writeJson(getStatePath(directDir), sessionState(directDir, cwd, {
      active: true,
      max_time_minutes: 0,
    }));
    await updateSessionMap(cwd, directDir);
    assert.equal(await resolveSessionForCwd(cwd), directDir);

    writeJson(getStatePath(directDir), sessionState(directDir, cwd, {
      active: true,
      step: 'implement',
      started_at: '2020-01-01T00:00:00.000Z',
      start_time_epoch: 1_577_836_800,
      max_time_minutes: 1,
    }));
    assert.equal(await resolveSessionForCwd(cwd), null);
    assert.equal(getSessionForCwd(cwd), null);

    const historicalDir = path.join(sessionsRoot, 'historical');
    writeJson(getStatePath(historicalDir), sessionState(historicalDir, cwd, {
      session_map_cwds: [cwd],
      started_at: '2099-01-01T00:00:00.000Z',
    }));
    assert.equal(await resolveSessionForCwd(cwd, { last: true }), historicalDir);
    assert.equal(getSessionForCwd(cwd), historicalDir);
  });
});

test('deactivateSession records terminal state and removes every owned mapping', async () => {
  await withDataRoot(async (dataRoot) => {
    const primary = makeTempDir('pickle-session-contract-primary-');
    const alias = makeTempDir('pickle-session-contract-alias-');
    const sessionDir = path.join(dataRoot, 'sessions', 'deactivate');
    writeJson(getStatePath(sessionDir), sessionState(sessionDir, primary, {
      active: true,
      step: 'implement',
      current_ticket: 'TICKET-9',
      session_map_cwds: [primary, alias],
    }));
    await updateSessionMap(primary, sessionDir);
    await updateSessionMap(alias, sessionDir);

    const result = await deactivateSession(sessionDir);
    assert.equal(result.active, false);
    assert.equal(result.last_exit_reason, 'cancelled');
    assert.equal(Number.isFinite(Date.parse(result.cancel_requested_at)), true);
    assert.deepEqual(result.history.at(-1), {
      step: 'inactive',
      ticket: 'TICKET-9',
      timestamp: result.history.at(-1).timestamp,
    });
    assert.equal(getSessionForCwd(primary), null);
    assert.equal(getSessionForCwd(alias), null);
  });
});
