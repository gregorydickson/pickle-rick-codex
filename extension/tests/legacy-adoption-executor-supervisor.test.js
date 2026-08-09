// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_EXECUTOR_FILE,
  runLegacyAdoptionExecutorSupervisor,
} from '../services/legacy-adoption-executor-supervisor.js';
import { prepareLiveSessionMigration, verifyLiveSessionMigration } from '../services/live-session-migration.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';

function identity(pid) {
  return { pid, pgid: pid, start_time: `start-${pid}`, fingerprint: `fingerprint-${pid}` };
}

function fixture() {
  const sessionDir = makeTempRoot('legacy-adoption-executor-session-');
  const sourceRuntimeRoot = makeTempRoot('legacy-adoption-executor-source-');
  const targetRuntimeRoot = makeTempRoot('legacy-adoption-executor-target-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: sessionDir, history: [], current_ticket: null, step: 'readiness',
  });
  return { sessionDir, sourceRuntimeRoot, targetRuntimeRoot };
}

function spec(value) {
  return { sessionDir: value.sessionDir, sourceRuntimeRoot: value.sourceRuntimeRoot, targetRuntimeRoot: value.targetRuntimeRoot };
}

test('dead adoption executor is exclusively replaced and converges without installer participation', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  let nextPid = 71000;
  const alive = new Set();
  const spawned = [];
  let outcome = 'running';
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    now: () => now, managerIdentity: identity(70000), leaseMs: 3_000, pollMs: 10,
    spawnExecutor: () => { const pid = nextPid++; spawned.push(pid); alive.add(pid); return pid; },
    capture: (pid) => identity(pid),
    inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    wait: () => { now += 10; },
    outcome: () => outcome,
    onIteration: (status) => {
      if (status.executor_generation === 1) alive.delete(status.executor_identity.pid);
      if (status.executor_generation === 2) outcome = 'launched';
    },
  });
  assert.equal(result.status, 'launched');
  assert.deepEqual(spawned, [71000, 71001]);
  assert.equal(result.executor_generation, 2);
  assert.equal(result.replacement_count, 1);
});

test('real killed watchdog executor is automatically replaced and reaches launch without installer rerun', () => {
  const value = fixture();
  const recordPath = path.join(value.sessionDir, 'legacy-session-adoption.json');
  writeJson(recordPath, { schema_version: 1, status: 'adopted' });
  const children = [];
  let spawns = 0;
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70009), leaseMs: 3_000, pollMs: 20,
    spawnExecutor: () => {
      spawns += 1;
      const code = spawns === 1
        ? 'setInterval(() => {}, 1000);'
        : `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify({schema_version:1,status:'launched',launched_runtime_root:'/runtime'})),40);setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
      child.unref();
      children.push(child.pid);
      return child.pid;
    },
    capture: (pid) => {
      const deadline = Date.now() + 1_000;
      let captured = null;
      while (!captured && Date.now() < deadline) captured = captureProcessLivenessIdentity(pid);
      return captured;
    },
    onIteration: (status) => {
      if (status.executor_generation === 1) process.kill(-status.executor_identity.pgid, 'SIGKILL');
    },
  });
  assert.equal(result.status, 'launched');
  assert.equal(spawns, 2);
  assert.equal(result.replacement_count, 1);
});

test('expired executor is reaped on supervisor restart before one replacement is launched', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const alive = new Set([72000]);
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    now: () => now, managerIdentity: identity(70001), leaseMs: 1_000, pollMs: 10,
    spawnExecutor: () => 72000, capture: (pid) => identity(pid), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    outcome: () => 'running', wait: () => undefined, onIteration: () => { throw new Error('manager-crash'); },
  }), /manager-crash/);
  now += 2_000;
  const reaped = [];
  let outcome = 'running';
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    now: () => now, managerIdentity: identity(70002), leaseMs: 1_000, pollMs: 10,
    spawnExecutor: () => { alive.add(72001); return 72001; }, capture: (pid) => identity(pid),
    inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    reap: (owner) => {
      reaped.push(owner.pid); alive.delete(owner.pid);
      return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'test reap', signals: ['SIGTERM'] };
    },
    outcome: () => outcome, wait: () => { now += 10; }, onIteration: () => { outcome = 'launched'; },
  });
  assert.deepEqual(reaped, [72000, 72001]);
  assert.equal(result.executor_generation, 2);
  assert.equal(result.replacement_count, 1);
});

test('ambiguous expired executor reap preserves the old fence and prevents replacement', () => {
  const value = fixture();
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    now: () => now, managerIdentity: identity(70011), leaseMs: 1_000, pollMs: 10,
    spawnExecutor: () => 73000, capture: (pid) => identity(pid), inspect: () => 'matched',
    outcome: () => 'running', onIteration: () => { throw new Error('manager-crash'); },
  }), /manager-crash/);
  now += 2_000;
  let replacements = 0;
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    now: () => now, managerIdentity: identity(70012), leaseMs: 1_000, pollMs: 10,
    spawnExecutor: () => { replacements += 1; return 73001; }, capture: (pid) => identity(pid), inspect: () => 'matched',
    reap: (owner) => ({ status: 'ambiguous', pid: owner.pid, pgid: owner.pgid,
      reason: 'identity could not be proven', signals: [] }), outcome: () => 'running',
  }), /could not be safely reaped: ambiguous/);
  assert.equal(replacements, 0);
  const status = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), 'utf8'));
  assert.equal(status.executor_identity.pid, 73000);
  assert.equal(status.executor_generation, 1);
  assert.equal(status.status, 'supervising');
});

test('signal-failed terminal cleanup cannot publish false launched convergence', () => {
  const value = fixture();
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70013), leaseMs: 30_000, pollMs: 10,
    spawnExecutor: () => 74000, capture: (pid) => identity(pid), inspect: () => 'matched',
    outcome: () => 'running', onIteration: () => { throw new Error('manager-crash'); },
  }), /manager-crash/);
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70014), inspect: () => 'matched', outcome: () => 'launched',
    reap: (owner) => ({ status: 'signal-failed', pid: owner.pid, pgid: owner.pgid,
      reason: 'SIGKILL denied', signals: ['SIGTERM', 'SIGKILL'] }),
  }), /could not be safely reaped: signal-failed/);
  const status = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), 'utf8'));
  assert.equal(status.status, 'supervising');
  assert.equal(status.executor_identity.pid, 74000);
});

test('terminal and cancelled sessions converge without spawning an executor', () => {
  for (const outcome of ['terminal', 'cancelled']) {
    const value = fixture();
    const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
      managerIdentity: identity(70003), outcome: () => outcome,
      spawnExecutor: () => assert.fail('terminal supervision must not spawn'),
    });
    assert.equal(result.status, outcome);
    assert.equal(result.executor_identity, null);
  }
});

test('live supervisor fence refuses a duplicate manager and launcher', () => {
  const value = fixture();
  const statusPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE);
  const owner = new StateManager();
  owner.acquireLock(statusPath);
  try {
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      managerIdentity: identity(70004), outcome: () => 'running',
      spawnExecutor: () => assert.fail('duplicate manager must not launch'),
    }), /Failed to acquire lock/);
  } finally {
    owner.releaseLock(statusPath);
  }
});

test('executor supervision telemetry remains outside the migration seal', () => {
  const value = fixture();
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), { schema_version: 1, status: 'supervising' });
  const runtime = { runtime_id: 'test', version: '1', build_hash: 'hash', min_state_schema: 1, max_state_schema: 1 };
  const migration = prepareLiveSessionMigration(value.sessionDir, runtime, runtime);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === LEGACY_ADOPTION_EXECUTOR_FILE), false);
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), { schema_version: 1, status: 'launched' });
  assert.doesNotThrow(() => verifyLiveSessionMigration(value.sessionDir, migration));
});
