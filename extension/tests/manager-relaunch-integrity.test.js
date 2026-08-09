// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  auditCodexManagerRelaunchCaps,
  auditDeclaredRunnerRelaunchCallsites,
  activatePreparedManagerRelaunchRecovery,
  consumeManagerRelaunchRecovery,
  CODEX_MANAGER_RELAUNCH_CAP,
} from '../services/manager-relaunch-integrity.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  acquireSupervisorLease,
  assertSupervisorLeaseFence,
  beginAutonomousExecution,
  createLogicalPipeline,
  releaseSupervisorLease,
} from '../services/durable-supervisor.js';
import { StateManager } from '../services/state-manager.js';
import { runSequential } from '../bin/mux-runner.js';
import { runPipeline } from '../bin/pipeline-runner.js';
import { runLoop } from '../bin/loop-runner.js';
import { recordPickleTmuxManagerRelaunch } from '../bin/pickle-tmux.js';
import { recordPicklePipelineManagerRelaunch } from '../bin/pickle-pipeline.js';
import { recordDetachedLoopManagerRelaunch } from '../services/detached-launch.js';
import { createPipelineContract, writePipelineContract } from '../services/pipeline.js';
import { beginPipelinePhase, ensurePipelineState, finishPipelinePhase } from '../services/pipeline-state.js';
import { makeTempRoot, writeJson } from './helpers.js';

function createState(sessionDir, overrides = {}) {
  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    working_dir: process.cwd(),
    step: 'implement',
    current_ticket: 'R1',
    pipeline_phase: 'pickle',
    pipeline_phase_index: 0,
    iteration: 0,
    history: [],
    manager_relaunch_count: 0,
    manager_relaunch_history: [],
    schema_version: 1,
    ...overrides,
  });
}

function createAutonomousPipeline(sessionDir) {
  createLogicalPipeline(sessionDir, 'manager-relaunch-pipeline', { nowMs: Date.now() - 10_000 });
  writePrdSeal(sessionDir, {
    prd: '# Manager recovery\n',
    sealedAt: new Date(Date.now() - 9_000).toISOString(),
    repository: { identity: 'fixture', working_directory: process.cwd(), execution_base_policy: 'sealed main' },
    acceptance_criteria: [{ id: 'AC-MANAGER', text: 'Manager recovery remains autonomous.' }],
    scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [],
    decision_precedence: [], preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir, { nowMs: Date.now() - 8_000 });
  return acquireSupervisorLease(sessionDir, {
    ownerId: 'predecessor-manager', ttlMs: 1_000, nowMs: Date.now() - 7_000,
  });
}

test('tmux, pipeline, and legacy managers continue beyond ten through authenticated recovery epochs', async () => {
  const fixtures = [
    { relaunchPath: 'pickle-tmux', record: recordPickleTmuxManagerRelaunch, setup: () => {} },
    {
      relaunchPath: 'pickle-pipeline',
      record: recordPicklePipelineManagerRelaunch,
      setup: (sessionDir) => createAutonomousPipeline(sessionDir),
    },
    {
      relaunchPath: 'detached-loop',
      record: recordDetachedLoopManagerRelaunch,
      setup: (sessionDir) => writeJson(path.join(sessionDir, 'legacy-session-adoption.json'), {
        schema_version: 1, status: 'adopted', resume_checkpoint: { phase: 'implement' },
      }),
    },
  ];
  for (const fixture of fixtures) {
    const sessionDir = makeTempRoot(`pickle-relaunch-${fixture.relaunchPath}-`);
    createState(sessionDir);
    const predecessorLease = fixture.setup(sessionDir);
    for (let index = 1; index <= CODEX_MANAGER_RELAUNCH_CAP + 2; index += 1) {
      assert.equal(fixture.record(sessionDir), index);
    }
    let state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    assert.equal(state.manager_relaunch_count, 12);
    assert.equal(state.manager_relaunch_history.length, 12);
    assert.equal(state.manager_relaunch_recovery_epoch, 2);
    assert.equal(state.manager_relaunch_recovery_route, 'supervised_authority_reconstruction');
    assert.equal(state.active, false);
    assert.equal(state.tmux_runner_pid ?? null, null);
    assert.equal(state.worker_pid ?? null, null);
    assert.equal(state.active_child_pid ?? null, null);
    assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
    const firstRecovery = JSON.parse(fs.readFileSync(
      path.join(sessionDir, 'manager-relaunch-recovery.json'), 'utf8',
    ));
    assert.equal(firstRecovery.trigger_count, CODEX_MANAGER_RELAUNCH_CAP);
    assert.equal(firstRecovery.status, 'prepared');
    assert.equal(firstRecovery.execution_plan.kind, 'authority_reconstruction');
    assert.ok(firstRecovery.execution_plan.ordered_authority_sources.includes('state'));
    assert.match(firstRecovery.strategy_hash, /^[a-f0-9]{64}$/);
    const reconstructionLease = fixture.relaunchPath === 'pickle-pipeline'
      ? acquireSupervisorLease(sessionDir, { ownerId: 'reconstruction-manager', ttlMs: 60_000 })
      : null;
    new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
      current.step = 'corrupt-step';
      current.current_ticket = 'CORRUPT';
      current.pipeline_phase = 'citadel';
      current.pipeline_phase_index = 99;
      current.tmux_session_name = 'replacement-manager';
      current.tmux_runner_pid = 4242;
      return current;
    });
    const activatedReconstruction = activatePreparedManagerRelaunchRecovery(sessionDir);
    assert.equal(activatedReconstruction.status, 'active');
    assert.match(activatedReconstruction.execution_evidence_path, /authority_reconstruction\.json$/);
    const reconstructionEvidence = JSON.parse(fs.readFileSync(
      path.join(sessionDir, activatedReconstruction.execution_evidence_path), 'utf8',
    ));
    assert.equal(reconstructionEvidence.kind, 'authority_reconstruction');
    assert.equal(reconstructionEvidence.strategy_hash, firstRecovery.strategy_hash);
    assert.deepEqual(
      reconstructionEvidence.ordered_authority_sources,
      firstRecovery.execution_plan.ordered_authority_sources,
    );
    assert.deepEqual(reconstructionEvidence.observed_resume_boundary, {
      step: 'corrupt-step', current_ticket: 'CORRUPT', pipeline_phase: 'citadel', pipeline_phase_index: 99,
    });
    assert.deepEqual(reconstructionEvidence.restored_resume_boundary, {
      step: 'implement', current_ticket: 'R1', pipeline_phase: 'pickle', pipeline_phase_index: 0,
    });
    state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    assert.equal(state.step, 'implement');
    assert.equal(state.current_ticket, 'R1');
    assert.equal(state.pipeline_phase, 'pickle');
    assert.equal(state.pipeline_phase_index, 0);
    assert.equal(state.tmux_session_name, 'replacement-manager');
    assert.equal(state.tmux_runner_pid, 4242);
    if (reconstructionLease) {
      releaseSupervisorLease(sessionDir, reconstructionLease.owner_id, reconstructionLease.token);
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')).manager_relaunch_recovery_status,
      'active',
    );

    if (fixture.relaunchPath === 'pickle-pipeline') {
      for (let index = 13; index <= (CODEX_MANAGER_RELAUNCH_CAP * 2) + 2; index += 1) {
        assert.equal(fixture.record(sessionDir), index);
      }
      state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
      assert.equal(state.manager_relaunch_count, 22);
      assert.equal(state.manager_relaunch_recovery_epoch, 3);
      assert.equal(state.manager_relaunch_recovery_route, 'fenced_executor_takeover');
      const takeover = JSON.parse(fs.readFileSync(
        path.join(sessionDir, 'manager-relaunch-recovery.json'), 'utf8',
      ));
      assert.equal(takeover.previous_strategy_hash, firstRecovery.strategy_hash);
      assert.notEqual(takeover.strategy_hash, firstRecovery.strategy_hash);
      assert.equal(takeover.authority_snapshot.logical_pipeline.length, 64);
      assert.equal(takeover.execution_plan.kind, 'executor_takeover');
      assert.equal(takeover.execution_plan.require_exclusive_launch_lock, true);
      assert.equal(takeover.execution_plan.observed_lease_generation, 2);
      await assert.rejects(
        () => runPipeline(sessionDir),
        /pipeline\.json|pipeline contract/i,
      );
      assert.throws(
        () => assertSupervisorLeaseFence(sessionDir, predecessorLease.owner_id, predecessorLease.token),
        /stale ownership/,
      );
      const activatedTakeover = activatePreparedManagerRelaunchRecovery(sessionDir);
      assert.equal(activatedTakeover.status, 'active');
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')).manager_relaunch_recovery_status,
        'consumed',
      );
      assert.match(activatedTakeover.execution_evidence_path, /executor_takeover\.json$/);
      assert.notEqual(activatedTakeover.execution_evidence_path, activatedReconstruction.execution_evidence_path);
      const takeoverEvidence = JSON.parse(fs.readFileSync(
        path.join(sessionDir, activatedTakeover.execution_evidence_path), 'utf8',
      ));
      assert.equal(takeoverEvidence.kind, 'executor_takeover');
      assert.equal(takeoverEvidence.strategy_hash, takeover.strategy_hash);
      assert.equal(takeoverEvidence.prepared_logical_pipeline_hash, takeover.authority_snapshot.logical_pipeline);
      assert.equal(takeoverEvidence.logical_pipeline_id, 'manager-relaunch-pipeline');
      assert.equal(takeoverEvidence.observed_journal_tail_hash, takeover.execution_plan.observed_journal_tail_hash);
      assert.notEqual(takeoverEvidence.current_logical_pipeline_hash, takeover.authority_snapshot.logical_pipeline);
      assert.equal(takeoverEvidence.current_lease_generation, 3);
      assert.match(takeoverEvidence.current_lease_owner, /^runner:/);
      assert.equal(takeoverEvidence.predecessor_fenced, true);
      assert.equal(takeoverEvidence.exclusive_launch_lock_required, true);
      assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
    }
  }
});

test('mux and detached-loop runner entrypoints consume prepared reconstruction before startup', async () => {
  const fixtures = [
    {
      relaunchPath: 'pickle-tmux',
      record: recordPickleTmuxManagerRelaunch,
      beforeRecord: () => {},
      prepare: () => {},
      run: (sessionDir) => runSequential(sessionDir, {}, {
        runCitadel: async () => { throw new Error('post-activation-stop'); },
      }),
      failure: /post-activation-stop|dependency-repair-manifest-missing/,
    },
    {
      relaunchPath: 'detached-loop',
      record: recordDetachedLoopManagerRelaunch,
      beforeRecord: (sessionDir) => {
        new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
          state.working_dir = sessionDir;
          return state;
        });
      },
      prepare: (sessionDir) => {
        writeJson(path.join(sessionDir, 'loop_config.json'), { mode: 'anatomy-park' });
      },
      run: (sessionDir) => runLoop(sessionDir),
      failure: /control directory must be outside/,
    },
  ];
  for (const fixture of fixtures) {
    const sessionDir = makeTempRoot(`manager-runner-${fixture.relaunchPath}-`);
    createState(sessionDir);
    fixture.beforeRecord(sessionDir);
    for (let count = 1; count <= 12; count += 1) {
      fixture.record(sessionDir);
    }
    new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
      state.step = 'drifted';
      state.current_ticket = 'DRIFTED';
      return state;
    });
    fixture.prepare(sessionDir);
    await assert.rejects(() => fixture.run(sessionDir), fixture.failure);
    const recovery = JSON.parse(fs.readFileSync(path.join(sessionDir, 'manager-relaunch-recovery.json'), 'utf8'));
    const evidence = JSON.parse(fs.readFileSync(path.join(sessionDir, recovery.execution_evidence_path), 'utf8'));
    assert.equal(recovery.status, 'active');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')).manager_relaunch_recovery_status,
      'consumed',
    );
    assert.equal(evidence.kind, 'authority_reconstruction');
    assert.equal(evidence.observed_resume_boundary.step, 'drifted');
    assert.equal(evidence.restored_resume_boundary.step, 'implement');
    assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
  }
});

test('takeover activation rejects an unchanged predecessor lease', () => {
  const sessionDir = makeTempRoot('manager-takeover-unfenced-');
  createState(sessionDir);
  createAutonomousPipeline(sessionDir);
  for (let count = 1; count <= 21; count += 1) {
    recordPicklePipelineManagerRelaunch(sessionDir);
  }
  assert.throws(
    () => activatePreparedManagerRelaunchRecovery(sessionDir),
    /strictly newer fenced lease generation/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sessionDir, 'manager-relaunch-recovery.json'), 'utf8')).status,
    'prepared',
  );
});

test('active reconstruction audit rejects fabricated receipts and post-activation authority drift', () => {
  const makeActive = (prefix) => {
    const sessionDir = makeTempRoot(prefix);
    createState(sessionDir);
    for (let count = 1; count <= 12; count += 1) recordPickleTmuxManagerRelaunch(sessionDir);
    activatePreparedManagerRelaunchRecovery(sessionDir);
    return sessionDir;
  };

  const fabricated = makeActive('manager-fabricated-receipt-');
  const fabricatedArtifactPath = path.join(fabricated, 'manager-relaunch-recovery.json');
  const fabricatedArtifact = JSON.parse(fs.readFileSync(fabricatedArtifactPath, 'utf8'));
  writeJson(path.join(fabricated, fabricatedArtifact.execution_evidence_path), {
    schema_version: 1,
    recovery_epoch: fabricatedArtifact.recovery_epoch,
    strategy_hash: fabricatedArtifact.strategy_hash,
    kind: 'authority_reconstruction',
    activated_at: new Date().toISOString(),
    receipt_hash: fabricatedArtifact.execution_receipt_hash,
  });
  assert.match(auditCodexManagerRelaunchCaps(fabricated).violations[0].reason, /execution evidence/);

  const boundaryDrift = makeActive('manager-boundary-drift-');
  new StateManager().update(path.join(boundaryDrift, 'state.json'), (state) => {
    state.step = 'unauthorized-drift';
    return state;
  });
  assert.match(auditCodexManagerRelaunchCaps(boundaryDrift).violations[0].reason, /execution evidence/);
  assert.throws(() => activatePreparedManagerRelaunchRecovery(boundaryDrift), /execution evidence/);

  const immutableDrift = makeActive('manager-immutable-drift-');
  new StateManager().update(path.join(immutableDrift, 'state.json'), (state) => {
    state.working_dir = makeTempRoot('manager-foreign-workspace-');
    return state;
  });
  assert.match(auditCodexManagerRelaunchCaps(immutableDrift).violations[0].reason, /execution evidence/);

  const legacyDrift = makeTempRoot('manager-legacy-authority-drift-');
  createState(legacyDrift);
  writeJson(path.join(legacyDrift, 'legacy-session-adoption.json'), {
    schema_version: 1, status: 'adopted', resume_checkpoint: { phase: 'implement' },
  });
  for (let count = 1; count <= 12; count += 1) recordDetachedLoopManagerRelaunch(legacyDrift);
  activatePreparedManagerRelaunchRecovery(legacyDrift);
  writeJson(path.join(legacyDrift, 'legacy-session-adoption.json'), {
    schema_version: 1, status: 'tampered', resume_checkpoint: { phase: 'release' },
  });
  assert.match(auditCodexManagerRelaunchCaps(legacyDrift).violations[0].reason, /execution evidence/);
});

test('consumption is idempotent through direct and nested pipeline phase entry and rejects every split status', async () => {
  const sessionDir = makeTempRoot('manager-consumption-atomic-');
  createState(sessionDir);
  for (let count = 1; count <= 12; count += 1) recordPickleTmuxManagerRelaunch(sessionDir);
  activatePreparedManagerRelaunchRecovery(sessionDir);
  assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);

  consumeManagerRelaunchRecovery(sessionDir);
  let state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.manager_relaunch_recovery_status, 'consumed');
  assert.equal(state.manager_relaunch_transition_journal.at(-1).event, 'consumed');
  assert.ok(state.manager_relaunch_recovery_consumed_at);
  assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
  const consumedAt = state.manager_relaunch_recovery_consumed_at;
  const consumedJournal = structuredClone(state.manager_relaunch_transition_journal);
  while (Date.now() <= Date.parse(consumedAt) + 2) { /* force a distinct clock tick */ }
  consumeManagerRelaunchRecovery(sessionDir);
  state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.manager_relaunch_recovery_consumed_at, consumedAt);
  assert.deepEqual(state.manager_relaunch_transition_journal, consumedJournal);

  await assert.rejects(
    () => runSequential(sessionDir, { operationLeaseHeld: true, runnerMode: 'pipeline' }),
    /dependency-repair-manifest-missing/,
  );
  state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.manager_relaunch_recovery_consumed_at, consumedAt);
  assert.deepEqual(state.manager_relaunch_transition_journal, consumedJournal);

  new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
    current.manager_relaunch_recovery_status = 'active';
    return current;
  });
  assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);

  new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
    current.manager_relaunch_recovery_status = 'consumed';
    current.manager_relaunch_recovery_consumed_at = null;
    return current;
  });
  assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);

  state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  state.manager_relaunch_transition_journal.at(-1).auth_hash = '0'.repeat(64);
  writeJson(path.join(sessionDir, 'state.json'), state);
  assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);
});

test('internally consistent unkeyed artifact, evidence, and transition forgery is rejected', () => {
  const sessionDir = makeTempRoot('manager-unkeyed-forgery-');
  createState(sessionDir);
  for (let count = 1; count <= 12; count += 1) recordPickleTmuxManagerRelaunch(sessionDir);
  activatePreparedManagerRelaunchRecovery(sessionDir);

  const fakeHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const artifactPath = path.join(sessionDir, 'manager-relaunch-recovery.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const evidencePath = path.join(sessionDir, artifact.execution_evidence_path);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const forgedBoundary = { step: 'forged', current_ticket: 'FORGED', pipeline_phase: null, pipeline_phase_index: null };

  artifact.execution_plan.resume_boundary = forgedBoundary;
  artifact.strategy_hash = fakeHash({ route: artifact.route, boundary: forgedBoundary });
  evidence.strategy_hash = artifact.strategy_hash;
  evidence.prepared_resume_boundary = forgedBoundary;
  evidence.restored_resume_boundary = forgedBoundary;
  delete evidence.receipt_hash;
  evidence.receipt_hash = fakeHash(evidence);
  artifact.execution_receipt_hash = evidence.receipt_hash;
  state.step = forgedBoundary.step;
  state.current_ticket = forgedBoundary.current_ticket;
  state.manager_relaunch_strategy_hash = artifact.strategy_hash;
  const transition = state.manager_relaunch_transition_journal.at(-1);
  transition.strategy_hash = artifact.strategy_hash;
  transition.receipt_hash = evidence.receipt_hash;
  transition.restored_boundary_hash = fakeHash(forgedBoundary);
  const { auth_hash: _oldAuthHash, ...fakeTransitionMaterial } = transition;
  transition.auth_hash = fakeHash(fakeTransitionMaterial);

  writeJson(artifactPath, artifact);
  writeJson(evidencePath, evidence);
  writeJson(statePath, state);
  assert.ok(auditCodexManagerRelaunchCaps(sessionDir).violations.length > 0);
});

test('activation timestamp is identical and authenticated across artifact, evidence, state, and journal', () => {
  const targets = ['artifact', 'evidence', 'state', 'journal'];
  for (const target of targets) {
    const sessionDir = makeTempRoot(`manager-activation-time-${target}-`);
    createState(sessionDir);
    for (let count = 1; count <= 12; count += 1) recordPickleTmuxManagerRelaunch(sessionDir);
    const activated = activatePreparedManagerRelaunchRecovery(sessionDir);
    const artifactPath = path.join(sessionDir, 'manager-relaunch-recovery.json');
    const evidencePath = path.join(sessionDir, activated.execution_evidence_path);
    const statePath = path.join(sessionDir, 'state.json');
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const activation = state.manager_relaunch_transition_journal.find((entry) => entry.event === 'activated');
    assert.equal(artifact.activated_at, evidence.activated_at);
    assert.equal(artifact.activated_at, state.manager_relaunch_recovery_activated_at);
    assert.equal(artifact.activated_at, activation.recorded_at);
    const tampered = '2099-01-01T00:00:00.000Z';
    if (target === 'artifact') {
      artifact.activated_at = tampered;
      writeJson(artifactPath, artifact);
    } else if (target === 'evidence') {
      evidence.activated_at = tampered;
      writeJson(evidencePath, evidence);
    } else if (target === 'state') {
      state.manager_relaunch_recovery_activated_at = tampered;
      writeJson(statePath, state);
    } else {
      activation.recorded_at = tampered;
      writeJson(statePath, state);
    }
    assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);
  }
});

test('real pipeline and nested mux phase consume once while validated pipeline state advances', async () => {
  const sessionDir = makeTempRoot('manager-real-pipeline-consumption-');
  createState(sessionDir);
  createAutonomousPipeline(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: process.cwd(),
    target: process.cwd(),
    scope: ['README.md'],
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'exercise manager recovery consumption',
  }));
  ensurePipelineState(sessionDir);
  for (let count = 1; count <= 12; count += 1) recordPicklePipelineManagerRelaunch(sessionDir);

  await assert.rejects(
    () => runPipeline(sessionDir),
    /dependency-repair-manifest-missing/,
  );
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  const consumed = state.manager_relaunch_transition_journal.filter((entry) => entry.event === 'consumed');
  assert.equal(consumed.length, 1);
  assert.equal(state.manager_relaunch_recovery_consumed_at, consumed[0].recorded_at);
  assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
  const pipelineStatePath = path.join(sessionDir, 'pipeline-state.json');
  const pipelineState = JSON.parse(fs.readFileSync(pipelineStatePath, 'utf8'));
  pipelineState.started_at = '2099-01-01T00:00:00.000Z';
  writeJson(pipelineStatePath, pipelineState);
  assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);
});

test('consumed pipeline evolution rejects skipped phases, mismatched tickets, and generic completion', () => {
  for (const probe of [
    { name: 'skip', step: 'pipeline_phase_failed', ticket: 'pickle' },
    { name: 'mismatch', step: 'pipeline_phase_started', ticket: 'anatomy-park' },
    { name: 'generic', step: 'complete', ticket: 'citadel' },
  ]) {
    const sessionDir = makeTempRoot(`manager-pipeline-causal-${probe.name}-`);
    createState(sessionDir);
    writePipelineContract(sessionDir, createPipelineContract({
      working_dir: process.cwd(), target: process.cwd(), scope: ['README.md'],
      phases: ['pickle', 'anatomy-park', 'citadel'], bootstrap_source: 'task', task: 'causal probe',
    }));
    ensurePipelineState(sessionDir);
    for (let count = 1; count <= 12; count += 1) recordPicklePipelineManagerRelaunch(sessionDir);
    activatePreparedManagerRelaunchRecovery(sessionDir);
    consumeManagerRelaunchRecovery(sessionDir);

    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.history.push({
      step: probe.step,
      ticket: probe.ticket,
      timestamp: new Date(Date.parse(state.manager_relaunch_recovery_consumed_at) + 1).toISOString(),
    });
    writeJson(statePath, state);
    const pipelineStatePath = path.join(sessionDir, 'pipeline-state.json');
    const pipelineState = JSON.parse(fs.readFileSync(pipelineStatePath, 'utf8'));
    pipelineState.phase_statuses = { pickle: 'done', 'anatomy-park': 'done', citadel: 'running' };
    pipelineState.current_phase = 'citadel';
    pipelineState.current_phase_index = 2;
    pipelineState.phase_started_at = new Date(Date.parse(state.manager_relaunch_recovery_consumed_at) + 1).toISOString();
    writeJson(pipelineStatePath, pipelineState);
    assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);
  }
});

test('prepared-running phase accepts exact idempotent restart before failed or done transition', () => {
  for (const exitReason of ['error', 'success']) {
    const sessionDir = makeTempRoot(`manager-pipeline-running-${exitReason}-`);
    createState(sessionDir);
    writePipelineContract(sessionDir, createPipelineContract({
      working_dir: process.cwd(), target: process.cwd(), scope: ['README.md'],
      phases: ['pickle'], bootstrap_source: 'task', task: 'resume prepared running phase',
    }));
    ensurePipelineState(sessionDir);
    beginPipelinePhase(sessionDir, 'pickle');
    for (let count = 1; count <= 12; count += 1) recordPicklePipelineManagerRelaunch(sessionDir);
    activatePreparedManagerRelaunchRecovery(sessionDir);
    consumeManagerRelaunchRecovery(sessionDir);
    const consumedHistoryLength = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'),
    ).history.length;

    beginPipelinePhase(sessionDir, 'pickle');
    assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
    finishPipelinePhase(sessionDir, 'pickle', { exitReason });
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    const postConsumptionEvents = state.history.slice(consumedHistoryLength).filter((entry) =>
      String(entry.step).startsWith('pipeline_phase_'));
    assert.deepEqual(
      postConsumptionEvents.map((entry) => [entry.step, entry.ticket]),
      [
        ['pipeline_phase_started', 'pickle'],
        [exitReason === 'success' ? 'pipeline_phase_done' : 'pipeline_phase_failed', 'pickle'],
      ],
    );
    assert.deepEqual(auditCodexManagerRelaunchCaps(sessionDir).violations, []);
  }
});

test('prepared-running phase rejects terminal transition without post-consumption reaffirmation', () => {
  for (const exitReason of ['error', 'success']) {
    const sessionDir = makeTempRoot(`manager-pipeline-unaffirmed-${exitReason}-`);
    createState(sessionDir);
    writePipelineContract(sessionDir, createPipelineContract({
      working_dir: process.cwd(), target: process.cwd(), scope: ['README.md'],
      phases: ['pickle'], bootstrap_source: 'task', task: 'reject unaffirmed terminal phase',
    }));
    ensurePipelineState(sessionDir);
    beginPipelinePhase(sessionDir, 'pickle');
    for (let count = 1; count <= 12; count += 1) recordPicklePipelineManagerRelaunch(sessionDir);
    activatePreparedManagerRelaunchRecovery(sessionDir);
    consumeManagerRelaunchRecovery(sessionDir);

    finishPipelinePhase(sessionDir, 'pickle', { exitReason });
    assert.match(auditCodexManagerRelaunchCaps(sessionDir).violations[0].reason, /execution evidence/);
  }
});

test('bundle audit treats count as telemetry but fails closed for a missing recovery epoch and undeclared path', () => {
  const sessionDir = makeTempRoot('pickle-relaunch-audit-');
  createState(sessionDir, {
    manager_relaunch_count: CODEX_MANAGER_RELAUNCH_CAP + 1,
    manager_relaunch_history: [{ path: 'mystery-manager', timestamp: new Date().toISOString() }],
  });
  const audit = auditCodexManagerRelaunchCaps(sessionDir);
  assert.equal(audit.checkedStatePaths.length, 1);
  assert.equal(audit.violations.length, 2);
  assert.match(audit.violations.map(({ reason }) => reason).join('\n'), /recovery epoch/i);
  assert.match(audit.violations.map(({ reason }) => reason).join('\n'), /undeclared runner relaunch path/);
});

test('source invariant admits only the three declared runner relaunch boundaries', () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  assert.deepEqual(auditDeclaredRunnerRelaunchCallsites(sourceRoot), []);
});
