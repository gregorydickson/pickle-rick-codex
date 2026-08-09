// @tier: fast
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { reconcileSessionLiveness } from '../services/session.js';
import {
  captureProcessLivenessIdentity,
  captureSpawnedProcessIdentity,
  inspectProcessLivenessIdentity,
  reapRecordedLiveProcessGroup,
} from '../services/orphan-reaper.js';
import { consumeAutonomousBudgetRollover } from '../services/autonomous-budget.js';
import {
  registerAutonomousOwnerSpec,
  restoreAutonomousBudgetOwner,
  runAutonomousOwnerRecoveryDaemon,
  fenceAutonomousOwnerRecoveryForHandoff,
  reconcileAutonomousOwnerHandoffTransaction,
} from '../services/autonomous-owner-recovery.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  beginAutonomousExecution,
  createLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
} from '../services/durable-supervisor.js';
import { prepareLiveSessionHandoffCheckpoint } from '../services/live-session-migration.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  captureOwnedTmuxRunnerBinding,
  killTmuxSessionById,
  readTmuxRunnerBinding,
  runTmux,
  shellQuote,
  tmuxSessionExists,
} from '../services/tmux.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot, writeJson } from './helpers.js';

function state(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/project',
    step: 'implement',
    iteration: 1,
    max_iterations: 25,
    max_time_minutes: 480,
    worker_timeout_seconds: 900,
    start_time_epoch: 1_700_000_000,
    run_start_time_epoch: 1_700_000_000,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2023-11-14T22:13:20.000Z',
    session_dir: '/tmp/session',
    schema_version: 1,
    ...overrides,
  };
}

async function waitForLineCount(filePath, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).length >= expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${expected} lines in ${filePath}`);
}

async function waitForState(statePath, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new StateManager().read(statePath);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for state predicate at ${statePath}`);
}

function runLivenessProcess(sessionDir, nowMs) {
  const source = `
    import('./services/session.js').then(({ reconcileSessionLiveness }) => {
      const result = reconcileSessionLiveness(process.argv[1], undefined, Number(process.argv[2]));
      process.stdout.write(String(result.state.autonomous_budget_rollover_intent_id || ''));
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, sessionDir, String(nowMs)], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `liveness child exited ${code}`)));
  });
}

function runRestoreProcess(sessionDir, nowMs) {
  const source = `
    import('./services/autonomous-owner-recovery.js').then(({ restoreAutonomousBudgetOwner }) => {
      process.stdout.write(restoreAutonomousBudgetOwner(process.argv[1], undefined, Number(process.argv[2])));
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, sessionDir, String(nowMs)], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `restore child exited ${code}`)));
  });
}

function registerProcessOwner(sessionDir, runnerArgs = []) {
  return registerAutonomousOwnerSpec(
    sessionDir,
    'mux-runner.js',
    runnerArgs,
    undefined,
    path.resolve(new URL('../bin/supervised-runner.js', import.meta.url).pathname),
  );
}

class InjectBeforeFirstUpdateStateManager extends StateManager {
  constructor(inject) {
    super();
    this.inject = inject;
    this.armed = true;
  }

  update(statePath, mutator, options) {
    if (this.armed) {
      this.armed = false;
      super.update(statePath, this.inject);
    }
    return super.update(statePath, mutator, options);
  }
}

test('reconcileSessionLiveness demotes a tmux session whose runner is gone', () => {
  const sessionDir = makeTempRoot('pickle-liveness-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, state({ session_dir: sessionDir, tmux_mode: true, tmux_runner_pid: 999_999_999 }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, true);
  assert.equal(result.state.active, false);
  assert.equal(result.state.last_exit_reason, 'runner_lost');
  assert.equal(result.state.step, 'paused');
});

test('reconcileSessionLiveness preserves an active session during a bounded autonomous budget relaunch', () => {
  const sessionDir = makeTempRoot('pickle-liveness-budget-rollover-');
  const nowMs = 1_700_000_100_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    last_exit_reason: 'autonomous_budget_rollover',
    autonomous_budget_rollover_intent_id: 'rollover-intent',
    autonomous_relaunch_not_before: new Date(nowMs + 250).toISOString(),
    autonomous_relaunch_deadline: new Date(nowMs + 60_250).toISOString(),
    recovery_required: false,
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.step, 'implement');
  assert.equal(result.state.recovery_required, false);
});

test('reconcileSessionLiveness reschedules an expired exact rollover intent instead of making it stale', () => {
  const sessionDir = makeTempRoot('pickle-liveness-budget-expired-');
  const nowMs = 1_700_000_100_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    active: false,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    last_exit_reason: 'runner_lost',
    autonomous_budget_epoch: 2,
    autonomous_budget_rollover_intent_id: 'rollover-intent',
    autonomous_relaunch_not_before: new Date(nowMs - 60_000).toISOString(),
    autonomous_relaunch_deadline: new Date(nowMs - 1).toISOString(),
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.last_exit_reason, 'autonomous_budget_rollover');
  assert.equal(result.state.autonomous_budget_rollover_intent_id, 'rollover-intent');
  assert.ok(Date.parse(result.state.autonomous_relaunch_not_before) > nowMs);
  assert.ok(Date.parse(result.state.autonomous_relaunch_deadline) > Date.parse(result.state.autonomous_relaunch_not_before));
});

test('expired rollover restores the exact supervisor owner after repeated whole-tmux loss', async (t) => {
  try {
    runTmux(['-V']);
  } catch {
    t.skip('tmux is unavailable');
    return;
  }
  const sessionDir = makeTempRoot('pickle-liveness-owner-restore-');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'owner-runs.log');
  const fixturePath = path.join(sessionDir, 'supervised-runner.js');
  fs.writeFileSync(fixturePath, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(markerPath)}, 'run\\n');`,
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  const sessionName = `pickle-${path.basename(sessionDir)}`;
  const runnerCommand = `node ${shellQuote(fixturePath)} ${shellQuote(sessionDir)} --runner-bin=mux-runner.js`;
  let binding;
  let daemon = null;
  try {
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, runnerCommand]);
    binding = captureOwnedTmuxRunnerBinding(sessionName, sessionDir);
    writeJson(statePath, state({
      session_dir: sessionDir,
      working_dir: sessionDir,
      tmux_mode: true,
      tmux_session_name: sessionName,
      tmux_runner_pid: binding.pane_pid,
      tmux_runner_binding: binding,
      last_exit_reason: 'autonomous_budget_rollover',
      autonomous_budget_epoch: 1,
      autonomous_budget_rollover_intent_id: 'same-rollover-uuid',
      autonomous_relaunch_not_before: new Date(1_700_000_099_000).toISOString(),
      autonomous_relaunch_deadline: new Date(1_700_000_099_999).toISOString(),
      recovery_required: false,
    }));
    registerAutonomousOwnerSpec(sessionDir, 'mux-runner.js', []);
    new StateManager().update(statePath, (current) => {
      current.autonomous_supervisor_pid = binding.pane_pid;
      current.autonomous_supervisor_identity = null;
      return current;
    });
    await waitForLineCount(markerPath, 1);
    daemon = runAutonomousOwnerRecoveryDaemon(sessionDir, { intervalMs: 10 });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle === 0) killTmuxSessionById(binding.session_id);
      else process.kill(binding.pane_pid, 'SIGKILL');
      const nowMs = 1_700_000_100_000 + cycle * 120_000;
      const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
      assert.equal(reconciled.stale, false);
      assert.equal(reconciled.state.autonomous_budget_rollover_intent_id, 'same-rollover-uuid');
      assert.ok(['pending', 'restored'].includes(reconciled.state.autonomous_owner_restoration.status));
      const restored = await waitForState(statePath, (current) => current.autonomous_owner_restoration?.status === 'restored');
      assert.equal(restored.autonomous_budget_rollover_intent_id, 'same-rollover-uuid');
      assert.equal(restored.autonomous_owner_restoration.status, 'restored');
      binding = restored.tmux_runner_binding;
      new StateManager().update(statePath, (current) => {
        current.autonomous_supervisor_pid = binding.pane_pid;
        current.autonomous_supervisor_identity = null;
        return current;
      });
      if (cycle === 0) assert.notEqual(binding.session_id, reconciled.state.tmux_runner_binding.session_id);
      else assert.equal(binding.session_id, reconciled.state.tmux_runner_binding.session_id);
      await waitForLineCount(markerPath, cycle + 2);
    }
    assert.equal(fs.readFileSync(markerPath, 'utf8').trim().split('\n').length, 3);

    const targetRuntimeBin = path.join(sessionDir, 'target-runtime-bin');
    const targetMarkerPath = path.join(sessionDir, 'target-owner-runs.log');
    fs.mkdirSync(targetRuntimeBin);
    fs.writeFileSync(path.join(targetRuntimeBin, 'recovered-supervisor-owner.js'), [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(targetMarkerPath)}, 'target\\n');`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    const sourceRuntime = {
      runtime_id: 'blue', version: '1', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const targetRuntime = {
      runtime_id: 'green', version: '1', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Owner handoff recovery\n');
    createLogicalPipeline(sessionDir, 'owner-handoff-recovery');
    writePrdSeal(sessionDir, {
      prd: '# Owner handoff recovery\n',
      repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
      acceptance_criteria: [{ id: 'AC-1', text: 'Recover the exact accepted owner.' }],
      scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
      preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
    });
    beginAutonomousExecution(sessionDir);
    const sourceLease = acquireSupervisorLease(sessionDir, { ownerId: 'blue-owner', ttlMs: 10_000 });
    const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
    const requestId = requestRuntimeHandoff(
      sessionDir, sourceLease.owner_id, sourceLease.token, sourceRuntime, targetRuntime, checkpoint,
    );
    const daemonPidBeforeHandoff = new StateManager().read(statePath).autonomous_owner_recovery_daemon_pid;
    fenceAutonomousOwnerRecoveryForHandoff(
      sessionDir,
      requestId,
      'mux-runner.js',
      [],
      targetRuntimeBin,
      targetRuntime,
    );
    const fenced = new StateManager().read(statePath);
    const stagedSourceSpec = fenced.autonomous_owner_handoff_transaction.source_owner_spec;
    const stagedTargetSpec = fenced.autonomous_owner_handoff_transaction.target_owner_spec;
    releaseRuntimeHandoffLease(sessionDir, sourceLease.owner_id, sourceLease.token, requestId);
    const acceptedTarget = acceptRuntimeHandoff(sessionDir, requestId, 'green-owner', 10_000, targetRuntime);
    // Fault injection: execution disappears after durable acceptance but before the normal
    // owner-transfer call. Recovery must use only the durable event + staged transaction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const committed = await waitForState(
      statePath,
      (current) => current.autonomous_owner_handoff_transaction?.status === 'completed',
    );
    assert.equal(committed.autonomous_owner_recovery_daemon_pid, daemonPidBeforeHandoff);
    assert.deepEqual(committed.autonomous_owner_spec, stagedTargetSpec);
    assert.notDeepEqual(committed.autonomous_owner_spec, stagedSourceSpec);
    assert.equal(committed.autonomous_owner_recovery_suspended, false);
    assert.equal(committed.autonomous_owner_recovery_suspended_for_handoff, null);
    assert.ok(committed.autonomous_owner_spec.pane_start_command.includes(targetRuntimeBin));
    new StateManager().update(statePath, (current) => {
      current.autonomous_supervisor_pid = binding.pane_pid;
      current.autonomous_supervisor_identity = null;
      return current;
    });
    killTmuxSessionById(binding.session_id);
    reconcileSessionLiveness(sessionDir, undefined, 1_700_000_350_000);
    const targetRestored = await waitForState(
      statePath,
      (current) => current.autonomous_owner_restoration?.status === 'restored'
        && current.tmux_runner_binding?.session_id !== binding.session_id,
    );
    binding = targetRestored.tmux_runner_binding;
    await waitForLineCount(targetMarkerPath, 1);
    assert.equal(fs.readFileSync(markerPath, 'utf8').trim().split('\n').length, 3, 'source owner was never restored');

    const rollbackCheckpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, targetRuntime, sourceRuntime);
    const rollbackRequestedAt = Date.now();
    const rollbackRequestId = requestRuntimeHandoff(
      sessionDir,
      acceptedTarget.lease.owner_id,
      acceptedTarget.lease.token,
      targetRuntime,
      sourceRuntime,
      rollbackCheckpoint,
      { nowMs: rollbackRequestedAt },
    );
    fenceAutonomousOwnerRecoveryForHandoff(
      sessionDir, rollbackRequestId, 'mux-runner.js', [], targetRuntimeBin, sourceRuntime,
    );
    const rollbackFenced = new StateManager().read(statePath);
    const exactRollbackSource = rollbackFenced.autonomous_owner_handoff_transaction.source_owner_spec;
    releaseRuntimeHandoffLease(
      sessionDir,
      acceptedTarget.lease.owner_id,
      acceptedTarget.lease.token,
      rollbackRequestId,
      { nowMs: rollbackRequestedAt + 1 },
    );
    // Fault injection: no target ever accepts and the fenced transaction expires.
    assert.equal(
      reconcileAutonomousOwnerHandoffTransaction(sessionDir, undefined, rollbackRequestedAt + 61_000),
      'rolled_back',
    );
    const rolledBack = new StateManager().read(statePath);
    assert.deepEqual(rolledBack.autonomous_owner_spec, exactRollbackSource);
    assert.equal(rolledBack.autonomous_owner_handoff_transaction.status, 'rolled_back');
    assert.equal(rolledBack.autonomous_owner_recovery_suspended, false);
    assert.equal(rolledBack.autonomous_owner_recovery_suspended_for_handoff, null);

    killTmuxSessionById(binding.session_id);
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, 'sleep 30']);
    const foreignBinding = readTmuxRunnerBinding(`${sessionName}:0`);
    assert.ok(foreignBinding);
    binding = foreignBinding;
    const foreignNowMs = 1_700_000_400_000;
    reconcileSessionLiveness(sessionDir, undefined, foreignNowMs);
    const foreignFailed = await waitForState(statePath, (current) => current.recovery_required === true);
    assert.match(foreignFailed.recovery_reason, /different immutable session/);
    try {
      assert.equal(restoreAutonomousBudgetOwner(sessionDir, undefined, foreignNowMs + 1_000), 'noop');
    } catch (error) {
      // A 10ms recovery daemon may reschedule between the observed failure and this probe.
      assert.match(String(error), /different immutable session/);
    }
    assert.equal(new StateManager().read(statePath).recovery_required, true);
    assert.equal(tmuxSessionExists(sessionName), true);
    new StateManager().update(statePath, (current) => {
      current.cancel_requested_at = new Date(foreignNowMs + 2_000).toISOString();
      current.last_exit_reason = 'cancelled';
      return current;
    });
    assert.equal(restoreAutonomousBudgetOwner(sessionDir, undefined, foreignNowMs + 3_000), 'noop');
    assert.equal(tmuxSessionExists(sessionName), true);
  } finally {
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
      if (daemon) await daemon;
    } catch {}
    if (binding?.session_id) {
      try { killTmuxSessionById(binding.session_id); } catch {}
    }
  }
});

test('reconcileSessionLiveness durably repairs a missing rollover intent for an elapsed session', () => {
  const expiredDir = makeTempRoot('pickle-liveness-expired-');
  writeJson(path.join(expiredDir, 'state.json'), state({
    session_dir: expiredDir,
    working_dir: expiredDir,
    max_time_minutes: 1,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(expiredDir);
  const expired = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_000);
  assert.equal(expired.stale, false);
  assert.equal(expired.state.active, true);
  assert.equal(expired.state.last_exit_reason, 'autonomous_budget_rollover');
  assert.match(expired.state.autonomous_budget_rollover_intent_id, /^[0-9a-f-]{36}$/);
  assert.equal(expired.state.autonomous_budget_epoch, 1);
  assert.equal(expired.state.autonomous_budget_reason, 'max_time');
  assert.equal(expired.state.autonomous_budget_rollover_checkpoint_pending.intent_id,
    expired.state.autonomous_budget_rollover_intent_id);
  assert.equal(expired.state.max_time_minutes, 2);
  assert.equal(expired.state.autonomous_time_budget_window_minutes, 2);
  assert.equal(expired.state.run_start_time_epoch, 1_700_000_120);
  assert.ok(Date.parse(expired.state.autonomous_relaunch_deadline)
    > Date.parse(expired.state.autonomous_relaunch_not_before));

  const resumed = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_001);
  assert.equal(resumed.state.autonomous_budget_rollover_intent_id,
    expired.state.autonomous_budget_rollover_intent_id, 'reconciliation reuses the durable intent');
  const checkpoints = [];
  assert.equal(consumeAutonomousBudgetRollover(
    new StateManager(),
    path.join(expiredDir, 'state.json'),
    { recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
  ), true);
  assert.deepEqual(checkpoints.map(({ kind }) => kind), [
    'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
  ]);
  const consumed = new StateManager().read(path.join(expiredDir, 'state.json'));
  assert.equal(consumed.autonomous_budget_rollover_intent_id, null);
  assert.equal(consumed.autonomous_budget_consumed_intent_id,
    expired.state.autonomous_budget_rollover_intent_id);

  const currentDir = makeTempRoot('pickle-liveness-current-');
  writeJson(path.join(currentDir, 'state.json'), state({ session_dir: currentDir, max_time_minutes: 10 }));
  const current = reconcileSessionLiveness(currentDir, undefined, 1_700_000_120_000);
  assert.equal(current.stale, false);
  assert.equal(current.state.active, true);
  assert.equal(fs.existsSync(path.join(currentDir, 'state.json')), true);
});

test('elapsed liveness repair never resurrects cancellation or unsafe rollover evidence', () => {
  const nowMs = 1_700_000_120_000;
  const cancelledDir = makeTempRoot('pickle-liveness-cancelled-expired-');
  writeJson(path.join(cancelledDir, 'state.json'), state({
    session_dir: cancelledDir,
    max_time_minutes: 1,
    cancel_requested_at: new Date(nowMs - 1_000).toISOString(),
    last_exit_reason: 'cancelled',
  }));
  const cancelled = reconcileSessionLiveness(cancelledDir, undefined, nowMs);
  assert.equal(cancelled.state.autonomous_budget_rollover_intent_id, undefined);
  assert.equal(cancelled.state.last_exit_reason, 'cancelled');

  const unsafeDir = makeTempRoot('pickle-liveness-unsafe-expired-');
  writeJson(path.join(unsafeDir, 'state.json'), state({
    session_dir: unsafeDir,
    max_time_minutes: 1,
    recovery_required: true,
    recovery_reason: 'operator-owned recovery evidence',
    step: 'blocked',
  }));
  const unsafe = reconcileSessionLiveness(unsafeDir, undefined, nowMs);
  assert.equal(unsafe.stale, false);
  assert.equal(unsafe.state.recovery_required, true);
  assert.equal(unsafe.state.recovery_reason, 'operator-owned recovery evidence');
  assert.equal(unsafe.state.autonomous_budget_rollover_intent_id, undefined);

  const corruptDir = makeTempRoot('pickle-liveness-corrupt-rollover-');
  writeJson(path.join(corruptDir, 'state.json'), state({
    session_dir: corruptDir,
    working_dir: corruptDir,
    max_time_minutes: 1,
    autonomous_budget_epoch: 'not-an-epoch',
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(corruptDir);
  assert.throws(
    () => reconcileSessionLiveness(corruptDir, undefined, nowMs),
    /corrupt epoch/,
  );
  const corrupt = new StateManager().read(path.join(corruptDir, 'state.json'));
  assert.equal(corrupt.active, true);
  assert.equal(corrupt.autonomous_budget_rollover_intent_id, undefined);

  const unboundDir = makeTempRoot('pickle-liveness-unbound-rollover-');
  writeJson(path.join(unboundDir, 'state.json'), state({
    session_dir: unboundDir,
    working_dir: unboundDir,
    max_time_minutes: 1,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
    autonomous_budget_rollover_checkpoint_pending: {
      kind: 'autonomous_budget_rollover', intent_id: 'lost-intent', epoch: 1,
    },
  }));
  registerProcessOwner(unboundDir);
  assert.throws(
    () => reconcileSessionLiveness(unboundDir, undefined, nowMs),
    /unbound recovery evidence/,
  );
  assert.equal(new StateManager().read(path.join(unboundDir, 'state.json'))
    .autonomous_budget_rollover_intent_id, undefined);

  const corruptIntentDir = makeTempRoot('pickle-liveness-corrupt-intent-');
  writeJson(path.join(corruptIntentDir, 'state.json'), state({
    session_dir: corruptIntentDir,
    max_time_minutes: 1,
    autonomous_budget_epoch: 0,
    autonomous_budget_rollover_intent_id: 'intent-without-epoch',
  }));
  assert.throws(
    () => reconcileSessionLiveness(corruptIntentDir, undefined, nowMs),
    /intent has a corrupt epoch/,
  );
});

test('elapsed repair blocks a live ambiguous child and never publishes a rollover intent', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-live-child-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    active_child_pid: process.pid,
    active_child_kind: 'codex',
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);

  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.last_exit_reason, 'max_time_orphaned_child');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.active_child_pid, process.pid);
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed repair reaps an exact child before atomically publishing rollover ownership', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-exact-child-');
  const child = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)', '--', '--add-dir', sessionDir,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  const identity = captureSpawnedProcessIdentity(Number(child.pid));
  assert.ok(identity);
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    active_child_pid: child.pid,
    active_child_kind: 'codex',
    active_child_identity: identity,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);
  try {
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
    assert.equal(result.stale, false);
    assert.equal(result.state.active, true);
    assert.equal(result.state.last_exit_reason, 'autonomous_budget_rollover');
    assert.ok(result.state.autonomous_budget_rollover_intent_id);
    assert.equal(result.state.active_child_pid, null);
    assert.equal(result.state.active_child_identity, null);
    assert.equal(result.state.recovery_required, undefined);
  } finally {
    try { process.kill(-Number(child.pid), 'SIGKILL'); } catch {}
  }
});

test('elapsed foreground session without an authenticated owner contract blocks without orphaning an intent', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-unsupervised-');
  writeJson(path.join(sessionDir, 'state.json'), state({ session_dir: sessionDir, max_time_minutes: 1 }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.recovery_kind, 'autonomous_owner_contract_invalid');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed process session restores one authenticated detached supervisor with exact argv and cwd', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'replacement.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  const spec = registerAutonomousOwnerSpec(
    sessionDir,
    'mux-runner.js',
    ['--process-owner-proof'],
    undefined,
    path.join(runtimeDir, 'supervised-runner.js'),
  );
  assert.equal(spec.owner_mode, 'process');
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });

  let restoredIdentity = null;
  try {
    const nowMs = 1_700_000_120_000;
    const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
    assert.equal(reconciled.state.last_exit_reason, 'autonomous_budget_rollover');
    assert.equal(reconciled.state.autonomous_owner_restoration.status, 'pending');
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => (
      runRestoreProcess(sessionDir, nowMs + 1_000)
    )));
    assert.equal(outcomes.filter((outcome) => outcome === 'restored').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === 'noop').length, 11);
    const restored = new StateManager().read(statePath);
    restoredIdentity = restored.autonomous_supervisor_identity;
    assert.equal(restored.autonomous_owner_restoration.status, 'restored');
    assert.equal(restored.history.filter(({ step }) => step === 'autonomous_owner_restored').length, 1);
    assert.equal(inspectProcessLivenessIdentity(restoredIdentity), 'matched');
    await waitForState(statePath, () => fs.existsSync(markerPath));
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.deepEqual(marker.argv, [fs.realpathSync(sessionDir), '--runner-bin=mux-runner.js', '--process-owner-proof']);
    assert.equal(marker.cwd, fs.realpathSync(sessionDir));
    assert.equal(marker.pid, restoredIdentity.pid);
    assert.equal(restoredIdentity.pgid, restoredIdentity.pid);
  } finally {
    if (restoredIdentity) reapRecordedLiveProcessGroup(restoredIdentity);
  }
});

test('process owner registration converges a crash snapshot and preserves corrupt immutable evidence', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-register-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, state({ session_dir: sessionDir, working_dir: sessionDir }));
  const spec = registerProcessOwner(sessionDir);
  new StateManager().update(statePath, (current) => {
    current.autonomous_budget_epoch = 2;
    current.autonomous_budget_rollover_intent_id = 'process-crash-rollover';
    current.autonomous_owner_restoration = {
      schema_version: 1,
      intent_id: 'process-crash-restoration',
      rollover_intent_id: 'process-crash-rollover',
      rollover_epoch: 2,
      owner_spec_id: spec.spec_id,
      status: 'restoring',
      attempt: 1,
      not_before: new Date(0).toISOString(),
      restorer_pid: 999_999_999,
      restorer_identity: null,
    };
    return current;
  });
  registerProcessOwner(sessionDir);
  let persisted = new StateManager().read(statePath);
  assert.equal(persisted.autonomous_owner_restoration.status, 'restored');
  assert.equal(persisted.autonomous_supervisor_pid, process.pid);
  assert.equal(persisted.history.filter(({ step }) => step === 'autonomous_owner_restored').length, 1);

  const corrupt = { ...persisted.autonomous_owner_spec, supervisor_sha256: '0'.repeat(64) };
  new StateManager().update(statePath, (current) => {
    current.autonomous_owner_spec = corrupt;
    current.autonomous_supervisor_pid = null;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  assert.throws(() => registerProcessOwner(sessionDir), /Refusing to overwrite a corrupt/);
  persisted = new StateManager().read(statePath);
  assert.deepEqual(persisted.autonomous_owner_spec, corrupt);
  assert.equal(persisted.autonomous_supervisor_pid, null);

  const raceDir = makeTempRoot('pickle-liveness-process-owner-register-race-');
  const raceStatePath = path.join(raceDir, 'state.json');
  const racedCorruption = { schema_version: 1, spec_id: 'corrupt-racing-owner-spec' };
  writeJson(raceStatePath, state({ session_dir: raceDir, working_dir: raceDir }));
  const racingManager = new InjectBeforeFirstUpdateStateManager((current) => {
    current.autonomous_owner_spec = racedCorruption;
    current.autonomous_supervisor_pid = null;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  assert.throws(
    () => registerAutonomousOwnerSpec(
      raceDir,
      'mux-runner.js',
      [],
      racingManager,
      path.resolve(new URL('../bin/supervised-runner.js', import.meta.url).pathname),
    ),
    /Refusing to overwrite a corrupt/,
  );
  const raced = new StateManager().read(raceStatePath);
  assert.deepEqual(raced.autonomous_owner_spec, racedCorruption);
  assert.equal(raced.autonomous_supervisor_pid, null);
});

test('process owner specification copied from another session fails closed before rollover publication', () => {
  const sourceDir = makeTempRoot('pickle-liveness-process-owner-source-');
  const targetDir = makeTempRoot('pickle-liveness-process-owner-target-');
  writeJson(path.join(sourceDir, 'state.json'), state({ session_dir: sourceDir, working_dir: sourceDir }));
  const foreignSpec = registerProcessOwner(sourceDir);
  writeJson(path.join(targetDir, 'state.json'), state({
    session_dir: targetDir,
    working_dir: targetDir,
    max_time_minutes: 1,
    autonomous_owner_spec: foreignSpec,
  }));
  const result = reconcileSessionLiveness(targetDir, undefined, 1_700_000_120_000);
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.recovery_kind, 'autonomous_owner_contract_invalid');
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed repair rejects an immutable owner mutation racing the atomic rollover publication', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-rollover-race-');
  const statePath = path.join(sessionDir, 'state.json');
  const racedCorruption = { schema_version: 1, spec_id: 'corrupt-racing-rollover-spec' };
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerProcessOwner(sessionDir);
  const racingManager = new InjectBeforeFirstUpdateStateManager((current) => {
    current.autonomous_owner_spec = racedCorruption;
    return current;
  });
  assert.throws(
    () => reconcileSessionLiveness(sessionDir, racingManager, 1_700_000_120_000),
    /immutable owner state changed/,
  );
  const raced = new StateManager().read(statePath);
  assert.deepEqual(raced.autonomous_owner_spec, racedCorruption);
  assert.equal(raced.autonomous_budget_rollover_intent_id, undefined);
});

test('process owner restoration refuses changed runtime bytes without spawning a replacement', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-tamper-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'replacement-started');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(reconciled.state.autonomous_owner_restoration.status, 'pending');
  fs.appendFileSync(path.join(runtimeDir, 'mux-runner.js'), '// changed after registration\n');
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000),
    /Refusing to restore.*immutable runtime identity/s,
  );
  const failed = new StateManager().read(statePath);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
  assert.equal(fs.existsSync(markerPath), false);
});

test('process owner restoration gives concurrent cancellation dominance and fences its detached child', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-cancel-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let launchedIdentity = null;
  const outcome = restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
    afterProcessSpawn(identity) {
      launchedIdentity = identity;
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at = new Date(nowMs + 1_001).toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    },
  });
  assert.equal(outcome, 'noop');
  assert.ok(launchedIdentity);
  assert.equal(inspectProcessLivenessIdentity(launchedIdentity), 'not-running');
  const cancelled = new StateManager().read(statePath);
  assert.equal(cancelled.last_exit_reason, 'cancelled');
  assert.equal(cancelled.history.some(({ step }) => step === 'autonomous_owner_restored'), false);
  assert.notEqual(cancelled.autonomous_supervisor_pid, launchedIdentity.pid);
});

test('process owner restoration rejects same-id contract corruption racing final publication', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-publication-race-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  const spec = registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let launchedIdentity = null;
  const corruption = { ...spec, runner_sha256: '0'.repeat(64) };
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
      afterProcessSpawn(identity) {
        launchedIdentity = identity;
        new StateManager().update(statePath, (current) => {
          current.autonomous_owner_spec = corruption;
          return current;
        });
      },
    }),
    /Refusing to publish restored process ownership/,
  );
  assert.ok(launchedIdentity);
  assert.equal(inspectProcessLivenessIdentity(launchedIdentity), 'not-running');
  const failed = new StateManager().read(statePath);
  assert.deepEqual(failed.autonomous_owner_spec, corruption);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
  assert.equal(failed.history.some(({ step }) => step === 'autonomous_owner_restored'), false);
  assert.notEqual(failed.autonomous_supervisor_pid, launchedIdentity.pid);
});

test('process owner restoration kills a spawned supervisor when immutable identity capture fails', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-capture-failure-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let spawnedPid = null;
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
      captureSpawnedIdentity(pid) {
        spawnedPid = pid;
        return null;
      },
    }),
    /without an exact spawned process identity/,
  );
  assert.ok(spawnedPid);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(spawnedPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      spawnedPid = null;
      break;
    }
  }
  assert.equal(spawnedPid, null, 'spawned supervisor must not survive failed identity capture');
  const failed = new StateManager().read(statePath);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
});

test('simultaneous elapsed repairs converge on one durable intent without loser errors', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-concurrent-repair-');
  const nowMs = 1_700_000_120_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);

  const observed = await Promise.all(Array.from({ length: 12 }, () => (
    runLivenessProcess(sessionDir, nowMs)
  )));
  assert.equal(new Set(observed).size, 1);
  assert.ok(observed[0]);
  const persisted = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.equal(persisted.autonomous_budget_rollover_intent_id, observed[0]);
  assert.equal(persisted.autonomous_budget_epoch, 1);
  assert.equal(persisted.history.filter(({ step }) => step === 'autonomous_budget_rollover').length, 1);
});

test('reconcileSessionLiveness blocks and preserves discoverability for a live orphan child', () => {
  const sessionDir = makeTempRoot('pickle-liveness-orphan-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: process.pid,
    active_child_kind: 'codex',
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.last_exit_reason, 'runner_lost_orphaned_child');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.active_child_pid, process.pid);
  assert.equal(result.state.orphan_child_pid, process.pid);
});

test('reconcileSessionLiveness reaps an identity-matched lifecycle child using a nested candidate add-dir', () => {
  const sessionDir = makeTempRoot('pickle-liveness-identity-orphan-');
  const candidateDir = path.join(sessionDir, 'worker-lifecycle-candidates', 'ticket-implement');
  fs.mkdirSync(candidateDir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--add-dir', candidateDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const identity = captureSpawnedProcessIdentity(Number(child.pid));
  assert.ok(identity);
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: child.pid,
    active_child_kind: 'codex',
    active_child_identity: identity,
  }));
  try {
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
    assert.equal(result.stale, true);
    assert.equal(result.state.active, false);
    assert.equal(result.state.last_exit_reason, 'runner_lost');
    assert.equal(result.state.recovery_required, false);
    assert.equal(result.state.orphan_child_pid, null);
  } finally {
    try { process.kill(-Number(child.pid), 'SIGKILL'); } catch {}
  }
});
