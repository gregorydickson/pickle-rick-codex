// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJsonFile } from '../services/pickle-utils.js';
import { StateManager, StateError } from '../services/state-manager.js';
import { getSessionForCwd, findLastSessionForCwd } from '../services/session-map.js';

const DEAD_PID = 99_999_999;
const BASE_TIME = 1_700_000_000_000;

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recoverable-json-wiring-')));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function setMtime(filePath, epochMs) {
  const time = new Date(epochMs);
  fs.utimesSync(filePath, time, time);
}

function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('VAL-CROSS-002: pickle-utils.readJsonFile recovers a newer valid dead-PID orphan tmp', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'state.json');
    const tmp = `${target}.tmp.${DEAD_PID}.orphan`;
    writeJson(target, { step: 'stale', schema_version: 1 });
    writeJson(tmp, { step: 'recovered', schema_version: 1 });
    setMtime(target, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    const result = readJsonFile(target);

    assert.deepEqual(result, { step: 'recovered', schema_version: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { step: 'recovered', schema_version: 1 });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readJsonFile preserves well-formed base behavior and fallback when no orphan tmp exists', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'state.json');
    writeJson(target, { step: 'clean' });
    const original = fs.readFileSync(target, 'utf8');

    assert.deepEqual(readJsonFile(target), { step: 'clean' });
    assert.equal(fs.readFileSync(target, 'utf8'), original);

    const missing = path.join(dir, 'missing.json');
    assert.equal(readJsonFile(missing), null);
    assert.deepEqual(readJsonFile(missing, {}), {});
  });
});

test('VAL-CROSS-002: StateManager.read recovers a newer valid dead-PID orphan tmp', () => {
  withTempDir((dir) => {
    const statePath = path.join(dir, 'state.json');
    const tmp = `${statePath}.tmp.${DEAD_PID}.orphan`;
    writeJson(statePath, { step: 'stale', schema_version: 1 });
    writeJson(tmp, { step: 'recovered', schema_version: 1 });
    setMtime(statePath, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    const state = new StateManager().read(statePath);

    assert.equal(state.step, 'recovered');
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { step: 'recovered', schema_version: 1 });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('StateManager.read still throws MISSING/CORRUPT when nothing valid exists', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'state.json');
    assert.throws(() => new StateManager().read(missing), (error) =>
      error instanceof StateError && error.code === 'MISSING');

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    assert.throws(() => new StateManager().read(corrupt), (error) =>
      error instanceof StateError && error.code === 'CORRUPT');
  });
});

test('VAL-CROSS-002: session-map readers recover a newer valid dead-PID orphan tmp', () => {
  const previous = process.env.PICKLE_DATA_ROOT;
  const dataRoot = makeTempDir();
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const projectDir = path.join(dataRoot, 'project');
    const sessionsRoot = path.join(dataRoot, 'sessions');
    const sessionDir = path.join(sessionsRoot, 'sess-a');
    fs.mkdirSync(sessionDir, { recursive: true });

    // current_sessions.json orphan tmp recovery (reached via readJsonFile seam).
    const mapPath = path.join(dataRoot, 'current_sessions.json');
    const mapTmp = `${mapPath}.tmp.${DEAD_PID}.orphan`;
    writeJson(mapPath, {});
    writeJson(mapTmp, { [projectDir]: sessionDir });
    setMtime(mapPath, BASE_TIME);
    setMtime(mapTmp, BASE_TIME + 1_000);

    assert.equal(getSessionForCwd(projectDir), sessionDir);
    assert.equal(fs.existsSync(mapTmp), false);

    // state.json orphan tmp recovery in findLastSessionForCwd's direct read site.
    const statePath = path.join(sessionDir, 'state.json');
    const stateTmp = `${statePath}.tmp.${DEAD_PID}.orphan`;
    writeJson(statePath, { working_dir: '/somewhere/else', started_at: '2026-01-01T00:00:00.000Z' });
    writeJson(stateTmp, { working_dir: projectDir, started_at: '2026-06-01T00:00:00.000Z' });
    setMtime(statePath, BASE_TIME);
    setMtime(stateTmp, BASE_TIME + 1_000);

    assert.equal(findLastSessionForCwd(projectDir), sessionDir);
    assert.equal(fs.existsSync(stateTmp), false);
  } finally {
    if (previous === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previous;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
