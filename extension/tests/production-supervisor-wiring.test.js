// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import { runSequential } from '../bin/mux-runner.js';
import { enqueueCitadelRemediation, parsePipelineHandoffOptions } from '../bin/pipeline-runner.js';
import { startDurableRuntimeOwnership } from '../services/durable-runtime.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  readLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
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
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined fixture PRD\n');
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

test('standalone mux archives Citadel refusal and schedules ticket remediation', async () => {
  const { sessionDir } = createAcceptedSession();
  initializePrdDevelopmentPipeline(sessionDir);
  ensureSessionPrdSeal(sessionDir);
  const result = await runSequential(sessionDir, { runnerMode: 'pickle' }, {
    runTicket: async (dir, ticketId) => {
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done', applied: true };
    },
    runCitadel: async (dir) => {
      writeJson(path.join(dir, 'citadel-report.json'), {
        schema_version: 1,
        verdict: 'block',
        reviewed_range: 'fixture..HEAD',
        acceptance_criteria_checked: deriveCitadelAcceptanceCriteria(dir),
        findings: [{ severity: 'high', title: 'Refused', evidence: 'release defect' }],
        generated_at: new Date().toISOString(),
      });
      return 'citadel-blocked';
    },
  });
  assert.equal(result, 'citadel-blocked');
  assert.equal(readLogicalPipeline(sessionDir).terminal_state, null);
  assert.equal(readManifest(sessionDir).tickets[0].status, 'Todo');
  assert.equal(fs.readdirSync(path.join(sessionDir, 'citadel-remediation')).length, 1);
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
  const pipeline = readPipelineState(sessionDir);
  assert.equal(pipeline.current_phase, 'pickle');
  assert.equal(pipeline.phase_statuses.pickle, 'todo');
  assert.equal(pipeline.phase_statuses.citadel, 'todo');
});
