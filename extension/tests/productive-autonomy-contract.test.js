// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTONOMOUS_FAILURE_TYPES,
  beginRecoveryStrategyEpoch,
  classifyAutonomousFailure,
  classifyFailure,
  executionTelemetrySummary,
  nextMaterialApproach,
  planSchedulerContinuity,
  readRecoveryStrategyEpochs,
  recordExecutionTelemetry,
  recoveryRoute,
  resolveAutonomousRecovery,
  recoveryExecutionAction,
  typedRecoveryRoute,
} from '../services/productive-autonomy.js';
import { makeTempRoot } from './helpers.js';

test('typed failures route to domain-specific handlers and minimal checkpoint invalidation', () => {
  assert.equal(classifyFailure({ kind: 'verification_contract' }), 'contract');
  assert.equal(classifyFailure({ kind: 'verification_failed' }), 'verification');
  assert.equal(classifyFailure({ phase: 'review', message: 'changes requested' }), 'review');
  assert.equal(classifyFailure({ phase: 'conformance' }), 'conformance');
  assert.equal(classifyFailure({ kind: 'quality_gate_red' }), 'quality');
  assert.equal(classifyFailure({ kind: 'worker_transport' }), 'infrastructure');

  assert.deepEqual(recoveryRoute('review').preserve, ['context', 'rejected_candidate', 'review_evidence']);
  assert.ok(!recoveryRoute('infrastructure').invalidate.includes('context'));
  assert.equal(recoveryRoute('contract').handler, 'repair_contract');
});

test('every declared autonomous failure has a typed recovery policy', () => {
  assert.equal(AUTONOMOUS_FAILURE_TYPES.length, 12);
  for (const failureType of AUTONOMOUS_FAILURE_TYPES) {
    const route = typedRecoveryRoute(failureType);
    assert.equal(route.failureType, failureType);
    assert.ok(route.handler);
    assert.ok(Array.isArray(route.invalidate));
    assert.ok(Array.isArray(route.preserve));
    assert.ok(recoveryExecutionAction(route));
  }
  assert.equal(classifyAutonomousFailure({ kind: 'verification_contract' }), 'contract_invalid');
  assert.equal(classifyAutonomousFailure({ kind: 'worker_transport' }), 'worker_transport');
  assert.equal(classifyAutonomousFailure({ kind: 'workspace_unsafe' }), 'workspace_unsafe');
  assert.equal(typedRecoveryRoute('prd_contract_defect').schedulerState, 'prd_revision_required');
  assert.equal(resolveAutonomousRecovery({ kind: 'artifact_invalid' }).handler, 'repair_artifact');
  assert.equal(resolveAutonomousRecovery({ kind: 'implementation_invalid' }).handler, 'repair_implementation');
  assert.equal(resolveAutonomousRecovery({ kind: 'completion_evidence_refused' }).handler, 'repair_completion_evidence');
  assert.equal(resolveAutonomousRecovery({ kind: 'workspace_unsafe' }).handler, 'reconstruct_workspace');
  assert.equal(resolveAutonomousRecovery({ kind: 'prd_contract_defect' }).handler, 'request_prd_revision');
  assert.notDeepEqual(
    typedRecoveryRoute('verification_failed').invalidate,
    typedRecoveryRoute('worker_transport').invalidate,
  );
});

test('strategy epochs reject consecutive identity and produce three materially distinct approaches', () => {
  const sessionDir = makeTempRoot('pickle-strategy-');
  const base = {
    ticketId: 'r1',
    domain: 'review',
    handler: 'remediate_candidate',
    checkpoint: 'implement',
    constraints: ['review refused'],
  };
  const first = beginRecoveryStrategyEpoch(sessionDir, {
    ...base,
    materialApproach: nextMaterialApproach('review', 0),
  }, 'failure');
  assert.throws(() => beginRecoveryStrategyEpoch(sessionDir, {
    ...base,
    materialApproach: nextMaterialApproach('review', 0),
  }, 'retry_threshold'), /recovery-strategy-not-novel/);
  const second = beginRecoveryStrategyEpoch(sessionDir, {
    ...base,
    materialApproach: nextMaterialApproach('review', 1),
  }, 'retry_threshold');
  const third = beginRecoveryStrategyEpoch(sessionDir, {
    ...base,
    materialApproach: nextMaterialApproach('review', 2),
  }, 'circuit_threshold');

  assert.equal(new Set([first.strategyHash, second.strategyHash, third.strategyHash]).size, 3);
  assert.equal(readRecoveryStrategyEpochs(sessionDir).length, 3);
});

test('scheduler continues independent work and emits diagnostic work when all tickets repair', () => {
  const tickets = [
    { id: 'a', status: 'In Progress', depends_on: [] },
    { id: 'b', status: 'Todo', depends_on: [] },
    { id: 'c', status: 'Todo', depends_on: ['a'] },
  ];
  assert.deepEqual(planSchedulerContinuity(tickets, new Set(['a'])), { kind: 'ticket', ticketId: 'b' });
  assert.deepEqual(
    planSchedulerContinuity(tickets, new Set(['a', 'b', 'c'])),
    { kind: 'diagnostic', ticketId: 'a', task: 'diagnose-and-select-material-repair-strategy' },
  );
});

test('telemetry includes failed calls and separates attempts, epochs, and discarded work', () => {
  const sessionDir = makeTempRoot('pickle-telemetry-');
  recordExecutionTelemetry(sessionDir, {
    ticket_id: 'r1', phase: 'implement', ticket_attempt: 1, phase_attempt: 1,
    recovery_epoch: 0, strategy_hash: null, outcome: 'failed', duration_ms: 400,
    input_tokens: 20, cached_input_tokens: 5, output_tokens: 10, productive_work: 0, discarded_work: 3,
  });
  recordExecutionTelemetry(sessionDir, {
    ticket_id: 'r1', phase: 'implement', ticket_attempt: 2, phase_attempt: 2,
    recovery_epoch: 1, strategy_hash: 'a'.repeat(64), outcome: 'success', duration_ms: 600,
    input_tokens: 15, cached_input_tokens: 4, output_tokens: 9, productive_work: 4, discarded_work: 0,
  });
  const summary = executionTelemetrySummary(sessionDir);
  assert.deepEqual(summary, {
    ticketAttempts: 2,
    phaseAttempts: 2,
    recoveryEpochs: 1,
    failedCalls: 1,
    successfulCalls: 1,
    timedOutCalls: 0,
    cancelledCalls: 0,
    durationMs: 1000,
    inputTokens: 35,
    cachedInputTokens: 9,
    cacheCreationInputTokens: 0,
    outputTokens: 19,
    productiveWork: 4,
    discardedWork: 3,
    executorRestarts: 0,
    checkpointsReused: 0,
    checkpointsInvalidated: 0,
    postSealHumanInterventions: 0,
    unexpectedTerminalExits: 0,
    autonomyScore: 1,
    reliabilityScore: 1,
  });
});
