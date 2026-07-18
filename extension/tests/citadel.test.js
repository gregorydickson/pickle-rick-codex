// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  deriveCitadelAcceptanceCriteria,
  getCitadelRepositoryFingerprint,
  runCitadelChecks,
  recoverCitadelStartCommit,
  validateCitadelReport,
} from '../services/citadel.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot } from './helpers.js';

test('validateCitadelReport derives a fail-closed verdict from severity', () => {
  const report = validateCitadelReport({
    findings: [{ severity: 'high', title: 'Broken contract', evidence: 'src/a.ts:4 contradicts src/b.ts:9' }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']);
  assert.equal(report.verdict, 'block');
  assert.equal(report.findings[0].severity, 'high');
  assert.throws(() => validateCitadelReport({ findings: [{ severity: 'urgent' }] }, 'abc..HEAD', ['AC-1']), /unsupported severity/);
});

test('validateCitadelReport rejects empty and incomplete acceptance-criteria evidence', () => {
  assert.throws(
    () => validateCitadelReport({ findings: [], acceptance_criteria_checked: [] }, 'abc..HEAD', []),
    /declares no acceptance criteria/,
  );
  assert.throws(
    () => validateCitadelReport({ findings: [], acceptance_criteria_checked: ['AC-1'] }, 'abc..HEAD', ['AC-1', 'AC-2']),
    /coverage is incomplete.*AC-2/,
  );
});

test('deriveCitadelAcceptanceCriteria prefers refined ticket criteria and falls back to the PRD', () => {
  const sessionDir = makeTempRoot('pickle-citadel-ac-');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Acceptance Criteria\n\n- PRD criterion\n');
  assert.deepEqual(deriveCitadelAcceptanceCriteria(sessionDir), ['PRD criterion']);
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [
      { acceptance_criteria: ['Ticket criterion one', 'Ticket criterion two'] },
      { acceptance_criteria: ['Ticket criterion two'] },
    ],
  }));
  assert.deepEqual(deriveCitadelAcceptanceCriteria(sessionDir), ['Ticket criterion one', 'Ticket criterion two']);
});

test('runCitadelChecks executes defined release scripts and skips absent ones', () => {
  const cwd = makeTempRoot('pickle-citadel-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(3)"',
    },
  }));
  const checks = runCitadelChecks(cwd, 10_000);
  assert.deepEqual(checks.map(({ status }) => status), ['passed', 'skipped', 'failed']);
  assert.equal(checks[2].exit_code, 3);
});

test('Citadel repository fingerprint detects commits and staged index changes', () => {
  const cwd = makeTempRoot('pickle-citadel-fingerprint-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
  const initial = getCitadelRepositoryFingerprint(cwd);

  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  assert.notEqual(getCitadelRepositoryFingerprint(cwd), initial);
  execFileSync('git', ['commit', '-qm', 'second'], { cwd });
  assert.notEqual(getCitadelRepositoryFingerprint(cwd), initial);
});

test('Citadel atomically self-heals an absent start_commit from reachable session bases', () => {
  const cwd = makeTempRoot('pickle-citadel-self-heal-repo-');
  const sessionDir = makeTempRoot('pickle-citadel-self-heal-session-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
  const pinned = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    working_dir: cwd,
    start_commit: null,
    pinned_sha: pinned,
  }));

  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  assert.equal(recoverCitadelStartCommit(manager, statePath, state, cwd), pinned);
  assert.equal(manager.read(statePath).start_commit, pinned);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
});
