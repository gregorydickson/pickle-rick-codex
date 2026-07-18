// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
import { createFakeCodex, makeTempRoot, prependPath, repoRoot, runNode, writeJson } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cleanRepo(prefix) {
  const cwd = makeTempRoot(prefix);
  git(cwd, ['init']);
  git(cwd, ['config', 'user.name', 'Destructive Safety Tests']);
  git(cwd, ['config', 'user.email', 'safety@example.test']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'baseline\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'baseline']);
  return cwd;
}

function setupSession(projectDir, env, task) {
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', task], { env, cwd: projectDir }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  const state = readJsonFile(statePath);
  state.active = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return sessionDir;
}

test('worker archive-cap abort preserves attempted tree and records a blocked recovery failure', () => {
  const projectDir = cleanRepo('pickle-worker-archive-cap-');
  const baseline = git(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-worker-archive-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: makeTempRoot(),
    PICKLE_DESTRUCTIVE_ARCHIVE_MAX_BYTES: '1',
    FAKE_CODEX_MUTATE_FILE: 'tracked.txt',
    FAKE_CODEX_APPEND_TEXT: 'attempted worker mutation\n',
  });
  const sessionDir = setupSession(projectDir, env, 'worker archive cap');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'R1',
      title: 'Archive cap worker',
      description: 'Verification fails after implementation mutates the owned file.',
      acceptance_criteria: ['Rejected work remains untouched when archival cannot proceed.'],
      verification: ['node -e "process.exit(7)"'],
      allowed_paths: ['tracked.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir }),
    /destructive-archive-cap-exceeded/,
  );
  assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  assert.match(fs.readFileSync(path.join(projectDir, 'tracked.txt'), 'utf8'), /attempted worker mutation/);
  assert.equal(git(projectDir, ['status', '--porcelain']), 'M tracked.txt');
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Blocked');
  assert.match(String(ticket.frontmatter.failure_reason), /destructive-archive-cap-exceeded/);
});

test('Citadel archive-cap abort preserves reviewer mutation and cannot approve', () => {
  const projectDir = cleanRepo('pickle-citadel-archive-cap-');
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    scripts: {
      test: `node -e ${JSON.stringify("require('node:fs').writeFileSync('tracked.txt', 'attempted Citadel mutation\\n')")}`,
    },
  }));
  git(projectDir, ['add', 'package.json']);
  git(projectDir, ['commit', '-m', 'test contract']);
  const baseline = git(projectDir, ['rev-parse', 'HEAD']);
  const env = {
    PICKLE_DATA_ROOT: makeTempRoot(),
    PICKLE_DESTRUCTIVE_ARCHIVE_MAX_BYTES: '1',
  };
  const sessionDir = setupSession(projectDir, env, 'Citadel archive cap');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{ acceptance_criteria: ['Citadel cannot erase unarchived mutation evidence.'] }],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/citadel.js'), sessionDir], { env, cwd: projectDir }),
    /destructive-archive-cap-exceeded/,
  );
  assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  assert.equal(fs.readFileSync(path.join(projectDir, 'tracked.txt'), 'utf8'), 'attempted Citadel mutation\n');
  assert.equal(git(projectDir, ['status', '--porcelain']), 'M tracked.txt');
  const reportPath = path.join(sessionDir, 'citadel-report.json');
  assert.ok(!fs.existsSync(reportPath) || readJsonFile(reportPath).verdict !== 'approve');
});

test('Microverse archive-cap abort preserves attempted iteration and exits non-success with recovery evidence', () => {
  const projectDir = cleanRepo('pickle-microverse-archive-cap-');
  const baseline = git(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-microverse-archive-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: makeTempRoot(),
    PICKLE_DESTRUCTIVE_ARCHIVE_MAX_BYTES: '1',
    FAKE_LOOP_COMPLETE_AFTER: '1',
    FAKE_LOOP_MUTATE_FILE: 'tracked.txt',
    FAKE_LOOP_APPEND_TEXT: 'attempted Microverse mutation\n',
  });
  const sessionDir = setupSession(projectDir, env, 'Microverse archive cap');
  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'microverse',
    task: 'hold a constant metric',
    metric: 'printf 1',
    direction: 'higher',
    stall_limit: 2,
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir }),
    /destructive-archive-cap-exceeded/,
  );
  assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  assert.match(fs.readFileSync(path.join(projectDir, 'tracked.txt'), 'utf8'), /attempted Microverse mutation/);
  assert.equal(git(projectDir, ['status', '--porcelain']), 'M tracked.txt');
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const log = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  assert.equal(state.last_exit_reason, 'error');
  assert.match(log, /destructive-archive-cap-exceeded/);
  assert.doesNotMatch(log, /finished: success/);
});
