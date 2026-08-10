// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
} from '../services/orphan-reaper.js';
import { recoverMonitoredProcessOwnership } from '../services/monitored-process-ownership.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot, repoRoot, waitFor, writeExecutable } from './helpers.js';

const brokerPath = path.join(repoRoot, 'bin/monitored-process-broker.js');

function commandDigest({ command, args, cwd }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ command, args, cwd: cwd || null }))
    .digest('hex');
}

function appendJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const payload = fs.readFileSync(filePath, 'utf8').trim();
  return payload ? payload.split('\n').map((line) => JSON.parse(line)) : [];
}

function createTargetFixture(root) {
  const descendantPath = writeExecutable(path.join(root, 'descendant.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
const nonce = process.env.DESCENDANT_NONCE;
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.SIGNAL_LOG, JSON.stringify({ role: 'descendant', pid: process.pid, nonce, signal: 'SIGTERM' }) + '\\n');
});
fs.appendFileSync(process.env.READINESS_LOG, JSON.stringify({ role: 'descendant', pid: process.pid, nonce }) + '\\n');
setInterval(() => {}, 1000);
`);

  return writeExecutable(path.join(root, 'target.mjs'), `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const nonce = process.env.TARGET_NONCE;
const descendantCommand = process.env.TRANSITION_DESCENDANT === '1' ? '/bin/sh' : process.execPath;
const descendantArgs = process.env.TRANSITION_DESCENDANT === '1'
  ? ['-c', 'if [ "$HOLD_TRANSITION" = "1" ]; then : > "$TRANSITION_READY"; while [ ! -f "$TRANSITION_GATE" ]; do sleep 0.01; done; else sleep 0.2; fi; exec "$NODE_BIN" "$DESCENDANT_PATH"']
  : [${JSON.stringify(descendantPath)}];
const descendant = spawn(descendantCommand, descendantArgs, {
  detached: process.env.DETACHED_DESCENDANT === '1',
  stdio: 'ignore',
  env: { ...process.env, NODE_BIN: process.execPath, DESCENDANT_PATH: ${JSON.stringify(descendantPath)} },
});
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.SIGNAL_LOG, JSON.stringify({ role: 'target', pid: process.pid, nonce, signal: 'SIGTERM' }) + '\\n');
});
fs.appendFileSync(process.env.READINESS_LOG, JSON.stringify({ role: 'target', pid: process.pid, nonce, descendant_pid: descendant.pid }) + '\\n');
const ready = setInterval(() => {
  const lines = fs.existsSync(process.env.READINESS_LOG) ? fs.readFileSync(process.env.READINESS_LOG, 'utf8') : '';
  if (!lines.includes('"role":"descendant"')) return;
  clearInterval(ready);
  fs.writeFileSync(process.env.SUCCESS_ARTIFACT, 'complete\\n');
  if (process.env.CLOSE_STDIO === '1') {
    for (const fd of [0, 1, 2]) { try { fs.closeSync(fd); } catch {} }
  }
  if (process.env.MODE === 'direct-exit') {
    const gate = setInterval(() => {
      if (!fs.existsSync(process.env.RELEASE_GATE)) return;
      clearInterval(gate);
      process.exit(23);
    }, 10);
  }
}, 10);
setInterval(() => {}, 1000);
`);
}

function startBroker(t) {
  const child = spawn(process.execPath, [brokerPath], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  child.on('message', (message) => messages.push(message));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  });
  return { child, messages, exited, closed, stderr: () => stderr };
}

function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function waitForMessage(run, type) {
  return await waitFor(
    () => run.messages.find((message) => message?.type === type),
    { timeoutMs: 10_000, message: `Timed out waiting for broker ${type}; stderr=${run.stderr()}` },
  );
}

async function waitForFixtureIdentities(readinessLog) {
  const records = await waitFor(() => {
    const current = appendJsonLines(readinessLog);
    return current.some(({ role }) => role === 'target')
      && current.some(({ role }) => role === 'descendant') ? current : null;
  }, { timeoutMs: 10_000, message: 'Target tree did not publish exact readiness records' });
  const identities = Object.fromEntries(records.map((record) => {
    const identity = captureProcessLivenessIdentity(record.pid, { identityKind: 'descendant' });
    assert.ok(identity, `${record.role} ${record.pid} must be live at its readiness fence`);
    return [record.role, { record, identity }];
  }));
  return identities;
}

async function assertTreeAbsent(...identities) {
  await waitFor(
    () => identities.every((identity) => inspectProcessLivenessIdentity(identity) === 'not-running'),
    { timeoutMs: 10_000, message: 'Broker returned before every immutable process identity was absent' },
  );
  for (const identity of identities) {
    assert.equal(inspectProcessLivenessIdentity(identity), 'not-running');
  }
}

function launchFixture(run, root, overrides = {}) {
  const command = createTargetFixture(root);
  const args = [];
  const cwd = root;
  const launchId = crypto.randomUUID();
  const digest = commandDigest({ command, args, cwd });
  const env = {
    ...process.env,
    MODE: 'linger',
    CLOSE_STDIO: '1',
    TARGET_NONCE: crypto.randomUUID(),
    DESCENDANT_NONCE: crypto.randomUUID(),
    READINESS_LOG: path.join(root, 'readiness.jsonl'),
    SIGNAL_LOG: path.join(root, 'signals.jsonl'),
    SUCCESS_ARTIFACT: path.join(root, 'success.txt'),
    RELEASE_GATE: path.join(root, 'release'),
    TRANSITION_READY: path.join(root, 'transition-ready'),
    TRANSITION_GATE: path.join(root, 'transition-release'),
    ...overrides,
  };
  return {
    request: { type: 'launch', launch_id: launchId, command_digest: digest, command, args, cwd, env },
    launchId,
    digest,
    env,
  };
}

for (const cause of ['success', 'timeout', 'cancel']) {
  test(`broker ${cause} shutdown TERM/KILLs a stubborn closed-stdio target tree exactly once`, { timeout: 30_000 }, async (t) => {
    const root = makeTempRoot(`pickle-broker-${cause}-`);
    const run = startBroker(t);
    const fixture = launchFixture(run, root);
    await send(run.child, fixture.request);
    const launched = await waitForMessage(run, 'launched');
    assert.equal(launched.launch_id, fixture.launchId);
    assert.equal(launched.command_digest, fixture.digest);
    assert.equal(launched.broker_identity.pid, run.child.pid);
    assert.equal(launched.broker_identity.pgid, run.child.pid);
    assert.equal(launched.target_identity.pgid, run.child.pid);
    await send(run.child, {
      type: 'release',
      launch_id: crypto.randomUUID(),
      command_digest: fixture.digest,
    });
    await send(run.child, {
      type: 'release',
      launch_id: fixture.launchId,
      command_digest: '0'.repeat(64),
    });
    assert.equal(inspectProcessLivenessIdentity(launched.target_identity), 'matched');
    assert.equal(fs.existsSync(fixture.env.READINESS_LOG), false,
      'stale or malformed release must leave the target stopped');
    await send(run.child, {
      type: 'release',
      launch_id: fixture.launchId,
      command_digest: fixture.digest,
    });
    const released = await waitForMessage(run, 'released');
    assert.equal(released.launch_id, fixture.launchId);
    assert.equal(released.command_digest, fixture.digest);
    assert.deepEqual(released.broker_identity, launched.broker_identity);
    assert.deepEqual(released.target_identity, launched.target_identity);

    const tree = await waitForFixtureIdentities(fixture.env.READINESS_LOG);
    assert.notEqual(tree.target.identity.pid, launched.target_identity.pid,
      'the stable guardian identity must be distinct from the user target');
    assert.equal(tree.target.identity.pgid, launched.target_identity.pgid);
    assert.equal(tree.descendant.identity.pgid, launched.broker_identity.pgid);
    await waitFor(() => fs.existsSync(fixture.env.SUCCESS_ARTIFACT), {
      timeoutMs: 10_000,
      message: 'Target did not publish its success artifact before shutdown',
    });

    // Stale/malformed control messages and a duplicate launch must not alter
    // the authenticated launch. Liveness and the single readiness record are
    // deterministic evidence that no second target was admitted.
    await send(run.child, { type: 'terminate', launch_id: crypto.randomUUID(), cause, grace_ms: 100 });
    await send(run.child, { type: 'terminate', launch_id: fixture.launchId, cause: 42, grace_ms: 100 });
    await send(run.child, fixture.request);
    assert.equal(inspectProcessLivenessIdentity(tree.target.identity), 'matched');
    assert.equal(appendJsonLines(fixture.env.READINESS_LOG).filter(({ role }) => role === 'target').length, 1);

    const terminate = { type: 'terminate', launch_id: fixture.launchId, cause, grace_ms: 150 };
    await send(run.child, terminate);
    await send(run.child, terminate);
    const acknowledgement = await waitForMessage(run, 'shutdown_ack');
    assert.equal(acknowledgement.launch_id, fixture.launchId);
    assert.equal(acknowledgement.command_digest, fixture.digest);
    assert.equal(acknowledgement.cause, cause);
    assert.deepEqual(acknowledgement.broker_identity, launched.broker_identity);
    assert.deepEqual(acknowledgement.target_identity, launched.target_identity);
    assert.deepEqual(new Set(acknowledgement.descendant_identities.map(({ pid }) => pid)),
      new Set([tree.target.identity.pid, tree.descendant.identity.pid]));
    await send(run.child, {
      type: 'shutdown_release', launch_id: fixture.launchId, command_digest: fixture.digest,
    });

    await run.closed;
    assert.equal(run.messages.filter(({ type }) => type === 'shutdown_ack').length, 1);
    await assertTreeAbsent(launched.broker_identity, launched.target_identity,
      tree.target.identity, tree.descendant.identity);
    assert.deepEqual(
      new Set(appendJsonLines(fixture.env.SIGNAL_LOG).map(({ role, pid, nonce, signal }) => `${role}:${pid}:${nonce}:${signal}`)),
      new Set([
        `target:${tree.target.record.pid}:${tree.target.record.nonce}:SIGTERM`,
        `descendant:${tree.descendant.record.pid}:${tree.descendant.record.nonce}:SIGTERM`,
      ]),
    );
  });
}

test('direct target exit still reaps a stubborn descendant and reports the target outcome', { timeout: 30_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-direct-exit-');
  const run = startBroker(t);
  const fixture = launchFixture(run, root, { MODE: 'direct-exit', CLOSE_STDIO: '0' });
  await send(run.child, fixture.request);
  const launched = await waitForMessage(run, 'launched');
  await send(run.child, {
    type: 'release',
    launch_id: fixture.launchId,
    command_digest: fixture.digest,
  });
  const released = await waitForMessage(run, 'released');
  assert.deepEqual(released.target_identity, launched.target_identity,
    'natural fast exit is authorized only after the exact guardian release is attested');
  const tree = await waitForFixtureIdentities(fixture.env.READINESS_LOG);
  await waitFor(() => fs.existsSync(fixture.env.SUCCESS_ARTIFACT), { timeoutMs: 10_000 });
  fs.writeFileSync(fixture.env.RELEASE_GATE, 'exit\n');

  const acknowledgement = await waitForMessage(run, 'shutdown_ack');
  assert.equal(acknowledgement.cause, 'target-exit');
  assert.equal(acknowledgement.target_exit_code, 23);
  assert.equal(acknowledgement.target_signal, null);
  await send(run.child, {
    type: 'shutdown_release', launch_id: fixture.launchId, command_digest: fixture.digest,
  });
  await run.closed;
  await assertTreeAbsent(launched.broker_identity, launched.target_identity,
    tree.target.identity, tree.descendant.identity);
});

test('shutdown ledger reaps a detached setsid descendant outside the broker process group', { timeout: 30_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-detached-descendant-');
  const run = startBroker(t);
  const fixture = launchFixture(run, root, { DETACHED_DESCENDANT: '1', TRANSITION_DESCENDANT: '1' });
  await send(run.child, fixture.request);
  const launched = await waitForMessage(run, 'launched');
  await send(run.child, { type: 'release', launch_id: fixture.launchId, command_digest: fixture.digest });
  const tree = await waitForFixtureIdentities(fixture.env.READINESS_LOG);
  assert.equal(tree.descendant.identity.pid, tree.descendant.identity.pgid);
  assert.notEqual(tree.descendant.identity.pgid, launched.broker_identity.pgid);
  await waitFor(() => fs.existsSync(fixture.env.SUCCESS_ARTIFACT), { timeoutMs: 10_000 });
  await send(run.child, { type: 'terminate', launch_id: fixture.launchId, cause: 'success', grace_ms: 150 });
  const acknowledgement = await waitForMessage(run, 'shutdown_ack');
  assert.ok(acknowledgement.descendant_identities.some(({ fingerprint }) => (
    fingerprint === tree.descendant.identity.fingerprint
  )));
  await send(run.child, {
    type: 'shutdown_release', launch_id: fixture.launchId, command_digest: fixture.digest,
  });
  await run.closed;
  await assertTreeAbsent(launched.broker_identity, launched.target_identity,
    tree.target.identity, tree.descendant.identity);
});

test('live ledger persists a detached descendant for recovery after broker SIGKILL', { timeout: 30_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-live-ledger-recovery-');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: 1, active: true })}\n`);
  const manager = new StateManager();
  const run = startBroker(t);
  const fixture = launchFixture(run, root, {
    DETACHED_DESCENDANT: '1', TRANSITION_DESCENDANT: '1', HOLD_TRANSITION: '1',
  });
  await send(run.child, fixture.request);
  const launched = await waitForMessage(run, 'launched');
  await send(run.child, { type: 'release', launch_id: fixture.launchId, command_digest: fixture.digest });
  await waitFor(() => fs.existsSync(fixture.env.TRANSITION_READY), {
    timeoutMs: 10_000,
    message: 'Detached transition shell did not reach its deterministic birth fence',
  });
  const birthUpdate = await waitFor(() => run.messages.find((message) => message?.type === 'descendants'
    && message.descendant_identities?.some(({ pid, pgid }) => pid === pgid)), {
    timeoutMs: 10_000,
    message: 'Broker did not publish the detached descendant birth identity while live',
  });
  fs.writeFileSync(fixture.env.TRANSITION_GATE, 'release\n');
  const tree = await waitForFixtureIdentities(fixture.env.READINESS_LOG);
  const update = await waitFor(() => run.messages.findLast((message) => message?.type === 'descendants'
    && message.descendant_identities?.some(({ fingerprint }) => fingerprint === tree.descendant.identity.fingerprint))
    || birthUpdate, { timeoutMs: 10_000 });
  const ledger = [launched.broker_identity, launched.target_identity, ...update.descendant_identities];
  const publishedDescendant = update.descendant_identities.find(({ fingerprint }) => (
    fingerprint === tree.descendant.identity.fingerprint
  ));
  assert.notEqual(publishedDescendant.command_sha256, tree.descendant.identity.command_sha256,
    'descendant birth identity must remain valid across its shell-to-node exec transition');
  manager.update(statePath, (state) => {
    state.active_child_identities = ledger;
    state.active_child_pid = launched.broker_identity.pid;
    state.active_child_identity = launched.broker_identity;
    return state;
  });

  process.kill(launched.broker_identity.pid, 'SIGKILL');
  await run.exited;
  assert.equal(inspectProcessLivenessIdentity(tree.descendant.identity), 'matched');
  recoverMonitoredProcessOwnership(manager, statePath);
  assert.deepEqual(manager.read(statePath).active_child_identities, []);
  await assertTreeAbsent(...ledger);
});

test('controller disconnect before launch exits 125 without starting a target', { timeout: 15_000 }, async (t) => {
  const run = startBroker(t);
  run.child.disconnect();
  const exited = await run.exited;
  // No target has inherited the broker's pipes in this path. Destroying the
  // local readable handles makes the assertion depend on process exit rather
  // than Node's separate and platform-sensitive stdio `close` bookkeeping.
  run.child.stdout.destroy();
  run.child.stderr.destroy();
  assert.deepEqual(exited, { code: 125, signal: null });
  assert.deepEqual(run.messages, []);
});

test('controller disconnect after launch reaps the stopped target before release', { timeout: 30_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-disconnect-');
  const run = startBroker(t);
  const fixture = launchFixture(run, root);
  await send(run.child, fixture.request);
  const launched = await waitForMessage(run, 'launched');
  run.child.disconnect();
  await run.exited;
  run.child.stdout.destroy();
  run.child.stderr.destroy();
  await assertTreeAbsent(launched.broker_identity, launched.target_identity);
  assert.equal(fs.existsSync(fixture.env.READINESS_LOG), false,
    'a target disconnected before release must never execute user code');
});

test('release fails closed when the stopped guardian identity disappears', { timeout: 15_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-release-reuse-');
  const run = startBroker(t);
  const fixture = launchFixture(run, root);
  await send(run.child, fixture.request);
  const launched = await waitForMessage(run, 'launched');
  process.kill(launched.target_identity.pid, 'SIGKILL');
  await assertTreeAbsent(launched.target_identity);
  await send(run.child, { type: 'release', launch_id: fixture.launchId, command_digest: fixture.digest });
  const acknowledgement = await waitForMessage(run, 'shutdown_ack');
  assert.match(acknowledgement.cause, /target-(?:exit|SIGKILL|release-identity-changed)/);
  await send(run.child, { type: 'shutdown_release', launch_id: fixture.launchId, command_digest: fixture.digest });
  await run.exited;
  assert.equal(fs.existsSync(fixture.env.READINESS_LOG), false,
    'a missing or reused guardian identity must never release user code');
});

test('a command-digest attestation failure launches no target', { timeout: 15_000 }, async (t) => {
  const root = makeTempRoot('pickle-broker-bad-digest-');
  const run = startBroker(t);
  const fixture = launchFixture(run, root);
  await send(run.child, { ...fixture.request, command_digest: '0'.repeat(64) });
  const closed = await run.closed;
  assert.deepEqual(closed, { code: 1, signal: null });
  assert.match(run.stderr(), /command digest mismatch/i);
  assert.equal(fs.existsSync(fixture.env.READINESS_LOG), false);
});
