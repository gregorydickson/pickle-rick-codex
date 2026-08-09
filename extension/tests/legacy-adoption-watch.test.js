// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LEGACY_ADOPTION_WATCH_STATUS_FILE,
  legacyAdoptionWatchDelayMs,
  runLegacyAdoptionWatch,
} from '../bin/adopt-legacy-session.js';
import { prepareLiveSessionMigration, verifyLiveSessionMigration } from '../services/live-session-migration.js';

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
  assert.equal(status.last_failure.kind, 'migration-continuity-failed');
  assert.equal(status.last_failure.recoverable, true);
  assert.match(status.last_failure.message, /state\.json/);
});

test('legacy adoption watcher retains failure evidence and converges after recovery', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-recovery-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let attempts = 0;
  const waits = [];
  const adopted = record('adopted');
  const launched = record('launched');
  const result = runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 100, maxDelayMs: 1_000,
    wait: (delay) => { waits.push(delay); now += delay; },
    adopt: () => { attempts += 1; if (attempts < 3) throw new Error('target runtime is temporarily unavailable'); return adopted; },
    chooseRuntime: () => ({ runtimeRoot: '/runtime', fallback: false }),
    launch: () => launched,
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
