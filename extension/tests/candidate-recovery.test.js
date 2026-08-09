// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  persistRejectedCandidateCheckpoint,
  restoreRejectedCandidateCheckpoint,
} from '../services/candidate-recovery.js';
import { stashUnattributableRemainder } from '../services/dirty-tree-salvage.js';

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

function fixture() {
  const workingDir = makeTempRoot('candidate-recovery-repo-');
  const sessionDir = makeTempRoot('candidate-recovery-session-');
  git(workingDir, ['init', '-q']);
  git(workingDir, ['config', 'user.name', 'Candidate Recovery']);
  git(workingDir, ['config', 'user.email', 'candidate@example.test']);
  fs.writeFileSync(path.join(workingDir, 'tracked.txt'), 'base\n');
  git(workingDir, ['add', 'tracked.txt']);
  git(workingDir, ['commit', '-qm', 'base']);
  const baseHead = git(workingDir, ['rev-parse', 'HEAD']).trim();
  fs.appendFileSync(path.join(workingDir, 'tracked.txt'), 'staged\n');
  git(workingDir, ['add', 'tracked.txt']);
  fs.appendFileSync(path.join(workingDir, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(workingDir, 'new.txt'), 'untracked\n');
  const stagedPatch = git(workingDir, ['diff', '--cached', '--binary', baseHead, '--'], 'buffer');
  const recoveryRef = stashUnattributableRemainder(workingDir, sessionDir, () => undefined);
  assert.ok(recoveryRef);
  const checkpoint = persistRejectedCandidateCheckpoint({
    sessionDir, workingDir, ticketId: 'r1', baseHead, recoveryRef,
    stagedPaths: ['tracked.txt'], stagedPatch,
  });
  git(workingDir, ['restore', '--source', baseHead, '--staged', '--worktree', '--', 'tracked.txt']);
  fs.rmSync(path.join(workingDir, 'new.txt'));
  assert.equal(git(workingDir, ['status', '--porcelain']).trim(), '');
  return { workingDir, sessionDir, baseHead, checkpoint };
}

test('candidate restore reconstructs the exact staged, unstaged, and untracked boundary', () => {
  const value = fixture();
  const restored = restoreRejectedCandidateCheckpoint({
    sessionDir: value.sessionDir,
    workingDir: value.workingDir,
    ticketId: 'r1',
    expectedBaseHead: value.baseHead,
    validateScope: (paths) => assert.deepEqual(paths, ['new.txt', 'tracked.txt']),
  });

  assert.ok(restored);
  assert.equal(fs.readFileSync(path.join(value.workingDir, 'tracked.txt'), 'utf8'), 'base\nstaged\nunstaged\n');
  assert.equal(fs.readFileSync(path.join(value.workingDir, 'new.txt'), 'utf8'), 'untracked\n');
  assert.equal(git(value.workingDir, ['diff', '--cached', '--name-only']).trim(), 'tracked.txt');
  assert.equal(git(value.workingDir, ['diff', '--name-only']).trim(), 'tracked.txt');
  assert.equal(git(value.workingDir, ['status', '--porcelain']).trim(), 'MM tracked.txt\n?? new.txt');
});

test('candidate restore rejects corrupt staged evidence before mutating the repository', () => {
  const value = fixture();
  const checkpointPath = path.join(value.sessionDir, 'rejected-candidates', 'r1.json');
  writeJson(checkpointPath, { ...value.checkpoint, staged_patch_sha256: '0'.repeat(64) });

  assert.throws(() => restoreRejectedCandidateCheckpoint({
    sessionDir: value.sessionDir,
    workingDir: value.workingDir,
    ticketId: 'r1',
    expectedBaseHead: value.baseHead,
    validateScope: () => undefined,
  }), /staged patch hash does not match/);
  assert.equal(git(value.workingDir, ['status', '--porcelain']).trim(), '');
  assert.equal(fs.readFileSync(path.join(value.workingDir, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(value.workingDir, 'new.txt')), false);
});

test('candidate restore rolls back when staged patch paths disagree with checkpoint metadata', () => {
  const value = fixture();
  const checkpointPath = path.join(value.sessionDir, 'rejected-candidates', 'r1.json');
  writeJson(checkpointPath, { ...value.checkpoint, staged_paths: ['new.txt'] });

  assert.throws(() => restoreRejectedCandidateCheckpoint({
    sessionDir: value.sessionDir,
    workingDir: value.workingDir,
    ticketId: 'r1',
    expectedBaseHead: value.baseHead,
    validateScope: () => undefined,
  }), /staged patch paths do not match/);
  assert.equal(git(value.workingDir, ['status', '--porcelain']).trim(), '');
  assert.equal(fs.readFileSync(path.join(value.workingDir, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(value.workingDir, 'new.txt')), false);
});

test('legacy path-only checkpoints retain their whole-path staging fallback', () => {
  const value = fixture();
  const checkpointPath = path.join(value.sessionDir, 'rejected-candidates', 'r1.json');
  const legacy = { ...value.checkpoint };
  delete legacy.staged_patch_base64;
  delete legacy.staged_patch_sha256;
  writeJson(checkpointPath, legacy);

  assert.ok(restoreRejectedCandidateCheckpoint({
    sessionDir: value.sessionDir,
    workingDir: value.workingDir,
    ticketId: 'r1',
    expectedBaseHead: value.baseHead,
    validateScope: () => undefined,
  }));
  assert.equal(git(value.workingDir, ['diff', '--cached', '--name-only']).trim(), 'tracked.txt');
  assert.equal(git(value.workingDir, ['diff', '--name-only']).trim(), '');
});
