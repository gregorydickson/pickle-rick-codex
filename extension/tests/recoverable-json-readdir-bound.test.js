// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listRecoverableTmpEntries } from '../services/recoverable-json.js';

const DEAD_PID = 99_999_999;

test('recoverable tmp discovery filters 10k decoys before per-file recovery I/O', () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => `decoy-${i}.json`);
  entries.push(`state.json.tmp.${DEAD_PID}`);
  entries.push('state.json.tmp.not-a-pid');
  entries.push(`other.json.tmp.${DEAD_PID}`);

  assert.deepEqual(listRecoverableTmpEntries(entries, 'state.json'), [
    { entry: `state.json.tmp.${DEAD_PID}`, pid: DEAD_PID },
  ]);
});
