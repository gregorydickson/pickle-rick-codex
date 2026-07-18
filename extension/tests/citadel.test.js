// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  deriveCitadelAcceptanceCriteria,
  getCitadelRepositoryFingerprint,
  runCitadel,
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

test('validateCitadelReport rejects malformed findings and normalizes optional evidence', () => {
  for (const value of [null, [], {}, { findings: null }]) {
    assert.throws(
      () => validateCitadelReport(value, 'abc..HEAD', ['AC-1']),
      /expected an object|findings must be an array/,
    );
  }
  for (const finding of [null, [], {}, { severity: 'low', title: ' ', evidence: 'proof' }]) {
    assert.throws(
      () => validateCitadelReport({ findings: [finding], acceptance_criteria_checked: ['AC-1'] }, 'abc..HEAD', ['AC-1']),
      /expected an object|unsupported severity|title and evidence are required/,
    );
  }

  const generatedAt = '2026-07-18T00:00:00.000Z';
  const report = validateCitadelReport({
    findings: [{
      severity: 'INFO',
      title: '  Checked contract  ',
      evidence: '  src/a.js:4 is covered  ',
      file: '  src/a.js  ',
      line: 4,
      recommendation: '  Keep the assertion  ',
    }],
    acceptance_criteria_checked: [null, '  AC-1  ', ''],
    generated_at: generatedAt,
  }, 'abc..HEAD', [' AC-1 ']);
  assert.equal(report.verdict, 'approve');
  assert.deepEqual(report.findings[0], {
    severity: 'info',
    title: 'Checked contract',
    evidence: 'src/a.js:4 is covered',
    file: 'src/a.js',
    line: 4,
    recommendation: 'Keep the assertion',
  });
  assert.deepEqual(report.acceptance_criteria_checked, ['AC-1']);
  assert.equal(report.generated_at, generatedAt);

  const defaults = validateCitadelReport({
    findings: [{ severity: 'low', title: 'Advisory', evidence: 'Observed', file: '', line: 0, recommendation: '' }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']);
  assert.deepEqual(
    { file: defaults.findings[0].file, line: defaults.findings[0].line, recommendation: defaults.findings[0].recommendation },
    { file: null, line: null, recommendation: null },
  );
  assert.equal(Number.isNaN(Date.parse(defaults.generated_at)), false);
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

test('deriveCitadelAcceptanceCriteria ignores malformed tickets and respects PRD section boundaries', () => {
  const sessionDir = makeTempRoot('pickle-citadel-ac-fallback-');
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [null, [], 'ticket', {}, { acceptance_criteria: [null, '  ', 7] }],
  }));
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined PRD\n\nNo criteria here.\n');
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), [
    '# PRD',
    '',
    '## Success Criteria',
    '',
    '- [x] First   criterion',
    '2) Second criterion',
    '* First criterion',
    '',
    '## Out of scope',
    '',
    '- Must not be included',
  ].join('\n'));

  assert.deepEqual(deriveCitadelAcceptanceCriteria(sessionDir), ['First criterion', 'Second criterion']);
  assert.deepEqual(deriveCitadelAcceptanceCriteria(makeTempRoot('pickle-citadel-ac-empty-')), []);
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

test('runCitadelChecks deduplicates and records declared ticket verification commands', () => {
  const cwd = makeTempRoot('pickle-citadel-ticket-checks-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: [] }));
  const passCommand = `${JSON.stringify(process.execPath)} -e "process.stdout.write('ticket passed')"`;
  const failCommand = `${JSON.stringify(process.execPath)} -e "process.stderr.write('ticket failed'); process.exit(4)"`;
  const checks = runCitadelChecks(cwd, 10_000, [passCommand, `  ${passCommand}  `, '', failCommand]);

  assert.deepEqual(checks.slice(0, 3).map(({ status }) => status), ['skipped', 'skipped', 'skipped']);
  assert.equal(checks.length, 5);
  assert.deepEqual(
    checks.slice(3).map(({ command, status, exit_code }) => ({ command, status, exit_code })),
    [
      { command: passCommand, status: 'passed', exit_code: 0 },
      { command: failCommand, status: 'failed', exit_code: 4 },
    ],
  );
  assert.match(checks[3].output, /ticket passed/);
  assert.match(checks[4].output, /ticket failed/);
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

test('runCitadel fails closed before monitored checks when release evidence is unavailable', async () => {
  const missingWorkingDir = makeTempRoot('pickle-citadel-no-working-dir-');
  fs.writeFileSync(path.join(missingWorkingDir, 'state.json'), JSON.stringify({ schema_version: 1 }));
  await assert.rejects(() => runCitadel(missingWorkingDir), /persisted working_dir/);

  const cwd = makeTempRoot('pickle-citadel-preflight-repo-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'release\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'release'], { cwd });
  const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

  const noCriteria = makeTempRoot('pickle-citadel-no-criteria-');
  fs.writeFileSync(path.join(noCriteria, 'state.json'), JSON.stringify({
    schema_version: 1,
    working_dir: cwd,
    start_commit: startCommit,
  }));
  assert.equal(await runCitadel(noCriteria), 'citadel-blocked');
  const noCriteriaReport = JSON.parse(fs.readFileSync(path.join(noCriteria, 'citadel-report.json'), 'utf8'));
  assert.equal(noCriteriaReport.verdict, 'block');
  assert.match(noCriteriaReport.findings[0].title, /no acceptance criteria/i);

  const malformedScope = makeTempRoot('pickle-citadel-malformed-scope-');
  fs.writeFileSync(path.join(malformedScope, 'state.json'), JSON.stringify({
    schema_version: 1,
    working_dir: cwd,
    start_commit: startCommit,
  }));
  fs.writeFileSync(path.join(malformedScope, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{ id: 'T-1', acceptance_criteria: ['Release evidence is complete.'] }],
  }));
  fs.writeFileSync(path.join(malformedScope, 'scope.json'), '{}');
  assert.equal(await runCitadel(malformedScope), 'citadel-blocked');
  const scopeReport = JSON.parse(fs.readFileSync(path.join(malformedScope, 'citadel-report.json'), 'utf8'));
  assert.equal(scopeReport.verdict, 'block');
  assert.match(scopeReport.findings[0].title, /scope contract is invalid/i);
  assert.match(scopeReport.findings[0].evidence, /scope\.json identity is malformed/);
});
