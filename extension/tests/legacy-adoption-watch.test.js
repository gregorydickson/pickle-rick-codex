// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_WATCH_STATUS_FILE,
  legacyAdoptionWatchDelayMs,
  runLegacyAdoptionWatch,
} from '../bin/adopt-legacy-session.js';
import { prepareLiveSessionMigration, verifyLiveSessionMigration } from '../services/live-session-migration.js';
import {
  adoptionWatchStrategyStateLaunched,
  beginAdoptionWatchStrategy,
  createAdoptionWatchStrategyState,
  finishAdoptionWatchStrategy,
  validateAdoptionWatchStrategyState,
} from '../services/adoption-watch-strategies.js';

function descriptor() {
  return {
    runtime_id: 'pickle-rick-codex:test', version: '1.0.0', build_hash: 'abc',
    min_state_schema: 1, max_state_schema: 1,
  };
}

function record(status = 'adopted') {
  return {
    schema_version: 1, status, session_id: 'session', source_runtime: descriptor(), target_runtime: descriptor(),
    migration_content_hash: 'hash', resume_checkpoint: { ticket_id: 'T1', phase: 'repair', reuse_phases: [], reason: 'test', history_length: 0 },
    legacy_owner: { runner: {}, supervisor: null, pane: {}, tmux_session_name: 'tmux', operation_lock_pid: 1, active_child: null },
    adopted_at: '2026-01-01T00:00:00.000Z', candidate_archive: { paths: [], staged_paths: [], ref: null },
    ...(status === 'launched' ? { launched_at: '2026-01-01T00:00:01.000Z', launched_runtime_root: '/runtime' } : {}),
  };
}

function args(sessionDir) {
  return { sessionDir, sourceRuntimeRoot: '/source', targetRuntimeRoot: '/target', validationSessionDir: '' };
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function rehashForgedStrategyState(state) {
  let previous = state.history_base_checkpoint.previous_hash;
  for (const entry of state.history) {
    entry.material_hash = stableHash({
      strategy_id: entry.strategy_id, evidence_hash: entry.evidence_hash, epoch_seed: entry.epoch_seed,
    });
    entry.previous_hash = previous;
    const { entry_hash: _entryHash, ...payload } = entry;
    entry.entry_hash = stableHash(payload);
    previous = entry.entry_hash;
  }
  state.state_hash = stableHash({
    schema_version: state.schema_version, epoch: state.epoch, cursor: state.cursor,
    epoch_seed: state.epoch_seed, history_base_checkpoint: state.history_base_checkpoint,
    history_head_hash: state.history.at(-1)?.entry_hash || state.history_base_checkpoint.previous_hash,
    active: state.active,
  });
  return state;
}

function strategyFailures(count) {
  let state = createAdoptionWatchStrategyState('session', 'a'.repeat(64));
  for (let index = 0; index < count; index += 1) {
    const timestamp = new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString();
    state = beginAdoptionWatchStrategy(state, 'a'.repeat(64), timestamp).state;
    state = finishAdoptionWatchStrategy(state, 'failed', 'persistent', timestamp);
  }
  return state;
}

test('legacy adoption watcher backoff progresses exponentially and respects its jittered cap', () => {
  const options = { baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0.2, random: () => 0.5 };
  assert.deepEqual([1, 2, 3, 4, 5, 20].map((attempt) => legacyAdoptionWatchDelayMs(attempt, options)),
    [250, 500, 1_000, 2_000, 2_000, 2_000]);
  assert.equal(legacyAdoptionWatchDelayMs(20, { ...options, random: () => 1 }), 2_000);
});

test('legacy adoption watcher durably exposes typed failures with bounded retry timing', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-failure-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const waits = [];
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 1_000, maxDelayMs: 2_000,
    adopt: () => { throw new Error('Live session migration continuity failed for state.json.'); },
    wait: (delay) => { waits.push(delay); now += delay; if (waits.length === 3) throw new Error('test-stop'); },
  }), /test-stop/);

  assert.deepEqual(waits, [1_000, 2_000, 2_000]);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.status, 'retrying');
  assert.equal(status.attempt_count, 3);
  assert.equal(status.consecutive_failures, 3);
  assert.equal(status.retry_delay_ms, 2_000);
  assert.equal(status.strategy_state.history[0].failure_signature.startsWith('migration-continuity-failed:'), true);
  assert.equal(status.last_failure.kind, 'launch-failed');
  assert.equal(status.last_failure.recoverable, true);
  assert.match(status.strategy_state.history[0].failure_signature, /state\.json/);
});

test('legacy adoption watcher retains failure evidence and converges after recovery', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-recovery-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let attempts = 0;
  const waits = [];
  const launched = record('launched');
  const result = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 100, maxDelayMs: 1_000,
    wait: (delay) => { waits.push(delay); now += delay; },
    executeStrategy: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('target runtime is temporarily unavailable');
      return launched;
    },
  });

  assert.equal(result.status, 'launched');
  assert.deepEqual(waits, [100, 200]);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.status, 'launched');
  assert.equal(status.attempt_count, 3);
  assert.equal(status.consecutive_failures, 0);
  assert.equal(status.last_failure.kind, 'runtime-mismatch');
  assert.equal(status.launched_runtime_root, '/runtime');
});

test('legacy adoption watcher observes another launcher without issuing a duplicate launch', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-converged-');
  const launched = record('launched');
  writeJson(path.join(sessionDir, 'legacy-session-adoption.json'), launched);
  const result = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => Date.parse('2026-01-01T00:00:02.000Z'),
    adopt: () => assert.fail('must not adopt after another owner launched'),
    launch: () => assert.fail('must not issue a duplicate launch'),
    wait: () => assert.fail('must converge immediately'),
  });

  assert.equal(result.status, 'launched');
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.status, 'launched');
  assert.equal(status.attempt_count, 0);
});

test('watcher status remains mutable control telemetry outside the sealed migration inventory', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-inventory-');
  const repo = makeTempRoot('pickle-adoption-watch-repo-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, current_ticket: null, step: 'readiness', history: [], working_dir: repo,
  });
  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), { status: 'watching', attempt_count: 0 });
  const runtime = descriptor();
  const migration = prepareLiveSessionMigration(sessionDir, runtime, runtime);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === LEGACY_ADOPTION_WATCH_STATUS_FILE), false);

  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
    status: 'retrying', attempt_count: 10, last_failure: { kind: 'migration-continuity-failed' },
  });
  assert.doesNotThrow(() => verifyLiveSessionMigration(sessionDir, migration));
});

test('malformed persisted counters and schema are replaced by typed recoverable status before retry', () => {
  for (const malformed of [
    { schema_version: 2 },
    {
      schema_version: 1, status: 'retrying', session_id: 'wrong', watcher_pid: 1,
      started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      attempt_count: 'many', consecutive_failures: 'several', last_attempt_at: null,
      next_retry_at: '2026-01-01T00:00:01.000Z', retry_delay_ms: 1_000,
      last_failure: null, launched_runtime_root: null,
    },
  ]) {
    const sessionDir = makeTempRoot('pickle-adoption-watch-malformed-');
    writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), malformed);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const waits = [];
    const launched = record('launched');
    runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, random: () => 0.5, baseDelayMs: 500, maxDelayMs: 2_000,
      wait: (delay) => { waits.push(delay); now += delay; },
      adopt: () => record('adopted'), chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
      launch: () => launched,
    });
    assert.deepEqual(waits, [500]);
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(status.status, 'launched');
    assert.equal(status.attempt_count, 1);
    assert.equal(status.last_failure.kind, 'watch-status-invalid');
    assert.match(status.last_failure.message, /Malformed persisted adoption watchdog status/);
  }
});

test('invalid persisted timestamps cannot throw or bypass the safe retry delay', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-invalid-time-');
  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
    schema_version: 1, status: 'retrying', session_id: path.basename(sessionDir), watcher_pid: 1,
    started_at: 'not-a-date', updated_at: 'also-not-a-date', attempt_count: 999, consecutive_failures: 999,
    last_attempt_at: null, next_retry_at: 'invalid', retry_delay_ms: 1,
    last_failure: null, launched_runtime_root: null,
  });
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const waits = [];
  const result = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 750, maxDelayMs: 3_000,
    wait: (delay) => { waits.push(delay); now += delay; },
    adopt: () => record('adopted'), chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
    launch: () => record('launched'),
  });
  assert.equal(result.status, 'launched');
  assert.deepEqual(waits, [750]);
});

test('valid persisted retry deadline is honored before the next numbered attempt', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-valid-restart-');
  const firstObserved = '2026-01-01T00:00:00.000Z';
  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
    schema_version: 1, status: 'retrying', session_id: path.basename(sessionDir), watcher_pid: 99,
    started_at: firstObserved, updated_at: firstObserved, attempt_count: 4, consecutive_failures: 4,
    last_attempt_at: firstObserved, retry_scheduled_at: '2026-01-01T00:00:02.000Z',
    next_retry_at: '2026-01-01T00:00:10.000Z', retry_delay_ms: 8_000,
    last_failure: {
      kind: 'adoption-failed', name: 'Error', message: 'temporary failure', recoverable: true,
      first_observed_at: firstObserved, last_observed_at: firstObserved,
    },
    launched_runtime_root: null,
  });
  let now = Date.parse('2026-01-01T00:00:07.000Z');
  const waits = [];
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, wait: (delay) => { waits.push(delay); now += delay; },
    adopt: () => record('adopted'), chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
    launch: () => record('launched'),
  });
  assert.deepEqual(waits, [3_000]);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.attempt_count, 5);
  assert.equal(status.started_at, firstObserved);
});

test('far-future and delay-inconsistent persisted deadlines are reclassified and bounded', () => {
  const cases = [
    { next_retry_at: '2099-01-01T00:00:01.000Z', retry_delay_ms: 1_000 },
    {
      retry_scheduled_at: '2099-01-01T00:00:00.000Z',
      next_retry_at: '2099-01-01T00:00:01.000Z', retry_delay_ms: 1_000,
    },
    { next_retry_at: '2026-01-01T00:00:01.000Z', retry_delay_ms: 2_000 },
    { next_retry_at: '2026-01-01T00:02:00.000Z', retry_delay_ms: 120_000 },
  ];
  for (const retry of cases) {
    const sessionDir = makeTempRoot('pickle-adoption-watch-deadline-');
    const scheduledAt = '2026-01-01T00:00:00.000Z';
    writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
      schema_version: 1, status: 'retrying', session_id: path.basename(sessionDir), watcher_pid: 1,
      started_at: scheduledAt, updated_at: scheduledAt, attempt_count: 1, consecutive_failures: 1,
      last_attempt_at: scheduledAt, retry_scheduled_at: scheduledAt, ...retry,
      last_failure: {
        kind: 'adoption-failed', name: 'Error', message: 'temporary failure', recoverable: true,
        first_observed_at: scheduledAt, last_observed_at: scheduledAt,
      },
      launched_runtime_root: null,
    });
    let now = Date.parse(scheduledAt);
    const waits = [];
    runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, random: () => 0.5, baseDelayMs: 500, maxDelayMs: 2_000,
      wait: (delay) => { waits.push(delay); now += delay; },
      adopt: () => record('adopted'), chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
      launch: () => record('launched'),
    });
    assert.deepEqual(waits, [500]);
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(status.last_failure.kind, 'watch-status-invalid');
    assert.ok(status.retry_delay_ms === null);
  }
});

test('persistent failure executes three material strategies and schedules a new evidence-bound epoch', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-strategies-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const routes = [];
  const waits = [];
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: (strategyId) => { routes.push(strategyId); throw new Error('persistent no progress'); },
    wait: (delay) => { waits.push(delay); now += delay; if (waits.length === 4) throw new Error('test-stop'); },
  }), /test-stop/);

  assert.deepEqual(routes.slice(0, 3), [
    'standard-adopt-launch',
    'authenticated-runtime-revalidation',
    'sealed-launch-transaction-reconstruction',
  ]);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.status, 'retrying');
  assert.equal(status.strategy_state.epoch, 2);
  assert.equal(status.strategy_state.history.length, 4);
  assert.equal(new Set(status.strategy_state.history.slice(0, 3).map((entry) => entry.material_hash)).size, 3);
  assert.notEqual(status.strategy_state.history[0].material_hash, status.strategy_state.history[3].material_hash);
  assert.ok(Date.parse(status.next_retry_at) > now - status.retry_delay_ms);
});

test('production strategy routes execute distinct adoption, authentication, and reconstruction operations', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-real-routes-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let adoptCalls = 0;
  let launchCalls = 0;
  let runtimeChecks = 0;
  const adopted = record('adopted');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    adopt: () => {
      adoptCalls += 1;
      writeJson(path.join(sessionDir, 'legacy-session-adoption.json'), adopted);
      return adopted;
    },
    chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
    runtimeMatches: () => { runtimeChecks += 1; return true; },
    launch: () => { launchCalls += 1; throw new Error('persistent launch failure'); },
    wait: (delay) => { now += delay; if (launchCalls === 3) throw new Error('test-stop'); },
  }), /test-stop/);
  assert.equal(adoptCalls, 2, 'reconstruction consumes the durable record instead of adopting again');
  assert.equal(launchCalls, 3);
  assert.ok(runtimeChecks >= 2, 'authenticated route validates persisted and selected runtime identities');
});

test('strategy history survives a crash after durable dispatch and advances on restart', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-strategy-crash-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    checkpoint: () => { throw new Error('simulated-hard-crash'); },
    executeStrategy: () => assert.fail('crash happens before execution'),
  }), /simulated-hard-crash/);
  const crashed = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(crashed.strategy_state.active.strategy_id, 'standard-adopt-launch');

  const routes = [];
  const result = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: (delay) => { now += delay; },
    executeStrategy: (strategyId) => { routes.push(strategyId); return record('launched'); },
  });
  assert.equal(result.status, 'launched');
  assert.deepEqual(routes, ['authenticated-runtime-revalidation']);
  const recovered = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.deepEqual(recovered.strategy_state.history.map((entry) => entry.outcome), ['interrupted', 'launched']);
});

test('tampered strategy material is rejected and replaced with recoverable bounded state', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-strategy-tamper-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => { throw new Error('persistent'); },
    wait: () => { throw new Error('test-stop'); },
  }), /test-stop/);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
  const tampered = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  tampered.strategy_state.history[0].material_hash = '0'.repeat(64);
  writeJson(statusPath, tampered);
  const waits = [];
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: (delay) => { waits.push(delay); now += delay; },
    executeStrategy: () => record('launched'),
  });
  const repaired = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.deepEqual(waits, [10]);
  assert.equal(repaired.last_failure.kind, 'watch-status-invalid');
  assert.equal(repaired.strategy_state.history.length, 1);
});

test('semantic replay rejects fully rehashed duplicate, reordered, and skipped strategies', () => {
  const probes = [
    (state) => { state.history[1].strategy_id = 'standard-adopt-launch'; },
    (state) => {
      state.history[0].strategy_id = 'authenticated-runtime-revalidation';
      state.history[1].strategy_id = 'standard-adopt-launch';
    },
    (state) => { state.history[1].strategy_id = 'sealed-launch-transaction-reconstruction'; },
  ];
  for (const mutate of probes) {
    const forged = structuredClone(strategyFailures(2));
    mutate(forged);
    rehashForgedStrategyState(forged);
    assert.match(validateAdoptionWatchStrategyState(forged), /strategy history entry|repeats/);
  }
});

test('semantic replay rejects rehashed forged epoch, seed, and cursor heads', () => {
  const probes = [
    (state) => { state.epoch += 1; },
    (state) => { state.epoch_seed = 'b'.repeat(64); },
    (state) => { state.cursor = 0; },
  ];
  for (const mutate of probes) {
    const forged = structuredClone(strategyFailures(2));
    mutate(forged);
    rehashForgedStrategyState(forged);
    assert.match(validateAdoptionWatchStrategyState(forged), /semantic history replay/);
  }
});

test('semantic base checkpoint validates a long history after bounded truncation', () => {
  const state = strategyFailures(100);
  assert.equal(state.history.length, 64);
  assert.equal(state.history_base_checkpoint.sequence, 36);
  assert.equal(state.epoch, 34);
  assert.equal(state.cursor, 1);
  assert.equal(validateAdoptionWatchStrategyState(state), null);
});

test('begin refuses a launched semantic state with unchanged or changed evidence', () => {
  let state = createAdoptionWatchStrategyState('session', 'a'.repeat(64));
  state = beginAdoptionWatchStrategy(state, 'a'.repeat(64), '2026-01-01T00:00:00.000Z').state;
  state = finishAdoptionWatchStrategy(state, 'launched', null, '2026-01-01T00:00:01.000Z');
  assert.equal(adoptionWatchStrategyStateLaunched(state), true);
  assert.throws(() => beginAdoptionWatchStrategy(
    state, 'a'.repeat(64), '2026-01-01T00:00:02.000Z',
  ), /already-launched/);
  assert.throws(() => beginAdoptionWatchStrategy(
    state, 'b'.repeat(64), '2026-01-01T00:00:02.000Z',
  ), /already-launched/);
});

test('missing authoritative launch record archives terminal state and restart converges without replay', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-terminal-recovery-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, executeStrategy: () => record('launched'),
  });
  const initiallyLaunched = JSON.parse(fs.readFileSync(
    path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8',
  ));
  assert.equal(initiallyLaunched.status, 'launched');

  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: () => { throw new Error('stop-after-terminal-boundary'); },
    executeStrategy: () => assert.fail('recovery boundary must be scheduled before execution'),
  }), /stop-after-terminal-boundary/);
  const recovered = JSON.parse(fs.readFileSync(
    path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8',
  ));
  assert.equal(recovered.status, 'retrying');
  assert.equal(recovered.last_failure.kind, 'terminal-inconsistency');
  assert.equal(recovered.strategy_state.epoch, initiallyLaunched.strategy_state.epoch + 1);
  assert.equal(recovered.terminal_recovery_refs.length, 1);
  const archivePath = path.join(sessionDir, recovered.terminal_recovery_refs[0].path);
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.equal(archive.prior_state_hash, initiallyLaunched.strategy_state.state_hash);

  writeJson(path.join(sessionDir, 'legacy-session-adoption.json'), record('launched'));
  const converged = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    wait: () => assert.fail('authoritative launch convergence precedes scheduled retry'),
    executeStrategy: () => assert.fail('must not replay after authoritative convergence'),
  });
  assert.equal(converged.status, 'launched');
  const finalStatus = JSON.parse(fs.readFileSync(
    path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8',
  ));
  assert.equal(finalStatus.terminal_recovery_refs.length, 1);
});

test('tampered terminal recovery archive is rejected and replaced by bounded autonomous recovery', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-terminal-tamper-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  runLegacyAdoptionWatch(args(sessionDir), { now: () => now, executeStrategy: () => record('launched') });
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: () => { throw new Error('boundary-stop'); },
  }), /boundary-stop/);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
  const boundary = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const archivePath = path.join(sessionDir, boundary.terminal_recovery_refs[0].path);
  fs.appendFileSync(archivePath, 'tamper');
  const waits = [];
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: (delay) => { waits.push(delay); now += delay; },
    executeStrategy: () => record('launched'),
  });
  const repaired = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.deepEqual(waits, [10]);
  assert.equal(repaired.last_failure.kind, 'watch-status-invalid');
  assert.deepEqual(repaired.terminal_recovery_refs, []);
});
