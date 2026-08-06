// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import {
  authorizeTicketRecoveryEpoch,
  buildTicketRecoveryFailureIdentity,
  decideTicketRecovery,
  getTicketRecoveryLineageOccurrences,
  getTicketRecoveryUsage,
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
  assert.equal(unchanged.lineage_occurrences, 2);
  assert.equal(unchanged.ticket_failure_count, 3);
  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.deepEqual(persisted.events.map((event) => event.sequence), [1, 2, 3]);
});

test('ticket recovery usage survives interleaved lineages and legacy events', () => {
  const sessionDir = makeTempRoot('pickle-ticket-recovery-interleaved-');
  const identityA = buildTicketRecoveryFailureIdentity({ failureKind: 'worker_failure', message: 'failure A' });
  const identityB = buildTicketRecoveryFailureIdentity({ failureKind: 'worker_failure', message: 'failure B' });

  const firstA = recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: identityA });
  recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: identityB });
  const secondA = recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity: identityA });

  assert.equal(firstA.lineage_occurrences, 1);
  assert.equal(secondA.changed_lineage, true);
  assert.equal(secondA.consecutive_same_lineage, 1);
  assert.equal(secondA.lineage_occurrences, 2);
  assert.equal(secondA.ticket_failure_count, 3);

  const historyPath = path.join(sessionDir, 'ticket-recovery-history.json');
  const persisted = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  for (const event of persisted.events) {
    delete event.lineage_occurrences;
    delete event.ticket_failure_count;
  }
  fs.writeFileSync(historyPath, `${JSON.stringify(persisted, null, 2)}\n`);
  assert.deepEqual(getTicketRecoveryUsage(sessionDir, 'r1'), {
    ticketFailureCount: 3,
    maxLineageOccurrences: 2,
  });
});

test('explicit retry starts a new bounded epoch without deleting recovery history', () => {
  const sessionDir = makeTempRoot('pickle-ticket-recovery-epoch-');
  const identity = buildTicketRecoveryFailureIdentity({ failureKind: 'worker_failure', message: 'failure' });
  recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity });
  recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity });
  assert.equal(getTicketRecoveryUsage(sessionDir, 'r1').ticketFailureCount, 2);

  const authorization = authorizeTicketRecoveryEpoch(sessionDir, 'r1');
  assert.equal(authorization.start_after_event, 2);
  assert.deepEqual(getTicketRecoveryUsage(sessionDir, 'r1'), {
    ticketFailureCount: 0,
    maxLineageOccurrences: 0,
  });
  const postAuthorization = recordTicketRecoveryFailure({
    sessionDir,
    ticketId: 'r1',
    failureKind: 'worker_failure',
    identity,
  });
  assert.equal(postAuthorization.ticket_failure_count, 3, 'persisted journal counter remains lifetime-monotonic');
  assert.equal(getTicketRecoveryUsage(sessionDir, 'r1').ticketFailureCount, 1);
  assert.equal(getTicketRecoveryLineageOccurrences(sessionDir, 'r1', identity.signature), 1);
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.equal(history.events.length, 3);
});

test('ticket recovery history rejects regressing durable budget counters', () => {
  const sessionDir = makeTempRoot('pickle-ticket-recovery-budget-corrupt-');
  const identity = buildTicketRecoveryFailureIdentity({ failureKind: 'worker_failure', message: 'same failure' });
  recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity });
  const historyPath = path.join(sessionDir, 'ticket-recovery-history.json');
  const persisted = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  persisted.events[0].ticket_failure_count = 2;
  fs.writeFileSync(historyPath, `${JSON.stringify(persisted, null, 2)}\n`);
  assert.throws(() => getTicketRecoveryUsage(sessionDir, 'r1'), /recovery counters regress/);
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
