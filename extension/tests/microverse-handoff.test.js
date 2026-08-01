// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  completeExperiment,
  planExperiment,
  startExperiment,
} from '../services/experiment-ledger.js';
import { createMetricConvergenceState } from '../services/metric-convergence.js';
import {
  MICROVERSE_RECENT_HANDOFF_LIMIT,
  MICROVERSE_WORKER_HANDOFF_MAX_CHARS,
  writeMicroverseWorkerHandoff,
} from '../services/microverse-handoff.js';
import { makeTempRoot } from './helpers.js';

test('microverse worker handoff stays small and points to durable history', () => {
  const sessionDir = makeTempRoot('pickle-microverse-handoff-session-');
  const workerArtifactDir = makeTempRoot('pickle-microverse-handoff-worker-');
  for (let index = 1; index <= 7; index += 1) {
    const record = planExperiment(sessionDir, {
      hypothesis: `Accepted hypothesis ${index} ${'evidence '.repeat(500)}`,
      hypothesisFamily: `family-${index}`,
      differentiator: `surface-${index}`,
      rationale: `rationale-${index}`,
      targetPaths: [`src/surface-${index}.ts`],
      baselineScore: index - 1,
    });
    startExperiment(sessionDir, record.id);
    completeExperiment(sessionDir, record.id, {
      status: 'accepted',
      classification: 'improved',
      resultScore: index,
      insight: `insight-${index} ${'detail '.repeat(500)}`,
    });
  }
  const current = planExperiment(sessionDir, {
    hypothesis: 'Runtime placeholder for Microverse iteration 8',
    differentiator: 'iteration 8; experiment 8',
    rationale: 'continue',
    baselineScore: 7,
  });
  startExperiment(sessionDir, current.id);
  const metricState = createMetricConvergenceState({
    command: 'printf 7',
    score: 7,
    raw: '7',
    measured_at: new Date(0).toISOString(),
  }, 'higher', 0, 10, 'gte');

  const handoffPath = writeMicroverseWorkerHandoff({
    sessionDir,
    workerArtifactDir,
    workingDir: '/repos/project',
    iteration: 8,
    loopConfig: {
      task: 'large objective '.repeat(10_000),
      metric: 'large metric '.repeat(10_000),
      direction: 'higher',
      target: 10,
      target_relation: 'gte',
    },
    metricState,
    experiment: current,
    experimentArtifactPath: path.join(workerArtifactDir, 'microverse-experiment.json'),
  });

  const raw = fs.readFileSync(handoffPath, 'utf8');
  const handoff = JSON.parse(raw);
  assert.ok(raw.length <= MICROVERSE_WORKER_HANDOFF_MAX_CHARS);
  assert.equal(handoff.current_experiment.id, 'exp-0008');
  assert.equal(handoff.recent_experiments.length, MICROVERSE_RECENT_HANDOFF_LIMIT);
  assert.deepEqual(handoff.recent_experiments.map((entry) => entry.id), [
    'exp-0003',
    'exp-0004',
    'exp-0005',
    'exp-0006',
    'exp-0007',
  ]);
  assert.match(handoff.objective.task_preview, /chars omitted; read durable reference/);
  assert.equal(
    handoff.durable_references.experiment_ledger,
    path.join(sessionDir, 'microverse-experiments.json'),
  );
  assert.match(handoff.read_strategy, /never load the full ledger into context/);
});
