// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  beginAutonomousExecution,
  acquireSupervisorLease,
  createLogicalPipeline,
  requestPrdRevision,
  terminateLogicalPipeline,
} from '../services/durable-supervisor.js';
import { runSupervisedRunner, supervisedRunnerDecision } from '../bin/supervised-runner.js';

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
});
