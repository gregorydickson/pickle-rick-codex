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
  persistCitadelReleaseApproval,
  validateCitadelReport,
} from '../services/citadel.js';
import { writePrdSeal } from '../services/prd-seal.js';
import { StateManager } from '../services/state-manager.js';
import { makeTempRoot, writeExecutable } from './helpers.js';

function initCitadelRepo() {
  const cwd = makeTempRoot('pickle-citadel-lifecycle-repo-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'release checkpoint'], { cwd });
  return cwd;
}

function makeCitadelLifecycleSession(criterion) {
  const cwd = initCitadelRepo();
  const sessionDir = makeTempRoot('pickle-citadel-lifecycle-session-');
  const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    working_dir: cwd,
    start_commit: startCommit,
    worker_timeout_seconds: 10,
  }));
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{ acceptance_criteria: [criterion] }],
  }));
  return { cwd, sessionDir };
}

function sealCitadelSession(sessionDir, cwd, id, text) {
  const prd = '# Approved release PRD\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  writePrdSeal(sessionDir, {
    prd,
    repository: { identity: 'fixture@HEAD', working_directory: cwd, execution_base_policy: 'sealed release' },
    acceptance_criteria: [{ id, text }],
    scope_and_ownership: {},
    dependencies_and_external_prerequisites: [],
    risk: [],
    decision_precedence: [],
    preservation_and_rollback: {},
    completion_definition: {},
    release_gates: [],
  });
}

test('validateCitadelReport derives a fail-closed verdict from severity', () => {
  const report = validateCitadelReport({
    reviewed_range: 'abc..HEAD',
    findings: [{ severity: 'high', title: 'Broken contract', evidence: 'src/a.ts:4 contradicts src/b.ts:9' }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']);
  assert.equal(report.verdict, 'block');
  assert.equal(report.findings[0].severity, 'high');
  assert.throws(() => validateCitadelReport({ reviewed_range: 'abc..HEAD', findings: [{ severity: 'urgent' }] }, 'abc..HEAD', ['AC-1']), /unsupported severity/);
});

test('validateCitadelReport rejects empty and incomplete acceptance-criteria evidence', () => {
  assert.throws(
    () => validateCitadelReport({ reviewed_range: 'abc..HEAD', findings: [], acceptance_criteria_checked: [] }, 'abc..HEAD', []),
    /declares no acceptance criteria/,
  );
  assert.throws(
    () => validateCitadelReport({ reviewed_range: 'abc..HEAD', findings: [], acceptance_criteria_checked: ['AC-1'] }, 'abc..HEAD', ['AC-1', 'AC-2']),
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
      () => validateCitadelReport({ reviewed_range: 'abc..HEAD', findings: [finding], acceptance_criteria_checked: ['AC-1'] }, 'abc..HEAD', ['AC-1']),
      /expected an object|unsupported severity|title and evidence are required/,
    );
  }

  const generatedAt = '2026-07-18T00:00:00.000Z';
  const report = validateCitadelReport({
    reviewed_range: 'abc..HEAD',
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
    reviewed_range: 'abc..HEAD',
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

test('sealed acceptance IDs and exact text override weaker manifest paraphrases and fail closed on drift', () => {
  const sealed = makeCitadelLifecycleSession('Security is handled.');
  sealCitadelSession(
    sealed.sessionDir,
    sealed.cwd,
    'AC-SECURE-07',
    'Every privileged operation rejects an expired immutable owner identity.',
  );
  const exact = 'AC-SECURE-07: Every privileged operation rejects an expired immutable owner identity.';
  const reviewedRange = `${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sealed.cwd, encoding: 'utf8' }).trim()}..HEAD`;
  assert.deepEqual(deriveCitadelAcceptanceCriteria(sealed.sessionDir), [exact]);
  assert.throws(() => validateCitadelReport({
    reviewed_range: reviewedRange,
    findings: [],
    acceptance_criteria_checked: ['Security is handled.'],
  }, reviewedRange,
  deriveCitadelAcceptanceCriteria(sealed.sessionDir)), /coverage is incomplete.*AC-SECURE-07/);
  assert.throws(() => persistCitadelReleaseApproval(sealed.sessionDir, {
    schema_version: 1,
    verdict: 'approve',
    reviewed_range: reviewedRange,
    acceptance_criteria_checked: ['Security is handled.'],
    findings: [],
    generated_at: new Date().toISOString(),
  }), /coverage is incomplete.*AC-SECURE-07/);

  const tampered = makeCitadelLifecycleSession('Legacy fallback.');
  sealCitadelSession(tampered.sessionDir, tampered.cwd, 'AC-SECURE-07', 'Exact sealed text.');
  const sealPath = path.join(tampered.sessionDir, 'prd.lock.json');
  const rawSeal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  rawSeal.acceptance_criteria[0].text = 'Weaker replacement.';
  fs.writeFileSync(sealPath, JSON.stringify(rawSeal));
  assert.throws(() => deriveCitadelAcceptanceCriteria(tampered.sessionDir), /semantic hash/);

  const driftedPrd = makeCitadelLifecycleSession('Legacy fallback.');
  sealCitadelSession(driftedPrd.sessionDir, driftedPrd.cwd, 'AC-SECURE-07', 'Exact sealed text.');
  fs.appendFileSync(path.join(driftedPrd.sessionDir, 'prd.md'), '\nUnapproved semantic drift.\n');
  assert.throws(() => deriveCitadelAcceptanceCriteria(driftedPrd.sessionDir), /does not match the approved seal/);
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

test('runCitadelChecks discovers extension-scoped release scripts', () => {
  const cwd = makeTempRoot('pickle-citadel-extension-scripts-');
  fs.mkdirSync(path.join(cwd, 'extension'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(cwd, 'extension', 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
    },
  }));

  const checks = runCitadelChecks(cwd, 10_000);

  assert.deepEqual(checks.map(({ status }) => status), ['passed', 'passed', 'passed']);
  assert.deepEqual(checks.map(({ command }) => command), [
    'npm --prefix extension run typecheck',
    'npm --prefix extension run lint',
    'npm run test',
  ]);
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

test('Citadel cooperatively terminates a long deterministic check after lease loss', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('The handoff drains Citadel.');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "setTimeout(() => {}, 10000)"' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'long check fixture'], { cwd });
  const statePath = path.join(sessionDir, 'state.json');
  new StateManager().update(statePath, (state) => {
    state.start_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    return state;
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => runCitadel(sessionDir, {
      assertDurableOwnership: () => {
        if (Date.now() - startedAt > 1_500) throw new Error('fixture lease ownership changed');
      },
    }),
    /fixture lease ownership changed/,
  );
  assert.ok(Date.now() - startedAt < 4_000, 'Citadel did not drain its child promptly');
  const state = new StateManager().read(statePath);
  assert.ok(Number.isInteger(state.active_child_pid), 'stale owner must preserve the child recovery identity for green');
  assert.ok(state.active_child_identity);
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

test('runCitadel monitors checks and enforces reviewer evidence and approval signals', async () => {
  const fakeBin = makeTempRoot('pickle-citadel-lifecycle-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const reportPath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const mode = criteria[0] || '';
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
fs.writeFileSync(reportPath, JSON.stringify({
  schema_version: 1,
  verdict: 'approve',
  reviewed_range: reviewedRange,
  acceptance_criteria_checked: mode.includes('invalid evidence') ? [] : criteria,
  findings: [],
  generated_at: '2026-07-18T00:00:00.000Z'
}));
const message = mode.includes('missing promise') ? 'review complete' : '<promise>THE_CITADEL_APPROVES</promise>';
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], message);
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 1 } }));
`);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  try {
    const sealed = makeCitadelLifecycleSession('Weaker manifest paraphrase.');
    sealCitadelSession(
      sealed.sessionDir,
      sealed.cwd,
      'AC-SECURE-07',
      'Every privileged operation rejects an expired immutable owner identity.',
    );
    assert.equal(await runCitadel(sealed.sessionDir), 'success');
    const sealedReport = JSON.parse(fs.readFileSync(path.join(sealed.sessionDir, 'citadel-report.json'), 'utf8'));
    assert.deepEqual(sealedReport.acceptance_criteria_checked, [
      'AC-SECURE-07: Every privileged operation rejects an expired immutable owner identity.',
    ]);

    const approved = makeCitadelLifecycleSession('approved release evidence');
    assert.equal(await runCitadel(approved.sessionDir), 'success');
    const approvedReport = JSON.parse(fs.readFileSync(path.join(approved.sessionDir, 'citadel-report.json'), 'utf8'));
    const checks = JSON.parse(fs.readFileSync(path.join(approved.sessionDir, 'citadel-checks.json'), 'utf8')).checks;
    const approvedState = JSON.parse(fs.readFileSync(path.join(approved.sessionDir, 'state.json'), 'utf8'));
    assert.equal(approvedReport.verdict, 'approve');
    assert.deepEqual(checks.map(({ status }) => status), ['skipped', 'skipped', 'passed', 'passed']);
    assert.equal(checks[3].command, 'git diff --check');
    assert.equal(approvedState.active_child_pid, null);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: approved.cwd, encoding: 'utf8' }), '');

    const invalid = makeCitadelLifecycleSession('invalid evidence');
    assert.equal(await runCitadel(invalid.sessionDir), 'citadel-blocked');
    const invalidReport = JSON.parse(fs.readFileSync(path.join(invalid.sessionDir, 'citadel-report.json'), 'utf8'));
    assert.match(invalidReport.findings[0].title, /report evidence is invalid/i);
    assert.match(invalidReport.findings[0].evidence, /coverage is incomplete/i);

    const missingPromise = makeCitadelLifecycleSession('missing promise');
    assert.equal(await runCitadel(missingPromise.sessionDir), 'citadel-blocked');
    const missingPromiseReport = JSON.parse(fs.readFileSync(path.join(missingPromise.sessionDir, 'citadel-report.json'), 'utf8'));
    assert.match(missingPromiseReport.findings[0].title, /approval signal missing/i);
  } finally {
    process.env.PATH = originalPath;
  }
});
