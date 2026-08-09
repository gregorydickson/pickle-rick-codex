// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUTONOMOUS_FAILURE_TYPES,
  beginRecoveryStrategyEpoch,
  classifyAutonomousFailure,
  classifyFailure,
  executionTelemetrySummary,
  materialStrategyHash,
  nextMaterialApproach,
  nextMaterialRecoveryPlan,
  planSchedulerContinuity,
  reconcileInterruptedModelCallTelemetry,
  readRecoveryStrategyEpochs,
  readUnresolvedRecoveryStrategyEpochs,
  recordRecoveryStrategyProgress,
  recordExecutionControlTelemetry,
  recordExecutionTelemetry,
  reserveModelCallTelemetry,
  finalizeModelCallTelemetry,
  recordUnexpectedNoncompletionTermination,
  recoveryRoute,
  resolveAutonomousRecovery,
  recoveryExecutionAction,
  typedRecoveryRoute,
} from '../services/productive-autonomy.js';
import { makeTempRoot, repoRoot } from './helpers.js';

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
    assert.equal(recoveryExecutionAction(route), route.handler);
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

test('explicit artifact failures outrank review and conformance phase fallbacks', () => {
  const expectedInvalidate = ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'];
  for (const phase of ['review', 'conformance']) {
    for (const input of [
      { kind: 'artifact_invalid', phase },
      { kind: 'worker_failure', phase, message: `worker-lifecycle-invalid-artifact: ${phase} exhausted bounded artifact recovery` },
      { kind: 'worker_failure', phase, message: `worker-lifecycle-missing-artifact: ${phase} did not write its artifact` },
    ]) {
      assert.equal(classifyAutonomousFailure(input), 'artifact_invalid');
      const route = resolveAutonomousRecovery(input);
      assert.equal(route.failureType, 'artifact_invalid');
      assert.equal(route.handler, 'repair_artifact');
      assert.deepEqual(route.invalidate, expectedInvalidate);
      assert.deepEqual(route.preserve, ['context', 'invalid_artifact_evidence']);
    }
  }
});

test('every explicit typed failure kind outranks lifecycle phase fallbacks', () => {
  for (const failureType of AUTONOMOUS_FAILURE_TYPES) {
    for (const phase of ['review', 'conformance']) {
      assert.equal(classifyAutonomousFailure({ kind: failureType, phase }), failureType);
    }
  }
});

test('every injected recoverable failure remains autonomous after the PRD seal', () => {
  const recoverable = AUTONOMOUS_FAILURE_TYPES.filter((failureType) => (
    typedRecoveryRoute(failureType).schedulerState === 'repairing'
  ));
  assert.deepEqual(recoverable, AUTONOMOUS_FAILURE_TYPES.filter((failureType) => failureType !== 'prd_contract_defect'));

  for (const failureType of recoverable) {
    const sessionDir = makeTempRoot(`pickle-autonomy-${failureType}-`);
    const injected = resolveAutonomousRecovery({ kind: failureType });
    assert.equal(injected.failureType, failureType, `${failureType} classification drifted`);
    assert.equal(injected.schedulerState, 'repairing', `${failureType} requested a human`);
    recordExecutionControlTelemetry(sessionDir, { checkpoints_invalidated: injected.invalidate.length });
    const summary = executionTelemetrySummary(sessionDir);
    assert.equal(summary.postSealHumanInterventions, 0, `${failureType} recorded a human intervention`);
    assert.equal(summary.autonomyScore, 1, `${failureType} broke autonomous recovery`);
  }

  const sealSource = fs.readFileSync(path.join(repoRoot, 'src/services/session-prd-seal.ts'), 'utf8');
  const increments = sealSource.match(/post_seal_human_interventions:\s*1/g) || [];
  assert.equal(increments.length, 1, 'production may increment the counter only at the explicit approval boundary');
  const approvalBoundary = sealSource.slice(sealSource.indexOf('export function approveSessionPrdRevision'));
  assert.match(approvalBoundary, /recordExecutionControlTelemetry\(sessionDir, \{ post_seal_human_interventions: 1 \}\)/);
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

test('strategy epochs reject A-B-A reuse across restart until verified progress resets the lineage', () => {
  const sessionDir = makeTempRoot('pickle-strategy-lineage-');
  const base = {
    ticketId: 'r1', domain: 'review', handler: 'remediate_candidate', checkpoint: 'implement',
    constraints: ['same unresolved refusal'],
  };
  const strategyA = { ...base, materialApproach: 'approach-a' };
  const strategyB = { ...base, materialApproach: 'approach-b' };
  const firstA = beginRecoveryStrategyEpoch(sessionDir, strategyA, 'failure');
  beginRecoveryStrategyEpoch(sessionDir, strategyB, 'retry_threshold');

  beginRecoveryStrategyEpoch(sessionDir, { ...strategyA, ticketId: 'r2' }, 'failure');
  recordRecoveryStrategyProgress(sessionDir, 'r2', 'unrelated ticket completed');

  assert.throws(
    () => beginRecoveryStrategyEpoch(sessionDir, strategyA, 'circuit_threshold'),
    new RegExp(`reused unresolved strategy ${firstA.strategyHash}`),
  );
  assert.deepEqual(readUnresolvedRecoveryStrategyEpochs(sessionDir, 'r1').map((epoch) => epoch.strategyHash), [
    firstA.strategyHash,
    materialStrategyHash(strategyB),
  ]);

  const progress = recordRecoveryStrategyProgress(sessionDir, 'r1', 'ticket completed after deterministic verification');
  assert.equal(progress?.afterEpochSequence, 2);
  assert.deepEqual(readUnresolvedRecoveryStrategyEpochs(sessionDir, 'r1'), []);
  const reusedA = beginRecoveryStrategyEpoch(sessionDir, strategyA, 'failure');
  assert.equal(reusedA.strategyHash, firstA.strategyHash);

  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'recovery-strategies.json'), 'utf8'));
  assert.deepEqual(persisted.progress.map((event) => event.ticketId), ['r2', 'r1']);
  assert.equal(readRecoveryStrategyEpochs(sessionDir).length, 4);
});

test('strategy exhaustion escalates through contract repair and durable diagnostics without hash reuse', () => {
  const sessionDir = makeTempRoot('pickle-strategy-escalation-');
  const route = typedRecoveryRoute('review_refused');
  const epochs = [];
  for (let index = 0; index < 7; index += 1) {
    const plan = nextMaterialRecoveryPlan(route, epochs);
    const epoch = beginRecoveryStrategyEpoch(sessionDir, {
      ticketId: 'r1', domain: plan.route.domain, handler: plan.route.handler,
      checkpoint: plan.route.invalidate[0] || 'executor', inputHashes: plan.inputHashes,
      constraints: ['unchanged review refusal'], materialApproach: plan.materialApproach,
    }, 'circuit_threshold');
    epochs.push(epoch);
  }

  assert.deepEqual(epochs.slice(0, 3).map((epoch) => epoch.materialApproach), [
    'apply-review-findings-to-candidate',
    'reduce-diff-and-reverify',
    'reconstruct-candidate-from-approved-context',
  ]);
  assert.equal(epochs[3].handler, 'repair_contract');
  assert.equal(epochs[3].domain, 'contract');
  assert.match(epochs[4].materialApproach, /diagnose-cross-phase-causal-gap/);
  assert.match(epochs[6].materialApproach, /6-unresolved-epochs/);
  assert.equal(new Set(epochs.map((epoch) => epoch.strategyHash)).size, epochs.length);
  assert.deepEqual(readUnresolvedRecoveryStrategyEpochs(sessionDir, 'r1'), epochs);
});

test('strategy progress history fails closed when a persisted reset boundary is corrupt', () => {
  const sessionDir = makeTempRoot('pickle-strategy-corrupt-progress-');
  beginRecoveryStrategyEpoch(sessionDir, {
    ticketId: 'r1', domain: 'review', handler: 'remediate_candidate', checkpoint: 'implement',
    constraints: ['refusal'], materialApproach: 'approach-a',
  }, 'failure');
  const journalPath = path.join(sessionDir, 'recovery-strategies.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.progress = [{
    sequence: 1, ticketId: 'r1', afterEpochSequence: 99, evidence: 'invented progress',
    recordedAt: new Date().toISOString(),
  }];
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => readRecoveryStrategyEpochs(sessionDir), /recovery-strategy-corrupt/);
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
    interruptedCalls: 0,
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
    qualityScore: 1,
    unexpectedNoncompletionTermination: false,
  });
});

test('executor recovery atomically finalizes orphaned model attempts with honest unavailable usage', () => {
  const sessionDir = makeTempRoot('pickle-interrupted-telemetry-');
  const reservation = reserveModelCallTelemetry(sessionDir, {
    ticketId: 'r1', phase: 'implement', ticketAttempt: 3, phaseAttempt: 2, recoveryEpoch: 1,
  });
  const journalPath = path.join(sessionDir, 'execution-telemetry.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.model_attempts[0].started_at = '2026-08-08T20:00:00.000Z';
  fs.writeFileSync(journalPath, JSON.stringify(journal));

  const reconciled = reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason: 'dead_executor', sourceOwnerId: 'runner:41:old', leaseGeneration: 7,
    now: new Date('2026-08-08T20:00:05.250Z'),
  });
  assert.equal(reconciled.length, 1);
  assert.deepEqual(reconciled[0], {
    sequence: 1,
    model_attempt_id: reservation.model_attempt_id,
    ticket_id: 'r1',
    phase: 'implement',
    ticket_attempt: 3,
    phase_attempt: 2,
    recovery_epoch: 1,
    strategy_hash: null,
    outcome: 'failed',
    telemetry_status: 'telemetry_unavailable',
    telemetry_failure: 'executor_interrupted',
    duration_ms: 5_250,
    input_tokens: null,
    cached_input_tokens: null,
    cache_creation_input_tokens: null,
    output_tokens: null,
    productive_work: 0,
    discarded_work: 1,
    interruption: { reason: 'dead_executor', source_owner_id: 'runner:41:old', lease_generation: 7 },
    recorded_at: '2026-08-08T20:00:05.250Z',
  });
  assert.deepEqual(reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason: 'dead_executor', sourceOwnerId: 'runner:41:old', leaseGeneration: 7,
    now: new Date('2026-08-08T20:00:06.000Z'),
  }), []);

  const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.model_attempts[0].status, 'finalized');
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.ticketAttempts, 1);
  assert.equal(summary.phaseAttempts, 1);
  assert.equal(summary.failedCalls, 0);
  assert.equal(summary.interruptedCalls, 1);
  assert.equal(summary.successfulCalls + summary.failedCalls + summary.interruptedCalls
    + summary.timedOutCalls + summary.cancelledCalls, summary.phaseAttempts);
  assert.equal(summary.durationMs, 5_250);
  assert.equal(summary.inputTokens, 0);
  assert.equal(summary.outputTokens, 0);
  assert.equal(summary.productiveWork, 0);
  assert.equal(summary.discardedWork, 1);
});

test('model finalization and executor recovery races cannot duplicate an attempt', () => {
  const sessionDir = makeTempRoot('pickle-telemetry-finalizer-race-');
  const result = {
    command: 'codex', args: [], exitCode: 0, stdout: '', stderr: '', timedOut: false,
    durationMs: 25, lastMessage: '', usage: {
      input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1,
    }, usageReported: true, terminatedAfterSuccess: false, cancelled: false,
    outputFormat: 'jsonl', assistantContent: '', toolCalls: [],
  };
  const finalizedFirst = reserveModelCallTelemetry(sessionDir, { ticketId: 'r1', phase: 'research' });
  finalizeModelCallTelemetry(sessionDir, finalizedFirst, { result });
  assert.deepEqual(reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason: 'supervised_executor_exit', now: new Date(),
  }), []);

  const recoveredFirst = reserveModelCallTelemetry(sessionDir, { ticketId: 'r1', phase: 'plan' });
  reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason: 'supervised_executor_exit', sourceOwnerId: 'process:42', now: new Date(),
  });
  assert.throws(
    () => finalizeModelCallTelemetry(sessionDir, recoveredFirst, { result }),
    /model-call-telemetry-reservation-finalized/,
  );
  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8'));
  assert.equal(persisted.events.length, 2);
  assert.deepEqual(persisted.events.map((event) => event.model_attempt_id), [1, 2]);
});

test('telemetry recovery creates a missing journal but classifies persisted corruption as fatal', () => {
  const absent = makeTempRoot('pickle-telemetry-absent-recovery-');
  assert.deepEqual(reconcileInterruptedModelCallTelemetry(absent, {
    reason: 'supervised_executor_exit', now: new Date('2026-08-08T20:00:00.000Z'),
  }), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(absent, 'execution-telemetry.json'), 'utf8')), {
    schema_version: 1, events: [], model_attempts: [], next_model_attempt_id: 1,
  });

  const corrupt = makeTempRoot('pickle-telemetry-corrupt-recovery-');
  fs.writeFileSync(path.join(corrupt, 'execution-telemetry.json'), '{broken');
  assert.throws(
    () => reconcileInterruptedModelCallTelemetry(corrupt, {
      reason: 'dead_executor', sourceOwnerId: 'runner:99:dead', now: new Date(),
    }),
    (error) => error?.code === 'EXECUTION_TELEMETRY_CORRUPT',
  );
  assert.equal(fs.readFileSync(path.join(corrupt, 'execution-telemetry.json'), 'utf8'), '{broken');
  const corruption = JSON.parse(fs.readFileSync(path.join(corrupt, 'execution-telemetry-corruption.json'), 'utf8'));
  assert.equal(corruption.schema_version, 1);
  assert.match(corruption.reason, /execution-telemetry-corrupt/);
  const summary = executionTelemetrySummary(corrupt);
  assert.equal(summary.unexpectedNoncompletionTermination, true);
  assert.equal(summary.unexpectedTerminalExits, 1);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);

  const malformedShape = makeTempRoot('pickle-telemetry-malformed-shape-recovery-');
  fs.writeFileSync(path.join(malformedShape, 'execution-telemetry.json'), JSON.stringify({
    schema_version: 1, events: 'not-an-array',
  }));
  assert.throws(
    () => reconcileInterruptedModelCallTelemetry(malformedShape, {
      reason: 'expired_lease', sourceOwnerId: 'runner:100:dead', leaseGeneration: 2, now: new Date(),
    }),
    (error) => error?.code === 'EXECUTION_TELEMETRY_CORRUPT',
  );
  assert.equal(executionTelemetrySummary(malformedShape).reliabilityScore, 0);
});

test('unexpected non-completion persistently zeroes autonomy, reliability, and quality', () => {
  const sessionDir = makeTempRoot('pickle-zero-rule-');
  assert.equal(recordUnexpectedNoncompletionTermination(sessionDir, 'supervisor crashed'), true);
  assert.equal(recordUnexpectedNoncompletionTermination(sessionDir, 'duplicate boundary'), false);
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedTerminalExits, 1);
  assert.equal(summary.unexpectedNoncompletionTermination, true);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);
});

test('legacy unexpected-terminal counter alone applies the same three-score zero rule', () => {
  const sessionDir = makeTempRoot('pickle-zero-rule-counter-');
  recordExecutionControlTelemetry(sessionDir, { unexpected_terminal_exits: 1 });
  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.unexpectedNoncompletionTermination, false);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
  assert.equal(summary.qualityScore, 0);
});

test('completed and explicitly cancelled durable terminals are excluded from zero scoring', () => {
  for (const terminalState of ['completed', 'cancelled']) {
    const sessionDir = makeTempRoot(`pickle-zero-rule-${terminalState}-`);
    fs.writeFileSync(path.join(sessionDir, 'logical-pipeline.json'), JSON.stringify({ terminal_state: terminalState }));
    assert.equal(recordUnexpectedNoncompletionTermination(sessionDir, 'late supervisor signal'), false);
    const summary = executionTelemetrySummary(sessionDir);
    assert.equal(summary.unexpectedNoncompletionTermination, false);
    assert.equal(summary.autonomyScore, 1);
    assert.equal(summary.reliabilityScore, 1);
    assert.equal(summary.qualityScore, 1);
  }
});
