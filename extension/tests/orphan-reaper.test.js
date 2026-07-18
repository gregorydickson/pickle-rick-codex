// @tier: fast
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { reapOwnedOrphanProcessGroup } from '../services/orphan-reaper.js';
import { makeTempRoot, waitFor } from './helpers.js';

const childProgram = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';

function spawnDetached(args = []) {
  const child = spawn(process.execPath, ['-e', childProgram, '--', ...args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilAlive(pid) {
  await waitFor(() => processAlive(pid), { message: `child ${pid} did not start` });
}

async function waitForArgv(pid, token) {
  await waitFor(() => {
    const inspected = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return inspected.status === 0 && inspected.stdout.includes(token);
  }, { message: `child ${pid} did not exec with ${token}` });
}

test('orphan reaper terminates only a process group whose argv proves exact session ownership', {
  skip: process.platform === 'win32',
}, async () => {
  const sessionDir = makeTempRoot('pickle-orphan-owned-');
  const child = spawnDetached(['--add-dir', sessionDir]);
  await waitUntilAlive(child.pid);
  await waitForArgv(child.pid, `--add-dir ${sessionDir}`);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const result = reapOwnedOrphanProcessGroup(sessionDir, child.pid, { termGraceMs: 50 });
  assert.equal(result.status, 'reaped', result.reason);
  assert.deepEqual(result.signals, ['SIGTERM', 'SIGKILL']);
  await waitFor(() => !processAlive(child.pid), { message: `owned child ${child.pid} survived reaping` });
});

test('orphan reaper never signals an unrelated live process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const sessionDir = makeTempRoot('pickle-orphan-unrelated-');
  const child = spawnDetached([]);
  t.after(() => {
    if (processAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
  });
  await waitUntilAlive(child.pid);

  const result = reapOwnedOrphanProcessGroup(sessionDir, child.pid, { termGraceMs: 10 });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.signals, []);
  assert.equal(processAlive(child.pid), true);
});

test('orphan reaper refuses KILL after the inspected identity changes', () => {
  const sessionDir = makeTempRoot('pickle-orphan-recycled-');
  const owned = {
    pid: 1234,
    pgid: 1234,
    argv: ['codex', 'exec', '--add-dir', sessionDir],
    command: null,
    fingerprint: 'owned',
  };
  const recycled = { ...owned, fingerprint: 'recycled' };
  let inspections = 0;
  const signals = [];
  const result = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: () => (++inspections < 3 ? owned : recycled),
    signalGroup: (_pgid, signal) => signals.push(signal),
    wait: () => {},
  });

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(result.signals, ['SIGTERM']);
});
