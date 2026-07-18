// @tier: fast
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSessionOrphanRecovered,
  captureProcessIdentity,
  captureSpawnedProcessIdentity,
  reapOwnedOrphanProcessGroup,
  reapRecordedLiveProcessGroup,
  recoverSessionOrphanState,
} from '../services/orphan-reaper.js';
import { makeTempRoot } from './helpers.js';

function ownedIdentity(sessionDir, overrides = {}) {
  return {
    pid: 4100,
    pgid: 4100,
    startTime: 'Sat Jul 18 12:00:00 2026',
    argv: ['codex', 'exec', `--add-dir=${sessionDir}`],
    command: '',
    fingerprint: 'owned-fingerprint',
    ...overrides,
  };
}

function recordedIdentity(overrides = {}) {
  return ownedIdentity('/unused-session', { argv: null, ...overrides });
}

function persistedIdentity(overrides = {}) {
  return {
    pid: 4100,
    pgid: 4100,
    start_time: 'Sat Jul 18 12:00:00 2026',
    fingerprint: 'owned-fingerprint',
    ...overrides,
  };
}

function sequence(...values) {
  return () => values.shift() ?? null;
}

test('owned orphan policy rejects missing, unrelated, and non-leader processes without signaling', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const unrelated = ownedIdentity(sessionDir, { argv: ['codex', 'exec'] });
  const nonLeader = ownedIdentity(sessionDir, { pgid: 4099 });

  assert.deepEqual(reapOwnedOrphanProcessGroup(sessionDir, 4100, { inspect: () => null }), {
    status: 'not-running', pid: 4100, pgid: null,
    reason: 'process is no longer running', signals: [],
  });
  assert.equal(reapOwnedOrphanProcessGroup(sessionDir, 4100, { inspect: () => unrelated }).status, 'ambiguous');
  assert.equal(reapOwnedOrphanProcessGroup(sessionDir, 4100, { inspect: () => nonLeader }).status, 'ambiguous');
});

test('owned orphan policy uses an exact command fallback when argv is unavailable', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const owned = ownedIdentity(sessionDir, {
    argv: null,
    command: `codex exec --add-dir=${sessionDir}`,
  });
  const signals = [];
  const result = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned, null),
    signalGroup: (_pgid, signal) => signals.push(signal),
    wait: () => {},
  });

  assert.equal(result.status, 'reaped');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('owned orphan policy rechecks immutable ownership before TERM', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const owned = ownedIdentity(sessionDir);

  const exited = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, null),
  });
  assert.equal(exited.status, 'not-running');
  assert.equal(exited.reason, 'process exited before TERM');

  const replaced = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, { ...owned, fingerprint: 'replacement' }),
  });
  assert.equal(replaced.status, 'ambiguous');
  assert.equal(replaced.reason, 'process identity changed before TERM');
});

test('owned orphan policy reports TERM failures without waiting or escalating', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const owned = ownedIdentity(sessionDir);
  let waited = false;
  const result = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned),
    signalGroup: () => { throw new Error('TERM denied'); },
    wait: () => { waited = true; },
  });

  assert.equal(result.status, 'signal-failed');
  assert.equal(result.reason, 'TERM denied');
  assert.deepEqual(result.signals, []);
  assert.equal(waited, false);
});

test('owned orphan policy accepts graceful TERM exit and escalates a stable survivor', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const owned = ownedIdentity(sessionDir);
  const gracefulSignals = [];
  const graceful = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned, null),
    signalGroup: (_pgid, signal) => gracefulSignals.push(signal),
    wait: () => {},
  });
  assert.equal(graceful.status, 'reaped');
  assert.deepEqual(gracefulSignals, ['SIGTERM']);

  const escalatedSignals = [];
  const escalated = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned, owned),
    signalGroup: (_pgid, signal) => escalatedSignals.push(signal),
    wait: () => {},
  });
  assert.equal(escalated.status, 'reaped');
  assert.deepEqual(escalatedSignals, ['SIGTERM', 'SIGKILL']);
});

test('owned orphan policy refuses or reports a failed KILL after TERM', () => {
  const sessionDir = makeTempRoot('pickle-orphan-contract-');
  const owned = ownedIdentity(sessionDir);
  const replaced = { ...owned, fingerprint: 'replacement' };
  const changed = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned, replaced),
    signalGroup: () => {},
    wait: () => {},
  });
  assert.equal(changed.status, 'ambiguous');
  assert.deepEqual(changed.signals, ['SIGTERM']);

  const failed = reapOwnedOrphanProcessGroup(sessionDir, owned.pid, {
    inspect: sequence(owned, owned, owned),
    signalGroup: (_pgid, signal) => {
      if (signal === 'SIGKILL') throw 'KILL denied';
    },
    wait: () => {},
  });
  assert.equal(failed.status, 'signal-failed');
  assert.equal(failed.reason, 'KILL denied');
  assert.deepEqual(failed.signals, ['SIGTERM']);
});

test('recorded child policy rejects absent and mismatched spawn identities', () => {
  const persisted = persistedIdentity();
  const absent = reapRecordedLiveProcessGroup(persisted, { inspect: () => null });
  assert.equal(absent.status, 'not-running');
  assert.equal(absent.pgid, null);

  for (const mismatch of [
    { fingerprint: 'replacement' },
    { pgid: 4099 },
    { startTime: 'different start' },
  ]) {
    const result = reapRecordedLiveProcessGroup(persisted, {
      inspect: () => recordedIdentity(mismatch),
    });
    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.signals, []);
  }
});

test('recorded child policy rechecks immutable identity before TERM', () => {
  const persisted = persistedIdentity();
  const current = recordedIdentity();
  const exited = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, null),
  });
  assert.equal(exited.status, 'not-running');
  assert.equal(exited.reason, 'recorded process exited before TERM');

  const changed = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, { ...current, fingerprint: 'replacement' }),
  });
  assert.equal(changed.status, 'ambiguous');
  assert.equal(changed.reason, 'process identity changed before TERM');
});

test('recorded child policy distinguishes a TERM race from a live signal failure', () => {
  const persisted = persistedIdentity();
  const current = recordedIdentity();
  const raced = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, null),
    signalGroup: () => { throw new Error('already exited'); },
    wait: () => {},
  });
  assert.equal(raced.status, 'reaped');
  assert.equal(raced.reason, 'recorded process exited during TERM race');

  const failed = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, current),
    signalGroup: () => { throw 'TERM denied'; },
    wait: () => {},
  });
  assert.equal(failed.status, 'signal-failed');
  assert.equal(failed.reason, 'TERM denied');
});

test('recorded child policy accepts graceful exit and escalates a stable survivor', () => {
  const persisted = persistedIdentity();
  const current = recordedIdentity();
  const graceful = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, null),
    signalGroup: () => {},
    wait: () => {},
  });
  assert.equal(graceful.status, 'reaped');
  assert.deepEqual(graceful.signals, ['SIGTERM']);

  const signals = [];
  const escalated = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, current),
    signalGroup: (_pgid, signal) => signals.push(signal),
    wait: () => {},
  });
  assert.equal(escalated.status, 'reaped');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('recorded child policy refuses or reports a failed KILL after TERM', () => {
  const persisted = persistedIdentity();
  const current = recordedIdentity();
  const changed = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, { ...current, fingerprint: 'replacement' }),
    signalGroup: () => {},
    wait: () => {},
  });
  assert.equal(changed.status, 'ambiguous');
  assert.deepEqual(changed.signals, ['SIGTERM']);

  const failed = reapRecordedLiveProcessGroup(persisted, {
    inspect: sequence(current, current, current),
    signalGroup: (_pgid, signal) => {
      if (signal === 'SIGKILL') throw new Error('KILL denied');
    },
    wait: () => {},
  });
  assert.equal(failed.status, 'signal-failed');
  assert.equal(failed.reason, 'KILL denied');
});

test('capture and recovery entrypoints fail closed for invalid process identifiers', () => {
  assert.equal(captureProcessIdentity(0), null);
  assert.equal(captureSpawnedProcessIdentity(-1, 0), null);
  assert.equal(recoverSessionOrphanState('/tmp/unused-session', {}), null);

  const updates = [];
  const stateManager = {
    read: () => ({ recovery_required: true, orphan_child_pid: 'invalid' }),
    update: (_statePath, mutator) => {
      const state = mutator({});
      updates.push(state);
      return state;
    },
  };
  assert.throws(
    () => assertSessionOrphanRecovered('/tmp/unused-session', stateManager),
    /Session recovery required: orphan ownership is not provable/,
  );
  assert.equal(updates[0].recovery_required, true);
  assert.equal(updates[0].orphan_recovery, null);

  const idleManager = { read: () => ({ recovery_required: false }), update: () => assert.fail('unexpected update') };
  assert.equal(assertSessionOrphanRecovered('/tmp/unused-session', idleManager), null);
});
