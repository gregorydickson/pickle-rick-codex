// @tier: integration
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  registerAutonomousOwnerSpec,
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
import { makeTempRoot, writeJson } from './helpers.js';

const runtimeBin = path.resolve('bin');

async function waitForState(statePath, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new StateManager().read(statePath);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for state predicate at ${statePath}`);
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child ${child.pid} to exit`)), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('mux CLI SIGKILL after handoff acquisition is reconciled to the exact target owner', async (t) => {
  try {
    runTmux(['-V']);
  } catch {
    t.skip('tmux is unavailable');
    return;
  }

  const sessionDir = makeTempRoot('mux-handoff-crash-');
  const statePath = path.join(sessionDir, 'state.json');
  const sourceFixture = path.join(sessionDir, 'supervised-runner.js');
  const sessionName = `pickle-${path.basename(sessionDir)}`;
  fs.writeFileSync(sourceFixture, 'setInterval(() => {}, 1_000);\n');
  const sourceCommand = `node ${shellQuote(sourceFixture)} ${shellQuote(sessionDir)} --runner-bin=mux-runner.js`;
  let binding = null;
  let daemonPromise = null;

  try {
    runTmux(['new-session', '-d', '-s', sessionName, '-c', sessionDir, sourceCommand]);
    binding = captureOwnedTmuxRunnerBinding(sessionName, sessionDir);
    writeJson(statePath, {
      schema_version: 1,
      active: true,
      working_dir: sessionDir,
      session_dir: sessionDir,
      original_prompt: 'exercise mux handoff crash recovery',
      step: 'implement',
      iteration: 1,
      max_iterations: 25,
      max_time_minutes: 480,
      worker_timeout_seconds: 900,
      start_time_epoch: Math.floor(Date.now() / 1_000),
      run_start_time_epoch: Math.floor(Date.now() / 1_000),
      started_at: new Date().toISOString(),
      current_ticket: null,
      history: [],
      tmux_mode: true,
      tmux_session_name: sessionName,
      tmux_runner_pid: binding.pane_pid,
      tmux_runner_binding: binding,
      autonomous_budget_epoch: 1,
      autonomous_budget_rollover_intent_id: 'mux-handoff-crash-rollover',
      autonomous_relaunch_not_before: new Date(Date.now() + 30_000).toISOString(),
      autonomous_relaunch_deadline: new Date(Date.now() + 90_000).toISOString(),
      recovery_required: false,
    });
    const sourceSpec = registerAutonomousOwnerSpec(sessionDir, 'mux-runner.js', []);
    assert.ok(sourceSpec);

    const sourceRuntime = {
      runtime_id: 'blue', version: '1', build_hash: 'b'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    const targetRuntime = {
      runtime_id: 'green', version: '2', build_hash: 'a'.repeat(64), min_state_schema: 1, max_state_schema: 1,
    };
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Mux handoff crash recovery\n');
    createLogicalPipeline(sessionDir, 'mux-handoff-crash-recovery');
    writePrdSeal(sessionDir, {
      prd: '# Mux handoff crash recovery\n',
      repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
      acceptance_criteria: [{ id: 'AC-1', text: 'Recover the exact accepted mux owner.' }],
      scope_and_ownership: {},
      dependencies_and_external_prerequisites: [],
      risk: [],
      decision_precedence: [],
      preservation_and_rollback: {},
      completion_definition: {},
      release_gates: [],
    });
    beginAutonomousExecution(sessionDir);
    const sourceLease = acquireSupervisorLease(sessionDir, { ownerId: 'blue-owner', ttlMs: 10_000 });
    const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
    const requestId = requestRuntimeHandoff(
      sessionDir,
      sourceLease.owner_id,
      sourceLease.token,
      sourceRuntime,
      targetRuntime,
      checkpoint,
    );
    releaseRuntimeHandoffLease(sessionDir, sourceLease.owner_id, sourceLease.token, requestId);

    const encodedTarget = Buffer.from(JSON.stringify(targetRuntime)).toString('base64url');
    const child = spawn(process.execPath, [
      path.join(runtimeBin, 'mux-runner.js'),
      sessionDir,
      `--handoff-request=${requestId}`,
      `--target-runtime=${encodedTarget}`,
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
    assert.equal(exited.signal, 'SIGKILL');

    const afterCrash = new StateManager().read(statePath);
    assert.equal(afterCrash.autonomous_owner_handoff_transaction.request_id, requestId);
    assert.equal(afterCrash.autonomous_owner_handoff_transaction.status, 'fenced');
    assert.equal(afterCrash.autonomous_owner_recovery_suspended, true);
    assert.match(readLogicalPipeline(sessionDir).lease.owner_id, new RegExp(`^runner:${child.pid}:`));

    daemonPromise = runAutonomousOwnerRecoveryDaemon(sessionDir, { intervalMs: 10 });
    const reconciled = await waitForState(
      statePath,
      (current) => current.autonomous_owner_handoff_transaction?.status === 'completed',
    );
    assert.equal(reconciled.autonomous_owner_recovery_suspended, false);
    assert.equal(reconciled.autonomous_owner_recovery_suspended_for_handoff, null);
    assert.notEqual(reconciled.autonomous_owner_spec.spec_id, sourceSpec.spec_id);
    assert.equal(reconciled.autonomous_owner_spec.runner_bin, 'mux-runner.js');
    assert.deepEqual(reconciled.autonomous_owner_spec.runner_args, []);
    assert.match(reconciled.autonomous_owner_spec.pane_start_command, /recovered-supervisor-owner\.js/);
    assert.doesNotMatch(reconciled.autonomous_owner_spec.pane_start_command, /--handoff-request|--target-runtime/);

    new StateManager().update(statePath, (current) => {
      current.cancel_requested_at = new Date().toISOString();
      current.last_exit_reason = 'cancelled';
      return current;
    });
    await daemonPromise;
    daemonPromise = null;
    killTmuxSessionById(binding.session_id);
    reconcileSessionLiveness(sessionDir, undefined, Date.now() + 120_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tmuxSessionExists(sessionName), false, 'cancellation must prevent owner restoration');
  } finally {
    if (fs.existsSync(statePath)) {
      new StateManager().update(statePath, (current) => {
        current.cancel_requested_at = current.cancel_requested_at || new Date().toISOString();
        current.last_exit_reason = 'cancelled';
        return current;
      });
    }
    if (daemonPromise) await daemonPromise;
    if (binding && tmuxSessionExists(sessionName)) killTmuxSessionById(binding.session_id);
  }
});
