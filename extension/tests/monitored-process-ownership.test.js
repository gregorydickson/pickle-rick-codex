// @tier: fast
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  clearActiveChildIfNoMonitoredOwnership,
  monitoredProcessStateCallbacks,
  recoverMonitoredProcessOwnership,
  recoverRefinementProcessOwnership,
} from '../services/monitored-process-ownership.js';
import { StateManager } from '../services/state-manager.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { safeDeactivate } from '../services/state-terminal.js';
import { makeTempRoot } from './helpers.js';

function identity(pid, pgid = pid) {
  const startTime = `start-${pid}`;
  return {
    pid,
    pgid,
    start_time: startTime,
    fingerprint: crypto.createHash('sha256').update(`${pid}\0${pgid}\0${startTime}`).digest('hex'),
  };
}

function descendantIdentity(pid, pgid, sessionId = pgid) {
  const startTime = `start-${pid}`;
  const commandSha256 = '0'.repeat(64);
  return {
    pid,
    pgid,
    start_time: startTime,
    fingerprint: crypto.createHash('sha256')
      .update(`v2-descendant\0${pid}\0${pgid}\0${sessionId}\0${startTime}`).digest('hex'),
    identity_version: 2,
    session_id: sessionId,
    command_sha256: commandSha256,
    identity_kind: 'descendant',
    strict_command: false,
  };
}

function fixture() {
  const root = makeTempRoot('pickle-monitored-ownership-');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: 1, active: true })}\n`);
  return { manager: new StateManager(), statePath };
}

class PublishingStateManager extends StateManager {
  publication = null;

  publicationInjected = false;

  update(statePath, updater) {
    if (this.publication && !this.publicationInjected) {
      this.publicationInjected = true;
      new StateManager().update(statePath, this.publication);
    }
    return super.update(statePath, updater);
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test('monitored ownership publishes broker then target before allowing descendants', () => {
  const { manager, statePath } = fixture();
  const callbacks = monitoredProcessStateCallbacks(manager, statePath, 'codex', 'worker');
  const broker = identity(98101);
  const target = identity(98102, broker.pgid);
  const descendant = identity(98103, broker.pgid);

  assert.throws(
    () => callbacks.onTargetSpawn(broker, target),
    /without its exact durable broker/,
  );
  callbacks.onSpawn({ pid: broker.pid }, broker);
  assert.deepEqual(manager.read(statePath).active_child_identities, [broker]);
  assert.deepEqual(manager.read(statePath).active_child_identity, broker);
  assert.equal(manager.read(statePath).active_child_controller_identity.pid, process.pid);

  callbacks.onTargetSpawn(broker, target);
  assert.deepEqual(manager.read(statePath).active_child_identities, [broker, target]);
  callbacks.onDescendants(broker, target, [descendant]);
  assert.deepEqual(manager.read(statePath).active_child_identities, [broker, target, descendant]);
  assert.throws(
    () => callbacks.onDescendants(broker, target, []),
    /must be monotonic/,
  );
});

test('a reused controller pid does not fence exact monitored recovery', async () => {
  const { manager, statePath } = fixture();
  const controller = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const liveController = await waitFor(() => captureProcessLivenessIdentity(controller.pid), 'controller did not start');
    const broker = identity(98111);
    manager.update(statePath, (state) => {
      state.active_child_identities = [broker];
      state.active_child_pid = broker.pid;
      state.active_child_identity = broker;
      state.active_child_controller_pid = controller.pid;
      state.active_child_controller_identity = { ...liveController, fingerprint: '0'.repeat(64) };
      return state;
    });
    recoverMonitoredProcessOwnership(manager, statePath);
    assert.deepEqual(manager.read(statePath).active_child_identities, []);
    assert.ok(captureProcessLivenessIdentity(controller.pid), 'unrelated reused controller pid remains untouched');
  } finally {
    controller.kill('SIGKILL');
  }
});

test('terminal finalization preserves an undrained monitored ledger as recovery-required', () => {
  const broker = identity(98121);
  const retained = safeDeactivate({
    active: true,
    active_child_pid: broker.pid,
    active_child_identity: broker,
    active_child_identities: [broker],
  });
  assert.equal(retained.active, false);
  assert.equal(retained.active_child_pid, broker.pid);
  assert.deepEqual(retained.active_child_identities, [broker]);
  assert.equal(retained.recovery_required, true);
  assert.equal(retained.orphan_child_pid, broker.pid);
});

test('refinement ownership recovery and terminalization honor the full identity ledger', () => {
  const { manager, statePath } = fixture();
  const broker = identity(98131);
  manager.update(statePath, (state) => {
    state.refinement_child_identities = [broker];
    state.active_child_pid = broker.pid;
    state.active_child_identity = broker;
    return state;
  });
  const retained = safeDeactivate(manager.read(statePath));
  assert.deepEqual(retained.refinement_child_identities, [broker]);
  assert.equal(retained.recovery_required, true);
  recoverRefinementProcessOwnership(manager, statePath);
  assert.deepEqual(manager.read(statePath).refinement_child_identities, []);
  assert.equal(manager.read(statePath).active_child_pid, null);
});

test('generic cleanup cannot erase an undrained monitored ownership ledger', () => {
  const { manager, statePath } = fixture();
  const callbacks = monitoredProcessStateCallbacks(manager, statePath, 'codex', 'worker');
  const broker = identity(98201);
  const target = identity(98202, broker.pgid);
  callbacks.onSpawn({ pid: broker.pid }, broker);
  callbacks.onTargetSpawn(broker, target);

  clearActiveChildIfNoMonitoredOwnership(manager, statePath, { worker_pid: null });
  const retained = manager.read(statePath);
  assert.deepEqual(retained.active_child_identities, [broker, target]);
  assert.deepEqual(retained.active_child_identity, broker);
  assert.equal(retained.active_child_pid, broker.pid);
});

test('attested drain clears only the exact complete immutable ledger', () => {
  const { manager, statePath } = fixture();
  const callbacks = monitoredProcessStateCallbacks(manager, statePath, 'codex', 'worker');
  const broker = identity(98301);
  const target = identity(98302, broker.pgid);
  const descendant = identity(98303, broker.pgid);
  callbacks.onSpawn({ pid: broker.pid }, broker);
  callbacks.onTargetSpawn(broker, target);
  callbacks.onDescendants(broker, target, [descendant]);

  assert.throws(
    () => callbacks.onDrain(broker, target, []),
    /ownership changed before drain persistence/,
  );
  assert.equal(manager.read(statePath).active_child_identities.length, 3);
  callbacks.onDrain(broker, target, [descendant]);
  const drained = manager.read(statePath);
  assert.deepEqual(drained.active_child_identities, []);
  assert.equal(drained.active_child_identity, null);
  assert.equal(drained.active_child_pid, null);
});

test('attested prelaunch drain clears the exact broker-only ownership ledger', () => {
  const { manager, statePath } = fixture();
  const callbacks = monitoredProcessStateCallbacks(manager, statePath, 'codex', 'worker');
  const broker = identity(98311);
  callbacks.onSpawn({ pid: broker.pid }, broker);

  callbacks.onDrain(broker, null, []);
  const drained = manager.read(statePath);
  assert.deepEqual(drained.active_child_identities, []);
  assert.equal(drained.active_child_identity, null);
  assert.equal(drained.active_child_pid, null);
});

test('restart recovery clears a stranded ledger only after exact groups are absent', () => {
  const { manager, statePath } = fixture();
  const broker = identity(98401);
  const target = identity(98402, broker.pgid);
  manager.update(statePath, (state) => {
    state.active_child_identities = [broker, target];
    state.active_child_pid = broker.pid;
    state.active_child_identity = broker;
    return state;
  });

  recoverMonitoredProcessOwnership(manager, statePath);
  assert.deepEqual(manager.read(statePath).active_child_identities, []);
  assert.equal(manager.read(statePath).active_child_identity, null);
});

test('restart recovery converges when target publication monotonically extends the broker ledger during drain', () => {
  const root = makeTempRoot('pickle-monitored-publication-race-');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: 1, active: false })}\n`);
  const manager = new PublishingStateManager();
  const broker = identity(98411);
  const target = identity(98412, broker.pgid);
  manager.update(statePath, (state) => {
    state.active_child_identities = [broker];
    state.active_child_pid = broker.pid;
    state.active_child_identity = broker;
    return state;
  });
  manager.publication = (state) => {
    state.active_child_identities = [broker, target];
    return state;
  };

  recoverMonitoredProcessOwnership(manager, statePath, { allowLiveController: true });

  assert.equal(manager.publicationInjected, true);
  assert.deepEqual(manager.read(statePath).active_child_identities, []);
  assert.equal(manager.read(statePath).active_child_identity, null);
});

test('restart recovery converges only for a completely attested added descendant group', () => {
  const root = makeTempRoot('pickle-monitored-descendant-publication-');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: 1, active: false })}\n`);
  const manager = new PublishingStateManager();
  const broker = identity(98415);
  const target = identity(98416, broker.pgid);
  const descendantLeader = descendantIdentity(98417, 98417);
  const descendantMember = descendantIdentity(98418, descendantLeader.pgid);
  manager.update(statePath, (state) => {
    state.active_child_identities = [broker, target];
    state.active_child_pid = broker.pid;
    state.active_child_identity = broker;
    return state;
  });
  manager.publication = (state) => {
    state.active_child_identities = [broker, target, descendantLeader, descendantMember];
    return state;
  };

  recoverMonitoredProcessOwnership(manager, statePath, { allowLiveController: true });

  assert.deepEqual(manager.read(statePath).active_child_identities, []);
});

test('restart recovery rejects removal, reorder, replacement, and unattested group drift during drain', () => {
  const broker = identity(98421);
  const target = identity(98422, broker.pgid);
  const replacement = identity(98423);
  const unattestedGroup = identity(98424);
  const corruptions = [
    { name: 'removal', ledger: [broker], pattern: /ownership changed during recovery/ },
    { name: 'reorder', ledger: [target, broker], pattern: /ownership changed during recovery/ },
    { name: 'replacement', ledger: [replacement, target], pattern: /ownership changed during recovery/ },
    { name: 'group drift', ledger: [broker, target, unattestedGroup], pattern: /unattested descendant process group/ },
  ];

  for (const corruption of corruptions) {
    const root = makeTempRoot(`pickle-monitored-${corruption.name.replace(' ', '-')}-`);
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, `${JSON.stringify({ schema_version: 1, active: false })}\n`);
    const manager = new PublishingStateManager();
    manager.update(statePath, (state) => {
      state.active_child_identities = [broker, target];
      state.active_child_pid = broker.pid;
      state.active_child_identity = broker;
      return state;
    });
    manager.publication = (state) => {
      state.active_child_identities = corruption.ledger;
      return state;
    };

    assert.throws(
      () => recoverMonitoredProcessOwnership(manager, statePath, { allowLiveController: true }),
      corruption.pattern,
      corruption.name,
    );
    assert.deepEqual(manager.read(statePath).active_child_identities, corruption.ledger);
  }
});

test('restart recovery reaps a stubborn target after its broker is SIGKILLed', async () => {
  const { manager, statePath } = fixture();
  const targetPidPath = path.join(path.dirname(statePath), 'target.pid');
  const broker = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const target = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.env.TARGET_PID_PATH, String(target.pid));",
    'setInterval(() => {}, 1000);',
  ].join('')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TARGET_PID_PATH: targetPidPath },
  });
  let brokerIdentity = null;
  let targetIdentity = null;
  try {
    await waitFor(() => fs.existsSync(targetPidPath), 'broker did not publish target pid');
    const targetPid = Number(fs.readFileSync(targetPidPath, 'utf8'));
    brokerIdentity = captureProcessLivenessIdentity(broker.pid);
    targetIdentity = captureProcessLivenessIdentity(targetPid);
    assert.ok(brokerIdentity && targetIdentity);
    assert.equal(targetIdentity.pgid, brokerIdentity.pgid);
    manager.update(statePath, (state) => {
      state.active_child_identities = [brokerIdentity, targetIdentity];
      state.active_child_pid = brokerIdentity.pid;
      state.active_child_identity = brokerIdentity;
      return state;
    });

    process.kill(brokerIdentity.pid, 'SIGKILL');
    await new Promise((resolve) => broker.once('exit', resolve));
    assert.equal(captureProcessLivenessIdentity(targetIdentity.pid)?.fingerprint, targetIdentity.fingerprint);
    recoverMonitoredProcessOwnership(manager, statePath);
    assert.deepEqual(manager.read(statePath).active_child_identities, []);
    assert.equal(captureProcessLivenessIdentity(targetIdentity.pid), null);
  } finally {
    for (const identity of [targetIdentity, brokerIdentity]) {
      if (!identity) continue;
      try { process.kill(-identity.pgid, 'SIGKILL'); } catch { /* already absent */ }
    }
  }
});
