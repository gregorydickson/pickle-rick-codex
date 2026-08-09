// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  beginAutonomousExecution,
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

function autonomousSession() {
  const sessionDir = makeTempRoot('pickle-supervised-runner-');
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

test('supervised runner exits for cooperative logical cancellation', () => {
  const cancelled = autonomousSession();
  const cancelledLease = acquireSupervisorLease(cancelled, { ownerId: 'cancelled-test', ttlMs: 60_000 });
  terminateLogicalPipeline(cancelled, 'cancelled', { ownerId: cancelledLease.owner_id, token: cancelledLease.token });
  assert.equal(supervisedRunnerDecision(cancelled), 'cancelled');
});

test('SIGKILL of an executor is replaced and the logical pipeline still completes', async () => {
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
