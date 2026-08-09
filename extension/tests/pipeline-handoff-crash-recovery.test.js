// @tier: integration
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  registerAutonomousOwnerSpec,
  restoreAutonomousBudgetOwner,
  runAutonomousOwnerRecoveryDaemon,
} from '../services/autonomous-owner-recovery.js';
import {
  acquireSupervisorLease,
  beginAutonomousExecution,
  createLogicalPipeline,
  readLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
} from '../services/durable-supervisor.js';
import { prepareLiveSessionHandoffCheckpoint } from '../services/live-session-migration.js';
import { writePrdSeal } from '../services/prd-seal.js';
import { reconcileSessionLiveness } from '../services/session.js';
import { StateManager } from '../services/state-manager.js';
import {
  captureOwnedTmuxRunnerBinding,
  killTmuxSessionById,
  runTmux,
  shellQuote,
  tmuxSessionExists,
} from '../services/tmux.js';
import { makeTempRoot, repoRoot, writeJson } from './helpers.js';

async function waitForState(statePath, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new StateManager().read(statePath);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for state predicate at ${statePath}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('pipeline CLI SIGKILL after durable handoff acquisition is reconciled and cancellation forbids restore', async (t) => {
  try {
    runTmux(['-V']);
  } catch {
    t.skip('tmux is unavailable');
    return;
  }

  const sessionDir = makeTempRoot('pickle-pipeline-handoff-crash-');
  const statePath = path.join(sessionDir, 'state.json');
  const sourceMarker = path.join(sessionDir, 'source-owner.log');
  const sourceOwner = path.join(sessionDir, 'source-owner.mjs');
  fs.writeFileSync(sourceOwner, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(sourceMarker)}, 'source\\n');`,
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Pipeline handoff crash\n');
  writeJson(statePath, {
    schema_version: 1,
    active: true,
    working_dir: sessionDir,
    session_dir: sessionDir,
    original_prompt: 'recover a killed accepted pipeline owner',
    step: 'implement',
    iteration: 1,
    max_iterations: 25,
    max_time_minutes: 480,
    worker_timeout_seconds: 60,
    start_time_epoch: Math.floor(Date.now() / 1_000),
    run_start_time_epoch: Math.floor(Date.now() / 1_000),
    started_at: new Date().toISOString(),
    current_ticket: null,
    history: [],
    tmux_mode: true,
    last_exit_reason: null,
  });

  const sessionName = `pickle-${path.basename(sessionDir)}`;
  const sourceCommand = `node ${shellQuote(sourceOwner)} ${shellQuote(sessionDir)} --runner-bin=pipeline-runner.js`;
  let sourceBinding;
  let daemon = null;
  try {
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, sourceCommand]);
    sourceBinding = captureOwnedTmuxRunnerBinding(sessionName, sessionDir);
    new StateManager().update(statePath, (current) => {
      current.tmux_session_name = sessionName;
      current.tmux_runner_pid = sourceBinding.pane_pid;
      current.tmux_runner_binding = sourceBinding;
      return current;
    });
    const sourceSpec = registerAutonomousOwnerSpec(sessionDir, 'pipeline-runner.js', []);
    assert.ok(sourceSpec);

    createLogicalPipeline(sessionDir, 'pipeline-handoff-crash');
    writePrdSeal(sessionDir, {
      prd: '# Pipeline handoff crash\n',
      repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
      acceptance_criteria: [{ id: 'AC-1', text: 'Reconcile the accepted owner after process loss.' }],
      scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
      preservation_and_rollback: {}, completion_definition: {}, release_gates: [],
    });
    beginAutonomousExecution(sessionDir);
    const sourceRuntime = {
      runtime_id: 'blue', version: '1', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const targetRuntime = {
      runtime_id: 'green', version: '2', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const sourceLease = acquireSupervisorLease(sessionDir, { ownerId: 'blue-owner', ttlMs: 60_000 });
    const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
    const requestId = requestRuntimeHandoff(
      sessionDir, sourceLease.owner_id, sourceLease.token, sourceRuntime, targetRuntime, checkpoint,
    );
    releaseRuntimeHandoffLease(sessionDir, sourceLease.owner_id, sourceLease.token, requestId);

    const encodedRuntime = Buffer.from(JSON.stringify(targetRuntime)).toString('base64url');
    const child = spawn(process.execPath, [
      path.join(repoRoot, 'bin/pipeline-runner.js'),
      sessionDir,
      `--handoff-request=${requestId}`,
      `--target-runtime=${encodedRuntime}`,
    ], {
      cwd: sessionDir,
      env: {
        ...process.env,
        PICKLE_TEST_MODE: '1',
        PICKLE_TEST_HANDOFF_CRASH_AFTER_ACQUIRE: '1',
      },
      stdio: 'ignore',
    });
    const exited = await waitForExit(child);
    assert.equal(exited.code, null);
    assert.equal(exited.signal, 'SIGKILL');

    const completedEvent = readLogicalPipeline(sessionDir).events.find(
      (event) => event.kind === 'runtime_handoff_completed' && event.details.request_id === requestId,
    );
    assert.ok(completedEvent, 'target acquisition was durable before SIGKILL');
    assert.equal(completedEvent.details.lease.owner_identity.pid, child.pid);

    daemon = runAutonomousOwnerRecoveryDaemon(sessionDir, { intervalMs: 20 });
    const reconciled = await waitForState(
      statePath,
      (current) => current.autonomous_owner_handoff_transaction?.status === 'completed',
    );
    const transaction = reconciled.autonomous_owner_handoff_transaction;
    assert.deepEqual(reconciled.autonomous_owner_spec, transaction.target_owner_spec);
    assert.notDeepEqual(reconciled.autonomous_owner_spec, transaction.source_owner_spec);
    assert.equal(reconciled.autonomous_owner_recovery_suspended, false);
    assert.equal(reconciled.autonomous_owner_recovery_suspended_for_handoff, null);
    assert.match(reconciled.autonomous_owner_spec.pane_start_command, /recovered-supervisor-owner\.js/);
    assert.match(reconciled.autonomous_owner_spec.pane_start_command, /--runner-bin=pipeline-runner\.js/);
    assert.doesNotMatch(reconciled.autonomous_owner_spec.pane_start_command, /source-owner\.mjs/);
    assert.doesNotMatch(reconciled.autonomous_owner_spec.pane_start_command, /--handoff-request=/);
    assert.doesNotMatch(reconciled.autonomous_owner_spec.pane_start_command, /--target-runtime=/);

    new StateManager().update(statePath, (current) => {
      current.cancel_requested_at = new Date().toISOString();
      current.last_exit_reason = 'cancelled';
      return current;
    });
    await daemon;
    daemon = null;
    const bindingAtCancellation = new StateManager().read(statePath).tmux_runner_binding;
    if (bindingAtCancellation?.session_id) {
      try { killTmuxSessionById(bindingAtCancellation.session_id); } catch {}
    }
    reconcileSessionLiveness(sessionDir);
    assert.equal(restoreAutonomousBudgetOwner(sessionDir), 'noop');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tmuxSessionExists(sessionName), false, 'cancellation must not restore either owner command');
    assert.equal(fs.readFileSync(sourceMarker, 'utf8').trim().split('\n').length, 1);
  } finally {
    try {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at ||= new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
      if (daemon) await daemon;
    } catch {}
    if (sourceBinding?.session_id) {
      try { killTmuxSessionById(sourceBinding.session_id); } catch {}
    }
  }
});
