// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot } from './helpers.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  assertSupervisorLeaseFence,
  beginAutonomousExecution,
  createLogicalPipeline,
  readLogicalPipeline,
  recordSupervisorCheckpoint,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
  renewSupervisorLease,
  terminateLogicalPipeline,
  watchdogRecoverSupervisor,
} from '../services/durable-supervisor.js';

const blueRuntime = { runtime_id: 'blue', version: '1.0.0', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
const greenRuntime = { runtime_id: 'green', version: '2.0.0', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 2 };

function writeSeal(sessionDir) {
  return writePrdSeal(sessionDir, {
    prd: '# Approved PRD\n',
    sealedAt: '2026-08-08T12:00:00.000Z',
    repository: {
      identity: 'pickle-rick-codex',
      working_directory: '/tmp/pickle-rick-codex',
      execution_base_policy: 'sealed main',
    },
    acceptance_criteria: [{ id: 'AC-03', text: 'Dead executors recover.' }],
    scope_and_ownership: {},
    dependencies_and_external_prerequisites: [],
    risk: [],
    decision_precedence: [],
    preservation_and_rollback: {},
    completion_definition: {},
    release_gates: [],
  });
}

function createAutonomousPipeline(prefix = 'durable-supervisor-') {
  const sessionDir = makeTempRoot(prefix);
  createLogicalPipeline(sessionDir, 'pipeline-1', { nowMs: 1_000 });
  writeSeal(sessionDir);
  beginAutonomousExecution(sessionDir, { nowMs: 2_000 });
  return sessionDir;
}

test('supervisor lease is exclusive, renewable by its token, and recoverable after expiry', () => {
  const sessionDir = createAutonomousPipeline();
  const first = acquireSupervisorLease(sessionDir, { ownerId: 'executor-a', ttlMs: 1_000, nowMs: 3_000 });
  assert.throws(
    () => acquireSupervisorLease(sessionDir, { ownerId: 'executor-b', ttlMs: 1_000, nowMs: 3_500 }),
    /held by executor-a/,
  );

  const renewed = renewSupervisorLease(sessionDir, {
    ownerId: 'executor-a',
    token: first.token,
    ttlMs: 2_000,
    nowMs: 3_500,
  });
  assert.equal(renewed.expires_at, new Date(5_500).toISOString());
  assert.throws(
    () => acquireSupervisorLease(sessionDir, { ownerId: 'executor-b', ttlMs: 1_000, nowMs: 5_499 }),
    /held by executor-a/,
  );
  assert.throws(
    () => recordSupervisorCheckpoint(sessionDir, first.owner_id, first.token, { stale: true }, { nowMs: 5_500 }),
    /Expired supervisor lease/,
  );

  const second = acquireSupervisorLease(sessionDir, { ownerId: 'executor-b', ttlMs: 1_000, nowMs: 5_500 });
  assert.equal(second.generation, 2);
  assert.throws(
    () => renewSupervisorLease(sessionDir, { ownerId: 'executor-a', token: first.token, ttlMs: 1_000, nowMs: 5_501 }),
    /ownership changed/,
  );
});

test('watchdog replaces a killed executor and resumes from the durable journal checkpoint', () => {
  const sessionDir = createAutonomousPipeline('killed-executor-');
  const first = acquireSupervisorLease(sessionDir, { ownerId: 'executor-dead', ttlMs: 60_000, nowMs: 3_000 });
  recordSupervisorCheckpoint(sessionDir, first.owner_id, first.token, {
    ticket_id: 'ticket-7',
    phase: 'implement',
    artifact: 'candidate-42',
  }, { nowMs: 4_000 });

  const result = watchdogRecoverSupervisor(sessionDir, {
    ownerId: 'executor-replacement',
    ttlMs: 60_000,
    nowMs: 5_000,
    executorAlive: (ownerId) => ownerId !== 'executor-dead',
  });

  assert.equal(result.recovered, true);
  assert.equal(result.reason, 'dead_executor');
  assert.equal(result.lease.owner_id, 'executor-replacement');
  assert.equal(result.lease.generation, 2);
  assert.deepEqual(result.resume_checkpoint, {
    ticket_id: 'ticket-7',
    phase: 'implement',
    artifact: 'candidate-42',
  });
  assert.equal(result.state.executor_restart_count, 1);
  assert.deepEqual(result.state.events.slice(-2).map((event) => event.kind), ['executor_lost', 'lease_recovered']);
});

test('normal terminal contract accepts only completed and cancelled and seals the journal', () => {
  const sessionDir = createAutonomousPipeline('terminal-contract-');
  assert.throws(() => terminateLogicalPipeline(sessionDir, 'failed'), /scores are zero/);
  const completed = terminateLogicalPipeline(sessionDir, 'completed', { nowMs: 3_000 });
  assert.equal(completed.terminal_state, 'completed');
  assert.equal(completed.lease, null);
  assert.throws(
    () => acquireSupervisorLease(sessionDir, { ownerId: 'too-late', ttlMs: 1_000, nowMs: 4_000 }),
    /already terminal/,
  );

  const cancelledDir = createAutonomousPipeline('cancelled-contract-');
  assert.equal(terminateLogicalPipeline(cancelledDir, 'cancelled').terminal_state, 'cancelled');
  assert.equal(readLogicalPipeline(cancelledDir).events.at(-1).kind, 'pipeline_cancelled');
});

test('blue-green handoff fences the shadow until release and resumes under one new owner', () => {
  const sessionDir = createAutonomousPipeline('blue-green-');
  const blue = acquireSupervisorLease(sessionDir, { ownerId: 'blue-executor', ttlMs: 5_000, nowMs: 3_000 });
  const checkpoint = { ticket_id: 'ticket-9', phase: 'verification_contract_repair', reuse_phases: ['research', 'plan'] };
  const requestId = requestRuntimeHandoff(sessionDir, blue.owner_id, blue.token, blueRuntime, greenRuntime, checkpoint, { nowMs: 3_100 });
  assert.throws(
    () => acceptRuntimeHandoff(sessionDir, requestId, 'green-executor', 5_000, greenRuntime, { nowMs: 3_200 }),
    /fenced by live owner blue-executor/,
  );
  assert.throws(
    () => requestRuntimeHandoff(sessionDir, blue.owner_id, blue.token, blueRuntime, greenRuntime, checkpoint, { nowMs: 3_300 }),
    /already pending/,
  );

  releaseRuntimeHandoffLease(sessionDir, blue.owner_id, blue.token, requestId, { nowMs: 3_400 });
  assert.throws(() => assertSupervisorLeaseFence(sessionDir, blue.owner_id, blue.token, { nowMs: 3_401 }), /stale ownership/);
  assert.throws(
    () => recordSupervisorCheckpoint(sessionDir, blue.owner_id, blue.token, { stale: true }, { nowMs: 3_401 }),
    /stale ownership/,
  );

  const handoff = acceptRuntimeHandoff(sessionDir, requestId, 'green-executor', 5_000, greenRuntime, { nowMs: 3_500 });
  assert.equal(handoff.lease.owner_id, 'green-executor');
  assert.equal(handoff.lease.generation, 2);
  assert.deepEqual(handoff.resume_checkpoint, checkpoint);
  assert.equal(assertSupervisorLeaseFence(sessionDir, 'green-executor', handoff.lease.token, { nowMs: 3_501 }).generation, 2);
  assert.throws(() => acceptRuntimeHandoff(sessionDir, requestId, 'duplicate', 5_000, greenRuntime, { nowMs: 3_502 }), /already completed/);
  assert.deepEqual(readLogicalPipeline(sessionDir).events.slice(-3).map((event) => event.kind), [
    'runtime_handoff_requested', 'runtime_handoff_released', 'runtime_handoff_completed',
  ]);
});

test('blue-green takeover automatically recovers an expired old executor', () => {
  const sessionDir = createAutonomousPipeline('blue-green-expired-');
  const blue = acquireSupervisorLease(sessionDir, { ownerId: 'blue-executor', ttlMs: 500, nowMs: 3_000 });
  const requestId = requestRuntimeHandoff(sessionDir, blue.owner_id, blue.token, blueRuntime, greenRuntime, { phase: 'review' }, { nowMs: 3_100 });
  const handoff = acceptRuntimeHandoff(sessionDir, requestId, 'green-executor', 5_000, greenRuntime, { nowMs: 3_500 });
  assert.equal(handoff.lease.generation, 2);
  assert.equal(handoff.state.executor_restart_count, 1);
  assert.deepEqual(handoff.state.events.slice(-2).map((event) => event.kind), ['executor_lost', 'runtime_handoff_completed']);
});
