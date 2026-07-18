// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearTmuxSession, respawnOwnedTmuxPane, sessionHashOf, isForeignTmuxSession } from '../services/tmux.js';

test('isForeignTmuxSession flags a trailing-hash mismatch as foreign', () => {
  assert.equal(
    isForeignTmuxSession('pipeline-aaaaaaaa', '/tmp/pickle-rick/sessions/some-session-bbbbbbbb'),
    true,
  );
});

test('isForeignTmuxSession recognizes our own session when hashes match', () => {
  assert.equal(
    isForeignTmuxSession('pipeline-86dd509f', '/tmp/pickle-rick/sessions/some-session-86dd509f'),
    false,
  );
});

test('isForeignTmuxSession fails CLOSED on an unrelated ambient name', () => {
  assert.equal(
    isForeignTmuxSession('pickle-dead', '/tmp/pickle-rick/sessions/some-session-86dd509f'),
    true,
  );
});

test('sessionHashOf returns the substring after the last hyphen', () => {
  assert.equal(sessionHashOf('pipeline-86dd509f'), '86dd509f');
  assert.equal(sessionHashOf('a-b-c-deadbeef'), 'deadbeef');
});

test('sessionHashOf returns the whole string when there is no hyphen', () => {
  assert.equal(sessionHashOf('nohyphen'), 'nohyphen');
  assert.equal(sessionHashOf(''), '');
});

test('clearTmuxSession refuses a foreign session before invoking tmux', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-foreign-tmux-'));
  const logPath = path.join(dir, 'tmux.log');
  const fakeTmux = path.join(dir, 'tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_TEST_LOG"\nexit 0\n`);
  fs.chmodSync(fakeTmux, 0o755);

  assert.throws(
    () => clearTmuxSession('pickle-aaaaaaaa', '/tmp/sessions/pickle-bbbbbbbb', {
      env: { PATH: `${dir}:${process.env.PATH}`, TMUX_TEST_LOG: logPath },
    }),
    /Refusing to mutate foreign tmux session pickle-aaaaaaaa/,
  );
  assert.equal(fs.existsSync(logPath), false, 'foreign ownership must be rejected before any tmux command');
});

test('clearTmuxSession kills an existing owned session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-owned-tmux-'));
  const logPath = path.join(dir, 'tmux.log');
  const fakeTmux = path.join(dir, 'tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_TEST_LOG"\nexit 0\n`);
  fs.chmodSync(fakeTmux, 0o755);

  assert.equal(clearTmuxSession('pickle-86dd509f', '/tmp/sessions/pickle-86dd509f', {
    env: { PATH: `${dir}:${process.env.PATH}`, TMUX_TEST_LOG: logPath },
  }), true);
  assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [
    'has-session -t pickle-86dd509f',
    'kill-session -t pickle-86dd509f',
  ]);
});

test('respawnOwnedTmuxPane refuses to kill a pane in a foreign session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-foreign-pane-'));
  const logPath = path.join(dir, 'tmux.log');
  const fakeTmux = path.join(dir, 'tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_TEST_LOG"\nexit 0\n`);
  fs.chmodSync(fakeTmux, 0o755);

  assert.throws(
    () => respawnOwnedTmuxPane(
      'pickle-aaaaaaaa',
      '/tmp/sessions/pickle-bbbbbbbb',
      'pickle-aaaaaaaa:0',
      'echo unsafe',
      { env: { PATH: `${dir}:${process.env.PATH}`, TMUX_TEST_LOG: logPath } },
    ),
    /Refusing to mutate foreign tmux session pickle-aaaaaaaa/,
  );
  assert.equal(fs.existsSync(logPath), false, 'foreign pane ownership must be rejected before tmux respawn');
});
