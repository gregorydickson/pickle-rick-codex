// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  flushPendingActivity,
  logActivity,
  pendingActivityCount,
  pruneActivity,
  readActivityLogs,
  resetActivityLoggerForTests,
  setActivityWriterForTests,
} from '../services/activity-logger.js';

test('activity logger retries a bounded number of times, retains failures, and flushes them in order', () => {
  const originalRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
  resetActivityLoggerForTests();
  let attempts = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    setActivityWriterForTests(() => {
      attempts += 1;
      throw new Error('disk unavailable');
    });
    assert.equal(logActivity({ event: 'first' }, { maxAttempts: 3 }), false);
    assert.equal(attempts, 3, 'bounded retry count is honored');
    assert.equal(pendingActivityCount(), 1);
    assert.deepEqual(readActivityLogs().map((event) => event.event), ['first'], 'pending events remain observable');

    assert.equal(logActivity({ event: 'second' }, { maxAttempts: 2 }), false);
    assert.equal(attempts, 5, 'an older pending event blocks later writes to preserve order');
    assert.equal(pendingActivityCount(), 2);

    setActivityWriterForTests((filePath, line) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, line);
    });
    assert.deepEqual(flushPendingActivity(), { written: 2, pending: 0, error: null });
    assert.equal(pendingActivityCount(), 0);
    assert.deepEqual(readActivityLogs().map((event) => event.event), ['first', 'second']);
    assert.ok(errors.some((message) => message.includes('remain pending')), 'write failure is not silent');
  } finally {
    console.error = originalError;
    resetActivityLoggerForTests();
    if (originalRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = originalRoot;
  }
});

test('activity logger reports an unserializable event without throwing or silently accepting it', () => {
  resetActivityLoggerForTests();
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    assert.equal(logActivity({ event: 'bad', value: 1n }), false);
    assert.equal(pendingActivityCount(), 0);
    assert.ok(errors.some((message) => message.includes('serialization failed')));
  } finally {
    console.error = originalError;
    resetActivityLoggerForTests();
  }
});

test('activity logger default persistence and pruning retain only current JSONL history', () => {
  const originalRoot = process.env.PICKLE_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-retention-'));
  process.env.PICKLE_DATA_ROOT = root;
  resetActivityLoggerForTests();
  try {
    assert.equal(logActivity({ event: 'persisted' }), true);
    assert.equal(pendingActivityCount(), 0);
    assert.deepEqual(readActivityLogs().map((event) => event.event), ['persisted']);

    const activityRoot = path.join(root, 'activity');
    fs.writeFileSync(path.join(activityRoot, '2000-01-01.jsonl'), '{"ts":"2000-01-01T00:00:00.000Z"}\n');
    fs.writeFileSync(path.join(activityRoot, 'README.txt'), 'not an activity log\n');

    assert.equal(pruneActivity(365), 1);
    assert.equal(fs.existsSync(path.join(activityRoot, '2000-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(activityRoot, 'README.txt')), true);
    assert.equal(pruneActivity(365), 0);

    process.env.PICKLE_DATA_ROOT = path.join(root, 'missing-root');
    assert.equal(pruneActivity(365), 0, 'a missing activity root is an empty retention set');
  } finally {
    resetActivityLoggerForTests();
    if (originalRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = originalRoot;
  }
});

test('activity logger rejects events beyond its bounded pending capacity', () => {
  resetActivityLoggerForTests();
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    setActivityWriterForTests(() => {
      throw 'offline';
    });
    for (let index = 0; index < 1_024; index += 1) {
      assert.equal(logActivity({ event: `queued-${index}` }, { maxAttempts: 0 }), false);
    }
    assert.equal(pendingActivityCount(), 1_024);
    assert.equal(logActivity({ event: 'overflow' }), false);
    assert.equal(pendingActivityCount(), 1_024);
    assert.match(errors.at(-1), /pending buffer full \(1024\)/);
  } finally {
    console.error = originalError;
    resetActivityLoggerForTests();
  }
});
