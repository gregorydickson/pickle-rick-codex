// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureAutonomousOwnerRecoveryDaemon,
} from '../services/autonomous-owner-recovery.js';
import { createCancellationRecoveryIntent } from '../services/cancellation-recovery.js';
import { inspectProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot, repoRoot, waitFor } from './helpers.js';

test('direct cancellation recovery watchdog replaces a SIGKILLed daemon without an owner spec', async (t) => {
  const sessionDir = makeTempRoot('pickle-cancel-watchdog-');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 1,
    active: false,
    working_dir: sessionDir,
    history: [],
    cancel_requested_at: new Date().toISOString(),
    last_exit_reason: 'cancel_recovery_required',
    recovery_required: true,
    recovery_kind: 'cancellation_ownership',
    // A corrupt intent stays pending and gives the replacement path time to be
    // observed without introducing a live process group into the fixture.
    cancellation_recovery: { schema_version: 1, status: 'pending', identities: 'corrupt' },
  }));
  const manager = new StateManager();
  const runtimeBin = path.join(repoRoot, 'bin');
  const startedPid = ensureAutonomousOwnerRecoveryDaemon(sessionDir, runtimeBin, manager);
  assert.ok(Number.isInteger(startedPid) && startedPid > 0);

  const started = await waitFor(() => {
    const state = manager.read(statePath);
    const daemon = state.autonomous_owner_recovery_daemon_identity;
    const watchdog = state.cancellation_recovery_watchdog_identity;
    return daemon && watchdog
      && inspectProcessLivenessIdentity(daemon) === 'matched'
      && inspectProcessLivenessIdentity(watchdog) === 'matched'
      ? { state, daemon, watchdog } : null;
  }, { timeoutMs: 10_000, message: 'direct recovery owner pair did not start' });
  assert.equal(started.state.autonomous_owner_spec, undefined);

  t.after(() => {
    try {
      manager.update(statePath, (state) => {
        const completed = createCancellationRecoveryIntent([]);
        completed.status = 'completed';
        state.cancellation_recovery = completed;
        state.recovery_required = false;
        state.recovery_kind = null;
        return state;
      });
    } catch { /* cleanup is best-effort */ }
    try {
      const latest = manager.read(statePath);
      for (const identity of [
        latest.autonomous_owner_recovery_daemon_identity,
        latest.cancellation_recovery_watchdog_identity,
      ]) {
        if (identity) process.kill(identity.pid, 'SIGKILL');
      }
    } catch { /* already absent */ }
  });

  process.kill(started.daemon.pid, 'SIGKILL');
  const replacement = await waitFor(() => {
    const state = manager.read(statePath);
    const identity = state.autonomous_owner_recovery_daemon_identity;
    return identity && identity.pid !== started.daemon.pid
      && inspectProcessLivenessIdentity(identity) === 'matched' ? identity : null;
  }, { timeoutMs: 10_000, message: 'watchdog did not replace the SIGKILLed recovery daemon' });

  assert.equal(inspectProcessLivenessIdentity(started.daemon), 'not-running');
  assert.notEqual(replacement.fingerprint, started.daemon.fingerprint);
  assert.equal(inspectProcessLivenessIdentity(started.watchdog), 'matched');

  process.kill(started.watchdog.pid, 'SIGKILL');
  const replacementWatchdog = await waitFor(() => {
    const state = manager.read(statePath);
    const identity = state.cancellation_recovery_watchdog_identity;
    return identity && identity.pid !== started.watchdog.pid
      && inspectProcessLivenessIdentity(identity) === 'matched' ? identity : null;
  }, { timeoutMs: 10_000, message: 'daemon did not replace the SIGKILLed recovery watchdog' });
  assert.equal(inspectProcessLivenessIdentity(started.watchdog), 'not-running');
  assert.notEqual(replacementWatchdog.fingerprint, started.watchdog.fingerprint);
  assert.equal(inspectProcessLivenessIdentity(replacement), 'matched');

  manager.update(statePath, (state) => {
    const completed = createCancellationRecoveryIntent([]);
    completed.status = 'completed';
    state.cancellation_recovery = completed;
    state.recovery_required = false;
    state.recovery_kind = null;
    return state;
  });
  const settled = await waitFor(() => {
    const state = manager.read(statePath);
    return state.autonomous_owner_recovery_daemon_identity == null
      && state.cancellation_recovery_watchdog_identity == null
      && state.cancellation_recovery_runtime_binding == null ? state : null;
  }, { timeoutMs: 10_000, message: 'recovery owner pair did not retire and clear runtime authority' });
  assert.equal(settled.autonomous_owner_recovery_daemon_pid, null);
  assert.equal(settled.cancellation_recovery_watchdog_pid, null);
  assert.equal(inspectProcessLivenessIdentity(replacement), 'not-running');
  assert.equal(inspectProcessLivenessIdentity(replacementWatchdog), 'not-running');
});
