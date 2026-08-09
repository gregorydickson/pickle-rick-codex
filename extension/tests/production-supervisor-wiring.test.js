// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeCodex, makeTempRoot, prependPath, writeJson } from './helpers.js';
import { muxRunnerExitFailed, runSequential } from '../bin/mux-runner.js';
import { repairTicketVerificationContract, runTicket } from '../bin/spawn-morty.js';
import {
  enqueueCitadelRemediation,
  parsePipelineHandoffOptions,
  pipelineExitFailed,
  runPipeline,
} from '../bin/pipeline-runner.js';
import { DurableOwnershipDrainError, startDurableRuntimeOwnership } from '../services/durable-runtime.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  recordSupervisorCheckpoint,
  readLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
  watchdogRecoverSupervisor,
} from '../services/durable-supervisor.js';
import { readPrdSeal } from '../services/prd-seal.js';
import { ensureSessionPrdSeal, initializePrdDevelopmentPipeline } from '../services/session-prd-seal.js';
import {
  beginRefinementRepositoryAdvance,
  refreshAcceptedRefinementRepositoryIdentity,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { createPipelineContract, writePipelineContract } from '../services/pipeline.js';
import {
  beginPipelinePhase,
  ensurePipelineState,
  finishPipelinePhase,
  readPipelineState,
} from '../services/pipeline-state.js';
import { readManifest, restructureTicketFiles, updateTicketStatus } from '../services/tickets.js';
import { ensureBootstrapSessionReady } from '../services/pipeline-bootstrap.js';
import { captureSpawnedProcessIdentity, inspectProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';
import { assertSessionOperationAvailable } from '../services/session-operation.js';
import {
  assertCitadelReleaseApproval,
  deriveCitadelAcceptanceCriteria,
  persistCitadelReleaseApproval,
  readCitadelSystemBlock,
} from '../services/citadel.js';
import {
  consumeDeterministicCheckFailure,
  runDeterministicRecoveryDiagnostic,
} from '../services/citadel-deterministic-recovery.js';
import { PreflightError } from '../services/verification-env.js';
import { reconstructWorkspaceFromDurableCheckpoint } from '../services/workspace-reconstruction.js';
import { buildTicketPhasePrompt } from '../services/prompts.js';
import { reconcileCitadelAttributionRepair, repairCitadelAttribution } from '../services/citadel-remediation.js';
import { repairCitadelReviewerArtifactContract } from '../services/citadel-reviewer-recovery.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeCitadelSystemBlock(sessionDir, overrides = {}) {
  writeJson(path.join(sessionDir, 'citadel-system-block.json'), {
    schema_version: 1,
    artifact_kind: 'citadel_system_block',
    category: 'infrastructure',
    code: 'deterministic_check_failed',
    reviewed_range: 'fixture..HEAD',
    title: 'Deterministic release check failed',
    evidence: 'npm test exited 7.',
    recommendation: 'Retry the deterministic gate in an isolated executor.',
    checks: [{ command: 'npm test', status: 'failed', exit_code: 7, output: 'fixture failure' }],
    recovery_action: 'retry_checks',
    recovery_ticket_ids: [],
    failure_identity: 'f'.repeat(64),
    attempt: 2,
    recovery_epoch: 1,
    bounded_attempt: 2,
    next_action: 'restart_executor',
    generated_at: new Date().toISOString(),
    ...overrides,
  });
}

test('pipeline runner decodes and forwards green runtime handoff arguments', () => {
  const targetRuntime = {
    runtime_id: 'green', version: '2.0.0', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 2,
  };
  assert.deepEqual(parsePipelineHandoffOptions([
    '--handoff-request=request-42',
    `--target-runtime=${Buffer.from(JSON.stringify(targetRuntime)).toString('base64url')}`,
  ]), { handoffRequestId: 'request-42', targetRuntime });
});

function createAcceptedSession(status = 'Todo') {
  const workingDir = makeTempRoot('production-supervisor-repo-');
  git(workingDir, ['init', '-q']);
  fs.writeFileSync(path.join(workingDir, 'README.md'), '# Fixture\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  const sessionDir = makeTempRoot('production-supervisor-session-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    active: false,
    working_dir: workingDir,
    session_dir: sessionDir,
    original_prompt: 'deliver accepted contract',
    step: 'refine',
    iteration: 0,
    max_iterations: 0,
    max_time_minutes: 0,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    started_at: '2026-08-08T00:00:00.000Z',
    start_commit: git(workingDir, ['rev-parse', 'HEAD']),
    current_ticket: null,
    history: [],
  });
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Approved fixture PRD\n\nShip durable runtime ownership.\n');
  fs.writeFileSync(
    path.join(sessionDir, 'prd_refined.md'),
    '# Refined fixture PRD\n\n### AC-RUNTIME-01: The launched runner renews exclusive durable ownership.\n',
  );
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'R1',
      title: 'Wire durable ownership',
      description: 'Exercise the production supervisor path.',
      acceptance_criteria: ['The launched runner renews exclusive durable ownership.'],
      verification: ['node -e "process.exit(0)"'],
      allowed_paths: ['README.md'],
      priority: 'P0',
      status,
    }],
  });
  writeRefinementAcceptance(sessionDir, { workingDir });
  return { sessionDir, workingDir };
}

function addIndependentDoneTicket(sessionDir, workingDir) {
  fs.appendFileSync(
    path.join(sessionDir, 'prd_refined.md'),
    '\n### AC-INDEPENDENT-01: Independent completed work retains its checkpoint.\n',
  );
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].status = 'Done';
  manifest.tickets[0].completion_commit = 'a'.repeat(40);
  manifest.tickets.push({
    id: 'R2',
    title: 'Preserve independent checkpoint',
    description: 'Exercise narrow Citadel attribution repair.',
    acceptance_criteria: ['Independent completed work retains its checkpoint.'],
    verification: ['node -e "process.exit(0)"'],
    allowed_paths: ['independent.txt'],
    priority: 'P1',
    status: 'Done',
    completion_commit: 'b'.repeat(40),
  });
  writeJson(manifestPath, manifest);
  writeRefinementAcceptance(sessionDir, { workingDir });
}

async function approveCitadelFixture(sessionDir) {
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  persistCitadelReleaseApproval(sessionDir, {
    schema_version: 1,
    verdict: 'approve',
    reviewed_range: `${state.start_commit}..HEAD`,
    acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(sessionDir),
    findings: [],
    generated_at: new Date().toISOString(),
  });
  return 'success';
}

async function withProcessEnvironment(environment, callback) {
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function prepareSealedVerificationRepairPipeline(sessionDir, workingDir, task) {
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task,
  }));
  ensurePipelineState(sessionDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  manifest.tickets[0].verification = [{ kind: 'process', executable: 'node', args: 'not-an-array' }];
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), manifest);
  writeRefinementAcceptance(sessionDir, { workingDir, preserveMalformedVerification: true });
}

test('bootstrap readiness writes a validated seal and crosses the explicit autonomous boundary', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  assert.equal(readLogicalPipeline(sessionDir).control_state, 'prd_development');

  await ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: true });
  const seal = readPrdSeal(sessionDir);
  assert.deepEqual(readPrdSeal(sessionDir), seal);
  assert.deepEqual(seal.acceptance_criteria, [{
    id: 'AC-RUNTIME-01',
    text: 'The launched runner renews exclusive durable ownership.',
  }]);
  const logical = readLogicalPipeline(sessionDir);
  assert.equal(logical.control_state, 'autonomous_execution');
  assert.equal(logical.prd_seal_hash, seal.semantic_hash);
  assert.equal(logical.events.at(-1).kind, 'prd_sealed');
});

test('runtime heartbeat owns, renews, excludes a second runner, and releases recoverably', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const ownership = startDurableRuntimeOwnership(sessionDir, {
    ownerId: `runner:${process.pid}:first`,
    ttlMs: 500,
    renewEveryMs: 50,
  });
  const initialExpiry = ownership.lease().expires_at;
  await new Promise((resolve) => setTimeout(resolve, 140));
  ownership.assertOwned();
  assert.ok(Date.parse(ownership.lease().expires_at) > Date.parse(initialExpiry));
  assert.throws(
    () => startDurableRuntimeOwnership(sessionDir, { ownerId: `runner:${process.pid}:second` }),
    /already owned by live executor/,
  );
  ownership.finish('error');
  assert.equal(readLogicalPipeline(sessionDir).lease, null);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
});

test('two consecutive executor losses preserve an authenticated older checkpoint generation', () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const dead = acquireSupervisorLease(sessionDir, {
    ownerId: 'runner:2147483646:dead',
    ttlMs: 60_000,
  });
  recordSupervisorCheckpoint(sessionDir, dead.owner_id, dead.token, {
    schema_version: 1,
    kind: 'worker_phase',
    ticket_id: 'r1',
    lease_generation: 99,
  });
  const persistedCheckpoint = readLogicalPipeline(sessionDir).events.at(-1).details.checkpoint;
  assert.equal(persistedCheckpoint.lease_generation, 1);
  const second = watchdogRecoverSupervisor(sessionDir, {
    ownerId: 'runner:2147483645:dead-second',
    ttlMs: 60_000,
    executorAlive: () => false,
  });
  assert.equal(second.lease.generation, 2);
  assert.equal(second.resume_checkpoint.lease_generation, 1);
  const third = watchdogRecoverSupervisor(sessionDir, {
    ownerId: 'runner:2147483644:dead-third',
    ttlMs: 60_000,
    executorAlive: () => false,
  });
  assert.equal(third.lease.generation, 3);
  assert.equal(third.resume_checkpoint.lease_generation, 1);
  const replacement = startDurableRuntimeOwnership(sessionDir, {
    ownerId: `runner:${process.pid}:replacement`,
  });
  assert.equal(replacement.lease().generation, 4);
  assert.equal(replacement.resumeCheckpoint().lease_generation, 1);
  replacement.finish('error');
});

test('replacement executor reuses a real fenced plan checkpoint and completes without replaying prior phases', async () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.active = true;
  writeJson(statePath, state);
  const fakeBin = makeTempRoot('production-supervisor-checkpoint-bin-');
  createFakeCodex(fakeBin);
  const invocationLog = path.join(sessionDir, 'checkpoint-invocations.jsonl');
  const env = {
    ...process.env,
    ...prependPath(fakeBin),
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
  };
  const moduleRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const executorScript = `
    import { startDurableRuntimeOwnership } from ${JSON.stringify(new URL('../services/durable-runtime.js', import.meta.url).href)};
    import { runTicket } from ${JSON.stringify(new URL('../bin/spawn-morty.js', import.meta.url).href)};
    const sessionDir = ${JSON.stringify(sessionDir)};
    const ownership = startDurableRuntimeOwnership(sessionDir);
    await runTicket(sessionDir, 'R1', {
      runnerMode: 'pickle',
      assertDurableOwnership: ownership.assertOwned,
      recordDurableCheckpoint: (checkpoint) => {
        ownership.recordCheckpoint(checkpoint);
        if (checkpoint.completed_phase === 'plan_review') process.kill(process.pid, 'SIGKILL');
      },
    });
  `;
  const first = spawn(process.execPath, ['--input-type=module', '-e', executorScript], {
    cwd: moduleRoot,
    env,
    stdio: 'ignore',
  });
  const firstExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first executor did not reach its checkpoint')), 15_000);
    first.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(firstExit.signal, 'SIGKILL');
  const afterKill = readLogicalPipeline(sessionDir);
  const checkpointEvent = [...afterKill.events].reverse().find((event) => event.kind === 'checkpoint_recorded');
  assert.equal(checkpointEvent.details.checkpoint.completed_phase, 'plan_review');
  assert.deepEqual(checkpointEvent.details.checkpoint.completed_phases, ['research', 'research_review', 'plan', 'plan_review']);
  assert.equal(checkpointEvent.details.checkpoint.lease_generation, 1);
  assert.equal(git(workingDir, ['status', '--porcelain']), '');
  const secondExecutorScript = `
    import { startDurableRuntimeOwnership } from ${JSON.stringify(new URL('../services/durable-runtime.js', import.meta.url).href)};
    const ownership = startDurableRuntimeOwnership(${JSON.stringify(sessionDir)});
    const checkpoint = ownership.resumeCheckpoint();
    if (!checkpoint || checkpoint.completed_phase !== 'plan_review' || checkpoint.lease_generation !== 1) process.exit(8);
    process.kill(process.pid, 'SIGKILL');
  `;
  const second = spawn(process.execPath, ['--input-type=module', '-e', secondExecutorScript], {
    cwd: moduleRoot,
    env,
    stdio: 'ignore',
  });
  const secondExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second executor did not recover the older checkpoint')), 10_000);
    second.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(secondExit, { code: null, signal: 'SIGKILL' });
  const replacement = spawn(process.execPath, [path.join(moduleRoot, 'bin', 'mux-runner.js'), sessionDir, '--on-failure=retry'], {
    cwd: moduleRoot,
    env,
    stdio: 'ignore',
  });
  const replacementExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replacement.kill('SIGKILL');
      reject(new Error('replacement executor did not complete'));
    }, 20_000);
    replacement.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(replacementExit, { code: 0, signal: null });
  const prompts = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).prompt);
  const phases = prompts.map((prompt) => prompt.match(/You are executing the "([^"]+)" phase/)?.[1]).filter(Boolean);
  for (const phase of ['research', 'research_review', 'plan', 'plan_review', 'implement', 'review', 'conformance']) {
    assert.equal(phases.filter((candidate) => candidate === phase).length, 1, phase);
  }
  const completed = readLogicalPipeline(sessionDir);
  assert.equal(completed.executor_restart_count, 2);
  assert.equal(completed.terminal_state, 'completed');
  assert.equal(completed.events.some((event) => event.kind === 'pipeline_cancelled'), false);
  assert.match(fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8'), /reused durable supervisor checkpoint through plan_review/);
});

test('tampered canonical supervisor evidence forces phase replay instead of context-cache fallback', async () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, { ...JSON.parse(fs.readFileSync(statePath, 'utf8')), active: true });
  const fakeBin = makeTempRoot('production-supervisor-tamper-bin-');
  createFakeCodex(fakeBin);
  const invocationLog = path.join(sessionDir, 'tamper-invocations.jsonl');
  const originalEnv = {
    PATH: process.env.PATH,
    PICKLE_TEST_MODE: process.env.PICKLE_TEST_MODE,
    PICKLE_TEST_QUALITY_COMMANDS: process.env.PICKLE_TEST_QUALITY_COMMANDS,
    FAKE_CODEX_INVOCATION_LOG: process.env.FAKE_CODEX_INVOCATION_LOG,
  };
  Object.assign(process.env, prependPath(fakeBin, { FAKE_CODEX_INVOCATION_LOG: invocationLog }));
  try {
    let planCheckpoint = null;
    await runTicket(sessionDir, 'R1', {
      runnerMode: 'pickle',
      recordDurableCheckpoint: (checkpoint) => {
        if (checkpoint.completed_phase === 'plan_review') planCheckpoint = { ...checkpoint, lease_generation: 1 };
      },
    });
    assert.ok(planCheckpoint);
    updateTicketStatus(sessionDir, 'R1', { status: 'In Progress' });
    beginRefinementRepositoryAdvance({
      sessionDir,
      workingDir,
      ticketId: 'r1',
      requiresCleanCommit: false,
    });
    const researchPath = path.join(sessionDir, 'worker-lifecycle', 'r1', 'research.json');
    fs.writeFileSync(researchPath, '{"tampered":true}\n');
    await runTicket(sessionDir, 'R1', {
      runnerMode: 'pickle',
      resumeCheckpoint: planCheckpoint,
    });
    const prompts = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).prompt);
    const phases = prompts.map((prompt) => prompt.match(/You are executing the "([^"]+)" phase/)?.[1]).filter(Boolean);
    for (const phase of ['research', 'research_review', 'plan', 'plan_review']) {
      assert.equal(phases.filter((candidate) => candidate === phase).length, 2, phase);
    }
    const restored = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    assert.equal(restored.phase, 'research');
    assert.equal(restored.ticket_id, 'r1');
    assert.match(restored.summary, /approved research/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('verified repository advance does not mutate the sealed execution-base identity', () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  const original = ensureSessionPrdSeal(sessionDir);
  fs.appendFileSync(path.join(workingDir, 'README.md'), 'verified ticket advance\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ticket advance']);
  refreshAcceptedRefinementRepositoryIdentity(sessionDir, workingDir);

  const resumed = ensureSessionPrdSeal(sessionDir);
  assert.equal(resumed.semantic_hash, original.semantic_hash);
  assert.equal(
    readLogicalPipeline(sessionDir).events.filter((event) => event.kind === 'prd_revision_requested').length,
    0,
  );
});

test('pre-launch semantic seal drift pauses for explicit human PRD approval', () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].acceptance_criteria.push('Human must approve changed semantics.');
  writeJson(manifestPath, manifest);
  writeRefinementAcceptance(sessionDir, { workingDir });
  assert.throws(() => ensureSessionPrdSeal(sessionDir), /explicit human approval/);
  assert.equal(readLogicalPipeline(sessionDir).control_state, 'prd_revision_required');
});

test('sealed runner ignores skip/abort choices and completes through autonomous retry', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let calls = 0;
  const result = await runSequential(sessionDir, { onFailure: 'skip', runnerMode: 'pickle' }, {
    runTicket: async () => {
      calls += 1;
      return calls === 1
        ? { status: 'incomplete', applied: false, reason: 'retry autonomously' }
        : { status: 'done', applied: true };
    },
    runCitadel: async (dir) => {
      const state = new StateManager().read(path.join(dir, 'state.json'));
      assert.equal(state.active, true, 'standalone mux must remain active through Citadel');
      assert.equal(state.last_exit_reason, null, 'success is not recorded before Citadel approval');
      assert.equal(readLogicalPipeline(dir).terminal_state, null);
      return await approveCitadelFixture(dir);
    },
  });
  assert.equal(result, 'success');
  assert.equal(calls, 2);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).last_exit_reason, 'success');
});

test('immediate preflight contract repair is not repeated on the next attempt', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let attempts = 0;
  let repairs = 0;
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new PreflightError({ kind: 'preflight-tool-missing', message: 'fixture tool is unavailable' });
      }
      return { status: 'done', applied: false };
    },
    repairTicketVerificationContract: async () => {
      repairs += 1;
      return [{ kind: 'process', command: process.execPath, args: ['--version'] }];
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(result, 'success');
  assert.equal(attempts, 2);
  assert.equal(repairs, 1);
});

test('workspace reconstruction restores only the journaled ticket boundary', () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  updateTicketStatus(sessionDir, 'R1', { status: 'In Progress' });
  beginRefinementRepositoryAdvance({ sessionDir, workingDir, ticketId: 'R1', requiresCleanCommit: true });
  assert.equal(readManifest(sessionDir).tickets[0].status, 'In Progress');
  fs.appendFileSync(path.join(workingDir, 'README.md'), 'unsafe worker mutation\n');
  assert.equal(readManifest(sessionDir).tickets[0].status, 'In Progress');
  const ticketId = reconstructWorkspaceFromDurableCheckpoint(sessionDir);
  assert.equal(ticketId, 'R1');
  assert.equal(git(workingDir, ['status', '--porcelain']), '');
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Todo');
  assert.throws(
    () => reconstructWorkspaceFromDurableCheckpoint(sessionDir),
    /missing-durable-checkpoint/,
  );
});

test('replacement runner reaps an identity-matched detached child before redispatch', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const identity = captureSpawnedProcessIdentity(child.pid);
  assert.ok(identity, 'failed to capture detached child identity');
  new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
    current.active_child_pid = child.pid;
    current.active_child_identity = identity;
    current.active_child_controller_pid = 999999;
    return current;
  });
  let childWasGoneAtDispatch = false;
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async () => {
      childWasGoneAtDispatch = inspectProcessLivenessIdentity(identity) !== 'matched';
      return { status: 'done', applied: true };
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(result, 'success');
  assert.equal(childWasGoneAtDispatch, true);
});

test('blue runSequential drains without deactivation and green resumes through a sealed migration to success', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let workerStarted;
  const started = new Promise((resolve) => { workerStarted = resolve; });
  const run = runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (_dir, ticketId, options) => {
      new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
        current.current_ticket = ticketId;
        current.step = 'implement';
        return current;
      });
      workerStarted();
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        options.assertDurableOwnership();
      }
    },
    runCitadel: approveCitadelFixture,
  });
  await started;
  const blue = readLogicalPipeline(sessionDir).lease;
  assert.ok(blue);
  const blueRuntime = { runtime_id: 'blue', version: '1.0.0', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
  const greenRuntime = { runtime_id: 'green', version: '2.0.0', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 2 };
  const requestId = requestRuntimeHandoff(
    sessionDir, blue.owner_id, blue.token, blueRuntime, greenRuntime, { phase: 'implement' },
  );
  releaseRuntimeHandoffLease(sessionDir, blue.owner_id, blue.token, requestId);
  const before = Date.now();
  assert.equal(await run, 'runtime_handoff');
  assert.ok(Date.now() - before < 2_000, 'blue worker did not drain promptly');
  assert.doesNotThrow(() => assertSessionOperationAvailable(sessionDir));
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
  const drained = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.equal(drained.active, true);
  assert.equal(drained.current_ticket, 'r1');
  assert.equal(drained.step, 'implement');
  assert.equal(drained.last_exit_reason, null);

  let resumed = false;
  const greenResult = await runSequential(sessionDir, {
    runnerMode: 'pickle', handoffRequestId: requestId, targetRuntime: greenRuntime,
  }, {
    runTicket: async () => {
      const state = new StateManager().read(path.join(sessionDir, 'state.json'));
      assert.equal(state.active, true);
      assert.equal(state.current_ticket, 'r1');
      assert.equal(state.step, 'implement');
      resumed = true;
      return { status: 'done', applied: true };
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(greenResult, 'success');
  assert.equal(resumed, true);
  const migration = JSON.parse(fs.readFileSync(path.join(sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  assert.equal(migration.source_runtime.runtime_id, 'blue');
  assert.equal(migration.target_runtime.runtime_id, 'green');
  assert.equal(migration.session_was_active, true);
  assert.equal(migration.resume_checkpoint.ticket_id, 'r1');
  assert.equal(migration.resume_checkpoint.phase, 'implement');
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
});

test('pipeline runtime handoff preserves its running phase until green completes it', async () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'preserve an in-flight pipeline phase across runtime handoff',
  }));
  ensurePipelineState(sessionDir);
  const blueRuntime = { runtime_id: 'blue', version: '1.0.0', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
  const greenRuntime = { runtime_id: 'green', version: '2.0.0', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 2 };
  let requestId;

  const blueResult = await runPipeline(sessionDir, {
    runSequential: async (dir) => {
      new StateManager().update(path.join(dir, 'state.json'), (current) => {
        current.current_ticket = 'r1';
        current.step = 'implement';
        return current;
      });
      const blue = readLogicalPipeline(dir).lease;
      assert.ok(blue);
      requestId = requestRuntimeHandoff(
        dir, blue.owner_id, blue.token, blueRuntime, greenRuntime, { phase: 'implement' },
      );
      releaseRuntimeHandoffLease(dir, blue.owner_id, blue.token, requestId);
      return 'runtime_handoff';
    },
  });
  assert.equal(blueResult, 'runtime_handoff');
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).active, true);
  assert.equal(readPipelineState(sessionDir).current_phase, 'pickle');
  assert.equal(readPipelineState(sessionDir).phase_statuses.pickle, 'running');

  const greenResult = await runPipeline(sessionDir, {
    handoffRequestId: requestId,
    targetRuntime: greenRuntime,
    runSequential: async (dir) => {
      updateTicketStatus(dir, 'R1', { status: 'Done' });
      return 'success';
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(greenResult, 'success');
  assert.equal(fs.existsSync(path.join(sessionDir, 'installed-runtime-migration.json')), true);
  assert.equal(readPipelineState(sessionDir).phase_statuses.pickle, 'done');
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
});

test('Citadel approval is invalidated by any later repository commit', async () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  await approveCitadelFixture(sessionDir);
  assert.doesNotThrow(() => assertCitadelReleaseApproval(sessionDir));
  fs.appendFileSync(path.join(workingDir, 'README.md'), 'post-approval mutation\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'stale approval']);
  assert.throws(() => assertCitadelReleaseApproval(sessionDir), /fresh Citadel approval/);
});

test('standalone mux carries exact Citadel refusal evidence into autonomous remediation and approval', async () => {
  const { sessionDir, workingDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let ticketRuns = 0;
  let citadelRuns = 0;
  let remediationPrompt = '';
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (dir, ticketId) => {
      ticketRuns += 1;
      if (ticketRuns === 2) {
        const ticket = readManifest(dir).tickets.find((entry) => entry.id === ticketId);
        assert.ok(ticket);
        remediationPrompt = buildTicketPhasePrompt({
          phase: 'implement', ticket, sessionDir: dir, workingDir,
        });
      }
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done', applied: true };
    },
    runCitadel: async (dir) => {
      citadelRuns += 1;
      if (citadelRuns > 1) return await approveCitadelFixture(dir);
      writeJson(path.join(dir, 'citadel-report.json'), {
        schema_version: 1,
        verdict: 'block',
        reviewed_range: 'fixture..HEAD',
        acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(dir),
        findings: [{
          severity: 'high',
          title: 'Release evidence is incomplete.',
          evidence: 'AC-RUNTIME-01 has no restart proof.',
          recommendation: 'Add a restart integration that preserves the refusal evidence.',
        }],
        generated_at: new Date().toISOString(),
      });
      return 'citadel-blocked';
    },
  });
  assert.equal(result, 'success');
  assert.equal(ticketRuns, 2);
  assert.equal(citadelRuns, 2);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  const ticket = readManifest(sessionDir).tickets[0];
  assert.equal(ticket.status, 'Done');
  assert.equal(ticket.failure_kind, 'citadel_refused');
  assert.match(remediationPrompt, /Release evidence is incomplete\./);
  assert.match(remediationPrompt, /AC-RUNTIME-01 has no restart proof\./);
  assert.match(remediationPrompt, /Add a restart integration that preserves the refusal evidence\./);
  assert.match(remediationPrompt, /citadel-report-/);
  assert.match(remediationPrompt, /The launched runner renews exclusive durable ownership\./);
  assert.equal(fs.readdirSync(path.join(sessionDir, 'citadel-remediation')).length, 1);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-current.json')), true);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});

test('standalone mux keeps unowned deterministic system blocks in autonomous diagnostic recovery', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let citadelRuns = 0;
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runCitadel: async (dir) => {
      citadelRuns += 1;
      writeCitadelSystemBlock(dir);
      return 'citadel-system-blocked';
    },
    runDeterministicRecoveryDiagnostic: async () => ({ kind: 'retry_scheduled', reason: 'fixture diagnostic retry' }),
  });

  assert.equal(result, 'citadel_system_recovery_scheduled');
  assert.equal(muxRunnerExitFailed(result), false);
  assert.equal(citadelRuns, 1, 'restart_executor escalation must not hot-loop in one executor');
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Done');
  assert.notEqual(readLogicalPipeline(sessionDir).control_state, 'prd_revision_required');
  const diagnostic = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-deterministic-recovery.json'), 'utf8',
  ));
  assert.equal(diagnostic.status, 'diagnostic_scheduled');
  assert.match(diagnostic.diagnostic_reason, /no ticket owner/i);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-report.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-attribution-repair.json')), false);
});

test('unowned deterministic diagnostic isolates malicious mutations and enqueues strict narrow recovery', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  writeCitadelSystemBlock(sessionDir, {
    evidence: 'global check output points to the runtime ownership ticket',
    checks: [{ command: 'npm test', status: 'failed', exit_code: 9, output: 'runtime ownership fixture failed' }],
  });
  const block = readCitadelSystemBlock(sessionDir);
  assert.equal(consumeDeterministicCheckFailure(sessionDir, block).kind, 'diagnostic_recovery_scheduled');
  let calls = 0;
  const diagnosticWorktrees = [];
  const liveHead = git(workingDir, ['rev-parse', 'HEAD']);
  const liveReadme = fs.readFileSync(path.join(workingDir, 'README.md'), 'utf8');
  const diagnostic = await runDeterministicRecoveryDiagnostic(sessionDir, {
    runCodex: async ({ cwd, prompt }) => {
      calls += 1;
      diagnosticWorktrees.push(cwd);
      assert.notEqual(cwd, workingDir);
      fs.writeFileSync(path.join(cwd, 'README.md'), `malicious diagnostic mutation ${calls}\n`);
      fs.writeFileSync(path.join(cwd, 'diagnostic-malware.txt'), 'must be discarded\n');
      execFileSync('git', ['add', 'README.md', 'diagnostic-malware.txt'], { cwd });
      execFileSync('git', [
        '-c', 'user.name=Malicious Diagnostic', '-c', 'user.email=malicious@example.invalid',
        'commit', '-qm', `malicious diagnostic commit ${calls}`,
      ], { cwd });
      const artifactPath = prompt.match(/Write diagnostic mapping artifact: ([^\n]+)/)?.[1]?.trim();
      const failureIdentity = prompt.match(/Failure identity: ([a-f0-9]+)/)?.[1];
      fs.writeFileSync(artifactPath, JSON.stringify(calls === 1 ? {
        schema_version: 1,
        failure_identity: failureIdentity,
        mappings: [{ ticket_id: 'missing-ticket' }],
      } : {
        schema_version: 1,
        failure_identity: failureIdentity,
        mappings: [{
          ticket_id: 'R1',
          check_commands: ['npm test'],
          acceptance_criteria: ['The launched runner renews exclusive durable ownership.'],
          paths: ['README.md'],
          rationale: 'The global test diagnostic names the runtime ownership fixture implemented by R1.',
        }],
      }));
      return {
        command: 'codex', args: [], exitCode: 0, stdout: '', stderr: '', timedOut: false,
        durationMs: 1, lastMessage: '',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        usageReported: true, terminatedAfterSuccess: false, cancelled: false,
        outputFormat: 'plain-text', assistantContent: '', toolCalls: [],
      };
    },
  });
  assert.deepEqual(diagnostic, { kind: 'resolved', ticket_ids: ['r1'] });
  assert.equal(calls, 2);
  assert.equal(git(workingDir, ['rev-parse', 'HEAD']), liveHead);
  assert.equal(git(workingDir, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(workingDir, 'README.md'), 'utf8'), liveReadme);
  assert.equal(fs.existsSync(path.join(workingDir, 'diagnostic-malware.txt')), false);
  assert.equal(diagnosticWorktrees.every((worktree) => !fs.existsSync(worktree)), true);
  const ticket = readManifest(sessionDir).tickets[0];
  assert.equal(ticket.status, 'Todo');
  assert.match(ticket.recovery_task, /runtime ownership fixture failed/);
  assert.match(ticket.recovery_task, /README\.md/);
  const journal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-deterministic-recovery.json'), 'utf8',
  ));
  assert.deepEqual(journal.diagnostic_attempts.map(({ status }) => status), ['rejected', 'resolved']);
  assert.notEqual(journal.diagnostic_attempts[0].strategy_hash, journal.diagnostic_attempts[1].strategy_hash);
  assert.deepEqual(journal.resolved_mappings[0].check_commands, ['npm test']);
});

test('deterministic system recovery uses five material ticket strategies then a novel autonomous diagnostic', () => {
  const { sessionDir } = createAcceptedSession('Done');
  writeCitadelSystemBlock(sessionDir, {
    evidence: 'node verification emitted exact diagnostic alpha',
    checks: [{
      command: "node -e 'process.exit(0)'",
      status: 'failed',
      exit_code: 7,
      output: 'exact diagnostic alpha',
    }],
  });
  const block = readCitadelSystemBlock(sessionDir);
  const strategies = [];
  for (let restart = 0; restart < 5; restart += 1) {
    const recovery = consumeDeterministicCheckFailure(sessionDir, block);
    assert.equal(recovery.kind, 'verification_repair_scheduled');
    strategies.push(recovery.strategy_hash);
    const ticket = readManifest(sessionDir).tickets[0];
    assert.equal(ticket.status, 'Todo');
    assert.match(ticket.recovery_task, /exact diagnostic alpha/);
    assert.match(ticket.recovery_task, /node -e 'process\.exit\(0\)'/);
  }
  assert.equal(new Set(strategies).size, 5);
  const boundary = consumeDeterministicCheckFailure(sessionDir, block);
  assert.equal(boundary.kind, 'diagnostic_recovery_scheduled');
  assert.match(boundary.reason, /strategies are exhausted/i);
  const journal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-deterministic-recovery.json'), 'utf8',
  ));
  assert.equal(journal.status, 'diagnostic_scheduled');
  assert.equal(journal.attempts.length, 6);
  assert.match(journal.evidence, /exact diagnostic alpha/);
  assert.equal(journal.failed_checks[0].output, 'exact diagnostic alpha');

  writeCitadelSystemBlock(sessionDir, {
    evidence: 'node verification emitted exact diagnostic beta',
    checks: [{
      command: "node -e 'process.exit(0)'", status: 'failed', exit_code: 7, output: 'exact diagnostic beta',
    }],
  });
  const changedEvidence = consumeDeterministicCheckFailure(sessionDir, readCitadelSystemBlock(sessionDir));
  assert.equal(changedEvidence.kind, 'verification_repair_scheduled');
  const changedJournal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-deterministic-recovery.json'), 'utf8',
  ));
  assert.notEqual(changedJournal.failure_identity, journal.failure_identity);
  assert.equal(changedJournal.attempts.length, 1);
});

test('mixed owned and unowned failed commands require diagnostic attribution', () => {
  const { sessionDir } = createAcceptedSession('Done');
  writeCitadelSystemBlock(sessionDir, {
    evidence: 'one ticket check and one global check failed together',
    checks: [
      { command: "node -e 'process.exit(0)'", status: 'failed', exit_code: 7, output: 'owned failure' },
      { command: 'npm test', status: 'failed', exit_code: 8, output: 'unowned failure' },
    ],
  });
  const recovery = consumeDeterministicCheckFailure(sessionDir, readCitadelSystemBlock(sessionDir));
  assert.equal(recovery.kind, 'diagnostic_recovery_scheduled');
  assert.match(recovery.reason, /at least one failed deterministic command has no ticket owner/i);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Done');
});

test('replacement diagnostic reaps orphan and resumes with a unique durable ordinal', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  writeCitadelSystemBlock(sessionDir, {
    evidence: 'orphaned global diagnostic needs replacement',
    checks: [{ command: 'npm test', status: 'failed', exit_code: 9, output: 'orphaned diagnostic' }],
  });
  consumeDeterministicCheckFailure(sessionDir, readCitadelSystemBlock(sessionDir));
  const journalPath = path.join(sessionDir, 'citadel-deterministic-recovery.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.diagnostic_attempts = [{
    ordinal: 1,
    strategy_id: 'strict-evidence-attribution-1',
    strategy_hash: 'a'.repeat(64),
    status: 'started',
    artifact_path: path.join(sessionDir, 'stale-diagnostic.json'),
    attempted_at: new Date().toISOString(),
  }];
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const identity = captureSpawnedProcessIdentity(child.pid);
  assert.ok(identity);
  new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
    current.active_child_pid = child.pid;
    current.active_child_kind = 'codex';
    current.active_child_command = 'citadel-deterministic-diagnostic-1';
    current.active_child_identity = identity;
    current.active_child_controller_pid = 999999;
    return current;
  });

  const result = await runDeterministicRecoveryDiagnostic(sessionDir, {
    runCodex: async ({ prompt }) => {
      const artifactPath = prompt.match(/Write diagnostic mapping artifact: ([^\n]+)/)?.[1]?.trim();
      const failureIdentity = prompt.match(/Failure identity: ([a-f0-9]+)/)?.[1];
      fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        failure_identity: failureIdentity,
        mappings: [{
          ticket_id: 'R1', check_commands: ['npm test'],
          acceptance_criteria: ['The launched runner renews exclusive durable ownership.'],
          paths: ['README.md'], rationale: 'The preserved diagnostic identifies R1 ownership.',
        }],
      }));
      return {
        command: 'codex', args: [], exitCode: 0, stdout: '', stderr: '', timedOut: false,
        durationMs: 1, lastMessage: '',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        usageReported: true, terminatedAfterSuccess: false, cancelled: false,
        outputFormat: 'plain-text', assistantContent: '', toolCalls: [],
      };
    },
  });
  assert.deepEqual(result, { kind: 'resolved', ticket_ids: ['r1'] });
  assert.notEqual(inspectProcessLivenessIdentity(identity), 'matched');
  const recovered = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.deepEqual(recovered.diagnostic_attempts.map(({ ordinal, status }) => ({ ordinal, status })), [
    { ordinal: 1, status: 'interrupted' },
    { ordinal: 2, status: 'resolved' },
  ]);
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).active_child_pid, null);
});

test('standalone mux converges across restart after exact-owner deterministic recovery', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const firstRun = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runCitadel: async (dir) => {
      writeCitadelSystemBlock(dir, {
        evidence: 'exact owner diagnostic from sealed verification',
        checks: [{
          command: "node -e 'process.exit(0)'",
          status: 'failed',
          exit_code: 7,
          output: 'exact owner diagnostic from sealed verification',
        }],
      });
      return 'citadel-system-blocked';
    },
  });
  assert.equal(firstRun, 'citadel_system_recovery_scheduled');
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Todo');

  let repairedTickets = 0;
  const secondRun = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (dir, ticketId) => {
      repairedTickets += 1;
      const ticket = readManifest(dir).tickets.find((candidate) => candidate.id === ticketId);
      assert.match(ticket.recovery_task, /exact owner diagnostic from sealed verification/);
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done' };
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(secondRun, 'success');
  assert.equal(repairedTickets, 1);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Done');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});

test('standalone mux consumes reviewer artifact-contract recovery and retries Citadel', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let citadelRuns = 0;
  let recoveryCalls = 0;
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runCitadel: async (dir) => {
      citadelRuns += 1;
      if (citadelRuns === 1) {
        writeCitadelSystemBlock(dir, {
          code: 'reviewer_artifact_strategy_exhausted',
          title: 'Citadel reviewer artifact strategies require contract reconstruction',
          evidence: `All bounded reviewer artifact strategies are exhausted for review ${'a'.repeat(64)}.`,
          recommendation: 'Run a strict artifact-contract diagnostic.',
          recovery_action: 'repair_reviewer_artifact_contract',
          recovery_ticket_ids: [],
        });
        return 'citadel-system-blocked';
      }
      return await approveCitadelFixture(dir);
    },
    repairCitadelReviewerArtifactContract: async (dir) => {
      recoveryCalls += 1;
      writeJson(path.join(dir, 'citadel-review-state.json'), {
        schema_version: 1,
        review_identity: 'a'.repeat(64),
        recovery_epoch: 6,
        strategy_id: 'artifact-contract-reconstruction',
        strategy_hash: '',
        status: 'running',
        attempts: [],
        artifact_contract_recovery: { status: 'resolved' },
        updated_at: new Date().toISOString(),
      });
      return { kind: 'resolved', diagnostic_identity: 'd'.repeat(64) };
    },
  });

  assert.equal(result, 'success');
  assert.equal(citadelRuns, 2);
  assert.equal(recoveryCalls, 1);
  assert.match(
    fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8'),
    /Resolved Citadel reviewer contract diagnostic/,
  );
});

test('pipeline routes Citadel PRD-contract system blocks to the authorized human boundary', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'route a Citadel PRD contract failure',
  }));
  ensurePipelineState(sessionDir);

  const result = await runPipeline(sessionDir, {
    runSequential: async () => 'success',
    runCitadel: async (dir) => {
      writeCitadelSystemBlock(dir, {
        category: 'contract',
        code: 'acceptance_criteria_missing',
        title: 'Citadel has no acceptance criteria to verify',
        evidence: 'The accepted PRD contract contains no acceptance criteria.',
        recommendation: 'Approve a revised PRD with machine-checkable acceptance criteria.',
        checks: [],
        recovery_action: 'request_prd_revision',
        attempt: 1,
        bounded_attempt: 1,
        next_action: 'retry_phase',
      });
      return 'citadel-system-blocked';
    },
  });

  assert.equal(result, 'prd_revision_required');
  assert.equal(pipelineExitFailed(result), false);
  assert.equal(readLogicalPipeline(sessionDir).control_state, 'prd_revision_required');
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Done');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});

test('pipeline resumes a material Citadel verification-contract repair across executor restart', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'recover an unavailable deterministic gate',
  }));
  ensurePipelineState(sessionDir);
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const missing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete missing.tickets[0].verification;
  writeJson(manifestPath, missing);
  let repairCalls = 0;

  await assert.rejects(() => runPipeline(sessionDir, {
    runSequential: async () => 'success',
    runCitadel: async (dir) => {
      writeCitadelSystemBlock(dir, {
        code: 'deterministic_gate_unavailable',
        title: 'Citadel deterministic gate unavailable',
        evidence: 'R1 has no substantive verification command.',
        recommendation: 'Reconstruct R1 verification from its sealed contract.',
        checks: [{ command: 'git diff --check', status: 'passed', exit_code: 0, output: '' }],
        recovery_action: 'repair_verification_contract',
        recovery_ticket_ids: ['R1'],
        attempt: 1,
        bounded_attempt: 1,
        next_action: 'retry_phase',
      });
      return 'citadel-system-blocked';
    },
    repairTicketVerificationContract: async (dir, ticketId, options) => {
      repairCalls += 1;
      assert.equal(ticketId, 'R1');
      assert.ok(options.strategy?.strategyHash);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.tickets[0].verification = ['node -e "process.exit(0)"'];
      manifest.tickets[0].status = 'Todo';
      writeJson(manifestPath, manifest);
      restructureTicketFiles(dir, manifest);
      throw new Error('simulated executor loss after durable materialization');
    },
  }), /simulated executor loss/);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Todo');
  assert.equal(readManifest(sessionDir).tickets[0].verification.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-system-block.json'), 'utf8')).recovery_action, 'repair_verification_contract');

  const rerunTickets = [];
  const result = await runPipeline(sessionDir, {
    runSequential: async (dir) => {
      assert.equal(readPipelineState(dir).current_phase, 'pickle');
      assert.equal(readManifest(dir).tickets[0].status, 'Todo');
      for (const ticket of readManifest(dir).tickets.filter(({ status }) => status === 'Todo')) {
        rerunTickets.push(ticket.id);
        updateTicketStatus(dir, ticket.id, { status: 'Done' });
      }
      return 'success';
    },
    runCitadel: approveCitadelFixture,
  });

  assert.equal(result, 'success');
  assert.equal(repairCalls, 1);
  assert.deepEqual(rerunTickets, ['r1']);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});

test('sealed pipeline repairs a malformed authorized verifier and reaches real Citadel approval', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  prepareSealedVerificationRepairPipeline(
    sessionDir,
    workingDir,
    'repair a malformed sealed verifier and complete the real release gate',
  );
  const fakeBin = makeTempRoot('production-supervisor-citadel-repair-bin-');
  const dataRoot = makeTempRoot('production-supervisor-citadel-repair-data-');
  createFakeCodex(fakeBin);
  const rerunTickets = [];
  let sequentialRuns = 0;

  const result = await withProcessEnvironment(prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot }), async () => (
    await runPipeline(sessionDir, {
      runSequential: async (dir) => {
        sequentialRuns += 1;
        if (sequentialRuns === 1) return 'success';
        for (const ticket of readManifest(dir).tickets.filter(({ status }) => status === 'Todo')) {
          rerunTickets.push(ticket.id);
          updateTicketStatus(dir, ticket.id, { status: 'Done' });
        }
        return 'success';
      },
    })
  ));

  assert.equal(result, 'success');
  assert.equal(sequentialRuns, 2);
  assert.deepEqual(rerunTickets, ['r1']);
  assert.deepEqual(readManifest(sessionDir).tickets[0].verification, [
    { kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] },
  ]);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  assert.equal(readCitadelSystemBlock(sessionDir), null);
  assert.doesNotThrow(() => assertCitadelReleaseApproval(sessionDir));
});

test('pipeline re-enters durable sealed verification repair after a crash before materialization', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  prepareSealedVerificationRepairPipeline(
    sessionDir,
    workingDir,
    'survive a contract-repair crash before manifest materialization',
  );
  const fakeBin = makeTempRoot('production-supervisor-pre-materialization-bin-');
  const dataRoot = makeTempRoot('production-supervisor-pre-materialization-data-');
  createFakeCodex(fakeBin);
  const transactionPath = path.join(sessionDir, 'verification-contract-repair-transaction.json');
  let repairCalls = 0;
  const crashOnceRepair = async (dir, ticketId, options) => {
    repairCalls += 1;
    return await repairTicketVerificationContract(dir, ticketId, {
      ...options,
      ...(repairCalls === 1
        ? { beforeMaterialization: () => { throw new Error('simulated crash before materialization'); } }
        : {}),
    });
  };
  const environment = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });

  await assert.rejects(
    () => withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
      runSequential: async () => 'success',
      repairTicketVerificationContract: crashOnceRepair,
    })),
    /simulated crash before materialization/,
  );
  assert.equal(repairCalls, 1);
  assert.equal(fs.existsSync(transactionPath), true);
  const interruptedManifest = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'refinement_manifest.json'),
    'utf8',
  ));
  assert.equal(typeof interruptedManifest.tickets[0].verification[0].args, 'string');
  assert.equal(readCitadelSystemBlock(sessionDir)?.recovery_action, 'repair_verification_contract');

  const rerunTickets = [];
  const result = await withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
    repairTicketVerificationContract: crashOnceRepair,
    runSequential: async (dir) => {
      for (const ticket of readManifest(dir).tickets.filter(({ status }) => status === 'Todo')) {
        rerunTickets.push(ticket.id);
        updateTicketStatus(dir, ticket.id, { status: 'Done' });
      }
      return 'success';
    },
  }));

  assert.equal(result, 'success');
  assert.equal(repairCalls, 2);
  assert.deepEqual(rerunTickets, ['r1']);
  assert.equal(fs.existsSync(transactionPath), false);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  assert.equal(readCitadelSystemBlock(sessionDir), null);
  assert.doesNotThrow(() => assertCitadelReleaseApproval(sessionDir));
  assert.match(
    fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf8'),
    /Re-entered durable Citadel verification-contract repair before phase dispatch/,
  );
});

test('pipeline resumes a real reviewer contract diagnostic beyond five exhausted strategy epochs', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  const reviewBase = git(workingDir, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(workingDir, 'README.md'), '\ncriterion shard repository evidence\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'add criterion shard repository evidence',
  ]);
  const expectedReviewHead = git(workingDir, ['rev-parse', 'HEAD']);
  const reviewedRange = `${reviewBase}..HEAD`;
  const liveReadmeBefore = fs.readFileSync(path.join(workingDir, 'README.md'), 'utf8');
  const liveStatusBefore = git(workingDir, ['status', '--porcelain=v1', '--untracked-files=all']);
  refreshAcceptedRefinementRepositoryIdentity(sessionDir, workingDir);
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'recover the Citadel reviewer artifact contract beyond its fixed strategy catalog',
  }));
  ensurePipelineState(sessionDir);
  const reviewIdentity = 'a'.repeat(64);
  writeJson(path.join(sessionDir, 'citadel-review-state.json'), {
    schema_version: 1,
    review_identity: reviewIdentity,
    recovery_epoch: 5,
    strategy_id: 'adversarial-two-pass',
    strategy_hash: 'b'.repeat(64),
    status: 'diagnostic_scheduled',
    attempts: Array.from({ length: 10 }, (_, index) => ({
      ordinal: index + 1,
      epoch: Math.floor(index / 2) + 1,
      attempt: index % 2 + 1,
      candidate_path: path.join(sessionDir, `invalid-${index + 1}.json`),
      candidate_hash: (index + 1).toString(16).padStart(64, '0'),
      status: 'rejected',
      strategy_id: `catalog-${Math.floor(index / 2) + 1}`,
      material_strategy_hash: (index + 11).toString(16).padStart(64, '0'),
      strategy_hash: (index + 21).toString(16).padStart(64, '0'),
      retry_feedback: 'findings must be an array',
      validation_error: 'findings must be an array',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })),
    updated_at: new Date().toISOString(),
  });
  const fakeBin = makeTempRoot('production-supervisor-reviewer-recovery-bin-');
  const dataRoot = makeTempRoot('production-supervisor-reviewer-recovery-data-');
  const invocationLog = path.join(sessionDir, 'reviewer-recovery-invocations.jsonl');
  const shardCounter = path.join(sessionDir, 'reviewer-shard-attempt-count.txt');
  createFakeCodex(fakeBin);
  const environment = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CRITERION_SHARD_COUNTER: shardCounter,
    FAKE_CRITERION_SHARD_MALFORMED_ATTEMPTS: '3',
  });
  let citadelRuns = 0;
  const runCitadel = async (dir) => {
    citadelRuns += 1;
    if (citadelRuns === 1) {
      writeCitadelSystemBlock(dir, {
        code: 'reviewer_artifact_strategy_exhausted',
        title: 'Citadel reviewer artifact strategies require contract reconstruction',
        evidence: `All bounded reviewer artifact strategies are exhausted for review ${reviewIdentity}.\nLast validation failure: findings must be an array`,
        recommendation: 'Run a strict artifact-contract diagnostic.',
        recovery_action: 'repair_reviewer_artifact_contract',
        recovery_ticket_ids: [],
        attempt: 1,
        recovery_epoch: 1,
        bounded_attempt: 1,
        next_action: 'retry_phase',
        reviewed_range: reviewedRange,
      });
      return 'citadel-system-blocked';
    }
    const recovered = JSON.parse(fs.readFileSync(path.join(dir, 'citadel-review-state.json'), 'utf8'));
    if (citadelRuns === 2) {
      assert.equal(recovered.recovery_epoch, 6);
      assert.equal(recovered.strategy_id, 'artifact-contract-reconstruction');
      assert.equal(recovered.artifact_contract_recovery.mechanism, 'schema_scaffold_replay');
      assert.equal(recovered.artifact_contract_recovery.failed_candidate_hashes.length, 10);
      const runtime = recovered.artifact_contract_recovery.runtime_artifacts;
      assert.equal(fs.existsSync(runtime.scaffold_path), true);
      assert.equal(fs.existsSync(runtime.validator_path), true);
      assert.equal(fs.existsSync(runtime.manifest_path), true);
      const validatorCandidate = path.join(dir, 'reviewer-validator-candidate.json');
      writeJson(validatorCandidate, {
        schema_version: 1,
        verdict: 'approve',
        reviewed_range: reviewedRange,
        acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(dir),
        findings: [],
        generated_at: new Date().toISOString(),
      });
      execFileSync(process.execPath, [runtime.validator_path, validatorCandidate]);
      fs.rmSync(validatorCandidate, { force: true });
      recovered.status = 'diagnostic_scheduled';
      recovered.attempts.push(...[101, 102].map((ordinal) => ({
        ordinal,
        epoch: 6,
        attempt: ordinal - 100,
        candidate_path: path.join(dir, `failed-reconstruction-${ordinal}.json`),
        candidate_hash: ordinal.toString(16).padStart(64, '0'),
        status: 'rejected',
        strategy_id: 'artifact-contract-reconstruction',
        material_strategy_hash: 'c'.repeat(64),
        strategy_hash: ordinal.toString(16).padStart(64, '0'),
        retry_feedback: 'reconstructed candidate still violates the canonical schema',
        validation_error: 'reconstructed candidate still violates the canonical schema',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })));
      writeJson(path.join(dir, 'citadel-review-state.json'), recovered);
      writeCitadelSystemBlock(dir, {
        code: 'reviewer_artifact_strategy_exhausted',
        title: 'Citadel reviewer artifact reconstruction requires a new mechanism',
        evidence: `Schema-scaffold reconstruction failed for review ${reviewIdentity}.`,
        recommendation: 'Use the next unused closed artifact reconstruction mechanism.',
        recovery_action: 'repair_reviewer_artifact_contract',
        recovery_ticket_ids: [],
        reviewed_range: reviewedRange,
      });
      return 'citadel-system-blocked';
    }
    if (citadelRuns === 3) {
      assert.equal(recovered.recovery_epoch, 7);
      assert.equal(recovered.artifact_contract_recovery.mechanism, 'evidence_bundle_reconstruction');
      assert.deepEqual(recovered.artifact_contract_recovery.mechanism_history, [
        'schema_scaffold_replay',
        'evidence_bundle_reconstruction',
      ]);
      assert.equal(fs.existsSync(recovered.artifact_contract_recovery.runtime_artifacts.evidence_bundle_path), true);
      recovered.status = 'diagnostic_scheduled';
      recovered.attempts.push({
        ordinal: 103,
        epoch: 7,
        attempt: 1,
        candidate_path: path.join(dir, 'failed-evidence-reconstruction.json'),
        candidate_hash: '9'.repeat(64),
        status: 'rejected',
        strategy_id: 'artifact-contract-reconstruction',
        material_strategy_hash: '8'.repeat(64),
        strategy_hash: '7'.repeat(64),
        retry_feedback: 'evidence reconstruction remained invalid',
        validation_error: 'evidence reconstruction remained invalid',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      writeJson(path.join(dir, 'citadel-review-state.json'), recovered);
      writeCitadelSystemBlock(dir, {
        code: 'reviewer_artifact_strategy_exhausted',
        title: 'Citadel reviewer artifact reconstruction requires criterion sharding',
        evidence: `Evidence-bundle reconstruction failed for review ${reviewIdentity}.`,
        recommendation: 'Execute the criterion-sharded review recovery plan.',
        recovery_action: 'repair_reviewer_artifact_contract',
        recovery_ticket_ids: [],
        reviewed_range: reviewedRange,
      });
      return 'citadel-system-blocked';
    }
    assert.equal(recovered.recovery_epoch, 8);
    assert.equal(recovered.artifact_contract_recovery.mechanism, 'criterion_sharded_reconstruction');
    assert.deepEqual(recovered.artifact_contract_recovery.mechanism_history, [
      'schema_scaffold_replay',
      'evidence_bundle_reconstruction',
      'criterion_sharded_reconstruction',
    ]);
    const shardBundlePath = recovered.artifact_contract_recovery.runtime_artifacts.criterion_shard_bundle_path;
    const shardBundle = JSON.parse(fs.readFileSync(shardBundlePath, 'utf8'));
    assert.deepEqual(shardBundle.acceptance_criteria, deriveCitadelAcceptanceCriteria(dir));
    assert.equal(shardBundle.results.length, deriveCitadelAcceptanceCriteria(dir).length);
    assert.equal(shardBundle.results.every(({ status, evidence }) => status === 'pass' && evidence.length > 0), true);
    assert.equal(shardBundle.results.every((shard) => shard.checkpoint_head === expectedReviewHead), true);
    assert.equal(shardBundle.results.every((shard) => shard.reviewed_range === reviewedRange), true);
    assert.equal(shardBundle.results.every((shard) => shard.repository_paths.includes('README.md')), true);
    assert.equal(shardBundle.results.every((shard) => shard.checks_cited.includes('npm test')), true);
    assert.equal(shardBundle.results.every((shard) => shard.evidence.some((entry) => (
      entry.includes('README.md') && entry.includes('criterion shard repository evidence')
    ))), true);
    assert.equal(fs.existsSync(path.join(dir, 'citadel-report.json')), false);
    return await approveCitadelFixture(dir);
  };
  let recoveryCalls = 0;
  const crashOnceRecovery = async (dir, block, options) => {
    recoveryCalls += 1;
    return await repairCitadelReviewerArtifactContract(dir, block, {
      ...options,
      ...(recoveryCalls === 1
        ? { faultInjection: () => { throw new Error('simulated reviewer diagnostic executor loss'); } }
        : {}),
    });
  };

  await assert.rejects(
    () => withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
      runSequential: async () => 'success',
      runCitadel,
      repairCitadelReviewerArtifactContract: crashOnceRecovery,
    })),
    /Injected failure before reviewer recovery resolution/,
  );
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-report.json')), false);
  const interrupted = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'),
    'utf8',
  ));
  assert.equal(interrupted.status, 'started');
  assert.equal(interrupted.attempts[0].status, 'started');

  const scheduled = await withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
    runSequential: async () => 'success',
    runCitadel,
    repairCitadelReviewerArtifactContract: crashOnceRecovery,
  }));
  assert.equal(scheduled, 'citadel_system_recovery_scheduled');
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
  const pendingRecovery = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'),
    'utf8',
  ));
  const pendingShardJournal = JSON.parse(fs.readFileSync(path.join(
    sessionDir,
    'citadel-reviewer-contract-runtime',
    pendingRecovery.diagnostic_identity,
    'criterion-shard-journal.json',
  ), 'utf8'));
  assert.equal(pendingShardJournal.status, 'pending');
  assert.deepEqual(pendingShardJournal.shards[0].attempts.map(({ status }) => status), ['rejected']);
  assert.equal(pendingShardJournal.shards[0].attempts[0].strategy_id, 'direct_repository_evidence');
  for (const expectedAttempts of [2, 3]) {
    const continued = await withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
      runSequential: async () => 'success',
      runCitadel,
      repairCitadelReviewerArtifactContract: crashOnceRecovery,
    }));
    assert.equal(continued, 'citadel_system_recovery_scheduled');
    assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
    const continuedShardJournal = JSON.parse(fs.readFileSync(path.join(
      sessionDir,
      'citadel-reviewer-contract-runtime',
      pendingRecovery.diagnostic_identity,
      'criterion-shard-journal.json',
    ), 'utf8'));
    assert.equal(continuedShardJournal.shards[0].attempts.length, expectedAttempts);
    assert.equal(continuedShardJournal.shards[0].attempts.at(-1).status, 'rejected');
  }
  const preRebootShardJournal = JSON.parse(fs.readFileSync(path.join(
    sessionDir,
    'citadel-reviewer-contract-runtime',
    pendingRecovery.diagnostic_identity,
    'criterion-shard-journal.json',
  ), 'utf8'));
  assert.equal(preRebootShardJournal.shards[0].attempts.every((attempt) => (
    path.resolve(attempt.candidate_path).startsWith(`${path.resolve(sessionDir)}${path.sep}`)
    && (attempt.strategy_artifact_path === null
      || path.resolve(attempt.strategy_artifact_path).startsWith(`${path.resolve(sessionDir)}${path.sep}`))
  )), true);
  for (const attempt of preRebootShardJournal.shards[0].attempts) {
    if (attempt.worktree_path && !path.resolve(attempt.worktree_path).startsWith(`${path.resolve(sessionDir)}${path.sep}`)) {
      fs.rmSync(path.dirname(attempt.worktree_path), { recursive: true, force: true });
    }
  }
  const result = await withProcessEnvironment(environment, async () => await runPipeline(sessionDir, {
    runSequential: async () => 'success',
    runCitadel,
    repairCitadelReviewerArtifactContract: crashOnceRecovery,
  }));
  assert.equal(result, 'success');
  assert.equal(citadelRuns, 4);
  assert.equal(recoveryCalls, 7);
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line));
  const recoveryPrompts = invocations
    .map(({ prompt }) => prompt)
    .filter((prompt) => prompt.includes('reviewer artifact-contract recovery worker'));
  assert.equal(recoveryPrompts.length, 3);
  const shardInvocations = invocations
    .filter(({ prompt }) => prompt.includes('criterion-shard review worker'));
  assert.equal(shardInvocations.length, deriveCitadelAcceptanceCriteria(sessionDir).length + 3);
  assert.deepEqual(
    shardInvocations.slice(0, 4).map(({ prompt }) => (
      prompt.match(/Execution strategy ID: ([^\n]+)/)?.[1]
    )),
    [
      'direct_repository_evidence',
      'runtime_citation_scaffold',
      'authenticated_diff_inventory_two_pass',
      'failure_bound_evidence_replan',
    ],
  );
  assert.equal(new Set(shardInvocations.slice(0, 4).map(({ prompt }) => (
    prompt.match(/Strategy material hash: ([a-f0-9]{64})/)?.[1]
  ))).size, 4);
  const finalShardJournal = JSON.parse(fs.readFileSync(path.join(
    sessionDir,
    'citadel-reviewer-contract-runtime',
    pendingRecovery.diagnostic_identity,
    'criterion-shard-journal.json',
  ), 'utf8'));
  const firstShardAttempts = finalShardJournal.shards[0].attempts;
  assert.equal(finalShardJournal.bounded_strategy_limit, 3);
  assert.equal(finalShardJournal.replan_after_attempt, 3);
  assert.deepEqual(firstShardAttempts.map(({ status }) => status), [
    'rejected', 'rejected', 'rejected', 'resolved',
  ]);
  assert.equal(firstShardAttempts.every((attempt) => (
    /^[a-f0-9]{64}$/.test(attempt.candidate_sha256)
    && (fs.statSync(attempt.candidate_path).mode & 0o777) === 0o400
  )), true);
  assert.equal(new Set(firstShardAttempts.map(({ strategy_material_hash }) => strategy_material_hash)).size, 4);
  assert.deepEqual(firstShardAttempts.map(({ evidence_route }) => evidence_route), [
    'direct_review', 'preseeded_citation', 'diff_inventory', 'replanned_evidence_inventory',
  ]);
  assert.equal(firstShardAttempts.slice(1).every((attempt) => (
    fs.existsSync(attempt.strategy_artifact_path) && /^[a-f0-9]{64}$/.test(attempt.strategy_artifact_sha256)
  )), true);
  for (const invocation of shardInvocations) {
    assert.notEqual(invocation.cwd, workingDir);
    assert.equal(fs.existsSync(invocation.cwd), false);
    assert.match(invocation.prompt, new RegExp(`Expected repository HEAD: ${expectedReviewHead}`));
    assert.ok(invocation.prompt.includes(`Immutable reviewed range: ${reviewedRange}`));
    const addDirIndex = invocation.args.indexOf('--add-dir');
    assert.notEqual(addDirIndex, -1);
    assert.notEqual(invocation.args[addDirIndex + 1], workingDir);
    assert.notEqual(invocation.args[addDirIndex + 1], invocation.cwd);
  }
  assert.equal(git(workingDir, ['rev-parse', 'HEAD']), expectedReviewHead);
  assert.equal(git(workingDir, ['status', '--porcelain=v1', '--untracked-files=all']), liveStatusBefore);
  assert.equal(fs.readFileSync(path.join(workingDir, 'README.md'), 'utf8'), liveReadmeBefore);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
});

test('live reviewer diagnostic ownership drain remains resumable without consuming its mechanism', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  const reviewIdentity = '4'.repeat(64);
  writeJson(path.join(sessionDir, 'citadel-review-state.json'), {
    schema_version: 1,
    review_identity: reviewIdentity,
    recovery_epoch: 5,
    strategy_id: 'adversarial-two-pass',
    strategy_hash: '5'.repeat(64),
    status: 'diagnostic_scheduled',
    attempts: [{
      ordinal: 10,
      epoch: 5,
      attempt: 2,
      candidate_path: path.join(sessionDir, 'invalid-drain.json'),
      candidate_hash: '6'.repeat(64),
      status: 'rejected',
      strategy_id: 'adversarial-two-pass',
      material_strategy_hash: '7'.repeat(64),
      strategy_hash: '8'.repeat(64),
      retry_feedback: 'findings must be an array',
      validation_error: 'findings must be an array',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }],
    updated_at: new Date().toISOString(),
  });
  writeCitadelSystemBlock(sessionDir, {
    code: 'reviewer_artifact_strategy_exhausted',
    title: 'Citadel reviewer artifact strategies require contract reconstruction',
    evidence: `All bounded reviewer artifact strategies are exhausted for review ${reviewIdentity}.`,
    recommendation: 'Run a strict artifact-contract diagnostic.',
    recovery_action: 'repair_reviewer_artifact_contract',
    recovery_ticket_ids: [],
  });
  const reviewStatePath = path.join(sessionDir, 'citadel-review-state.json');
  const reviewStateBefore = fs.readFileSync(reviewStatePath, 'utf8');
  const fakeBin = makeTempRoot('production-supervisor-reviewer-drain-bin-');
  createFakeCodex(fakeBin);
  const block = readCitadelSystemBlock(sessionDir);
  const startedAt = Date.now();
  await assert.rejects(
    () => withProcessEnvironment(prependPath(fakeBin, {
      FAKE_REVIEWER_RECOVERY_DELAY_MS: '10000',
    }), async () => await repairCitadelReviewerArtifactContract(sessionDir, block, {
      assertDurableOwnership: () => {
        if (Date.now() - startedAt > 150) throw new DurableOwnershipDrainError('fixture reviewer lease drained');
      },
    })),
    (error) => {
      assert.ok(error instanceof DurableOwnershipDrainError);
      assert.match(error.message, /fixture reviewer lease drained/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(reviewStatePath, 'utf8'), reviewStateBefore);
  const interruptedJournal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'),
    'utf8',
  ));
  assert.equal(interruptedJournal.mechanism, 'schema_scaffold_replay');
  assert.deepEqual(interruptedJournal.mechanism_history, ['schema_scaffold_replay']);
  assert.deepEqual(interruptedJournal.attempts.map(({ status }) => status), ['started']);
  const drainedState = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.ok(Number.isInteger(drainedState.active_child_pid));
  assert.ok(drainedState.active_child_identity);

  interruptedJournal.status = 'interrupted';
  interruptedJournal.attempts[0].status = 'interrupted';
  interruptedJournal.attempts[0].error = 'fixture crash between interrupted persistence and replacement launch';
  interruptedJournal.attempts[0].completed_at = new Date().toISOString();
  interruptedJournal.updated_at = interruptedJournal.attempts[0].completed_at;
  writeJson(path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'), interruptedJournal);

  const replacement = await withProcessEnvironment(prependPath(fakeBin, {
    FAKE_REVIEWER_RECOVERY_DELAY_MS: '0',
  }), async () => await repairCitadelReviewerArtifactContract(sessionDir, block));
  assert.equal(replacement.kind, 'resolved');
  const resolvedJournal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'),
    'utf8',
  ));
  assert.equal(resolvedJournal.mechanism, 'schema_scaffold_replay');
  assert.deepEqual(resolvedJournal.mechanism_history, ['schema_scaffold_replay']);
  assert.deepEqual(resolvedJournal.attempts.map(({ status }) => status), ['interrupted', 'resolved']);
});

test('criterion shard ownership drain preserves its worktree until exact child reap', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  const reviewBase = git(workingDir, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(workingDir, 'README.md'), '\ncriterion shard repository evidence\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'add drain review evidence',
  ]);
  const reviewedRange = `${reviewBase}..HEAD`;
  const reviewIdentity = '3'.repeat(64);
  writeJson(path.join(sessionDir, 'citadel-review-state.json'), {
    schema_version: 1,
    review_identity: reviewIdentity,
    recovery_epoch: 7,
    strategy_id: 'artifact-contract-reconstruction',
    strategy_hash: '4'.repeat(64),
    status: 'diagnostic_scheduled',
    attempts: [{
      ordinal: 1,
      candidate_path: path.join(sessionDir, 'invalid-shard-drain.json'),
      candidate_hash: '5'.repeat(64),
      status: 'rejected',
      validation_error: 'evidence reconstruction remained invalid',
    }],
    artifact_contract_recovery: {
      schema_version: 1,
      status: 'resolved',
      diagnostic_identity: '6'.repeat(64),
      mechanism: 'evidence_bundle_reconstruction',
      mechanism_history: ['schema_scaffold_replay', 'evidence_bundle_reconstruction'],
      failed_candidate_hashes: ['5'.repeat(64)],
      validator_invariants: ['findings is an array'],
    },
    updated_at: new Date().toISOString(),
  });
  writeCitadelSystemBlock(sessionDir, {
    code: 'reviewer_artifact_strategy_exhausted',
    title: 'Citadel reviewer recovery requires criterion sharding',
    evidence: 'Prior evidence reconstruction failed.',
    recommendation: 'Run repository-bound criterion shards.',
    recovery_action: 'repair_reviewer_artifact_contract',
    recovery_ticket_ids: [],
    reviewed_range: reviewedRange,
  });
  const fakeBin = makeTempRoot('production-supervisor-shard-drain-bin-');
  createFakeCodex(fakeBin);
  const block = readCitadelSystemBlock(sessionDir);
  const manager = new StateManager();
  await assert.rejects(
    () => withProcessEnvironment(prependPath(fakeBin, {
      FAKE_CRITERION_SHARD_DELAY_MS: '10000',
    }), async () => await repairCitadelReviewerArtifactContract(sessionDir, block, {
      assertDurableOwnership: () => {
        if (String(manager.read(path.join(sessionDir, 'state.json')).active_child_command || '')
          .startsWith('citadel-criterion-shard-')) {
          throw new DurableOwnershipDrainError('fixture criterion shard lease drained');
        }
      },
    })),
    /fixture criterion shard lease drained/,
  );
  const recoveryJournal = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'citadel-reviewer-contract-recovery.json'), 'utf8',
  ));
  const shardJournalPath = path.join(
    sessionDir,
    'citadel-reviewer-contract-runtime',
    recoveryJournal.diagnostic_identity,
    'criterion-shard-journal.json',
  );
  const drainedShardJournal = JSON.parse(fs.readFileSync(shardJournalPath, 'utf8'));
  const drainedAttempt = drainedShardJournal.shards[0].attempts[0];
  assert.equal(drainedAttempt.status, 'started');
  assert.equal(fs.existsSync(drainedAttempt.worktree_path), true);
  const drainedState = manager.read(path.join(sessionDir, 'state.json'));
  assert.ok(Number.isInteger(drainedState.active_child_pid));
  assert.ok(drainedState.active_child_identity);

  const replacement = await withProcessEnvironment(prependPath(fakeBin, {
    FAKE_CRITERION_SHARD_DELAY_MS: '0',
  }), async () => await repairCitadelReviewerArtifactContract(sessionDir, block));
  assert.equal(replacement.kind, 'resolved');
  assert.equal(fs.existsSync(drainedAttempt.worktree_path), false);
  const resolvedShardJournal = JSON.parse(fs.readFileSync(shardJournalPath, 'utf8'));
  assert.deepEqual(
    resolvedShardJournal.shards[0].attempts.map(({ status }) => status),
    ['interrupted', 'resolved'],
  );
  assert.ok(resolvedShardJournal.shards.every((shard) => /^[a-f0-9]{64}$/.test(shard.result_sha256)));
});

test('replacement reviewer diagnostic reaps a worker orphaned by real controller SIGKILL', async () => {
  const { sessionDir } = createAcceptedSession('Done');
  writeJson(path.join(sessionDir, 'citadel-review-state.json'), {
    schema_version: 1,
    review_identity: 'e'.repeat(64),
    recovery_epoch: 5,
    strategy_id: 'adversarial-two-pass',
    strategy_hash: 'f'.repeat(64),
    status: 'diagnostic_scheduled',
    attempts: [{
      ordinal: 10,
      epoch: 5,
      attempt: 2,
      candidate_path: path.join(sessionDir, 'invalid-orphan.json'),
      candidate_hash: '1'.repeat(64),
      status: 'rejected',
      strategy_id: 'adversarial-two-pass',
      material_strategy_hash: '2'.repeat(64),
      strategy_hash: '3'.repeat(64),
      retry_feedback: 'findings must be an array',
      validation_error: 'findings must be an array',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }],
    updated_at: new Date().toISOString(),
  });
  writeCitadelSystemBlock(sessionDir, {
    code: 'reviewer_artifact_strategy_exhausted',
    title: 'Citadel reviewer artifact strategies require contract reconstruction',
    evidence: `All bounded reviewer artifact strategies are exhausted for review ${'e'.repeat(64)}.`,
    recommendation: 'Run a strict artifact-contract diagnostic.',
    recovery_action: 'repair_reviewer_artifact_contract',
    recovery_ticket_ids: [],
  });
  const fakeBin = makeTempRoot('production-supervisor-reviewer-orphan-bin-');
  createFakeCodex(fakeBin);
  const recoveryServiceUrl = new URL('../services/citadel-reviewer-recovery.js', import.meta.url).href;
  const citadelServiceUrl = new URL('../services/citadel.js', import.meta.url).href;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', `
    import { repairCitadelReviewerArtifactContract } from ${JSON.stringify(recoveryServiceUrl)};
    import { readCitadelSystemBlock } from ${JSON.stringify(citadelServiceUrl)};
    await repairCitadelReviewerArtifactContract(
      ${JSON.stringify(sessionDir)},
      readCitadelSystemBlock(${JSON.stringify(sessionDir)}),
    );
  `], {
    env: prependPath(fakeBin, { FAKE_REVIEWER_RECOVERY_DELAY_MS: '10000' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const journalPath = path.join(sessionDir, 'citadel-reviewer-contract-recovery.json');
  const statePath = path.join(sessionDir, 'state.json');
  let orphanState = null;
  const waitDeadline = Date.now() + 5_000;
  while (Date.now() < waitDeadline) {
    if (fs.existsSync(journalPath)) {
      const candidate = new StateManager().read(statePath);
      if (Number.isInteger(candidate.active_child_pid) && candidate.active_child_identity) {
        orphanState = candidate;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!orphanState) {
    const stderr = controller.stderr.read()?.toString() || '';
    throw new Error(`reviewer recovery controller did not launch a journaled worker: ${stderr}`);
  }
  const identity = orphanState.active_child_identity;
  const startedJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.deepEqual(startedJournal.attempts.map(({ status }) => status), ['started']);
  assert.equal(fs.existsSync(startedJournal.attempts[0].candidate_path), false);
  process.kill(controller.pid, 'SIGKILL');
  await new Promise((resolve) => controller.once('exit', resolve));
  const block = readCitadelSystemBlock(sessionDir);
  const recovery = await withProcessEnvironment(prependPath(fakeBin, {
    FAKE_REVIEWER_RECOVERY_DELAY_MS: '0',
  }), async () => (
    await repairCitadelReviewerArtifactContract(sessionDir, block)
  ));

  assert.equal(recovery.kind, 'resolved');
  assert.notEqual(inspectProcessLivenessIdentity(identity), 'matched');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(journalPath, 'utf8')).attempts.map(({ status }) => status),
    ['interrupted', 'resolved'],
  );
  assert.equal(new StateManager().read(statePath).active_child_pid, null);
});

test('standalone mux durably resumes unattributed Citadel repair and preserves unrelated Done checkpoints', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  addIndependentDoneTicket(sessionDir, workingDir);
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let citadelRuns = 0;
  const blockWithoutAttribution = async (dir) => {
    citadelRuns += 1;
    writeJson(path.join(dir, 'citadel-report.json'), {
      schema_version: 1,
      verdict: 'block',
      acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(dir),
      findings: [{
        severity: 'high',
        title: 'Reviewer found incomplete release proof.',
        evidence: 'The restart proof is insufficient.',
        recommendation: 'Repair the responsible ticket and rerun the release gate.',
      }],
    });
    return 'citadel-blocked';
  };

  const firstReason = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runCitadel: blockWithoutAttribution,
    repairCitadelAttribution: async (dir) => await repairCitadelAttribution(dir, { artifact: {
      schema_version: 1,
      report_sha256: 'invalid',
      attributions: [{ finding_index: 0, ticket_id: 'R1', rationale: 'Invalid hash fixture.' }],
    } }),
  });
  assert.equal(firstReason, 'citadel_attribution_repair_scheduled');
  assert.equal(muxRunnerExitFailed(firstReason), false);
  assert.equal(citadelRuns, 1);
  assert.deepEqual(readManifest(sessionDir).tickets.map(({ status }) => status), ['Done', 'Done']);
  assert.equal(readManifest(sessionDir).tickets[1].completion_commit, 'b'.repeat(40));
  assert.ok(reconcileCitadelAttributionRepair(sessionDir));

  const rerunTickets = [];
  const secondReason = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    repairCitadelAttribution: async (dir) => {
      const intent = reconcileCitadelAttributionRepair(dir);
      return await repairCitadelAttribution(dir, { artifact: {
        schema_version: 1,
        report_sha256: intent.report_sha256,
        attributions: [{ finding_index: 0, ticket_id: 'R1', rationale: 'The finding concerns the R1 restart contract.' }],
      } });
    },
    runTicket: async (dir, ticketId) => {
      rerunTickets.push(ticketId);
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done', applied: true };
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(secondReason, 'success');
  assert.deepEqual(rerunTickets, ['r1']);
  assert.equal(readManifest(sessionDir).tickets[1].status, 'Done');
  assert.equal(readManifest(sessionDir).tickets[1].completion_commit, 'b'.repeat(40));
  assert.equal(reconcileCitadelAttributionRepair(sessionDir), null);
});

test('pipeline treats unattributed Citadel repair as a restart-safe nonterminal wakeup', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  addIndependentDoneTicket(sessionDir, workingDir);
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'repair unattributed Citadel refusal',
  }));
  ensurePipelineState(sessionDir);
  let citadelRuns = 0;
  const firstReason = await runPipeline(sessionDir, {
    runSequential: async () => 'success',
    runCitadel: async (dir) => {
      citadelRuns += 1;
      writeJson(path.join(dir, 'citadel-report.json'), {
        schema_version: 1,
        verdict: 'block',
        acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(dir),
        findings: [{ severity: 'high', title: 'Internal release report is unattributed.', evidence: 'Restart proof is incomplete.' }],
      });
      return 'citadel-blocked';
    },
    repairCitadelAttribution: async (dir) => await repairCitadelAttribution(dir, { artifact: {
      schema_version: 1,
      report_sha256: 'invalid',
      attributions: [{ finding_index: 0, ticket_id: 'R1', rationale: 'Invalid hash fixture.' }],
    } }),
  });
  assert.equal(firstReason, 'citadel_attribution_repair_scheduled');
  assert.equal(citadelRuns, 1);
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).last_exit_reason, firstReason);
  assert.ok(reconcileCitadelAttributionRepair(sessionDir));

  const rerunTickets = [];
  const secondReason = await runPipeline(sessionDir, {
    repairCitadelAttribution: async (dir) => {
      const intent = reconcileCitadelAttributionRepair(dir);
      return await repairCitadelAttribution(dir, { artifact: {
        schema_version: 1,
        report_sha256: intent.report_sha256,
        attributions: [{ finding_index: 0, ticket_id: 'R1', rationale: 'The release proof belongs to R1.' }],
      } });
    },
    runSequential: async (dir) => {
      for (const ticket of readManifest(dir).tickets.filter(({ status }) => status === 'Todo')) {
        rerunTickets.push(ticket.id);
        updateTicketStatus(dir, ticket.id, { status: 'Done' });
      }
      return 'success';
    },
    runCitadel: approveCitadelFixture,
  });
  assert.equal(secondReason, 'success');
  assert.deepEqual(rerunTickets, ['r1']);
  assert.equal(readManifest(sessionDir).tickets[1].completion_commit, 'b'.repeat(40));
});

test('replacement standalone mux reconciles a predecessor Citadel intent before worker dispatch', async () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const reportPath = path.join(sessionDir, 'citadel-report.json');
  const archivePath = path.join(sessionDir, 'citadel-remediation', 'citadel-report-predecessor.json');
  const criteria = deriveCitadelAcceptanceCriteria(sessionDir);
  const findings = [{
    severity: 'blocking',
    title: 'Restart lost the release objection.',
    evidence: 'The replacement worker received no Citadel evidence.',
    recommendation: 'Carry the archived report into the next implementation prompt.',
  }];
  writeJson(reportPath, { schema_version: 1, verdict: 'block', acceptance_criteria_checked: criteria, findings });
  writeJson(archivePath, { schema_version: 1, verdict: 'block', acceptance_criteria_checked: criteria, findings });
  writeJson(path.join(sessionDir, 'citadel-remediation-pending.json'), {
    schema_version: 2,
    failure_kind: 'citadel_refused',
    archive_path: archivePath,
    report_path: reportPath,
    ticket_ids: ['R1'],
    affected_tickets: [{ id: 'R1', acceptance_criteria: ['The launched runner renews exclusive durable ownership.'] }],
    findings,
    acceptance_criteria_checked: criteria,
    summary: 'Restart lost the release objection.',
    enqueued_at: '2026-08-08T01:00:00.000Z',
  });

  let remediationPrompt = '';
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (dir, ticketId) => {
      const ticket = readManifest(dir).tickets.find((entry) => entry.id === ticketId);
      assert.ok(ticket);
      remediationPrompt = buildTicketPhasePrompt({ phase: 'implement', ticket, sessionDir: dir, workingDir });
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done', applied: true };
    },
    runCitadel: approveCitadelFixture,
  });

  assert.equal(result, 'success');
  assert.match(remediationPrompt, /Restart lost the release objection\./);
  assert.match(remediationPrompt, /replacement worker received no Citadel evidence\./);
  assert.match(remediationPrompt, /Carry the archived report into the next implementation prompt\./);
  assert.match(remediationPrompt, /citadel-report-predecessor\.json/);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-current.json')), true);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
});

test('legacy unexpired runner lease is not stolen merely because immutable identity is absent', () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  acquireSupervisorLease(sessionDir, { ownerId: `runner:${process.pid}:legacy`, ttlMs: 60_000 });
  assert.throws(() => startDurableRuntimeOwnership(sessionDir), /already owned by live executor/);
});

test('Citadel refusal is archived, enqueues remediation, and resets affected phases', () => {
  const { sessionDir, workingDir } = createAcceptedSession('Done');
  writePipelineContract(sessionDir, createPipelineContract({
    working_dir: workingDir,
    target: workingDir,
    phases: ['pickle', 'citadel'],
    bootstrap_source: 'task',
    task: 'remediate Citadel refusal',
  }));
  ensurePipelineState(sessionDir);
  beginPipelinePhase(sessionDir, 'pickle');
  finishPipelinePhase(sessionDir, 'pickle', { exitReason: 'success' });
  beginPipelinePhase(sessionDir, 'citadel');
  finishPipelinePhase(sessionDir, 'citadel', { exitReason: 'citadel-blocked' });
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    findings: [{ title: 'Release evidence is incomplete.' }],
  });

  const archivePath = enqueueCitadelRemediation(sessionDir);
  assert.equal(fs.existsSync(archivePath), true);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Todo');
  assert.equal(readManifest(sessionDir).tickets[0].failure_kind, 'citadel_refused');
  const pipeline = readPipelineState(sessionDir);
  assert.equal(pipeline.current_phase, 'pickle');
  assert.equal(pipeline.phase_statuses.pickle, 'todo');
  assert.equal(pipeline.phase_statuses.citadel, 'todo');
});
