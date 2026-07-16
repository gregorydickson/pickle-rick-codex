// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { readRecoverableJsonObject } from '../services/recoverable-json.js';

const DEAD_PID = 99_999_999;
const BASE_TIME = 1_700_000_000_000;

test('readRecoverableJsonObject readdirSync bound: 10k decoys + 1 matching tmp under 50ms (darwin only)', () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const parentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rj-readdir-bound-')));
  try {
    const target = path.join(parentDir, 'state.json');

    fs.writeFileSync(target, JSON.stringify({ source: 'base' }));
    const baseTime = new Date(BASE_TIME);
    fs.utimesSync(target, baseTime, baseTime);

    for (let i = 0; i < 10_000; i++) {
      fs.writeFileSync(path.join(parentDir, `decoy-${i}.json`), '{}');
    }

    const matchingTmp = `${target}.tmp.${DEAD_PID}`;
    fs.writeFileSync(matchingTmp, JSON.stringify({ source: 'recovered' }));
    const tmpTime = new Date(BASE_TIME + 1_000);
    fs.utimesSync(matchingTmp, tmpTime, tmpTime);

    const t0 = performance.now();
    const result = readRecoverableJsonObject(target);
    const elapsed = performance.now() - t0;

    assert.ok(elapsed < 50, `wall-clock ${elapsed.toFixed(1)}ms >= 50ms — prefix filter may be missing`);
    assert.deepEqual(result, { source: 'recovered' });
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});
