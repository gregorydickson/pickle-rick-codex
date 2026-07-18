// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';
import { makeTempRoot, writeJson } from './helpers.js';

function terminalSession(sessionDir, overrides = {}) {
  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    tmux_session_name: `pickle-${path.basename(sessionDir)}`,
    ...overrides,
  });
}

test('terminal tmux cleanup removes the exact owned recorded session', () => {
  const sessionDir = makeTempRoot('pickle-tmux-terminal-');
  terminalSession(sessionDir);
  const calls = [];
  const result = cleanupTerminalTmuxSession(sessionDir, {
    clearSession: (name, ownedDir) => {
      calls.push([name, ownedDir]);
      return true;
    },
    now: () => '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.status, 'cleaned');
  assert.deepEqual(calls, [[`pickle-${path.basename(sessionDir)}`, sessionDir]]);
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.tmux_cleanup_status, 'cleaned');
});

test('terminal tmux cleanup quarantines a mismatched legacy name without signaling it', () => {
  const sessionDir = makeTempRoot('pickle-tmux-quarantine-');
  terminalSession(sessionDir, { tmux_session_name: 'pickle-legacy-session-name' });
  let clearCalls = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, {
    clearSession: () => {
      clearCalls += 1;
      return true;
    },
    now: () => '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.status, 'quarantined');
  assert.equal(clearCalls, 0);
  const report = JSON.parse(fs.readFileSync(path.join(sessionDir, 'tmux-quarantine.json'), 'utf8'));
  assert.equal(report.tmux_session_name, 'pickle-legacy-session-name');
  assert.equal(report.action, 'left-running');
});

test('terminal tmux cleanup preserves an explicitly requested monitor', () => {
  const sessionDir = makeTempRoot('pickle-tmux-preserve-');
  terminalSession(sessionDir, { preserve_tmux_monitor: true });
  let clearCalls = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, {
    clearSession: () => {
      clearCalls += 1;
      return true;
    },
  });

  assert.equal(result.status, 'preserved');
  assert.equal(clearCalls, 0);
});

test('terminal tmux cleanup does not touch an active session', () => {
  const sessionDir = makeTempRoot('pickle-tmux-active-');
  terminalSession(sessionDir, { active: true });
  let clearCalls = 0;
  const result = cleanupTerminalTmuxSession(sessionDir, {
    clearSession: () => {
      clearCalls += 1;
      return true;
    },
  });

  assert.equal(result.status, 'not-terminal');
  assert.equal(clearCalls, 0);
});
