// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_FILE,
  adoptActiveLegacyMuxSession,
  legacyContractRepairPending,
  launchAdoptedLegacySession,
  markLegacyContractRepairComplete,
} from '../services/legacy-session-adoption.js';
import { beginAutonomousExecution, createLogicalPipeline, readLogicalPipeline } from '../services/durable-supervisor.js';
import { writePrdSeal } from '../services/prd-seal.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runtime(label) {
  const root = makeTempRoot(`pickle-runtime-${label}-`);
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  writeJson(path.join(root, 'extension', 'package.json'), { name: 'pickle-rick-codex-extension', version: '0.2.17-beta.3' });
  writeJson(path.join(root, 'extension', 'state-schema.json'), { schema_version: 1 });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'runtime.ts'), `export const build = ${JSON.stringify(label)};\n`);
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
  const runner = identity(4100);
  const pane = identity(4200);
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
  return { repo, sessionDir, runner, pane, child, tmuxName, sourceRoot: runtime('source'), targetRoot: runtime('target') };
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

function depsFor(value, actions = []) {
  let tmuxLive = true;
  const canonicalSession = fs.realpathSync(value.sessionDir);
  const observations = new Map([
    [value.runner.pid, { identity: value.runner, command: `node /runtime/bin/mux-runner.js ${canonicalSession}` }],
    [value.pane.pid, { identity: value.pane, command: `bash -lc node /runtime/bin/mux-runner.js ${canonicalSession}` }],
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
    killTmux: () => { actions.push('tmux'); tmuxLive = false; },
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

  assert.deepEqual(actions, ['child', 'tmux']);
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
  assert.equal(launches, 1);
  assert.throws(() => launchAdoptedLegacySession(value.sessionDir, value.targetRoot, { launch: () => { launches += 1; } }), /already been launched/);
  assert.equal(launches, 1);
});

test('legacy adoption fails closed before signaling on owner identity mismatch', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  deps.observeProcess = () => ({ identity: value.runner, command: 'node unrelated.js' });
  assert.throws(() => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps), /identity or command/);
  assert.deepEqual(actions, []);
  assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_FILE)), false);
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
  fs.appendFileSync(path.join(hashValue.targetRoot, 'extension', 'src', 'runtime.ts'), '// drift\n');
  assert.throws(() => launchAdoptedLegacySession(hashValue.sessionDir, hashValue.targetRoot, { launch: () => assert.fail('must not launch') }), /runtime hash/);

  const refValue = fixture();
  adoptActiveLegacyMuxSession(refValue.sessionDir, refValue.sourceRoot, refValue.targetRoot, depsFor(refValue));
  git(refValue.repo, ['update-ref', '-d', `refs/pickle/salvage/${path.basename(refValue.sessionDir)}`]);
  assert.throws(() => launchAdoptedLegacySession(refValue.sessionDir, refValue.targetRoot, { launch: () => assert.fail('must not launch') }), /lost salvage refs/);
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
