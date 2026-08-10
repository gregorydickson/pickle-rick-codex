// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cancellationRecoveryIntent,
  createCancellationRecoveryIntent,
  hasPendingCancellationRecovery,
  mergeCancellationRecoveryIntent,
  reconcileCancellationRecovery,
} from '../services/cancellation-recovery.js';
import { runAutonomousOwnerRecoveryDaemon } from '../services/autonomous-owner-recovery.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';
import { createLogicalPipeline, readLogicalPipeline } from '../services/durable-supervisor.js';
import { makeTempRoot, waitFor } from './helpers.js';

function cancelledFixture(intent) {
  const sessionDir = makeTempRoot('pickle-cancel-recovery-');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    active: false,
    history: [],
    cancel_requested_at: new Date().toISOString(),
    last_exit_reason: 'cancel_recovery_required',
    recovery_required: true,
    recovery_kind: 'cancellation_ownership',
    cancellation_recovery: intent,
  }));
  return sessionDir;
}

test('autonomous recovery daemon completes cancellation despite terminal cancel markers', async () => {
  const sessionDir = cancelledFixture(createCancellationRecoveryIntent([]));
  createLogicalPipeline(sessionDir, 'cancel-recovery-pipeline');
  await runAutonomousOwnerRecoveryDaemon(sessionDir, { intervalMs: 5 });
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.equal(state.cancellation_recovery.status, 'completed');
  assert.equal(state.recovery_required, false);
  assert.equal(state.recovery_kind, null);
  assert.equal(state.autonomous_owner_recovery_daemon_pid, null);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'cancelled');
});

test('corrupt cancellation recovery intent remains fail-closed and pending', () => {
  const sessionDir = cancelledFixture({ schema_version: 1, status: 'pending', identities: 'corrupt' });
  const manager = new StateManager();
  assert.equal(hasPendingCancellationRecovery(manager.read(path.join(sessionDir, 'state.json'))), true);
  assert.equal(reconcileCancellationRecovery(sessionDir, manager), 'pending');
  const state = manager.read(path.join(sessionDir, 'state.json'));
  assert.equal(state.recovery_required, true);
  assert.match(state.recovery_reason, /corrupt or missing/);
});

test('cancellation recovery strictly validates retry metadata', () => {
  const valid = createCancellationRecoveryIntent([]);
  for (const mutation of [
    { attempt: -1 },
    { attempt: 1.5 },
    { epoch: 0 },
    { epoch: 1.5 },
    { not_before: 'not-a-date' },
    { last_error: 42 },
    { intent_id: '' },
  ]) {
    assert.equal(cancellationRecoveryIntent({ ...valid, ...mutation }), null, JSON.stringify(mutation));
  }
});

test('repeated cancellation preserves the durable identity union and revokes quiescence', () => {
  const startA = 'start-a';
  const startB = 'start-b';
  const identity = (pid, start) => ({
    pid, pgid: pid, start_time: start,
    fingerprint: crypto.createHash('sha256').update(`${pid}\0${pid}\0${start}`).digest('hex'),
  });
  const first = { ...createCancellationRecoveryIntent([identity(990001, startA)]), status: 'ownership_quiescent' };
  const merged = mergeCancellationRecoveryIntent(first, [identity(990002, startB)]);
  assert.equal(merged.intent_id, first.intent_id);
  assert.equal(merged.status, 'pending');
  assert.deepEqual(merged.identities, [identity(990001, startA), identity(990002, startB)]);
});

test('quiescent intent atomically merges a newly published identity and returns to pending', () => {
  const intent = { ...createCancellationRecoveryIntent([]), status: 'ownership_quiescent', attempt: 4, epoch: 3 };
  const sessionDir = cancelledFixture(intent);
  const manager = new StateManager();
  const controllerIdentity = captureProcessLivenessIdentity(process.pid);
  assert.ok(controllerIdentity);
  const lateStart = 'published-after-quiescence';
  const late = {
    pid: 999992,
    pgid: 999992,
    start_time: lateStart,
    fingerprint: crypto.createHash('sha256').update(`999992\0${999992}\0${lateStart}`).digest('hex'),
  };
  manager.update(path.join(sessionDir, 'state.json'), (state) => {
    state.active_child_identities = [late];
    state.active_child_controller_pid = process.pid;
    state.active_child_controller_identity = controllerIdentity;
    return state;
  });

  assert.equal(reconcileCancellationRecovery(sessionDir, manager), 'pending');
  const state = manager.read(path.join(sessionDir, 'state.json'));
  assert.equal(state.cancellation_recovery.status, 'pending');
  assert.deepEqual(state.cancellation_recovery.identities, [late]);
  assert.equal(state.cancellation_recovery.attempt, 1);
  assert.equal(state.cancellation_recovery.epoch, 3);
  assert.match(state.cancellation_recovery.last_error, /live controller/);
  assert.equal(state.recovery_required, true);
});

test('late ownership publication revokes quiescence and is merged before final clear', () => {
  const sessionDir = cancelledFixture(createCancellationRecoveryIntent([]));
  createLogicalPipeline(sessionDir, 'late-publication-pipeline');
  const manager = new StateManager();
  const lateStart = 'late-publication-start';
  const late = {
    pid: 999991,
    pgid: 999991,
    start_time: lateStart,
    fingerprint: crypto.createHash('sha256').update(`999991\0${999991}\0${lateStart}`).digest('hex'),
  };
  const first = reconcileCancellationRecovery(sessionDir, manager, Date.now(), {
    beforeFinalClear: () => manager.update(path.join(sessionDir, 'state.json'), (state) => {
      state.active_child_identities = [late];
      return state;
    }),
  });
  assert.equal(first, 'pending');
  const pending = manager.read(path.join(sessionDir, 'state.json'));
  assert.equal(pending.cancellation_recovery.status, 'pending');
  assert.deepEqual(pending.cancellation_recovery.identities, [late]);
  assert.equal(pending.recovery_required, true);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'cancelled');
  manager.update(path.join(sessionDir, 'state.json'), (state) => {
    state.active_child_identities = [];
    return state;
  });
  assert.equal(reconcileCancellationRecovery(sessionDir, manager, Date.now() + 60_000), 'completed');
});

test('corrupt late ownership publication revokes finalization without clearing evidence', () => {
  const sessionDir = cancelledFixture(createCancellationRecoveryIntent([]));
  const manager = new StateManager();
  assert.equal(reconcileCancellationRecovery(sessionDir, manager, Date.now(), {
    beforeFinalClear: () => manager.update(path.join(sessionDir, 'state.json'), (state) => {
      state.active_child_identities = [{ pid: 42 }];
      return state;
    }),
  }), 'pending');
  const state = manager.read(path.join(sessionDir, 'state.json'));
  assert.equal(state.recovery_required, true);
  assert.equal(state.cancellation_recovery.status, 'pending');
  assert.match(state.recovery_reason, /ledger is corrupt/);
  assert.deepEqual(state.active_child_identities, [{ pid: 42 }]);
});

test('cancellation recovery never signals a live PGID after its only exact authority exits', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group authority is POSIX-only');
  const marker = path.join(makeTempRoot('pickle-cancel-group-'), 'child.pid');
  const leader = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process');",
    "const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    'fs.writeFileSync(process.env.CHILD_MARKER,String(child.pid));',
    'setInterval(()=>{},1000);',
  ].join('')], { detached: true, stdio: 'ignore', env: { ...process.env, CHILD_MARKER: marker } });
  let childPid = 0;
  t.after(() => {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already absent */ }
  });
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 5_000, message: 'group child did not start' });
  childPid = Number(fs.readFileSync(marker, 'utf8'));
  const leaderIdentity = captureProcessLivenessIdentity(leader.pid);
  assert.ok(leaderIdentity && leaderIdentity.pid === leaderIdentity.pgid);
  process.kill(leader.pid, 'SIGKILL');
  await new Promise((resolve) => leader.once('exit', resolve));
  const sessionDir = cancelledFixture(createCancellationRecoveryIntent([leaderIdentity]));

  assert.equal(reconcileCancellationRecovery(sessionDir), 'pending');
  assert.doesNotThrow(() => process.kill(childPid, 0), 'unattested survivor was signalled');
  const pending = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.match(pending.recovery_reason, /without an exact signal authority/);

  process.kill(childPid, 'SIGKILL');
  await waitFor(() => {
    try { process.kill(childPid, 0); return false; } catch { return true; }
  }, { timeoutMs: 5_000, message: 'group child did not exit' });
  assert.equal(reconcileCancellationRecovery(sessionDir, new StateManager(), Date.now() + 60_000), 'completed');
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).recovery_required, false);
});
