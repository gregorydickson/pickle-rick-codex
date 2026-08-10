// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, prependPath, projectRoot, writeExecutable, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_FILE,
  adoptActiveLegacyMuxSession,
  legacyAdoptionLaunchTimeoutMs,
  legacyContractRepairPending,
  launchAdoptedLegacySession,
  markLegacyContractRepairComplete,
} from '../services/legacy-session-adoption.js';
import { acquireSupervisorLease, beginAutonomousExecution, createLogicalPipeline, readLogicalPipeline } from '../services/durable-supervisor.js';
import { readPrdSeal, writePrdSeal } from '../services/prd-seal.js';
import { ensureSessionPrdSeal } from '../services/session-prd-seal.js';
import {
  beginRefinementRepositoryAdvance,
  reconcileArchivedCandidateRefinementBoundary,
  refinementRepositoryIdentity,
  validateRefinementAcceptance,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { ensureBootstrapSessionReady, pendingAdoptedVerificationRepairTicket } from '../services/pipeline-bootstrap.js';
import { checkReadiness } from '../services/readiness.js';
import { readVerificationBaselines } from '../services/pipeline-state.js';
import { assertTicketVerificationBoundToSeal } from '../services/verification-seal-contract.js';
import { readManifest, updateTicketStatus } from '../services/tickets.js';
import { restoreRejectedCandidateCheckpoint } from '../services/candidate-recovery.js';
import { chooseLegacyLaunchRuntime } from '../bin/adopt-legacy-session.js';
import { runSequential } from '../bin/mux-runner.js';
import { adoptionSupervisorProvenanceReady } from '../bin/supervised-runner.js';
import { describeInstalledRuntime, runtimeBuildHash } from '../services/runtime-descriptor.js';
import { getWorkingTreeContentFingerprint, listUntrackedFiles } from '../services/git-utils.js';
import { prepareLiveSessionMigration } from '../services/live-session-migration.js';
import { persistCitadelReleaseApproval } from '../services/citadel.js';
import { acquireLaunchLock } from '../services/detached-launch.js';
import { readAdoptionWatchDomainEvidence } from '../services/adoption-watch-strategies.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { legacyAdoptionOutcome } from '../services/legacy-adoption-executor-supervisor.js';
import { validCommittedLegacyAdoptionTransfer } from '../services/legacy-adoption-transfer-proof.js';
import { StateManager } from '../services/state-manager.js';
import {
  authenticatedReadyProcessOwner,
  deriveAutonomousProcessOwnerSpec,
} from '../services/autonomous-owner-recovery.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function approveTargetRuntime(targetRoot) {
  if (!fs.existsSync(path.join(targetRoot, '.git'))) git(targetRoot, ['init']);
  git(targetRoot, ['config', 'user.name', 'Runtime Approval']);
  git(targetRoot, ['config', 'user.email', 'runtime-approval@example.test']);
  git(targetRoot, ['add', '-A']);
  if (git(targetRoot, ['status', '--porcelain'])) git(targetRoot, ['commit', '-m', 'approved runtime']);
  const head = git(targetRoot, ['rev-parse', 'HEAD']);
  const sessionDir = makeTempRoot('runtime-validation-session-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: false, working_dir: targetRoot, start_commit: head,
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{ id: 'validation', acceptance_criteria: ['Approved runtime passes its release gate.'] }],
  });
  persistCitadelReleaseApproval(sessionDir, {
    schema_version: 1, verdict: 'approve', reviewed_range: `${head}..HEAD`,
    acceptance_criteria_checked: ['Approved runtime passes its release gate.'], findings: [], generated_at: '2026-08-08T20:00:00.000Z',
  });
  return sessionDir;
}

function runtime(label) {
  const root = makeTempRoot(`pickle-runtime-${label}-`);
  for (const relative of ['bin', 'lib', 'skills', 'extension/bin', 'extension/services', 'extension/types']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    fs.writeFileSync(path.join(root, relative, 'runtime.js'), `// ${label}:${relative}\n`);
  }
  fs.writeFileSync(path.join(root, 'extension', 'bin', 'mux-runner.js'), `// ${label}:mux\n`);
  fs.writeFileSync(path.join(root, 'extension', 'bin', 'supervised-runner.js'),
    `// ${label}:supervisor\nsetInterval(() => {}, 1000);\n`);
  fs.writeFileSync(path.join(root, 'install.sh'), `#!/bin/sh\n# ${label}\n`);
  writeJson(path.join(root, 'package.json'), { name: 'pickle-rick-codex', version: '0.2.17-beta.3' });
  writeJson(path.join(root, 'extension', 'package.json'), { name: 'pickle-rick-codex-extension', version: '0.2.17-beta.3' });
  writeJson(path.join(root, 'extension', 'state-schema.json'), { schema_version: 1 });
  return root;
}

function identity(pid) {
  return { pid, pgid: pid, start_time: `start-${pid}`, fingerprint: `fingerprint-${pid}` };
}

function modernOwnershipEvidenceCases() {
  return [
    ['controller-pid', { active_child_controller_pid: 7001 }],
    ['controller-identity', { active_child_controller_identity: identity(7001) }],
    ['active-ledger', { active_child_identities: [identity(7002)] }],
    ['malformed-active-ledger', { active_child_identities: {} }],
    ['refinement-ledger', { refinement_child_identities: [identity(7003)] }],
    ['malformed-refinement-ledger', { refinement_child_identities: 'corrupt' }],
    ['supervisor-pid', { autonomous_supervisor_pid: 7004 }],
    ['malformed-supervisor-pid', { autonomous_supervisor_pid: '0' }],
    ['supervisor-identity', { autonomous_supervisor_identity: identity(7004) }],
    ['supervisor-ready-receipt', { autonomous_supervisor_ready_receipt: { receipt_id: 'modern-ready' } }],
    ['owner-spec', { autonomous_owner_spec: { spec_id: 'modern-owner' } }],
    ['owner-restoration', { autonomous_owner_restoration: { status: 'pending' } }],
    ['owner-handoff', { autonomous_owner_handoff_transaction: { status: 'prepared' } }],
    ['recovery-daemon-pid', { autonomous_owner_recovery_daemon_pid: 7005 }],
    ['recovery-daemon-identity', { autonomous_owner_recovery_daemon_identity: identity(7005) }],
    ['watchdog-pid', { cancellation_recovery_watchdog_pid: 7006 }],
    ['watchdog-identity', { cancellation_recovery_watchdog_identity: identity(7006) }],
    ['watchdog-arm-id', { cancellation_recovery_watchdog_arm_id: 'arm-1' }],
    ['watchdog-arm', { cancellation_recovery_watchdog_arm: { arm_id: 'arm-1' } }],
    ['recovery-runtime-binding', { cancellation_recovery_runtime_binding: { runtime_root: '/runtime' } }],
    ['cancellation-recovery', { cancellation_recovery: { status: 'pending' } }],
    ['recovery-required', { recovery_required: true }],
    ['malformed-recovery-required', { recovery_required: 'false' }],
    ['recovery-kind', { recovery_kind: 'cancellation_ownership' }],
    ['recovery-reason', { recovery_reason: 'pending ownership recovery' }],
    ['orphan-recovery', { orphan_recovery: { status: 'ambiguous' } }],
    ['orphan-child', { orphan_child_pid: 7007 }],
    ['malformed-zero-orphan-child', { orphan_child_pid: '0' }],
    ['recovery-suspended', { autonomous_owner_recovery_suspended: true }],
    ['malformed-recovery-suspended', { autonomous_owner_recovery_suspended: 'false' }],
    ['handoff-suspended', { autonomous_owner_recovery_suspended_for_handoff: 'handoff-1' }],
    ['cancel-requested', { cancel_requested_at: '2026-08-10T00:00:00.000Z' }],
    ['cancelled-flag', { cancelled: true }],
    ['cancelled-exit', { last_exit_reason: 'cancelled' }],
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
    ['legacy-adoption-challenge', { legacy_adoption_supervisor_challenge: 'challenge-1' }],
  ];
}

function byteSnapshot(paths) {
  return paths.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
}

function fixture(options = {}) {
  const repo = makeTempRoot('pickle-legacy-repo-');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Legacy Adoption']);
  git(repo, ['config', 'user.email', 'legacy@example.test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  const sessionDir = path.join(makeTempRoot('pickle-legacy-data-'), 'sessions', '2026-08-08-legacy');
  fs.mkdirSync(sessionDir, { recursive: true });
  // Mirrors the installed inventory's tmux pane shell -> mux runner layout.
  const runner = identity(options.runnerPid ?? 51980);
  const supervisor = identity(51970);
  const pane = identity(51956);
  const child = identity(4300);
  const tmuxName = `pickle-${path.basename(sessionDir)}`;
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: repo, current_ticket: 'r1', step: 'implement', history: [{ step: 'implement' }],
    tmux_runner_pid: runner.pid, tmux_session_name: tmuxName, worker_pid: runner.pid,
    active_child_pid: child.pid, active_child_identity: child,
  });
  writeJson(path.join(sessionDir, '.session-operation.lock'), { pid: runner.pid, ts: 1 });
  writeJson(path.join(path.dirname(path.dirname(sessionDir)), 'current_sessions.json'), { [fs.realpathSync(repo)]: fs.realpathSync(sessionDir) });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{ id: 'r1', status: 'In Progress', acceptance_criteria: ['Adopt safely.'], allowed_paths: ['tracked.txt'], verification: ['node -e "const x = `legacy`"'] }],
  });
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Legacy PRD\n');
  const lifecycle = path.join(sessionDir, 'worker-lifecycle', 'r1');
  fs.mkdirSync(lifecycle, { recursive: true });
  for (const phase of ['research', 'research_review', 'plan', 'plan_review']) {
    writeJson(path.join(lifecycle, `${phase}.json`), {
      schema_version: 1, phase, ticket_id: 'r1', summary: phase,
      ...(phase.endsWith('review') ? { verdict: 'approved', evidence: ['approved'] } : {}),
    });
  }
  fs.mkdirSync(path.join(sessionDir, 'worker-lifecycle-refusals', 'r1'), { recursive: true });
  writeJson(path.join(sessionDir, 'worker-lifecycle-refusals', 'r1', '0001-review.json'), { verdict: 'changes_requested' });
  writeJson(path.join(sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [{ sequence: 1 }] });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', `refs/pickle/salvage/${path.basename(sessionDir)}`, sha]);
  return { repo, sessionDir, runner, supervisor, pane, child, tmuxName, sourceRoot: runtime('source'), targetRoot: runtime('target') };
}

function seal(sessionDir) {
  createLogicalPipeline(sessionDir, path.basename(sessionDir));
  writePrdSeal(sessionDir, {
    prd: '# Legacy PRD\n', repository: { identity: 'repo@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'r1-AC-1', text: 'Adopt safely.' }], scope_and_ownership: {},
    dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [], preservation_and_rollback: {},
    completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function installLegacyRefinementAcceptance(value) {
  const refined = '# Legacy refined PRD\n\n## AC-1: Adopt safely\n';
  fs.writeFileSync(path.join(value.sessionDir, 'prd_refined.md'), refined);
  const statePath = path.join(value.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.start_commit = git(value.repo, ['rev-parse', 'HEAD']);
  writeJson(statePath, state);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'refinement_manifest.json'), 'utf8'));
  manifest.tickets = manifest.tickets.map((ticket, index) => ({
    title: `Legacy ticket ${index + 1}`,
    description: 'Repair the adopted legacy verification contract.',
    priority: 'P0',
    ...ticket,
  }));
  writeJson(path.join(value.sessionDir, 'refinement_manifest.json'), manifest);
  const contractFields = new Set([
    'id', 'title', 'description', 'complexity_tier', 'verification', 'verification_env', 'depends_on',
    'acceptance_criteria', 'priority', 'phase', 'output_artifacts', 'proof_corpus', 'allowed_paths',
    'freeze_contract', 'contract_decision', 'formatter', 'formatter_ticket',
  ]);
  const tickets = manifest.tickets.map((ticket) => Object.fromEntries(
    Object.entries(ticket).filter(([field]) => contractFields.has(field)),
  ));
  writeJson(path.join(value.sessionDir, 'refinement-acceptance.json'), {
    schema_version: 3,
    prompt_contract_version: 3,
    prd_sha256: sha256(fs.readFileSync(path.join(value.sessionDir, 'prd.md'))),
    refined_prd_sha256: sha256(refined),
    manifest_sha256: sha256(JSON.stringify(stableValue({ source: null, tickets }))),
    repository_identity: refinementRepositoryIdentity(value.repo, value.sessionDir),
    accepted_at: '2026-08-08T19:00:00.000Z',
  });
}

function depsFor(value, actions = []) {
  let tmuxLive = true;
  const canonicalSession = fs.realpathSync(value.sessionDir);
  const observations = new Map([
    [value.runner.pid, { identity: value.runner, parent_pid: value.supervisor.pid, command: `node ${path.join(fs.realpathSync(value.sourceRoot), 'extension', 'bin', 'mux-runner.js')} ${canonicalSession}` }],
    [value.supervisor.pid, { identity: value.supervisor, parent_pid: value.pane.pid, command: `node ${path.join(fs.realpathSync(value.sourceRoot), 'extension', 'bin', 'supervised-runner.js')} ${canonicalSession} --runner-bin=mux-runner.js --on-failure=retry` }],
    [value.pane.pid, { identity: value.pane, parent_pid: 1, command: `bash -lc node /runtime/bin/mux-runner.js ${canonicalSession}` }],
  ]);
  return {
    observeProcess: (pid) => observations.get(pid) || null,
    inspectProcess: () => (tmuxLive ? 'matched' : 'not-running'),
    inspectChild: () => 'matched',
    reapChild: () => {
      actions.push('child');
      return { status: 'reaped', pid: value.child.pid, pgid: value.child.pgid, reason: 'test', signals: ['SIGTERM'] };
    },
    tmuxExists: () => tmuxLive,
    tmuxPanePid: () => value.pane.pid,
    tmuxBinding: () => tmuxLive ? {
      session_name: value.tmuxName, session_id: '$7', session_created: '1723147200', pane_id: '%11',
      pane_pid: value.pane.pid, pane_start_command: 'bash',
    } : null,
    stopController: () => { actions.push('fence'); },
    resumeController: () => { actions.push('resume'); },
    startWatchdog: () => { actions.push('watchdog'); },
    killTmux: (sessionId) => { actions.push(`tmux:${sessionId}`); tmuxLive = false; },
    waitForRunnerExit: () => true,
    sealSession: seal,
    now: () => new Date('2026-08-08T20:00:00.000Z'),
  };
}

function writeRestoredRecoverySupervisor(statePath, owner, ready = true) {
  new StateManager().update(statePath, (state) => {
    const spec = state.autonomous_owner_spec;
    state.autonomous_supervisor_pid = owner.pid;
    state.autonomous_supervisor_identity = owner;
    state.autonomous_owner_restoration = {
      schema_version: 1, intent_id: 'accepted-test-restoration',
      rollover_intent_id: state.autonomous_budget_rollover_intent_id,
      rollover_epoch: Math.max(1, Number(state.autonomous_budget_epoch || 1)),
      owner_spec_id: spec.spec_id, status: 'restored', attempt: 1,
      not_before: '2026-08-08T20:00:00.000Z', restorer_pid: null, restorer_identity: null,
    };
    if (ready) {
      const unsignedReceipt = {
        schema_version: 1, owner_spec_id: spec.spec_id, supervisor_identity: owner,
        node_path: spec.node_path, supervisor_path: spec.supervisor_path, working_dir: spec.working_dir,
        session_dir: spec.session_dir, runner_bin: spec.runner_bin, runner_args: [...spec.runner_args],
        recovery_daemon_identity: state.legacy_adoption_supervisor_challenge
          ? state.autonomous_owner_recovery_daemon_identity || null : null,
        adoption_challenge: state.legacy_adoption_supervisor_challenge || null,
        ready_at: '2026-08-08T20:00:00.000Z',
      };
      state.autonomous_supervisor_ready_receipt = {
        ...unsignedReceipt, receipt_id: sha256(JSON.stringify(unsignedReceipt)),
      };
    }
    return state;
  });
  return owner;
}

function publishTestRecoveryDaemon(statePath) {
  const daemon = captureProcessLivenessIdentity(process.pid);
  assert.ok(daemon);
  new StateManager().update(statePath, (state) => {
    state.autonomous_owner_recovery_daemon_pid = daemon.pid;
    state.autonomous_owner_recovery_daemon_identity = daemon;
    return state;
  });
  return daemon;
}

function publishAcceptedRecoverySupervisor(statePath, t) {
  const daemon = publishTestRecoveryDaemon(statePath);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const spec = state.autonomous_owner_spec;
  const child = spawn(spec.node_path, [
    spec.supervisor_path, spec.session_dir, `--runner-bin=${spec.runner_bin}`, ...spec.runner_args,
  ], { cwd: spec.working_dir, detached: true, stdio: 'ignore' });
  child.unref();
  const owner = child.pid ? captureProcessLivenessIdentity(child.pid) : null;
  assert.ok(owner);
  t.after(() => {
    try { process.kill(-owner.pid, 'SIGKILL'); } catch {
      try { process.kill(owner.pid, 'SIGKILL'); } catch {}
    }
  });
  writeRestoredRecoverySupervisor(statePath, owner);
  return daemon;
}

function exactLaunchDeps(value, onLaunch = () => undefined, base = {}) {
  const runner = identity(62001);
  let launchedRoot = value.targetRoot;
  return {
    ...depsFor(value),
    ...base,
    observeProcess: (pid) => pid === runner.pid
      ? { identity: runner, parent_pid: value.pane.pid,
        command: `node ${path.join(fs.realpathSync(launchedRoot), 'extension', 'bin', 'mux-runner.js')} ${fs.realpathSync(value.sessionDir)}` }
      : pid === value.pane.pid ? { identity: value.pane, parent_pid: 1, command: 'bash' } : null,
    inspectProcess: () => 'matched',
    tmuxExists: () => true,
    tmuxBinding: () => ({
      session_name: value.tmuxName, session_id: '$launch', session_created: '1723147300', pane_id: '%launch',
      pane_pid: value.pane.pid, pane_start_command: 'bash',
    }),
    launch: (sessionDir, runtimeRoot) => {
      launchedRoot = runtimeRoot;
      onLaunch(sessionDir, runtimeRoot);
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeJson(statePath, { ...state, active: true, tmux_runner_pid: runner.pid, worker_pid: runner.pid,
        tmux_session_name: value.tmuxName });
      acquireSupervisorLease(sessionDir, { ownerId: 'target-runner', ttlMs: 60_000, ownerIdentity: runner });
    },
  };
}

test('legacy mux adoption preserves durable evidence, journals explicit adoption, and launches one supervised mux', () => {
  const value = fixture();
  const actions = [];
  const refusal = fs.readFileSync(path.join(value.sessionDir, 'worker-lifecycle-refusals', 'r1', '0001-review.json'), 'utf8');
  const recovery = fs.readFileSync(path.join(value.sessionDir, 'ticket-recovery-history.json'), 'utf8');
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value, actions));

  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'tmux:$7']);
  assert.equal(record.status, 'adopted');
  assert.equal(record.resume_checkpoint.phase, 'verification_contract_repair');
  assert.deepEqual(record.resume_checkpoint.reuse_phases, ['research', 'research_review', 'plan', 'plan_review']);
  assert.equal(fs.readFileSync(path.join(value.sessionDir, 'worker-lifecycle-refusals', 'r1', '0001-review.json'), 'utf8'), refusal);
  assert.equal(fs.readFileSync(path.join(value.sessionDir, 'ticket-recovery-history.json'), 'utf8'), recovery);
  assert.equal(fs.existsSync(path.join(value.sessionDir, '.session-operation.lock')), false);
  const logical = readLogicalPipeline(value.sessionDir);
  assert.equal(logical.lease, null);
  assert.deepEqual(logical.events.map((event) => event.kind), ['pipeline_created', 'prd_sealed', 'legacy_session_adopted']);
  assert.equal(logical.events[2].details.migration_content_hash, record.migration_content_hash);
  assert.equal(readAdoptionWatchDomainEvidence(
    value.sessionDir, value.sourceRoot, value.targetRoot,
  ).authenticated, true, 'authenticated post-seal PRD and journal are legitimate migration inventory additions');
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), true);
  markLegacyContractRepairComplete(value.sessionDir);
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), false);

  let launches = 0;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot,
    exactLaunchDeps(value, () => { launches += 1; }, { now: () => new Date('2026-08-08T20:01:00.000Z') }));
  assert.equal(launched.status, 'launched');
  assert.equal(launched.launched_runtime_root, fs.realpathSync(value.targetRoot));
  assert.equal(launches, 1);
  launchAdoptedLegacySession(value.sessionDir, value.targetRoot, { launch: () => { launches += 1; } });
  assert.equal(launches, 1);
});

test('legacy adoption retires the authenticated old lock even when its pid was reused by a live process', () => {
  const value = fixture({ runnerPid: process.pid });
  const record = adoptActiveLegacyMuxSession(
    value.sessionDir,
    value.sourceRoot,
    value.targetRoot,
    depsFor(value),
  );

  assert.equal(record.status, 'adopted');
  assert.equal(fs.existsSync(path.join(value.sessionDir, '.session-operation.lock')), false);
});

test('legacy adoption never retires a replaced operation lock with the recorded pid', () => {
  const value = fixture({ runnerPid: process.pid });
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');

  assert.throws(() => adoptActiveLegacyMuxSession(
    value.sessionDir,
    value.sourceRoot,
    value.targetRoot,
    {
      ...depsFor(value),
      checkpoint: (stage) => {
        if (stage === 'candidate_archived') {
          writeJson(path.join(value.sessionDir, '.session-operation.lock'), { pid: value.runner.pid, ts: 2 });
        }
      },
    },
  ), /refuses ownership transfer across a replaced session-operation lock/);

  assert.equal(JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, '.session-operation.lock'), 'utf8',
  )).ts, 2);
  assert.equal(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).stage, 'quiesced');
});

test('failed adopted launch restores exact state bytes and dead launch reservations before retry', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const statePath = path.join(value.sessionDir, 'state.json');
  const before = fs.readFileSync(statePath);
  const cwdDigest = sha256(String(JSON.parse(before.toString('utf8')).working_dir)).slice(0, 16);
  const launchLock = path.join(value.sessionDir, '.tmux-launch.lock');
  const cwdLock = path.join(path.dirname(value.sessionDir), `.tmux-cwd-${cwdDigest}.lock`);
  const deps = depsFor(value);
  let contenderBlocked = false;
  deps.afterLaunchReservationsAcquired = () => {
    assert.throws(() => acquireLaunchLock(value.sessionDir), /tmux launch is already in progress/);
    contenderBlocked = true;
  };
  deps.launch = () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    writeJson(statePath, { ...state, active: false });
    fs.writeFileSync(launchLock, '2147483647');
    fs.writeFileSync(cwdLock, '2147483647');
    throw new Error('simulated readiness timeout');
  };
  assert.throws(
    () => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, deps),
    /simulated readiness timeout/,
  );
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(contenderBlocked, true);
  assert.equal(fs.existsSync(launchLock), false);
  assert.equal(fs.existsSync(cwdLock), false);
  const transaction = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8'));
  assert.equal(transaction.stage, 'adopted');
  assert.equal(transaction.launch_attempt, undefined);

  let retries = 0;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot,
    exactLaunchDeps(value, () => { retries += 1; }));
  assert.equal(launched.status, 'launched');
  assert.equal(retries, 1);
});

test('rollback rejects a self-consistent snapshot that is not bound to the sealed migration', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, {
    ...depsFor(value),
    checkpoint: (stage) => {
      if (stage !== 'launching') return;
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      const tampered = Buffer.from('{"schema_version":1,"active":true}\n');
      transaction.launch_attempt.state_base64 = tampered.toString('base64');
      transaction.launch_attempt.state_size = tampered.length;
      transaction.launch_attempt.state_sha256 = sha256(tampered);
      writeJson(transactionPath, transaction);
      throw new Error('tampered launch checkpoint');
    },
  }), /tampered launch checkpoint/);
  assert.throws(
    () => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, depsFor(value)),
    /does not match the sealed migration state/,
  );
});

test('expired dead launch lease restores the sealed journal and permits retry', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const logicalPath = path.join(value.sessionDir, 'logical-pipeline.json');
  const exactLogical = fs.readFileSync(logicalPath);
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, {
    ...depsFor(value),
    launch: () => {
      acquireSupervisorLease(value.sessionDir, {
        ownerId: 'expired-launch-owner', ttlMs: 1_000, nowMs: Date.now() - 60_000,
        ownerIdentity: identity(64001),
      });
      throw new Error('owner expired before acknowledgement');
    },
  }), /owner expired before acknowledgement/);
  assert.deepEqual(fs.readFileSync(logicalPath), exactLogical);
  assert.equal(readLogicalPipeline(value.sessionDir).lease, null);
  assert.equal(launchAdoptedLegacySession(value.sessionDir, value.targetRoot, exactLaunchDeps(value)).status, 'launched');
});

test('snapshot-less legacy attempt with drifted lease journal remains launching without state mutation', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, {
    ...depsFor(value),
    checkpoint: (stage) => { if (stage === 'launching') throw new Error('simulated launcher crash'); },
  }), /simulated launcher crash/);
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  delete transaction.launch_attempt.logical_pipeline_size;
  delete transaction.launch_attempt.logical_pipeline_sha256;
  delete transaction.launch_attempt.logical_pipeline_base64;
  writeJson(transactionPath, transaction);
  acquireSupervisorLease(value.sessionDir, {
    ownerId: 'expired-legacy-owner', ttlMs: 1_000, nowMs: Date.now() - 60_000,
    ownerIdentity: identity(64003),
  });
  const statePath = path.join(value.sessionDir, 'state.json');
  const stateBeforeRetry = fs.readFileSync(statePath);
  assert.throws(
    () => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, depsFor(value)),
    /Snapshot-less legacy launch recovery cannot prove the sealed logical pipeline bytes/,
  );
  assert.deepEqual(fs.readFileSync(statePath), stateBeforeRetry);
  assert.equal(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).stage, 'launching');
});

test('exact dead partial tmux binding is removed by immutable id before rollback and retry', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const statePath = path.join(value.sessionDir, 'state.json');
  const binding = {
    schema_version: 1, session_name: value.tmuxName, session_id: '$91', session_created: '1723147391',
    pane_id: '%92', pane_pid: 64002,
    pane_start_command: `node /runtime/mux-runner.js ${fs.realpathSync(value.sessionDir)}`,
  };
  let tmuxLive = true;
  const killed = [];
  const deps = {
    ...depsFor(value),
    observeProcess: () => null,
    tmuxExists: () => tmuxLive,
    tmuxBinding: () => tmuxLive ? binding : null,
    killTmux: (sessionId) => { killed.push(sessionId); tmuxLive = false; },
    launch: () => {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeJson(statePath, { ...state, active: false, tmux_session_name: value.tmuxName,
        tmux_runner_binding: binding });
      throw new Error('runner died after creating tmux');
    },
  };
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, deps), /runner died/);
  assert.deepEqual(killed, ['$91']);
  assert.equal(launchAdoptedLegacySession(value.sessionDir, value.targetRoot, exactLaunchDeps(value)).status, 'launched');
});

test('persisted legacy launching stage reconstructs only the proven active prewrite and retries', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const statePath = path.join(value.sessionDir, 'state.json');
  const exactPrelaunch = fs.readFileSync(statePath);
  const state = JSON.parse(exactPrelaunch.toString('utf8'));
  writeJson(statePath, { ...state, active: false });
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  writeJson(transactionPath, { ...transaction, stage: 'launching', updated_at: '2026-08-08T20:00:01.000Z' });
  fs.writeFileSync(path.join(value.sessionDir, '.tmux-launch.lock'), '2147483647');

  let launches = 0;
  let recoveredBytes = null;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot,
    exactLaunchDeps(value, () => { launches += 1; recoveredBytes = fs.readFileSync(statePath); }));
  assert.equal(launched.status, 'launched');
  assert.equal(launches, 1);
  assert.deepEqual(recoveredBytes, exactPrelaunch);
});

test('launch rollback refuses a live reservation owner', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const statePath = path.join(value.sessionDir, 'state.json');
  const livePid = process.pid;
  const deps = depsFor(value);
  deps.launch = () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    writeJson(statePath, { ...state, active: false });
    fs.writeFileSync(path.join(value.sessionDir, '.tmux-launch.lock'), String(livePid));
    throw new Error('launch failed while child survived');
  };
  assert.throws(
    () => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, deps),
    /tmux launch is already in progress/,
  );
  const transaction = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8'));
  assert.equal(transaction.stage, 'launching');
});

test('launch rollback refuses lease-first and tmux-first partial owners without a state pid', () => {
  const leased = fixture();
  adoptActiveLegacyMuxSession(leased.sessionDir, leased.sourceRoot, leased.targetRoot, depsFor(leased));
  assert.throws(() => launchAdoptedLegacySession(leased.sessionDir, leased.targetRoot, {
    ...depsFor(leased),
    launch: () => {
      acquireSupervisorLease(leased.sessionDir, { ownerId: 'partial-runner', ttlMs: 60_000,
        ownerIdentity: identity(63001) });
      throw new Error('lease became visible before pid');
    },
  }), /unmatched live logical lease/);

  const tmux = fixture();
  adoptActiveLegacyMuxSession(tmux.sessionDir, tmux.sourceRoot, tmux.targetRoot, depsFor(tmux));
  assert.throws(() => launchAdoptedLegacySession(tmux.sessionDir, tmux.targetRoot, {
    ...depsFor(tmux),
    launch: () => {
      const statePath = path.join(tmux.sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeJson(statePath, { ...state, active: false, tmux_session_name: tmux.tmuxName,
        tmux_runner_binding: { session_name: tmux.tmuxName } });
      throw new Error('tmux became visible before pid');
    },
  }), /unmatched live tmux owner|unmatched live persisted tmux binding/);
});

test('launch exception reconciles an exact target runner instead of rolling it back', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const targetPid = 81234;
  const statePath = path.join(value.sessionDir, 'state.json');
  const command = `node ${path.join(fs.realpathSync(value.targetRoot), 'extension', 'bin', 'mux-runner.js')} ${fs.realpathSync(value.sessionDir)}`;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot, {
    ...depsFor(value),
    observeProcess: (pid) => pid === targetPid
      ? { identity: identity(pid), parent_pid: value.pane.pid, command }
      : pid === value.pane.pid
        ? { identity: value.pane, parent_pid: 1, command: 'bash' }
      : null,
    launch: () => {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeJson(statePath, { ...state, active: false, tmux_runner_pid: targetPid, worker_pid: targetPid,
        tmux_session_name: value.tmuxName });
      acquireSupervisorLease(value.sessionDir, { ownerId: 'target-runner', ttlMs: 60_000,
        ownerIdentity: identity(targetPid) });
      throw new Error('launcher lost acknowledgement');
    },
  });
  assert.equal(launched.status, 'launched');
  assert.equal(launched.launched_runtime_root, fs.realpathSync(value.targetRoot));
});

test('adoption launch timeout scales beyond readiness and runner startup work', () => {
  const value = fixture();
  writeJson(path.join(value.sessionDir, 'refinement_manifest.json'), {
    tickets: Array.from({ length: 14 }, (_, index) => ({ id: `r${index + 1}` })),
  });
  assert.equal(legacyAdoptionLaunchTimeoutMs(value.sessionDir, { PICKLE_ADOPTION_LAUNCH_TIMEOUT_MS: '30000' }), 6_840_000);
  assert.equal(legacyAdoptionLaunchTimeoutMs(value.sessionDir, { PICKLE_ADOPTION_LAUNCH_TIMEOUT_MS: '7200000' }), 7_200_000);
});

test('successful launch process exit without an exact owner rolls back and remains retryable', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const before = fs.readFileSync(path.join(value.sessionDir, 'state.json'));
  assert.throws(
    () => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, { ...depsFor(value), launch: () => undefined }),
    /without establishing an exact target owner/,
  );
  assert.deepEqual(fs.readFileSync(path.join(value.sessionDir, 'state.json')), before);
  const transaction = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8'));
  assert.equal(transaction.stage, 'adopted');
});

test('default sealing preserves malformed verification only after the legacy owner is durably fenced', () => {
  const value = fixture();
  installLegacyRefinementAcceptance(value);
  assert.throws(
    () => ensureSessionPrdSeal(value.sessionDir),
    /verification-contract-failed/,
  );
  const deps = depsFor(value);
  delete deps.sealSession;
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.equal(record.status, 'adopted');
  const sealRecord = readPrdSeal(value.sessionDir);
  assert.deepEqual(sealRecord.release_gates.ticket_verification, [{
    ticket_id: 'r1',
    acceptance_criteria: ['Adopt safely.'],
    verification: ['node -e "const x = `legacy`"'],
  }]);
});

test('resume-ready-only reaches the exact sealed adopted verification repair ticket', async () => {
  const value = fixture();
  installLegacyRefinementAcceptance(value);
  const deps = depsFor(value);
  delete deps.sealSession;
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  const manifestBefore = fs.readFileSync(path.join(value.sessionDir, 'refinement_manifest.json'), 'utf8');

  const ready = await ensureBootstrapSessionReady(value.sessionDir, { resumeReadyOnly: true });

  assert.equal(ready.summary.runnable[0].id, 'r1');
  assert.equal(fs.readFileSync(path.join(value.sessionDir, 'refinement_manifest.json'), 'utf8'), manifestBefore);
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), true);

  markLegacyContractRepairComplete(value.sessionDir);
  await assert.rejects(
    () => ensureBootstrapSessionReady(value.sessionDir, { resumeReadyOnly: true }),
    /unsafe legacy verification command contains backticks/,
  );
});

test('resume-ready-only keeps every non-adopted-ticket verification fail closed', async () => {
  const value = fixture();
  const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets.push({
    id: 'r2',
    title: 'Unrelated malformed ticket',
    description: 'This verifier is not authorized by the adoption checkpoint.',
    status: 'Todo',
    priority: 'P1',
    acceptance_criteria: ['Remain fail closed.'],
    allowed_paths: ['tracked.txt'],
    verification: ['node -e "const y = `unrelated`"'],
  });
  writeJson(manifestPath, manifest);
  installLegacyRefinementAcceptance(value);
  const deps = depsFor(value);
  delete deps.sealSession;
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);

  await assert.rejects(
    () => ensureBootstrapSessionReady(value.sessionDir, { resumeReadyOnly: true }),
    /unsafe legacy verification command contains backticks/,
  );
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), true);
});

test('adopted malformed verifier is ready, repaired once, baselined, dispatched once, and restart-safe', async () => {
  const value = fixture();
  const dataRoot = path.dirname(path.dirname(value.sessionDir));
  const qualityCommand = 'node -e "process.exit(0)"';
  const legacyCommand = 'runtime_root="$(mktemp -d)"; trap \'rm -rf "$runtime_root"\' EXIT; CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" bash install.sh && CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" npm run test:installed';
  fs.writeFileSync(path.join(value.repo, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(value.repo, 'package.json'), JSON.stringify({
    scripts: { 'test:installed': qualityCommand },
  }, null, 2));
  git(value.repo, ['add', 'install.sh', 'package.json']);
  git(value.repo, ['commit', '-m', 'add verifier prerequisites']);
  const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].verification = [{ command: legacyCommand }];
  writeJson(manifestPath, manifest);
  installLegacyRefinementAcceptance(value);
  writeRefinementAcceptance(value.sessionDir, {
    workingDir: value.repo,
    preserveMalformedVerification: true,
  });
  writeJson(path.join(value.sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [] });
  for (const phase of ['research', 'plan']) {
    const artifactPath = path.join(value.sessionDir, 'worker-lifecycle', 'r1', `${phase}.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (phase === 'research') artifact.evidence = ['legacy evidence remains reusable'];
    else artifact.steps = ['repair the verification contract before implementation'];
    writeJson(artifactPath, artifact);
  }
  fs.mkdirSync(path.join(value.sessionDir, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), [
    '---', 'id: r1', 'title: Legacy ticket 1', 'status: In Progress', '---', '',
  ].join('\n'));
  const statePath = path.join(value.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.worker_timeout_seconds = 10;
  state.quality_baseline = {
    head_sha: git(value.repo, ['rev-parse', 'HEAD']),
    captured_at: '2026-08-08T19:30:00.000Z',
    commands: [{ command: qualityCommand, ok: true, exitCode: 0, signature: 'success', output: '' }],
    command_contract: { [qualityCommand]: qualityCommand },
  };
  writeJson(statePath, state);

  const adoptionDeps = depsFor(value);
  delete adoptionDeps.sealSession;
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, adoptionDeps);

  const fakeBin = makeTempRoot('legacy-adoption-repair-bin-');
  const repairLog = path.join(fakeBin, 'repairs.log');
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('codex fixture 1.0.0');
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const value = (prefix) => prompt.split('\\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
fs.appendFileSync(process.env.LEGACY_REPAIR_LOG, 'repair\\n');
fs.writeFileSync(value('Contract repair artifact path: '), JSON.stringify({
  schema_version: 1,
  ticket_id: value('Ticket ID: '),
  verification: JSON.parse(value('Authorized sealed verification steps JSON: ')),
  rationale: 'reconstruct the exact sealed legacy command as a structured shell step',
}));
console.log('<promise>CONTRACT_REPAIR_COMPLETE</promise>');
`);
  const environment = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    LEGACY_REPAIR_LOG: repairLog,
  });
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const readiness = checkReadiness(value.sessionDir, { runtimeRoot: projectRoot, env: environment });
    assert.equal(readiness.ready, true, JSON.stringify(readiness.findings));
    assert.ok(readiness.findings.some((finding) => finding.code === 'adoption-repair-ready'));

    await ensureBootstrapSessionReady(value.sessionDir, { resumeReadyOnly: true });

    let dispatches = 0;
    const runTicket = async (sessionDir, ticketId) => {
      dispatches += 1;
      assert.equal(legacyContractRepairPending(sessionDir, ticketId), false);
      assert.equal(validateRefinementAcceptance(sessionDir, { workingDir: value.repo, verifyRepository: true }).ok, true);
      assert.doesNotThrow(() => assertTicketVerificationBoundToSeal(sessionDir, ticketId, value.repo));
      const repaired = readManifest(sessionDir).tickets.find((ticket) => ticket.id === ticketId);
      assert.equal(repaired.verification[0].kind, 'shell');
      assert.ok(Object.keys(readVerificationBaselines(sessionDir).by_ticket.r1 || {}).length > 0);
      updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
      return { status: 'done', applied: false };
    };
    const options = {
      operationLeaseHeld: true,
      onFailure: 'abort',
      runnerMode: 'pickle',
    };
    assert.equal(
      await runSequential(value.sessionDir, options, { runTicket }),
      'success',
      fs.readFileSync(path.join(value.sessionDir, 'mux-runner.log'), 'utf8'),
    );
    assert.equal(fs.readFileSync(repairLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(dispatches, 1);

    assert.equal(await runSequential(value.sessionDir, options, { runTicket }), 'success');
    assert.equal(fs.readFileSync(repairLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(dispatches, 1);
  } finally {
    for (const [key, prior] of Object.entries(previous)) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
});

test('watchdog prefers the canonical deployed runtime and records its owner root', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const canonicalRoot = runtime('target');
  const selected = chooseLegacyLaunchRuntime(
    canonicalRoot,
    value.targetRoot,
    describeInstalledRuntime(value.targetRoot),
    { timeoutMs: 0 },
  );
  assert.deepEqual(selected, { runtimeRoot: canonicalRoot, fallback: false });
  let launchedRoot = null;
  const record = launchAdoptedLegacySession(value.sessionDir, selected.runtimeRoot,
    exactLaunchDeps(value, (_sessionDir, root) => { launchedRoot = root; }));
  assert.equal(launchedRoot, fs.realpathSync(canonicalRoot));
  assert.equal(record.launched_runtime_root, fs.realpathSync(canonicalRoot));
});

test('installer death launches bounded checkout fallback and rerun hands it to canonical runtime', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  let clock = 0;
  const selected = chooseLegacyLaunchRuntime(
    value.sourceRoot,
    value.targetRoot,
    describeInstalledRuntime(value.targetRoot),
    { timeoutMs: 100, intervalMs: 25, now: () => clock, wait: (milliseconds) => { clock += milliseconds; } },
  );
  assert.deepEqual(selected, { runtimeRoot: value.targetRoot, fallback: true });
  const fallback = launchAdoptedLegacySession(value.sessionDir, selected.runtimeRoot, exactLaunchDeps(value));
  assert.equal(fallback.launched_runtime_root, fs.realpathSync(value.targetRoot));

  const canonicalRoot = runtime('target');
  let handoff = null;
  const canonical = launchAdoptedLegacySession(value.sessionDir, canonicalRoot, {
    handoff: (sessionDir, sourceRoot, targetRoot) => { handoff = { sessionDir, sourceRoot, targetRoot }; },
  });
  assert.deepEqual(handoff, {
    sessionDir: fs.realpathSync(value.sessionDir),
    sourceRoot: fs.realpathSync(value.targetRoot),
    targetRoot: fs.realpathSync(canonicalRoot),
  });
  assert.equal(canonical.launched_runtime_root, fs.realpathSync(canonicalRoot));
});

test('installer waits through a watchdog launch boundary and makes canonical runtime the owner', () => {
  const value = fixture();
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  const canonicalRoot = runtime('target');
  const recordPath = path.join(value.sessionDir, LEGACY_ADOPTION_FILE);
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const lockPath = path.join(value.sessionDir, '.legacy-session-adoption.lock');
  const readyPath = path.join(value.sessionDir, '.watchdog-boundary-ready');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    setTimeout(() => {
      const record = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, 'utf8'));
      fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ ...record, status: 'launched', launched_runtime_root: ${JSON.stringify(fs.realpathSync(value.targetRoot))}, launched_at: new Date().toISOString() }, null, 2));
      const transaction = JSON.parse(fs.readFileSync(${JSON.stringify(transactionPath)}, 'utf8'));
      fs.writeFileSync(${JSON.stringify(transactionPath)}, JSON.stringify({ ...transaction, stage: 'launched', launched_runtime_root: ${JSON.stringify(fs.realpathSync(value.targetRoot))} }, null, 2));
      fs.rmSync(${JSON.stringify(lockPath)}, { force: true });
    }, 300);
    setTimeout(() => process.exit(0), 1000);
  `], { stdio: 'ignore' });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.equal(fs.existsSync(readyPath), true);
  let handoff = null;
  const result = launchAdoptedLegacySession(value.sessionDir, canonicalRoot, {
    handoff: (sessionDir, sourceRoot, targetRoot) => { handoff = { sessionDir, sourceRoot, targetRoot }; },
  });
  assert.equal(result.launched_runtime_root, fs.realpathSync(canonicalRoot));
  assert.equal(handoff.sourceRoot, fs.realpathSync(value.targetRoot));
  assert.equal(handoff.targetRoot, fs.realpathSync(canonicalRoot));
  child.kill();
});

test('runtime descriptor relocations remain equal while literal shell aliases and reserved bytes cannot collide', () => {
  const first = runtime('relocated');
  const second = runtime('relocated');
  fs.appendFileSync(path.join(first, 'extension', 'bin', 'mux-runner.js'), `const runtimeRoot = ${JSON.stringify(fs.realpathSync(first))};\n`);
  fs.appendFileSync(path.join(second, 'extension', 'bin', 'mux-runner.js'), `const runtimeRoot = ${JSON.stringify(fs.realpathSync(second))};\n`);
  assert.equal(runtimeBuildHash(first), runtimeBuildHash(second));
  fs.writeFileSync(path.join(second, '.pickle-rick-runtime'), 'installed\n');
  const relocatedHash = runtimeBuildHash(second);
  fs.writeFileSync(path.join(second, 'extension', 'bin', 'mux-runner.js'), 'const runtimeRoot = "$HOME/.codex/pickle-rick";\n');
  assert.notEqual(runtimeBuildHash(second), relocatedHash);
  fs.writeFileSync(path.join(second, 'extension', 'bin', 'mux-runner.js'), 'const runtimeRoot = "~/.codex/pickle-rick";\n');
  assert.notEqual(runtimeBuildHash(second), relocatedHash);
  fs.writeFileSync(path.join(second, 'extension', 'bin', 'mux-runner.js'), 'const runtimeRoot = "<PICKLE_RUNTIME_ROOT>";\n');
  assert.throws(() => runtimeBuildHash(second), /reserved runtime-root normalization token/);
});

test('legacy adoption fails closed before signaling on owner identity mismatch', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  deps.observeProcess = () => ({ identity: value.runner, command: 'node unrelated.js' });
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), /identity or exact argv/);
  assert.deepEqual(actions, []);
  assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_FILE)), false);
});

test('legacy adoption accepts a mux runner owned directly by the immutable tmux pane', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const observe = deps.observeProcess;
  deps.observeProcess = (pid) => {
    const observed = observe(pid);
    return pid === value.runner.pid ? { ...observed, parent_pid: value.pane.pid } : observed;
  };
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.equal(record.legacy_owner.supervisor, null);
  assert.deepEqual(record.legacy_owner.runner, value.runner);
  assert.deepEqual(record.legacy_owner.pane, value.pane);
  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'tmux:$7']);
});

test('legacy adoption rejects an arbitrary wrapper inserted into the pane ancestry', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const observe = deps.observeProcess;
  const wrapper = identity(51975);
  deps.observeProcess = (pid) => {
    if (pid === value.runner.pid) return { ...observe(pid), parent_pid: wrapper.pid };
    if (pid === wrapper.pid) return { identity: wrapper, parent_pid: value.supervisor.pid, command: 'python arbitrary-wrapper.py' };
    return observe(pid);
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /not owned directly by the exact tmux pane or its exact supervisor/,
  );
  assert.deepEqual(actions, []);
});

test('legacy adoption rejects direct tmux pane identity drift after fencing', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const observe = deps.observeProcess;
  let drifted = false;
  deps.stopController = () => { actions.push('fence'); drifted = true; };
  deps.observeProcess = (pid) => {
    const observed = observe(pid);
    if (pid === value.runner.pid) return { ...observed, parent_pid: value.pane.pid };
    return drifted && pid === value.pane.pid
      ? { ...observed, identity: { ...value.pane, start_time: 'reused-pane' } }
      : observed;
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /controller ancestry changed/,
  );
  assert.deepEqual(actions, ['watchdog', 'fence', 'resume']);
});

test('legacy adoption fails closed when the supervisor identity drifts after fencing', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const observe = deps.observeProcess;
  let drifted = false;
  deps.stopController = () => { actions.push('fence'); drifted = true; };
  deps.observeProcess = (pid) => {
    const observed = observe(pid);
    return drifted && pid === value.supervisor.pid
      ? { ...observed, identity: { ...value.supervisor, start_time: 'reused-supervisor' } }
      : observed;
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /controller ancestry changed/,
  );
  assert.deepEqual(actions, ['watchdog', 'fence', 'resume']);
});

test('legacy adoption rejects schema, artifact, ref, and installed runtime hash drift before launch', () => {
  const schemaValue = fixture();
  const statePath = path.join(schemaValue.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.schema_version = 2;
  writeJson(statePath, state);
  assert.throws(() => adoptActiveLegacyMuxSession(schemaValue.sessionDir, schemaValue.sourceRoot, schemaValue.targetRoot, depsFor(schemaValue)), /schema 2|newer than supported 1/);

  const artifactValue = fixture();
  adoptActiveLegacyMuxSession(artifactValue.sessionDir, artifactValue.sourceRoot, artifactValue.targetRoot, depsFor(artifactValue));
  writeJson(path.join(artifactValue.sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [] });
  assert.throws(() => launchAdoptedLegacySession(artifactValue.sessionDir, artifactValue.targetRoot, { launch: () => assert.fail('must not launch') }), /continuity failed/);

  const hashValue = fixture();
  adoptActiveLegacyMuxSession(hashValue.sessionDir, hashValue.sourceRoot, hashValue.targetRoot, depsFor(hashValue));
  fs.appendFileSync(path.join(hashValue.targetRoot, 'extension', 'bin', 'runtime.js'), '// drift\n');
  assert.throws(() => launchAdoptedLegacySession(hashValue.sessionDir, hashValue.targetRoot, { launch: () => assert.fail('must not launch') }), /runtime hash/);

  const refValue = fixture();
  adoptActiveLegacyMuxSession(refValue.sessionDir, refValue.sourceRoot, refValue.targetRoot, depsFor(refValue));
  git(refValue.repo, ['update-ref', '-d', `refs/pickle/salvage/${path.basename(refValue.sessionDir)}`]);
  assert.throws(() => launchAdoptedLegacySession(refValue.sessionDir, refValue.targetRoot, { launch: () => assert.fail('must not launch') }), /lost salvage refs/);
});

test('legacy adoption archives only attributable active candidate dirt', () => {
  const owned = fixture();
  const manifestPath = path.join(owned.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].allowed_paths.push('candidate-new.txt');
  writeJson(manifestPath, manifest);
  fs.appendFileSync(path.join(owned.repo, 'tracked.txt'), 'staged\n');
  git(owned.repo, ['add', 'tracked.txt']);
  fs.appendFileSync(path.join(owned.repo, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(owned.repo, 'candidate-new.txt'), 'new\n');
  const record = adoptActiveLegacyMuxSession(owned.sessionDir, owned.sourceRoot, owned.targetRoot, depsFor(owned));
  assert.deepEqual(record.candidate_archive.paths, ['candidate-new.txt', 'tracked.txt']);
  assert.deepEqual(record.candidate_archive.staged_paths, ['tracked.txt']);
  assert.match(record.candidate_archive.ref, /^refs\/pickle\/salvage-history\//);
  assert.equal(fs.readFileSync(path.join(owned.repo, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(owned.repo, 'candidate-new.txt')), false);
  assert.equal(git(owned.repo, ['status', '--porcelain']), '');
  git(owned.repo, ['rev-parse', '--verify', record.candidate_archive.ref]);
  const restored = restoreRejectedCandidateCheckpoint({
    sessionDir: owned.sessionDir, workingDir: owned.repo, ticketId: 'r1', expectedBaseHead: git(owned.repo, ['rev-parse', 'HEAD']),
    validateScope: (paths) => assert.deepEqual(paths, ['candidate-new.txt', 'tracked.txt']),
  });
  assert.ok(restored);
  assert.equal(fs.readFileSync(path.join(owned.repo, 'tracked.txt'), 'utf8'), 'base\nstaged\nunstaged\n');
  assert.equal(fs.readFileSync(path.join(owned.repo, 'candidate-new.txt'), 'utf8'), 'new\n');
  assert.equal(git(owned.repo, ['diff', '--cached', '--name-only']), 'tracked.txt');

  const foreign = fixture();
  fs.writeFileSync(path.join(foreign.repo, 'unrelated.txt'), 'foreign\n');
  const actions = [];
  assert.throws(() => adoptActiveLegacyMuxSession(foreign.sessionDir, foreign.sourceRoot, foreign.targetRoot, depsFor(foreign, actions)), /unrelated dirty paths/);
  assert.deepEqual(actions, []);
});

test('legacy adoption atomically rebinds a started refinement boundary after archiving its candidate', () => {
  const value = fixture();
  fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'in-flight candidate\n');
  installLegacyRefinementAcceptance(value);
  fs.mkdirSync(path.join(value.sessionDir, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), [
    '---', 'id: r1', 'title: Legacy ticket 1', 'status: In Progress', '---', '',
  ].join('\n'));
  const priorIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
  writeJson(path.join(value.sessionDir, 'refinement-repository-advance.json'), {
    schema_version: 1,
    ticket_id: 'r1',
    baseline_repository_identity: priorIdentity,
    baseline_head_sha: git(value.repo, ['rev-parse', 'HEAD']),
    baseline_files_fingerprint: getWorkingTreeContentFingerprint(value.repo),
    baseline_untracked_files: listUntrackedFiles(value.repo),
    requires_clean_commit: true,
    phase: 'started',
    updated_at: '2026-08-08T19:30:00.000Z',
  });

  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value));
  assert.deepEqual(record.candidate_archive.paths, ['tracked.txt']);
  assert.equal(git(value.repo, ['status', '--porcelain']), '');
  const currentIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
  assert.notEqual(currentIdentity, priorIdentity);
  const acceptance = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'refinement-acceptance.json'), 'utf8'));
  const repairedManifest = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'refinement_manifest.json'), 'utf8'));
  const reconciliation = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-refinement-boundary-reconciliation.json'), 'utf8',
  ));
  assert.equal(acceptance.repository_identity, currentIdentity);
  assert.equal(fs.existsSync(path.join(value.sessionDir, 'refinement-repository-advance.json')), false);
  assert.equal(repairedManifest.tickets[0].status, 'Todo');
  assert.match(fs.readFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), 'utf8'), /status: "Todo"/);
  assert.equal(reconciliation.prior_acceptance_repository_identity, priorIdentity);
  assert.equal(reconciliation.prior_advance.baseline_repository_identity, priorIdentity);
  assert.equal(reconciliation.recovery_ref, record.candidate_archive.ref);
  assert.deepEqual(reconciliation.archived_paths, ['tracked.txt']);
  assert.equal(validateRefinementAcceptance(value.sessionDir, {
    workingDir: value.repo,
    verifyRepository: true,
    preserveMalformedVerification: true,
  }).ok, true);
});

test('mixed dirty accepted boundary adopts, resumes, and restores its exact archived candidate', async () => {
  const value = fixture();
  const qualityCommand = 'node -e "process.exit(0)"';
  const qualityRunCommand = 'npm run test';
  fs.writeFileSync(path.join(value.repo, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(value.repo, 'package.json'), JSON.stringify({
    scripts: { test: qualityCommand },
  }, null, 2));
  git(value.repo, ['add', 'install.sh', 'package.json']);
  git(value.repo, ['commit', '-m', 'add quality prerequisite']);
  const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].allowed_paths.push('candidate-new.txt');
  manifest.tickets[0].verification = [{
    kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'],
  }];
  writeJson(manifestPath, manifest);
  installLegacyRefinementAcceptance(value);
  fs.mkdirSync(path.join(value.sessionDir, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), [
    '---', 'id: r1', 'title: Legacy ticket 1', 'status: In Progress', '---', '',
  ].join('\n'));
  for (const phase of ['research', 'plan']) {
    const artifactPath = path.join(value.sessionDir, 'worker-lifecycle', 'r1', `${phase}.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (phase === 'research') artifact.evidence = ['legacy candidate evidence remains archived'];
    else artifact.steps = ['resume from the clean archived candidate boundary'];
    writeJson(artifactPath, artifact);
  }
  const statePath = path.join(value.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.worker_timeout_seconds = 10;
  state.quality_baseline = {
    head_sha: git(value.repo, ['rev-parse', 'HEAD']),
    captured_at: '2026-08-08T19:30:00.000Z',
    commands: [{ command: qualityRunCommand, ok: true, exitCode: 0, signature: 'success', output: '' }],
    command_contract: { [qualityRunCommand]: qualityCommand },
  };
  writeJson(statePath, state);

  fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'staged candidate\n');
  git(value.repo, ['add', 'tracked.txt']);
  fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'unstaged candidate\n');
  fs.writeFileSync(path.join(value.repo, 'candidate-new.txt'), 'untracked candidate\n');
  const dirtyAcceptance = writeRefinementAcceptance(value.sessionDir, { workingDir: value.repo });
  const dirtyIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
  assert.equal(dirtyAcceptance.repository_identity, dirtyIdentity);
  assert.equal(validateRefinementAcceptance(value.sessionDir, {
    workingDir: value.repo, verifyRepository: true,
  }).ok, true);
  const advance = beginRefinementRepositoryAdvance({
    sessionDir: value.sessionDir, workingDir: value.repo, ticketId: 'r1', requiresCleanCommit: false,
  });
  assert.equal(advance.phase, 'started');
  assert.equal(advance.baseline_repository_identity, dirtyIdentity);
  assert.equal(advance.baseline_head_sha, git(value.repo, ['rev-parse', 'HEAD']));
  assert.deepEqual(advance.baseline_untracked_files, ['candidate-new.txt']);

  const deps = depsFor(value);
  delete deps.sealSession;
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.equal(record.status, 'adopted');
  assert.deepEqual(record.candidate_archive.paths, ['candidate-new.txt', 'tracked.txt']);
  assert.deepEqual(record.candidate_archive.staged_paths, ['tracked.txt']);
  assert.match(record.candidate_archive.ref, /^refs\/pickle\/salvage-history\//);
  assert.equal(git(value.repo, ['status', '--porcelain']), '');
  const cleanIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
  assert.notEqual(cleanIdentity, dirtyIdentity);
  assert.equal(validateRefinementAcceptance(value.sessionDir, {
    workingDir: value.repo, verifyRepository: true,
  }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'refinement-acceptance.json'), 'utf8',
  )).repository_identity, cleanIdentity);
  assert.equal(fs.existsSync(path.join(value.sessionDir, 'refinement-repository-advance.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).tickets[0].status, 'Todo');
  assert.match(fs.readFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), 'utf8'), /status: "Todo"/);

  const archivePath = path.join(value.sessionDir, 'legacy-candidate-archive.json');
  const checkpointPath = path.join(value.sessionDir, 'rejected-candidates', 'r1.json');
  const archiveBeforeReadiness = fs.readFileSync(archivePath, 'utf8');
  const checkpointBeforeReadiness = fs.readFileSync(checkpointPath, 'utf8');
  const archive = JSON.parse(archiveBeforeReadiness);
  const checkpoint = JSON.parse(checkpointBeforeReadiness);
  const recoverySha = git(value.repo, ['rev-parse', record.candidate_archive.ref]);
  assert.equal(archive.cleanup_complete, true);
  assert.equal(archive.ref, record.candidate_archive.ref);
  assert.equal(checkpoint.recovery_ref, record.candidate_archive.ref);
  assert.equal(checkpoint.evidence_path, fs.realpathSync(archivePath));
  assert.deepEqual(checkpoint.changed_paths, ['candidate-new.txt', 'tracked.txt']);
  const migration = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  const preserved = new Set(migration.preserved_artifacts.map((entry) => entry.path));
  assert.ok(preserved.has('legacy-candidate-archive.json'));
  assert.ok(preserved.has('legacy-refinement-boundary-reconciliation.json'));
  assert.ok(preserved.has('rejected-candidates/r1.json'));
  assert.ok(migration.salvage_refs.some((entry) => entry.startsWith(`${record.candidate_archive.ref}:`)));
  assert.ok(fs.existsSync(path.join(value.sessionDir, 'prd.lock.json')));
  assert.equal(readLogicalPipeline(value.sessionDir).events.at(-1).kind, 'legacy_session_adopted');

  const readiness = checkReadiness(value.sessionDir, { runtimeRoot: projectRoot });
  assert.equal(readiness.ready, true, JSON.stringify(readiness.findings));
  assert.ok(readiness.findings.some((finding) => finding.code === 'adoption-repair-ready'));
  const ready = await ensureBootstrapSessionReady(value.sessionDir, { resumeReadyOnly: true });
  assert.equal(ready.summary.runnable[0].id, 'r1');
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), true);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), archiveBeforeReadiness);
  assert.equal(fs.readFileSync(checkpointPath, 'utf8'), checkpointBeforeReadiness);
  assert.equal(git(value.repo, ['rev-parse', record.candidate_archive.ref]), recoverySha);

  const restored = restoreRejectedCandidateCheckpoint({
    sessionDir: value.sessionDir,
    workingDir: value.repo,
    ticketId: 'r1',
    expectedBaseHead: git(value.repo, ['rev-parse', 'HEAD']),
    validateScope: (paths) => assert.deepEqual(paths, ['candidate-new.txt', 'tracked.txt']),
  });
  assert.ok(restored);
  assert.equal(fs.readFileSync(path.join(value.repo, 'tracked.txt'), 'utf8'), [
    'base', 'staged candidate', 'unstaged candidate', '',
  ].join('\n'));
  assert.equal(fs.readFileSync(path.join(value.repo, 'candidate-new.txt'), 'utf8'), 'untracked candidate\n');
  assert.equal(git(value.repo, ['diff', '--cached', '--name-only']), 'tracked.txt');
  assert.equal(git(value.repo, ['diff', '--name-only']), 'tracked.txt');
  assert.match(git(value.repo, ['status', '--porcelain']), /^MM tracked\.txt\n\?\? candidate-new\.txt$/);
});

test('migrated adoption supersedes stale repository-bound inventory and resumes idempotently', () => {
  const value = fixture();
  fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'in-flight migrated candidate\n');
  installLegacyRefinementAcceptance(value);
  fs.mkdirSync(path.join(value.sessionDir, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), [
    '---', 'id: r1', 'title: Legacy ticket 1', 'status: In Progress', '---', '',
  ].join('\n'));
  const priorIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
  writeJson(path.join(value.sessionDir, 'refinement-repository-advance.json'), {
    schema_version: 1, ticket_id: 'r1', baseline_repository_identity: priorIdentity,
    baseline_head_sha: git(value.repo, ['rev-parse', 'HEAD']),
    baseline_files_fingerprint: getWorkingTreeContentFingerprint(value.repo),
    baseline_untracked_files: listUntrackedFiles(value.repo), requires_clean_commit: true,
    phase: 'started', updated_at: '2026-08-08T19:30:00.000Z',
  });
  const deps = depsFor(value);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'quiesced') throw new Error('simulate-old-migrated-runtime');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /simulate-old-migrated-runtime/,
  );
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const staleMigration = prepareLiveSessionMigration(
    value.sessionDir, transaction.source_runtime, transaction.target_runtime,
    new Date('2026-08-08T19:59:00.000Z'), { forceVerificationContractRepair: true },
  );
  writeJson(transactionPath, {
    ...transaction, stage: 'migrated', migration_content_hash: staleMigration.content_hash,
    updated_at: '2026-08-08T19:59:00.000Z',
  });

  deps.checkpoint = undefined;
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  const completedTransaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const regeneratedMigration = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  assert.equal(record.status, 'adopted');
  assert.equal(completedTransaction.superseded_migration_content_hash, staleMigration.content_hash);
  assert.equal(completedTransaction.boundary_reconciliation.status, 'completed');
  assert.notEqual(regeneratedMigration.content_hash, staleMigration.content_hash);
  assert.equal(regeneratedMigration.content_hash, record.migration_content_hash);
  assert.equal(fs.existsSync(path.join(value.sessionDir, 'refinement-repository-advance.json')), false);
  assert.equal(validateRefinementAcceptance(value.sessionDir, {
    workingDir: value.repo, verifyRepository: true, preserveMalformedVerification: true,
  }).ok, true);
  assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).migration_content_hash, record.migration_content_hash);
});

test('quiesced adoption durably repins an approved compatible target runtime', () => {
  const value = fixture();
  const deps = depsFor(value);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'quiesced') throw new Error('pause-before-target-repin');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pause-before-target-repin/,
  );
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// approved target\n');
  deps.validationSessionDir = approveTargetRuntime(value.targetRoot);
  const replacement = describeInstalledRuntime(value.targetRoot);
  deps.checkpoint = undefined;
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  const transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  const migration = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  assert.deepEqual(record.target_runtime, replacement);
  assert.deepEqual(migration.target_runtime, replacement);
  assert.equal(transaction.target_runtime_supersessions.length, 1);
  assert.equal(transaction.target_runtime_supersessions[0].prior_migration_content_hash, null);
  assert.deepEqual(transaction.target_runtime_supersessions[0].replacement_target_runtime, replacement);
  assert.equal(record.target_runtime_supersessions[0].validation_approval_sha256,
    transaction.target_runtime_supersessions[0].validation_approval_sha256);
  const adoptionEvent = readLogicalPipeline(value.sessionDir).events.find((event) => event.kind === 'legacy_session_adopted');
  assert.deepEqual(adoptionEvent.details.target_runtime_supersessions, record.target_runtime_supersessions);
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  )).target_runtime_supersessions.length, 1);
});

test('quiesced target repin requires a Citadel validation session for the exact clean checkout', () => {
  const value = fixture();
  const deps = depsFor(value);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'quiesced') throw new Error('pause-for-unapproved-repin');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pause-for-unapproved-repin/,
  );
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// unapproved target\n');
  deps.checkpoint = undefined;
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /--validation-session/,
  );
  const transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(transaction.stage, 'quiesced');
  assert.equal(transaction.target_runtime_repin, undefined);
});

test('migrated adoption upgrades legacy prepared validation evidence and resumes after supersession crash', () => {
  const value = fixture();
  const deps = depsFor(value);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'migrated') throw new Error('pause-at-old-migration');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pause-at-old-migration/,
  );
  const oldMigration = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// approved migrated target\n');
  deps.validationSessionDir = approveTargetRuntime(value.targetRoot);
  const replacement = describeInstalledRuntime(value.targetRoot);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'target_runtime_superseded') throw new Error('crash-after-target-supersession');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /crash-after-target-supersession/,
  );
  const prepared = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(prepared.stage, 'quiesced');
  assert.equal(prepared.target_runtime_repin.status, 'prepared');
  assert.equal(prepared.target_runtime_repin.prior_migration_content_hash, oldMigration.content_hash);
  assert.deepEqual(prepared.target_runtime, oldMigration.target_runtime);
  assert.equal(fs.existsSync(path.join(value.sessionDir, 'installed-runtime-migration.json')), true);
  delete prepared.target_runtime_repin.validation_approval_file_sha256;
  delete prepared.target_runtime_repin.validation_report_file_sha256;
  writeJson(path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), prepared);

  deps.checkpoint = undefined;
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  const regenerated = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
  assert.deepEqual(record.target_runtime, replacement);
  assert.deepEqual(regenerated.target_runtime, replacement);
  assert.notEqual(regenerated.content_hash, oldMigration.content_hash);
  assert.equal(record.migration_content_hash, regenerated.content_hash);
  const completed = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(completed.target_runtime_repin.status, 'completed');
  assert.match(completed.target_runtime_repin.validation_approval_file_sha256, /^[a-f0-9]{64}$/);
  assert.match(completed.target_runtime_repin.validation_report_file_sha256, /^[a-f0-9]{64}$/);
  assert.equal(completed.target_runtime_supersessions.length, 1);
});

test('target runtime repin refuses migrated evidence drift before mutating its durable pin', () => {
  const value = fixture();
  const deps = depsFor(value);
  deps.checkpoint = (checkpoint) => {
    if (checkpoint === 'migrated') throw new Error('pause-before-drifted-repin');
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pause-before-drifted-repin/,
  );
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const before = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// replacement\n');
  deps.validationSessionDir = approveTargetRuntime(value.targetRoot);
  writeJson(path.join(value.sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [] });
  deps.checkpoint = undefined;
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /continuity failed/,
  );
  const after = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  assert.equal(after.stage, 'migrated');
  assert.deepEqual(after.target_runtime, before.target_runtime);
  assert.equal(after.target_runtime_supersessions, undefined);
});

test('archived boundary reconciliation resumes across prepared, applied, and completed checkpoints', () => {
  for (const checkpoint of ['boundary_prepared', 'boundary_applied', 'boundary_completed']) {
    const value = fixture();
    fs.appendFileSync(path.join(value.repo, 'tracked.txt'), `${checkpoint} candidate\n`);
    installLegacyRefinementAcceptance(value);
    fs.mkdirSync(path.join(value.sessionDir, 'r1'), { recursive: true });
    fs.writeFileSync(path.join(value.sessionDir, 'r1', 'linear_ticket_r1.md'), [
      '---', 'id: r1', 'title: Legacy ticket 1', 'status: In Progress', '---', '',
    ].join('\n'));
    const priorIdentity = refinementRepositoryIdentity(value.repo, value.sessionDir);
    writeJson(path.join(value.sessionDir, 'refinement-repository-advance.json'), {
      schema_version: 1, ticket_id: 'r1', baseline_repository_identity: priorIdentity,
      baseline_head_sha: git(value.repo, ['rev-parse', 'HEAD']),
      baseline_files_fingerprint: getWorkingTreeContentFingerprint(value.repo),
      baseline_untracked_files: listUntrackedFiles(value.repo), requires_clean_commit: true,
      phase: 'started', updated_at: '2026-08-08T19:30:00.000Z',
    });
    const deps = depsFor(value);
    let injected = false;
    deps.checkpoint = (current) => {
      const injectedCheckpoint = checkpoint === 'boundary_applied' ? 'boundary_prepared' : checkpoint;
      if (!injected && current === injectedCheckpoint) {
        injected = true;
        throw new Error(`injected-${checkpoint}`);
      }
    };
    assert.throws(
      () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      new RegExp(`injected-${checkpoint}`),
    );
    if (checkpoint === 'boundary_applied') {
      const transaction = JSON.parse(fs.readFileSync(
        path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
      ));
      reconcileArchivedCandidateRefinementBoundary({
        sessionDir: fs.realpathSync(value.sessionDir),
        workingDir: fs.realpathSync(value.repo),
        ticketId: transaction.boundary_reconciliation.ticket_id,
        baseHead: transaction.boundary_reconciliation.base_head,
        recoveryRef: transaction.boundary_reconciliation.recovery_ref,
        archivedPaths: transaction.candidate_archive.paths,
      });
    }
    deps.checkpoint = undefined;
    const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
    assert.equal(record.status, 'adopted', checkpoint);
    assert.equal(fs.existsSync(path.join(value.sessionDir, 'refinement-repository-advance.json')), false, checkpoint);
    assert.equal(validateRefinementAcceptance(value.sessionDir, {
      workingDir: value.repo, verifyRepository: true, preserveMalformedVerification: true,
    }).ok, true, checkpoint);
  }
});

test('legacy adoption freezes the controller then rereads a respawned child before any tmux kill', () => {
  const value = fixture();
  const actions = [];
  const replacement = identity(4400);
  const deps = depsFor(value, actions);
  deps.stopController = () => {
    actions.push('fence');
    const statePath = path.join(value.sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.active_child_pid = replacement.pid;
    state.active_child_identity = replacement;
    writeJson(statePath, state);
  };
  deps.reapChild = (child) => {
    actions.push(`child:${child.pid}`);
    return { status: 'reaped', pid: child.pid, pgid: child.pgid, reason: 'test', signals: ['SIGTERM'] };
  };
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.deepEqual(actions, ['watchdog', 'fence', `child:${replacement.pid}`, 'tmux:$7']);
});

test('candidate snapshot is taken after child quiescence and captures the final attributable mutation', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  deps.afterChildQuiesced = () => {
    actions.push('final-mutation');
    fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'last-worker-write\n');
  };
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.deepEqual(record.candidate_archive.paths, ['tracked.txt']);
  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'final-mutation', 'tmux:$7']);
  assert.equal(git(value.repo, ['status', '--porcelain']), '');
  restoreRejectedCandidateCheckpoint({ sessionDir: value.sessionDir, workingDir: value.repo, ticketId: 'r1',
    expectedBaseHead: git(value.repo, ['rev-parse', 'HEAD']), validateScope: () => undefined });
  assert.equal(fs.readFileSync(path.join(value.repo, 'tracked.txt'), 'utf8'), 'base\nlast-worker-write\n');
});

test('candidate restore WAL replays every crash prefix without double apply or byte loss', () => {
  for (const crashPoint of ['prepared', 'patch_applied', 'applied', 'archive_invalidated']) {
    const value = fixture();
    const deps = depsFor(value);
    const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.tickets[0].allowed_paths.push('scratch.txt');
    writeJson(manifestPath, manifest);
    fs.writeFileSync(path.join(value.repo, 'tracked.txt'), 'staged WAL candidate\n');
    git(value.repo, ['add', 'tracked.txt']);
    fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'unstaged WAL candidate\n');
    fs.writeFileSync(path.join(value.repo, 'scratch.txt'), 'untracked WAL candidate\n');
    const expected = {
      status: git(value.repo, ['status', '--porcelain=v1']),
      tracked: fs.readFileSync(path.join(value.repo, 'tracked.txt')),
      staged: execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }),
      scratch: fs.readFileSync(path.join(value.repo, 'scratch.txt')),
    };
    const statePath = path.join(value.sessionDir, 'state.json');
    let published = false;
    deps.checkpoint = (checkpoint) => {
      if (checkpoint !== 'candidate_archived' || published) return;
      published = true;
      new StateManager().update(statePath, (state) => {
        state.autonomous_budget_rollover_intent_id = `wal-${crashPoint}`;
        return state;
      });
    };
    let crashed = false;
    let simulatedCrash = null;
    deps.simulateProcessDeath = (error) => error === simulatedCrash;
    deps.candidateRestoreCheckpoint = (checkpoint) => {
      if (checkpoint !== crashPoint || crashed) return;
      crashed = true;
      simulatedCrash = new Error(`crash-${crashPoint}`);
      throw simulatedCrash;
    };

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      new RegExp(`crash-${crashPoint}`), crashPoint);
    deps.candidateRestoreCheckpoint = undefined;
    deps.checkpoint = undefined;
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /refuses modern authority/, crashPoint);
    assert.equal(git(value.repo, ['status', '--porcelain=v1']), expected.status, crashPoint);
    assert.deepEqual(fs.readFileSync(path.join(value.repo, 'tracked.txt')), expected.tracked, crashPoint);
    assert.deepEqual(execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }), expected.staged, crashPoint);
    assert.deepEqual(fs.readFileSync(path.join(value.repo, 'scratch.txt')), expected.scratch, crashPoint);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete state.autonomous_budget_rollover_intent_id;
    writeJson(statePath, state);
    assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).status,
      'adopted', crashPoint);
  }
});

test('prepared restore crash replays mode-only and symlink Git semantics', () => {
  const value = fixture();
  const deps = depsFor(value);
  const scriptPath = path.join(value.repo, 'mode-only.sh');
  const linkPath = path.join(value.repo, 'candidate-link');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  git(value.repo, ['add', 'mode-only.sh']);
  git(value.repo, ['commit', '-m', 'tracked non-executable script']);
  const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].allowed_paths.push('mode-only.sh', 'candidate-link');
  writeJson(manifestPath, manifest);
  fs.chmodSync(scriptPath, 0o755);
  fs.symlinkSync('tracked.txt', linkPath);
  const statePath = path.join(value.sessionDir, 'state.json');
  let published = false;
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'candidate_archived' || published) return;
    published = true;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'mode-symlink-restore';
      return state;
    });
  };
  let simulatedCrash = null;
  deps.simulateProcessDeath = (error) => error === simulatedCrash;
  deps.candidateRestoreCheckpoint = (checkpoint) => {
    if (checkpoint !== 'prepared' || simulatedCrash) return;
    simulatedCrash = new Error('prepared-mode-symlink-crash');
    throw simulatedCrash;
  };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /prepared-mode-symlink-crash/);
  deps.candidateRestoreCheckpoint = undefined;
  deps.checkpoint = undefined;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /refuses modern authority/);
  assert.equal(fs.lstatSync(scriptPath).mode & 0o111, 0o111);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(linkPath), 'tracked.txt');
});

test('candidate archive cleanup crash is discovered and exactly replayed before retry continues', () => {
  const value = fixture();
  const deps = depsFor(value);
  const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].allowed_paths.push('scratch.txt');
  writeJson(manifestPath, manifest);
  fs.writeFileSync(path.join(value.repo, 'tracked.txt'), 'staged cleanup candidate\n');
  git(value.repo, ['add', 'tracked.txt']);
  fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'unstaged cleanup candidate\n');
  fs.writeFileSync(path.join(value.repo, 'scratch.txt'), 'untracked cleanup candidate\n');
  const expected = {
    status: git(value.repo, ['status', '--porcelain=v1']),
    tracked: fs.readFileSync(path.join(value.repo, 'tracked.txt')),
    staged: execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }),
    scratch: fs.readFileSync(path.join(value.repo, 'scratch.txt')),
  };
  let crashed = false;
  let simulatedCrash = null;
  deps.simulateProcessDeath = (error) => error === simulatedCrash;
  deps.afterCandidateArchiveCleanup = () => {
    if (crashed) return;
    crashed = true;
    simulatedCrash = new Error('crash-after-candidate-cleanup');
    throw simulatedCrash;
  };

  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /crash-after-candidate-cleanup/);
  const stranded = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(stranded.candidate_archive.ref, null);
  assert.equal(git(value.repo, ['status', '--porcelain=v1']), '');
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-candidate-archive.json'), 'utf8',
  )).cleanup_complete, true);

  let checkedRestoredCandidate = false;
  deps.afterCandidateArchiveCleanup = undefined;
  deps.stopController = () => {
    checkedRestoredCandidate = true;
    assert.equal(git(value.repo, ['status', '--porcelain=v1']), expected.status);
    assert.deepEqual(fs.readFileSync(path.join(value.repo, 'tracked.txt')), expected.tracked);
    assert.deepEqual(execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }), expected.staged);
    assert.deepEqual(fs.readFileSync(path.join(value.repo, 'scratch.txt')), expected.scratch);
  };
  assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).status, 'adopted');
  assert.equal(checkedRestoredCandidate, true);
});

test('late modern evidence resumes the fenced legacy owner and remains retryable before tmux shutdown', () => {
  for (const phase of ['after-child-quiescence', 'immediately-before-kill']) {
    const value = fixture();
    const actions = [];
    const deps = depsFor(value, actions);
    const statePath = path.join(value.sessionDir, 'state.json');
    const evidence = { intent_id: `rollover-${phase}` };
    let candidateSnapshot = null;
    if (phase === 'immediately-before-kill') {
      const manifestPath = path.join(value.sessionDir, 'refinement_manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.tickets[0].allowed_paths.push('scratch.txt', 'late.txt');
      writeJson(manifestPath, manifest);
      fs.writeFileSync(path.join(value.repo, 'tracked.txt'), 'staged candidate\n');
      git(value.repo, ['add', 'tracked.txt']);
      fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'unstaged candidate\n');
      fs.writeFileSync(path.join(value.repo, 'scratch.txt'), 'untracked candidate\n');
      candidateSnapshot = {
        status: git(value.repo, ['status', '--porcelain=v1']),
        tracked: fs.readFileSync(path.join(value.repo, 'tracked.txt')),
        staged: execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }),
        untracked: fs.readFileSync(path.join(value.repo, 'scratch.txt')),
      };
    }
    const publishEvidence = () => {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.autonomous_budget_rollover_checkpoint_pending = evidence;
      writeJson(statePath, state);
    };
    if (phase === 'after-child-quiescence') deps.afterChildQuiesced = publishEvidence;
    else deps.checkpoint = (checkpoint) => {
      if (checkpoint === 'candidate_archived') publishEvidence();
    };

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /refuses modern evidence published/, phase);
    assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'resume'], phase);
    const rejected = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(rejected.autonomous_budget_rollover_checkpoint_pending, evidence, phase);
    assert.equal(rejected.tmux_runner_pid, value.runner.pid, phase);
    assert.equal(rejected.tmux_session_name, value.tmuxName, phase);
    if (candidateSnapshot) {
      assert.equal(git(value.repo, ['status', '--porcelain=v1']), candidateSnapshot.status, phase);
      assert.deepEqual(fs.readFileSync(path.join(value.repo, 'tracked.txt')), candidateSnapshot.tracked, phase);
      assert.deepEqual(execFileSync('git', ['show', ':tracked.txt'], { cwd: value.repo }), candidateSnapshot.staged, phase);
      assert.deepEqual(fs.readFileSync(path.join(value.repo, 'scratch.txt')), candidateSnapshot.untracked, phase);
    }
    const transaction = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
    ));
    assert.equal(transaction.stage, 'fenced', phase);

    delete rejected.autonomous_budget_rollover_checkpoint_pending;
    if (phase === 'immediately-before-kill') {
      fs.appendFileSync(path.join(value.repo, 'tracked.txt'), 'mutation after abort\n');
      fs.writeFileSync(path.join(value.repo, 'late.txt'), 'new untracked path after abort\n');
    }
    writeJson(statePath, rejected);
    deps.afterChildQuiesced = undefined;
    deps.checkpoint = undefined;
    actions.length = 0;
    const resumed = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
    assert.equal(resumed.status, 'adopted', phase);
    assert.deepEqual(actions, ['fence', 'child', 'tmux:$7'], phase);
    if (phase === 'immediately-before-kill') {
      assert.deepEqual(resumed.candidate_archive.paths, ['late.txt', 'scratch.txt', 'tracked.txt']);
      const completed = JSON.parse(fs.readFileSync(
        path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
      ));
      assert.equal(Object.hasOwn(completed, 'candidate_archive_epochs'), false);
      assert.match(git(value.repo, ['rev-parse', '--verify', completed.candidate_archive.ref]), /^[a-f0-9]{40}$/);
    }
  }
});

test('failed controller resume remains durably fenced until watchdog retry succeeds', () => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  deps.afterChildQuiesced = () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.autonomous_budget_rollover_intent_id = 'late-rollover';
    writeJson(statePath, state);
  };
  let resumeAttempts = 0;
  deps.resumeController = () => {
    resumeAttempts += 1;
    if (resumeAttempts === 1) throw new Error('injected SIGCONT failure');
  };

  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /durably fenced for watchdog retry/);
  let transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(transaction.stage, 'fenced');
  assert.equal(transaction.controller_fenced, true);

  deps.afterChildQuiesced = undefined;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /refuses modern authority/);
  transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(resumeAttempts, 2);
  assert.equal(transaction.controller_fenced, false);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete state.autonomous_budget_rollover_intent_id;
  writeJson(statePath, state);
  assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).status, 'adopted');
});

test('state-lock publication waits for atomic owner death and clear then remains watchdog-recoverable', (t) => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const statePath = path.join(value.sessionDir, 'state.json');
  const published = path.join(value.sessionDir, 'lock-respecting-publication.done');
  let writer;
  deps.afterFinalEvidenceCheck = () => {
    const source = [
      "import fs from 'node:fs';",
      "import { StateManager } from './services/state-manager.js';",
      "new StateManager().update(process.argv[1], (state) => { state.autonomous_budget_rollover_intent_id = 'concurrent-rollover'; return state; });",
      "fs.writeFileSync(process.argv[2], 'published');",
    ].join('\n');
    writer = spawn(process.execPath, ['--input-type=module', '-e', source, statePath, published], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname), stdio: 'ignore',
    });
  };
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(published) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(fs.existsSync(published), true, 'lock-respecting publisher never completed after handoff');
  };
  deps.ensurePostHandoffOwner = () => {
    return publishAcceptedRecoverySupervisor(statePath, t).pid;
  };
  t.after(() => {
    if (writer?.pid) try { process.kill(writer.pid, 'SIGKILL'); } catch {}
  });

  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);
  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'tmux:$7']);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.autonomous_budget_rollover_intent_id, 'concurrent-rollover');
  assert.equal(state.tmux_runner_pid, null);
  const transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(transaction.stage, 'quiesced');
  assert.equal(transaction.controller_shutdown.status, 'committed');
  assert.equal(transaction.post_handoff_recovery.status, 'ownership_transferred');
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('committed transfer proof rejects malformed and mismatched transaction bindings', (t) => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'strict-transfer-proof';
      return state;
    });
  };
  deps.ensurePostHandoffOwner = () => publishAcceptedRecoverySupervisor(statePath, t).pid;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);

  const committed = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const consumed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(validCommittedLegacyAdoptionTransfer(value.sessionDir, committed, consumed), true);

  const receiptArgMismatch = structuredClone(committed);
  receiptArgMismatch.post_handoff_recovery.ready_receipt.runner_args = ['--different'];
  const { receipt_id: ignored, ...unsignedReceipt } = receiptArgMismatch.post_handoff_recovery.ready_receipt;
  void ignored;
  receiptArgMismatch.post_handoff_recovery.ready_receipt.receipt_id = sha256(JSON.stringify(unsignedReceipt));
  receiptArgMismatch.post_handoff_recovery.ready_receipt_id
    = receiptArgMismatch.post_handoff_recovery.ready_receipt.receipt_id;

  const cases = [
    ['schema', (candidate) => { candidate.schema_version = 2; }],
    ['session', (candidate) => { candidate.session_id = 'different-session'; }],
    ['stage', (candidate) => { candidate.stage = 'fenced'; }],
    ['malformed-owner', (candidate) => { candidate.post_handoff_recovery.owner_identity.fingerprint = 'bad'; }],
    ['swapped-identities', (candidate) => {
      candidate.post_handoff_recovery.owner_identity
        = structuredClone(candidate.post_handoff_recovery.recovery_daemon_identity);
    }],
    ['spec-id', (candidate) => { candidate.post_handoff_recovery.owner_spec_id = '0'.repeat(64); }],
    ['receipt-id', (candidate) => { candidate.post_handoff_recovery.ready_receipt_id = '0'.repeat(64); }],
    ['receipt-spec', (candidate) => { candidate.post_handoff_recovery.ready_receipt.owner_spec_id = '0'.repeat(64); }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(committed);
    mutate(candidate);
    assert.equal(validCommittedLegacyAdoptionTransfer(value.sessionDir, candidate, consumed), false, label);
    writeJson(transactionPath, candidate);
    assert.equal(legacyAdoptionOutcome(value.sessionDir), 'running', label);
  }
  assert.equal(validCommittedLegacyAdoptionTransfer(value.sessionDir, receiptArgMismatch, consumed), false,
    'self-consistent receipt still must bind the owner spec');
  assert.equal(validCommittedLegacyAdoptionTransfer(value.sessionDir, committed, {
    ...consumed, legacy_adoption_supervisor_challenge: committed.post_handoff_recovery.challenge,
  }), false, 'unconsumed challenge');

  writeJson(transactionPath, committed);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('shutdown commits only when the runner exited and tmux is absent', () => {
  for (const failure of ['runner-live', 'tmux-live']) {
    const value = fixture();
    const actions = [];
    const deps = depsFor(value, actions);
    if (failure === 'runner-live') {
      let runnerLive = true;
      const baseInspect = deps.inspectProcess;
      deps.waitForRunnerExit = () => false;
      deps.inspectProcess = (exact) => exact.pid === value.runner.pid && runnerLive ? 'matched' : baseInspect(exact);
      deps.reapRunner = (exact) => {
        actions.push(`reap-runner:${exact.pid}`);
        runnerLive = false;
        return { status: 'reaped', pid: exact.pid, pgid: exact.pgid, reason: 'test', signals: ['SIGTERM'] };
      };
    }
    else {
      const exactKill = deps.killTmux;
      let killAttempts = 0;
      deps.killTmux = (sessionId) => {
        killAttempts += 1;
        if (killAttempts === 1) actions.push('kill-without-removing-tmux');
        else exactKill(sessionId);
      };
    }

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /owner did not stop/, failure);
    const transaction = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
    ));
    assert.equal(transaction.stage, 'fenced', failure);
    assert.notEqual(transaction.controller_shutdown.status, 'committed', failure);
    assert.equal(transaction.controller_fence.status, 'released', failure);
    assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).status,
      'adopted', failure);
    if (failure === 'runner-live') assert.equal(actions.includes(`reap-runner:${value.runner.pid}`), true);
  }
});

test('quiesced post-handoff evidence derives a durable generic owner and converges on acceptance', (t) => {
  for (const mode of ['budget-intent', 'async-owner']) {
    const value = fixture();
    const deps = depsFor(value);
    const statePath = path.join(value.sessionDir, 'state.json');
    let published = false;
    deps.checkpoint = (checkpoint) => {
      if (checkpoint !== 'quiesced' || published) return;
      published = true;
      new StateManager().update(statePath, (state) => {
        state.autonomous_budget_rollover_intent_id = `${mode}-rollover`;
        return state;
      });
    };
    let ensureAttempts = 0;
    deps.ensurePostHandoffOwner = () => {
      ensureAttempts += 1;
      if (ensureAttempts === 2) {
        return publishAcceptedRecoverySupervisor(statePath, t).pid;
      }
      return null;
    };

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /pending an authenticated target supervisor/, mode);
    assert.equal(fs.existsSync(path.join(value.sessionDir, 'installed-runtime-migration.json')), false, mode);
    const pendingState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(pendingState.autonomous_owner_spec.owner_mode, 'process', mode);
    assert.equal(pendingState.autonomous_owner_spec.runner_bin, 'mux-runner.js', mode);
    assert.deepEqual(pendingState.autonomous_owner_spec.runner_args, ['--on-failure=retry'], mode);
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /ownership transferred to the authenticated modern recovery owner/, mode);
    assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal', mode);
  }
});

test('recovery daemon death before target acceptance remains supervised and converges', (t) => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'daemon-death-rollover';
      return state;
    });
  };
  let ensureAttempts = 0;
  deps.ensurePostHandoffOwner = () => {
    ensureAttempts += 1;
    new StateManager().update(statePath, (state) => {
      state.autonomous_owner_recovery_daemon_pid = 90000 + ensureAttempts;
      state.autonomous_owner_recovery_daemon_identity = identity(90000 + ensureAttempts);
      return state;
    });
    if (ensureAttempts === 3) return publishAcceptedRecoverySupervisor(statePath, t).pid;
    return 90000 + ensureAttempts;
  };

  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pending an authenticated target supervisor/);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'running');
  new StateManager().update(statePath, (state) => {
    state.autonomous_owner_recovery_daemon_pid = null;
    state.autonomous_owner_recovery_daemon_identity = null;
    return state;
  });
  deps.checkpoint = undefined;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pending an authenticated target supervisor/);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'running');
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('arbitrary live Node process cannot satisfy target supervisor readiness', (t) => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'arbitrary-process-rollover';
      return state;
    });
  };
  let ensureAttempts = 0;
  deps.ensurePostHandoffOwner = () => {
    ensureAttempts += 1;
    if (ensureAttempts === 1) {
      const arbitrary = captureProcessLivenessIdentity(process.pid);
      assert.ok(arbitrary);
      const daemon = publishTestRecoveryDaemon(statePath);
      writeRestoredRecoverySupervisor(statePath, arbitrary, true);
      assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).autonomous_supervisor_ready_receipt,
        'forged receipt must be present for the provenance rejection');
      return daemon.pid;
    }
    return publishAcceptedRecoverySupervisor(statePath, t).pid;
  };

  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pending an authenticated target supervisor/);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'running');
  deps.checkpoint = undefined;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('supervisor ready receipt preserves spaces, quotes, and empty argv entries exactly', (t) => {
  const value = fixture();
  const statePath = path.join(value.sessionDir, 'state.json');
  const runnerArgs = ['--label=space value', '--quote="exact value"', ''];
  const supervisorPath = path.join(value.targetRoot, 'extension', 'bin', 'supervised-runner.js');
  const publishErrorPath = path.join(value.sessionDir, 'ready-publish-error.txt');
  const recoveryModule = new URL('../services/autonomous-owner-recovery.js', import.meta.url).href;
  fs.writeFileSync(supervisorPath, [
    "import { fileURLToPath } from 'node:url';",
    "import fs from 'node:fs';",
    `process.on('uncaughtException', (error) => { fs.writeFileSync(${JSON.stringify(publishErrorPath)}, error.stack || error.message); process.exit(1); });`,
    `import { publishAutonomousSupervisorReadyReceipt, registerAutonomousOwnerSpec } from ${JSON.stringify(recoveryModule)};`,
    "const sessionDir = process.argv[2];",
    "const runnerFlag = process.argv[3];",
    "const runnerBin = runnerFlag.slice('--runner-bin='.length);",
    "const runnerArgs = process.argv.slice(4);",
    "const self = fileURLToPath(import.meta.url);",
    "const spec = registerAutonomousOwnerSpec(sessionDir, runnerBin, runnerArgs, undefined, self);",
    "publishAutonomousSupervisorReadyReceipt(sessionDir, spec, runnerBin, runnerArgs, self);",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const spec = deriveAutonomousProcessOwnerSpec(
    value.sessionDir, value.repo, 'mux-runner.js', runnerArgs, path.join(value.targetRoot, 'extension', 'bin'),
  );
  const recoveryDaemon = captureProcessLivenessIdentity(process.pid);
  assert.ok(recoveryDaemon);
  const adoptionChallenge = 'structured-argv-challenge';
  new StateManager().update(statePath, (state) => {
    state.autonomous_owner_spec = spec;
    state.autonomous_budget_rollover_intent_id = 'structured-argv-rollover';
    state.autonomous_budget_epoch = 1;
    state.autonomous_owner_recovery_daemon_pid = recoveryDaemon.pid;
    state.autonomous_owner_recovery_daemon_identity = recoveryDaemon;
    state.legacy_adoption_supervisor_challenge = adoptionChallenge;
    state.autonomous_owner_restoration = {
      schema_version: 1, intent_id: 'structured-argv-restoration',
      rollover_intent_id: 'structured-argv-rollover', rollover_epoch: 1,
      owner_spec_id: spec.spec_id, status: 'restoring', attempt: 1,
      not_before: '2026-08-08T20:00:00.000Z', restorer_pid: process.pid,
      restorer_identity: captureProcessLivenessIdentity(process.pid),
    };
    return state;
  });
  const child = spawn(spec.node_path, [
    spec.supervisor_path, spec.session_dir, `--runner-bin=${spec.runner_bin}`, ...runnerArgs,
  ], { cwd: spec.working_dir, detached: true, stdio: 'ignore' });
  child.unref();
  const owner = child.pid ? captureProcessLivenessIdentity(child.pid) : null;
  assert.ok(owner);
  t.after(() => {
    try { process.kill(-owner.pid, 'SIGKILL'); } catch {
      try { process.kill(owner.pid, 'SIGKILL'); } catch {}
    }
  });
  const deadline = Date.now() + 5_000;
  while (!JSON.parse(fs.readFileSync(statePath, 'utf8')).autonomous_supervisor_ready_receipt
    && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  const exact = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(exact.autonomous_supervisor_ready_receipt,
    `supervisor did not publish its ready receipt: ${fs.existsSync(publishErrorPath) ? fs.readFileSync(publishErrorPath, 'utf8') : 'no error captured'}`);
  assert.deepEqual(authenticatedReadyProcessOwner(
    value.sessionDir, exact, recoveryDaemon, adoptionChallenge,
  ), owner);

  for (const runner_args of [
    ['--label=space', 'value', '--quote="exact value"', ''],
    ['--label=space value', '--quote=exact value', ''],
    ['--label=space value', '--quote="exact value"'],
  ]) {
    const changed = structuredClone(exact);
    const { receipt_id: ignored, ...unsigned } = changed.autonomous_supervisor_ready_receipt;
    void ignored;
    changed.autonomous_supervisor_ready_receipt = {
      ...unsigned, runner_args,
      receipt_id: sha256(JSON.stringify({ ...unsigned, runner_args })),
    };
    assert.equal(authenticatedReadyProcessOwner(
      value.sessionDir, changed, recoveryDaemon, adoptionChallenge,
    ), null);
  }
});

test('post-handoff recovery retires an authenticated legacy lock despite runner PID reuse', (t) => {
  const value = fixture({ runnerPid: process.pid });
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  const lockPath = path.join(value.sessionDir, '.session-operation.lock');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'pid-reuse-rollover';
      return state;
    });
  };
  deps.ensurePostHandoffOwner = () => {
    assert.equal(fs.existsSync(lockPath), false, 'legacy lock must be retired before target owner acceptance');
    return publishAcceptedRecoverySupervisor(statePath, t).pid;
  };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('consumed adoption challenge permits daemon replacement and a future runtime supervisor', (t) => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'consumed-handoff-rollover';
      return state;
    });
  };
  deps.ensurePostHandoffOwner = () => publishAcceptedRecoverySupervisor(statePath, t).pid;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);

  let transferred = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const oldSupervisor = transferred.autonomous_supervisor_identity;
  t.after(() => { try { process.kill(-oldSupervisor.pid, 'SIGKILL'); } catch {} });
  assert.equal(transferred.legacy_adoption_supervisor_challenge, null);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/,
    'post-consumption retry must use the committed proof without rearming the challenge');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).legacy_adoption_supervisor_challenge, null);
  new StateManager().update(statePath, (state) => {
    state.autonomous_budget_consumed_intent_id = state.autonomous_budget_rollover_intent_id;
    state.autonomous_budget_rollover_intent_id = null;
    state.autonomous_owner_restoration = null;
    state.autonomous_owner_recovery_daemon_pid = null;
    state.autonomous_owner_recovery_daemon_identity = null;
    return state;
  });
  assert.equal(adoptionSupervisorProvenanceReady(value.sessionDir), true,
    'consumed adoption epoch must not self-fence the productive supervisor after daemon death');

  const replacementDaemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore', cwd: value.repo,
  });
  replacementDaemon.unref();
  const replacementDaemonIdentity = replacementDaemon.pid
    ? captureProcessLivenessIdentity(replacementDaemon.pid) : null;
  assert.ok(replacementDaemonIdentity);
  t.after(() => { try { process.kill(-replacementDaemonIdentity.pid, 'SIGKILL'); } catch {} });
  new StateManager().update(statePath, (state) => {
    state.autonomous_owner_recovery_daemon_pid = replacementDaemonIdentity.pid;
    state.autonomous_owner_recovery_daemon_identity = replacementDaemonIdentity;
    return state;
  });
  assert.equal(adoptionSupervisorProvenanceReady(value.sessionDir), true,
    'replacement daemon inverse parentage must use the normal post-consumption contract');
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');

  try { process.kill(-oldSupervisor.pid, 'SIGKILL'); } catch {}
  const futureRoot = runtime('future-handoff');
  const futureSpec = deriveAutonomousProcessOwnerSpec(
    value.sessionDir, value.repo, 'mux-runner.js', ['--on-failure=retry'],
    path.join(futureRoot, 'extension', 'bin'),
  );
  const future = spawn(futureSpec.node_path, [
    futureSpec.supervisor_path, futureSpec.session_dir, `--runner-bin=${futureSpec.runner_bin}`,
    ...futureSpec.runner_args,
  ], { cwd: futureSpec.working_dir, detached: true, stdio: 'ignore' });
  future.unref();
  const futureIdentity = future.pid ? captureProcessLivenessIdentity(future.pid) : null;
  assert.ok(futureIdentity);
  t.after(() => { try { process.kill(-futureIdentity.pid, 'SIGKILL'); } catch {} });
  new StateManager().update(statePath, (state) => {
    state.autonomous_owner_spec = futureSpec;
    return state;
  });
  writeRestoredRecoverySupervisor(statePath, futureIdentity);
  transferred = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(authenticatedReadyProcessOwner(value.sessionDir, transferred), futureIdentity);
  assert.equal(adoptionSupervisorProvenanceReady(value.sessionDir), true);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('crash after transfer proof but before challenge consumption remains supervised and resumes consumption', (t) => {
  const value = fixture();
  const deps = depsFor(value);
  const statePath = path.join(value.sessionDir, 'state.json');
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(statePath, (state) => {
      state.autonomous_budget_rollover_intent_id = 'challenge-consumption-crash';
      return state;
    });
  };
  let daemon = null;
  deps.ensurePostHandoffOwner = () => {
    daemon ||= publishAcceptedRecoverySupervisor(statePath, t);
    return daemon.pid;
  };
  deps.afterOwnershipTransferRecorded = () => { throw new Error('crash-before-challenge-consumption'); };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /crash-before-challenge-consumption/);
  assert.equal(typeof JSON.parse(fs.readFileSync(statePath, 'utf8')).legacy_adoption_supervisor_challenge, 'string');
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'running');

  deps.afterOwnershipTransferRecorded = undefined;
  deps.checkpoint = undefined;
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /ownership transferred to the authenticated modern recovery owner/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).legacy_adoption_supervisor_challenge, null);
  assert.equal(legacyAdoptionOutcome(value.sessionDir), 'terminal');
});

test('post-handoff recovery refuses target runtime drift before spawning an owner', () => {
  const value = fixture();
  const deps = depsFor(value);
  let ensureAttempts = 0;
  deps.checkpoint = (checkpoint) => {
    if (checkpoint !== 'quiesced') return;
    new StateManager().update(path.join(value.sessionDir, 'state.json'), (state) => {
      state.autonomous_budget_rollover_intent_id = 'drifted-rollover';
      return state;
    });
    fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// drift before owner\n');
  };
  deps.ensurePostHandoffOwner = () => { ensureAttempts += 1; return null; };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /refuses drifted target runtime ownership/);
  assert.equal(ensureAttempts, 0);
  assert.equal(fs.existsSync(path.join(value.sessionDir, 'installed-runtime-migration.json')), false);
});

test('legacy adoption rejects immutable tmux reuse after controller fencing without killing a child', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  let reused = false;
  const originalBinding = deps.tmuxBinding;
  deps.stopController = () => { actions.push('fence'); reused = true; };
  deps.tmuxBinding = (name) => {
    const binding = originalBinding(name);
    return binding && reused ? { ...binding, session_id: '$99' } : binding;
  };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), /binding changed after controller fencing/);
  assert.deepEqual(actions, ['watchdog', 'fence', 'resume']);
});

test('legacy adoption resumes idempotently from every durable post-fence checkpoint', () => {
  for (const stage of ['fenced', 'candidate_archived', 'quiesced', 'migrated', 'sealed', 'journaled', 'adopted']) {
    const value = fixture();
    const deps = depsFor(value);
    let injected = false;
    deps.checkpoint = (checkpoint) => {
      if (!injected && checkpoint === stage) {
        injected = true;
        throw new Error(`injected-${stage}`);
      }
    };
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), new RegExp(`injected-${stage}`));
    deps.checkpoint = undefined;
    const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
    assert.equal(record.status, 'adopted', stage);
    assert.equal(readLogicalPipeline(value.sessionDir).events.filter((event) => event.kind === 'legacy_session_adopted').length, 1, stage);
  }
});

function strandAdoptionRecordBeforeLaunch(value, record) {
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  writeJson(transactionPath, { ...transaction, stage: 'launching', launch_attempt: undefined,
    launched_runtime_root: undefined, updated_at: '2026-08-08T20:01:00.000Z' });
  const statePath = path.join(value.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  writeJson(statePath, { ...state, active: false });
  return record;
}

function strandAdoptedSessionBeforeLaunch(value, deps) {
  return strandAdoptionRecordBeforeLaunch(value,
    adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps));
}

function preparePostAdoptionReplacement(value, deps, existingSupersession = false) {
  let prior;
  if (existingSupersession) {
    deps.checkpoint = (current) => {
      if (current === 'migrated') throw new Error('pause-initial-migration');
    };
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /pause-initial-migration/);
    fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// first approved replacement\n');
    deps.validationSessionDir = approveTargetRuntime(value.targetRoot);
    deps.checkpoint = undefined;
    prior = strandAdoptionRecordBeforeLaunch(value,
      adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps));
  } else {
    prior = strandAdoptedSessionBeforeLaunch(value, deps);
  }
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// post-adoption replacement\n');
  deps.validationSessionDir = approveTargetRuntime(value.targetRoot);
  return prior;
}

test('stranded adopted launch is rolled back, superseded, and launched from the exact replacement epoch once', () => {
  const value = fixture();
  const deps = depsFor(value);
  const prior = preparePostAdoptionReplacement(value, deps, true);
  const replacement = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.notEqual(replacement.migration_content_hash, prior.migration_content_hash);
  assert.notEqual(replacement.target_runtime.build_hash, prior.target_runtime.build_hash);
  assert.equal(prior.target_runtime_supersessions.length, 1);
  assert.equal(replacement.target_runtime_supersessions.length, 2);
  assert.deepEqual(replacement.target_runtime_supersessions[0], prior.target_runtime_supersessions[0]);
  const state = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.active, true);
  const transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(transaction.stage, 'adopted');
  assert.equal(transaction.post_adoption_repin.status, 'completed');
  assert.equal(transaction.target_runtime_repin.status, 'completed');
  assert.equal(transaction.target_runtime_supersessions.length, 2);
  assert.equal(transaction.superseded_migration_content_hash, prior.migration_content_hash);
  assert.equal(transaction.launch_attempt, undefined);
  const events = readLogicalPipeline(value.sessionDir).events.filter((event) => event.kind === 'legacy_session_adopted');
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).details.migration_content_hash, replacement.migration_content_hash);
  assert.deepEqual(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), replacement);
  let launches = 0;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot,
    exactLaunchDeps(value, () => { launches += 1; }));
  assert.equal(launched.status, 'launched');
  assert.equal(launches, 1);
});

test('post-adoption supersession accepts an ownerless legacy boundary with absent nullable ownership fields', () => {
  const value = fixture();
  const deps = depsFor(value);
  const initialStatePath = path.join(value.sessionDir, 'state.json');
  const initialState = JSON.parse(fs.readFileSync(initialStatePath, 'utf8'));
  Object.assign(initialState, {
    active_child_controller_pid: null,
    active_child_controller_identity: null,
    active_child_identities: [],
    refinement_child_identities: [],
    autonomous_supervisor_pid: null,
    autonomous_supervisor_identity: null,
    autonomous_owner_spec: null,
    autonomous_owner_restoration: null,
    autonomous_owner_handoff_transaction: null,
    autonomous_owner_recovery_daemon_pid: null,
    autonomous_owner_recovery_daemon_identity: null,
    cancellation_recovery_watchdog_pid: null,
    cancellation_recovery_watchdog_identity: null,
    cancellation_recovery_watchdog_arm_id: null,
    cancellation_recovery_watchdog_arm: null,
    cancellation_recovery_runtime_binding: null,
    cancellation_recovery: null,
    recovery_required: false,
    recovery_kind: null,
    recovery_reason: null,
    orphan_child_pid: 0,
    orphan_recovery: null,
    autonomous_owner_recovery_suspended: false,
    autonomous_owner_recovery_suspended_for_handoff: null,
    cancel_requested_at: null,
    cancelled: false,
    manager_relaunch_recovery_epoch: 0,
    manager_relaunch_recovery_route: '',
    manager_relaunch_recovery_status: '',
    manager_relaunch_recovery_activated_at: '',
    manager_relaunch_recovery_consumed_at: '',
    artifact_contract_recovery: null,
    autonomous_budget_rollover_intent_id: '',
    autonomous_budget_rollover_checkpoint_pending: null,
    autonomous_budget_consumed_intent_id: '',
    autonomous_budget_consumed_checkpoint_pending: null,
    autonomous_budget_checkpoint_error: '',
  });
  writeJson(initialStatePath, initialState);
  const prior = preparePostAdoptionReplacement(value, deps);
  const statePath = path.join(value.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.active_child_controller_pid, null);
  assert.equal(state.active_child_controller_identity, null);

  const replacement = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  assert.notEqual(replacement.migration_content_hash, prior.migration_content_hash);
  const transaction = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
  ));
  assert.equal(transaction.stage, 'adopted');
  assert.equal(transaction.post_adoption_repin.status, 'completed');
});

test('initial adoption rejects every modern ownership side ledger before side effects with byte identity', () => {
  for (const [label, evidence] of modernOwnershipEvidenceCases()) {
    const value = fixture();
    const actions = [];
    const deps = depsFor(value, actions);
    const statePath = path.join(value.sessionDir, 'state.json');
    writeJson(statePath, { ...JSON.parse(fs.readFileSync(statePath, 'utf8')), ...evidence });
    const paths = [
      statePath,
      path.join(value.sessionDir, '.session-operation.lock'),
      path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'),
      path.join(value.sessionDir, 'installed-runtime-migration.json'),
      path.join(value.sessionDir, 'logical-pipeline.json'),
      path.join(value.sessionDir, LEGACY_ADOPTION_FILE),
    ];
    const before = byteSnapshot(paths);

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /refuses modern authority, recovery, or cancellation evidence/, label);
    assert.deepEqual(byteSnapshot(paths), before, label);
    assert.deepEqual(actions, [], label);
  }
});

test('post-adoption supersession rejects modern ownership evidence with byte identity', () => {
  const cases = [
    ...modernOwnershipEvidenceCases(),
    ['active-child-identity', { active_child_identity: identity(7010) }],
    ['malformed-controller-identity', { active_child_controller_identity: { pid: 42 } }],
  ];
  for (const [label, evidence] of cases) {
    const value = fixture();
    const deps = depsFor(value);
    pausePreparedPostAdoptionRepin(value, deps);
    const statePath = path.join(value.sessionDir, 'state.json');
    writeJson(statePath, { ...JSON.parse(fs.readFileSync(statePath, 'utf8')), ...evidence });
    const paths = [
      statePath,
      path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'),
      path.join(value.sessionDir, 'installed-runtime-migration.json'),
      path.join(value.sessionDir, 'logical-pipeline.json'),
      path.join(value.sessionDir, LEGACY_ADOPTION_FILE),
    ];
    const before = byteSnapshot(paths);

    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /exact ownerless verification-repair boundary/, label);
    assert.deepEqual(byteSnapshot(paths), before, label);
  }
});

test('post-adoption supersession replays every exact write prefix without duplicating its epoch', () => {
  for (const checkpoint of [
    'post_adoption_repin_prepared', 'post_adoption_repin_journal_applied',
    'post_adoption_repin_journaled', 'post_adoption_repin_migration_applied',
    'post_adoption_repin_migration_written', 'post_adoption_repin_record_applied',
    'post_adoption_repin_record_written', 'post_adoption_repin_completed',
  ]) {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    let injected = false;
    deps.checkpoint = (current) => {
      if (!injected && current === checkpoint) {
        injected = true;
        throw new Error(`crash-${checkpoint}`);
      }
    };
    assert.throws(
      () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      new RegExp(`crash-${checkpoint}`), checkpoint,
    );
    deps.checkpoint = undefined;
    const replacement = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
    assert.equal(adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps).migration_content_hash,
      replacement.migration_content_hash, checkpoint);
    assert.equal(readLogicalPipeline(value.sessionDir).events
      .filter((event) => event.kind === 'legacy_session_adopted').length, 2, checkpoint);
    const transaction = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, 'legacy-session-adoption-transaction.json'), 'utf8',
    ));
    const migration = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'installed-runtime-migration.json'), 'utf8'));
    const latest = readLogicalPipeline(value.sessionDir).events.filter((event) => event.kind === 'legacy_session_adopted').at(-1);
    assert.equal(transaction.post_adoption_repin.status, 'completed', checkpoint);
    assert.equal(transaction.migration_content_hash, replacement.migration_content_hash, checkpoint);
    assert.equal(migration.content_hash, replacement.migration_content_hash, checkpoint);
    assert.equal(latest.details.migration_content_hash, replacement.migration_content_hash, checkpoint);
    let launches = 0;
    const launchDeps = exactLaunchDeps(value, () => { launches += 1; });
    assert.equal(launchAdoptedLegacySession(value.sessionDir, value.targetRoot, launchDeps).status, 'launched', checkpoint);
    assert.equal(launchAdoptedLegacySession(value.sessionDir, value.targetRoot, launchDeps).status, 'launched', checkpoint);
    assert.equal(launches, 1, checkpoint);
  }
});

test('post-adoption supersession rejects forged predecessor evidence and live ownership', () => {
  {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    deps.checkpoint = (current) => {
      if (current === 'post_adoption_repin_prepared') throw new Error('pause-prepared');
    };
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), /pause-prepared/);
    const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    transaction.post_adoption_repin.prior_adoption_record_sha256 = 'a'.repeat(64);
    writeJson(transactionPath, transaction);
    deps.checkpoint = undefined;
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /artifacts do not match an exact recoverable write prefix/);
  }
  {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    const logical = readLogicalPipeline(value.sessionDir);
    acquireSupervisorLease(value.sessionDir, { ownerId: 'intruder', ttlMs: 60_000 });
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /leased logical pipeline|live logical lease/);
    assert.equal(logical.events.filter((event) => event.kind === 'legacy_session_adopted').length, 1);
  }
});

function pausePreparedPostAdoptionRepin(value, deps) {
  preparePostAdoptionReplacement(value, deps);
  deps.checkpoint = (current) => {
    if (current === 'post_adoption_repin_prepared') throw new Error('pause-prepared-evidence');
  };
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /pause-prepared-evidence/);
  deps.checkpoint = undefined;
  return path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
}

test('prepared post-adoption repin reauthenticates external approval, clean head, and every descriptor', () => {
  for (const mutation of ['head', 'dirty', 'approval', 'report', 'embedded', 'descriptor']) {
    const value = fixture();
    const deps = depsFor(value);
    const transactionPath = pausePreparedPostAdoptionRepin(value, deps);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    if (mutation === 'head') {
      fs.appendFileSync(path.join(value.targetRoot, 'install.sh'), '# clean new head\n');
      approveTargetRuntime(value.targetRoot);
    }
    if (mutation === 'dirty') fs.appendFileSync(path.join(value.targetRoot, 'install.sh'), '# dirty\n');
    if (mutation === 'approval') fs.appendFileSync(
      path.join(deps.validationSessionDir, 'citadel-release-approval.json'), ' ',
    );
    if (mutation === 'report') fs.appendFileSync(path.join(deps.validationSessionDir, 'citadel-report.json'), ' ');
    if (mutation === 'embedded') {
      transaction.post_adoption_repin.validation_report.generated_at = 'tampered';
      transaction.post_adoption_repin.validation_report_sha256 = sha256(
        JSON.stringify(transaction.post_adoption_repin.validation_report),
      );
      writeJson(transactionPath, transaction);
    }
    if (mutation === 'descriptor') {
      transaction.post_adoption_repin.replacement_record.target_runtime.version = 'same-build-forgery';
      writeJson(transactionPath, transaction);
    }
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /validation|approval|report|replacement runtime|descriptor|clean replacement checkout/i, mutation);
  }
});

test('post-adoption repin never downgrades missing top-level or nested raw validation hashes', () => {
  {
    const value = fixture();
    const deps = depsFor(value);
    const transactionPath = pausePreparedPostAdoptionRepin(value, deps);
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    delete transaction.post_adoption_repin.validation_approval_file_sha256;
    delete transaction.post_adoption_repin.validation_report_file_sha256;
    writeJson(transactionPath, transaction);
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /validation evidence is incomplete/);
  }
  for (const layer of ['top-level', 'nested']) {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
    const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const evidence = layer === 'top-level'
      ? transaction.post_adoption_repin : transaction.post_adoption_repin.supersession;
    delete evidence.validation_approval_file_sha256;
    delete evidence.validation_report_file_sha256;
    writeJson(transactionPath, transaction);
    assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, exactLaunchDeps(value)),
      /validation evidence is incomplete/, layer);
  }
});

test('journal-applied supersession is not exposed as resume-ready and tampered epochs never advance', () => {
  for (const checkpoint of ['post_adoption_repin_journal_applied', 'post_adoption_repin_migration_written']) {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    deps.checkpoint = (current) => {
      if (current === checkpoint) throw new Error(`pause-${checkpoint}`);
    };
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      new RegExp(`pause-${checkpoint}`));
    deps.checkpoint = undefined;
    const state = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'state.json'), 'utf8'));
    if (checkpoint === 'post_adoption_repin_journal_applied') {
      assert.throws(() => pendingAdoptedVerificationRepairTicket(value.sessionDir, state, true),
        /exact sealed migration checkpoint/);
    }
    const logicalPath = path.join(value.sessionDir, 'logical-pipeline.json');
    const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
    const latest = logical.events.at(-1);
    latest.details.legacy_owner = { ...latest.details.legacy_owner, operation_lock_pid: 999999 };
    const { event_hash: ignored, ...withoutHash } = latest;
    latest.event_hash = sha256(JSON.stringify(stableValue(withoutHash)));
    writeJson(logicalPath, logical);
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /journal|prefix|adoption/i, checkpoint);
  }
});

test('unsafe post-adoption owners and recovery ledgers reject without changing durable artifacts', () => {
  for (const unsafe of ['persisted-owner', 'tmux', 'refinement-ledger', 'launch-owner']) {
    const value = fixture();
    const deps = depsFor(value);
    preparePostAdoptionReplacement(value, deps);
    const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
    const statePath = path.join(value.sessionDir, 'state.json');
    if (unsafe === 'persisted-owner') deps.inspectProcess = () => 'matched';
    if (unsafe === 'tmux') {
      deps.tmuxExists = () => true;
      deps.tmuxBinding = () => ({ session_name: value.tmuxName, session_id: '$7', session_created: '1723147200',
        pane_id: '%11', pane_pid: value.pane.pid, pane_start_command: 'bash' });
    }
    if (unsafe === 'refinement-ledger') {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeJson(statePath, { ...state, refinement_child_identities: [identity(7777)], recovery_required: true });
    }
    if (unsafe === 'launch-owner') {
      const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
      transaction.launch_attempt = { owner_pid: 8888, runtime_root: value.targetRoot };
      writeJson(transactionPath, transaction);
      deps.observeProcess = (pid) => pid === 8888
        ? { identity: identity(pid), parent_pid: 1, command: 'live launch reservation owner' } : null;
    }
    const paths = [statePath, transactionPath, path.join(value.sessionDir, 'installed-runtime-migration.json'),
      path.join(value.sessionDir, 'logical-pipeline.json'), path.join(value.sessionDir, LEGACY_ADOPTION_FILE)];
    const before = paths.map((file) => fs.readFileSync(file, 'utf8'));
    assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
      /live|recovery|historical state|owner|tmux/i, unsafe);
    assert.deepEqual(paths.map((file) => fs.readFileSync(file, 'utf8')), before, unsafe);
  }
});

test('completed supersession cannot bypass its transaction and launched target drift fails before deployment', () => {
  const value = fixture();
  const deps = depsFor(value);
  preparePostAdoptionReplacement(value, deps);
  adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps);
  const transactionPath = path.join(value.sessionDir, 'legacy-session-adoption-transaction.json');
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const stripped = { ...transaction };
  delete stripped.post_adoption_repin;
  writeJson(transactionPath, stripped);
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /mandatory completed repin transaction/);
  const state = JSON.parse(fs.readFileSync(path.join(value.sessionDir, 'state.json'), 'utf8'));
  assert.throws(() => pendingAdoptedVerificationRepairTicket(value.sessionDir, state, true),
    /exact sealed migration checkpoint/);
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, exactLaunchDeps(value)),
    /exact completed launch epoch|journal checkpoint/);

  writeJson(transactionPath, transaction);
  assert.equal(launchAdoptedLegacySession(value.sessionDir, value.targetRoot, exactLaunchDeps(value)).status, 'launched');
  fs.appendFileSync(path.join(value.targetRoot, 'extension', 'bin', 'runtime.js'), '// drift after launch\n');
  approveTargetRuntime(value.targetRoot);
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /authenticated live runtime handoff before deployment/);
});

test('installer stages legacy adoption before replacement and launches only after deployment', () => {
  const installer = fs.readFileSync(path.join(path.resolve(new URL('..', import.meta.url).pathname), '..', 'install.sh'), 'utf8');
  const prepare = installer.indexOf('adopt-legacy-session.js" prepare');
  const deploy = installer.indexOf('rsync -a --delete --delete-excluded');
  const launch = installer.indexOf('adopt-legacy-session.js" launch');
  const descriptor = installer.indexOf('write-runtime-descriptor.js');
  assert.ok(prepare > 0 && deploy > prepare && descriptor > deploy && launch > descriptor);
  assert.match(installer, /--adopt-session/);
});
