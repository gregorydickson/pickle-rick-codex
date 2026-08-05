// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import {
  buildTicketRecoveryFailureIdentity,
  decideTicketRecovery,
  recordTicketRecoveryFailure,
} from '../services/recovery-controller.js';

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

test('adaptive recovery continues changed lineages and stops only after verified unchanged exhaustion', () => {
  const changed = decideTicketRecovery({
    failureKind: 'worker_failure',
    failureMode: 'retry',
    attempt: 20,
    maxAttempts: Number.POSITIVE_INFINITY,
    adaptiveExhausted: false,
  });
  const exhausted = decideTicketRecovery({
    failureKind: 'worker_failure',
    failureMode: 'retry',
    attempt: 21,
    maxAttempts: Number.POSITIVE_INFINITY,
    adaptiveExhausted: true,
  });

  assert.equal(changed.action, 'retry');
  assert.equal(exhausted.action, 'abort');
  assert.equal(exhausted.exitReason, 'circuit_open');
});

test('ticket recovery history persists changed and unchanged refusal lineages across calls', () => {
  const sessionDir = makeTempRoot('pickle-ticket-recovery-');
  const firstIdentity = buildTicketRecoveryFailureIdentity({
    failureKind: 'worker_failure',
    message: 'worker-lifecycle-refusal',
    phase: 'review',
    artifact: { verdict: 'changes_requested', findings: ['first blocker'] },
    evidencePath: '/evidence/1.json',
  });
  const secondIdentity = buildTicketRecoveryFailureIdentity({
    failureKind: 'worker_failure',
    message: 'worker-lifecycle-refusal',
    phase: 'review',
    artifact: { verdict: 'changes_requested', findings: ['second blocker'] },
    evidencePath: '/evidence/2.json',
  });

  const first = recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: firstIdentity });
  const changed = recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: secondIdentity });
  const unchanged = recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: secondIdentity });

  assert.equal(first.changed_lineage, true);
  assert.equal(changed.changed_lineage, true);
  assert.equal(unchanged.changed_lineage, false);
  assert.equal(unchanged.consecutive_same_lineage, 2);
  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.deepEqual(persisted.events.map((event) => event.sequence), [1, 2, 3]);
});

test('ticket recovery history fails closed instead of resetting corrupt state', () => {
  const sessionDir = makeTempRoot('pickle-ticket-recovery-corrupt-');
  fs.writeFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), '{broken');
  const identity = buildTicketRecoveryFailureIdentity({
    failureKind: 'worker_failure',
    message: 'same failure',
  });
  assert.throws(
    () => recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity }),
    /ticket-recovery-corrupt/,
  );
});
