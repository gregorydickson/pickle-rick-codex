// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionHashOf, isForeignTmuxSession } from '../services/tmux.js';

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
