// @tier: fast
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  AddDirOutsideSandboxError,
  assertAddDirsUnderTmpdirIfTestMode,
} from '../services/codex.js';
import { makeTempRoot } from './helpers.js';

test('test-mode add-dir guard accepts temp paths and raises a typed error outside the sandbox', () => {
  const tempDir = makeTempRoot('pickle-add-dir-');
  assert.doesNotThrow(() => assertAddDirsUnderTmpdirIfTestMode([tempDir], { PICKLE_TEST_MODE: '1' }));
  assert.throws(
    () => assertAddDirsUnderTmpdirIfTestMode([path.resolve(os.tmpdir(), '..', 'outside-pickle-sandbox')], { PICKLE_TEST_MODE: '1' }),
    (error) => error instanceof AddDirOutsideSandboxError && error.addDir.includes('outside-pickle-sandbox'),
  );
});

test('test-mode add-dir guard resolves an existing symlink parent before accepting a missing child', { skip: process.platform === 'win32' }, () => {
  const sandbox = makeTempRoot('pickle-add-dir-symlink-');
  const link = path.join(sandbox, 'escape');
  fs.symlinkSync(process.cwd(), link, 'dir');
  assert.throws(
    () => assertAddDirsUnderTmpdirIfTestMode([path.join(link, 'not-created')], { PICKLE_TEST_MODE: '1' }, sandbox),
    AddDirOutsideSandboxError,
  );
});

test('production add-dir behavior is unaffected by the test-only guard', () => {
  assert.doesNotThrow(() => assertAddDirsUnderTmpdirIfTestMode(['/definitely/outside/tmp'], {}));
});
