// @tier: fast
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkReadiness } from '../services/readiness.js';
import { makeTempRoot, projectRoot, writeJson } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createReadyFixture() {
  const dataRoot = makeTempRoot('pickle-readiness-data-');
  const workingDir = makeTempRoot('pickle-readiness-project-');
  const sessionDir = path.join(dataRoot, 'sessions', 'ready-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  git(workingDir, ['init']);
  git(workingDir, ['config', 'user.name', 'Readiness Test']);
  git(workingDir, ['config', 'user.email', 'readiness@example.com']);
  fs.writeFileSync(path.join(workingDir, 'baseline.txt'), 'baseline\n');
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  git(workingDir, ['add', 'baseline.txt', 'package.json']);
  git(workingDir, ['commit', '-m', 'baseline']);
  const head = git(workingDir, ['rev-parse', 'HEAD']);
  writeJson(path.join(dataRoot, 'config.json'), { runtime: { command: process.execPath } });
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    active: false,
    working_dir: workingDir,
    step: 'refine',
    tmux_mode: false,
    recovery_required: false,
    quality_baseline: {
      head_sha: head,
      captured_at: '2026-01-01T00:00:00.000Z',
      commands: [{
        command: 'npm run test',
        ok: true,
        exitCode: 0,
        signature: 'fixture-success',
        output: '',
      }],
      command_contract: { 'npm run test': 'node -e "process.exit(0)"' },
    },
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    source: 'codex-refinement',
    tickets: [{
      id: 'r1',
      title: 'Preserve baseline',
      description: 'Keep the prepared baseline file covered by verification.',
      acceptance_criteria: ['baseline.txt remains covered by an executable verification command.'],
      verification: ['node -e "process.exit(0)"'],
      allowed_paths: ['baseline.txt'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  fs.mkdirSync(path.join(sessionDir, 'r1'));
  fs.writeFileSync(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'), [
    '---',
    'id: r1',
    'title: Preserve baseline',
    'status: Todo',
    '---',
    '',
  ].join('\n'));
  return { dataRoot, sessionDir, workingDir };
}

test('checkReadiness approves a prepared session and bounds readiness cycle history', () => {
  const fixture = createReadyFixture();
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = fixture.dataRoot;
  const stateBefore = fs.readFileSync(path.join(fixture.sessionDir, 'state.json'), 'utf8');
  const manifestBefore = fs.readFileSync(path.join(fixture.sessionDir, 'refinement_manifest.json'), 'utf8');
  try {
    for (let index = 0; index < 3; index += 1) {
      const report = checkReadiness(fixture.sessionDir, {
        runtimeRoot: projectRoot,
        historyLimit: 2,
        now: () => `2026-01-01T00:00:0${index}.000Z`,
      });
      assert.equal(report.ready, true, JSON.stringify(report.findings));
    }
    const history = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, 'readiness-history.json'), 'utf8'));
    assert.equal(history.cycles.length, 2);
    assert.equal(history.cycles[0].checked_at, '2026-01-01T00:00:01.000Z');
    assert.equal(fs.readFileSync(path.join(fixture.sessionDir, 'state.json'), 'utf8'), stateBefore);
    assert.equal(fs.readFileSync(path.join(fixture.sessionDir, 'refinement_manifest.json'), 'utf8'), manifestBefore);
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('checkReadiness blocks dirty, recovering, open-circuit sessions with stale evidence', () => {
  const fixture = createReadyFixture();
  fs.writeFileSync(path.join(fixture.workingDir, 'dirty.txt'), 'dirty\n');
  const statePath = path.join(fixture.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.recovery_required = true;
  state.recovery_reason = 'orphan ownership ambiguous';
  state.quality_baseline.head_sha = 'deadbeef';
  writeJson(statePath, state);
  writeJson(path.join(fixture.sessionDir, 'circuit_breaker.json'), { state: 'OPEN', reason: 'no progress' });
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = fixture.dataRoot;
  try {
    const report = checkReadiness(fixture.sessionDir, { runtimeRoot: projectRoot });
    assert.equal(report.ready, false);
    const codes = new Set(report.findings.filter((entry) => entry.severity === 'error').map((entry) => entry.code));
    assert.ok(codes.has('git-tree-dirty'));
    assert.ok(codes.has('quality-baseline-not-ready'));
    assert.ok(codes.has('circuit-open'));
    assert.ok(codes.has('recovery-required'));
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('checkReadiness rejects a fresh-looking quality baseline with no commands', () => {
  const fixture = createReadyFixture();
  const statePath = path.join(fixture.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.quality_baseline.commands = [];
  state.quality_baseline.command_contract = {};
  writeJson(statePath, state);
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = fixture.dataRoot;
  try {
    const report = checkReadiness(fixture.sessionDir, { runtimeRoot: projectRoot });
    assert.equal(report.ready, false);
    assert.ok(report.findings.some((entry) => entry.code === 'quality-baseline-not-ready'));
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});

test('checkReadiness rejects malformed or contract-mismatched quality results', () => {
  const fixture = createReadyFixture();
  const statePath = path.join(fixture.sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.quality_baseline.commands = [{}];
  state.quality_baseline.command_contract = {};
  writeJson(statePath, state);
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = fixture.dataRoot;
  try {
    const malformed = checkReadiness(fixture.sessionDir, { runtimeRoot: projectRoot });
    assert.equal(malformed.ready, false);
    state.quality_baseline.commands = [{
      command: 'npm run test', ok: true, exitCode: 0, signature: 'ok', output: '',
    }];
    state.quality_baseline.command_contract = { 'npm run lint': 'node -e "process.exit(0)"' };
    writeJson(statePath, state);
    const mismatched = checkReadiness(fixture.sessionDir, { runtimeRoot: projectRoot });
    assert.equal(mismatched.ready, false);
  } finally {
    if (previousRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousRoot;
  }
});
