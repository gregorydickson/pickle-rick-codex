import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, runNode } from './helpers.js';

test('metrics command is explicit when there is no data', () => {
  const env = { PICKLE_DATA_ROOT: makeTempRoot() };
  const output = runNode(['bin/metrics.js', '--days', '0'], { env }).trim();
  assert.match(output, /^No metrics data found/);
});
