// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';
import { makeTempRoot, writeJson } from './helpers.js';
import { StateManager } from '../services/state-manager.js';

function bindingFor(sessionDir, overrides = {}) {
  return {
    schema_version: 1,
    session_name: `pickle-${path.basename(sessionDir)}`,
    session_id: '$7',
    session_created: '1723147200',
    pane_id: '%11',
    pane_pid: 4200,
    pane_start_command: `bash -lc 'node /runtime/bin/supervised-runner.js ${fs.realpathSync(sessionDir)} --runner-bin=mux-runner.js'`,
    ...overrides,
  };
}

function terminalSession(sessionDir, overrides = {}) {
  const binding = bindingFor(sessionDir);
  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    tmux_session_name: binding.session_name,
    tmux_runner_binding: binding,
    ...overrides,
  });
  return binding;
}

test('terminal tmux cleanup inspects twice and kills only the immutable session id', () => {
  const sessionDir = makeTempRoot('pickle-tmux-terminal-');
  const binding = terminalSession(sessionDir);
  const reads = [];
  const kills = [];
  const result = cleanupTerminalTmuxSession(sessionDir, {
    readBinding: (target) => { reads.push(target); return binding; },
    killSessionId: (id) => kills.push(id),
    now: () => '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.status, 'cleaned');
  assert.deepEqual(reads, ['%11', '%11']);
  assert.deepEqual(kills, ['$7']);
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.tmux_cleanup_status, 'cleaned');
});

test('terminal cleanup quarantines legacy name-only state without signaling it', () => {
  const sessionDir = makeTempRoot('pickle-tmux-quarantine-');
  terminalSession(sessionDir, { tmux_runner_binding: null });
  let kills = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, { killSessionId: () => { kills += 1; } });
  assert.equal(result.status, 'quarantined');
  assert.equal(kills, 0);
  const report = JSON.parse(fs.readFileSync(path.join(sessionDir, 'tmux-quarantine.json'), 'utf8'));
  assert.equal(report.action, 'left-running');
});

test('same-name reuse between initial check and kill never kills the foreign session', () => {
  const sessionDir = makeTempRoot('pickle-tmux-reuse-');
  const binding = terminalSession(sessionDir);
  const replacement = { ...binding, session_id: '$8', pane_id: '%12', pane_pid: 4300 };
  let current = binding;
  const kills = [];
  const result = cleanupTerminalTmuxSession(sessionDir, {
    readBinding: () => current,
    beforeRecheck: () => { current = replacement; },
    killSessionId: (id) => kills.push(id),
  });
  assert.equal(result.status, 'quarantined');
  assert.deepEqual(kills, []);
});

test('pane command mismatch fails closed before destruction', () => {
  const sessionDir = makeTempRoot('pickle-tmux-command-');
  const binding = terminalSession(sessionDir);
  let kills = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, {
    readBinding: () => ({ ...binding, pane_start_command: 'bash' }),
    killSessionId: () => { kills += 1; },
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(kills, 0);
});

test('terminal tmux cleanup preserves an explicitly requested monitor', () => {
  const sessionDir = makeTempRoot('pickle-tmux-preserve-');
  terminalSession(sessionDir, { preserve_tmux_monitor: true });
  let kills = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, { killSessionId: () => { kills += 1; } });
  assert.equal(result.status, 'preserved');
  assert.equal(kills, 0);
});

test('terminal tmux cleanup does not touch an active session', () => {
  const sessionDir = makeTempRoot('pickle-tmux-active-');
  terminalSession(sessionDir, { active: true });
  let kills = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, { killSessionId: () => { kills += 1; } });
  assert.equal(result.status, 'not-terminal');
  assert.equal(kills, 0);
});

test('terminal cleanup holds the state lock through recheck and immutable kill', () => {
  const sessionDir = makeTempRoot('pickle-tmux-atomic-');
  const binding = terminalSession(sessionDir);
  const manager = new StateManager();
  let lockHeldDuringKill = false;
  const originalAcquire = manager.acquireLock.bind(manager);
  const originalRelease = manager.releaseLock.bind(manager);
  let held = false;
  manager.acquireLock = (statePath) => { originalAcquire(statePath); held = true; };
  manager.releaseLock = (statePath) => { held = false; originalRelease(statePath); };
  const result = cleanupTerminalTmuxSession(sessionDir, {
    stateManager: manager,
    readBinding: () => binding,
    killSessionId: () => { lockHeldDuringKill = held; },
  });
  assert.equal(result.status, 'cleaned');
  assert.equal(lockHeldDuringKill, true);
});
