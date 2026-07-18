// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DestructiveGitSafetyError, recoverableHardReset } from '../services/recoverable-git.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recoverable-git-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.name', 'Recovery Tests']);
  git(cwd, ['config', 'user.email', 'recovery@example.test']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'base']);
  return cwd;
}

test('recoverable hard reset archives committed, dirty, and untracked state before restoring', () => {
  const cwd = repo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-session-'));
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'committed attempt\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'attempt']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'dirty attempt\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'new evidence\n');

  const archive = recoverableHardReset({
    workingDir: cwd,
    sessionDir,
    targetHead: baseline,
    operation: 'test-reset',
  });

  assert.equal(git(cwd, ['rev-parse', 'HEAD']), baseline);
  assert.equal(git(cwd, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'base\n');
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

  assert.throws(
    () => recoverableHardReset({
      workingDir: cwd,
      sessionDir,
      targetHead: baseline,
      operation: 'bad-ref',
      headRecoveryRef: 'refs/heads/bad ref',
    }),
    (error) => error instanceof DestructiveGitSafetyError && error.kind === 'destructive-archive-failed',
  );
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), attempted);
});
