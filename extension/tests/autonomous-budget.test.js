// @tier: fast
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempRoot, writeJson } from './helpers.js';
import { StateManager } from '../services/state-manager.js';
import {
  consumeAutonomousBudgetRollover,
  scheduleAutonomousBudgetRollover,
} from '../services/autonomous-budget.js';
import { runLoop } from '../bin/loop-runner.js';
import { runSupervisedRunner } from '../bin/supervised-runner.js';
import { beginAutonomousExecution, cancelLogicalPipelineByOperator, createLogicalPipeline } from '../services/durable-supervisor.js';
import { writePrdSeal } from '../services/prd-seal.js';

test('autonomous iteration budget rollover advances a stable window and consumes its intent once', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-budget-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'implement', current_ticket: 'R1', history: [],
    iteration: 25, max_iterations: 25, max_time_minutes: 480,
  });
  const manager = new StateManager();
  const checkpoints = [];
  const first = scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations', {
    ticketId: 'R1', nowMs: 1_000, recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  const pending = manager.read(statePath);
  assert.equal(first.delayMs, 250);
  assert.equal(pending.active, true);
  assert.equal(pending.max_iterations, 50);
  assert.equal(pending.autonomous_iteration_budget_window, 25);
  assert.equal(pending.autonomous_budget_rollover_intent_id, first.intentId);
  assert.equal(checkpoints[0].intent_id, first.intentId);

  assert.equal(consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }), true);
  assert.equal(consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }), false);
  const consumed = manager.read(statePath);
  assert.equal(consumed.autonomous_budget_consumed_epoch, 1);
  assert.equal(consumed.history.filter((entry) => entry.step === 'autonomous_budget_rollover_consumed').length, 1);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.kind), [
    'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
  ]);

  manager.update(statePath, (state) => {
    state.last_exit_reason = null;
    state.iteration = 50;
    return state;
  });
  const second = scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations', { nowMs: 2_000 });
  assert.equal(second.delayMs, 500);
  assert.equal(manager.read(statePath).max_iterations, 75);
});

test('autonomous time budget rollover resets the effective work window before relaunch', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-time-budget-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'research', history: [], iteration: 0,
    max_iterations: 25, max_time_minutes: 480, run_started_at: '2020-01-01T00:00:00.000Z',
  });
  const manager = new StateManager();
  scheduleAutonomousBudgetRollover(manager, statePath, 'max_time', { nowMs: 1_700_000_000_000 });
  const pending = manager.read(statePath);
  assert.equal(pending.max_time_minutes, 960);
  assert.equal(pending.autonomous_time_budget_window_minutes, 960);
  assert.equal(pending.run_started_at, '2023-11-14T22:13:20.000Z');
  assert.equal(pending.active, true);
  assert.equal(pending.step, 'research');
});

test('repair mode still rejects a genuinely pre-existing rollover intent', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-preexisting-rollover-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'implement', history: [], iteration: 1,
    max_iterations: 25, max_time_minutes: 1, autonomous_budget_epoch: 1,
    autonomous_budget_rollover_intent_id: 'pre-existing-intent',
    last_exit_reason: 'autonomous_budget_rollover',
  });
  assert.throws(
    () => scheduleAutonomousBudgetRollover(new StateManager(), statePath, 'max_time', {
      repairMissingIntent: true,
    }),
    /second autonomous budget rollover/,
  );
  assert.equal(new StateManager().read(statePath).autonomous_budget_rollover_intent_id,
    'pre-existing-intent');
});

test('replacement reconciles a crash after rollover state commit but before lease checkpoint', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-budget-crash-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'implement', history: [], iteration: 25,
    max_iterations: 25, max_time_minutes: 480,
  });
  const manager = new StateManager();
  const rollover = scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations', {
    recordDurableCheckpoint: () => { throw new Error('simulated checkpoint crash'); },
  });
  assert.equal(rollover.checkpointRecorded, false);
  const pending = manager.read(statePath);
  assert.equal(pending.active, true);
  assert.equal(pending.max_iterations, 50);
  assert.equal(typeof pending.autonomous_budget_rollover_intent_id, 'string');
  assert.equal(pending.autonomous_budget_checkpoint_error, 'simulated checkpoint crash');

  const reconciled = [];
  assert.equal(consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: (checkpoint) => reconciled.push(checkpoint),
  }), true);
  assert.deepEqual(reconciled.map((checkpoint) => checkpoint.kind), [
    'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
  ]);
  assert.equal(reconciled[0].intent_id, pending.autonomous_budget_rollover_intent_id);
  assert.equal(consumeAutonomousBudgetRollover(manager, statePath), false);
});

test('atomic rollover scheduling cannot resurrect a cancelled session', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-budget-cancel-race-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: false, step: 'paused', history: [], iteration: 25,
    max_iterations: 25, max_time_minutes: 480, last_exit_reason: 'cancelled',
    cancel_requested_at: new Date().toISOString(),
  });
  const manager = new StateManager();
  assert.equal(scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations'), null);
  const state = manager.read(statePath);
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.max_iterations, 25);
  assert.equal(state.autonomous_budget_rollover_intent_id, undefined);
});

test('consume checkpoint failure leaves an exact pending receipt and retry re-emits it once', () => {
  const sessionDir = makeTempRoot('pickle-autonomous-budget-consume-crash-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'implement', history: [], iteration: 25,
    max_iterations: 25, max_time_minutes: 480,
  });
  const manager = new StateManager();
  const scheduled = [];
  const rollover = scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations', {
    recordDurableCheckpoint: (checkpoint) => scheduled.push(checkpoint),
  });
  assert.ok(rollover);
  assert.throws(() => consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: () => { throw new Error('simulated consumed checkpoint crash'); },
  }), /simulated consumed checkpoint crash/);
  const interrupted = manager.read(statePath);
  assert.equal(interrupted.autonomous_budget_rollover_intent_id, null);
  assert.equal(interrupted.autonomous_budget_consumed_checkpoint_pending.intent_id, rollover.intentId);
  assert.equal(interrupted.autonomous_budget_checkpoint_error, 'simulated consumed checkpoint crash');

  const recovered = [];
  assert.equal(consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: (checkpoint) => recovered.push(checkpoint),
  }), true);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].receipt_id, `autonomous-budget:consumed:${rollover.intentId}`);
  assert.equal(manager.read(statePath).autonomous_budget_consumed_checkpoint_pending, null);
  assert.equal(consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: (checkpoint) => recovered.push(checkpoint),
  }), false);
  assert.equal(recovered.length, 1);
});

test('cancellation after a consumed-checkpoint crash remains terminal in the replacement loop', async () => {
  const projectDir = makeTempRoot('pickle-autonomous-cancel-after-consume-project-');
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd: projectDir });
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: projectDir, stdio: 'ignore' });
  const sessionDir = makeTempRoot('pickle-autonomous-cancel-after-consume-session-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'anatomy-park', current_ticket: null, history: [],
    iteration: 25, max_iterations: 25, max_time_minutes: 480, working_dir: projectDir,
    session_dir: sessionDir, original_prompt: 'continue autonomous review', started_at: new Date().toISOString(),
  });
  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park', target: projectDir, task: 'continue autonomous review', stall_limit: 8,
  });
  const manager = new StateManager();
  scheduleAutonomousBudgetRollover(manager, statePath, 'max_iterations', {
    recordDurableCheckpoint: () => undefined,
  });
  assert.throws(() => consumeAutonomousBudgetRollover(manager, statePath, {
    recordDurableCheckpoint: () => { throw new Error('consume checkpoint crash before cancellation'); },
  }), /consume checkpoint crash before cancellation/);
  manager.update(statePath, (state) => {
    state.active = false;
    state.cancelled = true;
    state.last_exit_reason = 'cancelled';
    state.cancel_requested_at = '2020-01-01T00:00:00.000Z';
    return state;
  });
  const replacementCheckpoints = [];
  await assert.rejects(() => runLoop(sessionDir, {
    durableOwnershipHeld: true,
    runStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    assertDurableOwnership: () => undefined,
    recordDurableCheckpoint: (checkpoint) => replacementCheckpoints.push(checkpoint),
  }), /cancelled during loop runner startup/);
  const cancelled = manager.read(statePath);
  assert.equal(cancelled.active, false);
  assert.equal(cancelled.last_exit_reason, 'cancelled');
  assert.equal(cancelled.cancel_requested_at, '2020-01-01T00:00:00.000Z');
  assert.ok(cancelled.autonomous_budget_consumed_checkpoint_pending);
  assert.deepEqual(replacementCheckpoints, []);
});

test('durably owned loop runner rolls over at its iteration boundary without terminal phase exit', async () => {
  const projectDir = makeTempRoot('pickle-autonomous-loop-project-');
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd: projectDir });
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: projectDir, stdio: 'ignore' });
  const sessionDir = makeTempRoot('pickle-autonomous-loop-session-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'anatomy-park', current_ticket: null, history: [],
    iteration: 25, max_iterations: 25, max_time_minutes: 480, working_dir: projectDir,
    session_dir: sessionDir, original_prompt: 'continue autonomous review', started_at: new Date().toISOString(),
  });
  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park', target: projectDir, task: 'continue autonomous review', stall_limit: 8,
  });
  const checkpoints = [];
  await runLoop(sessionDir, {
    durableOwnershipHeld: true,
    assertDurableOwnership: () => undefined,
    recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  const state = new StateManager().read(statePath);
  assert.equal(state.active, true);
  assert.equal(state.step, 'anatomy-park');
  assert.equal(state.last_exit_reason, 'autonomous_budget_rollover');
  assert.equal(state.max_iterations, 50);
  assert.equal(checkpoints[0].kind, 'autonomous_budget_rollover');
});

test('supervised standalone loop CLI owns, checkpoints, consumes, and replaces at real budget boundaries', async () => {
  const projectDir = makeTempRoot('pickle-autonomous-loop-cli-project-');
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd: projectDir });
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: projectDir, stdio: 'ignore' });
  const sessionDir = makeTempRoot('pickle-autonomous-loop-cli-session-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    schema_version: 1, active: true, step: 'anatomy-park', current_ticket: null, history: [],
    iteration: 25, max_iterations: 25, max_time_minutes: 480, working_dir: projectDir,
    session_dir: sessionDir, original_prompt: 'continue autonomous review', started_at: new Date().toISOString(),
  });
  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park', target: projectDir, task: 'continue autonomous review', stall_limit: 8,
  });
  createLogicalPipeline(sessionDir, 'standalone-loop');
  writePrdSeal(sessionDir, {
    prd: '# Standalone loop\n',
    repository: { identity: 'repo@base', working_directory: projectDir, execution_base_policy: 'sealed base' },
    acceptance_criteria: [{ id: 'AC-1', text: 'Continue across budget boundaries.' }],
    scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir);

  const supervised = runSupervisedRunner(sessionDir, 'loop-runner.js', [], { restartDelayMs: 0 });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = new StateManager().read(statePath);
    if (Number(state.autonomous_budget_epoch || 0) >= 1) {
      new StateManager().update(statePath, (current) => {
        current.iteration = current.max_iterations;
        return current;
      });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (Number(new StateManager().read(statePath).autonomous_budget_epoch || 0) >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Number(new StateManager().read(statePath).autonomous_budget_epoch), 2);
  new StateManager().update(statePath, (current) => {
    current.active = false;
    current.last_exit_reason = 'cancelled';
    current.cancel_requested_at = new Date().toISOString();
    return current;
  });
  const cancelledLogical = cancelLogicalPipelineByOperator(
    sessionDir,
    'test completed after two exact replacements',
  );
  assert.equal(cancelledLogical.terminal_state, 'cancelled');
  assert.equal(await supervised, 130);
  const repeatedCancellation = cancelLogicalPipelineByOperator(
    sessionDir,
    'replayed cleanup after the supervised executor observed cancellation',
  );
  assert.equal(repeatedCancellation.terminal_state, 'cancelled');
  assert.equal(
    repeatedCancellation.events.filter((event) => event.kind === 'pipeline_cancelled').length,
    1,
  );
  const checkpoints = repeatedCancellation.events
    .map((event) => event.details.checkpoint)
    .filter((checkpoint) => checkpoint?.kind?.startsWith('autonomous_budget'));
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.kind), [
    'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed', 'autonomous_budget_rollover',
  ]);
});
