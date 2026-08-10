// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempRoot, writeJson } from './helpers.js';
import { ensureLegacyAdoptionSupervisorOwner, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE, legacyAdoptionSupervisorManagerArgs } from '../services/legacy-adoption-supervisor-owner.js';
import {
  LEGACY_ADOPTION_EXECUTOR_FILE,
  readAuthenticatedLegacyAdoptionExecutorStatus,
  readLegacyAdoptionExecutorStatus,
  requestLegacyAdoptionExecutorRestart,
} from '../services/legacy-adoption-executor-supervisor.js';
import { startLegacyAdoptionSupervisorOwner } from '../bin/adopt-legacy-session.js';
import { killTmuxSessionById, tmuxSessionExists } from '../services/tmux.js';
import { inspectRecordedLiveProcessIdentity, reapRecordedLiveProcessGroup } from '../services/orphan-reaper.js';

function identity(pid) {
  return { pid, pgid: pid, start_time: `start-${pid}`, fingerprint: `fingerprint-${pid}` };
}

function fixture() {
  const sessionDir = makeTempRoot('legacy-adoption-owner-session-');
  const sourceRuntimeRoot = makeTempRoot('legacy-adoption-owner-source-');
  const targetRuntimeRoot = makeTempRoot('legacy-adoption-owner-target-');
  return { sessionDir, sourceRuntimeRoot, targetRuntimeRoot };
}

function executorStatus(value, manager = identity(81000), status = 'supervising') {
  const owner = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8'));
  const boundSpec = { ...value, sessionDir: fs.realpathSync(value.sessionDir), ownerNonce: owner.launch_nonce };
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), {
    schema_version: 1, session_id: path.basename(value.sessionDir), status,
    manager_identity: manager, manager_generation: 1, manager_parent_pid: owner.binding.pane_pid,
    manager_argv_sha256: crypto.createHash('sha256').update(JSON.stringify([process.execPath, ...legacyAdoptionSupervisorManagerArgs(boundSpec)])).digest('hex'),
    owner_nonce: owner.launch_nonce, executor_identity: identity(82000), executor_generation: 1,
    executor_started_at: '2026-08-09T00:00:01.000Z', executor_lease_expires_at: '2026-08-09T00:01:00.000Z',
    executor_spec_sha256: owner.executor_spec_sha256, replacement_count: 0, last_loss_at: null,
    last_restart_request_id: null, updated_at: '2026-08-09T00:00:01.000Z',
  });
}

function cleanupRealOwner(value, owner) {
  let exactOwner = owner;
  if (!exactOwner) {
    try {
      exactOwner = JSON.parse(fs.readFileSync(
        path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8',
      ));
    } catch {}
  }
  const executor = readLegacyAdoptionExecutorStatus(value.sessionDir);
  if (exactOwner?.binding?.session_id && tmuxSessionExists(exactOwner.binding.session_name)) {
    killTmuxSessionById(exactOwner.binding.session_id);
  }
  if (executor?.executor_identity) {
    const result = reapRecordedLiveProcessGroup(executor.executor_identity);
    assert.ok(['reaped', 'not-running'].includes(result.status));
    assert.notEqual(inspectRecordedLiveProcessIdentity(executor.executor_identity), 'matched');
  }
}

test('prepare owner waits for authenticated supervisor readiness and attaches without duplication', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  let creates = 0;
  let live = true;
  let binding = null;
  const deps = {
    now: () => now, timeoutMs: 1_000, tmuxExists: () => live,
    createOwner: (name) => {
      creates += 1;
      binding = { schema_version: 1, session_name: name, session_id: '$81', session_created: '1',
        pane_id: '%82', pane_pid: 83000, pane_start_command: 'bash' };
      return binding;
    },
    readBinding: () => binding,
    inspectManager: () => 'matched',
    wait: () => { now += 50; executorStatus(value); },
  };
  live = false;
  const first = ensureLegacyAdoptionSupervisorOwner(value, {
    ...deps, createOwner: (...args) => { live = true; return deps.createOwner(...args); },
  });
  assert.equal(first.status, 'ready');
  assert.equal(creates, 1);
  const second = ensureLegacyAdoptionSupervisorOwner(value, deps);
  assert.equal(second.status, 'ready');
  assert.equal(creates, 1);
  assert.equal(second.supervisor_identity_fingerprint, identity(81000).fingerprint);
});

test('stale dead owner is replaced while a mismatched live binding fails closed', () => {
  const value = fixture();
  let live = false;
  let binding = null;
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const ready = ensureLegacyAdoptionSupervisorOwner(value, {
    now: () => now, timeoutMs: 1_000, tmuxExists: () => live,
    createOwner: (name) => {
      live = true;
      binding = { schema_version: 1, session_name: name, session_id: '$91', session_created: '1',
        pane_id: '%92', pane_pid: 84000, pane_start_command: 'bash' };
      return binding;
    },
    readBinding: () => binding, inspectManager: () => 'matched',
    wait: () => { now += 50; executorStatus(value, identity(81001)); },
  });
  assert.equal(ready.status, 'ready');
  assert.throws(() => ensureLegacyAdoptionSupervisorOwner(value, {
    tmuxExists: () => true, readBinding: () => ({ ...binding, pane_id: '%foreign' }),
  }), /does not match its immutable owner record/);
});

test('foreign live manager status cannot acknowledge the requested owner spec', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  let binding = null;
  assert.throws(() => ensureLegacyAdoptionSupervisorOwner(value, {
    now: () => now, timeoutMs: 150, tmuxExists: () => Boolean(binding),
    createOwner: (name) => {
      binding = { schema_version: 1, session_name: name, session_id: '$foreign', session_created: '1',
        pane_id: '%foreign', pane_pid: 84500, pane_start_command: 'bash' };
      return binding;
    },
    readBinding: () => binding, inspectManager: () => 'matched',
    wait: () => {
      now += 50;
      executorStatus(value, identity(81009));
      const statusPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE);
      const foreign = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      foreign.owner_nonce = 'foreign-owner-nonce';
      foreign.executor_spec_sha256 = 'foreign-spec';
      writeJson(statusPath, foreign);
    },
  }), /Timed out waiting for adoption supervisor readiness acknowledgement/);
});

test('terminal acknowledgement cleans up only the immutable owner session id', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  let binding = null;
  let live = false;
  const killed = [];
  const result = ensureLegacyAdoptionSupervisorOwner(value, {
    now: () => now, timeoutMs: 1_000, tmuxExists: () => live,
    createOwner: (name) => {
      live = true;
      binding = { schema_version: 1, session_name: name, session_id: '$101', session_created: '1',
        pane_id: '%102', pane_pid: 85000, pane_start_command: 'bash' };
      return binding;
    },
    readBinding: () => binding, inspectManager: () => 'matched', killTmux: (id) => killed.push(id),
    wait: () => { now += 50; executorStatus(value, identity(81002), 'launched'); },
  });
  assert.equal(result.status, 'terminal');
  assert.deepEqual(killed, ['$101']);
});

test('real prepare seam tmux owner replaces a SIGKILLed node supervisor and converges launched', () => {
  const value = fixture();
  writeJson(path.join(value.sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: value.sessionDir, history: [],
    tmux_runner_pid: null, tmux_session_name: null, worker_pid: null, active_child_pid: null,
  });
  let owner = null;
  try {
    startLegacyAdoptionSupervisorOwner(value.sessionDir, value.sourceRuntimeRoot, value.targetRuntimeRoot);
    owner = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8'));
    const first = readLegacyAdoptionExecutorStatus(value.sessionDir);
    assert.equal(owner.status, 'ready');
    assert.equal(first.status, 'supervising');
    assert.equal(first.manager_generation, 1);
    assert.equal(tmuxSessionExists(owner.binding.session_name), true);

    process.kill(first.manager_identity.pid, 'SIGKILL');
    const replacementDeadline = Date.now() + 15_000;
    let replacement = null;
    while (Date.now() < replacementDeadline) {
      const current = readAuthenticatedLegacyAdoptionExecutorStatus(value);
      if (current?.manager_generation > first.manager_generation
        && current.manager_identity.fingerprint !== first.manager_identity.fingerprint) {
        replacement = current;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(replacement, 'tmux restart owner did not publish a replacement supervisor generation');
    assert.equal(replacement.manager_generation, 2);

    writeJson(path.join(value.sessionDir, 'legacy-session-adoption.json'), {
      schema_version: 1, status: 'launched', launched_runtime_root: value.targetRuntimeRoot,
    });
    const terminalDeadline = Date.now() + 10_000;
    let terminal = null;
    while (Date.now() < terminalDeadline) {
      const current = readLegacyAdoptionExecutorStatus(value.sessionDir);
      if (current?.status === 'launched') { terminal = current; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(terminal, 'replacement supervisor did not converge the launched result');
    assert.equal(terminal.manager_generation, 2);
  } finally {
    cleanupRealOwner(value, owner);
  }
});

test('dead ready tmux owner rebinds its old status to a new nonce and converges ready', () => {
  const value = fixture();
  writeJson(path.join(value.sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: value.sessionDir, history: [],
    tmux_runner_pid: null, tmux_session_name: null, worker_pid: null, active_child_pid: null,
  });
  let currentOwner = null;
  try {
    startLegacyAdoptionSupervisorOwner(value.sessionDir, value.sourceRuntimeRoot, value.targetRuntimeRoot);
    const firstOwner = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8',
    ));
    const first = readAuthenticatedLegacyAdoptionExecutorStatus(value);
    assert.ok(first);
    assert.equal(firstOwner.status, 'ready');

    killTmuxSessionById(firstOwner.binding.session_id);
    startLegacyAdoptionSupervisorOwner(value.sessionDir, value.sourceRuntimeRoot, value.targetRuntimeRoot);
    currentOwner = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8',
    ));
    const rebound = readAuthenticatedLegacyAdoptionExecutorStatus(value);
    assert.ok(rebound, 'replacement owner did not authenticate its rebound supervisor status');
    assert.equal(currentOwner.status, 'ready');
    assert.notEqual(currentOwner.launch_nonce, firstOwner.launch_nonce);
    assert.notEqual(currentOwner.binding.session_id, firstOwner.binding.session_id);
    assert.equal(rebound.owner_nonce, currentOwner.launch_nonce);
    assert.ok(rebound.manager_generation > first.manager_generation);
    assert.notEqual(rebound.manager_identity.fingerprint, first.manager_identity.fingerprint);
    assert.notEqual(rebound.executor_identity.fingerprint, first.executor_identity.fingerprint);
  } finally {
    if (!currentOwner) {
      currentOwner = JSON.parse(fs.readFileSync(
        path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8',
      ));
    }
    cleanupRealOwner(value, currentOwner);
  }
});

test('successor manager processes an exact pending restart request after predecessor death', () => {
  const value = fixture();
  writeJson(path.join(value.sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: value.sessionDir, history: [],
    tmux_runner_pid: null, tmux_session_name: null, worker_pid: null, active_child_pid: null,
  });
  let owner = null;
  try {
    startLegacyAdoptionSupervisorOwner(value.sessionDir, value.sourceRuntimeRoot, value.targetRuntimeRoot);
    owner = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE), 'utf8'));
    const first = readAuthenticatedLegacyAdoptionExecutorStatus(value);
    assert.ok(first);
    process.kill(first.manager_identity.pid, 'SIGSTOP');
    const request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'manager death window', first);
    process.kill(first.manager_identity.pid, 'SIGKILL');

    const replacementDeadline = Date.now() + 15_000;
    let replacement = null;
    while (Date.now() < replacementDeadline) {
      const current = readAuthenticatedLegacyAdoptionExecutorStatus(value);
      if (current?.manager_generation > first.manager_generation
        && current.executor_generation > request.expected_generation
        && current.last_restart_request_id === request.request_id) {
        replacement = current;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(replacement, 'successor manager did not authenticate the exact pending restart');
    assert.equal(replacement.manager_generation, 2);
    assert.notEqual(replacement.executor_identity.fingerprint, request.expected_executor_fingerprint);

    writeJson(path.join(value.sessionDir, 'legacy-session-adoption.json'), {
      schema_version: 1, status: 'launched', launched_runtime_root: value.targetRuntimeRoot,
    });
    const terminalDeadline = Date.now() + 10_000;
    while (Date.now() < terminalDeadline
      && readLegacyAdoptionExecutorStatus(value.sessionDir)?.status !== 'launched') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(readLegacyAdoptionExecutorStatus(value.sessionDir)?.status, 'launched');
  } finally {
    cleanupRealOwner(value, owner);
  }
});
