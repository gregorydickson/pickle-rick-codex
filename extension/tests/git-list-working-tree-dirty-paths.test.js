// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listWorkingTreeDirtyPaths } from '../services/git-utils.js';
import { makeTempRoot } from './helpers.js';

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

test('listWorkingTreeDirtyPaths returns new, modified, and deleted paths deduped and localeCompare-sorted', () => {
  const dir = initRepo('pickle-rick-list-dirty-basic-');
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'deleted.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);

  fs.writeFileSync(path.join(dir, 'modified.txt'), 'changed\n');
  fs.rmSync(path.join(dir, 'deleted.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');

  const result = listWorkingTreeDirtyPaths(dir);
  assert.deepEqual(result, ['deleted.txt', 'modified.txt', 'new.txt']);
});

test('listWorkingTreeDirtyPaths surfaces both paths for a rename so owned staging preserves the move', () => {
  const dir = initRepo('pickle-rick-list-dirty-rename-');
  fs.writeFileSync(path.join(dir, 'oldname.txt'), 'stable content for rename detection\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);

  git(dir, ['mv', 'oldname.txt', 'newname.txt']);

  const result = listWorkingTreeDirtyPaths(dir);
  assert.ok(result.includes('newname.txt'), 'new path is returned');
  assert.ok(result.includes('oldname.txt'), 'rename source is returned for deletion staging');
});

test('listWorkingTreeDirtyPaths filters out paths under excludePrefixes', () => {
  const dir = initRepo('pickle-rick-list-dirty-exclude-');
  fs.mkdirSync(path.join(dir, 'excluded'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'excluded', 'nested.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);

  fs.writeFileSync(path.join(dir, 'keep.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'excluded', 'nested.txt'), 'changed\n');

  const withoutExclude = listWorkingTreeDirtyPaths(dir);
  assert.deepEqual(withoutExclude, ['excluded/nested.txt', 'keep.txt']);

  const withExclude = listWorkingTreeDirtyPaths(dir, ['excluded']);
  assert.deepEqual(withExclude, ['keep.txt']);
});

test('listWorkingTreeDirtyPaths throws when git exits non-zero (non-git dir)', () => {
  const dir = makeTempRoot('pickle-rick-list-dirty-nongit-');
  assert.throws(() => listWorkingTreeDirtyPaths(dir));
});
