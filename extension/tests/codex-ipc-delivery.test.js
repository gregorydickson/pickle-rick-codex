// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.js';

test('every controller-to-broker IPC write has callback delivery accounting', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/services/codex.ts'), 'utf8');
  const directSends = source.match(/child\.send\s*\(/g) || [];

  assert.equal(directSends.length, 1,
    'broker IPC writes must stay centralized so peer-close EPIPE cannot escape as a ChildProcess error');
  assert.doesNotMatch(source, /child\.send\?\./,
    'optional child.send calls without callback accounting recreate the asynchronous EPIPE race');
  assert.match(source, /child\.send\(message, \(error\) => \{/,
    'the centralized send must consume asynchronous delivery errors through a callback');
  assert.match(source, /if \(authorityObserved\(\)\) return;/,
    'only an authenticated protocol acknowledgement may supersede delivery failure');
  assert.match(source, /recordUnacknowledgedFailure/,
    'unacknowledged transport failures must remain fail-closed');
});
