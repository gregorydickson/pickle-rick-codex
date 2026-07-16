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

function commitMore(dir, message, opts = {}) {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  git(dir, ['add', 'a.txt']);
  const args = [];
  if (opts.authorName && opts.authorEmail) {
    args.push('-c', `user.name=${opts.authorName}`, '-c', `user.email=${opts.authorEmail}`);
  }
  args.push('commit', '-m', message);
  git(dir, args);
  return git(dir, ['rev-parse', 'HEAD']);
}

function trailerOf(dir, sha) {
  return git(dir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)', sha]);
}

test('VAL-STAMP-014: an auto-commit candidate git cannot resolve is never returned', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: bogus, ticketId: 'r1' }),
    null,
  );
});

test('VAL-STAMP-015: HEAD equal to baseline (no commit past baseline) is never stamped', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null, ticketId: 'r1' }),
    null,
  );
});

test('resolves the auto-commit sha as-is when spawn-morty owns the commit (no amend)', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'auto');
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: head, ticketId: 'r1' }),
    head,
  );
});

test('VAL-STAMP-013: a worker self-commit WITH a matching trailer is trusted unchanged (no amend)', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'worker: real work\n\nPickle-Ticket: r1');
  const resolved = resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null, ticketId: 'r1' });
  assert.equal(resolved, head, 'trailer-matched self-commit trusted as-is');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'HEAD unchanged — no amend/second commit');
});

test('a worker self-commit WITHOUT a matching trailer is reconciled by amend (single-commit, clean index)', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'worker: real work', { authorName: 'Worker', authorEmail: 'worker@local.invalid' });
  const resolved = resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null, ticketId: 'r1' });
  assert.ok(resolved, 'a sha is returned');
  assert.equal(resolved, git(dir, ['rev-parse', 'HEAD']), 'resolved sha equals the amended HEAD');
  assert.notEqual(resolved, head, 'the tip was amended to append the trailer');
  assert.equal(trailerOf(dir, resolved), 'r1', 'the amended commit carries the Pickle-Ticket trailer');
  assert.equal(runGitCount(dir, baseline), 1, 'still exactly one commit past baseline');
  assert.equal(git(dir, ['log', '-1', '--format=%an <%ae>', resolved]), 'Worker <worker@local.invalid>', 'author preserved');
});

test('a multi-commit window is NOT amended — the untrailed candidate is stamped unchanged', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  commitMore(dir, 'worker: first');
  const head = commitMore(dir, 'worker: second');
  const resolved = resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null, ticketId: 'r1' });
  assert.equal(resolved, head, 'candidate stamped unchanged in a multi-commit window');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'HEAD unchanged — no amend');
  assert.equal(trailerOf(dir, resolved), '', 'no trailer appended');
});

test('a dirty index is NOT amended — the untrailed candidate is stamped unchanged', () => {
  const dir = initRepo();
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  const head = commitMore(dir, 'worker: real work');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  git(dir, ['add', 'staged.txt']);
  const resolved = resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: baseline, autoCommitSha: null, ticketId: 'r1' });
  assert.equal(resolved, head, 'candidate stamped unchanged when the index is dirty');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'HEAD unchanged — no amend');
});

test('a non-git working dir yields null (never throws)', () => {
  const dir = makeTempRoot('pickle-nogit-');
  assert.equal(
    resolveCompletionCommitSha({ workingDir: dir, baselineHeadSha: '', autoCommitSha: null, ticketId: 'r1' }),
    null,
  );
});

function runGitCount(dir, baseline) {
  return Number(git(dir, ['rev-list', '--count', `${baseline}..HEAD`]));
}
