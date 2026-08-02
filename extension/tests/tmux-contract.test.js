// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearTmuxSession,
  ensureTmuxAvailable,
  getRuntimeRoot,
  respawnOwnedTmuxPane,
  runTmux,
  shellQuote,
  tmuxSessionExists,
  waitForTmuxRunnerStart,
} from '../services/tmux.js';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tmux-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installFakeTmux(dir) {
  const executable = path.join(dir, 'tmux');
  fs.writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
if [ "$1" = "-V" ]; then
  printf '%s\\n' "tmux 3.4-contract"
  exit "\${TMUX_VERSION_STATUS:-0}"
fi
if [ "$1" = "has-session" ]; then
  exit "\${TMUX_HAS_SESSION_STATUS:-0}"
fi
if [ "\${TMUX_COMMAND_FAIL:-0}" = "1" ]; then
  printf '%s\\n' "fake tmux command failed" >&2
  exit 7
fi
printf '%s\\n' "fake tmux output"
`);
  fs.chmodSync(executable, 0o755);
}

test('tmux command adapter reports availability, existence, mutation, and failures', (t) => {
  const dir = makeTempDir(t);
  const logPath = path.join(dir, 'tmux.log');
  installFakeTmux(dir);
  const originalPath = process.env.PATH;
  const originalLog = process.env.TMUX_TEST_LOG;
  const originalVersionStatus = process.env.TMUX_VERSION_STATUS;
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.TMUX_TEST_LOG = logPath;

  try {
    assert.equal(getRuntimeRoot(), path.resolve('.'));
    assert.equal(shellQuote("runner's command"), `'runner'\\''s command'`);
    assert.equal(ensureTmuxAvailable(), 'tmux 3.4-contract');

    process.env.TMUX_VERSION_STATUS = '1';
    assert.throws(ensureTmuxAvailable, /tmux is required/);
    delete process.env.TMUX_VERSION_STATUS;

    const baseOptions = {
      cwd: dir,
      timeoutMs: 1_000,
      env: { PATH: `${dir}:${originalPath}`, TMUX_TEST_LOG: logPath },
    };
    assert.equal(tmuxSessionExists('pickle-deadbeef', baseOptions), true);
    assert.equal(tmuxSessionExists('pickle-deadbeef', {
      ...baseOptions,
      env: { ...baseOptions.env, TMUX_HAS_SESSION_STATUS: '1' },
    }), false);
    assert.equal(clearTmuxSession('pickle-deadbeef', '/tmp/session-deadbeef', {
      ...baseOptions,
      env: { ...baseOptions.env, TMUX_HAS_SESSION_STATUS: '1' },
    }), false);

    respawnOwnedTmuxPane(
      'pickle-deadbeef',
      '/tmp/session-deadbeef',
      'pickle-deadbeef:0.0',
      'node runner.js',
      baseOptions,
    );
    assert.equal(runTmux(['display-message', 'ready'], baseOptions), 'fake tmux output');
    assert.throws(
      () => runTmux(['display-message', 'broken'], {
        ...baseOptions,
        env: { ...baseOptions.env, TMUX_COMMAND_FAIL: '1' },
      }),
      /fake tmux command failed/,
    );

    assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [
      '-V',
      '-V',
      'has-session -t pickle-deadbeef',
      'has-session -t pickle-deadbeef',
      'has-session -t pickle-deadbeef',
      'respawn-pane -k -t pickle-deadbeef:0.0 node runner.js',
      'display-message ready',
      'display-message broken',
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.TMUX_TEST_LOG;
    else process.env.TMUX_TEST_LOG = originalLog;
    if (originalVersionStatus === undefined) delete process.env.TMUX_VERSION_STATUS;
    else process.env.TMUX_VERSION_STATUS = originalVersionStatus;
  }
});

test('waitForTmuxRunnerStart accepts matching persisted runner identity', async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    active: true,
    tmux_session_name: 'pipeline-deadbeef',
    tmux_runner_pid: process.pid,
  }));

  await assert.doesNotReject(
    waitForTmuxRunnerStart(dir, 'pipeline-deadbeef', 'pipeline', { timeoutMs: 100, intervalMs: 1 }),
  );
});

test('waitForTmuxRunnerStart accepts a live persisted starting owner and rejects log-only startup', async (t) => {
  const dir = makeTempDir(t);
  const logPath = path.join(dir, 'loop-runner.log');
  const stalePrefix = 'loop-runner started in a prior launch\n';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    active: true,
    tmux_session_name: 'loop-other',
    tmux_runner_pid: 0,
  }));
  fs.writeFileSync(logPath, `${stalePrefix}loop-runner started\n`);

  await assert.rejects(waitForTmuxRunnerStart(dir, 'loop-deadbeef', 'loop', {
    timeoutMs: 100,
    intervalMs: 1,
    existingLogSizeBytes: Buffer.byteLength(stalePrefix),
  }), /tmux runner did not start for loop-deadbeef/);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    active: false,
    runner_starting: true,
    tmux_session_name: 'loop-deadbeef',
    tmux_runner_pid: process.pid,
  }));
  await assert.doesNotReject(
    waitForTmuxRunnerStart(dir, 'loop-deadbeef', 'loop', {
      timeoutMs: 100,
      intervalMs: 1,
      existingLogSizeBytes: fs.statSync(logPath).size,
    }),
  );
});
