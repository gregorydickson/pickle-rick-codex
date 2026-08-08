// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DestructiveGitSafetyError, recoverableHardReset } from '../services/recoverable-git.js';
import { listChangedPathsSince } from '../services/git-utils.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recoverable-git-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.name', 'Recovery Tests']);
  git(cwd, ['config', 'user.email', 'recovery@example.test']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'unrelated base\n');
  git(cwd, ['add', 'tracked.txt', 'unrelated.txt']);
  git(cwd, ['commit', '-m', 'base']);
  return cwd;
}

test('path-scoped recovery archives owned state and preserves injected unrelated tracked and untracked work', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-session-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'committed attempt\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'attempt']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'dirty attempt\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'new evidence\n');
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'injected unrelated work\n');
  fs.writeFileSync(path.join(cwd, 'injected.txt'), 'injected untracked work\n');

  const archive = recoverableHardReset({
    workingDir: cwd,
    sessionDir,
    targetHead: baseline,
    operation: 'test-reset',
    ownedPaths: ['tracked.txt', 'new.txt'],
  });

  assert.equal(git(cwd, ['rev-parse', 'HEAD']), baseline);
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.txt'), 'utf8'), 'injected unrelated work\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'injected.txt'), 'utf8'), 'injected untracked work\n');
  assert.match(git(cwd, ['status', '--porcelain']), /unrelated\.txt/);
  assert.match(git(cwd, ['status', '--porcelain']), /injected\.txt/);
  assert.ok(archive.headRef);
  assert.ok(archive.dirtyRef);
  assert.equal(git(cwd, ['show', `${archive.headRef}:tracked.txt`]), 'committed attempt');
  assert.equal(git(cwd, ['show', `${archive.dirtyRef}:tracked.txt`]), 'dirty attempt');
  assert.equal(git(cwd, ['show', `${archive.dirtyRef}:new.txt`]), 'new evidence');
});

test('recoverable hard reset aborts without mutation when archive cap is exceeded', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-cap-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'oversize.bin'), Buffer.alloc(256, 1));

  assert.throws(
    () => recoverableHardReset({
      workingDir: cwd,
      sessionDir,
      targetHead: baseline,
      operation: 'cap-test',
      ownedPaths: ['oversize.bin'],
      maxArchiveBytes: 32,
    }),
    (error) => error instanceof DestructiveGitSafetyError && error.kind === 'destructive-archive-cap-exceeded',
  );
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), baseline);
  assert.equal(fs.existsSync(path.join(cwd, 'oversize.bin')), true);
});

test('recoverable hard reset aborts when the recovery ref cannot be anchored', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-ref-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'attempt\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'attempt']);
  const attempted = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'injected tracked work\n');
  fs.writeFileSync(path.join(cwd, 'injected.txt'), 'injected untracked work\n');

  assert.throws(
    () => recoverableHardReset({
      workingDir: cwd,
      sessionDir,
      targetHead: baseline,
      operation: 'bad-ref',
      ownedPaths: ['tracked.txt'],
      headRecoveryRef: 'refs/heads/bad ref',
    }),
    (error) => error instanceof DestructiveGitSafetyError && error.kind === 'destructive-archive-failed',
  );
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), attempted);
  assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.txt'), 'utf8'), 'injected tracked work\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'injected.txt'), 'utf8'), 'injected untracked work\n');
});

test('path-scoped recovery restores both sides of a committed rename with unusual names', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-rename-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  const source = 'old odd [name].txt';
  const destination = 'new odd [name].txt';
  const unrelatedUntracked = 'user odd [draft].txt';
  fs.writeFileSync(path.join(cwd, source), 'rename evidence\n');
  git(cwd, ['add', source]);
  git(cwd, ['commit', '-m', 'add rename source']);
  const renameBaseline = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['mv', source, destination]);
  git(cwd, ['commit', '-m', 'rename attempt']);
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'injected unrelated work\n');
  fs.writeFileSync(path.join(cwd, unrelatedUntracked), 'injected untracked work\n');

  const changed = listChangedPathsSince(cwd, renameBaseline);
  assert.ok(changed.includes(source));
  assert.ok(changed.includes(destination));
  recoverableHardReset({
    workingDir: cwd,
    sessionDir,
    targetHead: renameBaseline,
    operation: 'rename-reset',
    ownedPaths: changed.filter((candidate) => candidate === source || candidate === destination),
  });

  assert.notEqual(git(cwd, ['rev-parse', 'HEAD']), baseline);
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), renameBaseline);
  assert.equal(fs.readFileSync(path.join(cwd, source), 'utf8'), 'rename evidence\n');
  assert.equal(fs.existsSync(path.join(cwd, destination)), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.txt'), 'utf8'), 'injected unrelated work\n');
  assert.equal(fs.readFileSync(path.join(cwd, unrelatedUntracked), 'utf8'), 'injected untracked work\n');
});

test('path-scoped recovery preserves mixed-commit topology while reverting only owned paths', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-mixed-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'owned attempt\n');
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'preserved commit\n');
  git(cwd, ['add', 'tracked.txt', 'unrelated.txt']);
  git(cwd, ['commit', '-m', 'mixed owned and preserved changes']);
  const mixedCommit = git(cwd, ['rev-parse', 'HEAD']);

  recoverableHardReset({
    workingDir: cwd,
    sessionDir,
    targetHead: baseline,
    operation: 'mixed-ownership',
    ownedPaths: ['tracked.txt'],
    evidencePaths: ['tracked.txt', 'unrelated.txt'],
  });

  const restoredHead = git(cwd, ['rev-parse', 'HEAD']);
  assert.notEqual(restoredHead, baseline);
  assert.notEqual(restoredHead, mixedCommit);
  assert.doesNotThrow(() => git(cwd, ['merge-base', '--is-ancestor', mixedCommit, restoredHead]));
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.txt'), 'utf8'), 'preserved commit\n');
  assert.equal(git(cwd, ['show', 'HEAD:tracked.txt']), 'base');
  assert.equal(git(cwd, ['show', 'HEAD:unrelated.txt']), 'preserved commit');
  assert.equal(git(cwd, ['status', '--porcelain']), '');
});
