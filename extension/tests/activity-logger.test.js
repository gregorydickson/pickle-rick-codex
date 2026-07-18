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
