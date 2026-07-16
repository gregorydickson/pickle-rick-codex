// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { waitForTmuxRunnerStart } from '../services/tmux.js';

const DEAD_PID = 99_999_999;
const BASE_TIME = 1_700_000_000_000;

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recoverable-json-wiring-tmux-')));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function setMtime(filePath, epochMs) {
  const time = new Date(epochMs);
  fs.utimesSync(filePath, time, time);
}

async function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('VAL-CROSS-002: waitForTmuxRunnerStart recovers a newer valid dead-PID orphan tmp state.json', async () => {
  await withTempDir(async (dir) => {
    const sessionName = 'pickle-sess-a';
    const statePath = path.join(dir, 'state.json');
    const tmp = `${statePath}.tmp.${DEAD_PID}.orphan`;

    // Stale base has NOT started the runner; the orphan tmp holds the started payload.
    writeJson(statePath, { active: false });
    writeJson(tmp, { active: true, tmux_session_name: sessionName, tmux_runner_pid: 4242 });
    setMtime(statePath, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    await assert.doesNotReject(
      waitForTmuxRunnerStart(dir, sessionName, 'pickle', { timeoutMs: 2_000, intervalMs: 20 }),
    );

    // The orphan tmp was promoted to the base file and removed.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(statePath, 'utf8')),
      { active: true, tmux_session_name: sessionName, tmux_runner_pid: 4242 },
    );
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('waitForTmuxRunnerStart still times out when no started state or runner log exists', async () => {
  await withTempDir(async (dir) => {
    const sessionName = 'pickle-sess-b';
    // Absent state.json (missing => null) and no runner log: behavior preserved (throws).
    await assert.rejects(
      waitForTmuxRunnerStart(dir, sessionName, 'pickle', { timeoutMs: 60, intervalMs: 20 }),
      /tmux runner did not start/,
    );
  });
});
