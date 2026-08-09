// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_EXECUTOR_FILE,
  LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE,
  LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX,
  LEGACY_ADOPTION_EXECUTOR_RESTART_FILE,
  LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE,
  publishLegacyAdoptionExecutorRestart,
  requestLegacyAdoptionExecutorRestart,
  runLegacyAdoptionExecutorSupervisor,
} from '../services/legacy-adoption-executor-supervisor.js';
import { prepareLiveSessionMigration, verifyLiveSessionMigration } from '../services/live-session-migration.js';
import { captureProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { StateManager } from '../services/state-manager.js';

function identity(pid) {
  return { pid, pgid: pid, start_time: `start-${pid}`, fingerprint: `fingerprint-${pid}` };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
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
  assert.equal(result.manager_generation, 1);
  assert.equal(result.replacement_count, 1);
});

test('authenticated strategy restart request is acknowledged by the next executor generation', () => {
  const value = fixture();
  let nextPid = 75000;
  let outcome = 'running';
  let request = null;
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70020), spawnExecutor: () => nextPid++, capture: (pid) => identity(pid),
    inspect: () => 'matched', wait: () => undefined, outcome: () => outcome,
    reap: (owner) => ({ status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'requested', signals: ['SIGTERM'] }),
    onIteration: (status) => {
      if (status.executor_generation === 1 && !request) {
        request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'strategy changed', status);
      } else if (status.executor_generation === 2) outcome = 'launched';
    },
  });
  assert.equal(result.executor_generation, 2);
  assert.equal(result.manager_generation, 1);
  assert.equal(result.last_restart_request_id, request.request_id);
  assert.equal(result.replacement_count, 1);
});

test('restart publication is idempotent, preserves conflicts, and cancellation dominates publication', () => {
  const value = fixture();
  const restartPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE);
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70022), spawnExecutor: () => 75200, capture: (pid) => identity(pid),
    inspect: () => 'matched', wait: () => undefined, outcome: () => 'running',
    onIteration: (status) => {
      const first = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'same intent', status);
      const second = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'ignored duplicate reason', status);
      assert.deepEqual(second, first);

      const conflict = {
        ...first, request_id: 'foreign-request', expected_generation: first.expected_generation + 1,
      };
      writeJson(restartPath, conflict);
      assert.throws(
        () => requestLegacyAdoptionExecutorRestart(value.sessionDir, 'must not overwrite', status),
        /Conflicting legacy adoption executor restart request/,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(restartPath, 'utf8')), conflict);

      fs.unlinkSync(restartPath);
      writeJson(path.join(value.sessionDir, 'state.json'), {
        schema_version: 1, active: false, cancelled: true, working_dir: value.sessionDir,
        history: [], current_ticket: null, step: 'cancelled',
      });
      assert.throws(
        () => requestLegacyAdoptionExecutorRestart(value.sessionDir, 'cancelled request', status),
        /Cancelled legacy adoption cannot publish/,
      );
      assert.equal(fs.existsSync(restartPath), false);
      throw new Error('idempotency-witness-complete');
    },
  }), /idempotency-witness-complete/);
});

test('thirty publishers use one atomic create and never overwrite the winning UUID', async () => {
  const value = fixture();
  const status = {
    schema_version: 1, session_id: path.basename(value.sessionDir), status: 'supervising',
    manager_identity: identity(70023), manager_generation: 1, manager_parent_pid: 70000,
    manager_argv_sha256: 'a'.repeat(64), owner_nonce: 'owner', executor_identity: identity(75210),
    executor_generation: 1, executor_started_at: new Date().toISOString(),
    executor_lease_expires_at: new Date(Date.now() + 60_000).toISOString(), executor_spec_sha256: 'b'.repeat(64),
    replacement_count: 0, last_loss_at: null, last_restart_request_id: null, updated_at: new Date().toISOString(),
  };
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), status);
  const barrier = path.join(value.sessionDir, 'publisher-barrier');
  const workerPath = path.join(value.sessionDir, 'publisher.mjs');
  const supervisorModule = new URL('../services/legacy-adoption-executor-supervisor.js', import.meta.url).href;
  fs.writeFileSync(workerPath, `
import fs from 'node:fs';
const [moduleUrl, sessionDir, barrier, index] = process.argv.slice(2);
const { prepareLegacyAdoptionExecutorRestart, publishLegacyAdoptionExecutorRestart, readLegacyAdoptionExecutorStatus } = await import(moduleUrl);
while (!fs.existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const status = readLegacyAdoptionExecutorStatus(sessionDir);
const request = prepareLegacyAdoptionExecutorRestart(status, 'barrier', {
  requestId: 'publisher-' + index, requestedAt: '2026-08-09T00:00:00.000Z',
});
try {
  const result = publishLegacyAdoptionExecutorRestart(sessionDir, request, status);
  process.stdout.write(JSON.stringify({ ok: true, request_id: result.request_id }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
`);
  const children = Array.from({ length: 30 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, supervisorModule, value.sessionDir, barrier, String(index)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`publisher ${index} exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  }));
  fs.writeFileSync(barrier, 'go');
  const results = await Promise.all(children);
  const successes = results.filter((result) => result.ok);
  const conflicts = results.filter((result) => !result.ok);
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 29);
  assert.ok(conflicts.every((result) => /Conflicting legacy adoption executor restart request/.test(result.error)));
  const persisted = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), 'utf8',
  ));
  assert.equal(persisted.request_id, successes[0].request_id);
});

test('atomic publication falls back to exclusive create when hard links are unsupported', () => {
  const value = fixture();
  const originalLink = fs.linkSync;
  let request = null;
  fs.linkSync = () => {
    const error = new Error('hard links unsupported');
    error.code = 'ENOTSUP';
    throw error;
  };
  try {
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      managerIdentity: identity(70028), spawnExecutor: () => 75220, capture: (pid) => identity(pid),
      inspect: () => 'matched', outcome: () => 'running', wait: () => undefined,
      onIteration: (status) => {
        request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'portable fallback', status);
        throw new Error('fallback-witness');
      },
    }), /fallback-witness/);
  } finally {
    fs.linkSync = originalLink;
  }
  const persisted = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), 'utf8',
  ));
  assert.equal(persisted.request_id, request.request_id);
});

test('publication scavenges orphan temp files and bounds accepted-WAL quarantines', () => {
  const value = fixture();
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(
      value.sessionDir, `.${LEGACY_ADOPTION_EXECUTOR_RESTART_FILE}.999.${index}.publish`,
    ), 'orphan');
  }
  for (let index = 0; index < 30; index += 1) {
    fs.writeFileSync(path.join(
      value.sessionDir, `${LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX}${index}`,
    ), 'quarantine');
  }
  let request = null;
  let authenticated = null;
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70029), spawnExecutor: () => 75230, capture: (pid) => identity(pid),
    inspect: () => 'matched', outcome: () => 'running', wait: () => undefined,
    onIteration: (status) => {
      authenticated = status;
      request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'scavenge', status);
      throw new Error('scavenge-witness');
    },
  }), /scavenge-witness/);
  publishLegacyAdoptionExecutorRestart(value.sessionDir, request, authenticated);
  const entries = fs.readdirSync(value.sessionDir);
  assert.equal(entries.filter((entry) => entry.startsWith(`.${LEGACY_ADOPTION_EXECUTOR_RESTART_FILE}.`)
    && entry.endsWith('.publish')).length, 0);
  assert.equal(entries.filter((entry) => (
    entry.startsWith(LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX)
  )).length, 16);
});

test('accepted WAL tampering is quarantined without deleting the external request or writing an ACK', () => {
  for (const [name, mutate] of [
    ['request-id', (accepted) => { accepted.request.request_id = 'tampered-request'; }],
    ['stage', (accepted) => { accepted.stage = 'committed'; }],
    ['predecessor-identity', (accepted) => { accepted.predecessor_identity.fingerprint = 'unrelated-process'; }],
  ]) {
    const value = fixture();
    const alive = new Set();
    let request = null;
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      managerIdentity: identity(70024), spawnExecutor: () => { alive.add(75300); return 75300; },
      capture: (pid) => identity(pid), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
      outcome: () => 'running', wait: () => undefined,
      onIteration: (status) => { request ||= requestLegacyAdoptionExecutorRestart(value.sessionDir, name, status); },
      checkpoint: (point) => { if (point === 'restart_accepted') throw new Error('accepted-crash'); },
    }), /accepted-crash/);
    const acceptedPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE);
    const tampered = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
    mutate(tampered);
    writeJson(acceptedPath, tampered);
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      managerIdentity: identity(70025), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
      spawnExecutor: () => assert.fail('tampered WAL must not launch'), outcome: () => 'running',
    }), /invalid and was quarantined/);
    assert.equal(fs.existsSync(acceptedPath), false, name);
    const quarantine = fs.readdirSync(value.sessionDir)
      .find((entry) => entry.startsWith(LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX));
    assert.ok(quarantine, name);
    const persistedRequest = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), 'utf8',
    ));
    assert.equal(persistedRequest.request_id, request.request_id, name);
    assert.equal(JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), 'utf8',
    )).last_restart_request_id, null, name);
  }
});

test('self-sealed WAL for an unrelated predecessor fails its persisted-status genesis fence', () => {
  const value = fixture();
  const alive = new Set();
  let request = null;
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70026), spawnExecutor: () => { alive.add(75400); return 75400; },
    capture: (pid) => identity(pid), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    outcome: () => 'running', wait: () => undefined,
    onIteration: (status) => { request ||= requestLegacyAdoptionExecutorRestart(value.sessionDir, 'genesis', status); },
    checkpoint: (point) => { if (point === 'restart_accepted') throw new Error('accepted-crash'); },
  }), /accepted-crash/);
  const acceptedPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE);
  const forged = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
  forged.predecessor_identity = identity(99991);
  forged.request.expected_executor_fingerprint = forged.predecessor_identity.fingerprint;
  forged.authenticated_status.executor_identity = forged.predecessor_identity;
  forged.integrity_chain = [];
  const record = { ...forged };
  delete record.integrity_chain;
  const recordHash = crypto.createHash('sha256').update(canonicalJson(record)).digest('hex');
  const transitionHash = crypto.createHash('sha256').update(canonicalJson({
    domain: 'pickle-rick-legacy-adoption-restart-v1', stage: 'accepted',
    previous_sha256: null, record_sha256: recordHash,
  })).digest('hex');
  forged.integrity_chain = [{
    stage: 'accepted', previous_sha256: null, record_sha256: recordHash, transition_sha256: transitionHash,
    record,
  }];
  writeJson(acceptedPath, forged);
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), forged.request);
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70027), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    spawnExecutor: () => assert.fail('forged genesis must not launch'), outcome: () => 'running',
  }), /lost its authenticated status\/request genesis/);
  assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE)), true);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), 'utf8',
  )).last_restart_request_id, null);
});

test('self-sealed forged later-stage WAL is quarantined before running or cancellation can signal it', () => {
  for (const outcome of ['running', 'cancelled']) {
    const value = fixture();
    const alive = new Set();
    const exactExecutors = new Set();
    const reaped = [];
    let nextPid = 75500;
    let request = null;
    const common = {
      managerIdentity: identity(70034),
      spawnExecutor: () => {
        const pid = nextPid++;
        alive.add(pid);
        exactExecutors.add(pid);
        return pid;
      },
      capture: (pid) => identity(pid),
      inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
      discoverExecutors: () => [...exactExecutors].filter((pid) => alive.has(pid)).map(identity),
      reap: (owner) => {
        reaped.push(owner.pid);
        alive.delete(owner.pid);
        return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'test', signals: ['SIGTERM'] };
      },
      outcome: () => 'running', wait: () => undefined,
    };
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      ...common,
      onIteration: (status) => {
        request ||= requestLegacyAdoptionExecutorRestart(value.sessionDir, 'later-stage forge', status);
      },
      checkpoint: (point) => { if (point === 'restart_successor_persisted') throw new Error('captured-crash'); },
    }), /captured-crash/);
    const acceptedPath = path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE);
    const forged = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
    const unrelated = identity(99992);
    alive.add(unrelated.pid);
    forged.successor_identity = unrelated;
    const last = forged.integrity_chain.at(-1);
    const record = { ...forged };
    delete record.integrity_chain;
    last.record = JSON.parse(JSON.stringify(record));
    last.record_sha256 = crypto.createHash('sha256').update(canonicalJson(last.record)).digest('hex');
    last.transition_sha256 = crypto.createHash('sha256').update(canonicalJson({
      domain: 'pickle-rick-legacy-adoption-restart-v1', stage: last.stage,
      previous_sha256: last.previous_sha256, record_sha256: last.record_sha256,
    })).digest('hex');
    writeJson(acceptedPath, forged);
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      ...common, managerIdentity: identity(70035), outcome: () => outcome,
      spawnExecutor: () => assert.fail('forged later-stage WAL must not launch'),
    }), /not bound to the exact executor spec/);
    assert.deepEqual(reaped, [75500], 'only the legitimate predecessor was reaped before the forged crash image');
    assert.equal(alive.has(unrelated.pid), true, 'forged unrelated process must be preserved');
    assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE)), true);
    assert.equal(JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), 'utf8',
    )).last_restart_request_id, null);
  }
});

test('accepted restart WAL reconciles every manager crash stage without duplicate replacement', () => {
  const crashPoints = [
    'restart_accepted',
    'restart_predecessor_stopped',
    'restart_predecessor_reap_persisted',
    'restart_launch_persisted',
    'restart_successor_started',
    'restart_successor_persisted',
    'restart_status_committed',
    'restart_cleanup_committed',
  ];
  for (const crashPoint of crashPoints) {
    const value = fixture();
    const alive = new Set();
    const spawned = [];
    const predecessorReaps = [];
    let nextPid = 76000;
    let request = null;
    const common = {
      leaseMs: 30_000, pollMs: 10,
      spawnExecutor: () => { const pid = nextPid++; spawned.push(pid); alive.add(pid); return pid; },
      capture: (pid) => identity(pid),
      inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
      discoverExecutors: () => [...alive].map(identity),
      reap: (owner) => {
        if (alive.delete(owner.pid) && owner.pid === 76000) predecessorReaps.push(owner.pid);
        return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'test reap', signals: ['SIGTERM'] };
      },
      outcome: () => 'running', wait: () => undefined,
    };
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
      ...common, managerIdentity: identity(70030),
      onIteration: (status) => {
        if (!request) request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'fault injection', status);
      },
      checkpoint: (point) => { if (point === crashPoint) throw new Error(`crash:${point}`); },
    }), new RegExp(`crash:${crashPoint}`));

    let outcome = 'running';
    const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
      ...common, managerIdentity: identity(70031), outcome: () => outcome,
      onIteration: () => { outcome = 'launched'; },
    });
    assert.equal(result.executor_generation, 2, crashPoint);
    assert.equal(result.replacement_count, 1, crashPoint);
    assert.equal(result.last_restart_request_id, request.request_id, crashPoint);
    assert.deepEqual(spawned, [76000, 76001], crashPoint);
    assert.deepEqual(predecessorReaps, [76000], crashPoint);
    assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE)), false, crashPoint);
    const accepted = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE), 'utf8',
    ));
    assert.equal(accepted.stage, 'committed', crashPoint);
    assert.equal(accepted.request.request_id, request.request_id, crashPoint);
  }
});

test('dead captured successor is durably requeued and relaunched under the same request UUID', () => {
  const value = fixture();
  const alive = new Set();
  const spawned = [];
  let nextPid = 76500;
  let request = null;
  const common = {
    leaseMs: 30_000, pollMs: 10,
    spawnExecutor: () => { const pid = nextPid++; spawned.push(pid); alive.add(pid); return pid; },
    capture: (pid) => identity(pid), inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
    discoverExecutors: () => [...alive].map(identity),
    reap: (owner) => {
      alive.delete(owner.pid);
      return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'test reap', signals: ['SIGTERM'] };
    },
    outcome: () => 'running', wait: () => undefined,
  };
  assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), {
    ...common, managerIdentity: identity(70032),
    onIteration: (status) => { request ||= requestLegacyAdoptionExecutorRestart(value.sessionDir, 'dead successor', status); },
    checkpoint: (point) => { if (point === 'restart_successor_persisted') throw new Error('successor-crash'); },
  }), /successor-crash/);
  assert.deepEqual(spawned, [76500, 76501]);
  alive.delete(76501);
  let outcome = 'running';
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    ...common, managerIdentity: identity(70033), outcome: () => outcome,
    onIteration: () => { outcome = 'launched'; },
  });
  assert.deepEqual(spawned, [76500, 76501, 76502]);
  assert.equal(result.last_restart_request_id, request.request_id);
  const committed = JSON.parse(fs.readFileSync(
    path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE), 'utf8',
  ));
  assert.equal(committed.stage, 'committed');
  assert.equal(committed.successor_identity.pid, 76502);
  assert.deepEqual(committed.integrity_chain.map((entry) => entry.stage), [
    'accepted', 'predecessor_reaped', 'launch_pending', 'successor_captured',
    'launch_pending', 'successor_captured', 'committed',
  ]);
});

test('cancellation during accepted restart reaps ownership and never launches a successor', () => {
  for (const crashPoint of ['restart_accepted', 'restart_launch_persisted']) {
    const value = fixture();
    const alive = new Set();
    const spawned = [];
    let nextPid = 77000;
    let request = null;
    const common = {
      managerIdentity: identity(70040), leaseMs: 30_000, pollMs: 10,
      spawnExecutor: () => { const pid = nextPid++; spawned.push(pid); alive.add(pid); return pid; },
      capture: (pid) => identity(pid),
      inspect: (owner) => alive.has(owner.pid) ? 'matched' : 'not-running',
      discoverExecutors: () => [...alive].map(identity),
      reap: (owner) => {
        alive.delete(owner.pid);
        return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'terminal', signals: ['SIGTERM'] };
      },
      outcome: () => 'running', wait: () => undefined,
      onIteration: (status) => {
        if (!request) request = requestLegacyAdoptionExecutorRestart(value.sessionDir, 'cancel race', status);
      },
      checkpoint: (point) => { if (point === crashPoint) throw new Error(`crash:${point}`); },
    };
    assert.throws(() => runLegacyAdoptionExecutorSupervisor(spec(value), common), new RegExp(`crash:${crashPoint}`));
    let outcomeChecks = 0;
    const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
      ...common, managerIdentity: identity(70041), checkpoint: undefined, onIteration: undefined,
      outcome: () => (++outcomeChecks === 1 ? 'running' : 'cancelled'),
    });
    assert.equal(result.status, 'cancelled', crashPoint);
    assert.deepEqual(spawned, [77000], crashPoint);
    assert.equal(result.executor_generation, 1, crashPoint);
    assert.equal(result.replacement_count, crashPoint === 'restart_launch_persisted' ? 1 : 0, crashPoint);
    assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE)), false, crashPoint);
    assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE)), false, crashPoint);
    const rejected = JSON.parse(fs.readFileSync(
      path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), 'utf8',
    ));
    assert.equal(rejected.request_id, request.request_id, crashPoint);
    assert.match(rejected.rejection_reason, /cancelled/, crashPoint);
  }
});

test('stale mismatched restart request is quarantined without replacing the live executor', () => {
  const value = fixture();
  let iterations = 0;
  let outcome = 'running';
  const reaped = [];
  const result = runLegacyAdoptionExecutorSupervisor(spec(value), {
    managerIdentity: identity(70021), spawnExecutor: () => 75100, capture: (pid) => identity(pid),
    inspect: () => 'matched', wait: () => undefined, outcome: () => outcome,
    reap: (owner) => {
      reaped.push(owner.pid);
      return { status: 'reaped', pid: owner.pid, pgid: owner.pgid, reason: 'terminal', signals: ['SIGTERM'] };
    },
    onIteration: (status) => {
      iterations += 1;
      if (iterations === 1) {
        writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), {
          schema_version: 1, request_id: 'stale-request', expected_generation: status.executor_generation - 1,
          expected_executor_fingerprint: 'foreign-fingerprint', reason: 'stale', requested_at: new Date().toISOString(),
        });
      } else outcome = 'launched';
    },
  });
  assert.equal(result.executor_generation, 1);
  assert.equal(result.replacement_count, 0);
  assert.deepEqual(reaped, [75100]);
  assert.equal(fs.existsSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE)), false);
  const rejected = JSON.parse(fs.readFileSync(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), 'utf8'));
  assert.equal(rejected.request_id, 'stale-request');
  assert.match(rejected.rejection_reason, /authenticated executor generation/);
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
  assert.equal(result.manager_generation, 2);
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
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE), { stage: 'accepted' });
  const quarantinePath = path.join(
    value.sessionDir, `${LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX}fixture`,
  );
  const publishPath = path.join(
    value.sessionDir, `.${LEGACY_ADOPTION_EXECUTOR_RESTART_FILE}.999.fixture.publish`,
  );
  writeJson(quarantinePath, { quarantined: true });
  fs.writeFileSync(publishPath, 'pending');
  const runtime = { runtime_id: 'test', version: '1', build_hash: 'hash', min_state_schema: 1, max_state_schema: 1 };
  const migration = prepareLiveSessionMigration(value.sessionDir, runtime, runtime);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === LEGACY_ADOPTION_EXECUTOR_FILE), false);
  assert.equal(migration.preserved_artifacts.some(
    (artifact) => artifact.path === LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE,
  ), false);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === path.basename(quarantinePath)), false);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === path.basename(publishPath)), false);
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), { schema_version: 1, status: 'launched' });
  writeJson(path.join(value.sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE), { stage: 'committed' });
  writeJson(quarantinePath, { quarantined: 'changed' });
  fs.writeFileSync(publishPath, 'changed');
  assert.doesNotThrow(() => verifyLiveSessionMigration(value.sessionDir, migration));
});
