// @tier: integration
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readLogicalPipeline } from '../services/durable-supervisor.js';
import { captureProcessLivenessIdentity, inspectProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { killTmuxSessionById, runTmux, tmuxSessionExists } from '../services/tmux.js';
import {
  acceptTestRefinement,
  createFakeCodex,
  makeTempRoot,
  prependPath,
  repoRoot,
  runNode,
  waitFor,
  writeJson,
} from './helpers.js';

function git(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeRepository(repoDir) {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.name', 'Pickle Rick Tests']);
  git(repoDir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  git(repoDir, ['add', 'feature.txt', 'package.json']);
  git(repoDir, ['commit', '-m', 'base']);
}

function tail(filePath, lines = 40) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '<missing>';
  }
}

function fakeCodexEventSummary(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).slice(-30).map((line) => {
      const event = JSON.parse(line);
      const prompt = String(event.prompt || '');
      return {
        pid: event.pid,
        invocation_nonce: event.invocation_nonce,
        cwd: event.cwd,
        phase: prompt.match(/You are executing the "([^"]+)" phase/)?.[1]
          || 'unknown',
        ticket: prompt.match(/phase for ticket ([^:]+):/)?.[1] || null,
      };
    });
  } catch {
    return [];
  }
}

function ownerRecoveryDiagnostics(sessionDir, state, logical, env, fakeCodexLogPath = '') {
  const supervisorIdentity = state?.autonomous_supervisor_identity || null;
  const daemonIdentity = state?.autonomous_owner_recovery_daemon_identity || null;
  const restorerIdentity = state?.autonomous_owner_restoration?.restorer_identity || null;
  const childIdentity = state?.active_child_identity || null;
  const tmuxRunnerIdentity = Number(state?.tmux_runner_pid) > 0
    ? captureProcessLivenessIdentity(Number(state.tmux_runner_pid)) : null;
  let tmux = '<unavailable>';
  try {
    tmux = state?.tmux_session_name
      ? runTmux(['list-panes', '-t', state.tmux_session_name, '-F', '#{pane_pid} #{pane_dead} #{pane_current_command} #{pane_start_command}'], { env })
      : '<session name not persisted>';
  } catch (error) {
    tmux = `<error: ${error instanceof Error ? error.message : String(error)}>`;
  }
  return JSON.stringify({
    state: {
      active: state?.active,
      step: state?.step,
      iteration: state?.iteration,
      current_ticket: state?.current_ticket,
      last_exit_reason: state?.last_exit_reason,
      recovery_required: state?.recovery_required,
      recovery_reason: state?.recovery_reason,
      autonomous_budget_epoch: state?.autonomous_budget_epoch,
      autonomous_budget_rollover_intent_id: state?.autonomous_budget_rollover_intent_id,
      autonomous_budget_consumed_intent_id: state?.autonomous_budget_consumed_intent_id,
      autonomous_budget_consumed_epoch: state?.autonomous_budget_consumed_epoch,
      autonomous_budget_rollover_checkpoint_pending: state?.autonomous_budget_rollover_checkpoint_pending,
      autonomous_budget_consumed_checkpoint_pending: state?.autonomous_budget_consumed_checkpoint_pending,
      autonomous_budget_checkpoint_error: state?.autonomous_budget_checkpoint_error,
      autonomous_relaunch_not_before: state?.autonomous_relaunch_not_before,
      autonomous_relaunch_deadline: state?.autonomous_relaunch_deadline,
      autonomous_owner_spec_id: state?.autonomous_owner_spec?.spec_id,
      autonomous_owner_command: state?.autonomous_owner_spec?.pane_start_command,
      autonomous_owner_restoration: state?.autonomous_owner_restoration,
      tmux_session_name: state?.tmux_session_name,
      tmux_runner_pid: state?.tmux_runner_pid,
      tmux_runner_binding: state?.tmux_runner_binding,
      tmux_runner_observed_identity: tmuxRunnerIdentity,
      active_child_identity: childIdentity,
      active_child_liveness: childIdentity ? inspectProcessLivenessIdentity(childIdentity) : 'absent',
      autonomous_supervisor_identity: supervisorIdentity,
      autonomous_supervisor_liveness: supervisorIdentity ? inspectProcessLivenessIdentity(supervisorIdentity) : 'absent',
      autonomous_owner_recovery_daemon_identity: daemonIdentity,
      autonomous_owner_recovery_daemon_liveness: daemonIdentity ? inspectProcessLivenessIdentity(daemonIdentity) : 'absent',
      restorer_identity: restorerIdentity,
      restorer_liveness: restorerIdentity ? inspectProcessLivenessIdentity(restorerIdentity) : 'absent',
      history_tail: Array.isArray(state?.history) ? state.history.slice(-30) : [],
    },
    logical: logical ? {
      control_state: logical.control_state,
      terminal_state: logical.terminal_state,
      lease_generation: logical.lease_generation,
      lease: logical.lease,
      checkpoints: logical.events.filter((event) => event.kind === 'checkpoint_recorded')
        .map((event) => event.details.checkpoint),
      events_tail: logical.events.slice(-30).map((event) => ({ kind: event.kind, details: event.details })),
    } : null,
    tmux,
    supervisor_log: tail(path.join(sessionDir, 'supervisor.log'), 80),
    mux_runner_log: tail(path.join(sessionDir, 'mux-runner.log'), 80),
    fake_codex_events: fakeCodexLogPath ? fakeCodexEventSummary(fakeCodexLogPath) : [],
  }, null, 2);
}

async function waitForCompletedProductionRecovery({
  sessionDir, statePath, projectDir, intentId, env, fakeCodexLogPath,
}) {
  const startedAt = Date.now();
  const overallDeadline = startedAt + 90_000;
  const inactivityLimitMs = 30_000;
  let lastProgressAt = startedAt;
  let lastFingerprint = '';
  let restoredOwnerMissingAt = null;
  let latestState = null;
  let latestLogical = null;

  while (Date.now() < overallDeadline) {
    latestState = readJsonFile(statePath);
    try { latestLogical = readLogicalPipeline(sessionDir); } catch { latestLogical = null; }
    const feature = fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8');
    const r1 = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status;
    const r2 = parseTicketFile(path.join(sessionDir, 'r2', 'linear_ticket_r2.md')).status;
    const fakeEvents = fakeCodexEventSummary(fakeCodexLogPath);
    if (latestState.autonomous_budget_consumed_intent_id === intentId
      && latestState.last_exit_reason === 'success'
      && feature.includes('recovered-owner-work')) return latestState;

    const terminalReason = latestState.recovery_required === true
      ? `recovery required: ${latestState.recovery_reason || 'unknown reason'}`
      : latestState.cancel_requested_at || latestState.last_exit_reason === 'cancelled'
        ? 'session was cancelled'
        : latestLogical?.terminal_state === 'cancelled'
          ? 'logical pipeline was cancelled'
          : latestState.autonomous_owner_restoration?.status === 'failed'
            ? `owner restoration failed: ${latestState.autonomous_owner_restoration.error || 'unknown reason'}`
            : latestState.active === false && latestState.last_exit_reason
              && latestState.last_exit_reason !== 'autonomous_budget_rollover'
              ? `session stopped with ${latestState.last_exit_reason}`
              : null;
    if (terminalReason) {
      assert.fail(`${terminalReason} before recovered successor completion\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
    }

    const restoration = latestState.autonomous_owner_restoration;
    const restoredBinding = restoration?.restored_tmux_binding;
    if (restoration?.status === 'restored' && restoredBinding?.session_id
      && !tmuxSessionExists(restoredBinding.session_name, { env })) {
      restoredOwnerMissingAt ||= Date.now();
      if (Date.now() - restoredOwnerMissingAt >= 500) {
        assert.fail(`restored tmux owner disappeared before successor completion\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
      }
    } else {
      restoredOwnerMissingAt = null;
    }

    const fingerprint = JSON.stringify([
      latestState.step,
      latestState.iteration,
      latestState.current_ticket,
      latestState.last_exit_reason,
      latestState.autonomous_budget_rollover_intent_id,
      latestState.autonomous_budget_consumed_intent_id,
      latestState.autonomous_owner_restoration?.status,
      latestState.autonomous_owner_restoration?.attempt,
      latestState.tmux_runner_binding?.session_id,
      latestState.autonomous_supervisor_identity?.fingerprint,
      latestState.active_child_identity?.fingerprint,
      Array.isArray(latestState.history) ? latestState.history.length : 0,
      latestLogical?.lease_generation,
      latestLogical?.lease?.owner_id,
      latestLogical?.events.length,
      latestLogical?.terminal_state,
      r1,
      r2,
      feature,
      fakeEvents.map((event) => event.invocation_nonce),
    ]);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgressAt = Date.now();
    }
    if (Date.now() - lastProgressAt >= inactivityLimitMs) {
      assert.fail(`recovered successor made no durable progress for ${inactivityLimitMs}ms\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`recovered successor did not complete within the 90000ms progress-aware window\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
}

async function waitForPendingProductionRollover(sessionDir, statePath, env, fakeCodexLogPath = '') {
  const startedAt = Date.now();
  // Preserve the original 30-second no-progress budget. A second bounded window
  // is available only while durable phase/history/journal progress continues.
  const overallDeadline = startedAt + 60_000;
  const inactivityLimitMs = 30_000;
  let lastProgressAt = startedAt;
  let lastFingerprint = '';
  let deadOwnerObservedAt = null;
  let latestState = null;
  let latestLogical = null;

  while (Date.now() < overallDeadline) {
    latestState = readJsonFile(statePath);
    try { latestLogical = readLogicalPipeline(sessionDir); } catch { latestLogical = null; }
    const intentId = latestState.autonomous_budget_rollover_intent_id;
    const durableRollover = intentId && latestLogical?.events.some((event) => (
      event.details.checkpoint?.kind === 'autonomous_budget_rollover'
      && event.details.checkpoint.intent_id === intentId
    ));
    const daemonIdentity = latestState.autonomous_owner_recovery_daemon_identity;
    if (latestState.last_exit_reason === 'autonomous_budget_rollover'
      && durableRollover
      && latestState.autonomous_owner_spec
      && daemonIdentity
      && inspectProcessLivenessIdentity(daemonIdentity) === 'matched') return latestState;

    const fingerprint = JSON.stringify([
      latestState.step,
      latestState.iteration,
      latestState.current_ticket,
      latestState.last_exit_reason,
      latestState.autonomous_budget_rollover_intent_id,
      latestState.autonomous_owner_spec?.spec_id,
      latestState.autonomous_owner_recovery_daemon_identity?.fingerprint,
      latestState.active_child_identity?.fingerprint,
      Array.isArray(latestState.history) ? latestState.history.length : 0,
      latestLogical?.lease_generation,
      latestLogical?.events.length,
      latestLogical?.terminal_state,
    ]);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgressAt = Date.now();
    }

    const terminalReason = latestState.recovery_required === true
      ? `recovery required: ${latestState.recovery_reason || 'unknown reason'}`
      : latestState.cancel_requested_at || latestState.last_exit_reason === 'cancelled'
        ? 'session was cancelled'
        : latestLogical?.terminal_state === 'cancelled'
          ? 'logical pipeline was cancelled'
          : null;
    if (terminalReason) {
      assert.fail(`${terminalReason} before pending rollover\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
    }

    const supervisorIdentity = latestState.autonomous_supervisor_identity;
    const supervisorDead = supervisorIdentity
      ? inspectProcessLivenessIdentity(supervisorIdentity) !== 'matched'
      : false;
    const tmuxMissing = latestState.tmux_session_name
      ? !tmuxSessionExists(latestState.tmux_session_name, { env })
      : false;
    const ownerDead = supervisorDead || tmuxMissing;
    if (ownerDead) {
      deadOwnerObservedAt ||= Date.now();
      if (Date.now() - deadOwnerObservedAt >= 500) {
        assert.fail(`production owner exited before pending rollover\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
      }
    } else {
      deadOwnerObservedAt = null;
    }

    if (Date.now() - lastProgressAt >= inactivityLimitMs) {
      assert.fail(`production owner made no durable progress for ${inactivityLimitMs}ms\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`production owner did not reach a durable pending rollover within 60000ms\n${ownerRecoveryDiagnostics(sessionDir, latestState, latestLogical, env, fakeCodexLogPath)}`);
}

test('production tmux owner recovery restores a killed rollover and the successor performs work', async (t) => {
  try {
    runTmux(['-V']);
  } catch {
    t.skip('tmux is unavailable');
    return;
  }

  const dataRoot = makeTempRoot('pickle-owner-recovery-data-');
  const projectDir = makeTempRoot('pickle-owner-recovery-project-');
  const fakeBin = makeTempRoot('pickle-owner-recovery-bin-');
  const tmuxTmpDir = fs.mkdtempSync('/tmp/prtm-');
  const fakeCodexLogPath = path.join(dataRoot, 'fake-codex-events.jsonl');
  initializeRepository(projectDir);
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'recovered-owner-work\n',
    FAKE_CODEX_HANG_MS: '10',
    FAKE_CODEX_INVOCATION_LOG: fakeCodexLogPath,
    PICKLE_CODEX_BIN: path.join(fakeBin, 'codex'),
    PICKLE_TEST_MAX_ITERATIONS: '1',
    // An isolated tmux server inherits this test's fake-Codex PATH instead of
    // a long-lived developer tmux server's ambient environment.
    TMUX_TMPDIR: tmuxTmpDir,
  });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'recover a killed autonomous owner'], {
    env,
    cwd: projectDir,
  }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1', title: 'Reach the rollover boundary',
        description: 'Complete one ticket so the configured iteration boundary is reached.',
        acceptance_criteria: ['The first owner completes one bounded ticket.'],
        verification: ['node -e "process.exit(0)"'], allowed_paths: ['feature.txt'], priority: 'P1', status: 'Todo',
      },
      {
        id: 'R2', title: 'Recovered owner work',
        description: 'The replacement owner must execute this ticket.',
        acceptance_criteria: ['The recovered owner appends the second expected feature marker.'],
        verification: [
          'node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'feature.txt\',\'utf8\');if((text.match(/recovered-owner-work/g)||[]).length!==2)process.exit(1)"',
        ],
        allowed_paths: ['feature.txt'], priority: 'P1', status: 'Todo',
      },
    ],
  });
  acceptTestRefinement(sessionDir, projectDir);
  writeJson(statePath, {
    ...readJsonFile(statePath),
    // The next rollover is epoch 5, giving the test a four-second pending window
    // in which to kill the exact production tmux owner.
    autonomous_budget_epoch: 4,
  });

  let cleanupBinding = null;
  try {
    const launchOutput = runNode([
      path.join(repoRoot, 'bin/pickle-tmux.js'),
      '--resume', sessionDir,
    ], { env, cwd: projectDir });
    assert.match(launchOutput, /Pickle Rick tmux mode launched/);

    const pending = await waitForPendingProductionRollover(sessionDir, statePath, env, fakeCodexLogPath);
    const intentId = pending.autonomous_budget_rollover_intent_id;
    const originalBinding = pending.tmux_runner_binding;
    cleanupBinding = originalBinding;
    assert.ok(originalBinding?.session_id);
    assert.doesNotMatch(originalBinding.pane_start_command, /--resume(?:\s|=|$)/);

    killTmuxSessionById(originalBinding.session_id, { env });

    const completed = await waitForCompletedProductionRecovery({
      sessionDir,
      statePath,
      projectDir,
      intentId,
      env,
      fakeCodexLogPath,
    });
    cleanupBinding = completed.tmux_runner_binding;

    assert.notDeepEqual(
      [completed.tmux_runner_binding.session_id, completed.tmux_runner_binding.session_created],
      [originalBinding.session_id, originalBinding.session_created],
    );
    assert.doesNotMatch(completed.tmux_runner_binding.pane_start_command, /--resume(?:\s|=|$)/);
    assert.ok(completed.history.some((entry) => entry.step === 'autonomous_owner_restored'));
    assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
    assert.equal(parseTicketFile(path.join(sessionDir, 'r2', 'linear_ticket_r2.md')).status, 'Done');
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8'),
      'base\nrecovered-owner-work\nrecovered-owner-work\n',
    );

    const checkpoints = readLogicalPipeline(sessionDir).events
      .map((event) => event.details.checkpoint)
      .filter((checkpoint) => checkpoint?.intent_id === intentId);
    assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.kind), [
      'autonomous_budget_rollover',
      'autonomous_budget_rollover_consumed',
    ]);
    await waitFor(
      () => !tmuxSessionExists(completed.tmux_runner_binding.session_name, { env }),
      { timeoutMs: 5_000, intervalMs: 50, message: 'recovered terminal owner did not clean up tmux' },
    );
  } finally {
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    } catch {}
    if (cleanupBinding?.session_id) {
      try { killTmuxSessionById(cleanupBinding.session_id, { env }); } catch {}
    }
    try {
      const daemonPid = Number(readJsonFile(statePath).autonomous_owner_recovery_daemon_pid);
      if (Number.isInteger(daemonPid) && daemonPid > 0) process.kill(daemonPid, 'SIGTERM');
    } catch {}
    try { runTmux(['kill-server'], { env }); } catch {}
  }
});
