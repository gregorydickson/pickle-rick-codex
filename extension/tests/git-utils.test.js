// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  amendCommitTrailer,
  applyPatch,
  canApplyPatch,
  classifyPatchApplyError,
  checkPatchApply,
  countCommitsSince,
  createPatchFromWorktree,
  createTicketWorktree,
  getWorkingTreeFingerprint,
  isIndexClean,
  readCommitTrailer,
  removeTicketWorktree,
} from '../services/git-utils.js';
import { makeTempRoot } from './helpers.js';

function runGit(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('createPatchFromWorktree preserves a valid trailing newline for git apply', () => {
  const repoDir = makeTempRoot('pickle-rick-git-utils-repo-');
  const sessionDir = makeTempRoot('pickle-rick-git-utils-session-');
  let worktreeDir = null;

  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.name', 'Pickle Rick Tests']);
  runGit(repoDir, ['config', 'user.email', 'pickle-rick-tests@example.com']);

  const targetFile = path.join(repoDir, 'feature-flags.ts');
  fs.writeFileSync(targetFile, 'export const enabled = false;\n');
  runGit(repoDir, ['add', 'feature-flags.ts']);
  runGit(repoDir, ['commit', '-m', 'base']);

  try {
    const worktree = createTicketWorktree({ repoDir, sessionDir, ticketId: 'r2' });
    worktreeDir = worktree.worktreeDir;

    fs.writeFileSync(
      path.join(worktreeDir, 'feature-flags.ts'),
      'export const enabled = true;\n',
    );

    const patchPath = path.join(sessionDir, 'r2.patch');
    createPatchFromWorktree(worktreeDir, worktree.baseSha, patchPath);

    const patch = fs.readFileSync(patchPath, 'utf8');
    assert.ok(patch.endsWith('\n'), 'generated patch must preserve the trailing newline');
    assert.equal(canApplyPatch(repoDir, patchPath), true);

    applyPatch(repoDir, patchPath);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'export const enabled = true;\n');
  } finally {
    if (worktreeDir) {
      removeTicketWorktree(worktreeDir);
    }
  }
});

test('createTicketWorktree supports repos with an unborn HEAD', () => {
  const repoDir = makeTempRoot('pickle-rick-git-utils-unborn-repo-');
  const sessionDir = makeTempRoot('pickle-rick-git-utils-unborn-session-');
  let worktreeDir = null;

  runGit(repoDir, ['init']);
  const targetFile = path.join(repoDir, 'README.md');
  fs.writeFileSync(targetFile, '# bootstrap\n');

  try {
    const worktree = createTicketWorktree({ repoDir, sessionDir, ticketId: 'r1' });
    worktreeDir = worktree.worktreeDir;

    fs.writeFileSync(path.join(worktreeDir, 'README.md'), '# bootstrap\n\nupdated\n');

    const patchPath = path.join(sessionDir, 'r1.patch');
    createPatchFromWorktree(worktreeDir, worktree.baseSha, patchPath);

    assert.equal(canApplyPatch(repoDir, patchPath), true);
    applyPatch(repoDir, patchPath);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), '# bootstrap\n\nupdated\n');
  } finally {
    if (worktreeDir) {
      removeTicketWorktree(worktreeDir);
    }
  }
});

test('checkPatchApply classifies malformed patch payloads as invalid', () => {
  const repoDir = makeTempRoot('pickle-rick-git-utils-repo-');
  const patchPath = path.join(repoDir, 'broken.patch');

  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.name', 'Pickle Rick Tests']);
  runGit(repoDir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['commit', '-m', 'base']);

  fs.writeFileSync(patchPath, 'this is not a patch\n');

  const result = checkPatchApply(repoDir, patchPath);
  assert.equal(result.ok, false);
  assert.match(result.error, /no valid patches in input|patch/i);
  assert.equal(classifyPatchApplyError(result.error), 'patch-invalid');
});

test('classifyPatchApplyError keeps merge failures distinct from malformed patches', () => {
  assert.equal(
    classifyPatchApplyError('error: No valid patches in input (allow with "--allow-empty")'),
    'patch-invalid',
  );
  assert.equal(
    classifyPatchApplyError('error: patch failed: feature-flags.ts:1\nerror: feature-flags.ts: patch does not apply'),
    'patch-conflict',
  );
});

test('getWorkingTreeFingerprint tracks file edits outside git worktrees', () => {
  const workingDir = makeTempRoot('pickle-rick-git-utils-plain-dir-');
  const targetFile = path.join(workingDir, 'notes.txt');

  fs.writeFileSync(targetFile, 'alpha\n');
  const before = getWorkingTreeFingerprint(workingDir);

  fs.writeFileSync(targetFile, 'beta\n');
  const after = getWorkingTreeFingerprint(workingDir);

  assert.notEqual(before, after);
});

function initTrailerRepo() {
  const dir = makeTempRoot('pickle-rick-git-trailer-');
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Base Author']);
  runGit(dir, ['config', 'user.email', 'base@local.invalid']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  runGit(dir, ['add', 'a.txt']);
  runGit(dir, ['commit', '-m', 'base']);
  return dir;
}

function head(dir) {
  return runGit(dir, ['rev-parse', 'HEAD']).trim();
}

test('readCommitTrailer returns the trimmed trailer value when present', () => {
  const dir = initTrailerRepo();
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  runGit(dir, ['add', 'a.txt']);
  runGit(dir, ['commit', '-m', 'work\n\nPickle-Ticket: r1']);
  assert.equal(readCommitTrailer(dir, head(dir), 'Pickle-Ticket'), 'r1');
});

test('readCommitTrailer returns null when the trailer is absent', () => {
  const dir = initTrailerRepo();
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  runGit(dir, ['add', 'a.txt']);
  runGit(dir, ['commit', '-m', 'plain work']);
  assert.equal(readCommitTrailer(dir, head(dir), 'Pickle-Ticket'), null);
});

test('readCommitTrailer never throws for an unresolvable sha or non-git dir', () => {
  const dir = initTrailerRepo();
  assert.equal(readCommitTrailer(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'Pickle-Ticket'), null);
  assert.equal(readCommitTrailer(dir, '', 'Pickle-Ticket'), null);
  const nonGit = makeTempRoot('pickle-rick-git-trailer-nogit-');
  assert.equal(readCommitTrailer(nonGit, 'HEAD', 'Pickle-Ticket'), null);
});

test('amendCommitTrailer appends the trailer, preserves the original author, and returns the new sha', () => {
  const dir = initTrailerRepo();
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  runGit(dir, ['add', 'a.txt']);
  runGit(dir, ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'worker: real work']);
  const before = head(dir);
  const authorBefore = runGit(dir, ['log', '-1', '--format=%an <%ae>', before]).trim();
  assert.equal(authorBefore, 'Worker <worker@local.invalid>');

  const amended = amendCommitTrailer(dir, before, 'Pickle-Ticket: r1');
  assert.ok(amended, 'returns a sha');
  assert.equal(amended, head(dir), 'returned sha equals new HEAD');
  assert.notEqual(amended, before, 'HEAD was rewritten');

  assert.equal(readCommitTrailer(dir, amended, 'Pickle-Ticket'), 'r1');
  assert.equal(runGit(dir, ['log', '-1', '--format=%an <%ae>', amended]).trim(), 'Worker <worker@local.invalid>', 'author preserved');
  assert.equal(runGit(dir, ['log', '-1', '--format=%s', amended]).trim(), 'worker: real work', 'subject preserved');
  assert.match(runGit(dir, ['log', '-1', '--format=%cn', amended]).trim(), /Pickle Rick/, 'committer is the pickle identity');

  const window = runGit(dir, ['rev-list', '--count', 'HEAD']).trim();
  assert.equal(window, '2', 'amend did not create a second commit');
});

test('amendCommitTrailer returns null on empty message or unresolvable sha (never throws)', () => {
  const dir = initTrailerRepo();
  runGit(dir, ['commit', '--amend', '--allow-empty-message', '-m', '']);
  assert.equal(amendCommitTrailer(dir, head(dir), 'Pickle-Ticket: r1'), null);
  assert.equal(amendCommitTrailer(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'Pickle-Ticket: r1'), null);
  assert.equal(amendCommitTrailer(dir, '', 'Pickle-Ticket: r1'), null);
});

test('countCommitsSince and isIndexClean report window size and staged state', () => {
  const dir = initTrailerRepo();
  const baseline = head(dir);
  assert.equal(countCommitsSince(dir, baseline), 0);
  assert.equal(isIndexClean(dir), true);

  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  runGit(dir, ['add', 'a.txt']);
  runGit(dir, ['commit', '-m', 'one']);
  assert.equal(countCommitsSince(dir, baseline), 1);

  fs.writeFileSync(path.join(dir, 'b.txt'), 'staged\n');
  runGit(dir, ['add', 'b.txt']);
  assert.equal(isIndexClean(dir), false, 'staged path makes the index dirty');
});
