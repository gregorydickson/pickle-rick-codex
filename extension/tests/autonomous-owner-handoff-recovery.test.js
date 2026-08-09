// @tier: fast
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  reconcileAutonomousOwnerHandoffTransaction,
  transferAutonomousOwnerRecoveryForAcceptedHandoff,
} from '../services/autonomous-owner-recovery.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  abortExpiredRuntimeHandoff,
  beginAutonomousExecution,
  createLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
} from '../services/durable-supervisor.js';
import {
  LiveSessionMigrationContentionError,
  prepareLiveSessionHandoffCheckpoint,
} from '../services/live-session-migration.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { writePrdSeal } from '../services/prd-seal.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot, writeJson } from './helpers.js';

function runtime(runtimeId, hashCharacter) {
  return {
    runtime_id: runtimeId,
    version: '1',
    build_hash: hashCharacter.repeat(64),
    min_state_schema: 1,
    max_state_schema: 1,
  };
}

function ownerSpec(sessionDir, runtimeId) {
  const unsigned = {
    schema_version: 1,
    session_dir: sessionDir,
    working_dir: sessionDir,
    tmux_session_name: `pickle-${runtimeId}`,
    original_tmux_session_id: `$${runtimeId}`,
    original_tmux_session_created: '1700000000',
    pane_start_command: `"node ${runtimeId}/recovered-supervisor-owner.js"`,
    runner_bin: 'mux-runner.js',
    runner_args: [],
  };
  return {
    ...unsigned,
    spec_id: crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  };
}

function acceptedHandoffFixture({ accepted = true } = {}) {
  const sessionDir = makeTempRoot('pickle-owner-handoff-reconcile-');
  const statePath = path.join(sessionDir, 'state.json');
  const sourceRuntime = runtime('blue', 'b');
  const targetRuntime = runtime('green', 'a');
  const nowMs = 1_700_000_000_000;
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Durable handoff reconciliation\n');
  writeJson(statePath, {
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    current_ticket: 'r1',
    history: [],
    schema_version: 1,
  });
  createLogicalPipeline(sessionDir, 'durable handoff reconciliation', { nowMs });
  writePrdSeal(sessionDir, {
    prd: '# Durable handoff reconciliation\n',
    repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'AC-1', text: 'Recover continuously after transient finalization contention.' }],
    scope_and_ownership: {},
    dependencies_and_external_prerequisites: [],
    risk: [],
    decision_precedence: [],
    preservation_and_rollback: {},
    completion_definition: {},
    release_gates: [],
  });
  beginAutonomousExecution(sessionDir, { nowMs: nowMs + 1 });
  const lease = acquireSupervisorLease(sessionDir, {
    ownerId: 'blue-owner',
    ttlMs: 120_000,
    nowMs: nowMs + 2,
  });
  const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
  const requestId = requestRuntimeHandoff(
    sessionDir,
    lease.owner_id,
    lease.token,
    sourceRuntime,
    targetRuntime,
    checkpoint,
    { nowMs: nowMs + 3 },
  );
  releaseRuntimeHandoffLease(sessionDir, lease.owner_id, lease.token, requestId, { nowMs: nowMs + 4 });
  if (accepted) {
    acceptRuntimeHandoff(sessionDir, requestId, 'green-owner', 120_000, targetRuntime, { nowMs: nowMs + 5 });
  } else {
    assert.equal(abortExpiredRuntimeHandoff(sessionDir, 60_000, { nowMs: nowMs + 60_005 }), true);
  }
  const targetIdentity = captureProcessLivenessIdentity(process.pid);
  assert.ok(targetIdentity);
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const sourceOwnerSpec = ownerSpec(resolvedSessionDir, 'blue');
  const targetOwnerSpec = ownerSpec(resolvedSessionDir, 'green');
  new StateManager().update(statePath, (current) => {
    current.autonomous_owner_spec = sourceOwnerSpec;
    current.tmux_runner_binding = {
      schema_version: 1,
      session_name: sourceOwnerSpec.tmux_session_name,
      session_id: sourceOwnerSpec.original_tmux_session_id,
      session_created: sourceOwnerSpec.original_tmux_session_created,
      pane_id: '%1',
      pane_pid: process.pid,
      pane_start_command: sourceOwnerSpec.pane_start_command,
    };
    current.autonomous_owner_recovery_suspended = true;
    current.autonomous_owner_recovery_suspended_for_handoff = requestId;
    current.autonomous_owner_handoff_transaction = {
      schema_version: 1,
      request_id: requestId,
      status: 'fenced',
      deadline_at: new Date(nowMs + 60_000).toISOString(),
      source_owner_spec: sourceOwnerSpec,
      source_supervisor_pid: process.pid,
      source_supervisor_identity: targetIdentity,
      target_owner_spec: targetOwnerSpec,
      target_supervisor_pid: process.pid,
      target_supervisor_identity: targetIdentity,
      target_runtime: targetRuntime,
      reconcile_attempt: 0,
      reconcile_epoch: 1,
      reconcile_strategy: 'immediate_snapshot_retry',
      reconcile_not_before: null,
      error: null,
    };
    return current;
  });
  return { sessionDir, statePath, requestId, targetOwnerSpec, targetRuntime, nowMs };
}

const transferPublicationCorruptionCases = [
  {
    name: 'same-id target owner field',
    mutate: (transaction) => { transaction.target_owner_spec.runner_args = ['--corrupt-after-fence']; },
    reason: /invalid target owner specification/,
  },
  {
    name: 'target identity',
    mutate: (transaction) => { transaction.target_supervisor_identity.fingerprint = '0'.repeat(64); },
    reason: /invalid target supervisor identity/,
  },
  {
    name: 'numeric epoch',
    mutate: (transaction) => { transaction.reconcile_epoch = null; },
    reason: /invalid reconcile epoch/,
  },
];

for (const fixtureCase of transferPublicationCorruptionCases) {
  test(`normal accepted-handoff transfer rejects ${fixtureCase.name} corruption before atomic publication`, () => {
    const fixture = acceptedHandoffFixture();
    const manager = new StateManager();
    const originalOwner = structuredClone(manager.read(fixture.statePath).autonomous_owner_spec);
    const transferred = transferAutonomousOwnerRecoveryForAcceptedHandoff(
      fixture.sessionDir,
      'mux-runner.js',
      [],
      fixture.sessionDir,
      manager,
      {
        beforePublish: (current) => fixtureCase.mutate(current.autonomous_owner_handoff_transaction),
      },
    );
    const rejected = manager.read(fixture.statePath);
    assert.equal(transferred, null);
    assert.deepEqual(rejected.autonomous_owner_spec, originalOwner);
    assert.equal(rejected.autonomous_owner_handoff_transaction.status, 'failed');
    assert.equal(rejected.recovery_required, true);
    assert.equal(rejected.recovery_kind, 'autonomous_owner_handoff_transaction_invalid');
    assert.match(rejected.recovery_reason, fixtureCase.reason);
    assert.equal(rejected.autonomous_owner_recovery_daemon_pid, undefined);
    assert.equal(rejected.history.some((entry) => (
      entry.step === 'autonomous_owner_recovery_transferred_for_runtime_handoff'
    )), false);
  });
}

const corruptTransactionCases = [
  {
    name: 'target owner spec hash',
    mutate: (transaction) => { transaction.target_owner_spec.spec_id = '0'.repeat(64); },
    reason: /invalid target owner specification/,
  },
  {
    name: 'source owner spec hash',
    mutate: (transaction) => { transaction.source_owner_spec.spec_id = '0'.repeat(64); },
    reason: /invalid source owner specification/,
  },
  {
    name: 'target supervisor identity',
    mutate: (transaction) => { transaction.target_supervisor_identity.fingerprint = 'not-a-fingerprint'; },
    reason: /invalid target supervisor identity/,
  },
  {
    name: 'reconcile attempt',
    mutate: (transaction) => { transaction.reconcile_attempt = null; },
    reason: /invalid reconcile attempt/,
  },
  {
    name: 'reconcile epoch',
    mutate: (transaction) => { transaction.reconcile_epoch = null; },
    reason: /invalid reconcile epoch/,
  },
  {
    name: 'reconcile not-before',
    mutate: (transaction) => { transaction.reconcile_not_before = 'not-a-timestamp'; },
    reason: /invalid reconcile not-before/,
  },
];

for (const fixtureCase of corruptTransactionCases) {
  test(`handoff reconciliation rejects corrupt ${fixtureCase.name} before finalization or owner installation`, () => {
    const fixture = acceptedHandoffFixture();
    const manager = new StateManager();
    const originalOwner = structuredClone(manager.read(fixture.statePath).autonomous_owner_spec);
    manager.update(fixture.statePath, (current) => {
      fixtureCase.mutate(current.autonomous_owner_handoff_transaction);
      return current;
    });
    let finalizerCalls = 0;
    assert.equal(reconcileAutonomousOwnerHandoffTransaction(
      fixture.sessionDir,
      new StateManager(),
      fixture.nowMs + 100,
      { finalizeMigration: () => { finalizerCalls += 1; return {}; } },
    ), 'noop');
    const rejected = manager.read(fixture.statePath);
    assert.equal(finalizerCalls, 0);
    assert.deepEqual(rejected.autonomous_owner_spec, originalOwner);
    assert.equal(rejected.autonomous_owner_handoff_transaction.status, 'failed');
    assert.equal(rejected.recovery_required, true);
    assert.equal(rejected.recovery_kind, 'autonomous_owner_handoff_transaction_invalid');
    assert.match(rejected.recovery_reason, fixtureCase.reason);
    assert.equal(rejected.autonomous_owner_recovery_suspended, false);
    assert.equal(rejected.autonomous_owner_recovery_suspended_for_handoff, null);
    assert.equal(rejected.history.some((entry) => (
      entry.step === 'autonomous_owner_handoff_reconciled_to_target'
        || entry.step === 'autonomous_owner_handoff_reconciled_to_source'
    )), false);
  });
}

test('handoff commit revalidates a target owner spec changed during finalization', () => {
  const fixture = acceptedHandoffFixture();
  const manager = new StateManager();
  const originalOwner = structuredClone(manager.read(fixture.statePath).autonomous_owner_spec);
  let finalizerCalls = 0;
  assert.equal(reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    manager,
    fixture.nowMs + 100,
    {
      finalizeMigration: () => {
        finalizerCalls += 1;
        manager.update(fixture.statePath, (current) => {
          current.autonomous_owner_handoff_transaction.target_owner_spec.spec_id = '0'.repeat(64);
          return current;
        });
        return {};
      },
    },
  ), 'noop');
  const rejected = manager.read(fixture.statePath);
  assert.equal(finalizerCalls, 1);
  assert.deepEqual(rejected.autonomous_owner_spec, originalOwner);
  assert.equal(rejected.autonomous_owner_handoff_transaction.status, 'failed');
  assert.equal(rejected.recovery_kind, 'autonomous_owner_handoff_transaction_invalid');
  assert.match(rejected.recovery_reason, /invalid target owner specification/);
});

test('handoff rollback rejects a corrupt source owner spec without installing or executing it', () => {
  const fixture = acceptedHandoffFixture({ accepted: false });
  const manager = new StateManager();
  const originalOwner = structuredClone(manager.read(fixture.statePath).autonomous_owner_spec);
  manager.update(fixture.statePath, (current) => {
    current.autonomous_owner_handoff_transaction.source_owner_spec.spec_id = '0'.repeat(64);
    return current;
  });
  let finalizerCalls = 0;
  assert.equal(reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 60_006,
    { finalizeMigration: () => { finalizerCalls += 1; return {}; } },
  ), 'noop');
  const rejected = manager.read(fixture.statePath);
  assert.equal(finalizerCalls, 0);
  assert.deepEqual(rejected.autonomous_owner_spec, originalOwner);
  assert.equal(rejected.autonomous_owner_handoff_transaction.status, 'failed');
  assert.equal(rejected.recovery_kind, 'autonomous_owner_handoff_transaction_invalid');
  assert.match(rejected.recovery_reason, /invalid source owner specification/);
  assert.equal(rejected.history.some((entry) => entry.step === 'autonomous_owner_handoff_reconciled_to_source'), false);
});

test('accepted handoff contention advances durable strategy epochs across restarts until finalization succeeds', () => {
  const fixture = acceptedHandoffFixture();
  let calls = 0;
  const finalizeMigration = () => {
    calls += 1;
    if (calls <= 10) throw new LiveSessionMigrationContentionError(`snapshot contention ${calls}`);
    return {};
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    reconcileAutonomousOwnerHandoffTransaction(
      fixture.sessionDir,
      new StateManager(),
      fixture.nowMs + 100 + attempt,
      { finalizeMigration },
    );
  }
  let recovered = new StateManager().read(fixture.statePath);
  assert.equal(recovered.autonomous_owner_handoff_transaction.status, 'fenced');
  assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_attempt, 0);
  assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_epoch, 2);
  assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_strategy, 'quiescence_backoff');
  assert.equal(recovered.recovery_required, undefined);
  const epochTwoStart = Date.parse(recovered.autonomous_owner_handoff_transaction.reconcile_not_before);
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    epochTwoStart - 1,
    { finalizeMigration },
  );
  assert.equal(calls, 5, 'restart before the durable epoch boundary must not consume an attempt');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    reconcileAutonomousOwnerHandoffTransaction(
      fixture.sessionDir,
      new StateManager(),
      epochTwoStart + attempt,
      { finalizeMigration },
    );
  }
  recovered = new StateManager().read(fixture.statePath);
  assert.equal(recovered.autonomous_owner_handoff_transaction.status, 'fenced');
  assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_epoch, 3);
  assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_strategy, 'extended_quiescence_backoff');
  assert.equal(recovered.recovery_required, undefined);
  const epochThreeStart = Date.parse(recovered.autonomous_owner_handoff_transaction.reconcile_not_before);

  assert.equal(reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    epochThreeStart,
    { finalizeMigration },
  ), 'completed');
  const completed = new StateManager().read(fixture.statePath);
  assert.equal(calls, 11);
  assert.equal(completed.autonomous_owner_handoff_transaction.status, 'completed');
  assert.deepEqual(completed.autonomous_owner_spec, fixture.targetOwnerSpec);
  assert.equal(completed.autonomous_owner_recovery_suspended, false);
  assert.equal(completed.autonomous_owner_recovery_suspended_for_handoff, null);
  assert.equal(completed.history.filter((entry) => (
    entry.step === 'autonomous_owner_handoff_reconciliation_epoch_advanced'
  )).length, 2);
});

for (const errorCode of ['EIO', 'EINTR', 'ESTALE']) {
  test(`accepted handoff ${errorCode} filesystem failures advance a recovery epoch instead of failing integrity`, () => {
    const fixture = acceptedHandoffFixture();
    const finalizeMigration = () => {
      const error = new Error(`operational filesystem failure ${errorCode}`);
      error.code = errorCode;
      throw error;
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reconcileAutonomousOwnerHandoffTransaction(
        fixture.sessionDir,
        new StateManager(),
        fixture.nowMs + 100 + attempt,
        { finalizeMigration },
      );
    }
    const recovered = new StateManager().read(fixture.statePath);
    assert.equal(recovered.autonomous_owner_handoff_transaction.status, 'fenced');
    assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_attempt, 0);
    assert.equal(recovered.autonomous_owner_handoff_transaction.reconcile_epoch, 2);
    assert.equal(recovered.autonomous_owner_handoff_transaction.error, `operational filesystem failure ${errorCode}`);
    assert.equal(recovered.recovery_required, undefined);
    assert.equal(recovered.autonomous_owner_recovery_suspended, true);
  });
}

test('cancellation racing transient handoff finalization remains terminal across restart', () => {
  const fixture = acceptedHandoffFixture();
  const manager = new StateManager();
  let calls = 0;
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    manager,
    fixture.nowMs + 100,
    {
      finalizeMigration: () => {
        calls += 1;
        manager.update(fixture.statePath, (current) => {
          current.cancel_requested_at = new Date(fixture.nowMs + 100).toISOString();
          current.last_exit_reason = 'cancelled';
          return current;
        });
        throw new LiveSessionMigrationContentionError('cancel raced finalization');
      },
    },
  );
  const cancelled = manager.read(fixture.statePath);
  assert.equal(cancelled.last_exit_reason, 'cancelled');
  assert.equal(cancelled.autonomous_owner_handoff_transaction.status, 'fenced');
  assert.equal(cancelled.autonomous_owner_handoff_transaction.reconcile_attempt, 0);
  assert.equal(cancelled.recovery_required, undefined);
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 1_000,
    { finalizeMigration: () => { calls += 1; return {}; } },
  );
  assert.equal(calls, 1, 'a replacement reconciler must not run after cancellation');
});

test('restart resumes a legacy five-attempt terminal handoff in a new durable epoch', () => {
  const fixture = acceptedHandoffFixture();
  new StateManager().update(fixture.statePath, (current) => {
    current.autonomous_owner_handoff_transaction = {
      ...current.autonomous_owner_handoff_transaction,
      status: 'failed',
      reconcile_attempt: 5,
      error: 'snapshot contention before upgrade',
    };
    current.autonomous_owner_recovery_suspended = false;
    current.autonomous_owner_recovery_suspended_for_handoff = null;
    current.recovery_required = true;
    current.recovery_reason = 'accepted runtime handoff migration could not be finalized after bounded retries';
    return current;
  });

  assert.equal(reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 100,
    { finalizeMigration: () => ({}) },
  ), 'completed');
  const resumed = new StateManager().read(fixture.statePath);
  assert.equal(resumed.autonomous_owner_handoff_transaction.status, 'completed');
  assert.equal(resumed.autonomous_owner_handoff_transaction.reconcile_epoch, 2);
  assert.equal(resumed.recovery_required, false);
  assert.equal(resumed.recovery_reason, null);
  assert.ok(resumed.history.some((entry) => entry.step === 'autonomous_owner_handoff_legacy_exhaustion_resumed'));
});

test('accepted handoff integrity failures still fail closed without entering another epoch', () => {
  const fixture = acceptedHandoffFixture();
  let calls = 0;
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 100,
    { finalizeMigration: () => { calls += 1; throw new Error('migration manifest hash mismatch'); } },
  );
  const failed = new StateManager().read(fixture.statePath);
  assert.equal(failed.autonomous_owner_handoff_transaction.status, 'failed');
  assert.equal(failed.autonomous_owner_handoff_transaction.reconcile_epoch, 1);
  assert.equal(failed.autonomous_owner_recovery_suspended, false);
  assert.equal(failed.autonomous_owner_recovery_suspended_for_handoff, null);
  assert.equal(failed.recovery_required, true);
  assert.match(failed.recovery_reason, /failed integrity validation/);
  assert.ok(failed.history.some((entry) => entry.step === 'autonomous_owner_handoff_reconciliation_failed_closed'));
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 1_000,
    { finalizeMigration: () => { calls += 1; return {}; } },
  );
  assert.equal(calls, 1, 'a replacement reconciler must not bypass fail-closed recovery state');
});

test('unknown coded finalization errors are not blanket-retried as infrastructure failures', () => {
  const fixture = acceptedHandoffFixture();
  const error = new Error('unexpected migration invariant failure');
  error.code = 'ERR_ASSERTION';
  reconcileAutonomousOwnerHandoffTransaction(
    fixture.sessionDir,
    new StateManager(),
    fixture.nowMs + 100,
    { finalizeMigration: () => { throw error; } },
  );
  const failed = new StateManager().read(fixture.statePath);
  assert.equal(failed.autonomous_owner_handoff_transaction.status, 'failed');
  assert.equal(failed.autonomous_owner_handoff_transaction.reconcile_epoch, 1);
  assert.equal(failed.recovery_required, true);
  assert.match(failed.recovery_reason, /failed integrity validation/);
});
