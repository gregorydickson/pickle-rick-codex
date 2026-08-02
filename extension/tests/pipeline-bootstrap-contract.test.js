// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempRoot, writeJson } from './helpers.js';
import { readJsonFile } from '../services/pickle-utils.js';
import { refinePrd } from '../bin/spawn-refinement-team.js';
import {
  beginRefinementRepositoryAdvance,
  markRefinementRepositoryAdvanceVerified,
  reconcileVerifiedRefinementRepositoryAdvance,
  refinementRepositoryAdvancePath,
  validateRefinementAcceptance,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { updateTicketStatus, writeTicketFiles } from '../services/tickets.js';
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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeGitWorkingDir(prefix) {
  const workingDir = makeTempRoot(prefix);
  git(workingDir, ['init', '-q']);
  fs.writeFileSync(path.join(workingDir, 'README.md'), '# Fixture\n');
  git(workingDir, ['add', 'README.md']);
  git(workingDir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  return workingDir;
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
    /missing or empty (?:prd\.md|refinement_manifest\.json)/,
  );

  const empty = makeTempRoot('pipeline-bootstrap-empty-');
  const emptyWorkingDir = makeTempRoot('pipeline-bootstrap-empty-working-');
  writeJson(path.join(empty, 'state.json'), runnerState({ working_dir: emptyWorkingDir }));
  fs.writeFileSync(path.join(empty, 'prd.md'), '# Empty refinement\n');
  fs.writeFileSync(path.join(empty, 'prd_refined.md'), '# Empty refined PRD\n');
  writeJson(path.join(empty, 'refinement_manifest.json'), { tickets: [] });
  writeRefinementAcceptance(empty);
  await assert.rejects(
    () => ensureBootstrapSessionReady(empty, { resumeReadyOnly: true }),
    /manifest contains zero tickets/,
  );

  const done = makeTempRoot('pipeline-bootstrap-done-');
  const doneWorkingDir = makeTempRoot('pipeline-bootstrap-done-working-');
  writeJson(path.join(done, 'state.json'), runnerState({ working_dir: doneWorkingDir }));
  fs.writeFileSync(path.join(done, 'prd.md'), '# Completed refinement\n');
  fs.writeFileSync(path.join(done, 'prd_refined.md'), '# Completed refined PRD\n');
  writeJson(path.join(done, 'refinement_manifest.json'), {
    tickets: [{
      id: 'done-ticket',
      title: 'Done ticket',
      description: 'A complete persisted ticket.',
      acceptance_criteria: ['The ticket is complete.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Done',
    }],
  });
  writeRefinementAcceptance(done);
  const completed = await ensureBootstrapSessionReady(done, { resumeReadyOnly: true });
  assert.equal(completed.summary.done, 1);
  assert.equal(completed.summary.runnable.length, 0);
});

test('bootstrap readiness invalidates accepted refinement when the source PRD changes', async () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-stale-refinement-');
  const workingDir = makeTempRoot('pipeline-bootstrap-stale-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({
    working_dir: workingDir,
    step: 'research',
    history: [{ step: 'refine', timestamp: '2026-08-01T00:00:00.000Z' }],
  }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Original PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'ticket-001',
      title: 'Preserve source binding',
      description: 'The accepted refinement is bound to the source PRD content.',
      acceptance_criteria: ['Editing the source PRD invalidates the acceptance receipt.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  writeRefinementAcceptance(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Changed PRD\n');

  await assert.rejects(
    () => ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: true }),
    /prd_sha256 does not match the accepted refinement/,
  );
});

test('bootstrap preserves progressed legacy refinement artifacts instead of silently replacing them', async () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-legacy-progress-');
  const workingDir = makeGitWorkingDir('pipeline-bootstrap-legacy-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({
    working_dir: workingDir,
    step: 'implement',
    current_ticket: 'ticket-001',
  }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Legacy source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Legacy refined PRD\n');
  writeTicketFiles(sessionDir, {
    tickets: [{
      id: 'ticket-001',
      title: 'Preserve legacy progress',
      description: 'Existing execution progress requires explicit operator review.',
      acceptance_criteria: ['Automatic bootstrap does not overwrite unverified progress.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'In Progress',
    }],
  });
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const ticketPath = path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md');
  const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
  const ticketBefore = fs.readFileSync(ticketPath, 'utf8');

  await assert.rejects(
    () => ensureBootstrapSessionReady(sessionDir),
    /Refusing automatic replacement; run explicit PRD refinement/,
  );
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
  assert.equal(fs.readFileSync(ticketPath, 'utf8'), ticketBefore);
  assert.equal(fs.existsSync(path.join(sessionDir, 'refinement-acceptance.json')), false);
});

test('refinement acceptance ignores runtime progress but detects contract mutation', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-progress-acceptance-');
  const workingDir = makeTempRoot('pipeline-bootstrap-progress-working-');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  const manifest = {
    source: 'codex-refinement',
    tickets: [{
      id: 'ticket-001',
      title: 'Preserve plan identity',
      description: 'Runtime evidence does not alter the immutable ticket contract.',
      acceptance_criteria: ['Status updates retain refinement acceptance.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Todo',
    }],
  };
  writeTicketFiles(sessionDir, manifest);
  writeRefinementAcceptance(sessionDir, { workingDir });

  updateTicketStatus(sessionDir, 'ticket-001', {
    status: 'Done',
    completed_at: '2026-08-01T00:00:00.000Z',
    completion_commit: 'abc123',
  });
  assert.equal(validateRefinementAcceptance(sessionDir).ok, true);

  const changed = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  changed.tickets[0].verification = ['node --test changed.test.js'];
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), changed);
  assert.equal(validateRefinementAcceptance(sessionDir).ok, false);
});

test('bootstrap reaccepts a previously accepted manifest after supported alias normalization', async () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-normalized-acceptance-');
  const workingDir = makeTempRoot('pipeline-bootstrap-normalized-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({
    working_dir: workingDir,
    step: 'research',
    history: [{ step: 'refine', timestamp: '2026-08-01T00:00:00.000Z' }],
  }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'Ticket A',
      title: 'Normalize supported aliases',
      description: 'Canonicalization must not invalidate an already accepted plan.',
      acceptance_criteria: ['The normalized manifest retains a valid acceptance receipt.'],
      verification: ['test -f README.md'],
      allowedPaths: ['./README.md'],
      priority: 'P1',
      status: 'Done',
    }],
  });
  writeRefinementAcceptance(sessionDir);
  const receiptBeforeNormalization = fs.readFileSync(
    path.join(sessionDir, 'refinement-acceptance.json'),
    'utf8',
  );

  const recovered = await ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: true });
  assert.equal(recovered.summary.done, 1);
  assert.equal(validateRefinementAcceptance(sessionDir).ok, true);
  const normalized = readJsonFile(path.join(sessionDir, 'refinement_manifest.json'));
  assert.equal(normalized.tickets[0].id, 'ticket-a');
  assert.deepEqual(normalized.tickets[0].allowed_paths, ['README.md']);
  assert.equal('allowedPaths' in normalized.tickets[0], false);
  assert.equal(
    fs.readFileSync(path.join(sessionDir, 'refinement-acceptance.json'), 'utf8'),
    receiptBeforeNormalization,
  );
});

test('refinement acceptance binds supported semantic boolean aliases', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-semantic-aliases-');
  const workingDir = makeTempRoot('pipeline-bootstrap-semantic-working-');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = {
    tickets: [{
      id: 'semantic-alias-ticket',
      title: 'Bind semantic aliases',
      description: 'Supported aliases participate in the immutable plan contract.',
      acceptance_criteria: ['Changing a semantic alias invalidates acceptance.'],
      verification: ['npm test'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Todo',
      formatterTicket: true,
      contractDecision: true,
    }],
  };
  writeJson(manifestPath, manifest);
  writeRefinementAcceptance(sessionDir, { workingDir });

  manifest.tickets[0].formatterTicket = false;
  writeJson(manifestPath, manifest);
  assert.equal(validateRefinementAcceptance(sessionDir).ok, false);

  manifest.tickets[0].formatterTicket = true;
  writeJson(manifestPath, manifest);
  writeRefinementAcceptance(sessionDir, { workingDir });
  manifest.tickets[0].contractDecision = false;
  writeJson(manifestPath, manifest);
  assert.equal(validateRefinementAcceptance(sessionDir).ok, false);
});

test('bootstrap auto-commits and accepts an exact verified dirty ticket after controller loss', async () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-verified-recovery-');
  const workingDir = makeGitWorkingDir('pipeline-bootstrap-verified-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({ working_dir: workingDir }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeTicketFiles(sessionDir, {
    source: 'codex-refinement',
    tickets: [{
      id: 'ticket-001',
      title: 'Recover verified work',
      description: 'Verified ticket work survives a controller crash.',
      acceptance_criteria: ['The exact verified tree is committed and accepted.'],
      verification: ['test -f README.md'],
      allowed_paths: ['feature.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  writeRefinementAcceptance(sessionDir, { workingDir });
  updateTicketStatus(sessionDir, 'ticket-001', { status: 'In Progress' });
  beginRefinementRepositoryAdvance({
    sessionDir,
    workingDir,
    ticketId: 'ticket-001',
    requiresCleanCommit: true,
  });
  fs.writeFileSync(path.join(workingDir, 'feature.txt'), 'verified work\n');
  markRefinementRepositoryAdvanceVerified({
    sessionDir,
    workingDir,
    ticketId: 'ticket-001',
    changedPaths: ['feature.txt'],
  });
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    ...readJsonFile(statePath),
    recovery_required: true,
    recovery_kind: 'ticket_repository',
    recovery_reason: 'controller lost after verification',
    last_exit_reason: 'recovery_required',
  });

  const recovered = await ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: true });
  assert.equal(recovered.summary.done, 1);
  const manifest = readJsonFile(path.join(sessionDir, 'refinement_manifest.json'));
  assert.equal(manifest.tickets[0].status, 'Done');
  assert.equal(git(workingDir, ['status', '--porcelain']), '');
  assert.equal(git(workingDir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)']), 'ticket-001');
  assert.equal(validateRefinementAcceptance(sessionDir, { workingDir, verifyRepository: true }).ok, true);
  assert.equal(fs.existsSync(refinementRepositoryAdvancePath(sessionDir)), false);
  const recoveredState = readJsonFile(statePath);
  assert.equal(recoveredState.recovery_required, false);
  assert.equal(recoveredState.recovery_kind, null);
  assert.equal(recoveredState.recovery_reason, null);
  assert.equal(recoveredState.last_exit_reason, null);
});

test('refinement rejects a session control plane nested inside its worker repository', () => {
  const workingDir = makeGitWorkingDir('pipeline-bootstrap-nested-working-');
  const sessionDir = path.join(workingDir, '.pickle-session');
  fs.mkdirSync(sessionDir);
  writeJson(path.join(sessionDir, 'state.json'), runnerState({ working_dir: workingDir }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeTicketFiles(sessionDir, {
    tickets: [{
      id: 'ticket-001',
      title: 'Reject nested control state',
      description: 'Worker write access cannot include controller trust artifacts.',
      acceptance_criteria: ['The session control plane remains outside the worker repository.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Todo',
    }],
  });

  assert.throws(
    () => writeRefinementAcceptance(sessionDir, { workingDir }),
    /Cannot accept refinement before every canonical artifact exists/,
  );
  assert.equal(fs.existsSync(path.join(sessionDir, 'refinement-acceptance.json')), false);
  assert.equal(fs.existsSync(refinementRepositoryAdvancePath(sessionDir)), false);
  assert.equal(readJsonFile(path.join(sessionDir, 'refinement_manifest.json')).tickets[0].status, 'Todo');
});

test('direct-mode verified dirty work is restored for retry instead of promoted', () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-direct-recovery-');
  const workingDir = makeGitWorkingDir('pipeline-bootstrap-direct-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({ working_dir: workingDir }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeTicketFiles(sessionDir, {
    tickets: [{
      id: 'ticket-001',
      title: 'Reject uncommitted direct work',
      description: 'Direct mode retains the live completion-evidence policy.',
      acceptance_criteria: ['Uncommitted mutations are restored, not marked Done.'],
      verification: ['test -f README.md'],
      allowed_paths: ['feature.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  writeRefinementAcceptance(sessionDir, { workingDir });
  updateTicketStatus(sessionDir, 'ticket-001', { status: 'In Progress' });
  beginRefinementRepositoryAdvance({
    sessionDir,
    workingDir,
    ticketId: 'ticket-001',
    requiresCleanCommit: false,
  });
  fs.writeFileSync(path.join(workingDir, 'feature.txt'), 'uncommitted direct work\n');
  markRefinementRepositoryAdvanceVerified({
    sessionDir,
    workingDir,
    ticketId: 'ticket-001',
    changedPaths: ['feature.txt'],
  });

  assert.deepEqual(
    reconcileVerifiedRefinementRepositoryAdvance(sessionDir, workingDir),
    { reconciled: true, ticketId: 'ticket-001' },
  );
  const manifest = readJsonFile(path.join(sessionDir, 'refinement_manifest.json'));
  assert.equal(manifest.tickets[0].status, 'Todo');
  assert.equal(fs.existsSync(path.join(workingDir, 'feature.txt')), false);
  assert.equal(validateRefinementAcceptance(sessionDir, { workingDir, verifyRepository: true }).ok, true);
});

test('verified single self-commit is attributed, while ambiguous multi-commit work is restored', () => {
  for (const commitCount of [1, 2]) {
    const sessionDir = makeTempRoot(`pipeline-bootstrap-self-commit-${commitCount}-`);
    const workingDir = makeGitWorkingDir(`pipeline-bootstrap-self-working-${commitCount}-`);
    const baselineHead = git(workingDir, ['rev-parse', 'HEAD']);
    writeJson(path.join(sessionDir, 'state.json'), runnerState({ working_dir: workingDir }));
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
    writeTicketFiles(sessionDir, {
      tickets: [{
        id: 'ticket-001',
        title: 'Recover self-committed work',
        description: 'Only unambiguous verified commits are attributed during recovery.',
        acceptance_criteria: ['Ambiguous commit history is restored for retry.'],
        verification: ['test -f README.md'],
        allowed_paths: ['feature-1.txt', 'feature-2.txt'],
        priority: 'P1',
        status: 'Todo',
      }],
    });
    writeRefinementAcceptance(sessionDir, { workingDir });
    updateTicketStatus(sessionDir, 'ticket-001', { status: 'In Progress' });
    beginRefinementRepositoryAdvance({
      sessionDir,
      workingDir,
      ticketId: 'ticket-001',
      requiresCleanCommit: true,
    });
    const changedPaths = [];
    for (let index = 1; index <= commitCount; index += 1) {
      const fileName = `feature-${index}.txt`;
      changedPaths.push(fileName);
      fs.writeFileSync(path.join(workingDir, fileName), `commit ${index}\n`);
      git(workingDir, ['add', fileName]);
      git(workingDir, ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', `worker ${index}`]);
    }
    markRefinementRepositoryAdvanceVerified({
      sessionDir,
      workingDir,
      ticketId: 'ticket-001',
      changedPaths,
    });

    assert.equal(reconcileVerifiedRefinementRepositoryAdvance(sessionDir, workingDir).reconciled, true);
    const manifest = readJsonFile(path.join(sessionDir, 'refinement_manifest.json'));
    if (commitCount === 1) {
      assert.equal(manifest.tickets[0].status, 'Done');
      assert.equal(git(workingDir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)']), 'ticket-001');
    } else {
      assert.equal(manifest.tickets[0].status, 'Todo');
      assert.equal(git(workingDir, ['rev-parse', 'HEAD']), baselineHead);
    }
  }
});

test('refinement refuses to erase an unreconciled repository advance', async () => {
  const sessionDir = makeTempRoot('pipeline-bootstrap-refine-advance-');
  const workingDir = makeGitWorkingDir('pipeline-bootstrap-refine-working-');
  writeJson(path.join(sessionDir, 'state.json'), runnerState({ working_dir: workingDir }));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Source PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n');
  writeTicketFiles(sessionDir, {
    tickets: [{
      id: 'ticket-001',
      title: 'Preserve recovery journal',
      description: 'Re-refinement cannot erase live ticket ownership.',
      acceptance_criteria: ['The journal remains until recovery succeeds.'],
      verification: ['test -f README.md'],
      allowed_paths: ['feature.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  writeRefinementAcceptance(sessionDir, { workingDir });
  updateTicketStatus(sessionDir, 'ticket-001', { status: 'In Progress' });
  beginRefinementRepositoryAdvance({
    sessionDir,
    workingDir,
    ticketId: 'ticket-001',
    requiresCleanCommit: true,
  });
  fs.writeFileSync(path.join(workingDir, 'feature.txt'), 'interrupted work\n');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Changed source PRD\n');

  await assert.rejects(() => refinePrd(sessionDir), /Cannot reconcile repository advance: prd_sha256/);
  assert.equal(fs.existsSync(refinementRepositoryAdvancePath(sessionDir)), true);
  assert.equal(fs.existsSync(path.join(workingDir, 'feature.txt')), true);
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
