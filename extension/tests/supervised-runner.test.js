// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot } from './helpers.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  beginAutonomousExecution,
  createLogicalPipeline,
  requestPrdRevision,
  terminateLogicalPipeline,
} from '../services/durable-supervisor.js';
import { supervisedRunnerDecision } from '../bin/supervised-runner.js';

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

test('supervised runner exits only for the two logical terminal states', () => {
  const completed = autonomousSession();
  terminateLogicalPipeline(completed, 'completed');
  assert.equal(supervisedRunnerDecision(completed), 'completed');
  const cancelled = autonomousSession();
  terminateLogicalPipeline(cancelled, 'cancelled');
  assert.equal(supervisedRunnerDecision(cancelled), 'cancelled');
});
