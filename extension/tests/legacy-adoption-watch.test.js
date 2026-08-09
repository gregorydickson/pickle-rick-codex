// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { describeInstalledRuntime } from '../services/runtime-descriptor.js';
import {
  adoptionWatchStrategyStateLaunched,
  beginAdoptionWatchStrategy,
  createAdoptionWatchStrategyState,
  finishAdoptionWatchStrategy,
  readAdoptionWatchDomainEvidence,
  validateAdoptionWatchStrategyState,
} from '../services/adoption-watch-strategies.js';
import {
  readAdoptionWatchMaterialMarkers,
  recordAdoptionWatchMaterialMarker,
} from '../services/adoption-watch-material-ledger.js';
import { archiveAdoptionWatchTerminalState } from '../services/adoption-watch-terminal-recovery.js';

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

function authenticRuntimeRoot(prefix, payload) {
  const root = makeTempRoot(prefix);
  fs.writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\n');
  writeJson(path.join(root, 'package.json'), { name: 'runtime-fixture' });
  writeJson(path.join(root, 'extension', 'package.json'), { version: '1.0.0' });
  writeJson(path.join(root, 'extension', 'state-schema.json'), { schema_version: 1 });
  for (const relative of ['skills/fixture.txt', 'extension/bin/fixture.js',
    'extension/services/fixture.js', 'extension/types/fixture.d.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), payload);
  }
  return root;
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
      strategy_id: entry.strategy_id, evidence_hash: entry.evidence_hash,
      constraints_hash: entry.constraints_hash,
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
  writeJson(path.join(sessionDir, 'watch-material-ledger.json'), { control: 1 });
  writeJson(path.join(sessionDir, 'watch-strategy-authority.json'), { control: 1 });
  fs.mkdirSync(path.join(sessionDir, 'watch-materials'));
  writeJson(path.join(sessionDir, 'watch-materials', `${'a'.repeat(64)}.json`), { control: 1 });
  fs.mkdirSync(path.join(sessionDir, 'watch-terminal-recovery'));
  writeJson(path.join(sessionDir, 'watch-terminal-recovery', `${'b'.repeat(64)}.json`), { control: 1 });
  const runtime = descriptor();
  const migration = prepareLiveSessionMigration(sessionDir, runtime, runtime);
  assert.equal(migration.preserved_artifacts.some((artifact) => artifact.path === LEGACY_ADOPTION_WATCH_STATUS_FILE), false);

  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
    status: 'retrying', attempt_count: 10, last_failure: { kind: 'migration-continuity-failed' },
  });
  writeJson(path.join(sessionDir, 'watch-material-ledger.json'), { control: 2 });
  writeJson(path.join(sessionDir, 'watch-strategy-authority.json'), { control: 2 });
  assert.doesNotThrow(() => verifyLiveSessionMigration(sessionDir, migration));
});

test('malformed persisted counters and schema without controls fail closed with typed recovery', () => {
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
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, random: () => 0.5, baseDelayMs: 500, maxDelayMs: 2_000,
      wait: (delay) => { waits.push(delay); now += delay; if (waits.length === 2) throw new Error('malformed-blocked'); },
      executeStrategy: () => assert.fail('malformed established status must not bootstrap'),
    }), /malformed-blocked/);
    assert.deepEqual(waits, [500, 500]);
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(status.status, 'retrying');
    assert.equal(status.attempt_count, 0);
    assert.equal(status.strategy_state.cursor, 3);
    assert.equal(status.last_failure.kind, 'executor-restart-requested');
  }
});

test('invalid persisted timestamps without controls wait safely and fail closed', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-invalid-time-');
  writeJson(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), {
    schema_version: 1, status: 'retrying', session_id: path.basename(sessionDir), watcher_pid: 1,
    started_at: 'not-a-date', updated_at: 'also-not-a-date', attempt_count: 999, consecutive_failures: 999,
    last_attempt_at: null, next_retry_at: 'invalid', retry_delay_ms: 1,
    last_failure: null, launched_runtime_root: null,
  });
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const waits = [];
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 750, maxDelayMs: 3_000,
    wait: (delay) => { waits.push(delay); now += delay; if (waits.length === 2) throw new Error('timestamp-blocked'); },
    executeStrategy: () => assert.fail('invalid timestamp status must not bootstrap'),
  }), /timestamp-blocked/);
  assert.deepEqual(waits, [750, 750]);
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
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, random: () => 0.5, baseDelayMs: 500, maxDelayMs: 2_000,
      wait: (delay) => { waits.push(delay); now += delay; if (waits.length === 2) throw new Error('deadline-blocked'); },
      executeStrategy: () => assert.fail('invalid deadline status must not bootstrap'),
    }), /deadline-blocked/);
    assert.deepEqual(waits, [500, 500]);
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(status.last_failure.kind, 'executor-restart-requested');
    assert.equal(status.strategy_state.cursor, 3);
  }
});

test('persistent failure executes three material strategies then awaits real evidence change', () => {
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
  assert.equal(routes.length, 3);
  assert.equal(status.strategy_state.epoch, 1);
  assert.equal(status.strategy_state.cursor, 3);
  assert.equal(status.strategy_state.history.length, 3);
  assert.equal(new Set(status.strategy_state.history.map((entry) => entry.material_hash)).size, 3);
  assert.equal(status.executor_restart_action.action, 'awaiting_evidence_change');
  assert.equal(status.last_failure.kind, 'executor-restart-requested');
  assert.ok(Date.parse(status.next_retry_at) > now - status.retry_delay_ms);
});

test('forged supervisor telemetry and migration-only changes cannot unlock an exhausted catalog', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-forged-supervisor-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let waits = 0;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => { throw new Error('persistent'); },
    wait: (delay) => { now += delay; waits += 1; if (waits === 4) throw new Error('initial-stop'); },
  }), /initial-stop/);

  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), {
    schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
    manager_identity: { pid: process.pid, pgid: process.pid, start_time: 'forged', fingerprint: 'forged-manager' },
    executor_identity: { pid: process.pid, pgid: process.pid, start_time: 'forged', fingerprint: 'forged-executor' },
    executor_generation: 999, executor_spec_sha256: 'f'.repeat(64),
    last_restart_request_id: 'forged-receipt', updated_at: new Date(now).toISOString(),
  });
  writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), { arbitrary_runtime_change: crypto.randomUUID() });
  now += 1_000;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => assert.fail('forged evidence must not authorize a fourth strategy'),
    wait: () => { throw new Error('forged-stop'); },
  }), /forged-stop/);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(status.strategy_state.epoch, 1);
  assert.equal(status.strategy_state.cursor, 3);
  assert.equal(status.executor_restart_action.action, 'awaiting_evidence_change');
});

test('immutable material ledger rejects replay after bounded archive references are evicted', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-ledger-');
  const evidenceHash = 'a'.repeat(64);
  const initial = createAdoptionWatchStrategyState('session', evidenceHash);
  const begun = beginAdoptionWatchStrategy(initial, evidenceHash, '2026-01-01T00:00:00.000Z');
  recordAdoptionWatchMaterialMarker(sessionDir, begun.attempt);
  const evictedArchiveRefs = Array.from({ length: 20 }, (_, index) => `archive-${index}`).slice(-16);
  assert.equal(evictedArchiveRefs.includes('archive-0'), false);
  assert.throws(() => beginAdoptionWatchStrategy(
    createAdoptionWatchStrategyState('session', evidenceHash), evidenceHash,
    '2026-01-02T00:00:00.000Z', readAdoptionWatchMaterialMarkers(sessionDir),
  ), /reuse-rejected/);
});

test('authenticated executor replacements are not novelty and domain change alone unlocks the next epoch', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-generation-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let domainHash = 'd'.repeat(64);
  let domainAuthenticated = true;
  let restartRequests = 0;
  const readDomainEvidence = () => ({ hash: domainHash, authenticated: domainAuthenticated });
  const executorStatus = (generation, pid, fingerprint, lastRestartRequestId = null,
    managerGeneration = 1, managerFingerprint = 'manager-fingerprint') => ({
    schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
    manager_identity: { pid: 10, pgid: 10, start_time: 'manager', fingerprint: managerFingerprint },
    manager_generation: managerGeneration, manager_parent_pid: 9, manager_argv_sha256: 'a'.repeat(64),
    owner_nonce: 'owner-nonce',
    executor_identity: { pid, pgid: pid, start_time: `executor-${generation}`, fingerprint },
    executor_generation: generation, executor_started_at: '2026-01-01T00:00:00.000Z',
    executor_lease_expires_at: '2026-01-01T00:01:00.000Z', executor_spec_sha256: 'c'.repeat(64),
    replacement_count: generation - 1, last_loss_at: null, last_restart_request_id: lastRestartRequestId,
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const firstStatus = executorStatus(1, process.pid, 'executor-one');
  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), firstStatus);
  const routes = [];
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    wait: (delay) => { now += delay; },
    executeStrategy: (strategyId) => { routes.push(strategyId); throw new Error('persistent'); },
    readDomainEvidence,
    readExecutorStatus: () => firstStatus,
    requestExecutorRestart: () => {
      restartRequests += 1;
      writeJson(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'), { pending: true });
      return {
        schema_version: 1, request_id: 'restart-1', expected_generation: 1,
        expected_executor_fingerprint: 'executor-one', reason: 'catalog exhausted',
        requested_at: '2026-01-01T00:00:00.030Z',
      };
    },
    yieldExecutor: () => { throw new Error('executor-yielded'); },
  }), /executor-yielded/);
  assert.equal(routes.length, 3);
  const requested = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(requested.executor_restart_action.action, 'executor_restart_requested');
  assert.equal(requested.executor_restart_action.request.expected_generation, 1);

  fs.rmSync(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'));
  const forgedStatus = executorStatus(2, process.pid + 1, 'executor-forged', 'restart-1', 1, 'forged-manager');
  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), forgedStatus);
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    readDomainEvidence,
    readExecutorStatus: () => forgedStatus,
    wait: () => { throw new Error('forged-successor-stop'); },
    executeStrategy: () => assert.fail('same-generation manager drift must not unlock a new epoch'),
  }), /forged-successor-stop/);
  const fenced = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(fenced.strategy_state.epoch, 1);
  assert.equal(fenced.executor_restart_action.request.request_id, 'restart-1');

  const secondStatus = executorStatus(2, process.pid + 2, 'executor-two', 'restart-1', 2, 'manager-successor');
  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), secondStatus);
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence,
    readExecutorStatus: () => secondStatus,
    executeStrategy: () => assert.fail('authenticated replacement with unchanged domain must not dispatch'),
    wait: () => { throw new Error('unchanged-domain-generation-two'); },
  }), /unchanged-domain-generation-two/);
  const thirdStatus = executorStatus(3, process.pid + 3, 'executor-three', 'restart-1', 3, 'manager-third');
  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), thirdStatus);
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence,
    readExecutorStatus: () => thirdStatus,
    executeStrategy: () => assert.fail('multiple authenticated replacements must remain supervised waiting'),
    wait: () => { throw new Error('unchanged-domain-generation-three'); },
  }), /unchanged-domain-generation-three/);
  const waiting = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(waiting.strategy_state.epoch, 1);
  assert.equal(waiting.strategy_state.cursor, 3);
  assert.equal(waiting.attempt_count, 3);
  const fourthStatus = executorStatus(4, process.pid + 4, 'executor-four', 'restart-1', 4, 'manager-fourth');
  writeJson(path.join(sessionDir, 'legacy-session-adoption-executor.json'), fourthStatus);
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence,
    readExecutorStatus: () => fourthStatus,
    executeStrategy: () => assert.fail('generation four with unchanged domain must remain waiting'),
    wait: () => { throw new Error('unchanged-domain-generation-four'); },
  }), /unchanged-domain-generation-four/);
  assert.equal(restartRequests, 1);

  domainHash = 'f'.repeat(64);
  domainAuthenticated = false;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence,
    readExecutorStatus: () => fourthStatus,
    executeStrategy: () => assert.fail('unauthenticated domain bytes must not unlock a new epoch'),
    wait: () => { throw new Error('unauthenticated-domain-change'); },
  }), /unauthenticated-domain-change/);
  domainHash = 'e'.repeat(64);
  domainAuthenticated = true;
  const resumedRoutes = [];
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    readDomainEvidence,
    readExecutorStatus: () => fourthStatus,
    executeStrategy: (strategyId) => { resumedRoutes.push(strategyId); return record('launched'); },
  });
  assert.deepEqual(resumedRoutes, ['standard-adopt-launch']);
  const resumed = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(resumed.strategy_state.epoch, 2);
  assert.equal(resumed.executor_restart_action, null);
  assert.equal(resumed.executor_restart_history.length, 1);
  assert.notEqual(resumed.strategy_state.history[0].material_hash,
    requested.strategy_state.history[0].material_hash);
});

test('authenticated runtime contents provide real domain novelty after replacement acknowledgement', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-real-domain-');
  const sourceRuntimeRoot = authenticRuntimeRoot('pickle-source-runtime-', 'source');
  const targetRuntimeRoot = authenticRuntimeRoot('pickle-target-runtime-', 'target-v1');
  const watchArgs = { sessionDir, sourceRuntimeRoot, targetRuntimeRoot, validationSessionDir: '' };
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const status = (generation, fingerprint, receipt = null, managerGeneration = 1) => ({
    schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
    manager_identity: { pid: 10 + managerGeneration, pgid: 10 + managerGeneration,
      start_time: `manager-${managerGeneration}`, fingerprint: `manager-${managerGeneration}` },
    manager_generation: managerGeneration, manager_parent_pid: 9, manager_argv_sha256: 'a'.repeat(64),
    owner_nonce: 'stable-owner',
    executor_identity: { pid: generation === 1 ? process.pid : process.pid + generation,
      pgid: process.pid + generation, start_time: `executor-${generation}`, fingerprint },
    executor_generation: generation, executor_started_at: '2026-01-01T00:00:00.000Z',
    executor_lease_expires_at: '2026-01-01T00:01:00.000Z', executor_spec_sha256: 'c'.repeat(64),
    replacement_count: generation - 1, last_loss_at: null, last_restart_request_id: receipt,
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const initialDomain = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
  assert.equal(initialDomain.authenticated, true);
  const first = status(1, 'executor-one');
  assert.throws(() => runLegacyAdoptionWatch(watchArgs, {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    readExecutorStatus: () => first,
    executeStrategy: () => { throw new Error('persistent'); },
    wait: (delay) => { now += delay; },
    requestExecutorRestart: () => {
      writeJson(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'), { pending: true });
      return { schema_version: 1, request_id: 'real-domain-restart', expected_generation: 1,
        expected_executor_fingerprint: 'executor-one', reason: 'catalog exhausted',
        requested_at: '2026-01-01T00:00:00.030Z' };
    },
    yieldExecutor: () => { throw new Error('real-domain-yield'); },
  }), /real-domain-yield/);
  fs.unlinkSync(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'));
  const replacement = status(2, 'executor-two', 'real-domain-restart', 2);
  assert.throws(() => runLegacyAdoptionWatch(watchArgs, {
    now: () => now, readExecutorStatus: () => replacement,
    executeStrategy: () => assert.fail('replacement identity alone is not domain novelty'),
    wait: () => { throw new Error('real-domain-unchanged'); },
  }), /real-domain-unchanged/);

  fs.appendFileSync(path.join(targetRuntimeRoot, 'extension', 'services', 'fixture.js'), '\ntarget-v2');
  const changedDomain = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
  assert.equal(changedDomain.authenticated, true);
  assert.notEqual(changedDomain.hash, initialDomain.hash);
  const routes = [];
  runLegacyAdoptionWatch(watchArgs, {
    now: () => now, readExecutorStatus: () => replacement,
    executeStrategy: (strategyId) => { routes.push(strategyId); return record('launched'); },
  });
  assert.deepEqual(routes, ['standard-adopt-launch']);
  const resumed = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(resumed.strategy_state.epoch, 2);
});

test('authenticated migration domain projection binds exact live semantics but ignores inert reseal metadata', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-semantic-migration-');
  const workingDir = makeTempRoot('pickle-adoption-watch-semantic-working-');
  const sourceRuntimeRoot = authenticRuntimeRoot('pickle-semantic-source-', 'source');
  const targetRuntimeRoot = authenticRuntimeRoot('pickle-semantic-target-', 'target');
  const sourceRuntime = describeInstalledRuntime(sourceRuntimeRoot);
  const targetRuntime = describeInstalledRuntime(targetRuntimeRoot);
  execFileSync('git', ['init'], { cwd: workingDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd: workingDir });
  fs.writeFileSync(path.join(workingDir, 'tracked.txt'), 'base\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workingDir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: workingDir, stdio: 'ignore' });
  execFileSync('git', ['update-ref', `refs/pickle/salvage/${path.basename(sessionDir)}/probe`, 'HEAD'], {
    cwd: workingDir,
  });
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: workingDir, history: [], current_ticket: null, step: 'readiness',
  });
  let migration = prepareLiveSessionMigration(
    sessionDir, sourceRuntime, targetRuntime, new Date('2026-01-01T00:00:00.000Z'),
    { forceVerificationContractRepair: true },
  );
  assert.equal(migration.salvage_refs.length, 1);
  const adoptionPath = path.join(sessionDir, 'legacy-session-adoption.json');
  const adoption = {
    ...record('adopted'), session_id: path.basename(sessionDir), source_runtime: sourceRuntime,
    target_runtime: targetRuntime, migration_content_hash: migration.content_hash,
    target_runtime_supersessions: [{ forged_control_id: 'one', superseded_at: '2026-01-01T00:00:00.000Z' }],
  };
  writeJson(adoptionPath, adoption);
  const initial = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
  assert.equal(initial.authenticated, true);

  adoption.target_runtime_supersessions[0] = { forged_control_id: 'two', superseded_at: '2099-01-01T00:00:00.000Z' };
  writeJson(adoptionPath, adoption);
  assert.equal(readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot).hash, initial.hash);

  const { content_hash: _oldHash, ...resealedPayload } = migration;
  migration = { ...resealedPayload, migration_id: crypto.randomUUID(), created_at: '2027-02-03T04:05:06.000Z' };
  migration.content_hash = stableHash(migration);
  adoption.migration_content_hash = migration.content_hash;
  writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), migration);
  writeJson(adoptionPath, adoption);
  const resealed = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
  assert.equal(resealed.authenticated, true);
  assert.equal(resealed.hash, initial.hash);

  const reversed = Object.fromEntries(Object.entries(migration).reverse());
  writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), reversed);
  assert.equal(readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot).hash, initial.hash);
  const sourceAlias = path.join(makeTempRoot('pickle-semantic-aliases-'), 'source');
  const targetAlias = path.join(path.dirname(sourceAlias), 'target');
  fs.symlinkSync(sourceRuntimeRoot, sourceAlias);
  fs.symlinkSync(targetRuntimeRoot, targetAlias);
  assert.equal(readAdoptionWatchDomainEvidence(sessionDir, sourceAlias, targetAlias).hash, initial.hash);

  const invalidHashes = [];
  for (const mutate of [
    (candidate) => { candidate.session_schema = 999; },
    (candidate) => { candidate.preserved_artifacts = []; },
    (candidate) => { candidate.salvage_refs = []; },
    (candidate) => { candidate.resume_checkpoint.ticket_id = 'FORGED'; },
    (candidate) => { candidate.resume_checkpoint.phase = 'forged'; },
    (candidate) => { candidate.resume_checkpoint.reuse_phases = ['research']; },
    (candidate) => { candidate.resume_checkpoint.history_length = 999; },
  ]) {
    const candidate = JSON.parse(JSON.stringify(migration));
    mutate(candidate);
    delete candidate.content_hash;
    candidate.content_hash = stableHash(candidate);
    adoption.migration_content_hash = candidate.content_hash;
    writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), candidate);
    writeJson(adoptionPath, adoption);
    const invalid = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
    assert.equal(invalid.authenticated, false);
    invalidHashes.push(invalid.hash);
  }
  assert.equal(new Set(invalidHashes).size, 1, 'all invalid reseals collapse to stable non-novel evidence');

  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: workingDir, history: [{ event: 'resumed' }],
    current_ticket: 'R1', step: 'readiness',
  });
  migration = prepareLiveSessionMigration(
    sessionDir, sourceRuntime, targetRuntime, new Date('2027-03-04T05:06:07.000Z'),
    { forceVerificationContractRepair: true },
  );
  adoption.migration_content_hash = migration.content_hash;
  writeJson(adoptionPath, adoption);
  const changed = readAdoptionWatchDomainEvidence(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
  assert.equal(changed.authenticated, true);
  assert.notEqual(changed.hash, initial.hash);
});

test('legacy v1 exhausted authority burns its catalog and pending ACK cannot authorize v2 replay', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-v1-migration-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let domainHash = '1'.repeat(64);
  const readDomainEvidence = () => ({ hash: domainHash, authenticated: true });
  const supervisor = (generation, fingerprint, receipt = null) => ({
    schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
    manager_identity: { pid: 10, pgid: 10, start_time: 'manager', fingerprint: 'manager' },
    manager_generation: generation, manager_parent_pid: 9, manager_argv_sha256: 'a'.repeat(64),
    owner_nonce: 'owner', executor_identity: { pid: generation === 1 ? process.pid : process.pid + generation,
      pgid: process.pid + generation, start_time: `executor-${generation}`, fingerprint },
    executor_generation: generation, executor_started_at: '2026-01-01T00:00:00.000Z',
    executor_lease_expires_at: '2026-01-01T00:01:00.000Z', executor_spec_sha256: 'c'.repeat(64),
    replacement_count: generation - 1, last_loss_at: null, last_restart_request_id: receipt,
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  const first = supervisor(1, 'executor-one');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence, readExecutorStatus: () => first,
    executeStrategy: () => { throw new Error('persistent'); }, wait: (delay) => { now += delay; },
    requestExecutorRestart: () => {
      writeJson(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'), { pending: true });
      return { schema_version: 1, request_id: 'v1-pending', expected_generation: 1,
        expected_executor_fingerprint: 'executor-one', reason: 'v1 exhausted',
        requested_at: '2026-01-01T00:00:00.030Z' };
    },
    yieldExecutor: () => { throw new Error('v1-yield'); },
  }), /v1-yield/);
  const authorityPath = path.join(sessionDir, 'watch-strategy-authority.json');
  const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  delete authority.domain_evidence_schema;
  const { content_hash: _contentHash, ...legacyPayload } = authority;
  authority.content_hash = stableHash(legacyPayload);
  writeJson(authorityPath, authority);
  fs.unlinkSync(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'));
  domainHash = '2'.repeat(64);
  const successor = supervisor(2, 'executor-two', 'v1-pending');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, readDomainEvidence, readExecutorStatus: () => successor,
    executeStrategy: () => assert.fail('v1 pending ACK must never authorize a v2 epoch'),
    wait: () => { throw new Error('v2-waiting'); },
  }), /v2-waiting/);
  const migrated = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(migrated.strategy_state.cursor, 3);
  assert.equal(migrated.strategy_state.history_base_checkpoint.evidence_hash, domainHash);
  assert.equal(migrated.executor_restart_action.action, 'awaiting_evidence_change');
  assert.equal(migrated.executor_restart_action.request, null);
});

test('production strategy routes execute distinct adoption, authentication, and reconstruction operations', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-real-routes-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let adoptCalls = 0;
  let launchCalls = 0;
  let runtimeChecks = 0;
  const adopted = record('adopted');
  writeJson(path.join(sessionDir, 'legacy-session-adoption.json'), adopted);
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, random: () => 0.5, baseDelayMs: 10, maxDelayMs: 40,
    adopt: () => {
      adoptCalls += 1;
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
    checkpoint: (point) => { if (point === 'strategy_persisted') throw new Error('simulated-hard-crash'); },
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

test('crash after material reservation but before active checkpoint advances without replay', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-reservation-crash-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    checkpoint: (point) => { if (point === 'material_reserved') throw new Error('reservation-crash'); },
    executeStrategy: () => assert.fail('reserved route must not dispatch before its checkpoint'),
  }), /reservation-crash/);
  assert.equal(fs.existsSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE)), false);

  const routes = [];
  runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now,
    executeStrategy: (strategyId) => { routes.push(strategyId); return record('launched'); },
  });
  assert.deepEqual(routes, ['authenticated-runtime-revalidation']);
});

test('missing ledger halves repair while a present corrupt manifest fails closed without replay', () => {
  for (const damage of ['marker', 'manifest-delete', 'manifest-tamper']) {
    const sessionDir = makeTempRoot(`pickle-adoption-watch-ledger-${damage}-`);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => { throw new Error('first-route-failed'); },
      wait: () => { throw new Error('damage-stop'); },
    }), /damage-stop/);
    const markerDir = path.join(sessionDir, 'watch-materials');
    const manifestPath = path.join(sessionDir, 'watch-material-ledger.json');
    if (damage === 'marker') fs.unlinkSync(path.join(markerDir, fs.readdirSync(markerDir)[0]));
    if (damage === 'manifest-delete') fs.unlinkSync(manifestPath);
    if (damage === 'manifest-tamper') {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.root_hash = '0'.repeat(64);
      writeJson(manifestPath, manifest);
    }
    now += 1_000;
    const routes = [];
    const resume = () => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      wait: (delay) => {
        now += delay;
        if (damage === 'manifest-tamper') throw new Error('corrupt-manifest-blocked');
      },
      executeStrategy: (strategyId) => { routes.push(strategyId); return record('launched'); },
    });
    if (damage === 'manifest-tamper') {
      assert.throws(resume, /corrupt-manifest-blocked/);
      assert.deepEqual(routes, []);
    } else {
      resume();
      assert.deepEqual(routes, ['authenticated-runtime-revalidation']);
    }
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(status.last_failure.kind,
      damage === 'manifest-tamper' ? 'executor-restart-requested' : 'watch-status-invalid');
  }
});

test('combined authority, manifest, and marker damage never shrinks exhausted material completeness', () => {
  const cases = [
    'marker-delete+manifest-root',
    'marker-delete+manifest-delete',
    'marker-tamper+manifest-root',
    'authority-root+marker-delete',
    'authority-delete+manifest-root',
    'authority-root+marker-delete+manifest-root',
  ];
  for (const damage of cases) {
    const sessionDir = makeTempRoot(`pickle-adoption-watch-combined-${damage.replaceAll('+', '-')}-`);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    let waits = 0;
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => { throw new Error('persistent'); },
      wait: (delay) => { now += delay; waits += 1; if (waits === 4) throw new Error('combined-ready'); },
    }), /combined-ready/);
    const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
    const manifestPath = path.join(sessionDir, 'watch-material-ledger.json');
    const authorityPath = path.join(sessionDir, 'watch-strategy-authority.json');
    const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
    const routeZero = authority.expected_markers.find((marker) => marker.strategy_id === 'standard-adopt-launch');
    const markerPath = path.join(sessionDir, 'watch-materials', `${routeZero.material_hash}.json`);
    if (damage.includes('marker-delete')) fs.unlinkSync(markerPath);
    if (damage.includes('marker-tamper')) writeJson(markerPath, { material_hash: routeZero.material_hash, corrupt: true });
    if (damage.includes('manifest-delete')) fs.unlinkSync(manifestPath);
    if (damage.includes('manifest-root')) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.root_hash = '0'.repeat(64);
      writeJson(manifestPath, manifest);
    }
    if (damage.includes('authority-delete')) fs.unlinkSync(authorityPath);
    if (damage.includes('authority-root')) {
      const damagedAuthority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
      damagedAuthority.ledger_root_hash = '0'.repeat(64);
      writeJson(authorityPath, damagedAuthority);
    }
    const corruptStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    corruptStatus.schema_version = 999;
    writeJson(statusPath, corruptStatus);
    now += 1_000;
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => assert.fail(`combined damage replayed a route: ${damage}`),
      wait: () => { throw new Error('combined-blocked'); },
    }), /combined-blocked/);
    const repaired = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(repaired.strategy_state.cursor, 3, damage);
    assert.equal(repaired.executor_restart_action.action, 'awaiting_evidence_change', damage);
    assert.equal(readAdoptionWatchMaterialMarkers(sessionDir).size, 3, damage);
  }
});

test('corrupt controls plus invalid embedded tail fail closed for every deleted route marker', () => {
  for (const deletedRoute of [0, 1, 2]) {
    const sessionDir = makeTempRoot(`pickle-adoption-watch-tail-loss-${deletedRoute}-`);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    let waits = 0;
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => { throw new Error('persistent'); },
      wait: (delay) => { now += delay; waits += 1; if (waits === 4) throw new Error('tail-ready'); },
    }), /tail-ready/);
    const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const deletedMaterial = status.strategy_state.history[deletedRoute].material_hash;
    status.strategy_state.history[2].material_hash = '0'.repeat(64);
    writeJson(statusPath, status);
    fs.unlinkSync(path.join(sessionDir, 'watch-materials', `${deletedMaterial}.json`));
    const manifestPath = path.join(sessionDir, 'watch-material-ledger.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.root_hash = '0'.repeat(64);
    writeJson(manifestPath, manifest);
    const authorityPath = path.join(sessionDir, 'watch-strategy-authority.json');
    const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
    authority.ledger_root_hash = '0'.repeat(64);
    writeJson(authorityPath, authority);
    now += 1_000;
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => assert.fail(`route ${deletedRoute} replayed after conflicting corruption`),
      wait: () => { throw new Error('tail-blocked'); },
    }), /tail-blocked/);
    const blocked = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(blocked.strategy_state.cursor, 3, `deleted route ${deletedRoute}`);
    assert.equal(blocked.executor_restart_action.action, 'awaiting_evidence_change');
    assert.equal(blocked.last_failure.kind, 'executor-restart-requested');
  }
});

test('full control deletion cannot turn an established exhausted watcher into pristine bootstrap', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-full-control-deletion-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let waits = 0;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => { throw new Error('persistent'); },
    wait: (delay) => { now += delay; waits += 1; if (waits === 4) throw new Error('deletion-ready'); },
  }), /deletion-ready/);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  status.strategy_state.history[2].material_hash = '0'.repeat(64);
  writeJson(statusPath, status);
  fs.unlinkSync(path.join(sessionDir, 'watch-strategy-authority.json'));
  fs.unlinkSync(path.join(sessionDir, 'watch-material-ledger.json'));
  fs.rmSync(path.join(sessionDir, 'watch-materials'), { recursive: true });
  now += 1_000;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => assert.fail('full control deletion must not replay route zero'),
    wait: () => { throw new Error('deletion-blocked'); },
  }), /deletion-blocked/);
  const blocked = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(blocked.strategy_state.cursor, 3);
  assert.equal(blocked.executor_restart_action.action, 'awaiting_evidence_change');
});

test('invalid status with absent controls is established corruption, while a pristine session bootstraps', () => {
  const established = makeTempRoot('pickle-adoption-watch-invalid-status-no-controls-');
  writeJson(path.join(established, LEGACY_ADOPTION_WATCH_STATUS_FILE), { schema_version: 999, prior_run: true });
  assert.throws(() => runLegacyAdoptionWatch(args(established), {
    executeStrategy: () => assert.fail('invalid established status must not bootstrap'),
    wait: () => { throw new Error('established-blocked'); },
  }), /established-blocked/);
  const blocked = JSON.parse(fs.readFileSync(path.join(established, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
  assert.equal(blocked.strategy_state.cursor, 3);

  const pristine = makeTempRoot('pickle-adoption-watch-true-pristine-');
  const routes = [];
  runLegacyAdoptionWatch(args(pristine), {
    executeStrategy: (strategyId) => { routes.push(strategyId); return record('launched'); },
  });
  assert.deepEqual(routes, ['standard-adopt-launch']);
});

test('orphaned terminal archive or restart-request indicators prevent clean bootstrap', () => {
  for (const indicator of ['terminal-archive', 'restart-request']) {
    const sessionDir = makeTempRoot(`pickle-adoption-watch-orphan-${indicator}-`);
    if (indicator === 'terminal-archive') {
      fs.mkdirSync(path.join(sessionDir, 'watch-terminal-recovery'));
      writeJson(path.join(sessionDir, 'watch-terminal-recovery', `${'a'.repeat(64)}.json`), { orphaned: true });
    } else {
      writeJson(path.join(sessionDir, 'legacy-session-adoption-executor-restart.json'), { orphaned: true });
    }
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      executeStrategy: () => assert.fail(`${indicator} must prevent clean bootstrap`),
      wait: () => { throw new Error('indicator-blocked'); },
    }), /indicator-blocked/);
    const blocked = JSON.parse(fs.readFileSync(path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE), 'utf8'));
    assert.equal(blocked.strategy_state.cursor, 3);
  }
});

test('corrupt watch status plus migration-only evidence cannot bypass durable exhausted authority', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-corrupt-transition-');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let waits = 0;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => { throw new Error('persistent'); },
    wait: (delay) => { now += delay; waits += 1; if (waits === 4) throw new Error('exhausted-stop'); },
  }), /exhausted-stop/);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
  const corrupt = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  corrupt.schema_version = 999;
  writeJson(statusPath, corrupt);
  writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), { changed_without_restart: true });
  now += 1_000;
  assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
    now: () => now, baseDelayMs: 10, maxDelayMs: 40,
    executeStrategy: () => assert.fail('corruption must not authorize strategy replay'),
    wait: () => { throw new Error('blocked-stop'); },
  }), /blocked-stop/);
  const repaired = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(repaired.strategy_state.cursor, 3);
  assert.equal(repaired.strategy_state.epoch, 1);
});

test('deleted or root-tampered authority plus invalid status reconstructs reserved evidence without replay', () => {
  for (const damage of ['delete', 'root-tamper']) {
    const sessionDir = makeTempRoot(`pickle-adoption-watch-authority-${damage}-`);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      executeStrategy: () => { throw new Error('route-zero-failed'); },
      wait: () => { throw new Error('authority-stop'); },
    }), /authority-stop/);
    const statusPath = path.join(sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    status.schema_version = 999;
    writeJson(statusPath, status);
    const authorityPath = path.join(sessionDir, 'watch-strategy-authority.json');
    if (damage === 'delete') fs.unlinkSync(authorityPath);
    else {
      const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
      authority.ledger_root_hash = '0'.repeat(64);
      writeJson(authorityPath, authority);
    }
    writeJson(path.join(sessionDir, 'installed-runtime-migration.json'), { unauthenticated_change: damage });
    now += 1_000;
    assert.throws(() => runLegacyAdoptionWatch(args(sessionDir), {
      now: () => now, baseDelayMs: 10, maxDelayMs: 40,
      wait: () => { throw new Error('transition-blocked'); },
      executeStrategy: () => assert.fail('unauthenticated evidence transition must not dispatch'),
    }), /transition-blocked/);
    const repaired = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(repaired.strategy_state.cursor, 3);
    assert.equal(repaired.executor_restart_action.action, 'awaiting_evidence_change');
  }
});

test('real archive ref eviction plus old marker unlink still cannot replay old material', () => {
  const sessionDir = makeTempRoot('pickle-adoption-watch-real-eviction-');
  const refs = [];
  let oldestAttempt;
  for (let index = 0; index < 17; index += 1) {
    const evidence = index.toString(16).padStart(64, '0');
    const startedAt = new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString();
    let state = createAdoptionWatchStrategyState('session', evidence);
    const begun = beginAdoptionWatchStrategy(state, evidence, startedAt);
    if (index === 0) oldestAttempt = begun.attempt;
    recordAdoptionWatchMaterialMarker(sessionDir, begun.attempt);
    state = finishAdoptionWatchStrategy(begun.state, 'launched', null, startedAt);
    refs.push(archiveAdoptionWatchTerminalState(sessionDir, state, evidence, startedAt));
  }
  const retained = refs.slice(-16);
  assert.equal(retained.some((ref) => ref.path === refs[0].path), false);
  fs.unlinkSync(path.join(sessionDir, 'watch-materials', `${oldestAttempt.material_hash}.json`));
  assert.ok(readAdoptionWatchMaterialMarkers(sessionDir).has(oldestAttempt.material_hash));
  assert.throws(() => beginAdoptionWatchStrategy(
    createAdoptionWatchStrategyState('session', oldestAttempt.evidence_hash), oldestAttempt.evidence_hash,
    '2026-02-01T00:00:00.000Z', readAdoptionWatchMaterialMarkers(sessionDir),
  ), /reuse-rejected/);
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
  assert.equal(repaired.strategy_state.history.length, 2);
  assert.equal(repaired.strategy_state.history[0].outcome, 'failed');
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
    assert.match(validateAdoptionWatchStrategyState(forged), /semantic history replay|strategy history entry/);
  }
});

test('constant evidence cannot produce a fourth attempt or an artificial next epoch', () => {
  const state = strategyFailures(3);
  assert.equal(state.epoch, 1);
  assert.equal(state.cursor, 3);
  assert.equal(validateAdoptionWatchStrategyState(state), null);
  assert.throws(() => beginAdoptionWatchStrategy(
    state, 'a'.repeat(64), '2026-01-01T00:00:04.000Z',
  ), /catalog-exhausted/);
  const forged = structuredClone(state);
  forged.epoch = 2;
  forged.cursor = 0;
  rehashForgedStrategyState(forged);
  assert.match(validateAdoptionWatchStrategyState(forged), /semantic history replay/);
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
