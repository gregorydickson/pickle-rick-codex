// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  abandonPlannedExperiment,
  archiveExperimentDiff,
  assertExperimentFamilyShift,
  assertExperimentStrategy,
  compactExperimentMemory,
  completeExperiment,
  createExperimentLedger,
  normalizeExperimentHypothesis,
  planExperiment,
  readExperimentLedger,
  reconcileRunningExperiments,
  recordWorkerAttemptFailure,
  researchConvergenceState,
  startExperiment,
  updateExperimentPlan,
  validateExperimentFamilyShift,
  validateExperimentStrategy,
  writeExperimentLedger,
} from '../services/experiment-ledger.js';
import { makeTempRoot } from './helpers.js';

const T0 = '2026-01-01T00:00:00.000Z';

function plan(sessionDir, hypothesis, extra = {}) {
  return planExperiment(sessionDir, {
    hypothesis,
    rationale: `Evidence for ${hypothesis}`,
    baselineScore: 73.72,
    targetPaths: ['extension/tests/example.test.js'],
    ...extra,
  }, { now: T0 });
}

test('experiment ledger persists planned, running, and accepted evidence across resume', () => {
  const sessionDir = makeTempRoot('pickle-experiment-ledger-');
  const planned = plan(sessionDir, 'Cover setup-session branches', {
    hypothesisFamily: 'coverage/setup-session',
  });
  assert.equal(planned.id, 'exp-0001');
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.target_paths, ['extension/tests/example.test.js']);

  const running = startExperiment(sessionDir, planned.id, { now: '2026-01-01T00:01:00.000Z' });
  assert.equal(running.status, 'running');

  const artifact = archiveExperimentDiff(sessionDir, planned.id, 'diff --git a/test b/test\n');
  const accepted = completeExperiment(sessionDir, planned.id, {
    status: 'accepted',
    classification: 'improved',
    resultScore: 75.1,
    changedPaths: ['extension/tests/setup-session.test.js'],
    diffArtifact: artifact,
    insight: 'CLI parsing branches are deterministic.',
    verification: ['npm run test:fast'],
  }, { now: '2026-01-01T00:02:00.000Z' });

  assert.equal(accepted.result_score, 75.1);
  assert.equal(accepted.diff_artifact, 'experiments/exp-0001.patch');
  assert.equal(fs.readFileSync(path.join(sessionDir, artifact), 'utf8'), 'diff --git a/test b/test\n');
  const resumed = readExperimentLedger(sessionDir);
  assert.equal(resumed.experiments[0].insight, 'CLI parsing branches are deterministic.');
  assert.equal(resumed.experiment_stall_count, 0);
  assert.equal(resumed.worker_failure_count, 0);
  assert.equal(plan(sessionDir, 'Cover a second subsystem').id, 'exp-0002');
  assert.deepEqual(fs.readdirSync(sessionDir).filter((name) => name.includes('.tmp.')), []);
});

test('normalized duplicate hypotheses require a material differentiator', () => {
  const sessionDir = makeTempRoot('pickle-experiment-duplicates-');
  plan(sessionDir, 'Add deterministic setup-session branch tests!');
  assert.equal(
    normalizeExperimentHypothesis('  ADD deterministic setup–session branch tests '),
    'add deterministic setup session branch tests',
  );
  assert.throws(
    () => plan(sessionDir, 'add deterministic setup session branch tests'),
    /requires an explicit differentiator|Duplicate experiment hypothesis/,
  );
  const differentiated = plan(sessionDir, 'add deterministic setup session branch tests', {
    differentiator: 'exercise malformed config input',
  });
  assert.equal(differentiated.id, 'exp-0002');
  assert.throws(
    () => plan(sessionDir, 'ADD deterministic setup session branch tests', {
      differentiator: 'Exercise malformed-config input',
    }),
    /Duplicate experiment hypothesis/,
  );
});

test('a running placeholder can adopt the worker-persisted experiment plan', () => {
  const sessionDir = makeTempRoot('pickle-experiment-worker-plan-');
  const record = plan(sessionDir, 'Runtime placeholder iteration 1', { differentiator: 'iteration 1' });
  startExperiment(sessionDir, record.id);
  const updated = updateExperimentPlan(sessionDir, record.id, {
    hypothesis: 'Cover prompt builder branches',
    hypothesisFamily: 'coverage/prompts',
    rationale: 'Prompt builders are deterministic and substantially uncovered.',
    targetPaths: ['extension/tests/prompts.test.js'],
  });
  assert.equal(updated.status, 'running');
  assert.equal(updated.hypothesis, 'Cover prompt builder branches');
  assert.equal(updated.hypothesis_family, 'coverage/prompts');
});

test('worker failures and valid experiment stalls update separate counters', () => {
  const sessionDir = makeTempRoot('pickle-experiment-counters-');
  const incomplete = plan(sessionDir, 'First worker attempt');
  startExperiment(sessionDir, incomplete.id);
  completeExperiment(sessionDir, incomplete.id, {
    status: 'invalid',
    classification: 'worker_incomplete',
    insight: 'No authoritative completion evidence.',
  });
  let ledger = readExperimentLedger(sessionDir);
  assert.equal(ledger.worker_failure_count, 1);
  assert.equal(ledger.experiment_stall_count, 0);

  const timeout = plan(sessionDir, 'Second worker attempt');
  startExperiment(sessionDir, timeout.id);
  completeExperiment(sessionDir, timeout.id, {
    status: 'invalid',
    classification: 'worker_timeout',
  });
  ledger = readExperimentLedger(sessionDir);
  assert.equal(ledger.worker_failure_count, 2);
  assert.equal(ledger.experiment_stall_count, 0);

  const held = plan(sessionDir, 'Completed non-improving experiment');
  startExperiment(sessionDir, held.id);
  completeExperiment(sessionDir, held.id, {
    status: 'rejected',
    classification: 'held',
    resultScore: 73.72,
    changedPaths: ['extension/tests/example.test.js'],
    insight: 'The branch was already covered.',
  });
  ledger = readExperimentLedger(sessionDir);
  assert.equal(ledger.worker_failure_count, 0);
  assert.equal(ledger.experiment_stall_count, 1);
  assert.equal(compactExperimentMemory(ledger).invalid.length, 2);
  assert.equal(compactExperimentMemory(ledger).rejected.length, 1);
});

test('worker retries retain one scientific experiment id and preserve attempt evidence', () => {
  const sessionDir = makeTempRoot('pickle-experiment-retries-');
  const experiment = plan(sessionDir, 'Exercise the same scientific hypothesis');
  startExperiment(sessionDir, experiment.id, { now: '2026-01-01T00:01:00.000Z' });
  let retry = recordWorkerAttemptFailure(sessionDir, experiment.id, {
    classification: 'worker_incomplete',
    insight: 'Final-message evidence was absent.',
  }, { now: '2026-01-01T00:02:00.000Z' });
  assert.equal(retry.id, 'exp-0001');
  assert.equal(retry.status, 'planned');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retry_count, 1);

  startExperiment(sessionDir, experiment.id, { now: '2026-01-01T00:03:00.000Z' });
  retry = recordWorkerAttemptFailure(sessionDir, experiment.id, {
    classification: 'worker_timeout',
  }, { now: '2026-01-01T00:04:00.000Z' });
  assert.equal(retry.attempt, 3);
  assert.equal(readExperimentLedger(sessionDir).experiments.length, 1);
  assert.equal(readExperimentLedger(sessionDir).experiment_stall_count, 0);
  assert.equal(readExperimentLedger(sessionDir).worker_failure_count, 2);

  startExperiment(sessionDir, experiment.id, { now: '2026-01-01T00:05:00.000Z' });
  completeExperiment(sessionDir, experiment.id, {
    status: 'accepted', classification: 'improved', resultScore: 74.5,
  }, { now: '2026-01-01T00:06:00.000Z' });
  const completed = readExperimentLedger(sessionDir);
  assert.equal(completed.experiments.length, 1);
  assert.equal(completed.experiments[0].worker_attempts.length, 3);
  assert.deepEqual(
    completed.experiments[0].worker_attempts.map((attempt) => attempt.status),
    ['invalid', 'invalid', 'completed'],
  );
  assert.deepEqual(
    compactExperimentMemory(completed).invalid_attempts.map((entry) => entry.attempt.classification),
    ['worker_incomplete', 'worker_timeout'],
  );
  assert.equal(completed.worker_failure_count, 0);
  assert.equal(completed.experiment_stall_count, 0);
});

test('retry exhaustion abandons the same experiment without inventing another attempt', () => {
  const sessionDir = makeTempRoot('pickle-experiment-abandon-');
  const experiment = plan(sessionDir, 'Retry-bounded hypothesis');
  startExperiment(sessionDir, experiment.id, { now: '2026-01-01T00:01:00.000Z' });
  recordWorkerAttemptFailure(sessionDir, experiment.id, {
    classification: 'worker_error',
    insight: 'Worker exited nonzero.',
  }, { now: '2026-01-01T00:02:00.000Z' });
  const abandoned = abandonPlannedExperiment(sessionDir, experiment.id, {
    classification: 'worker_error',
    insight: 'Worker failure limit reached.',
  }, { now: '2026-01-01T00:03:00.000Z' });
  assert.equal(abandoned.status, 'invalid');
  assert.equal(abandoned.attempt, 2);
  assert.equal(abandoned.worker_attempts.length, 1);
  assert.equal(readExperimentLedger(sessionDir).worker_failure_count, 1);
  assert.equal(readExperimentLedger(sessionDir).experiment_stall_count, 0);
});

test('resume and cancellation reconcile stale running records without scientific stalls', () => {
  const resumeDir = makeTempRoot('pickle-experiment-reconcile-resume-');
  const resumable = plan(resumeDir, 'Resume this hypothesis');
  startExperiment(resumeDir, resumable.id);
  const resumed = reconcileRunningExperiments(resumeDir, {
    mode: 'resume',
    now: '2026-01-01T00:10:00.000Z',
  });
  assert.deepEqual(resumed.reconciled_ids, [resumable.id]);
  assert.equal(resumed.ledger.experiments[0].status, 'planned');
  assert.equal(resumed.ledger.experiments[0].attempt, 2);
  assert.equal(resumed.ledger.experiments[0].worker_attempts[0].classification, 'worker_incomplete');
  assert.equal(resumed.ledger.experiment_stall_count, 0);
  assert.equal(startExperiment(resumeDir, resumable.id).id, resumable.id);

  const cancelDir = makeTempRoot('pickle-experiment-reconcile-cancel-');
  const cancelled = plan(cancelDir, 'Cancel this hypothesis');
  startExperiment(cancelDir, cancelled.id);
  const cancellation = reconcileRunningExperiments(cancelDir, {
    mode: 'cancel',
    classification: 'worker_error',
    insight: 'Session cancellation interrupted the worker.',
  });
  assert.equal(cancellation.ledger.experiments[0].status, 'invalid');
  assert.equal(cancellation.ledger.experiments[0].classification, 'worker_error');
  assert.equal(cancellation.ledger.experiment_stall_count, 0);
  assert.equal(cancellation.ledger.worker_failure_count, 1);
  assert.deepEqual(reconcileRunningExperiments(cancelDir, { mode: 'cancel' }).reconciled_ids, []);
});

test('convergence escalates deterministically and unresolved plans defer stalled', () => {
  const sessionDir = makeTempRoot('pickle-experiment-convergence-');
  for (let index = 1; index <= 8; index += 1) {
    const record = plan(sessionDir, `Rejected hypothesis family ${index}`);
    startExperiment(sessionDir, record.id);
    completeExperiment(sessionDir, record.id, {
      status: 'rejected',
      classification: index % 2 ? 'held' : 'regressed',
      resultScore: 73.72 - index,
      insight: `Rejected evidence ${index}`,
    });
    const level = researchConvergenceState(readExperimentLedger(sessionDir)).level;
    if (index < 3) assert.equal(level, 'none');
    else if (index < 5) assert.equal(level, 'warn');
    else if (index < 8) assert.equal(level, 'paradigm_shift');
    else assert.equal(level, 'stalled');
  }

  plan(sessionDir, 'Unresolved alternative direction');
  assert.equal(researchConvergenceState(readExperimentLedger(sessionDir)).level, 'paradigm_shift');

  const sessionWithReset = makeTempRoot('pickle-experiment-reset-');
  for (let index = 0; index < 3; index += 1) {
    const record = plan(sessionWithReset, `Held hypothesis ${index}`);
    startExperiment(sessionWithReset, record.id);
    completeExperiment(sessionWithReset, record.id, {
      status: 'rejected', classification: 'held', resultScore: 1,
    });
  }
  assert.equal(researchConvergenceState(readExperimentLedger(sessionWithReset)).level, 'warn');
  const improvement = plan(sessionWithReset, 'Successful hypothesis');
  startExperiment(sessionWithReset, improvement.id);
  completeExperiment(sessionWithReset, improvement.id, {
    status: 'accepted', classification: 'improved', resultScore: 2,
  });
  assert.equal(researchConvergenceState(readExperimentLedger(sessionWithReset)).level, 'none');
});

test('paradigm shift exposes exhausted families and validates a material family change', () => {
  const sessionDir = makeTempRoot('pickle-experiment-family-shift-');
  for (let index = 0; index < 5; index += 1) {
    const record = plan(sessionDir, `Sibling hypothesis ${index}`, {
      hypothesisFamily: 'coverage/prompts',
    });
    startExperiment(sessionDir, record.id);
    completeExperiment(sessionDir, record.id, {
      status: 'rejected', classification: 'held', resultScore: 73.72,
    });
  }
  const ledger = readExperimentLedger(sessionDir);
  const state = researchConvergenceState(ledger);
  assert.equal(state.level, 'paradigm_shift');
  assert.equal(state.family_shift_required, true);
  assert.deepEqual(state.exhausted_hypothesis_families, ['coverage prompts']);
  assert.equal(validateExperimentFamilyShift(ledger, null).valid, false);
  assert.equal(validateExperimentFamilyShift(ledger, 'Coverage / Prompts').valid, false);
  assert.match(validateExperimentFamilyShift(ledger, 'coverage/session lifecycle').reason ?? '', /^$/);
  assert.equal(validateExperimentFamilyShift(ledger, 'coverage/session lifecycle').valid, true);
  assert.throws(() => assertExperimentFamilyShift(ledger, 'coverage-prompts'), /exhausted/);
  assert.doesNotThrow(() => assertExperimentFamilyShift(ledger, 'coverage/session lifecycle'));
});

test('warn requires a different target set or hypothesis family', () => {
  const sessionDir = makeTempRoot('pickle-experiment-warning-shift-');
  for (let index = 0; index < 3; index += 1) {
    const record = plan(sessionDir, `Warning sibling ${index}`, {
      hypothesisFamily: 'coverage/prompts',
      targetPaths: ['extension/tests/prompts.test.js'],
    });
    startExperiment(sessionDir, record.id);
    completeExperiment(sessionDir, record.id, {
      status: 'rejected', classification: 'held', resultScore: 73.72,
    });
  }
  const ledger = readExperimentLedger(sessionDir);
  assert.equal(researchConvergenceState(ledger).level, 'warn');
  const repeated = validateExperimentStrategy(ledger, {
    hypothesisFamily: 'Coverage / Prompts',
    targetPaths: ['extension/tests/prompts.test.js'],
  });
  assert.equal(repeated.valid, false);
  assert.match(repeated.reason, /different target path set or hypothesis family/);
  assert.equal(validateExperimentStrategy(ledger, {
    hypothesisFamily: 'coverage/prompts',
    targetPaths: ['extension/tests/session.test.js'],
  }).valid, true);
  assert.equal(validateExperimentStrategy(ledger, {
    hypothesisFamily: 'coverage/session',
    targetPaths: ['extension/tests/prompts.test.js'],
  }).valid, true);
  assert.throws(() => assertExperimentFamilyShift(ledger, 'coverage/prompts'), /different target/);
  assert.throws(() => assertExperimentStrategy(ledger, {
    hypothesisFamily: 'coverage/prompts',
    targetPaths: ['extension/tests/prompts.test.js'],
  }), /different target/);
  assert.doesNotThrow(() => assertExperimentStrategy(ledger, {
    hypothesisFamily: 'coverage/prompts',
    targetPaths: ['extension/tests/session.test.js'],
  }));
});

test('ledger rejects malformed transitions and unsupported persisted schemas', () => {
  const sessionDir = makeTempRoot('pickle-experiment-validation-');
  const record = plan(sessionDir, 'Validate transition contracts');
  assert.throws(
    () => completeExperiment(sessionDir, record.id, {
      status: 'accepted', classification: 'improved', resultScore: 2,
    }),
    /cannot complete from status planned/,
  );
  startExperiment(sessionDir, record.id);
  assert.throws(
    () => completeExperiment(sessionDir, record.id, {
      status: 'accepted', classification: 'held', resultScore: 2,
    }),
    /incompatible/,
  );

  const aheadDir = makeTempRoot('pickle-experiment-schema-');
  const ahead = { ...createExperimentLedger(T0), schema_version: 2 };
  fs.writeFileSync(path.join(aheadDir, 'microverse-experiments.json'), `${JSON.stringify(ahead)}\n`);
  assert.throws(() => readExperimentLedger(aheadDir), /Unsupported.*schema/);

  assert.throws(
    () => writeExperimentLedger(aheadDir, { ...createExperimentLedger(T0), next_sequence: 0 }),
    /next_sequence/,
  );
});
