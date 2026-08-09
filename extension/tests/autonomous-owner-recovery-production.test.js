// @tier: integration
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readLogicalPipeline } from '../services/durable-supervisor.js';
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
  initializeRepository(projectDir);
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'recovered-owner-work\n',
    FAKE_CODEX_HANG_MS: '10',
    PICKLE_CODEX_BIN: path.join(fakeBin, 'codex'),
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
    writeJson(statePath, {
      ...readJsonFile(statePath),
      max_iterations: 1,
    });

    const pending = await waitFor(() => {
      const state = readJsonFile(statePath);
      return state.last_exit_reason === 'autonomous_budget_rollover'
        && state.autonomous_budget_rollover_intent_id
        && state.autonomous_owner_spec
        && state.autonomous_owner_recovery_daemon_identity
        ? state : null;
    }, { timeoutMs: 30_000, intervalMs: 20, message: 'production owner never reached a pending rollover' });
    const intentId = pending.autonomous_budget_rollover_intent_id;
    const originalBinding = pending.tmux_runner_binding;
    cleanupBinding = originalBinding;
    assert.ok(originalBinding?.session_id);
    assert.doesNotMatch(originalBinding.pane_start_command, /--resume(?:\s|=|$)/);

    killTmuxSessionById(originalBinding.session_id, { env });

    const completed = await waitFor(() => {
      const state = readJsonFile(statePath);
      const feature = fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8');
      return state.autonomous_budget_consumed_intent_id === intentId
        && state.last_exit_reason === 'success'
        && feature.includes('recovered-owner-work')
        ? state : null;
    }, {
      timeoutMs: 45_000,
      intervalMs: 50,
      message: 'recovered production successor did not consume the rollover and finish work',
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
