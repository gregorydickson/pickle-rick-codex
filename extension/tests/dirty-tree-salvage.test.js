// @tier: integration
// B-1SEAM WS-3 dirty-tree-salvage seam (codex port).
//
// Exercises the standalone salvage primitive against REAL temp git repos:
//   - stashUnattributableRemainder: clean tree -> null/no ref; dirty tree ->
//     refs/pickle/salvage/<session> anchoring tracked mods AND untracked files,
//     while the real worktree AND real index stay byte-identical (throwaway
//     GIT_INDEX_FILE).
//   - salvageDirtyTree: foreign>0 -> ref + stagePaths===owned + foreign
//     recoverable; foreign===0 -> salvageRef:null, no ref, owned passthrough.
//   - stageOwnedPaths: per-path add of a deleted + a new file, unlisted dirt
//     left untracked.
//   - source pin: exactly ONE `add -A`, bound to the throwaway GIT_INDEX_FILE
//     stash; no other whole-tree add/-u.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  stashUnattributableRemainder,
  salvageDirtyTree,
  stageOwnedPaths,
} from '../services/dirty-tree-salvage.js';
import { makeTempRoot } from './helpers.js';

const noop = () => {};

function git(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(prefix) {
  const dir = makeTempRoot(prefix);
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Pickle Rick Tests']);
  git(dir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  return dir;
}

function commitBase(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
}

function refExists(dir, ref) {
  const out = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/pickle/salvage']).trim();
  return out.split('\n').filter(Boolean).includes(ref);
}

function sessionDirFor(session) {
  return path.join('/some/sessions/root', session);
}

test('stashUnattributableRemainder returns null and creates no ref on a clean tree', () => {
  const dir = initRepo('pickle-salvage-clean-');
  commitBase(dir, { 'a.txt': 'base\n' });
  const session = 'sess-clean';

  const result = stashUnattributableRemainder(dir, sessionDirFor(session), noop);

  assert.equal(result, null, 'clean tree returns null');
  assert.equal(
    git(dir, ['for-each-ref', 'refs/pickle/salvage']).trim(),
    '',
    'no salvage ref is created on a clean tree',
  );
});

test('stashUnattributableRemainder anchors tracked mods + untracked without mutating index/worktree', () => {
  const dir = initRepo('pickle-salvage-dirty-');
  commitBase(dir, { 'tracked.txt': 'base\n' });
  const session = 'sess-dirty';
  const ref = `refs/pickle/salvage/${session}`;

  // tracked modification + untracked file
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'modified\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'brand new\n');

  const statusBefore = git(dir, ['status', '--porcelain']);
  const diffCachedBefore = git(dir, ['diff', '--cached']);

  const result = stashUnattributableRemainder(dir, sessionDirFor(session), noop);

  assert.ok(result, 'returns a truthy ref name');
  assert.equal(result, ref);
  assert.ok(refExists(dir, ref), 'salvage ref exists');

  const tree = git(dir, ['ls-tree', '-r', '--name-only', ref])
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(tree, ['tracked.txt', 'untracked.txt'], 'anchored tree has tracked + untracked');

  const blob = git(dir, ['show', `${ref}:tracked.txt`]);
  assert.equal(blob, 'modified\n', 'anchored tracked file carries the modification');

  // real worktree + real index untouched
  assert.equal(git(dir, ['status', '--porcelain']), statusBefore, 'worktree/status byte-identical');
  assert.equal(git(dir, ['diff', '--cached']), diffCachedBefore, 'real index byte-identical');
  assert.equal(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8'), 'modified\n');
  assert.equal(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'brand new\n');
});

test('salvageDirtyTree anchors + returns owned only when foreign paths exist', () => {
  const dir = initRepo('pickle-salvage-foreign-');
  commitBase(dir, { 'owned.txt': 'base\n' });
  const session = 'sess-foreign';
  const ref = `refs/pickle/salvage/${session}`;

  fs.writeFileSync(path.join(dir, 'owned.txt'), 'owned change\n');
  fs.writeFileSync(path.join(dir, 'foreign.txt'), 'foreign work\n');

  const owned = ['owned.txt'];
  const plan = salvageDirtyTree({
    workingDir: dir,
    sessionDir: sessionDirFor(session),
    owned,
    foreign: ['foreign.txt'],
    log: noop,
  });

  assert.deepEqual(plan.stagePaths, owned, 'stagePaths deep-equals owned');
  assert.equal(plan.salvageRef, ref, 'salvageRef points at the created ref');
  assert.ok(refExists(dir, ref), 'salvage ref created');

  const recovered = git(dir, ['show', `${ref}:foreign.txt`]);
  assert.equal(recovered, 'foreign work\n', 'foreign path recoverable from ref');
});

test('salvageDirtyTree passes owned through with no ref when foreign is empty', () => {
  const dir = initRepo('pickle-salvage-noforeign-');
  commitBase(dir, { 'owned.txt': 'base\n' });
  const session = 'sess-noforeign';

  fs.writeFileSync(path.join(dir, 'owned.txt'), 'owned change\n');

  const owned = ['owned.txt'];
  const plan = salvageDirtyTree({
    workingDir: dir,
    sessionDir: sessionDirFor(session),
    owned,
    foreign: [],
    log: noop,
  });

  assert.equal(plan.salvageRef, null, 'no ref when foreign is empty');
  assert.deepEqual(plan.stagePaths, owned, 'owned passes through unchanged');
  assert.equal(
    git(dir, ['for-each-ref', 'refs/pickle/salvage']).trim(),
    '',
    'no salvage ref created for a foreign-free tree',
  );
});

test('stageOwnedPaths stages exactly the listed new + deleted paths; unlisted dirt stays untracked', () => {
  const dir = initRepo('pickle-salvage-stage-');
  commitBase(dir, { 'todelete.txt': 'base\n', 'other.txt': 'base\n' });
  const session = 'sess-stage';

  fs.rmSync(path.join(dir, 'todelete.txt')); // deleted tracked file
  fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n'); // new file
  fs.writeFileSync(path.join(dir, 'unlisted.txt'), 'bystander\n'); // unlisted dirty path

  stageOwnedPaths(dir, ['todelete.txt', 'new.txt']);

  const cached = git(dir, ['diff', '--cached', '--name-only'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(cached, ['new.txt', 'todelete.txt'], 'exactly the listed paths staged');

  // deletion recorded in the index
  const cachedStatus = git(dir, ['diff', '--cached', '--name-status']);
  assert.match(cachedStatus, /^D\s+todelete\.txt$/m, 'deleted tracked file staged as deletion');
  assert.match(cachedStatus, /^A\s+new\.txt$/m, 'new file staged as addition');

  // unlisted dirt is still untracked/unstaged
  assert.match(git(dir, ['status', '--porcelain']), /^\?\? unlisted\.txt$/m, 'unlisted dirt untracked');
});

test('source pin: exactly one `add -A`, bound to the throwaway GIT_INDEX_FILE stash; no other whole-tree add', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const srcPath = path.resolve(testDir, '..', 'src', 'services', 'dirty-tree-salvage.ts');
  const source = fs.readFileSync(srcPath, 'utf8');

  // Count `add -A` array-literal forms: 'add', '-A'  (single or double quoted).
  const addAll = source.match(/['"]add['"]\s*,\s*['"]-A['"]/g) || [];
  assert.equal(addAll.length, 1, `expected exactly one \`add -A\`, found ${addAll.length}`);

  // No whole-tree `add -u` anywhere.
  const addU = source.match(/['"]add['"]\s*,\s*['"]-u['"]/g) || [];
  assert.equal(addU.length, 0, 'no whole-tree `add -u` allowed');

  // The module must use a throwaway GIT_INDEX_FILE for the stash.
  assert.match(source, /GIT_INDEX_FILE/, 'uses a throwaway GIT_INDEX_FILE');
});
