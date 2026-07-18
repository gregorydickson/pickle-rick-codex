// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTicketRecovery } from '../services/recovery-controller.js';

test('recovery ladder escalates from one bounded retry to terminal abort', () => {
  const first = decideTicketRecovery({
    failureKind: 'worker_failure',
    failureMode: 'retry-once',
    attempt: 1,
    maxAttempts: 2,
  });
  const second = decideTicketRecovery({
    failureKind: 'worker_failure',
    failureMode: 'retry-once',
    attempt: 2,
    maxAttempts: 2,
  });

  assert.equal(first.action, 'retry');
  assert.equal(second.action, 'abort');
  assert.equal(second.exitReason, 'error');
});

test('recovery ladder honors execution budgets and an OPEN circuit before retry', () => {
  const budget = decideTicketRecovery({
    failureKind: 'oracle_refusal',
    failureMode: 'retry-once',
    attempt: 1,
    maxAttempts: 2,
    stopReason: 'max_time',
  });
  const circuit = decideTicketRecovery({
    failureKind: 'worker_failure',
    failureMode: 'retry-once',
    attempt: 1,
    maxAttempts: 2,
    circuitOpen: true,
  });

  assert.equal(budget.action, 'abort');
  assert.match(budget.reason, /max_time/);
  assert.deepEqual(circuit, {
    action: 'abort',
    exitReason: 'circuit_open',
    reason: 'circuit breaker is OPEN',
  });
});
