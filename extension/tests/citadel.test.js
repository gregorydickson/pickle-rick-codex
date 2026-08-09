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
  reconcileValidatedCitadelTelemetry,
  persistCitadelReleaseApproval,
  resolveCitadelCheckCwd,
  validateCitadelReport,
} from '../services/citadel.js';
import { reconcileInterruptedModelCallTelemetry } from '../services/productive-autonomy.js';
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

test('Citadel verification cwd cannot escape its isolated worktree', () => {
  const isolated = makeTempRoot('pickle-citadel-cwd-');
  fs.mkdirSync(path.join(isolated, 'extension'));
  assert.equal(resolveCitadelCheckCwd(isolated, 'extension'), fs.realpathSync(path.join(isolated, 'extension')));
  assert.throws(
    () => resolveCitadelCheckCwd(isolated, path.join(path.dirname(isolated), 'live-release-workspace')),
    /escapes the isolated release worktree/,
  );
  assert.throws(() => resolveCitadelCheckCwd(isolated, '../outside'), /escapes the isolated release worktree/);
});

test('Citadel provisions committed dependencies inside a clean self-contained review worktree', async () => {
  const cwd = makeTempRoot('pickle-citadel-dependency-repo-');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'pickle@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Pickle Test'], { cwd });
  fs.mkdirSync(path.join(cwd, 'vendor', 'citadel-local-dependency'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'vendor', 'citadel-local-dependency', 'package.json'), JSON.stringify({
    name: 'citadel-local-dependency', version: '1.0.0', main: 'index.js',
  }));
  fs.writeFileSync(path.join(cwd, 'vendor', 'citadel-local-dependency', 'index.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'citadel-dependency-fixture', version: '1.0.0',
    scripts: { test: 'node -e "require(\'citadel-local-dependency\')"' },
    dependencies: { 'citadel-local-dependency': 'file:vendor/citadel-local-dependency' },
  }));
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd, stdio: 'ignore', timeout: 30_000,
  });
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'external-source-marker'), 'must not be linked\n');
  execFileSync('git', ['add', '.gitignore', 'package.json', 'package-lock.json', 'vendor'], { cwd });
  execFileSync('git', ['commit', '-qm', 'release checkpoint'], { cwd });
  const sessionDir = makeTempRoot('pickle-citadel-dependency-session-');
  const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1, working_dir: cwd, start_commit: startCommit, worker_timeout_seconds: 10,
  }));
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{ acceptance_criteria: ['The isolated review dependency tree is clean and self-contained.'] }],
  }));

  const fakeBin = makeTempRoot('pickle-citadel-clean-reviewer-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const prompt = fs.readFileSync(0, 'utf8');
const status = cp.execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const dependency = path.join(process.cwd(), 'node_modules', 'citadel-local-dependency');
if (status !== '' || !fs.existsSync(dependency) || fs.lstatSync(path.join(process.cwd(), 'node_modules')).isSymbolicLink()
    || !fs.realpathSync(dependency).startsWith(process.cwd() + path.sep)
    || fs.existsSync(path.join(process.cwd(), 'node_modules', 'external-source-marker'))) process.exit(9);
const reportPath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
fs.writeFileSync(reportPath, JSON.stringify({ schema_version: 1, verdict: 'approve', reviewed_range: reviewedRange,
  acceptance_criteria_checked: criteria, findings: [], generated_at: new Date().toISOString() }));
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], '<promise>THE_CITADEL_APPROVES</promise>');
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  try {
    assert.equal(await runCitadel(sessionDir), 'success');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('Citadel rejects an absolute verification cwd before it can mutate the release tree', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('Checks stay isolated.');
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{
      acceptance_criteria: ['Checks stay isolated.'],
      verification: [{
        kind: 'process',
        executable: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('escaped.txt', 'must not run\\n')"],
        cwd,
      }],
    }],
  }));

  await assert.rejects(() => runCitadel(sessionDir), /escapes the isolated release worktree/);
  assert.equal(fs.existsSync(path.join(cwd, 'escaped.txt')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
});

test('Citadel rejects destructive structured verification before spawning it', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('Checks are read-only.');
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{
      acceptance_criteria: ['Checks are read-only.'],
      verification: [{ kind: 'process', executable: 'git', args: ['clean', '-fdx'] }],
    }],
  }));

  await assert.rejects(() => runCitadel(sessionDir), /git clean is not permitted in verification/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
});

test('Citadel rejects an always-pass manifest verifier that drifts from the sealed release gate', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('The sealed verifier remains mandatory.');
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{
      id: 'r1', acceptance_criteria: ['The sealed verifier remains mandatory.'],
      verification: [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }],
    }],
  }));
  const prd = '# Approved verifier PRD\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  writePrdSeal(sessionDir, {
    prd,
    repository: { identity: 'fixture@HEAD', working_directory: cwd, execution_base_policy: 'sealed release' },
    acceptance_criteria: [{ id: 'AC-VERIFY', text: 'The sealed verifier remains mandatory.' }],
    scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {},
    release_gates: {
      ticket_verification: [{
        ticket_id: 'r1', acceptance_criteria: ['The sealed verifier remains mandatory.'],
        verification: [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(6)'] }],
      }],
      final_gate: 'citadel',
    },
  });

  await assert.rejects(() => runCitadel(sessionDir), /sealed-verification-semantic-drift: r1/);
});

test('Citadel rejects representation drift without a valid seal-bound repair receipt', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('Verification representation is receipted.');
  const step = { kind: 'process', executable: 'node', args: ['--version'] };
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{ id: 'r1', acceptance_criteria: ['Verification representation is receipted.'], verification: [step] }],
  }));
  const prd = '# Approved receipt PRD\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  writePrdSeal(sessionDir, {
    prd,
    repository: { identity: 'fixture@HEAD', working_directory: cwd, execution_base_policy: 'sealed release' },
    acceptance_criteria: [{ id: 'AC-RECEIPT', text: 'Verification representation is receipted.' }],
    scope_and_ownership: {}, dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {},
    release_gates: {
      ticket_verification: [{
        ticket_id: 'r1', acceptance_criteria: ['Verification representation is receipted.'], verification: { steps: [step] },
      }],
      final_gate: 'citadel',
    },
  });

  await assert.rejects(() => runCitadel(sessionDir), /sealed-verification-receipt-missing-or-invalid: r1/);
});

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
      ticket_ids: ['  R1  '],
      acceptance_criteria: ['  AC-1  '],
      paths: ['  src/a.js  '],
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
    ticket_ids: ['R1'],
    acceptance_criteria: ['AC-1'],
    paths: ['src/a.js'],
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
const path = require('node:path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const reportPath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const mode = criteria[0] || '';
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
const countPath = path.join(path.dirname(path.dirname(reportPath)), '..', 'citadel-review-count');
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;
fs.writeFileSync(countPath, String(count));
let findings = [];
if (mode.includes('malformed once') && count === 1) findings = {};
if (mode.includes('repeated malformed') && !prompt.includes('strict-minimal-json')) findings = {};
if (mode.includes('oversize artifact')) findings = ['x'.repeat(1024 * 1024 + 1)];
if (mode.includes('substantive block')) findings = [{
  severity: 'high',
  title: 'Release invariant is violated',
  evidence: 'A valid blocking finding.',
  recommendation: 'Fix the release invariant.'
}];
const candidate = JSON.stringify({
  schema_version: 1,
  verdict: 'approve',
  reviewed_range: reviewedRange,
  acceptance_criteria_checked: mode.includes('invalid evidence') ? [] : criteria,
  findings,
  generated_at: '2026-07-18T00:00:00.000Z'
});
if (mode.includes('partial delayed artifact')) {
  fs.writeFileSync(reportPath, '{"schema_version":');
  setTimeout(() => fs.writeFileSync(reportPath, candidate), 75);
} else if (mode.includes('symlink artifact')) fs.symlinkSync(countPath, reportPath);
else fs.writeFileSync(reportPath, candidate);
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
    await assert.rejects(() => runCitadel(invalid.sessionDir), (error) => {
      assert.equal(error.code, 'CITADEL_REVIEWER_ARTIFACT_INVALID');
      assert.match(error.message, /coverage is incomplete/i);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(invalid.sessionDir, 'citadel-review-count'), 'utf8'), '2');

    const missingPromise = makeCitadelLifecycleSession('missing promise');
    await assert.rejects(() => runCitadel(missingPromise.sessionDir), /approval signal is missing/i);
    assert.equal(fs.readFileSync(path.join(missingPromise.sessionDir, 'citadel-review-count'), 'utf8'), '2');

    const delayed = makeCitadelLifecycleSession('partial delayed artifact completes before process exit');
    assert.equal(await runCitadel(delayed.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(delayed.sessionDir, 'citadel-review-count'), 'utf8'), '1');

    const telemetryCrash = makeCitadelLifecycleSession('validated telemetry survives a controller crash');
    await assert.rejects(() => runCitadel(telemetryCrash.sessionDir, {
      faultInjection: () => { throw new Error('fixture crash'); },
    }), /after durable candidate validation/i);
    const crashedState = JSON.parse(fs.readFileSync(
      path.join(telemetryCrash.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    assert.equal(crashedState.attempts[0].status, 'validated');
    assert.equal(crashedState.attempts[0].telemetry_status, 'started');
    assert.equal(reconcileValidatedCitadelTelemetry(telemetryCrash.sessionDir), 1);
    assert.deepEqual(reconcileInterruptedModelCallTelemetry(telemetryCrash.sessionDir, {
      reason: 'fixture-supervisor-recovery',
    }), []);
    assert.equal(await runCitadel(telemetryCrash.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(telemetryCrash.sessionDir, 'citadel-review-count'), 'utf8'), '1');
    const crashTelemetry = JSON.parse(fs.readFileSync(
      path.join(telemetryCrash.sessionDir, 'execution-telemetry.json'), 'utf8',
    ));
    assert.deepEqual(
      crashTelemetry.events.filter((event) => event.phase === 'citadel')
        .map(({ outcome, productive_work, discarded_work }) => ({ outcome, productive_work, discarded_work })),
      [{ outcome: 'success', productive_work: 1, discarded_work: 0 }],
    );

    for (const corruption of ['symlink', 'oversize']) {
      const recoveredUnsafe = makeCitadelLifecycleSession(`recovered ${corruption} candidate is rejected safely`);
      assert.equal(await runCitadel(recoveredUnsafe.sessionDir), 'success');
      const unsafeStatePath = path.join(recoveredUnsafe.sessionDir, 'citadel-review-state.json');
      const unsafeState = JSON.parse(fs.readFileSync(unsafeStatePath, 'utf8'));
      unsafeState.status = 'running';
      unsafeState.attempts[0].status = 'validated';
      const unsafeCandidate = unsafeState.attempts[0].candidate_path;
      fs.rmSync(unsafeCandidate, { force: true });
      if (corruption === 'symlink') {
        fs.symlinkSync(path.join(recoveredUnsafe.sessionDir, 'citadel-review-count'), unsafeCandidate);
      } else {
        fs.writeFileSync(unsafeCandidate, 'x'.repeat(1024 * 1024 + 1));
      }
      fs.writeFileSync(unsafeStatePath, JSON.stringify(unsafeState));
      assert.equal(await runCitadel(recoveredUnsafe.sessionDir), 'success');
      assert.equal(fs.readFileSync(path.join(recoveredUnsafe.sessionDir, 'citadel-review-count'), 'utf8'), '2');
      const repairedState = JSON.parse(fs.readFileSync(unsafeStatePath, 'utf8'));
      assert.equal(repairedState.attempts[0].status, 'rejected');
      assert.match(repairedState.attempts[0].validation_error, corruption === 'symlink' ? /non-symlink/i : /exceeds/i);
      assert.equal(repairedState.attempts[1].status, 'accepted');
    }

    const recovered = makeCitadelLifecycleSession('malformed once then approve');
    assert.equal(await runCitadel(recovered.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(recovered.sessionDir, 'citadel-review-count'), 'utf8'), '2');
    const recoveredAttemptFiles = fs.readdirSync(recovered.sessionDir)
      .filter((name) => /^citadel-review-attempt-.*\.json$/.test(name));
    assert.equal(recoveredAttemptFiles.length, 1);
    const recoveredAttempt = JSON.parse(fs.readFileSync(
      path.join(recovered.sessionDir, recoveredAttemptFiles[0]), 'utf8',
    ));
    assert.match(recoveredAttempt.validation_error, /findings must be an array/i);
    assert.equal(recoveredAttempt.checkpoint_restored, true);
    assert.match(recoveredAttempt.raw_report, /"findings":\{\}/);
    const recoveredTelemetry = JSON.parse(fs.readFileSync(
      path.join(recovered.sessionDir, 'execution-telemetry.json'), 'utf8',
    )).events.filter((event) => event.phase === 'citadel');
    assert.deepEqual(
      recoveredTelemetry.map(({ outcome, productive_work, discarded_work }) => ({ outcome, productive_work, discarded_work })),
      [
        { outcome: 'failed', productive_work: 0, discarded_work: 1 },
        { outcome: 'success', productive_work: 1, discarded_work: 0 },
      ],
    );
    const recoveryStatePath = path.join(recovered.sessionDir, 'citadel-review-state.json');
    const recoveryState = JSON.parse(fs.readFileSync(recoveryStatePath, 'utf8'));
    recoveryState.status = 'running';
    recoveryState.attempts.at(-1).status = 'validated';
    fs.writeFileSync(recoveryStatePath, JSON.stringify(recoveryState));
    fs.rmSync(path.join(recovered.sessionDir, 'citadel-report.json'), { force: true });
    assert.equal(await runCitadel(recovered.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(recovered.sessionDir, 'citadel-review-count'), 'utf8'), '2');

    const exhausted = makeCitadelLifecycleSession('repeated malformed reviewer evidence');
    await assert.rejects(() => runCitadel(exhausted.sessionDir), (error) => {
      assert.equal(error.code, 'CITADEL_REVIEWER_ARTIFACT_INVALID');
      assert.equal(error.attempts, 2);
      assert.match(error.message, /findings must be an array/i);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(exhausted.sessionDir, 'citadel-review-count'), 'utf8'), '2');
    assert.equal(fs.existsSync(path.join(exhausted.sessionDir, 'citadel-report.json')), false);
    const failure = JSON.parse(fs.readFileSync(
      path.join(exhausted.sessionDir, 'citadel-reviewer-artifact-failure.json'), 'utf8',
    ));
    assert.equal(failure.code, 'CITADEL_REVIEWER_ARTIFACT_INVALID');
    const exhaustedTelemetry = JSON.parse(fs.readFileSync(
      path.join(exhausted.sessionDir, 'execution-telemetry.json'), 'utf8',
    )).events.filter((event) => event.phase === 'citadel');
    assert.deepEqual(exhaustedTelemetry.map((event) => event.outcome), ['failed', 'failed']);
    const exhaustedAttemptFiles = fs.readdirSync(exhausted.sessionDir)
      .filter((name) => /^citadel-review-attempt-.*\.json$/.test(name));
    assert.equal(exhaustedAttemptFiles.length, 2);
    for (const attemptFile of exhaustedAttemptFiles) {
      assert.match(
        JSON.parse(fs.readFileSync(path.join(exhausted.sessionDir, attemptFile), 'utf8')).validation_error,
        /findings must be an array/i,
      );
    }
    assert.equal(await runCitadel(exhausted.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(exhausted.sessionDir, 'citadel-review-count'), 'utf8'), '3');
    const exhaustedState = JSON.parse(fs.readFileSync(
      path.join(exhausted.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    assert.equal(exhaustedState.status, 'accepted');
    assert.equal(exhaustedState.recovery_epoch, 2);
    assert.deepEqual(exhaustedState.attempts.map((entry) => entry.ordinal), [1, 2, 3]);
    assert.deepEqual(exhaustedState.attempts.map((entry) => entry.epoch), [1, 1, 2]);
    assert.notEqual(exhaustedState.attempts[0].strategy_hash, exhaustedState.attempts[2].strategy_hash);
    const resolvedFailure = JSON.parse(fs.readFileSync(
      path.join(exhausted.sessionDir, 'citadel-reviewer-artifact-failure.json'), 'utf8',
    ));
    assert.ok(resolvedFailure.resolved_at);

    for (const criterion of ['oversize artifact is rejected', 'symlink artifact is rejected']) {
      const unsafe = makeCitadelLifecycleSession(criterion);
      await assert.rejects(() => runCitadel(unsafe.sessionDir), /reviewer did not produce a valid artifact/i);
      const unsafeEvidenceFiles = fs.readdirSync(unsafe.sessionDir)
        .filter((name) => /^citadel-review-attempt-.*\.json$/.test(name));
      assert.equal(unsafeEvidenceFiles.length, 2);
      for (const fileName of unsafeEvidenceFiles) {
        const evidence = JSON.parse(fs.readFileSync(path.join(unsafe.sessionDir, fileName), 'utf8'));
        assert.equal(evidence.raw_report, null);
      }
      assert.equal(fs.existsSync(path.join(unsafe.sessionDir, 'citadel-report.json')), false);
    }

    const blocked = makeCitadelLifecycleSession('substantive block requires repair');
    assert.equal(await runCitadel(blocked.sessionDir), 'citadel-blocked');
    assert.equal(fs.readFileSync(path.join(blocked.sessionDir, 'citadel-review-count'), 'utf8'), '1');
    const blockedReport = JSON.parse(fs.readFileSync(path.join(blocked.sessionDir, 'citadel-report.json'), 'utf8'));
    assert.equal(blockedReport.findings[0].title, 'Release invariant is violated');
    assert.equal(
      fs.readdirSync(blocked.sessionDir).some((name) => /^citadel-review-attempt-.*\.json$/.test(name)),
      false,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
