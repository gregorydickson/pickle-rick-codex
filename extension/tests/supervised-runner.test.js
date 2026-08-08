// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { executionTelemetrySummary } from '../services/productive-autonomy.js';

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

function releasedHandoffSession() {
  const sessionDir = autonomousSession();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ last_exit_reason: 'runtime_handoff' }));
  const lease = acquireSupervisorLease(sessionDir, { ownerId: 'blue-source', ttlMs: 60_000 });
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
  const fixtureDir = makeTempRoot('pickle-supervised-executor-');
  const countPath = path.join(fixtureDir, 'count');
  const pidPath = path.join(fixtureDir, 'pid');
  const durableModule = new URL('../services/durable-supervisor.js', import.meta.url).href;
  const runnerPath = path.join(fixtureDir, 'executor.mjs');
  fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
const [sessionDir, countPath, pidPath, durableModule] = process.argv.slice(2);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
if (count === 1) {
  fs.writeFileSync(pidPath, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const { acquireSupervisorLease, terminateLogicalPipeline } = await import(durableModule);
  const lease = acquireSupervisorLease(sessionDir, { ownerId: 'fixture-replacement', ttlMs: 60000 });
  terminateLogicalPipeline(sessionDir, 'cancelled', { ownerId: lease.owner_id, token: lease.token });
}
`);

  const run = runSupervisedRunner(
    sessionDir,
    'mux-runner.js',
    [countPath, pidPath, durableModule],
    { runnerPath, restartDelayMs: 10 },
  );
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(pidPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(pidPath), 'first executor did not start');
  process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGKILL');
  assert.equal(await run, 130);
  assert.equal(fs.readFileSync(countPath, 'utf8'), '2');
  assert.equal(supervisedRunnerDecision(sessionDir), 'cancelled');
  const recoveredSummary = executionTelemetrySummary(sessionDir);
  assert.equal(recoveredSummary.unexpectedNoncompletionTermination, false);
  assert.equal(recoveredSummary.autonomyScore, 1);
  assert.equal(recoveredSummary.reliabilityScore, 1);
  assert.equal(recoveredSummary.qualityScore, 1);
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
  assert.equal(recordSupervisorSignalTermination(sessionDir, 'source retired after release', false), false);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, false);
  assert.equal(summary.autonomyScore, 1);
  assert.equal(summary.reliabilityScore, 1);
  assert.equal(summary.qualityScore, 1);
});
