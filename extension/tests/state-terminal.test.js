// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../services/state-manager.js';
import { finalizeTerminalState, finalizeTerminalStateObject } from '../services/state-terminal.js';
import { makeTempRoot, writeJson } from './helpers.js';

function activeState(overrides = {}) {
  return {
    schema_version: 1,
    active: true,
    step: 'implement',
    history: [],
    tmux_runner_pid: 101,
    worker_pid: 102,
    active_child_pid: 103,
    active_child_kind: 'codex',
    active_child_command: 'codex exec',
    last_exit_reason: null,
    ...overrides,
  };
}

test('terminal finalization atomically deactivates runtime fields and records the reason', () => {
  const sessionDir = makeTempRoot('pickle-terminal-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, activeState());
  const result = finalizeTerminalState(new StateManager(), statePath, { exitReason: 'error' });

  assert.equal(result.exitReason, 'error');
  assert.equal(result.state.active, false);
  assert.equal(result.state.last_exit_reason, 'error');
  for (const key of ['tmux_runner_pid', 'worker_pid', 'active_child_pid', 'active_child_kind', 'active_child_command']) {
    assert.equal(result.state[key], null);
  }
});

test('terminal finalization cannot erase an earlier abnormal reason with late success', () => {
  const state = activeState({ active: false, last_exit_reason: 'cancelled' });
  const reason = finalizeTerminalStateObject(state, { exitReason: 'success' });
  assert.equal(reason, 'cancelled');
  assert.equal(state.last_exit_reason, 'cancelled');
});

test('new abnormal evidence supersedes an earlier successful terminal marker', () => {
  const state = activeState({ active: false, last_exit_reason: 'success' });
  const reason = finalizeTerminalStateObject(state, { exitReason: 'error' });
  assert.equal(reason, 'error');
  assert.equal(state.last_exit_reason, 'error');
});

test('deferred pipeline phase finalization deactivates without prematurely writing an exit reason', () => {
  const state = activeState();
  const reason = finalizeTerminalStateObject(state, { exitReason: 'error', deferExitReason: true });
  assert.equal(reason, 'error');
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, null);
});

test('mux, loop, and pipeline terminal paths use the central finalizer', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const expected = new Map([
    ['services/pipeline-bootstrap.ts', 'finalizeTerminalStateObject'],
    ['services/pipeline-phase-setup.ts', 'finalizeTerminalStateObject'],
    ['services/pipeline-state.ts', 'finalizeTerminalStateObject'],
    ['bin/pipeline-runner.ts', 'finalizeTerminalState'],
  ]);
  for (const [relative, symbol] of expected) {
    const source = fs.readFileSync(path.join(srcRoot, relative), 'utf8');
    assert.match(source, new RegExp(`${symbol}\\(`), relative);
  }
});
