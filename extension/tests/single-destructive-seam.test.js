// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.js';

test('worker, Citadel, and Microverse hard reset only through the recoverable Git seam', () => {
  const sources = [
    'src/bin/spawn-morty.ts',
    'src/bin/loop-runner.ts',
    'src/services/citadel.ts',
    'src/services/metric-convergence.ts',
  ];
  for (const relativePath of sources) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /reset[^\n]{0,40}--hard|\['reset',\s*'--hard'/, `${relativePath} bypasses recoverable-git`);
    assert.match(source, /recoverableHardReset/, `${relativePath} must use recoverable-git`);
  }
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src/services/recoverable-git.ts'), 'utf8'),
    /\['reset', '--hard', options\.targetHead\]/,
  );
});
