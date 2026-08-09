// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeCodex, makeTempRoot, prependPath, writeJson } from './helpers.js';
import { muxRunnerExitFailed, runSequential } from '../bin/mux-runner.js';
import { runTicket } from '../bin/spawn-morty.js';
import { enqueueCitadelRemediation, parsePipelineHandoffOptions, runPipeline } from '../bin/pipeline-runner.js';
import { startDurableRuntimeOwnership } from '../services/durable-runtime.js';
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
import { readManifest, updateTicketStatus } from '../services/tickets.js';
import { ensureBootstrapSessionReady } from '../services/pipeline-bootstrap.js';
import { captureSpawnedProcessIdentity, inspectProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';
import { assertSessionOperationAvailable } from '../services/session-operation.js';
import { assertCitadelReleaseApproval, deriveCitadelAcceptanceCriteria, persistCitadelReleaseApproval } from '../services/citadel.js';
import { PreflightError } from '../services/verification-env.js';
import { reconstructWorkspaceFromDurableCheckpoint } from '../services/workspace-reconstruction.js';
import { buildTicketPhasePrompt } from '../services/prompts.js';
import { reconcileCitadelAttributionRepair, repairCitadelAttribution } from '../services/citadel-remediation.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

test('long active worker drains promptly when blue releases for green handoff', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  let workerStarted;
  const started = new Promise((resolve) => { workerStarted = resolve; });
  const run = runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (_dir, _ticketId, options) => {
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
  assert.equal(
    acceptRuntimeHandoff(sessionDir, requestId, 'green-fixture', 60_000, greenRuntime).lease.owner_id,
    'green-fixture',
  );
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
