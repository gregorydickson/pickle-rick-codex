// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
import { restoreRejectedCandidateCheckpoint } from '../services/candidate-recovery.js';
import { chooseLegacyLaunchRuntime } from '../bin/adopt-legacy-session.js';
import { describeInstalledRuntime, runtimeBuildHash } from '../services/runtime-descriptor.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

test('legacy adoption rejects a mux runner that is merely a sibling of the exact supervisor', () => {
  const value = fixture();
  const actions = [];
  const deps = depsFor(value, actions);
  const observe = deps.observeProcess;
  deps.observeProcess = (pid) => {
    const observed = observe(pid);
    return pid === value.runner.pid ? { ...observed, parent_pid: value.pane.pid } : observed;
  };
  assert.throws(
    () => adoptActiveLegacyMuxSession(value.sessionDir, value.sourceRoot, value.targetRoot, deps),
    /not owned by the exact tmux pane supervisor chain/,
  );
  assert.deepEqual(actions, []);
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
    /not owned by the exact tmux pane supervisor chain/,
  );
  assert.deepEqual(actions, []);
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
