// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import {
  assertPrdSealMatchesPrd,
  createPrdSeal,
  readPrdSeal,
  writePrdSeal,
} from '../services/prd-seal.js';
import {
  LOGICAL_PIPELINE_CONTROL_STATES,
  approvePrdRevision,
  beginAutonomousExecution,
  createLogicalPipeline,
  readLogicalPipeline,
  requestPrdRevision,
} from '../services/durable-supervisor.js';

function sealInput(prd = '# Approved PRD\n\nShip it.\n', criterionText = 'The engine ships.') {
  return {
    prd,
    sealedAt: '2026-08-08T12:00:00.000Z',
    repository: {
      identity: 'pickle-rick-codex',
      working_directory: '/tmp/pickle-rick-codex',
      execution_base_policy: 'main at sealed HEAD; preserve unrelated work',
    },
    acceptance_criteria: [{ id: 'AC-01', text: criterionText }],
    scope_and_ownership: { include: ['extension/src'], preserve: ['unrelated work'] },
    dependencies_and_external_prerequisites: [],
    risk: ['durability'],
    decision_precedence: ['PRD', 'repository instructions'],
    preservation_and_rollback: { policy: 'checkpoint before promotion' },
    completion_definition: { terminal: 'completed' },
    release_gates: ['typecheck', 'tests'],
  };
}

test('PRD seal binds exact PRD and semantic contract with validated durable read-back', () => {
  const sessionDir = makeTempRoot('prd-seal-');
  const input = sealInput();
  const seal = writePrdSeal(sessionDir, input);

  assert.deepEqual(readPrdSeal(sessionDir), seal);
  assert.doesNotThrow(() => assertPrdSealMatchesPrd(seal, input.prd));
  assert.throws(() => assertPrdSealMatchesPrd(seal, `${input.prd}\nSemantic mutation.`), /does not match/);

  const changedCriterion = createPrdSeal(sealInput(input.prd, 'The engine ships autonomously.'));
  assert.notEqual(changedCriterion.semantic_hash, seal.semantic_hash);

  const sealPath = path.join(sessionDir, 'prd.lock.json');
  const tampered = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  tampered.release_gates.push('unsealed gate');
  fs.writeFileSync(sealPath, JSON.stringify(tampered));
  assert.throws(() => readPrdSeal(sessionDir), /semantic hash/);
});

test('post-seal control plane has no human-wait state and only formal PRD revision can leave execution', () => {
  assert.deepEqual(LOGICAL_PIPELINE_CONTROL_STATES, [
    'prd_development',
    'autonomous_execution',
    'prd_revision_required',
  ]);
  const sessionDir = makeTempRoot('human-boundary-');
  createLogicalPipeline(sessionDir, 'pipeline-1', { nowMs: 1_000 });
  writePrdSeal(sessionDir, sealInput());
  beginAutonomousExecution(sessionDir, { nowMs: 2_000 });
  const originalSealHash = readLogicalPipeline(sessionDir).prd_seal_hash;
  assert.equal(readLogicalPipeline(sessionDir).control_state, 'autonomous_execution');

  const statePath = path.join(sessionDir, 'logical-pipeline.json');
  const tampered = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  tampered.control_state = 'waiting_for_human_approval';
  fs.writeFileSync(statePath, JSON.stringify(tampered));
  assert.throws(() => readLogicalPipeline(sessionDir), /control state/);

  fs.writeFileSync(statePath, JSON.stringify(beginFreshAutonomousState(sessionDir)));
  const revised = requestPrdRevision(sessionDir, 'AC-01 contradicts AC-02.', 'Clarify precedence.', { nowMs: 3_000 });
  assert.equal(revised.control_state, 'prd_revision_required');
  assert.equal(revised.events.at(-1).kind, 'prd_revision_requested');

  const approved = approvePrdRevision(
    sessionDir,
    sealInput('# Revised approved PRD\n', 'The clarified engine ships.'),
    { nowMs: 4_000 },
  );
  assert.equal(approved.control_state, 'autonomous_execution');
  assert.notEqual(approved.prd_seal_hash, originalSealHash);
  assert.equal(approved.events.at(-1).kind, 'prd_sealed');
});

function beginFreshAutonomousState(sessionDir) {
  fs.rmSync(path.join(sessionDir, 'logical-pipeline.json'));
  createLogicalPipeline(sessionDir, 'pipeline-2', { nowMs: 1_000 });
  return beginAutonomousExecution(sessionDir, { nowMs: 2_000 });
}
