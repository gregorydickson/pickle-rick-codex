import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import { readJsonFile } from '../lib/pickle-utils.js';
import {
  assertPipelineResumeCompatible,
  createPipelineContract,
  resolveNextPipelinePhase,
  validatePipelineContract,
  writePipelineContract,
} from '../lib/pipeline.js';
import {
  beginPipelinePhase,
  cancelPipelineSession,
  ensurePipelineState,
  finishPipelinePhase,
  readPipelineState,
} from '../lib/pipeline-state.js';

function writeSessionState(sessionDir, workingDir) {
  writeJson(path.join(sessionDir, 'state.json'), {
    active: true,
    working_dir: workingDir,
    step: 'pickle',
    iteration: 0,
    max_iterations: 0,
    max_time_minutes: 0,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    original_prompt: 'pipeline contract test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-19T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 1,
    tmux_mode: true,
    last_exit_reason: null,
  });
}

test('validatePipelineContract normalizes aliases and resolveNextPipelinePhase returns the first incomplete phase', () => {
  const contract = validatePipelineContract({
    working_dir: '/tmp/pipeline-working-dir',
    target: '/tmp/pipeline-working-dir',
    phases: ['pickle', 'anatomy', 'szechuan'],
    bootstrap_source: 'task',
    task: 'ship the pipeline',
  });

  assert.deepEqual(contract.phases, ['pickle', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(contract.skip_flags, {
    anatomy: false,
    szechuan: false,
  });
  assert.equal(
    resolveNextPipelinePhase(contract, {
      phase_statuses: {
        pickle: 'done',
        'anatomy-park': 'running',
        'szechuan-sauce': 'todo',
      },
    }),
    'anatomy-park',
  );
});

test('assertPipelineResumeCompatible rejects immutable launch drift on resume', () => {
  const existing = createPipelineContract({
    working_dir: '/tmp/pipeline-working-dir',
    target: '/tmp/pipeline-working-dir',
    phases: ['pickle', 'anatomy-park'],
    skip_flags: {
      anatomy: false,
      szechuan: true,
    },
    bootstrap_source: 'prd',
    bootstrap_prd: '/tmp/original-prd.md',
  });

  const changedTarget = createPipelineContract({
    ...existing,
    target: '/tmp/other-target',
  });
  assert.throws(
    () => assertPipelineResumeCompatible(existing, changedTarget),
    /Cannot change pipeline target on resume/,
  );

  const changedBootstrap = createPipelineContract({
    ...existing,
    bootstrap_source: 'task',
    task: 'new bootstrap',
    bootstrap_prd: null,
  });
  assert.throws(
    () => assertPipelineResumeCompatible(existing, changedBootstrap),
    /Cannot change pipeline bootstrap source on resume/,
  );

  const existingTaskBootstrap = createPipelineContract({
    working_dir: '/tmp/pipeline-working-dir',
    target: '/tmp/pipeline-working-dir',
    phases: ['pickle', 'anatomy-park'],
    skip_flags: {
      anatomy: false,
      szechuan: true,
    },
    bootstrap_source: 'task',
    task: 'original bootstrap prompt',
  });
  const changedTask = createPipelineContract({
    ...existingTaskBootstrap,
    task: 'changed bootstrap prompt',
  });
  assert.throws(
    () => assertPipelineResumeCompatible(existingTaskBootstrap, changedTask),
    /Cannot change pipeline task bootstrap prompt on resume/,
  );

  const changedPhases = createPipelineContract({
    ...existing,
    phases: ['pickle'],
    skip_flags: {
      anatomy: true,
      szechuan: true,
    },
  });
  assert.throws(
    () => assertPipelineResumeCompatible(existing, changedPhases),
    /Cannot change pipeline phase list on resume/,
  );
});

test('ensurePipelineState mirrors immutable pipeline launch fields into state.json without treating it as the authority', () => {
  const sessionDir = makeTempRoot();
  writeSessionState(sessionDir, '/tmp/session-working-dir');
  writePipelineContract(sessionDir, {
    working_dir: '/tmp/pipeline-working-dir',
    target: '/tmp/pipeline-target',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    skip_flags: {
      anatomy: false,
      szechuan: false,
    },
    bootstrap_source: 'prd',
    bootstrap_prd: '/tmp/original-prd.md',
  });

  const pipelineState = ensurePipelineState(sessionDir);
  const mirroredState = readJsonFile(path.join(sessionDir, 'state.json'));

  assert.equal(pipelineState.current_phase, 'pickle');
  assert.equal(mirroredState.working_dir, '/tmp/session-working-dir');
  assert.equal(mirroredState.pipeline_working_dir, '/tmp/pipeline-working-dir');
  assert.equal(mirroredState.pipeline_target, '/tmp/pipeline-target');
  assert.equal(mirroredState.pipeline_bootstrap_source, 'prd');
  assert.equal(mirroredState.pipeline_bootstrap_prd, '/tmp/original-prd.md');
  assert.equal(mirroredState.pipeline_task, null);
  assert.deepEqual(mirroredState.pipeline_phases, ['pickle', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(mirroredState.pipeline_skip_flags, {
    anatomy: false,
    szechuan: false,
  });
  assert.equal(mirroredState.pipeline_phase, 'pickle');
  assert.equal(mirroredState.pipeline_phase_index, 0);
  assert.equal(mirroredState.pipeline_total_phases, 3);
});

test('cancelPipelineSession updates pipeline-state.json and mirrors the interrupted phase into state.json atomically', () => {
  const sessionDir = makeTempRoot();
  writeSessionState(sessionDir, '/tmp/pipeline-working-dir');
  writePipelineContract(sessionDir, {
    working_dir: '/tmp/pipeline-working-dir',
    target: '/tmp/pipeline-working-dir',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    bootstrap_source: 'task',
    task: 'ship the pipeline',
  });

  finishPipelinePhase(sessionDir, 'pickle', {
    exitReason: 'success',
    completedAt: '2026-04-19T00:09:00.000Z',
  });
  beginPipelinePhase(sessionDir, 'anatomy-park', {
    startedAt: '2026-04-19T00:10:00.000Z',
  });
  const result = cancelPipelineSession(sessionDir, {
    cancelledAt: '2026-04-19T00:11:00.000Z',
  });

  const pipelineState = readPipelineState(sessionDir);
  assert.equal(result.state.active, false);
  assert.equal(result.state.pipeline_mode, true);
  assert.equal(result.state.pipeline_phase, 'anatomy-park');
  assert.equal(result.state.pipeline_phase_index, 1);
  assert.equal(result.state.pipeline_total_phases, 3);
  assert.equal(result.state.pipeline_working_dir, '/tmp/pipeline-working-dir');
  assert.equal(result.state.pipeline_target, '/tmp/pipeline-working-dir');
  assert.equal(result.state.pipeline_bootstrap_source, 'task');
  assert.equal(result.state.pipeline_task, 'ship the pipeline');
  assert.deepEqual(result.state.pipeline_phases, ['pickle', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(result.state.pipeline_skip_flags, {
    anatomy: false,
    szechuan: false,
  });
  assert.equal(result.state.last_exit_reason, 'cancelled');
  assert.equal(pipelineState.current_phase, 'anatomy-park');
  assert.equal(pipelineState.current_phase_index, 1);
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'cancelled');
  assert.equal(pipelineState.last_exit_reason, 'cancelled');
});

test('finishPipelinePhase keeps verification-contract failures blocked on the current ticket', () => {
  const sessionDir = makeTempRoot();
  const workingDir = '/tmp/pipeline-working-dir';
  writeSessionState(sessionDir, workingDir);
  writePipelineContract(sessionDir, {
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'anatomy-park'],
    bootstrap_source: 'task',
    task: 'ship the pipeline',
  });

  beginPipelinePhase(sessionDir, 'pickle', {
    startedAt: '2026-04-19T00:10:00.000Z',
  });
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    ...readJsonFile(statePath),
    current_ticket: 'ticket-007',
  });

  const result = finishPipelinePhase(sessionDir, 'pickle', {
    exitReason: 'verification-contract-failed',
    lastError: 'pickle phase exited with verification-contract-failed',
  });

  const pipelineState = readPipelineState(sessionDir);
  assert.equal(result.state.last_exit_reason, 'verification-contract-failed');
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.current_ticket, 'ticket-007');
  assert.equal(result.state.pipeline_phase, 'pickle');
  assert.equal(result.state.pipeline_phase_index, 0);
  assert.equal(pipelineState.current_phase, 'pickle');
  assert.equal(pipelineState.phase_statuses.pickle, 'failed');
  assert.equal(pipelineState.last_exit_reason, 'verification-contract-failed');
});
