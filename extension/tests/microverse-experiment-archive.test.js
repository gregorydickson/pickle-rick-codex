// @tier: fast
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { archiveMicroverseExperiment } from '../services/microverse-experiment-archive.js';
import { makeTempRoot } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fixture() {
  const workingDir = makeTempRoot('pickle-microverse-archive-repo-');
  const sessionDir = makeTempRoot('pickle-microverse-archive-session-');
  git(workingDir, ['init', '-b', 'main']);
  git(workingDir, ['config', 'user.email', 'test@example.invalid']);
  git(workingDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(workingDir, 'tracked.bin'), Buffer.from([0, 1, 2, 3]));
  git(workingDir, ['add', 'tracked.bin']);
  git(workingDir, ['commit', '-m', 'baseline']);
  return { workingDir, sessionDir, baseRef: git(workingDir, ['rev-parse', 'HEAD']) };
}

test('experiment archive preserves binary tracked changes and full untracked contents', () => {
  const { workingDir, sessionDir, baseRef } = fixture();
  fs.writeFileSync(path.join(workingDir, 'tracked.bin'), Buffer.from([255, 0, 254, 1]));
  const untrackedBinary = Buffer.from([0, 255, 10, 13, 128]);
  fs.mkdirSync(path.join(workingDir, 'nested'));
  fs.writeFileSync(path.join(workingDir, 'nested', 'new.bin'), untrackedBinary);
  fs.symlinkSync('../tracked.bin', path.join(workingDir, 'nested', 'link'));

  const result = archiveMicroverseExperiment({
    workingDir,
    sessionDir,
    experimentId: 'exp-0001',
    baseRef,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(result.artifact, 'experiments/exp-0001.archive.json');
  assert.equal(result.untrackedCount, 2);
  assert.deepEqual(result.changedPaths, ['nested/link', 'nested/new.bin', 'tracked.bin']);

  const artifactBytes = fs.readFileSync(path.join(sessionDir, result.artifact));
  assert.equal(result.sha256, sha256(artifactBytes));
  const archive = JSON.parse(artifactBytes.toString('utf8'));
  assert.equal(archive.schema_version, 1);
  const trackedPatch = Buffer.from(archive.tracked_patch.data, 'base64');
  assert.equal(archive.tracked_patch.sha256, sha256(trackedPatch));
  assert.match(trackedPatch.toString('utf8'), /GIT binary patch/);
  const binary = archive.untracked.find((entry) => entry.path === 'nested/new.bin');
  assert.deepEqual(Buffer.from(binary.data, 'base64'), untrackedBinary);
  assert.equal(binary.sha256, sha256(untrackedBinary));
  const symlink = archive.untracked.find((entry) => entry.path === 'nested/link');
  assert.equal(symlink.type, 'symlink');
  assert.equal(Buffer.from(symlink.data, 'base64').toString('utf8'), '../tracked.bin');
  assert.deepEqual(fs.readdirSync(path.join(sessionDir, 'experiments')).filter((name) => name.includes('.tmp.')), []);
});

test('experiment archive excludes pre-existing untracked paths from attribution', () => {
  const { workingDir, sessionDir, baseRef } = fixture();
  fs.writeFileSync(path.join(workingDir, 'pre-existing.txt'), 'user data');
  fs.writeFileSync(path.join(workingDir, 'experiment.txt'), 'experiment data');
  const result = archiveMicroverseExperiment({
    workingDir,
    sessionDir,
    experimentId: 'exp-0002',
    baseRef,
    excludeUntrackedPaths: ['pre-existing.txt'],
  });
  const archive = JSON.parse(fs.readFileSync(path.join(sessionDir, result.artifact), 'utf8'));
  assert.deepEqual(archive.untracked.map((entry) => entry.path), ['experiment.txt']);
  assert.deepEqual(result.changedPaths, ['experiment.txt']);
});

test('experiment archive fails closed on unsafe destinations and byte limits', () => {
  const limited = fixture();
  fs.writeFileSync(path.join(limited.workingDir, 'large.bin'), Buffer.alloc(64, 1));
  assert.throws(() => archiveMicroverseExperiment({
    ...limited,
    experimentId: 'exp-0003',
    maxArchiveBytes: 16,
  }), /exceeds 16 bytes/);
  assert.equal(fs.existsSync(path.join(limited.sessionDir, 'experiments', 'exp-0003.archive.json')), false);

  const escaped = fixture();
  const outside = makeTempRoot('pickle-microverse-archive-outside-');
  fs.symlinkSync(outside, path.join(escaped.sessionDir, 'experiments'));
  assert.throws(() => archiveMicroverseExperiment({
    ...escaped,
    experimentId: 'exp-0004',
  }), /outside the session directory/);
  assert.equal(fs.existsSync(path.join(outside, 'exp-0004.archive.json')), false);
});
