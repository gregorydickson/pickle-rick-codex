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
  legacyContractRepairPending,
  launchAdoptedLegacySession,
  markLegacyContractRepairComplete,
} from '../services/legacy-session-adoption.js';
import { beginAutonomousExecution, createLogicalPipeline, readLogicalPipeline } from '../services/durable-supervisor.js';
import { readPrdSeal, writePrdSeal } from '../services/prd-seal.js';
import { ensureSessionPrdSeal } from '../services/session-prd-seal.js';
import {
  beginRefinementRepositoryAdvance,
  reconcileArchivedCandidateRefinementBoundary,
  refinementRepositoryIdentity,
  validateRefinementAcceptance,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { ensureBootstrapSessionReady } from '../services/pipeline-bootstrap.js';
import { checkReadiness } from '../services/readiness.js';
import { readVerificationBaselines } from '../services/pipeline-state.js';
import { assertTicketVerificationBoundToSeal } from '../services/verification-seal-contract.js';
import { readManifest, updateTicketStatus } from '../services/tickets.js';
import { restoreRejectedCandidateCheckpoint } from '../services/candidate-recovery.js';
import { chooseLegacyLaunchRuntime } from '../bin/adopt-legacy-session.js';
import { runSequential } from '../bin/mux-runner.js';
import { describeInstalledRuntime, runtimeBuildHash } from '../services/runtime-descriptor.js';
import { getWorkingTreeContentFingerprint, listUntrackedFiles } from '../services/git-utils.js';
import { prepareLiveSessionMigration } from '../services/live-session-migration.js';
import { persistCitadelReleaseApproval } from '../services/citadel.js';

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
  fs.writeFileSync(path.join(root, 'install.sh'), `#!/bin/sh\n# ${label}\n`);
  writeJson(path.join(root, 'package.json'), { name: 'pickle-rick-codex', version: '0.2.17-beta.3' });
  writeJson(path.join(root, 'extension', 'package.json'), { name: 'pickle-rick-codex-extension', version: '0.2.17-beta.3' });
  writeJson(path.join(root, 'extension', 'state-schema.json'), { schema_version: 1 });
  return root;
}

function identity(pid) {
  return { pid, pgid: pid, start_time: `start-${pid}`, fingerprint: `fingerprint-${pid}` };
}

function fixture() {
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
  const runner = identity(51980);
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

test('legacy mux adoption preserves durable evidence, journals explicit adoption, and launches one supervised mux', () => {
  const value = fixture();
  const actions = [];
  const refusal = fs.readFileSync(path.join(value.sessionDir, 'worker-lifecycle-refusals', 'r1', '0001-review.json'), 'utf8');
  const recovery = fs.readFileSync(path.join(value.sessionDir, 'ticket-recovery-history.json'), 'utf8');
  const record = adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, depsFor(value, actions));

  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'tmux:$7', 'resume']);
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
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), true);
  markLegacyContractRepairComplete(value.sessionDir);
  assert.equal(legacyContractRepairPending(value.sessionDir, 'r1'), false);

  let launches = 0;
  const launched = launchAdoptedLegacySession(value.sessionDir, value.targetRoot, {
    launch: () => { launches += 1; }, now: () => new Date('2026-08-08T20:01:00.000Z'),
  });
  assert.equal(launched.status, 'launched');
  assert.equal(launched.launched_runtime_root, fs.realpathSync(value.targetRoot));
  assert.equal(launches, 1);
  launchAdoptedLegacySession(value.sessionDir, value.targetRoot, { launch: () => { launches += 1; } });
  assert.equal(launches, 1);
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

    let launches = 0;
    launchAdoptedLegacySession(value.sessionDir, value.targetRoot, { launch: () => { launches += 1; } });
    assert.equal(launches, 1);
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
  const record = launchAdoptedLegacySession(value.sessionDir, selected.runtimeRoot, {
    launch: (_sessionDir, root) => { launchedRoot = root; },
  });
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
  const fallback = launchAdoptedLegacySession(value.sessionDir, selected.runtimeRoot, { launch: () => undefined });
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
  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'tmux:$7', 'resume']);
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
  assert.deepEqual(actions, ['watchdog', 'fence']);
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
  assert.deepEqual(actions, ['watchdog', 'fence']);
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

test('migrated adoption verifies old evidence before target repin and resumes after supersession crash', () => {
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
  assert.deepEqual(actions, ['watchdog', 'fence', `child:${replacement.pid}`, 'tmux:$7', 'resume']);
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
  assert.deepEqual(actions, ['watchdog', 'fence', 'child', 'final-mutation', 'tmux:$7', 'resume']);
  assert.equal(git(value.repo, ['status', '--porcelain']), '');
  restoreRejectedCandidateCheckpoint({ sessionDir: value.sessionDir, workingDir: value.repo, ticketId: 'r1',
    expectedBaseHead: git(value.repo, ['rev-parse', 'HEAD']), validateScope: () => undefined });
  assert.equal(fs.readFileSync(path.join(value.repo, 'tracked.txt'), 'utf8'), 'base\nlast-worker-write\n');
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
  assert.deepEqual(actions, ['watchdog', 'fence']);
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

test('installer stages legacy adoption before replacement and launches only after deployment', () => {
  const installer = fs.readFileSync(path.join(path.resolve(new URL('..', import.meta.url).pathname), '..', 'install.sh'), 'utf8');
  const prepare = installer.indexOf('adopt-legacy-session.js" prepare');
  const deploy = installer.indexOf('rsync -a --delete --delete-excluded');
  const launch = installer.indexOf('adopt-legacy-session.js" launch');
  const descriptor = installer.indexOf('write-runtime-descriptor.js');
  assert.ok(prepare > 0 && deploy > prepare && descriptor > deploy && launch > descriptor);
  assert.match(installer, /--adopt-session/);
});
