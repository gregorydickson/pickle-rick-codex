// @tier: fast
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { reconcileSessionLiveness, resolveSessionForCwd } from '../services/session.js';
import {
  captureProcessLivenessIdentity,
  captureSpawnedProcessIdentity,
  inspectProcessLivenessIdentity,
  reapRecordedLiveProcessGroup,
} from '../services/orphan-reaper.js';
import { consumeAutonomousBudgetRollover } from '../services/autonomous-budget.js';
import {
  registerAutonomousOwnerSpec,
  restoreAutonomousBudgetOwner,
  runAutonomousOwnerRecoveryDaemon,
  fenceAutonomousOwnerRecoveryForHandoff,
  reconcileAutonomousOwnerHandoffTransaction,
} from '../services/autonomous-owner-recovery.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  beginAutonomousExecution,
  cancelLogicalPipelineByOperator,
  createLogicalPipeline,
  readLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
} from '../services/durable-supervisor.js';
import { prepareLiveSessionHandoffCheckpoint, prepareLiveSessionMigration } from '../services/live-session-migration.js';
import { updateSessionMap } from '../services/session-map.js';
import { assertSessionOperationAvailable } from '../services/session-operation.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  captureOwnedTmuxRunnerBinding,
  killTmuxSessionById,
  readTmuxRunnerBinding,
  runTmux,
  shellQuote,
  tmuxSessionExists,
} from '../services/tmux.js';
import { StateManager } from '../services/state-manager.js';
import { fakeLifecycleArtifactWriterSource, makeTempRoot, writeJson } from './helpers.js';
import { runCitadel, validateCitadelRecoveryEvidence } from '../services/citadel.js';

function state(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/project',
    step: 'implement',
    iteration: 1,
    max_iterations: 25,
    max_time_minutes: 480,
    worker_timeout_seconds: 900,
    start_time_epoch: 1_700_000_000,
    run_start_time_epoch: 1_700_000_000,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2023-11-14T22:13:20.000Z',
    session_dir: '/tmp/session',
    schema_version: 1,
    ...overrides,
  };
}

async function waitForLineCount(filePath, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).length >= expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${expected} lines in ${filePath}`);
}

async function waitForState(statePath, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new StateManager().read(statePath);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for state predicate at ${statePath}`);
}

async function waitForOwnerRecoveryMilestone(statePath, predicate, semanticProjection, label) {
  const inactivityMs = 15_000;
  const absoluteMs = 45_000;
  const startedAt = Date.now();
  let lastSemanticProgressAt = startedAt;
  let highWater = [];
  let lastState = null;
  while (Date.now() - startedAt < absoluteMs) {
    const current = new StateManager().read(statePath);
    lastState = current;
    if (predicate(current)) return current;
    const semantic = semanticProjection(current);
    if (semantic.some((value, index) => value > (highWater[index] || 0))) {
      highWater = semantic.map((value, index) => Math.max(value, highWater[index] || 0));
      lastSemanticProgressAt = Date.now();
    }
    if (Date.now() - lastSemanticProgressAt >= inactivityMs) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${label} made no durable semantic progress within its recovery budgets: ${JSON.stringify({
    inactivity_ms: inactivityMs,
    absolute_ms: absoluteMs,
    high_water: highWater,
    restoration: lastState?.autonomous_owner_restoration || null,
    handoff: lastState?.autonomous_owner_handoff_transaction || null,
    owner_spec_id: lastState?.autonomous_owner_spec?.spec_id || null,
    tmux_binding: lastState?.tmux_runner_binding || null,
    recovery_required: lastState?.recovery_required,
    recovery_reason: lastState?.recovery_reason,
  })}`);
}

async function waitForOwnerRunCount(filePath, expected) {
  const inactivityMs = 15_000;
  const absoluteMs = 45_000;
  const startedAt = Date.now();
  let lastSemanticProgressAt = startedAt;
  let highWater = 0;
  while (Date.now() - startedAt < absoluteMs) {
    let lines = 0;
    try {
      lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).length;
    } catch {}
    if (lines >= expected) return;
    if (lines > highWater) {
      highWater = lines;
      lastSemanticProgressAt = Date.now();
    }
    if (Date.now() - lastSemanticProgressAt >= inactivityMs) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Owner launch made no semantic progress toward ${expected} runs: ${JSON.stringify({
    inactivity_ms: inactivityMs, absolute_ms: absoluteMs, observed_runs: highWater, file: filePath,
  })}`);
}

function readJsonIfPresent(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function fileTail(filePath, bytes = 4_096) {
  try {
    const value = fs.readFileSync(filePath, 'utf8');
    return value.slice(-bytes);
  } catch {
    return '';
  }
}

function persistedIdentityLiveness(identity) {
  return identity ? inspectProcessLivenessIdentity(identity) : 'absent';
}

async function waitForLegacyMigrationCompletion(statePath, sessionDir, predicate, {
  workerTimeoutSeconds,
  baselineReviewCount,
}) {
  // The fake runtime is bounded by the same worker timeout used by the
  // production Citadel model call. Give every durable stage that full bound
  // plus drain/scheduling reserve, while retaining an immutable whole-flow cap.
  const workerBoundMs = Math.max(1_000, Number(workerTimeoutSeconds) * 1_000);
  const inactivityMs = workerBoundMs + 30_000;
  const absoluteMs = (workerBoundMs * 3) + 60_000;
  const startedAt = Date.now();
  let lastSemanticProgressAt = startedAt;
  let highWater = [];
  let lastStage = 'migration-not-published';
  let lastState = null;
  let observedSupervisorIdentity = null;
  let observedDaemonIdentity = null;

  while (Date.now() - startedAt < absoluteMs) {
    const current = new StateManager().read(statePath);
    lastState = current;
    observedSupervisorIdentity ||= current.autonomous_supervisor_identity || null;
    observedDaemonIdentity ||= current.autonomous_owner_recovery_daemon_identity || null;
    const observedSupervisorAbsent = observedSupervisorIdentity
      && inspectProcessLivenessIdentity(observedSupervisorIdentity) === 'not-running';
    const observedDaemonAbsent = observedDaemonIdentity
      && inspectProcessLivenessIdentity(observedDaemonIdentity) === 'not-running';
    if (predicate(current) && observedSupervisorAbsent && observedDaemonAbsent) return {
      state: current,
      supervisorIdentity: observedSupervisorIdentity,
      daemonIdentity: observedDaemonIdentity,
    };
    const migrationStatus = String(current.legacy_max_time_migration?.status || '');
    const migrationRank = ['rollover_scheduled', 'owner_restoration_planned', 'owner_restored', 'rollover_consumed']
      .indexOf(migrationStatus) + 1;
    const restorationStatus = String(current.autonomous_owner_restoration?.status || '');
    const restorationRank = ['pending', 'restoring', 'restored', 'rollover_consumed']
      .indexOf(restorationStatus) + 1;
    const report = readJsonIfPresent(path.join(sessionDir, 'citadel-report.json'));
    const reviewCount = Number(fileTail(path.join(sessionDir, 'legacy-citadel-review-count'), 64).trim() || 0);
    const logical = readJsonIfPresent(path.join(sessionDir, 'logical-pipeline.json'));
    const historySteps = new Set((current.history || []).map((entry) => String(entry?.step || '')).filter(Boolean));
    const muxLog = fileTail(path.join(sessionDir, 'mux-runner.log'));
    const semantic = [
      Math.max(0, migrationRank),
      Math.max(0, restorationRank),
      current.autonomous_budget_consumed_intent_id ? 1 : 0,
      historySteps.size,
      /mux-runner started/.test(muxLog) ? 1 : 0,
      reviewCount > baselineReviewCount ? reviewCount - baselineReviewCount : 0,
      report?.verdict === 'approve' ? 1 : 0,
      fs.existsSync(path.join(sessionDir, 'citadel-release-approval.json')) ? 1 : 0,
      current.step === 'complete' ? 1 : 0,
      logical?.terminal_state === 'completed' ? 1 : 0,
      observedSupervisorAbsent ? 1 : 0,
      observedDaemonAbsent ? 1 : 0,
    ];
    if (semantic.some((value, index) => value > (highWater[index] || 0))) {
      highWater = semantic.map((value, index) => Math.max(value, highWater[index] || 0));
      lastSemanticProgressAt = Date.now();
      lastStage = [
        migrationStatus || 'migration-pending',
        restorationStatus || 'owner-pending',
        current.step || 'no-step',
        report?.verdict || 'no-citadel-report',
      ].join('/');
    }
    if (Date.now() - lastSemanticProgressAt >= inactivityMs) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const logical = readJsonIfPresent(path.join(sessionDir, 'logical-pipeline.json'));
  const identityLiveness = Object.fromEntries([
    ['supervisor', lastState?.autonomous_supervisor_identity],
    ['recovery_daemon', lastState?.autonomous_owner_recovery_daemon_identity],
    ['active_child', lastState?.active_child_identity],
  ].map(([label, identity]) => [label, identity
    ? inspectProcessLivenessIdentity(identity) : 'absent']));
  assert.fail(`Legacy migration made no new durable semantic progress within its configured budgets: ${JSON.stringify({
    inactivity_ms: inactivityMs,
    absolute_ms: absoluteMs,
    last_stage: lastStage,
    high_water: highWater,
    migration: lastState?.legacy_max_time_migration || null,
    restoration: lastState?.autonomous_owner_restoration || null,
    step: lastState?.step,
    current_ticket: lastState?.current_ticket,
    logical,
    identity_liveness: identityLiveness,
    citadel_report: readJsonIfPresent(path.join(sessionDir, 'citadel-report.json')),
    citadel_review_count: fileTail(path.join(sessionDir, 'legacy-citadel-review-count'), 64),
    mux_log_tail: fileTail(path.join(sessionDir, 'mux-runner.log')),
  })}`);
}

function runLivenessProcess(sessionDir, nowMs) {
  const source = `
    import('./services/session.js').then(({ reconcileSessionLiveness }) => {
      const result = reconcileSessionLiveness(process.argv[1], undefined, Number(process.argv[2]), { allowLegacyMaxTimeMigration: true });
      process.stdout.write(String(result.state.autonomous_budget_rollover_intent_id || ''));
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, sessionDir, String(nowMs)], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `liveness child exited ${code}`)));
  });
}

function runRestoreProcess(sessionDir, nowMs) {
  const source = `
    import('./services/autonomous-owner-recovery.js').then(({ restoreAutonomousBudgetOwner }) => {
      process.stdout.write(restoreAutonomousBudgetOwner(process.argv[1], undefined, Number(process.argv[2])));
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, sessionDir, String(nowMs)], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `restore child exited ${code}`)));
  });
}

function registerProcessOwner(sessionDir, runnerArgs = []) {
  return registerAutonomousOwnerSpec(
    sessionDir,
    'mux-runner.js',
    runnerArgs,
    undefined,
    path.resolve(new URL('../bin/supervised-runner.js', import.meta.url).pathname),
  );
}

function initializeGitRepository(workingDir) {
  execFileSync('git', ['init', '-q'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.email', 'pickle@example.invalid'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd: workingDir });
  fs.writeFileSync(path.join(workingDir, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workingDir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workingDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
}

function sealLegacySession(sessionDir, workingDir) {
  const prd = '# Continue productive autonomous work\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  return writePrdSeal(sessionDir, {
    prd,
    repository: { identity: 'fixture@base', working_directory: workingDir, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'AC-1', text: 'The autonomous owner performs productive work.' }],
    scope_and_ownership: [{ ticket_id: 'release-validation', allowed_paths: ['tracked.txt'], output_artifacts: [] }],
    dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
  });
}

function deadProcessIdentity(pid = 999_999_999) {
  const pgid = pid;
  const start_time = 'legacy-owner-start';
  return {
    pid, pgid, start_time,
    fingerprint: crypto.createHash('sha256').update(`${pid}\0${pgid}\0${start_time}`).digest('hex'),
  };
}

class InjectBeforeFirstUpdateStateManager extends StateManager {
  constructor(inject) {
    super();
    this.inject = inject;
    this.armed = true;
  }

  update(statePath, mutator, options) {
    if (this.armed) {
      this.armed = false;
      super.update(statePath, this.inject);
    }
    return super.update(statePath, mutator, options);
  }
}

test('reconcileSessionLiveness demotes a tmux session whose runner is gone', () => {
  const sessionDir = makeTempRoot('pickle-liveness-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, state({ session_dir: sessionDir, tmux_mode: true, tmux_runner_pid: 999_999_999 }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, true);
  assert.equal(result.state.active, false);
  assert.equal(result.state.last_exit_reason, 'runner_lost');
  assert.equal(result.state.step, 'paused');
});

test('reconcileSessionLiveness reaps the full monitored ledger when the broker is dead', { timeout: 15_000 }, async () => {
  const sessionDir = makeTempRoot('pickle-liveness-monitored-ledger-');
  const statePath = path.join(sessionDir, 'state.json');
  const targetPidPath = path.join(sessionDir, 'target.pid');
  const broker = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    "const c=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "fs.writeFileSync(process.env.TARGET_PID_PATH,String(c.pid));setInterval(()=>{},1000);",
  ].join('')], { detached: true, stdio: 'ignore', env: { ...process.env, TARGET_PID_PATH: targetPidPath } });
  let brokerIdentity;
  let targetIdentity;
  try {
    while (!fs.existsSync(targetPidPath)) await new Promise((resolve) => setTimeout(resolve, 10));
    brokerIdentity = captureProcessLivenessIdentity(broker.pid);
    targetIdentity = captureProcessLivenessIdentity(Number(fs.readFileSync(targetPidPath, 'utf8')));
    assert.ok(brokerIdentity && targetIdentity);
    writeJson(statePath, state({
      session_dir: sessionDir,
      tmux_mode: true,
      tmux_runner_pid: 999_999_999,
      active_child_pid: brokerIdentity.pid,
      active_child_identity: brokerIdentity,
      active_child_identities: [brokerIdentity, targetIdentity],
    }));
    process.kill(brokerIdentity.pid, 'SIGKILL');
    await new Promise((resolve) => broker.once('exit', resolve));
    assert.equal(inspectProcessLivenessIdentity(targetIdentity), 'matched');

    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
    assert.equal(result.stale, true);
    assert.equal(result.state.recovery_required, false);
    assert.deepEqual(result.state.active_child_identities, []);
    assert.equal(inspectProcessLivenessIdentity(targetIdentity), 'not-running');
  } finally {
    if (brokerIdentity) { try { process.kill(-brokerIdentity.pgid, 'SIGKILL'); } catch {} }
    if (targetIdentity && targetIdentity.pgid !== brokerIdentity?.pgid) {
      try { process.kill(-targetIdentity.pgid, 'SIGKILL'); } catch {}
    }
  }
});

test('reconcileSessionLiveness does not prune a live refinement identity ledger', { timeout: 15_000 }, async () => {
  const sessionDir = makeTempRoot('pickle-liveness-refinement-ledger-');
  const statePath = path.join(sessionDir, 'state.json');
  const childPidPath = path.join(sessionDir, 'child.pid');
  const launcher = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    "const c=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    "c.unref();fs.writeFileSync(process.env.CHILD_PID_PATH,String(c.pid));",
  ].join('')], { stdio: 'ignore', env: { ...process.env, CHILD_PID_PATH: childPidPath } });
  let identity;
  try {
    await new Promise((resolve) => launcher.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    while (!(identity = captureProcessLivenessIdentity(childPid))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeJson(statePath, state({
      session_dir: sessionDir,
      tmux_mode: true,
      tmux_runner_pid: 999_999_999,
      active_child_pid: identity.pid,
      active_child_identity: identity,
      refinement_child_identities: [identity],
    }));
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
    assert.equal(result.stale, true);
    assert.deepEqual(result.state.refinement_child_identities, []);
    assert.equal(inspectProcessLivenessIdentity(identity), 'not-running');
  } finally {
    if (identity) { try { process.kill(-identity.pgid, 'SIGKILL'); } catch {} }
  }
});

test('reconcileSessionLiveness preserves an active session during a bounded autonomous budget relaunch', () => {
  const sessionDir = makeTempRoot('pickle-liveness-budget-rollover-');
  const nowMs = 1_700_000_100_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    last_exit_reason: 'autonomous_budget_rollover',
    autonomous_budget_rollover_intent_id: 'rollover-intent',
    autonomous_relaunch_not_before: new Date(nowMs + 250).toISOString(),
    autonomous_relaunch_deadline: new Date(nowMs + 60_250).toISOString(),
    recovery_required: false,
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.step, 'implement');
  assert.equal(result.state.recovery_required, false);
});

test('reconcileSessionLiveness reschedules an expired exact rollover intent instead of making it stale', () => {
  const sessionDir = makeTempRoot('pickle-liveness-budget-expired-');
  const nowMs = 1_700_000_100_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    active: false,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    last_exit_reason: 'runner_lost',
    autonomous_budget_epoch: 2,
    autonomous_budget_rollover_intent_id: 'rollover-intent',
    autonomous_relaunch_not_before: new Date(nowMs - 60_000).toISOString(),
    autonomous_relaunch_deadline: new Date(nowMs - 1).toISOString(),
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.last_exit_reason, 'autonomous_budget_rollover');
  assert.equal(result.state.autonomous_budget_rollover_intent_id, 'rollover-intent');
  assert.ok(Date.parse(result.state.autonomous_relaunch_not_before) > nowMs);
  assert.ok(Date.parse(result.state.autonomous_relaunch_deadline) > Date.parse(result.state.autonomous_relaunch_not_before));
});

test('expired rollover restores the exact supervisor owner after repeated whole-tmux loss', async (t) => {
  try {
    runTmux(['-V']);
  } catch {
    t.skip('tmux is unavailable');
    return;
  }
  const sessionDir = makeTempRoot('pickle-liveness-owner-restore-');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'owner-runs.log');
  const fixturePath = path.join(sessionDir, 'supervised-runner.js');
  fs.writeFileSync(fixturePath, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(markerPath)}, 'run\\n');`,
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  const sessionName = `pickle-${path.basename(sessionDir)}`;
  const runnerCommand = `node ${shellQuote(fixturePath)} ${shellQuote(sessionDir)} --runner-bin=mux-runner.js`;
  let binding;
  let daemon = null;
  try {
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, runnerCommand]);
    binding = captureOwnedTmuxRunnerBinding(sessionName, sessionDir);
    writeJson(statePath, state({
      session_dir: sessionDir,
      working_dir: sessionDir,
      tmux_mode: true,
      tmux_session_name: sessionName,
      tmux_runner_pid: binding.pane_pid,
      tmux_runner_binding: binding,
      last_exit_reason: 'autonomous_budget_rollover',
      autonomous_budget_epoch: 1,
      autonomous_budget_rollover_intent_id: 'same-rollover-uuid',
      autonomous_relaunch_not_before: new Date(1_700_000_099_000).toISOString(),
      autonomous_relaunch_deadline: new Date(1_700_000_099_999).toISOString(),
      recovery_required: false,
    }));
    registerAutonomousOwnerSpec(sessionDir, 'mux-runner.js', []);
    new StateManager().update(statePath, (current) => {
      current.autonomous_supervisor_pid = binding.pane_pid;
      current.autonomous_supervisor_identity = null;
      return current;
    });
    await waitForOwnerRunCount(markerPath, 1);
    daemon = runAutonomousOwnerRecoveryDaemon(sessionDir, { intervalMs: 10 });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const previousIntentId = new StateManager().read(statePath).autonomous_owner_restoration?.intent_id || null;
      if (cycle === 0) killTmuxSessionById(binding.session_id);
      else process.kill(binding.pane_pid, 'SIGKILL');
      const nowMs = 1_700_000_100_000 + cycle * 120_000;
      const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
      assert.equal(reconciled.stale, false);
      assert.equal(reconciled.state.autonomous_budget_rollover_intent_id, 'same-rollover-uuid');
      assert.ok(['pending', 'restored'].includes(reconciled.state.autonomous_owner_restoration.status));
      const restored = await waitForOwnerRecoveryMilestone(
        statePath,
        (current) => current.autonomous_owner_restoration?.status === 'restored'
          && current.autonomous_owner_restoration?.intent_id !== previousIntentId,
        (current) => {
          const restoration = current.autonomous_owner_restoration;
          const isNewIntent = restoration?.intent_id !== previousIntentId;
          return [
            isNewIntent ? 1 : 0,
            isNewIntent ? ['pending', 'restoring', 'restored'].indexOf(restoration?.status) + 1 : 0,
            current.recovery_required === true ? 0 : 1,
          ];
        },
        `owner restoration cycle ${cycle + 1}`,
      );
      assert.equal(restored.autonomous_budget_rollover_intent_id, 'same-rollover-uuid');
      assert.equal(restored.autonomous_owner_restoration.status, 'restored');
      binding = restored.tmux_runner_binding;
      new StateManager().update(statePath, (current) => {
        current.autonomous_supervisor_pid = binding.pane_pid;
        current.autonomous_supervisor_identity = null;
        return current;
      });
      if (cycle === 0) assert.notEqual(binding.session_id, reconciled.state.tmux_runner_binding.session_id);
      else assert.equal(binding.session_id, reconciled.state.tmux_runner_binding.session_id);
      await waitForOwnerRunCount(markerPath, cycle + 2);
    }
    assert.equal(fs.readFileSync(markerPath, 'utf8').trim().split('\n').length, 3);

    const targetRuntimeBin = path.join(sessionDir, 'target-runtime-bin');
    const targetMarkerPath = path.join(sessionDir, 'target-owner-runs.log');
    fs.mkdirSync(targetRuntimeBin);
    fs.writeFileSync(path.join(targetRuntimeBin, 'recovered-supervisor-owner.js'), [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(targetMarkerPath)}, 'target\\n');`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    const sourceRuntime = {
      runtime_id: 'blue', version: '1', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const targetRuntime = {
      runtime_id: 'green', version: '1', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Owner handoff recovery\n');
    createLogicalPipeline(sessionDir, 'owner-handoff-recovery');
    writePrdSeal(sessionDir, {
      prd: '# Owner handoff recovery\n',
      repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
      acceptance_criteria: [{ id: 'AC-1', text: 'Recover the exact accepted owner.' }],
      scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
      preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
    });
    beginAutonomousExecution(sessionDir);
    const sourceLease = acquireSupervisorLease(sessionDir, { ownerId: 'blue-owner', ttlMs: 10_000 });
    const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
    const requestId = requestRuntimeHandoff(
      sessionDir, sourceLease.owner_id, sourceLease.token, sourceRuntime, targetRuntime, checkpoint,
    );
    const daemonPidBeforeHandoff = new StateManager().read(statePath).autonomous_owner_recovery_daemon_pid;
    fenceAutonomousOwnerRecoveryForHandoff(
      sessionDir,
      requestId,
      'mux-runner.js',
      [],
      targetRuntimeBin,
      targetRuntime,
    );
    const fenced = new StateManager().read(statePath);
    const stagedSourceSpec = fenced.autonomous_owner_handoff_transaction.source_owner_spec;
    const stagedTargetSpec = fenced.autonomous_owner_handoff_transaction.target_owner_spec;
    releaseRuntimeHandoffLease(sessionDir, sourceLease.owner_id, sourceLease.token, requestId);
    const acceptedTarget = acceptRuntimeHandoff(sessionDir, requestId, 'green-owner', 10_000, targetRuntime);
    // Fault injection: execution disappears after durable acceptance but before the normal
    // owner-transfer call. Recovery must use only the durable event + staged transaction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const committed = await waitForState(
      statePath,
      (current) => current.autonomous_owner_handoff_transaction?.status === 'completed',
    );
    assert.equal(committed.autonomous_owner_recovery_daemon_pid, daemonPidBeforeHandoff);
    assert.deepEqual(committed.autonomous_owner_spec, stagedTargetSpec);
    assert.notDeepEqual(committed.autonomous_owner_spec, stagedSourceSpec);
    assert.equal(committed.autonomous_owner_recovery_suspended, false);
    assert.equal(committed.autonomous_owner_recovery_suspended_for_handoff, null);
    assert.ok(committed.autonomous_owner_spec.pane_start_command.includes(targetRuntimeBin));
    new StateManager().update(statePath, (current) => {
      current.autonomous_supervisor_pid = binding.pane_pid;
      current.autonomous_supervisor_identity = null;
      return current;
    });
    killTmuxSessionById(binding.session_id);
    reconcileSessionLiveness(sessionDir, undefined, 1_700_000_350_000);
    const previousTargetRestorationIntent = committed.autonomous_owner_restoration?.intent_id || null;
    const targetRestored = await waitForOwnerRecoveryMilestone(
      statePath,
      (current) => current.autonomous_owner_restoration?.status === 'restored'
        && current.tmux_runner_binding?.session_id !== binding.session_id,
      (current) => {
        const restoration = current.autonomous_owner_restoration;
        const isNewIntent = restoration?.intent_id !== previousTargetRestorationIntent;
        return [
          current.autonomous_owner_spec?.spec_id === stagedTargetSpec.spec_id ? 1 : 0,
          isNewIntent ? 1 : 0,
          isNewIntent ? ['pending', 'restoring', 'restored'].indexOf(restoration?.status) + 1 : 0,
          current.tmux_runner_binding?.session_id !== binding.session_id ? 1 : 0,
        ];
      },
      'accepted target owner restoration',
    );
    binding = targetRestored.tmux_runner_binding;
    await waitForOwnerRunCount(targetMarkerPath, 1);
    assert.equal(fs.readFileSync(markerPath, 'utf8').trim().split('\n').length, 3, 'source owner was never restored');

    const rollbackCheckpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, targetRuntime, sourceRuntime);
    const rollbackRequestedAt = Date.now();
    const rollbackRequestId = requestRuntimeHandoff(
      sessionDir,
      acceptedTarget.lease.owner_id,
      acceptedTarget.lease.token,
      targetRuntime,
      sourceRuntime,
      rollbackCheckpoint,
      { nowMs: rollbackRequestedAt },
    );
    fenceAutonomousOwnerRecoveryForHandoff(
      sessionDir, rollbackRequestId, 'mux-runner.js', [], targetRuntimeBin, sourceRuntime,
    );
    const rollbackFenced = new StateManager().read(statePath);
    const exactRollbackSource = rollbackFenced.autonomous_owner_handoff_transaction.source_owner_spec;
    releaseRuntimeHandoffLease(
      sessionDir,
      acceptedTarget.lease.owner_id,
      acceptedTarget.lease.token,
      rollbackRequestId,
      { nowMs: rollbackRequestedAt + 1 },
    );
    // Fault injection: no target ever accepts and the fenced transaction expires.
    assert.equal(
      reconcileAutonomousOwnerHandoffTransaction(sessionDir, undefined, rollbackRequestedAt + 61_000),
      'rolled_back',
    );
    const rolledBack = new StateManager().read(statePath);
    assert.deepEqual(rolledBack.autonomous_owner_spec, exactRollbackSource);
    assert.equal(rolledBack.autonomous_owner_handoff_transaction.status, 'rolled_back');
    assert.equal(rolledBack.autonomous_owner_recovery_suspended, false);
    assert.equal(rolledBack.autonomous_owner_recovery_suspended_for_handoff, null);

    killTmuxSessionById(binding.session_id);
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, 'sleep 30']);
    const foreignBinding = readTmuxRunnerBinding(`${sessionName}:0`);
    assert.ok(foreignBinding);
    binding = foreignBinding;
    const foreignNowMs = 1_700_000_400_000;
    reconcileSessionLiveness(sessionDir, undefined, foreignNowMs);
    const foreignFailed = await waitForState(statePath, (current) => current.recovery_required === true);
    assert.match(foreignFailed.recovery_reason, /different immutable session/);
    try {
      assert.equal(restoreAutonomousBudgetOwner(sessionDir, undefined, foreignNowMs + 1_000), 'noop');
    } catch (error) {
      // A 10ms recovery daemon may reschedule between the observed failure and this probe.
      assert.match(String(error), /different immutable session/);
    }
    assert.equal(new StateManager().read(statePath).recovery_required, true);
    assert.equal(tmuxSessionExists(sessionName), true);
    new StateManager().update(statePath, (current) => {
      current.cancel_requested_at = new Date(foreignNowMs + 2_000).toISOString();
      current.last_exit_reason = 'cancelled';
      return current;
    });
    assert.equal(restoreAutonomousBudgetOwner(sessionDir, undefined, foreignNowMs + 3_000), 'noop');
    assert.equal(tmuxSessionExists(sessionName), true);
  } finally {
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
      if (daemon) await daemon;
    } catch {}
    if (binding?.session_id) {
      try { killTmuxSessionById(binding.session_id); } catch {}
    }
  }
});

test('reconcileSessionLiveness durably repairs a missing rollover intent for an elapsed session', () => {
  const expiredDir = makeTempRoot('pickle-liveness-expired-');
  writeJson(path.join(expiredDir, 'state.json'), state({
    session_dir: expiredDir,
    working_dir: expiredDir,
    max_time_minutes: 1,
    iteration: 0,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(expiredDir);
  const expired = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_000);
  assert.equal(expired.stale, false);
  assert.equal(expired.state.active, true);
  assert.equal(expired.state.last_exit_reason, 'autonomous_budget_rollover');
  assert.match(expired.state.autonomous_budget_rollover_intent_id, /^[0-9a-f-]{36}$/);
  assert.equal(expired.state.autonomous_budget_epoch, 1);
  assert.equal(expired.state.autonomous_budget_reason, 'max_time');
  assert.equal(expired.state.autonomous_budget_rollover_checkpoint_pending.intent_id,
    expired.state.autonomous_budget_rollover_intent_id);
  assert.equal(expired.state.max_time_minutes, 2);
  assert.equal(expired.state.autonomous_time_budget_window_minutes, 2);
  assert.equal(expired.state.run_start_time_epoch, 1_700_000_120);
  assert.ok(Date.parse(expired.state.autonomous_relaunch_deadline)
    > Date.parse(expired.state.autonomous_relaunch_not_before));

  const resumed = reconcileSessionLiveness(expiredDir, undefined, 1_700_000_120_001);
  assert.equal(resumed.state.autonomous_budget_rollover_intent_id,
    expired.state.autonomous_budget_rollover_intent_id, 'reconciliation reuses the durable intent');
  const checkpoints = [];
  assert.equal(consumeAutonomousBudgetRollover(
    new StateManager(),
    path.join(expiredDir, 'state.json'),
    { recordDurableCheckpoint: (checkpoint) => checkpoints.push(checkpoint) },
  ), true);
  assert.deepEqual(checkpoints.map(({ kind }) => kind), [
    'autonomous_budget_rollover', 'autonomous_budget_rollover_consumed',
  ]);
  const consumed = new StateManager().read(path.join(expiredDir, 'state.json'));
  assert.equal(consumed.autonomous_budget_rollover_intent_id, null);
  assert.equal(consumed.autonomous_budget_consumed_intent_id,
    expired.state.autonomous_budget_rollover_intent_id);

  const currentDir = makeTempRoot('pickle-liveness-current-');
  writeJson(path.join(currentDir, 'state.json'), state({ session_dir: currentDir, max_time_minutes: 10 }));
  const current = reconcileSessionLiveness(currentDir, undefined, 1_700_000_120_000);
  assert.equal(current.stale, false);
  assert.equal(current.state.active, true);
  assert.equal(fs.existsSync(path.join(currentDir, 'state.json')), true);
});

test('legacy paused max_time session migrates once through mapped lookup, supervised ownership, and productive work', async () => {
  const dataRoot = makeTempRoot('pickle-legacy-max-time-data-');
  const workingDir = makeTempRoot('pickle-legacy-max-time-work-');
  const sessionDir = path.join(dataRoot, 'sessions', 'legacy-session');
  const statePath = path.join(sessionDir, 'state.json');
  const fakeBin = path.join(sessionDir, 'fake-bin');
  const stableIterationMarker = path.join(dataRoot, 'second-iteration-ready');
  const iterationCounter = path.join(dataRoot, 'iteration-count');
  fs.mkdirSync(fakeBin, { recursive: true });
  const startCommit = initializeGitRepository(workingDir);
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 9.9.9-test'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') { console.log('--output-last-message --add-dir'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const output = args[args.indexOf('--output-last-message') + 1];
const artifactDir = prompt.match(/Worker artifact dir: ([^\\n]+)/)?.[1]?.trim();
const invocationCount = fs.existsSync(process.env.PICKLE_TEST_ITERATION_COUNTER)
  ? Number(fs.readFileSync(process.env.PICKLE_TEST_ITERATION_COUNTER, 'utf8')) + 1 : 1;
fs.writeFileSync(process.env.PICKLE_TEST_ITERATION_COUNTER, String(invocationCount));
const priorIteration = invocationCount > 1;
if (artifactDir) {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(artifactDir + '/anatomy-park-summary.json', JSON.stringify({
    finding_family: 'legacy-migration-e2e', highest_severity_finding: 'productive real runner iteration',
    data_flow_path: 'daemon -> supervisor -> loop runner -> codex', fix_applied: 'advanced durable iteration',
    verification: ['real loop runner'], trap_doors: [], next_action: 'continue',
  }));
}
if (priorIteration) fs.writeFileSync(process.env.PICKLE_TEST_STABLE_ITERATION_MARKER, 'ready');
// Complete the first productive iteration promptly, then keep its successor live long
// enough to take the migration snapshot without racing another fixture iteration.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, priorIteration ? 15000 : 350);
fs.writeFileSync(output, '<promise>CONTINUE</promise>');
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  fs.chmodSync(fakeCodex, 0o755);
  writeJson(statePath, state({
    active: false,
    working_dir: fs.realpathSync(workingDir),
    session_dir: fs.realpathSync(sessionDir),
    step: 'paused',
    last_exit_reason: 'max_time',
    start_commit: startCommit,
    pinned_sha: startCommit,
    max_time_minutes: 1,
    history: [{ step: 'max_time', timestamp: '2023-11-14T22:14:20.000Z' }],
    current_ticket: null,
    tmux_mode: true,
  }));
  const seal = sealLegacySession(sessionDir, workingDir);
  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park', target: fs.realpathSync(workingDir), stall_limit: 5,
  });

  const previousRoot = process.env.PICKLE_DATA_ROOT;
  const previousTestMode = process.env.PICKLE_TEST_MODE;
  const previousMigrationRuntime = process.env.PICKLE_TEST_LEGACY_MIGRATION_RUNTIME_BIN;
  const previousPath = process.env.PATH;
  const previousStableIterationMarker = process.env.PICKLE_TEST_STABLE_ITERATION_MARKER;
  const previousIterationCounter = process.env.PICKLE_TEST_ITERATION_COUNTER;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  delete process.env.PICKLE_TEST_LEGACY_MIGRATION_RUNTIME_BIN;
  process.env.PATH = `${fakeBin}:${previousPath || ''}`;
  process.env.PICKLE_TEST_STABLE_ITERATION_MARKER = stableIterationMarker;
  process.env.PICKLE_TEST_ITERATION_COUNTER = iterationCounter;
  let restoredIdentity = null;
  let daemonIdentity = null;
  try {
    await updateSessionMap(fs.realpathSync(workingDir), sessionDir);
    const nowMs = Date.now();
    const callers = await Promise.all(Array.from({ length: 8 }, () => resolveSessionForCwd(workingDir)));
    assert.deepEqual(new Set(callers), new Set([sessionDir]), 'all concurrent mapped callers select one session');
    const mapped = callers[0];
    assert.equal(mapped, sessionDir, 'mapped get-session lookup retains the migrated session');

    const migrated = new StateManager().read(statePath);
    assert.equal(migrated.active, true);
    assert.ok(migrated.last_exit_reason === 'autonomous_budget_rollover' || migrated.last_exit_reason === null);
    assert.equal(migrated.legacy_max_time_migration.prd_seal_hash, seal.semantic_hash);
    assert.equal(migrated.legacy_max_time_migration.start_commit, startCommit);
    assert.equal(migrated.legacy_max_time_migration.pinned_sha, startCommit);
    assert.equal(migrated.legacy_max_time_migration.rollover_intent_id,
      migrated.autonomous_budget_rollover_intent_id ?? migrated.autonomous_budget_consumed_intent_id);
    assert.equal(migrated.legacy_max_time_migration.source_owner_spec_id, null);
    assert.equal(migrated.autonomous_owner_spec.spec_id,
      migrated.legacy_max_time_migration.target_owner_spec_id);
    assert.equal(migrated.history.filter(({ step }) => step === 'legacy_max_time_session_migrated').length, 1);
    assert.equal(migrated.history.filter(({ step }) => step === 'autonomous_budget_rollover').length, 1);
    assert.ok(['pending', 'restoring', 'restored'].includes(migrated.autonomous_owner_restoration.status));
    assert.equal(readLogicalPipeline(sessionDir).control_state, 'autonomous_execution');

    const restored = await waitForState(statePath, (current) => (
      current.autonomous_owner_restoration?.status === 'restored'
        && Number(current.iteration) >= 1
        && fs.existsSync(path.join(sessionDir, 'anatomy-park-summary.json'))
        && fs.existsSync(stableIterationMarker)
    ), 15_000);
    restoredIdentity = restored.autonomous_supervisor_identity;
    daemonIdentity = restored.autonomous_owner_recovery_daemon_identity;
    assert.equal(inspectProcessLivenessIdentity(restoredIdentity), 'matched');
    assert.equal(restored.autonomous_owner_spec.supervisor_path,
      path.resolve(new URL('../bin/supervised-runner.js', import.meta.url).pathname));
    assert.equal(restored.autonomous_owner_spec.runner_bin, 'loop-runner.js');
    assert.equal(restored.legacy_max_time_migration.status, 'rollover_consumed');
    assert.match(restored.legacy_max_time_migration.target_runtime.build_hash, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(path.join(sessionDir, 'loop-runner.log')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'anatomy-park-summary.json'), 'utf8'))
      .finding_family, 'legacy-migration-e2e');
    const sourceRuntime = {
      runtime_id: 'legacy-runtime', version: '1', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const targetRuntime = {
      runtime_id: 'current-runtime', version: '2', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const liveMigration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime);
    assert.equal(liveMigration.session_was_active, true);
    assert.equal(liveMigration.resume_checkpoint.ticket_id, null);
    assert.ok(new StateManager().read(statePath).iteration >= 1);
    new StateManager().update(statePath, (current) => {
      current.autonomous_budget_epoch = Number(current.autonomous_budget_epoch) + 1;
      return current;
    });
    const laterEpochLookup = reconcileSessionLiveness(sessionDir);
    assert.notEqual(laterEpochLookup.state.recovery_kind, 'legacy_max_time_migration_corrupt',
      'a consumed migration receipt remains valid after an ordinary later budget epoch');
  } finally {
    try {
      cancelLogicalPipelineByOperator(sessionDir, 'test cleanup');
    } catch {}
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    } catch {}
    let cleanupState = null;
    try { cleanupState = new StateManager().read(statePath); } catch {}
    for (const identity of [
      restoredIdentity,
      daemonIdentity,
      cleanupState?.autonomous_supervisor_identity,
      cleanupState?.autonomous_owner_recovery_daemon_identity,
    ]) {
      if (identity) reapRecordedLiveProcessGroup(identity);
    }
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
    if (previousTestMode === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = previousTestMode;
    if (previousMigrationRuntime === undefined) delete process.env.PICKLE_TEST_LEGACY_MIGRATION_RUNTIME_BIN;
    else process.env.PICKLE_TEST_LEGACY_MIGRATION_RUNTIME_BIN = previousMigrationRuntime;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousStableIterationMarker === undefined) delete process.env.PICKLE_TEST_STABLE_ITERATION_MARKER;
    else process.env.PICKLE_TEST_STABLE_ITERATION_MARKER = previousStableIterationMarker;
    if (previousIterationCounter === undefined) delete process.env.PICKLE_TEST_ITERATION_COUNTER;
    else process.env.PICKLE_TEST_ITERATION_COUNTER = previousIterationCounter;
  }
});

test('sealed validation-shaped legacy max_time state bootstraps the real mux supervisor without source control-plane fields', async () => {
  const dataRoot = makeTempRoot('pickle-legacy-validation-data-');
  const workingDir = makeTempRoot('pickle-legacy-validation-work-');
  const sessionDir = path.join(dataRoot, 'sessions', 'validation-session');
  const statePath = path.join(sessionDir, 'state.json');
  const fakeBin = path.join(sessionDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  let startCommit = initializeGitRepository(workingDir);
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({
    name: 'legacy-citadel-fixture', version: '1.0.0', scripts: { test: 'node --version' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd: workingDir });
  execFileSync('git', ['commit', '-qm', 'add release gate'], { cwd: workingDir });
  startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
${fakeLifecycleArtifactWriterSource()}
if (args[0] === '--version') { console.log('codex 9.9.9-test'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') { console.log('--output-last-message --add-dir'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const reportPath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const outputIndex = args.indexOf('--output-last-message');
if (!reportPath) {
  const phase = prompt.match(/You are executing the "([^"]+)" phase/)?.[1] || '';
  if (phase === 'implement') {
    fs.appendFileSync(path.join(process.cwd(), 'tracked.txt'), 'remediated\\n');
    cp.execFileSync('git', ['add', 'tracked.txt']);
    cp.execFileSync('git', ['-c', 'user.name=Pickle Test', '-c', 'user.email=pickle@example.invalid',
      'commit', '-qm', 'fix release validation', '-m', 'Pickle-Ticket: release-validation']);
  }
  if (phase) {
    writeFakeLifecycleArtifact(prompt, phase);
    if (phase === 'implement') {
      const artifactPath = prompt.split('\\n').find((line) => line.startsWith('Lifecycle artifact path: '))
        ?.slice('Lifecycle artifact path: '.length).trim();
      if (artifactPath) {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        artifact.files_changed = ['tracked.txt'];
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
      }
    }
  }
  if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], '<promise>DONE</promise>');
  process.exit(0);
}
const sessionDir = path.dirname(path.dirname(path.dirname(reportPath)));
const countPath = path.join(sessionDir, 'legacy-citadel-review-count');
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;
fs.writeFileSync(countPath, String(count));
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
const block = count === 1;
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  schema_version: 1, verdict: block ? 'block' : 'approve', reviewed_range: reviewedRange,
  acceptance_criteria_checked: criteria,
  findings: block ? [{ severity: 'high', title: 'Legacy release requires resumed validation',
    evidence: 'The pre-control-plane session stopped before final approval.', file: 'tracked.txt', line: 1,
    recommendation: 'Resume the sealed Citadel review.', ticket_ids: ['release-validation'],
    acceptance_criteria: ['Release remains sealed.'], paths: ['tracked.txt'] }] : [],
  generated_at: new Date().toISOString(),
}));
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], '<promise>THE_CITADEL_APPROVES</promise>');
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 1 } }));
`);
  fs.chmodSync(fakeCodex, 0o755);
  writeJson(statePath, state({
    active: false,
    working_dir: fs.realpathSync(workingDir),
    session_dir: fs.realpathSync(sessionDir),
    step: 'paused',
    iteration: 0,
    worker_timeout_seconds: 60,
    last_exit_reason: 'max_time',
    start_commit: startCommit,
    pinned_sha: startCommit,
    tmux_mode: false,
    pipeline_mode: false,
    tmux_runner_pid: null,
    worker_pid: null,
    active_child_pid: null,
    current_ticket: null,
    history: [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }],
  }));
  const seal = sealLegacySession(sessionDir, workingDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'release-validation', title: 'Validate release', status: 'Done', priority: 'P0',
      depends_on: [], allowed_paths: ['tracked.txt'], acceptance_criteria: ['Release remains sealed.'],
      verification: [{ kind: 'process', executable: 'node', args: ['--version'] }],
    }],
  });
  assert.equal(fs.existsSync(path.join(sessionDir, 'logical-pipeline.json')), false);
  const source = new StateManager().read(statePath);
  for (const field of ['autonomous_owner_spec', 'autonomous_owner_restoration',
    'autonomous_supervisor_pid', 'autonomous_supervisor_identity',
    'autonomous_owner_recovery_daemon_pid', 'autonomous_owner_recovery_daemon_identity']) {
    assert.equal(source[field], undefined, `source fixture must omit ${field}`);
  }

  const previousRoot = process.env.PICKLE_DATA_ROOT;
  const previousPath = process.env.PATH;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  process.env.PATH = `${fakeBin}:${previousPath || ''}`;
  let supervisorIdentity = null;
  let daemonIdentity = null;
  try {
    assert.equal(await runCitadel(sessionDir), 'citadel-blocked', 'fixture starts from authenticated blocked Citadel evidence');
    const baselineReviewCount = Number(fs.readFileSync(path.join(sessionDir, 'legacy-citadel-review-count'), 'utf8'));
    new StateManager().update(statePath, (current) => {
      current.active = false;
      current.step = 'paused';
      current.last_exit_reason = 'max_time';
      current.completed_at = null;
      current.cancel_requested_at = null;
      current.cancelled = false;
      current.recovery_required = false;
      current.orphan_child_pid = null;
      current.orphan_recovery = null;
      current.active_child_pid = null;
      current.active_child_identity = null;
      current.autonomous_budget_rollover_intent_id = null;
      current.autonomous_budget_rollover_checkpoint_pending = null;
      current.autonomous_owner_restoration = null;
      current.history = [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }];
      return current;
    });
    assert.equal(validateCitadelRecoveryEvidence(
      sessionDir, fs.realpathSync(workingDir), new StateManager().read(statePath),
    ).report_verdict, 'block');
    await updateSessionMap(fs.realpathSync(workingDir), sessionDir);
    assert.equal(await resolveSessionForCwd(workingDir), sessionDir);
    assert.ok(new StateManager().read(statePath).legacy_max_time_migration, 'mapped lookup records migration receipt');
    const completion = await waitForLegacyMigrationCompletion(statePath, sessionDir, (current) => (
      current.legacy_max_time_migration?.status === 'rollover_consumed'
        && current.autonomous_budget_rollover_intent_id === null
        && current.step === 'complete'
        && readLogicalPipeline(sessionDir).terminal_state === 'completed'
        && fs.existsSync(path.join(sessionDir, 'citadel-report.json'))
        && JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-report.json'), 'utf8')).verdict === 'approve'
        && fs.existsSync(path.join(sessionDir, 'citadel-release-approval.json'))
        && fs.existsSync(path.join(sessionDir, 'mux-runner.log'))
        && persistedIdentityLiveness(current.autonomous_supervisor_identity) === 'not-running'
        && current.worker_pid == null
        && current.active_child_pid == null
        && current.active_child_identity == null
    ), {
      workerTimeoutSeconds: Number(new StateManager().read(statePath).worker_timeout_seconds || 60),
      baselineReviewCount,
    });
    const restored = completion.state;
    supervisorIdentity = completion.supervisorIdentity || restored.autonomous_supervisor_identity;
    daemonIdentity = completion.daemonIdentity || restored.autonomous_owner_recovery_daemon_identity;
    assert.equal(inspectProcessLivenessIdentity(supervisorIdentity), 'not-running',
      'the exact supervisor must exit after committing logical completion');
    assert.ok(daemonIdentity, 'the recovery daemon identity must be observed before its terminal cleanup');
    assert.equal(inspectProcessLivenessIdentity(daemonIdentity), 'not-running',
      'the exact observed recovery daemon must exit after logical completion');
    assert.equal(restored.worker_pid, null);
    assert.equal(restored.active_child_pid, null);
    assert.equal(restored.active_child_identity, null);
    for (const lockName of ['.session-operation.lock', '.legacy-max-time-migration-fence.lock',
      '.autonomous-owner-recovery-daemon.lock']) {
      assert.equal(fs.existsSync(path.join(sessionDir, lockName)), false, `${lockName} must be released`);
    }
    assertSessionOperationAvailable(sessionDir);
    assert.equal(restored.autonomous_owner_spec.runner_bin, 'mux-runner.js');
    assert.deepEqual(restored.autonomous_owner_spec.runner_args, ['--on-failure=retry']);
    assert.equal(restored.legacy_max_time_migration.source_owner_spec_id, null);
    assert.equal(restored.legacy_max_time_migration.execution_profile.derivation, 'sealed_standard_session');
    assert.equal(restored.legacy_max_time_migration.prd_seal_hash, seal.semantic_hash);
    assert.equal(restored.legacy_max_time_migration.execution_profile.citadel_recovery_authority.report_verdict, 'block');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-report.json'), 'utf8')).verdict, 'approve');
    assert.equal(restored.autonomous_budget_rollover_intent_id, null);
    assert.ok(restored.autonomous_budget_consumed_intent_id);
    assert.equal(readLogicalPipeline(sessionDir).control_state, 'autonomous_execution');
    assert.match(fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8'), /mux-runner started/);
    validateCitadelRecoveryEvidence(sessionDir, fs.realpathSync(workingDir), restored, {
      allowRepositoryDescendantOf: restored.legacy_max_time_migration.execution_profile.repository_head,
    });
    const terminalLookup = reconcileSessionLiveness(sessionDir);
    assert.equal(terminalLookup.state.step, 'complete');
    assert.equal(terminalLookup.state.recovery_kind, undefined,
      'an authenticated completed migration remains terminal on later mapped lookup');
    const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
    const crashWindowLogical = JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
    crashWindowLogical.terminal_state = null;
    fs.writeFileSync(logicalPath, JSON.stringify(crashWindowLogical));
    const incompleteTerminalLookup = reconcileSessionLiveness(sessionDir);
    assert.equal(incompleteTerminalLookup.state.step, 'blocked');
    assert.equal(incompleteTerminalLookup.state.recovery_kind, 'legacy_max_time_migration_corrupt',
      'state completion without authenticated logical completion fails closed');
  } finally {
    try { cancelLogicalPipelineByOperator(sessionDir, 'test cleanup'); } catch {}
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    } catch {}
    let cleanupState = null;
    try { cleanupState = new StateManager().read(statePath); } catch {}
    const cleanupResults = [];
    const cleanupIdentities = [
      supervisorIdentity,
      daemonIdentity,
      cleanupState?.autonomous_supervisor_identity,
      cleanupState?.autonomous_owner_recovery_daemon_identity,
    ].filter((identity, index, all) => identity
      && all.findIndex((candidate) => candidate?.fingerprint === identity.fingerprint) === index);
    for (const identity of cleanupIdentities) {
      cleanupResults.push(reapRecordedLiveProcessGroup(identity));
    }
    for (const result of cleanupResults) {
      assert.ok(['reaped', 'not-running'].includes(result.status),
        `legacy migration cleanup could not prove exact reaping: ${JSON.stringify(result)}`);
    }
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('completed migrated pipeline remains terminal after its exact supervisor exits', async () => {
  const dataRoot = makeTempRoot('pickle-legacy-pipeline-data-');
  const workingDir = makeTempRoot('pickle-legacy-pipeline-work-');
  const sessionDir = path.join(dataRoot, 'sessions', 'pipeline-session');
  const statePath = path.join(sessionDir, 'state.json');
  const fakeBin = path.join(sessionDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  initializeGitRepository(workingDir);
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({
    name: 'legacy-pipeline-fixture', version: '1.0.0', scripts: { test: 'node --version' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd: workingDir });
  execFileSync('git', ['commit', '-qm', 'add pipeline release gate'], { cwd: workingDir });
  const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workingDir, encoding: 'utf8',
  }).trim();
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 9.9.9-test'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') { console.log('--output-last-message --add-dir'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const reportPath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const outputIndex = args.indexOf('--output-last-message');
if (!reportPath) process.exit(2);
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
fs.mkdirSync(require('node:path').dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  schema_version: 1, verdict: 'approve', reviewed_range: reviewedRange,
  acceptance_criteria_checked: criteria, findings: [], generated_at: new Date().toISOString(),
}));
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], '<promise>THE_CITADEL_APPROVES</promise>');
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 1 } }));
`);
  fs.chmodSync(fakeCodex, 0o755);
  writeJson(statePath, state({
    active: false,
    working_dir: fs.realpathSync(workingDir),
    session_dir: fs.realpathSync(sessionDir),
    step: 'paused',
    iteration: 0,
    last_exit_reason: 'max_time',
    start_commit: startCommit,
    pinned_sha: startCommit,
    tmux_mode: false,
    pipeline_mode: true,
    tmux_runner_pid: null,
    worker_pid: null,
    active_child_pid: null,
    history: [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }],
  }));
  sealLegacySession(sessionDir, workingDir);
  writeJson(path.join(sessionDir, 'pipeline.json'), {
    schema_version: 1,
    working_dir: fs.realpathSync(workingDir),
    target: fs.realpathSync(workingDir),
    phases: ['citadel'],
    skip_flags: { anatomy: true, szechuan: true },
    bootstrap_source: 'task',
    task: 'finish the sealed migrated pipeline',
    scope: [],
  });
  writeJson(path.join(sessionDir, 'pipeline-state.json'), {
    schema_version: 1,
    current_phase: 'citadel',
    current_phase_index: 0,
    phase_statuses: { citadel: 'todo' },
    started_at: '2026-08-09T07:00:00.000Z',
    phase_started_at: null,
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'release-validation', title: 'Validate pipeline release', status: 'Done',
      acceptance_criteria: ['The autonomous owner performs productive work.'],
      verification: [{ kind: 'process', executable: 'node', args: ['--version'] }],
    }],
  });

  const previousRoot = process.env.PICKLE_DATA_ROOT;
  const previousPath = process.env.PATH;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  process.env.PATH = `${fakeBin}:${previousPath || ''}`;
  let supervisorIdentity = null;
  let daemonIdentity = null;
  try {
    await updateSessionMap(fs.realpathSync(workingDir), sessionDir);
    assert.equal(await resolveSessionForCwd(workingDir), sessionDir);
    const completed = await waitForState(statePath, (current) => (
      current.legacy_max_time_migration?.status === 'rollover_consumed'
        && current.step === 'complete'
        && readLogicalPipeline(sessionDir).terminal_state === 'completed'
        && JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-state.json'), 'utf8')).completed_at
        && inspectProcessLivenessIdentity(current.autonomous_supervisor_identity) === 'not-running'
    ), 40_000);
    supervisorIdentity = completed.autonomous_supervisor_identity;
    daemonIdentity = completed.autonomous_owner_recovery_daemon_identity;
    assert.equal(completed.legacy_max_time_migration.execution_profile.runner_mode, 'pipeline');
    assert.equal(completed.legacy_max_time_migration.execution_profile.runner_bin, 'pipeline-runner.js');
    const reconciled = reconcileSessionLiveness(sessionDir);
    assert.equal(reconciled.state.step, 'complete');
    assert.equal(reconciled.state.recovery_kind, undefined);
    assert.equal(readLogicalPipeline(sessionDir).terminal_state, 'completed');
  } finally {
    let cleanupState = null;
    try { cleanupState = new StateManager().read(statePath); } catch {}
    for (const identity of [
      supervisorIdentity,
      daemonIdentity,
      cleanupState?.autonomous_supervisor_identity,
      cleanupState?.autonomous_owner_recovery_daemon_identity,
    ]) {
      if (identity) reapRecordedLiveProcessGroup(identity);
    }
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('mapped legacy migration refuses a cwd already claimed by another live session', async () => {
  const dataRoot = makeTempRoot('pickle-legacy-exclusive-data-');
  const workingDir = makeTempRoot('pickle-legacy-exclusive-work-');
  const legacyDir = path.join(dataRoot, 'sessions', 'legacy');
  const liveDir = path.join(dataRoot, 'sessions', 'live');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });
  const startCommit = initializeGitRepository(workingDir);
  writeJson(path.join(legacyDir, 'state.json'), state({
    active: false,
    working_dir: fs.realpathSync(workingDir),
    session_dir: fs.realpathSync(legacyDir),
    step: 'paused',
    last_exit_reason: 'max_time',
    start_commit: startCommit,
    pinned_sha: startCommit,
    history: [
      { step: 'implement', timestamp: '2023-11-14T22:13:20.000Z' },
      { step: 'max_time', timestamp: '2023-11-14T22:14:20.000Z' },
    ],
  }));
  sealLegacySession(legacyDir, workingDir);
  createLogicalPipeline(legacyDir, 'legacy-exclusive');
  beginAutonomousExecution(legacyDir);
  registerProcessOwner(legacyDir);
  new StateManager().update(path.join(legacyDir, 'state.json'), (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = deadProcessIdentity();
    return current;
  });
  writeJson(path.join(liveDir, 'state.json'), state({
    active: true,
    working_dir: fs.realpathSync(workingDir),
    session_dir: fs.realpathSync(liveDir),
  }));
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    await updateSessionMap(fs.realpathSync(workingDir), legacyDir);
    assert.equal(await resolveSessionForCwd(workingDir), legacyDir);
    const legacy = new StateManager().read(path.join(legacyDir, 'state.json'));
    assert.equal(legacy.active, false);
    assert.equal(legacy.autonomous_budget_rollover_intent_id, undefined);
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('legacy bootstrap classifier rejects approval, adoption, partial pipeline, and conflicting loop artifacts', () => {
  for (const fixture of [
    { label: 'approved', write: (sessionDir) => writeJson(path.join(sessionDir, 'citadel-release-approval.json'), {}) },
    { label: 'adoption', write: (sessionDir) => writeJson(path.join(sessionDir, 'legacy-session-adoption-transaction.json'), {}) },
    { label: 'partial-pipeline', state: { pipeline_mode: true }, write: (sessionDir, workingDir) => writeJson(path.join(sessionDir, 'pipeline.json'), { working_dir: workingDir }) },
    { label: 'conflicting-loop-pipeline', state: { pipeline_mode: true }, write: (sessionDir, workingDir) => {
      writeJson(path.join(sessionDir, 'pipeline.json'), { working_dir: workingDir });
      writeJson(path.join(sessionDir, 'pipeline-state.json'), { schema_version: 1 });
      writeJson(path.join(sessionDir, 'loop_config.json'), { mode: 'anatomy-park', target: workingDir });
    } },
  ]) {
    const workingDir = makeTempRoot(`pickle-legacy-classifier-${fixture.label}-work-`);
    const sessionDir = makeTempRoot(`pickle-legacy-classifier-${fixture.label}-session-`);
    const startCommit = initializeGitRepository(workingDir);
    writeJson(path.join(sessionDir, 'state.json'), state({
      active: false,
      working_dir: fs.realpathSync(workingDir),
      session_dir: fs.realpathSync(sessionDir),
      step: 'paused',
      last_exit_reason: 'max_time',
      start_commit: startCommit,
      pinned_sha: startCommit,
      tmux_mode: true,
      pipeline_mode: false,
      tmux_runner_pid: null,
      worker_pid: null,
      active_child_pid: null,
      history: [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }],
      ...fixture.state,
    }));
    sealLegacySession(sessionDir, workingDir);
    writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
      tickets: [{ id: 'release-validation', title: 'Validate release', status: 'Done' }],
    });
    fixture.write(sessionDir, fs.realpathSync(workingDir));
    const result = reconcileSessionLiveness(sessionDir, undefined, Date.now(), { allowLegacyMaxTimeMigration: true });
    assert.equal(result.state.active, false, fixture.label);
    assert.equal(result.state.legacy_max_time_migration, undefined, fixture.label);
    assert.equal(fs.existsSync(path.join(sessionDir, 'logical-pipeline.json')), false, fixture.label);
  }
});

test('legacy logical bootstrap resumes both pre-seal and post-seal crash stages under the same source CAS', async () => {
  const dataRoot = makeTempRoot('pickle-legacy-logical-data-');
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    for (const stage of ['pre-seal', 'post-seal']) {
    const workingDir = makeTempRoot(`pickle-legacy-logical-${stage}-work-`);
    const sessionDir = path.join(dataRoot, 'sessions', `${stage}-session`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');
    const startCommit = initializeGitRepository(workingDir);
    writeJson(statePath, state({
      active: false,
      working_dir: fs.realpathSync(workingDir),
      session_dir: fs.realpathSync(sessionDir),
      step: 'paused',
      last_exit_reason: 'max_time',
      start_commit: startCommit,
      pinned_sha: startCommit,
      tmux_mode: true,
      pipeline_mode: false,
      tmux_runner_pid: null,
      worker_pid: null,
      active_child_pid: null,
      history: [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }],
    }));
    sealLegacySession(sessionDir, workingDir);
    writeJson(path.join(sessionDir, 'loop_config.json'), {
      mode: 'anatomy-park', target: fs.realpathSync(workingDir), stall_limit: 5,
    });
    const source = new StateManager().read(statePath);
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const pipelineId = `legacy-max-time-${sourceHash.slice(0, 24)}`;
    createLogicalPipeline(sessionDir, pipelineId);
    if (stage === 'post-seal') beginAutonomousExecution(sessionDir);

    await updateSessionMap(fs.realpathSync(workingDir), sessionDir);
    assert.equal(await resolveSessionForCwd(workingDir), sessionDir, stage);
    const reconciled = new StateManager().read(statePath);
    assert.equal(reconciled.active, true, stage);
    assert.equal(reconciled.legacy_max_time_migration.source_state_sha256, sourceHash, stage);
    assert.equal(reconciled.legacy_max_time_migration.logical_pipeline_id, pipelineId, stage);
    assert.ok(['pending', 'restoring', 'restored'].includes(reconciled.autonomous_owner_restoration.status), stage);
    assert.equal(readLogicalPipeline(sessionDir).control_state, 'autonomous_execution', stage);
    const owned = await waitForState(statePath, (current) => (
      current.autonomous_owner_recovery_daemon_identity
    ), 5_000);
    try { cancelLogicalPipelineByOperator(sessionDir, 'test cleanup'); } catch {}
    new StateManager().update(statePath, (current) => {
      current.cancel_requested_at ||= new Date().toISOString();
      current.last_exit_reason = 'cancelled';
      return current;
    });
    const final = new StateManager().read(statePath);
    for (const identity of [final.autonomous_supervisor_identity, owned.autonomous_owner_recovery_daemon_identity]) {
      if (!identity) continue;
      assert.ok(['reaped', 'not-running'].includes(reapRecordedLiveProcessGroup(identity).status), stage);
    }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('cwd authority timeout releases the in-process queue for a later mapped lookup', async () => {
  const dataRoot = makeTempRoot('pickle-cwd-authority-timeout-data-');
  const workingDir = makeTempRoot('pickle-cwd-authority-timeout-work-');
  const sessionDir = path.join(dataRoot, 'sessions', 'active');
  fs.mkdirSync(sessionDir, { recursive: true });
  const exactCwd = fs.realpathSync(workingDir);
  writeJson(path.join(sessionDir, 'state.json'), state({
    active: true,
    working_dir: exactCwd,
    session_dir: fs.realpathSync(sessionDir),
  }));
  const digest = crypto.createHash('sha256').update(exactCwd).digest('hex');
  const lockPath = path.join(dataRoot, 'sessions', `.cwd-authority-${digest}.lock`);
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    await updateSessionMap(exactCwd, sessionDir);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await assert.rejects(resolveSessionForCwd(exactCwd), /Failed to acquire lock/);
    fs.rmSync(lockPath, { force: true });
    assert.equal(await resolveSessionForCwd(exactCwd), sessionDir);
  } finally {
    fs.rmSync(lockPath, { force: true });
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('legacy max_time reconciliation does not resurrect unsealed, completed, cancelled, or unsafe inactive state', () => {
  const nowMs = 1_700_000_120_000;
  for (const [label, override] of [
    ['unsealed', {}],
    ['completed', { step: 'complete', completed_at: '2023-11-14T22:15:00.000Z' }],
    ['cancelled', { cancel_requested_at: '2023-11-14T22:15:00.000Z' }],
    ['unsafe', { recovery_required: true, recovery_reason: 'operator evidence' }],
    ['logical-cancelled', {}],
  ]) {
    const workingDir = makeTempRoot(`pickle-legacy-${label}-work-`);
    const sessionDir = makeTempRoot(`pickle-legacy-${label}-session-`);
    const startCommit = initializeGitRepository(workingDir);
    writeJson(path.join(sessionDir, 'state.json'), state({
      active: false, working_dir: fs.realpathSync(workingDir), session_dir: fs.realpathSync(sessionDir),
      step: 'paused', last_exit_reason: 'max_time',
      start_commit: startCommit, pinned_sha: startCommit,
      history: [
        { step: 'implement', timestamp: '2023-11-14T22:13:20.000Z' },
        { step: 'max_time', timestamp: '2023-11-14T22:14:20.000Z' },
      ],
      ...override,
    }));
    registerProcessOwner(sessionDir);
    new StateManager().update(path.join(sessionDir, 'state.json'), (current) => {
      current.autonomous_supervisor_pid = 999_999_999;
      current.autonomous_supervisor_identity = deadProcessIdentity();
      return current;
    });
    if (label !== 'unsealed') {
      sealLegacySession(sessionDir, workingDir);
      createLogicalPipeline(sessionDir, `legacy-${label}`);
      beginAutonomousExecution(sessionDir);
      if (label === 'logical-cancelled') cancelLogicalPipelineByOperator(sessionDir, 'already cancelled');
    }
    const result = reconcileSessionLiveness(sessionDir, undefined, nowMs, { allowLegacyMaxTimeMigration: true });
    assert.equal(result.state.active, false, `${label} remains inactive`);
    assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined, `${label} gets no intent`);
    assert.equal(result.state.legacy_max_time_migration, undefined, `${label} gets no receipt`);
  }
});

test('legacy max_time migration rejects every modern side ledger without state or bootstrap writes', () => {
  const evidenceCases = [
    ['active-child-pid', { active_child_pid: 7000 }],
    ['malformed-active-child-pid', { active_child_pid: '0' }],
    ['worker-pid', { worker_pid: 7000 }],
    ['malformed-worker-pid', { worker_pid: '0' }],
    ['tmux-runner-pid', { tmux_runner_pid: 7000 }],
    ['malformed-tmux-runner-pid', { tmux_runner_pid: '0' }],
    ['active-child-identity', { active_child_identity: deadProcessIdentity() }],
    ['controller-pid', { active_child_controller_pid: 7001 }],
    ['controller-identity', { active_child_controller_identity: deadProcessIdentity() }],
    ['active-ledger', { active_child_identities: [deadProcessIdentity()] }],
    ['malformed-active-ledger', { active_child_identities: {} }],
    ['refinement-ledger', { refinement_child_identities: [deadProcessIdentity()] }],
    ['malformed-refinement-ledger', { refinement_child_identities: 'corrupt' }],
    ['supervisor-pid', { autonomous_supervisor_pid: 7002 }],
    ['malformed-supervisor-pid', { autonomous_supervisor_pid: '0' }],
    ['supervisor-identity', { autonomous_supervisor_identity: deadProcessIdentity() }],
    ['owner-spec', { autonomous_owner_spec: { spec_id: 'modern-owner' } }],
    ['owner-restoration', { autonomous_owner_restoration: { status: 'pending' } }],
    ['owner-handoff', { autonomous_owner_handoff_transaction: { status: 'prepared' } }],
    ['recovery-daemon-pid', { autonomous_owner_recovery_daemon_pid: 7003 }],
    ['recovery-daemon-identity', { autonomous_owner_recovery_daemon_identity: deadProcessIdentity() }],
    ['watchdog-pid', { cancellation_recovery_watchdog_pid: 7004 }],
    ['watchdog-identity', { cancellation_recovery_watchdog_identity: deadProcessIdentity() }],
    ['watchdog-arm-id', { cancellation_recovery_watchdog_arm_id: 'arm-1' }],
    ['watchdog-arm', { cancellation_recovery_watchdog_arm: { arm_id: 'arm-1' } }],
    ['runtime-binding', { cancellation_recovery_runtime_binding: { runtime_root: '/runtime' } }],
    ['cancellation-recovery', { cancellation_recovery: { status: 'pending' } }],
    ['recovery-required', { recovery_required: true }],
    ['malformed-recovery-required', { recovery_required: 'false' }],
    ['recovery-kind', { recovery_kind: 'cancellation_ownership' }],
    ['recovery-reason', { recovery_reason: 'pending recovery' }],
    ['orphan-recovery', { orphan_recovery: { status: 'ambiguous' } }],
    ['orphan-child', { orphan_child_pid: 7005 }],
    ['malformed-zero-orphan-child', { orphan_child_pid: '0' }],
    ['recovery-suspended', { autonomous_owner_recovery_suspended: true }],
    ['malformed-recovery-suspended', { autonomous_owner_recovery_suspended: 'false' }],
    ['handoff-suspended', { autonomous_owner_recovery_suspended_for_handoff: 'handoff-1' }],
    ['cancel-requested', { cancel_requested_at: '2026-08-10T00:00:00.000Z' }],
    ['cancelled-flag', { cancelled: true }],
    ['manager-relaunch-epoch', { manager_relaunch_recovery_epoch: 2 }],
    ['malformed-manager-relaunch-epoch', { manager_relaunch_recovery_epoch: '0' }],
    ['manager-relaunch-route', { manager_relaunch_recovery_route: 'fenced_executor_takeover' }],
    ['manager-relaunch-status', { manager_relaunch_recovery_status: 'active' }],
    ['manager-relaunch-activated', { manager_relaunch_recovery_activated_at: '2026-08-10T00:00:00.000Z' }],
    ['manager-relaunch-consumed', { manager_relaunch_recovery_consumed_at: '2026-08-10T00:00:00.000Z' }],
    ['artifact-contract-recovery', { artifact_contract_recovery: { status: 'pending' } }],
    ['budget-rollover-intent', { autonomous_budget_rollover_intent_id: 'rollover-1' }],
    ['budget-rollover-checkpoint', { autonomous_budget_rollover_checkpoint_pending: { intent_id: 'rollover-1' } }],
    ['budget-consumed-intent', { autonomous_budget_consumed_intent_id: 'rollover-1' }],
    ['budget-consumed-checkpoint', { autonomous_budget_consumed_checkpoint_pending: { intent_id: 'rollover-1' } }],
    ['budget-checkpoint-error', { autonomous_budget_checkpoint_error: 'checkpoint transport failed' }],
  ];
  for (const [label, evidence] of evidenceCases) {
    const workingDir = makeTempRoot(`pickle-legacy-side-ledger-${label}-work-`);
    const sessionDir = makeTempRoot(`pickle-legacy-side-ledger-${label}-session-`);
    const statePath = path.join(sessionDir, 'state.json');
    const startCommit = initializeGitRepository(workingDir);
    writeJson(statePath, state({
      active: false,
      working_dir: fs.realpathSync(workingDir),
      session_dir: fs.realpathSync(sessionDir),
      step: 'paused',
      last_exit_reason: 'max_time',
      start_commit: startCommit,
      pinned_sha: startCommit,
      history: [{ step: 'max_time', timestamp: '2026-08-09T07:37:50.045Z' }],
      ...evidence,
    }));
    sealLegacySession(sessionDir, workingDir);
    createLogicalPipeline(sessionDir, `legacy-side-ledger-${label}`);
    beginAutonomousExecution(sessionDir);
    const paths = [
      statePath,
      path.join(sessionDir, 'logical-pipeline.json'),
      path.join(sessionDir, 'prd_refined.md'),
      path.join(sessionDir, 'refinement-acceptance.json'),
    ];
    const before = paths.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);

    const result = reconcileSessionLiveness(sessionDir, undefined, Date.now(), { allowLegacyMaxTimeMigration: true });
    assert.equal(result.state.active, false, label);
    assert.equal(result.state.legacy_max_time_migration, undefined, label);
    assert.deepEqual(paths.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null), before, label);
  }
});

test('tampered legacy max_time migration transaction blocks owner recovery', () => {
  const sessionDir = makeTempRoot('pickle-legacy-migration-tamper-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: fs.realpathSync(sessionDir),
    working_dir: fs.realpathSync(sessionDir),
    legacy_max_time_migration: {
      schema_version: 1,
      migration_id: 'migration',
      status: 'rollover_scheduled',
      contract_sha256: '0'.repeat(64),
    },
  }));
  const result = reconcileSessionLiveness(sessionDir);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.recovery_kind, 'legacy_max_time_migration_corrupt');
  assert.equal(result.state.autonomous_owner_recovery_suspended, true);
});

test('elapsed liveness repair never resurrects cancellation or unsafe rollover evidence', () => {
  const nowMs = 1_700_000_120_000;
  const cancelledDir = makeTempRoot('pickle-liveness-cancelled-expired-');
  writeJson(path.join(cancelledDir, 'state.json'), state({
    session_dir: cancelledDir,
    max_time_minutes: 1,
    cancel_requested_at: new Date(nowMs - 1_000).toISOString(),
    last_exit_reason: 'cancelled',
  }));
  const cancelled = reconcileSessionLiveness(cancelledDir, undefined, nowMs);
  assert.equal(cancelled.state.autonomous_budget_rollover_intent_id, undefined);
  assert.equal(cancelled.state.last_exit_reason, 'cancelled');

  const unsafeDir = makeTempRoot('pickle-liveness-unsafe-expired-');
  writeJson(path.join(unsafeDir, 'state.json'), state({
    session_dir: unsafeDir,
    max_time_minutes: 1,
    recovery_required: true,
    recovery_reason: 'operator-owned recovery evidence',
    step: 'blocked',
  }));
  const unsafe = reconcileSessionLiveness(unsafeDir, undefined, nowMs);
  assert.equal(unsafe.stale, false);
  assert.equal(unsafe.state.recovery_required, true);
  assert.equal(unsafe.state.recovery_reason, 'operator-owned recovery evidence');
  assert.equal(unsafe.state.autonomous_budget_rollover_intent_id, undefined);

  const corruptDir = makeTempRoot('pickle-liveness-corrupt-rollover-');
  writeJson(path.join(corruptDir, 'state.json'), state({
    session_dir: corruptDir,
    working_dir: corruptDir,
    max_time_minutes: 1,
    autonomous_budget_epoch: 'not-an-epoch',
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(corruptDir);
  assert.throws(
    () => reconcileSessionLiveness(corruptDir, undefined, nowMs),
    /corrupt epoch/,
  );
  const corrupt = new StateManager().read(path.join(corruptDir, 'state.json'));
  assert.equal(corrupt.active, true);
  assert.equal(corrupt.autonomous_budget_rollover_intent_id, undefined);

  const unboundDir = makeTempRoot('pickle-liveness-unbound-rollover-');
  writeJson(path.join(unboundDir, 'state.json'), state({
    session_dir: unboundDir,
    working_dir: unboundDir,
    max_time_minutes: 1,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
    autonomous_budget_rollover_checkpoint_pending: {
      kind: 'autonomous_budget_rollover', intent_id: 'lost-intent', epoch: 1,
    },
  }));
  registerProcessOwner(unboundDir);
  assert.throws(
    () => reconcileSessionLiveness(unboundDir, undefined, nowMs),
    /unbound recovery evidence/,
  );
  assert.equal(new StateManager().read(path.join(unboundDir, 'state.json'))
    .autonomous_budget_rollover_intent_id, undefined);

  const corruptIntentDir = makeTempRoot('pickle-liveness-corrupt-intent-');
  writeJson(path.join(corruptIntentDir, 'state.json'), state({
    session_dir: corruptIntentDir,
    max_time_minutes: 1,
    autonomous_budget_epoch: 0,
    autonomous_budget_rollover_intent_id: 'intent-without-epoch',
  }));
  assert.throws(
    () => reconcileSessionLiveness(corruptIntentDir, undefined, nowMs),
    /intent has a corrupt epoch/,
  );
});

test('elapsed repair blocks a live ambiguous child and never publishes a rollover intent', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-live-child-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    active_child_pid: process.pid,
    active_child_kind: 'codex',
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);

  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.last_exit_reason, 'max_time_orphaned_child');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.active_child_pid, process.pid);
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed repair reaps an exact child before atomically publishing rollover ownership', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-exact-child-');
  const child = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)', '--', '--add-dir', sessionDir,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  const identity = captureSpawnedProcessIdentity(Number(child.pid));
  assert.ok(identity);
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    active_child_pid: child.pid,
    active_child_kind: 'codex',
    active_child_identity: identity,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);
  try {
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
    assert.equal(result.stale, false);
    assert.equal(result.state.active, true);
    assert.equal(result.state.last_exit_reason, 'autonomous_budget_rollover');
    assert.ok(result.state.autonomous_budget_rollover_intent_id);
    assert.equal(result.state.active_child_pid, null);
    assert.equal(result.state.active_child_identity, null);
    assert.equal(result.state.recovery_required, undefined);
  } finally {
    try { process.kill(-Number(child.pid), 'SIGKILL'); } catch {}
  }
});

test('elapsed foreground session without an authenticated owner contract blocks without orphaning an intent', () => {
  const sessionDir = makeTempRoot('pickle-liveness-expired-unsupervised-');
  writeJson(path.join(sessionDir, 'state.json'), state({ session_dir: sessionDir, max_time_minutes: 1 }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_120_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, true);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.recovery_kind, 'autonomous_owner_contract_invalid');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed process session restores one authenticated detached supervisor with exact argv and cwd', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'replacement.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  const spec = registerAutonomousOwnerSpec(
    sessionDir,
    'mux-runner.js',
    ['--process-owner-proof'],
    undefined,
    path.join(runtimeDir, 'supervised-runner.js'),
  );
  assert.equal(spec.owner_mode, 'process');
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });

  let restoredIdentity = null;
  try {
    const nowMs = 1_700_000_120_000;
    const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
    assert.equal(reconciled.state.last_exit_reason, 'autonomous_budget_rollover');
    assert.equal(reconciled.state.autonomous_owner_restoration.status, 'pending');
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => (
      runRestoreProcess(sessionDir, nowMs + 1_000)
    )));
    assert.equal(outcomes.filter((outcome) => outcome === 'restored').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === 'noop').length, 11);
    const restored = new StateManager().read(statePath);
    restoredIdentity = restored.autonomous_supervisor_identity;
    assert.equal(restored.autonomous_owner_restoration.status, 'restored');
    assert.equal(restored.history.filter(({ step }) => step === 'autonomous_owner_restored').length, 1);
    assert.equal(inspectProcessLivenessIdentity(restoredIdentity), 'matched');
    await waitForState(statePath, () => fs.existsSync(markerPath));
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.deepEqual(marker.argv, [fs.realpathSync(sessionDir), '--runner-bin=mux-runner.js', '--process-owner-proof']);
    assert.equal(marker.cwd, fs.realpathSync(sessionDir));
    assert.equal(marker.pid, restoredIdentity.pid);
    assert.equal(restoredIdentity.pgid, restoredIdentity.pid);
  } finally {
    if (restoredIdentity) reapRecordedLiveProcessGroup(restoredIdentity);
  }
});

test('process owner registration converges a crash snapshot and preserves corrupt immutable evidence', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-register-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, state({ session_dir: sessionDir, working_dir: sessionDir }));
  const spec = registerProcessOwner(sessionDir);
  new StateManager().update(statePath, (current) => {
    current.autonomous_budget_epoch = 2;
    current.autonomous_budget_rollover_intent_id = 'process-crash-rollover';
    current.autonomous_owner_restoration = {
      schema_version: 1,
      intent_id: 'process-crash-restoration',
      rollover_intent_id: 'process-crash-rollover',
      rollover_epoch: 2,
      owner_spec_id: spec.spec_id,
      status: 'restoring',
      attempt: 1,
      not_before: new Date(0).toISOString(),
      restorer_pid: 999_999_999,
      restorer_identity: null,
    };
    return current;
  });
  registerProcessOwner(sessionDir);
  let persisted = new StateManager().read(statePath);
  assert.equal(persisted.autonomous_owner_restoration.status, 'restored');
  assert.equal(persisted.autonomous_supervisor_pid, process.pid);
  assert.equal(persisted.history.filter(({ step }) => step === 'autonomous_owner_restored').length, 1);

  const corrupt = { ...persisted.autonomous_owner_spec, supervisor_sha256: '0'.repeat(64) };
  new StateManager().update(statePath, (current) => {
    current.autonomous_owner_spec = corrupt;
    current.autonomous_supervisor_pid = null;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  assert.throws(() => registerProcessOwner(sessionDir), /Refusing to overwrite a corrupt/);
  persisted = new StateManager().read(statePath);
  assert.deepEqual(persisted.autonomous_owner_spec, corrupt);
  assert.equal(persisted.autonomous_supervisor_pid, null);

  const raceDir = makeTempRoot('pickle-liveness-process-owner-register-race-');
  const raceStatePath = path.join(raceDir, 'state.json');
  const racedCorruption = { schema_version: 1, spec_id: 'corrupt-racing-owner-spec' };
  writeJson(raceStatePath, state({ session_dir: raceDir, working_dir: raceDir }));
  const racingManager = new InjectBeforeFirstUpdateStateManager((current) => {
    current.autonomous_owner_spec = racedCorruption;
    current.autonomous_supervisor_pid = null;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  assert.throws(
    () => registerAutonomousOwnerSpec(
      raceDir,
      'mux-runner.js',
      [],
      racingManager,
      path.resolve(new URL('../bin/supervised-runner.js', import.meta.url).pathname),
    ),
    /Refusing to overwrite a corrupt/,
  );
  const raced = new StateManager().read(raceStatePath);
  assert.deepEqual(raced.autonomous_owner_spec, racedCorruption);
  assert.equal(raced.autonomous_supervisor_pid, null);
});

test('process owner specification copied from another session fails closed before rollover publication', () => {
  const sourceDir = makeTempRoot('pickle-liveness-process-owner-source-');
  const targetDir = makeTempRoot('pickle-liveness-process-owner-target-');
  writeJson(path.join(sourceDir, 'state.json'), state({ session_dir: sourceDir, working_dir: sourceDir }));
  const foreignSpec = registerProcessOwner(sourceDir);
  writeJson(path.join(targetDir, 'state.json'), state({
    session_dir: targetDir,
    working_dir: targetDir,
    max_time_minutes: 1,
    autonomous_owner_spec: foreignSpec,
  }));
  const result = reconcileSessionLiveness(targetDir, undefined, 1_700_000_120_000);
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.recovery_kind, 'autonomous_owner_contract_invalid');
  assert.equal(result.state.autonomous_budget_rollover_intent_id, undefined);
});

test('elapsed repair rejects an immutable owner mutation racing the atomic rollover publication', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-rollover-race-');
  const statePath = path.join(sessionDir, 'state.json');
  const racedCorruption = { schema_version: 1, spec_id: 'corrupt-racing-rollover-spec' };
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerProcessOwner(sessionDir);
  const racingManager = new InjectBeforeFirstUpdateStateManager((current) => {
    current.autonomous_owner_spec = racedCorruption;
    return current;
  });
  assert.throws(
    () => reconcileSessionLiveness(sessionDir, racingManager, 1_700_000_120_000),
    /immutable owner state changed/,
  );
  const raced = new StateManager().read(statePath);
  assert.deepEqual(raced.autonomous_owner_spec, racedCorruption);
  assert.equal(raced.autonomous_budget_rollover_intent_id, undefined);
});

test('process owner restoration refuses changed runtime bytes without spawning a replacement', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-tamper-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  const markerPath = path.join(sessionDir, 'replacement-started');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  const reconciled = reconcileSessionLiveness(sessionDir, undefined, nowMs);
  assert.equal(reconciled.state.autonomous_owner_restoration.status, 'pending');
  fs.appendFileSync(path.join(runtimeDir, 'mux-runner.js'), '// changed after registration\n');
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000),
    /Refusing to restore.*immutable runtime identity/s,
  );
  const failed = new StateManager().read(statePath);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
  assert.equal(fs.existsSync(markerPath), false);
});

test('process owner restoration gives concurrent cancellation dominance and fences its detached child', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-cancel-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let launchedIdentity = null;
  const outcome = restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
    afterProcessSpawn(identity) {
      launchedIdentity = identity;
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at = new Date(nowMs + 1_001).toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    },
  });
  assert.equal(outcome, 'noop');
  assert.ok(launchedIdentity);
  assert.equal(inspectProcessLivenessIdentity(launchedIdentity), 'not-running');
  const cancelled = new StateManager().read(statePath);
  assert.equal(cancelled.last_exit_reason, 'cancelled');
  assert.equal(cancelled.history.some(({ step }) => step === 'autonomous_owner_restored'), false);
  assert.notEqual(cancelled.autonomous_supervisor_pid, launchedIdentity.pid);
});

test('process owner restoration rejects same-id contract corruption racing final publication', () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-publication-race-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  const spec = registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let launchedIdentity = null;
  const corruption = { ...spec, runner_sha256: '0'.repeat(64) };
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
      afterProcessSpawn(identity) {
        launchedIdentity = identity;
        new StateManager().update(statePath, (current) => {
          current.autonomous_owner_spec = corruption;
          return current;
        });
      },
    }),
    /Refusing to publish restored process ownership/,
  );
  assert.ok(launchedIdentity);
  assert.equal(inspectProcessLivenessIdentity(launchedIdentity), 'not-running');
  const failed = new StateManager().read(statePath);
  assert.deepEqual(failed.autonomous_owner_spec, corruption);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
  assert.equal(failed.history.some(({ step }) => step === 'autonomous_owner_restored'), false);
  assert.notEqual(failed.autonomous_supervisor_pid, launchedIdentity.pid);
});

test('process owner restoration kills a spawned supervisor when immutable identity capture fails', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-process-owner-capture-failure-');
  const runtimeDir = path.join(sessionDir, 'runtime');
  const statePath = path.join(sessionDir, 'state.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'mux-runner.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(runtimeDir, 'supervised-runner.js'), 'setInterval(() => {}, 1000);\n');
  writeJson(statePath, state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
  }));
  registerAutonomousOwnerSpec(
    sessionDir, 'mux-runner.js', [], undefined, path.join(runtimeDir, 'supervised-runner.js'),
  );
  new StateManager().update(statePath, (current) => {
    current.autonomous_supervisor_pid = 999_999_999;
    current.autonomous_supervisor_identity = null;
    return current;
  });
  const nowMs = 1_700_000_120_000;
  reconcileSessionLiveness(sessionDir, undefined, nowMs);
  let spawnedPid = null;
  assert.throws(
    () => restoreAutonomousBudgetOwner(sessionDir, undefined, nowMs + 1_000, {
      captureSpawnedIdentity(pid) {
        spawnedPid = pid;
        return null;
      },
    }),
    /without an exact spawned process identity/,
  );
  assert.ok(spawnedPid);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(spawnedPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      spawnedPid = null;
      break;
    }
  }
  assert.equal(spawnedPid, null, 'spawned supervisor must not survive failed identity capture');
  const failed = new StateManager().read(statePath);
  assert.equal(failed.autonomous_owner_restoration.status, 'failed');
  assert.equal(failed.recovery_required, true);
});

test('simultaneous elapsed repairs converge on one durable intent without loser errors', async () => {
  const sessionDir = makeTempRoot('pickle-liveness-concurrent-repair-');
  const nowMs = 1_700_000_120_000;
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    working_dir: sessionDir,
    max_time_minutes: 1,
    autonomous_supervisor_identity: captureProcessLivenessIdentity(process.pid),
  }));
  registerProcessOwner(sessionDir);

  const observed = await Promise.all(Array.from({ length: 12 }, () => (
    runLivenessProcess(sessionDir, nowMs)
  )));
  assert.equal(new Set(observed).size, 1);
  assert.ok(observed[0]);
  const persisted = new StateManager().read(path.join(sessionDir, 'state.json'));
  assert.equal(persisted.autonomous_budget_rollover_intent_id, observed[0]);
  assert.equal(persisted.autonomous_budget_epoch, 1);
  assert.equal(persisted.history.filter(({ step }) => step === 'autonomous_budget_rollover').length, 1);
});

test('reconcileSessionLiveness blocks and preserves discoverability for a live orphan child', () => {
  const sessionDir = makeTempRoot('pickle-liveness-orphan-');
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: process.pid,
    active_child_kind: 'codex',
  }));
  const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
  assert.equal(result.stale, false);
  assert.equal(result.state.active, false);
  assert.equal(result.state.step, 'blocked');
  assert.equal(result.state.last_exit_reason, 'runner_lost_orphaned_child');
  assert.equal(result.state.recovery_required, true);
  assert.equal(result.state.active_child_pid, process.pid);
  assert.equal(result.state.orphan_child_pid, process.pid);
});

test('reconcileSessionLiveness reaps an identity-matched lifecycle child using a nested candidate add-dir', () => {
  const sessionDir = makeTempRoot('pickle-liveness-identity-orphan-');
  const candidateDir = path.join(sessionDir, 'worker-lifecycle-candidates', 'ticket-implement');
  fs.mkdirSync(candidateDir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--add-dir', candidateDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const identity = captureSpawnedProcessIdentity(Number(child.pid));
  assert.ok(identity);
  writeJson(path.join(sessionDir, 'state.json'), state({
    session_dir: sessionDir,
    tmux_mode: true,
    tmux_runner_pid: 999_999_999,
    active_child_pid: child.pid,
    active_child_kind: 'codex',
    active_child_identity: identity,
  }));
  try {
    const result = reconcileSessionLiveness(sessionDir, undefined, 1_700_000_100_000);
    assert.equal(result.stale, true);
    assert.equal(result.state.active, false);
    assert.equal(result.state.last_exit_reason, 'runner_lost');
    assert.equal(result.state.recovery_required, false);
    assert.equal(result.state.orphan_child_pid, null);
  } finally {
    try { process.kill(-Number(child.pid), 'SIGKILL'); } catch {}
  }
});
