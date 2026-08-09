// @tier: fast
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { reconcileSessionLiveness } from '../services/session.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
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

test('reconcileSessionLiveness expires an over-time non-tmux session but preserves a current one', () => {
  const expiredDir = makeTempRoot('pickle-liveness-expired-');
  writeJson(path.join(expiredDir, 'state.json'), state({ session_dir: expiredDir, max_time_minutes: 1 }));
  const expired = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_000);
  assert.equal(expired.stale, true);
  assert.equal(expired.state.last_exit_reason, 'max_time');

  const currentDir = makeTempRoot('pickle-liveness-current-');
  writeJson(path.join(currentDir, 'state.json'), state({ session_dir: currentDir, max_time_minutes: 10 }));
  const current = reconcileSessionLiveness(currentDir, undefined, 1_700_000_120_000);
  assert.equal(current.stale, false);
  assert.equal(current.state.active, true);
  assert.equal(fs.existsSync(path.join(currentDir, 'state.json')), true);
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
