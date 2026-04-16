import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyPatch,
  canApplyPatch,
  classifyPatchApplyError,
  checkPatchApply,
  createPatchFromWorktree,
  createTicketWorktree,
  removeTicketWorktree,
} from '../lib/git-utils.js';
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
