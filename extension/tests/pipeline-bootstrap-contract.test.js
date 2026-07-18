// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import { readJsonFile } from '../services/pickle-utils.js';
import {
  assertBootstrapSessionNotRunning,
  copyPrdIntoSession,
  createBootstrapSession,
  ensureBootstrapSessionReady,
  enterMuxRunnerPhase,
  exitMuxRunnerPhase,
  firstMarkdownHeading,
  isProcessAlive,
  recordBootstrapPreflightBlocked,
  resolveBootstrapResumeSessionDir,
  resumeBootstrapSession,
  writeTaskPrdIntoSession,
} from '../services/pipeline-bootstrap.js';

function managerFor(initialState) {
  const manager = {
    state: structuredClone(initialState),
    update(_statePath, mutator) {
      this.state = mutator(this.state) ?? this.state;
      return this.state;
    },
  };
  return manager;
}

function runnerState(overrides = {}) {
  return {
    active: false,
    current_ticket: 'ticket-008',
    history: [],
    last_exit_reason: null,
    tmux_runner_pid: null,
    worker_pid: null,
    active_child_pid: null,
    active_child_kind: null,
    active_child_command: null,
    ...overrides,
  };
}

test('bootstrap heading and PRD materialization preserve the public task contract', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-prd-');
  const source = path.join(makeTempRoot('pipeline-bootstrap-source-'), 'source.md');
  fs.writeFileSync(source, '# Source title\n\nSource body\n');

  assert.equal(firstMarkdownHeading('intro\n# Selected title\n', 'fallback'), 'Selected title');
  assert.equal(firstMarkdownHeading('no heading', ' fallback '), 'fallback');
  assert.equal(copyPrdIntoSession(sessionDir, source), path.join(sessionDir, 'prd.md'));
  assert.equal(fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf8'), '# Source title\n\nSource body\n');

  const destination = writeTaskPrdIntoSession(sessionDir, '  # Task title\n\nShip the feature.  ');
  assert.equal(destination, path.join(sessionDir, 'prd.md'));
  assert.equal(
    fs.readFileSync(destination, 'utf8'),
    '# Task title\n\n## Summary\n# Task title\n\nShip the feature.\n',
  );
  assert.throws(() => writeTaskPrdIntoSession(sessionDir, '  \n  '), /Task prompt is required/);
});

test('bootstrap resume and process guards reject an already-running session', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-running-');
  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    history: [],
    tmux_runner_pid: process.pid,
  });

  assert.equal(resolveBootstrapResumeSessionDir(null), null);
  assert.equal(resolveBootstrapResumeSessionDir('/tmp/explicit-session'), '/tmp/explicit-session');
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(999_999_999), false);
  assert.doesNotThrow(() => assertBootstrapSessionNotRunning(null));
  assert.throws(
    () => assertBootstrapSessionNotRunning(sessionDir),
    new RegExp(`Session is already running under tmux runner pid ${process.pid}`),
  );
});

test('bootstrap creation validates its source before setup', async () => {
  await assert.rejects(() => createBootstrapSession(), /A PRD path or task prompt is required/);
  await assert.rejects(
    () => createBootstrapSession({ prdPath: '/tmp/a.md', taskPrompt: 'duplicate source' }),
    /either a PRD or a task prompt, not both/,
  );
  await assert.rejects(
    () => createBootstrapSession({ prdPath: '/tmp/pipeline-bootstrap-missing-prd.md' }),
    /PRD file not found/,
  );
});

test('task bootstrap creation and explicit resume materialize local session state', async () => {
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  const dataRoot = makeTempRoot('pipeline-bootstrap-data-');
  const workingDir = makeTempRoot('pipeline-bootstrap-working-');
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const sessionDir = await createBootstrapSession({
      taskPrompt: 'Ship deterministic bootstrap coverage',
      maxTime: '7',
      workerTimeout: '11',
      cwd: workingDir,
    });
    const created = readJsonFile(path.join(sessionDir, 'state.json'));
    assert.equal(created.working_dir, fs.realpathSync(workingDir));
    assert.equal(created.tmux_mode, true);
    assert.equal(created.active, false);
    assert.equal(created.max_iterations, 0);
    assert.equal(created.command_template, null);
    assert.equal(created.step, 'refine');
    assert.equal(created.history.at(-1).step, 'tmux_bootstrap');
    assert.match(fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf8'), /Ship deterministic bootstrap coverage/);

    const resumedDir = await resumeBootstrapSession({
      resume: sessionDir,
      maxTime: '9',
      workerTimeout: '13',
      cwd: workingDir,
    });
    const resumed = readJsonFile(path.join(resumedDir, 'state.json'));
    assert.equal(resumedDir, sessionDir);
    assert.equal(resumed.tmux_mode, true);
    assert.equal(resumed.active, false);
    assert.equal(resumed.max_iterations, 0);
    assert.equal(resumed.command_template, null);
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
  }
});

test('bootstrap readiness fails closed for incomplete or unrunnable sessions', async () => {
  const missingState = makeTempRoot('pipeline-bootstrap-no-state-');
  await assert.rejects(() => ensureBootstrapSessionReady(missingState), /missing state\.json/);

  const missingPrd = makeTempRoot('pipeline-bootstrap-no-prd-');
  writeJson(path.join(missingPrd, 'state.json'), runnerState({ working_dir: missingPrd }));
  await assert.rejects(() => ensureBootstrapSessionReady(missingPrd), /missing .*prd\.md/);
  await assert.rejects(
    () => ensureBootstrapSessionReady(missingPrd, { resumeReadyOnly: true }),
    /missing .*refinement_manifest\.json/,
  );

  const empty = makeTempRoot('pipeline-bootstrap-empty-');
  writeJson(path.join(empty, 'state.json'), runnerState({ working_dir: empty }));
  fs.writeFileSync(path.join(empty, 'prd.md'), '# Empty refinement\n');
  writeJson(path.join(empty, 'refinement_manifest.json'), { tickets: [] });
  await assert.rejects(() => ensureBootstrapSessionReady(empty), /refinement produced zero tickets/);

  const done = makeTempRoot('pipeline-bootstrap-done-');
  writeJson(path.join(done, 'state.json'), runnerState({ working_dir: done }));
  fs.writeFileSync(path.join(done, 'prd.md'), '# Completed refinement\n');
  writeJson(path.join(done, 'refinement_manifest.json'), {
    tickets: [{ id: 'done-ticket', title: 'Done ticket', status: 'Done' }],
  });
  await assert.rejects(() => ensureBootstrapSessionReady(done), /Session has no runnable tickets/);
});

test('recordBootstrapPreflightBlocked clears ownership and persists the failure reason', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-blocked-');
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, runnerState({
    active: true,
    tmux_runner_pid: 11,
    active_child_pid: 22,
    active_child_kind: 'codex',
    active_child_command: 'codex exec',
  }));

  recordBootstrapPreflightBlocked(sessionDir, {
    kind: 'preflight-environment-missing',
    message: 'required environment is missing',
  });

  const state = readJsonFile(statePath);
  assert.equal(state.active, false);
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.active_child_pid, null);
  assert.equal(state.active_child_kind, null);
  assert.equal(state.active_child_command, null);
  assert.equal(state.current_ticket, 'ticket-008');
  assert.equal(state.step, 'blocked');
  assert.equal(state.last_exit_reason, 'preflight-environment-missing');
  assert.equal(state.history.at(-1).step, 'preflight-environment-missing');
});

test('enterMuxRunnerPhase establishes fresh runner ownership and invokes the run-start hook', () => {
  const manager = managerFor(runnerState({
    last_exit_reason: 'cancelled',
    cancel_requested_at: '2026-07-18T00:00:00.000Z',
    active_child_pid: 22,
    active_child_kind: 'codex',
    active_child_command: 'codex exec',
    worker_pid: 33,
  }));

  const state = enterMuxRunnerPhase(manager, '/tmp/state.json', {
    runnerPid: 808,
    markRunStart(current) {
      current.run_started = true;
    },
  });

  assert.equal(state.active, true);
  assert.equal(state.tmux_runner_pid, 808);
  assert.equal(state.last_exit_reason, null);
  assert.equal(state.cancel_requested_at, null);
  assert.equal(state.active_child_pid, null);
  assert.equal(state.active_child_kind, null);
  assert.equal(state.active_child_command, null);
  assert.equal(state.worker_pid, null);
  assert.equal(state.run_started, true);
  assert.equal(state.history.at(-1).step, 'runner_start');
});

test('exitMuxRunnerPhase maps success, errors, contract blocks, pauses, and deferred exits', () => {
  const success = managerFor(runnerState({ active: true }));
  assert.equal(
    exitMuxRunnerPhase(success, '/tmp/success-state.json', { exitReason: 'success' }),
    'success',
  );
  assert.equal(success.state.active, false);
  assert.equal(success.state.current_ticket, null);
  assert.equal(success.state.step, 'complete');
  assert.equal(success.state.history.at(-1).step, 'complete');

  const failed = managerFor(runnerState({ active: true }));
  assert.equal(
    exitMuxRunnerPhase(failed, '/tmp/failed-state.json', {
      exitReason: 'error',
      failedTicketId: 'ticket-failed',
    }),
    'error',
  );
  assert.equal(failed.state.current_ticket, 'ticket-failed');
  assert.equal(failed.state.step, 'paused');
  assert.equal(failed.state.history.at(-1).step, 'failed');

  const blocked = managerFor(runnerState({ active: true }));
  exitMuxRunnerPhase(blocked, '/tmp/blocked-state.json', {
    exitReason: 'verification-contract-failed',
  });
  assert.equal(blocked.state.current_ticket, 'ticket-008');
  assert.equal(blocked.state.step, 'blocked');
  assert.equal(blocked.state.history.at(-1).step, 'verification-contract-failed');

  const paused = managerFor(runnerState({ active: true }));
  exitMuxRunnerPhase(paused, '/tmp/paused-state.json', { exitReason: 'cancelled' });
  assert.equal(paused.state.current_ticket, null);
  assert.equal(paused.state.step, 'paused');
  assert.equal(paused.state.history.at(-1).step, 'cancelled');

  const deferred = managerFor(runnerState({ active: true, last_exit_reason: 'existing-abnormal' }));
  assert.equal(
    exitMuxRunnerPhase(deferred, '/tmp/deferred-state.json', {
      exitReason: 'success',
      deferTerminalState: true,
    }),
    'existing-abnormal',
  );
  assert.equal(deferred.state.active, false);
  assert.equal(deferred.state.last_exit_reason, 'existing-abnormal');
  assert.equal(deferred.state.step, undefined);
});
