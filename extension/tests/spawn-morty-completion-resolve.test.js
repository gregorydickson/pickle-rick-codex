// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCompletionCommitSha } from '../bin/spawn-morty.js';
import { makeTempRoot } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const dir = makeTempRoot('pickle-resolve-');
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Resolve Test']);
  git(dir, ['config', 'user.email', 'resolve@local.invalid']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

function commitMore(dir, message) {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('VAL-STAMP-014: an auto-commit candidate git cannot resolve is never returned', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: bogus }),
    null,
  );
});

test('VAL-STAMP-015: HEAD equal to baseline (no commit past baseline) is never stamped', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null }),
    null,
  );
});

test('resolves the auto-commit sha when spawn-morty owns the commit', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'auto');
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: head }),
    head,
  );
});

test('resolves HEAD when the worker self-committed past baseline (no auto-commit)', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'worker');
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null }),
    head,
  );
});

test('a non-git working dir yields null (never throws)', () => {
  const dir = makeTempRoot('pickle-nogit-');
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: '', autoCommitSha: null }),
    null,
  );
});
