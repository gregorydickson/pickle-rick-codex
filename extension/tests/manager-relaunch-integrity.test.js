// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditCodexManagerRelaunchCaps,
  auditDeclaredRunnerRelaunchCallsites,
  CODEX_MANAGER_RELAUNCH_CAP,
  recordCodexManagerRelaunch,
} from '../services/manager-relaunch-integrity.js';
import { makeTempRoot, writeJson } from './helpers.js';

function createState(sessionDir, overrides = {}) {
  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    working_dir: process.cwd(),
    step: 'paused',
    iteration: 0,
    history: [],
    manager_relaunch_count: 0,
    manager_relaunch_history: [],
    schema_version: 1,
    ...overrides,
  });
}

test('persisted Codex manager relaunch count is bounded at the session cap', () => {
  const sessionDir = makeTempRoot('pickle-relaunch-cap-');
  createState(sessionDir);
  for (let index = 1; index <= CODEX_MANAGER_RELAUNCH_CAP; index += 1) {
    assert.equal(recordCodexManagerRelaunch(sessionDir, 'pickle-tmux'), index);
  }
  assert.throws(
    () => recordCodexManagerRelaunch(sessionDir, 'pickle-tmux'),
    /relaunch cap 10 reached/,
  );
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.manager_relaunch_count, CODEX_MANAGER_RELAUNCH_CAP);
  assert.equal(state.manager_relaunch_history.length, CODEX_MANAGER_RELAUNCH_CAP);
});

test('bundle audit fails closed for an excessive count and undeclared relaunch path', () => {
  const sessionDir = makeTempRoot('pickle-relaunch-audit-');
  createState(sessionDir, {
    manager_relaunch_count: CODEX_MANAGER_RELAUNCH_CAP + 1,
    manager_relaunch_history: [{ path: 'mystery-manager', timestamp: new Date().toISOString() }],
  });
  const audit = auditCodexManagerRelaunchCaps(sessionDir);
  assert.equal(audit.checkedStatePaths.length, 1);
  assert.equal(audit.violations.length, 2);
  assert.match(audit.violations[0].reason, /exceeds cap/);
  assert.match(audit.violations[1].reason, /undeclared runner relaunch path/);
});

test('source invariant admits only the three declared runner relaunch boundaries', () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  assert.deepEqual(auditDeclaredRunnerRelaunchCallsites(sourceRoot), []);
});
