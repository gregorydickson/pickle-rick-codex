// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureProtectedPathManifest, changedProtectedPaths } from '../services/microverse-protection.js';
import { makeTempRoot } from './helpers.js';

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function initGitRepo(root) {
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'tests@example.com']);
  runGit(root, ['config', 'user.name', 'Tests']);
}

function protectedRepo() {
  const root = makeTempRoot('pickle-microverse-protected-');
  initGitRepo(root);
  fs.mkdirSync(path.join(root, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'harness', 'metric.js'), 'export const metric = 1;\n');
  fs.writeFileSync(path.join(root, 'allowed.test.js'), 'baseline\n');
  runGit(root, ['add', 'harness/metric.js', 'allowed.test.js']);
  runGit(root, ['commit', '-m', 'baseline']);
  return root;
}

test('protected manifest ignores changes outside declared paths', () => {
  const root = protectedRepo();
  const manifest = captureProtectedPathManifest(root, ['harness/**']);
  fs.writeFileSync(path.join(root, 'allowed.test.js'), 'changed\n');
  assert.deepEqual(changedProtectedPaths(root, manifest), []);
});

test('protected manifest detects modified, removed, and newly-created matching files', () => {
  const root = protectedRepo();
  const manifest = captureProtectedPathManifest(root, ['harness/**']);
  fs.writeFileSync(path.join(root, 'harness', 'metric.js'), 'export const metric = 2;\n');
  fs.writeFileSync(path.join(root, 'harness', 'new.json'), '{}\n');
  assert.deepEqual(changedProtectedPaths(root, manifest), ['harness/metric.js', 'harness/new.json']);
  fs.rmSync(path.join(root, 'harness', 'metric.js'));
  assert.deepEqual(changedProtectedPaths(root, manifest), ['harness/metric.js', 'harness/new.json']);
});

test('protected manifest rejects paths that can escape the repository', () => {
  const root = protectedRepo();
  assert.throws(() => captureProtectedPathManifest(root, ['../outside']), /repository-relative/);
  assert.throws(() => captureProtectedPathManifest(root, ['/tmp/outside']), /repository-relative/);
});
