// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, repoRoot, runNode, writeJson } from './helpers.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  beginAutonomousExecution,
  readLogicalPipeline,
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  createLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestPrdRevision,
  requestRuntimeHandoff,
  terminateLogicalPipeline,
} from '../services/durable-supervisor.js';
import { recordSupervisorSignalTermination, runSupervisedRunner, supervisedRunnerDecision } from '../bin/supervised-runner.js';
import { executionTelemetrySummary, recordUnexpectedNoncompletionTermination } from '../services/productive-autonomy.js';
import { writeRefinementAcceptance } from '../services/refinement-artifacts.js';
import { ensureSessionPrdSeal } from '../services/session-prd-seal.js';
import { reconcileSessionLiveness } from '../services/session.js';
import { inspectRecordedLiveProcessIdentity, reapRecordedLiveProcessGroup } from '../services/orphan-reaper.js';
import { createCancellationRecoveryIntent } from '../services/cancellation-recovery.js';
import { StateManager } from '../services/state-manager.js';

function autonomousSession() {
  const sessionDir = makeTempRoot('pickle-supervised-runner-');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1, active: true, history: [], iteration: 0, max_iterations: 25,
    max_time_minutes: 480, working_dir: sessionDir, step: 'implement',
  }));
  createLogicalPipeline(sessionDir, 'pipeline');
  writePrdSeal(sessionDir, {
    prd: '# Approved\n',
    repository: { identity: 'repo@base', working_directory: sessionDir, execution_base_policy: 'sealed base' },
    acceptance_criteria: [{ id: 'AC-1', text: 'Keep running.' }],
    scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir);
  return sessionDir;
}

const sourceRuntime = { runtime_id: 'blue', version: '1.0.0', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
const targetRuntime = { runtime_id: 'green', version: '2.0.0', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
const sourceIdentity = { pid: 41001, pgid: 41000, start_time: 'Sat Aug  8 13:00:00 2026', fingerprint: 'c'.repeat(64) };
const unrelatedIdentity = { ...sourceIdentity, pid: 41002, fingerprint: 'd'.repeat(64) };

function releasedHandoffSession() {
  const sessionDir = autonomousSession();
  const lease = acquireSupervisorLease(sessionDir, {
    ownerId: 'blue-source', ttlMs: 60_000, ownerIdentity: sourceIdentity,
  });
  const requestId = requestRuntimeHandoff(
    sessionDir, lease.owner_id, lease.token, sourceRuntime, targetRuntime, { phase: 'implement' },
  );
  releaseRuntimeHandoffLease(sessionDir, lease.owner_id, lease.token, requestId);
  return { sessionDir, requestId };
}

test('supervised runner restarts every nonterminal autonomous executor exit', () => {
  const sessionDir = autonomousSession();
  assert.equal(supervisedRunnerDecision(sessionDir), 'restart');
  requestPrdRevision(sessionDir, 'contradiction evidence', 'proposed patch');
  assert.equal(supervisedRunnerDecision(sessionDir), 'wait_for_prd');
});

test('default iteration and unusable time budgets roll through supervised replacements into productive work', async () => {
  const dataRoot = makeTempRoot('pickle-supervised-budget-data-');
  const projectDir = makeTempRoot('pickle-supervised-budget-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'supervised budget rollover'], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'R1', title: 'Budget rollover', description: 'Continue after the configured boundary.',
      acceptance_criteria: ['A replacement executor completes the ticket.'],
      verification: ['node -e "process.exit(0)"'], allowed_paths: ['README.md'], priority: 'P1', status: 'Todo',
    }],
  });
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Budget rollover\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Budget rollover\n');
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    writeRefinementAcceptance(sessionDir);
    ensureSessionPrdSeal(sessionDir);
    const statePath = path.join(sessionDir, 'state.json');
    const initial = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    writeJson(statePath, {
      ...initial,
      active: true,
      iteration: 25,
      max_iterations: 25,
      max_time_minutes: 0.000001,
      run_started_at: '2020-01-01T00:00:00.000Z',
    });

    const fixtureDir = makeTempRoot('pickle-supervised-budget-executor-');
    const launchesPath = path.join(fixtureDir, 'launches');
    const workPath = path.join(fixtureDir, 'work');
    const runnerPath = path.join(fixtureDir, 'executor.mjs');
    const muxModule = new URL('../bin/mux-runner.js', import.meta.url).href;
    const ticketsModule = new URL('../services/tickets.js', import.meta.url).href;
    fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
const [sessionDir, launchesPath, workPath, dataRoot, muxModule, ticketsModule] = process.argv.slice(2);
process.env.PICKLE_DATA_ROOT = dataRoot;
fs.writeFileSync(launchesPath, String(Number(fs.existsSync(launchesPath) ? fs.readFileSync(launchesPath, 'utf8') : 0) + 1));
const { runSequential, muxRunnerExitFailed } = await import(muxModule);
const { updateTicketStatus } = await import(ticketsModule);
const reason = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
  runTicket: async (_sessionDir, ticketId) => {
    fs.writeFileSync(workPath, String(Number(fs.existsSync(workPath) ? fs.readFileSync(workPath, 'utf8') : 0) + 1));
    updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
    return { status: 'done', applied: true };
  },
  runCitadel: async () => 'cancelled',
});
process.exitCode = muxRunnerExitFailed(reason) ? 1 : 0;
`);

    const run = runSupervisedRunner(sessionDir, 'mux-runner.js', [
      launchesPath, workPath, dataRoot, muxModule, ticketsModule,
    ], { runnerPath, restartDelayMs: 0 });
    let rollover = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (let attempt = 0; attempt < 100 && rollover.last_exit_reason !== 'autonomous_budget_rollover'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rollover = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    assert.equal(rollover.active, true);
    assert.equal(rollover.last_exit_reason, 'autonomous_budget_rollover');
    assert.equal(rollover.max_iterations, 50);
    assert.equal(reconcileSessionLiveness(sessionDir).state.active, true);

    assert.equal(await run, 130);
    assert.equal(fs.readFileSync(launchesPath, 'utf8'), '3');
    assert.equal(fs.readFileSync(workPath, 'utf8'), '1');
    const completed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(completed.last_exit_reason, 'cancelled');
    assert.equal(completed.max_time_minutes, 1, 'tiny zero-work time window expands to a productive minimum');
    assert.equal(completed.autonomous_budget_epoch, 2);
    assert.equal(completed.autonomous_budget_consumed_epoch, 2);
    assert.equal(completed.history.filter((entry) => entry.step === 'autonomous_budget_rollover_consumed').length, 2);
    const logical = readLogicalPipeline(sessionDir);
    assert.equal(logical.terminal_state, 'cancelled');
    const budgetCheckpoints = logical.events
      .map((event) => event.details.checkpoint)
      .filter((checkpoint) => checkpoint?.kind?.startsWith('autonomous_budget_rollover'));
    assert.deepEqual(budgetCheckpoints.map((checkpoint) => checkpoint.kind), [
      'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
      'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
    ]);
    assert.equal(budgetCheckpoints[0].intent_id, budgetCheckpoints[1].intent_id);
    assert.equal(budgetCheckpoints[2].intent_id, budgetCheckpoints[3].intent_id);
    assert.notEqual(budgetCheckpoints[0].intent_id, budgetCheckpoints[2].intent_id);
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('supervised runner exits for cooperative logical cancellation', () => {
  const cancelled = autonomousSession();
  const cancelledLease = acquireSupervisorLease(cancelled, { ownerId: 'cancelled-test', ttlMs: 60_000 });
  terminateLogicalPipeline(cancelled, 'cancelled', { ownerId: cancelledLease.owner_id, token: cancelledLease.token });
  assert.equal(supervisedRunnerDecision(cancelled), 'cancelled');
});

test('supervised runner waits for cancellation recovery instead of restarting development', () => {
  const sessionDir = autonomousSession();
  new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
    state.active = false;
    state.cancel_requested_at = new Date().toISOString();
    state.last_exit_reason = 'cancel_recovery_required';
    state.recovery_required = true;
    state.recovery_kind = 'cancellation_ownership';
    state.cancellation_recovery = createCancellationRecoveryIntent([]);
    return state;
  });
  assert.equal(supervisedRunnerDecision(sessionDir), 'wait_for_cancel_recovery');
  const lease = acquireSupervisorLease(sessionDir, { ownerId: 'cancel-recovery-test', ttlMs: 60_000 });
  terminateLogicalPipeline(sessionDir, 'cancelled', { ownerId: lease.owner_id, token: lease.token });
  assert.equal(supervisedRunnerDecision(sessionDir), 'wait_for_cancel_recovery',
    'pending ownership recovery takes precedence over the cancelled logical journal');
});

test('SIGKILL of an executor is replaced and the logical pipeline still completes', async (t) => {
  const sessionDir = autonomousSession();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1, active: true, active_child_pid: null, active_child_identity: null,
  }));
  const fixtureDir = makeTempRoot('pickle-supervised-executor-');
  const countPath = path.join(fixtureDir, 'count');
  const pidPath = path.join(fixtureDir, 'pid');
  const modelPidPath = path.join(fixtureDir, 'model-pid');
  const recoverySnapshotPath = path.join(fixtureDir, 'recovery-snapshot.json');
  const fakeCodexPath = path.join(fixtureDir, 'codex');
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.MODEL_PID_PATH, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const durableModule = new URL('../services/durable-supervisor.js', import.meta.url).href;
  const codexModule = new URL('../services/codex.js', import.meta.url).href;
  const stateManagerModule = new URL('../services/state-manager.js', import.meta.url).href;
  const orphanReaperModule = new URL('../services/orphan-reaper.js', import.meta.url).href;
  const runnerPath = path.join(fixtureDir, 'executor.mjs');
  let exactModelIdentity = null;
  t.after(() => {
    if (!exactModelIdentity) return;
    const result = reapRecordedLiveProcessGroup(exactModelIdentity);
    assert.ok(['reaped', 'not-running'].includes(result.status));
    assert.notEqual(inspectRecordedLiveProcessIdentity(exactModelIdentity), 'matched');
  });
  fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
const [sessionDir, countPath, pidPath, modelPidPath, recoverySnapshotPath, fakeCodexPath, durableModule, codexModule, stateManagerModule, orphanReaperModule] = process.argv.slice(2);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
if (count === 1) {
  const { runCodexExecMonitored } = await import(codexModule);
  const { StateManager } = await import(stateManagerModule);
  const { captureSpawnedProcessIdentity } = await import(orphanReaperModule);
  fs.writeFileSync(pidPath, String(process.pid));
  await runCodexExecMonitored({
    command: fakeCodexPath,
    prompt: 'interrupted monitored call',
    timeoutMs: 60000,
    env: { MODEL_PID_PATH: modelPidPath },
    onSpawn: (child) => {
      const identity = captureSpawnedProcessIdentity(Number(child.pid));
      if (!identity) throw new Error('could not capture monitored child identity');
      new StateManager().update(sessionDir + '/state.json', (state) => {
        state.active_child_pid = child.pid;
        state.active_child_kind = 'codex';
        state.active_child_command = 'interrupted monitored call';
        state.active_child_identity = identity;
        state.active_child_controller_pid = process.pid;
        return state;
      });
    },
    telemetry: {
      sessionDir, ticketId: 'T-SIGKILL', phase: 'implement', ticketAttempt: 4, phaseAttempt: 3, recoveryEpoch: 2,
    },
  });
} else {
  fs.copyFileSync(sessionDir + '/execution-telemetry.json', recoverySnapshotPath);
  const { acquireSupervisorLease, terminateLogicalPipeline } = await import(durableModule);
  const lease = acquireSupervisorLease(sessionDir, { ownerId: 'fixture-replacement', ttlMs: 60000 });
  terminateLogicalPipeline(sessionDir, 'cancelled', { ownerId: lease.owner_id, token: lease.token });
}
`);

  const run = runSupervisedRunner(
    sessionDir,
    'mux-runner.js',
    [countPath, pidPath, modelPidPath, recoverySnapshotPath, fakeCodexPath, durableModule, codexModule,
      stateManagerModule, orphanReaperModule],
    { runnerPath, restartDelayMs: 10 },
  );
  const deadline = Date.now() + 5_000;
  while ((!fs.existsSync(pidPath) || !fs.existsSync(modelPidPath)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(pidPath) && fs.existsSync(modelPidPath), 'monitored model call did not start');
  const killedPid = Number(fs.readFileSync(pidPath, 'utf8'));
  const modelPid = Number(fs.readFileSync(modelPidPath, 'utf8'));
  exactModelIdentity = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')).active_child_identity;
  assert.ok(exactModelIdentity, 'cleanup must bind the exact journaled fake Codex process group');
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.kill(killedPid, 'SIGKILL');
  assert.equal(await run, 130);
  assert.equal(fs.readFileSync(countPath, 'utf8'), '2');
  assert.equal(supervisedRunnerDecision(sessionDir), 'cancelled');
  const reapDeadline = Date.now() + 2_000;
  let modelAlive = true;
  while (modelAlive && Date.now() < reapDeadline) {
    try {
      process.kill(modelPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      modelAlive = false;
    }
  }
  assert.equal(modelAlive, false, 'supervisor did not reap the interrupted model process group');
  const beforeReplacementAction = JSON.parse(fs.readFileSync(recoverySnapshotPath, 'utf8'));
  assert.equal(beforeReplacementAction.events.length, 1);
  assert.equal(beforeReplacementAction.events[0].telemetry_failure, 'executor_interrupted');
  assert.equal(beforeReplacementAction.model_attempts.filter((attempt) => attempt.status === 'started').length, 0);
  const recoveredSummary = executionTelemetrySummary(sessionDir);
  assert.equal(recoveredSummary.unexpectedNoncompletionTermination, false);
  assert.equal(recoveredSummary.ticketAttempts, 1);
  assert.equal(recoveredSummary.phaseAttempts, 1);
  assert.equal(recoveredSummary.failedCalls, 0);
  assert.equal(recoveredSummary.interruptedCalls, 1);
  assert.equal(recoveredSummary.successfulCalls + recoveredSummary.failedCalls + recoveredSummary.interruptedCalls
    + recoveredSummary.timedOutCalls + recoveredSummary.cancelledCalls, recoveredSummary.phaseAttempts);
  assert.ok(recoveredSummary.durationMs > 0);
  assert.equal(recoveredSummary.productiveWork, 0);
  assert.equal(recoveredSummary.discardedWork, 1);
  assert.equal(recoveredSummary.autonomyScore, 1);
  assert.equal(recoveredSummary.reliabilityScore, 1);
  assert.equal(recoveredSummary.qualityScore, 1);
  const telemetry = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8'));
  assert.equal(telemetry.events.length, 1);
  assert.equal(telemetry.model_attempts.filter((attempt) => attempt.status === 'started').length, 0);
  const recoveredState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(recoveredState.active_child_pid, null);
  assert.ok(['reaped', 'not-running'].includes(recoveredState.orphan_recovery.status));
  assert.equal(telemetry.events[0].outcome, 'failed');
  assert.equal(telemetry.events[0].telemetry_status, 'telemetry_unavailable');
  assert.equal(telemetry.events[0].telemetry_failure, 'executor_interrupted');
  assert.equal(telemetry.events[0].input_tokens, null);
  assert.equal(telemetry.events[0].cached_input_tokens, null);
  assert.equal(telemetry.events[0].cache_creation_input_tokens, null);
  assert.equal(telemetry.events[0].output_tokens, null);
  assert.deepEqual(telemetry.events[0].interruption, {
    reason: 'supervised_executor_exit', source_owner_id: `process:${killedPid}`, lease_generation: null,
  });
});

test('pre-publication executor SIGKILL never releases an unregistered model across serial stress', async () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sessionDir = autonomousSession();
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      schema_version: 1, active: true, active_child_pid: null, active_child_identity: null,
    }));
    const fixtureDir = makeTempRoot('pickle-supervised-prepublication-');
    const countPath = path.join(fixtureDir, 'count');
    const executorPidPath = path.join(fixtureDir, 'executor-pid');
    const brokerPidPath = path.join(fixtureDir, 'broker-pid');
    const modelStartedPath = path.join(fixtureDir, 'model-started');
    const fakeCodexPath = path.join(fixtureDir, 'codex');
    fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.MODEL_STARTED_PATH, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const durableModule = new URL('../services/durable-supervisor.js', import.meta.url).href;
    const codexModule = new URL('../services/codex.js', import.meta.url).href;
    const runnerPath = path.join(fixtureDir, 'executor.mjs');
    fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
const [sessionDir, countPath, executorPidPath, brokerPidPath, modelStartedPath, fakeCodexPath, durableModule, codexModule] = process.argv.slice(2);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
if (count === 1) {
  const { runCodexExecMonitored } = await import(codexModule);
  fs.writeFileSync(executorPidPath, String(process.pid));
  await runCodexExecMonitored({
    command: fakeCodexPath,
    prompt: 'must remain gated',
    timeoutMs: 60000,
    env: { MODEL_STARTED_PATH: modelStartedPath },
    onSpawn: (child) => {
      fs.writeFileSync(brokerPidPath, String(child.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    },
    telemetry: { sessionDir, ticketId: 'T-PREPUBLICATION', phase: 'implement', ticketAttempt: 1, phaseAttempt: 1, recoveryEpoch: 1 },
  });
} else {
  const { acquireSupervisorLease, terminateLogicalPipeline } = await import(durableModule);
  const lease = acquireSupervisorLease(sessionDir, { ownerId: 'fixture-replacement', ttlMs: 60000 });
  terminateLogicalPipeline(sessionDir, 'cancelled', { ownerId: lease.owner_id, token: lease.token });
}
`);

    const run = runSupervisedRunner(
      sessionDir,
      'mux-runner.js',
      [countPath, executorPidPath, brokerPidPath, modelStartedPath, fakeCodexPath, durableModule, codexModule],
      { runnerPath, restartDelayMs: 0 },
    );
    const deadline = Date.now() + 5_000;
    while ((!fs.existsSync(executorPidPath) || !fs.existsSync(brokerPidPath)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(fs.existsSync(executorPidPath) && fs.existsSync(brokerPidPath), 'gated broker did not start');
    const executorPid = Number(fs.readFileSync(executorPidPath, 'utf8'));
    const brokerPid = Number(fs.readFileSync(brokerPidPath, 'utf8'));
    process.kill(executorPid, 'SIGKILL');
    assert.equal(await run, 130);
    assert.equal(fs.existsSync(modelStartedPath), false, 'model started before durable ownership publication');
    const brokerDeadline = Date.now() + 2_000;
    let brokerAlive = true;
    while (brokerAlive && Date.now() < brokerDeadline) {
      try {
        process.kill(brokerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        brokerAlive = false;
      }
    }
    assert.equal(brokerAlive, false, `unreleased broker ${brokerPid} survived its controller`);
    assert.equal(fs.readFileSync(countPath, 'utf8'), '2');
  }
});

test('supervisor refuses replacement when a live child has no immutable recovery identity', async () => {
  const sessionDir = autonomousSession();
  const fixtureDir = makeTempRoot('pickle-supervised-ambiguous-orphan-');
  const countPath = path.join(fixtureDir, 'count');
  const runnerPath = path.join(fixtureDir, 'executor.mjs');
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  assert.ok(orphan.pid);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    active: true,
    active_child_pid: orphan.pid,
    active_child_identity: null,
  }));
  fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
const countPath = process.argv[3];
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
process.exit(1);
`);

  try {
    await assert.rejects(
      runSupervisedRunner(sessionDir, 'mux-runner.js', [countPath], { runnerPath, restartDelayMs: 0 }),
      /Session recovery required: live child has no valid immutable spawn identity/,
    );
  } finally {
    try { process.kill(-Number(orphan.pid), 'SIGKILL'); } catch { /* already gone */ }
  }
  assert.equal(fs.readFileSync(countPath, 'utf8'), '1');
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.recovery_required, true);
  assert.equal(state.orphan_recovery.status, 'ambiguous');
  assert.equal(fs.existsSync(path.join(sessionDir, 'execution-telemetry.json')), false);
});

test('production supervisor fatal boundary persists unexpected non-completion and zeroes every score', () => {
  const sessionDir = autonomousSession();
  fs.writeFileSync(path.join(sessionDir, 'logical-pipeline.json'), '{corrupt');
  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'supervised-runner.js'),
    sessionDir,
    '--runner-bin=mux-runner.js',
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 1);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, true);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);
  const telemetry = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8'));
  assert.match(telemetry.unexpected_noncompletion_termination.reason, /supervisor fatal error/);
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.autonomous_owner_recovery_daemon_pid, undefined);
  assert.equal(state.autonomous_owner_recovery_daemon_identity, undefined);
  assert.equal(state.autonomous_owner_spec, undefined);
});

test('green supervisor fatal before handoff acceptance zeroes every score', () => {
  const { sessionDir } = releasedHandoffSession();
  assert.equal(recordSupervisorSignalTermination(sessionDir, 'green fatal before accept', true), true);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, true);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);
});

test('source supervisor intentional exit after accepted handoff is excluded from zero scoring', () => {
  const { sessionDir, requestId } = releasedHandoffSession();
  acceptRuntimeHandoff(sessionDir, requestId, 'green-target', 60_000, targetRuntime);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ last_exit_reason: null, active: true }));
  assert.equal(recordSupervisorSignalTermination(
    sessionDir, 'source retired after green cleared shared state', false, sourceIdentity,
  ), false);
  assert.equal(recordUnexpectedNoncompletionTermination(
    sessionDir, 'old source tmux cleanup after green startup', { consumeExpectedSourceHandoffExit: true },
  ), false);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, false);
  assert.equal(summary.autonomyScore, 1);
  assert.equal(summary.reliabilityScore, 1);
  assert.equal(summary.qualityScore, 1);
});

test('unrelated executor cannot consume the accepted source handoff exemption', () => {
  const { sessionDir, requestId } = releasedHandoffSession();
  acceptRuntimeHandoff(sessionDir, requestId, 'green-target', 60_000, targetRuntime);
  assert.equal(recordSupervisorSignalTermination(sessionDir, 'unrelated fatal', false, unrelatedIdentity), true);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, true);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);
});
