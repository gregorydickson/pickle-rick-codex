// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  deduplicateCitadelCheckExecutions,
  deriveCitadelAcceptanceCriteria,
  citadelSystemBlockPath,
  getCitadelRepositoryFingerprint,
  readCitadelSystemBlock,
  runCitadel,
  runCitadelChecks,
  runCitadelChecksMonitored,
  runMonitoredCitadelCheck,
  recoverCitadelStartCommit,
  reconcileValidatedCitadelTelemetry,
  persistCitadelReleaseApproval,
  resolvePickleTrustedTestInventory,
  resolveCitadelCheckCwd,
  validateCitadelRecoveryEvidence,
  validateCitadelReport,
} from '../services/citadel.js';
import { reconcileInterruptedModelCallTelemetry } from '../services/productive-autonomy.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
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
    tickets: [{ id: 'T-1', acceptance_criteria: [criterion] }],
  }));
  return { cwd, sessionDir };
}

function sealCitadelSession(sessionDir, cwd, id, text, ticketVerification = null) {
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
    release_gates: ticketVerification
      ? { ticket_verification: [{ ticket_id: 't-1', acceptance_criteria: [text], verification: ticketVerification }] }
      : [],
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
    findings: [{
      severity: 'high', title: 'Broken contract', evidence: 'src/a.ts:4 contradicts src/b.ts:9',
      file: 'src/a.ts', line: 4, recommendation: 'Repair the contract mismatch.',
      ticket_ids: ['R1'], acceptance_criteria: ['AC-1'], paths: ['src/a.ts', 'src/b.ts'],
    }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']);
  assert.equal(report.verdict, 'block');
  assert.equal(report.findings[0].severity, 'high');
  assert.throws(() => validateCitadelReport({
    reviewed_range: 'abc..HEAD',
    findings: [{
      severity: 'urgent', title: 'Unknown severity', evidence: 'Evidence', file: null, line: null,
      recommendation: null, ticket_ids: [], acceptance_criteria: [], paths: [],
    }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']), /unsupported severity/);
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
  for (const finding of [null, [], {}, {
    severity: 'low', title: ' ', evidence: 'proof', file: null, line: null, recommendation: null,
    ticket_ids: [], acceptance_criteria: [], paths: [],
  }]) {
    assert.throws(
      () => validateCitadelReport({ reviewed_range: 'abc..HEAD', findings: [finding], acceptance_criteria_checked: ['AC-1'] }, 'abc..HEAD', ['AC-1']),
      /expected an object|missing required fields|title and evidence are required/,
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
    findings: [{
      severity: 'low', title: 'Advisory', evidence: 'Observed', file: '', line: null, recommendation: '',
      ticket_ids: [], acceptance_criteria: [], paths: [],
    }],
    acceptance_criteria_checked: ['AC-1'],
  }, 'abc..HEAD', ['AC-1']);
  assert.deepEqual(
    { file: defaults.findings[0].file, line: defaults.findings[0].line, recommendation: defaults.findings[0].recommendation },
    { file: null, line: null, recommendation: null },
  );
  assert.equal(Number.isNaN(Date.parse(defaults.generated_at)), false);
});

test('validateCitadelReport rejects every missing finding-schema key', () => {
  const complete = {
    severity: 'low', title: 'Complete advisory', evidence: 'Concrete evidence.',
    file: null, line: null, recommendation: null,
    ticket_ids: [], acceptance_criteria: [], paths: [],
  };
  for (const field of [
    'severity', 'title', 'evidence', 'file', 'line', 'recommendation',
    'ticket_ids', 'acceptance_criteria', 'paths',
  ]) {
    const finding = { ...complete };
    delete finding[field];
    assert.throws(
      () => validateCitadelReport({
        reviewed_range: 'abc..HEAD', findings: [finding], acceptance_criteria_checked: ['AC-1'],
      }, 'abc..HEAD', ['AC-1']),
      new RegExp(`missing required fields:.*${field}`),
      field,
    );
  }
});

test('validateCitadelReport requires concrete attribution arrays for every critical or high finding', () => {
  const complete = {
    severity: 'high', title: 'Blocking defect', evidence: 'src/a.ts:4 proves the defect.',
    file: 'src/a.ts', line: 4, recommendation: 'Repair the affected behavior.',
    ticket_ids: ['R1'], acceptance_criteria: ['AC-1'], paths: ['src/a.ts'],
  };
  for (const field of ['ticket_ids', 'acceptance_criteria', 'paths']) {
    assert.throws(
      () => validateCitadelReport({
        reviewed_range: 'abc..HEAD',
        findings: [{ ...complete, [field]: [] }],
        acceptance_criteria_checked: ['AC-1'],
      }, 'abc..HEAD', ['AC-1']),
      /critical\/high findings require non-empty ticket_ids, acceptance_criteria, and paths/,
      field,
    );
  }
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

test('Citadel deduplicates exact auto-discovered and ticket executions by structured identity', async () => {
  const cwd = makeTempRoot('pickle-citadel-structured-dedupe-');
  const sessionDir = makeTempRoot('pickle-citadel-structured-dedupe-session-');
  const marker = path.join(cwd, 'execution-count');
  fs.writeFileSync(path.join(cwd, 'count.cjs'), [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;",
    "fs.writeFileSync(marker, String(count + 1));",
  ].join('\n'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node count.cjs' } }));
  execFileSync('git', ['init', '-q'], { cwd });
  const descriptors = [
    { command: 'npm run test', executable: 'npm', args: ['run', 'test'] },
    {
      command: 'ticket T-1 verification',
      executable: 'npm',
      args: ['run', 'test'],
      cwd: '.',
      verificationStep: { kind: 'process', executable: 'npm', args: ['run', 'test'] },
    },
  ];

  const deduplicated = deduplicateCitadelCheckExecutions(descriptors, cwd);
  const results = await runCitadelChecksMonitored(cwd, sessionDir, [{
    kind: 'package_script', manager: 'npm', script: 'test',
  }], {
    timeoutMs: 10_000,
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => {},
  });

  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0], descriptors[0]);
  assert.equal(fs.readFileSync(marker, 'utf8'), '1');
  assert.deepEqual(results.map(({ command }) => command), [
    'npm run typecheck', 'npm run lint', 'npm run test', 'git diff --check',
  ]);
});

test('Citadel structured deduplication retains distinct cwd, env, argv, and skip semantics', () => {
  const cwd = makeTempRoot('pickle-citadel-structured-retention-');
  const nested = path.join(cwd, 'nested');
  fs.mkdirSync(nested);
  const base = { command: 'base', executable: 'node', args: ['--version'], env: { PATH: process.env.PATH, MODE: 'a' } };
  const descriptors = [
    base,
    { ...base, command: 'cwd', cwd: nested },
    { ...base, command: 'env', env: { PATH: process.env.PATH, MODE: 'b' } },
    { ...base, command: 'argv', args: ['--help'] },
    { ...base, command: 'skipped', skipped: true },
  ];

  assert.deepEqual(deduplicateCitadelCheckExecutions(descriptors, cwd), descriptors);
});

function makeTrustedPickleTopology(delayMs = 75, npmBody = null) {
  const cwd = makeTempRoot('pickle-citadel-trusted-topology-');
  const sessionDir = makeTempRoot('pickle-citadel-trusted-session-');
  const fakeBin = path.join(cwd, 'fake-bin');
  const orderPath = path.join(cwd, 'trusted-order');
  fs.mkdirSync(path.join(cwd, 'extension'));
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'pickle-rick-codex',
    scripts: { test: 'npm --prefix extension test' },
  }));
  fs.writeFileSync(path.join(cwd, 'extension', 'package.json'), JSON.stringify({
    scripts: {
      pretest: 'if [ -d src ] && [ -d node_modules ]; then npm run build && npm run audit:test-tiers; fi',
      test: 'npm run test:fast && npm run test:integration',
      prebuild: 'bash scripts/copy-shell-assets.sh',
      build: 'tsc',
      'audit:test-tiers': 'bash scripts/audit-test-tiers.sh',
      'test:fast': 'node bin/test-runner.js --tier fast --test-concurrency=8',
      'test:integration': 'node bin/test-runner.js --tier integration --test-concurrency=4',
    },
  }));
  writeExecutable(path.join(fakeBin, 'npm'), (npmBody || `#!/bin/sh
item=''
for arg in "$@"; do item="$arg"; done
printf '%s\\n' "$item" >> ${JSON.stringify(orderPath)}
printf 'untrusted-forged-progress:%s\\n' "$item"
sleep ${delayMs / 1_000}
`).replace('__ORDER_PATH__', JSON.stringify(orderPath)));
  execFileSync('git', ['init', '-q'], { cwd });
  return { cwd, sessionDir, fakeBin, orderPath };
}

test('Citadel trusted npm adapter binds exact immutable topology and fails closed on drift', () => {
  const fixture = makeTrustedPickleTopology();
  const inventory = resolvePickleTrustedTestInventory(fixture.cwd, 250, {
    PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}`,
    FIXTURE: 'trusted',
  });
  assert.ok(inventory);
  assert.deepEqual(inventory.items.map(({ id, ordinal }) => ({ id, ordinal })), [
    { id: 'extension-build', ordinal: 1 },
    { id: 'extension-audit-test-tiers', ordinal: 2 },
    { id: 'extension-test-fast', ordinal: 3 },
    { id: 'extension-test-integration', ordinal: 4 },
  ]);
  assert.equal(new Set(inventory.items.map((item) => item.execution_identity)).size, 4);
  assert.match(inventory.inventory_id, /^[a-f0-9]{64}$/);
  const extensionPackagePath = path.join(fixture.cwd, 'extension', 'package.json');
  const extensionPackage = JSON.parse(fs.readFileSync(extensionPackagePath, 'utf8'));
  extensionPackage.scripts.test = 'npm run test:fast';
  fs.writeFileSync(extensionPackagePath, JSON.stringify(extensionPackage));
  assert.throws(
    () => resolvePickleTrustedTestInventory(fixture.cwd, 250),
    /topology drifted.*test/i,
  );
});

test('Citadel controller accepts only ordered successful inventory completions as semantic progress', async () => {
  const itemTimeoutMs = 5_000;
  const fixture = makeTrustedPickleTopology(1_400);
  const startedAt = Date.now();
  const results = await runCitadelChecksMonitored(fixture.cwd, fixture.sessionDir, [], {
    timeoutMs: itemTimeoutMs,
    environment: { ...process.env, PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}` },
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => {},
  });
  const testResult = results.find((result) => result.command === 'npm run test');
  assert.equal(testResult.status, 'passed');
  assert.equal(testResult.semantic_progress_count, 4);
  assert.equal(testResult.last_progress_identity, 'extension-test-integration');
  assert.ok(Date.now() - startedAt > itemTimeoutMs, 'ordered completions must extend work beyond one item window');
  assert.deepEqual(fs.readFileSync(fixture.orderPath, 'utf8').trim().split('\n'), [
    'build', 'audit:test-tiers', 'test:fast', 'test:integration',
  ]);
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.sessionDir, 'citadel-deterministic-check-journal.json'), 'utf8',
  ));
  assert.equal(journal.status, 'completed');
  assert.deepEqual(journal.completed_items.map(({ item_id, ordinal }) => ({ item_id, ordinal })), [
    { item_id: 'extension-build', ordinal: 1 },
    { item_id: 'extension-audit-test-tiers', ordinal: 2 },
    { item_id: 'extension-test-fast', ordinal: 3 },
    { item_id: 'extension-test-integration', ordinal: 4 },
  ]);
});

test('Citadel whole-gate absolute cap dominates continuing valid inventory progress', async () => {
  const readyPath = path.join(process.env.TMPDIR || '/tmp', `pickle-citadel-gate-ready-${process.pid}-${Date.now()}`);
  const fixture = makeTrustedPickleTopology(0, `#!/bin/sh
item=''
for arg in "$@"; do item="$arg"; done
printf '%s\\n' "$item" >> __ORDER_PATH__
if [ "$item" = 'build' ]; then exit 0; fi
printf 'ready\\n' > ${JSON.stringify(readyPath)}
while :; do sleep 1; done
`);
  const results = await runCitadelChecksMonitored(fixture.cwd, fixture.sessionDir, [], {
    timeoutMs: 10_000,
    wholeGateTimeoutMs: 2_000,
    environment: { ...process.env, PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}` },
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => {},
  });
  const testResult = results.find((result) => result.command === 'npm run test');
  assert.equal(testResult.status, 'failed');
  assert.equal(testResult.timed_out, true);
  assert.equal(testResult.timeout_kind, 'absolute');
  assert.equal(testResult.semantic_progress_count, 1);
  assert.equal(fs.existsSync(readyPath), true, 'the blocked second item must be ready before the gate cap');
  assert.deepEqual(fs.readFileSync(fixture.orderPath, 'utf8').trim().split('\n'), [
    'build', 'audit:test-tiers',
  ]);
  assert.equal(results.some((result) => result.command === 'git diff --check'), false);
});

test('Citadel cancellation dominates a successful trusted completion before the next item', async () => {
  const fixture = makeTrustedPickleTopology(25);
  let exits = 0;
  await assert.rejects(() => runCitadelChecksMonitored(fixture.cwd, fixture.sessionDir, [], {
    timeoutMs: 400,
    environment: { ...process.env, PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}` },
    isCancelled: () => exits >= 1,
    onSpawn: () => {},
    onExit: () => { exits += 1; },
  }), /deterministic checks cancelled/i);
  assert.deepEqual(fs.readFileSync(fixture.orderPath, 'utf8').trim().split('\n'), ['build']);
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.sessionDir, 'citadel-deterministic-check-journal.json'), 'utf8',
  ));
  assert.equal(journal.status, 'interrupted');
});

test('Citadel snapshots cancellation at close before the cancellation poll can run', async () => {
  const cwd = makeTempRoot('pickle-citadel-close-cancel-race-');
  let cancellationChecks = 0;
  let drainCalls = 0;
  let exitOutcome = null;

  await assert.rejects(
    () => runMonitoredCitadelCheck({
      command: 'immediate close',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }, cwd, {
      timeoutMs: 10_000,
      cancelPollMs: 60_000,
      isCancelled: () => ++cancellationChecks === 2,
      onSpawn: () => {},
      onExit: (outcome) => { exitOutcome = outcome; },
      drainProcessTree: async () => { drainCalls += 1; return true; },
    }),
    /deterministic checks cancelled/i,
  );

  assert.equal(cancellationChecks, 2, 'cancellation must be checked once before spawn and once at close');
  assert.equal(drainCalls, 1, 'close-observed cancellation must use the awaited drain path');
  assert.deepEqual(exitOutcome, { quiescent: true, cancelled: true, timedOut: false });
});

test('Citadel deadlines begin at child spawn even when onSpawn persistence is delayed', async () => {
  const cwd = makeTempRoot('pickle-citadel-delayed-onspawn-');
  const result = await runMonitoredCitadelCheck({
    command: 'early exit with delayed fence persistence',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  }, cwd, {
    timeoutMs: 25,
    absoluteTimeoutMs: 25,
    isCancelled: () => false,
    onSpawn: async () => await new Promise((resolve) => setTimeout(resolve, 200)),
    onExit: () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.ok(result.elapsed_ms >= 200);
});

test('Citadel whole-gate cap includes delayed onSpawn and suppresses the next check', async () => {
  const cwd = makeTempRoot('pickle-citadel-delayed-onspawn-gate-');
  const sessionDir = makeTempRoot('pickle-citadel-delayed-onspawn-session-');
  const marker = path.join(cwd, 'later-check-ran');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
  }));
  execFileSync('git', ['init', '-q'], { cwd });
  const results = await runCitadelChecksMonitored(cwd, sessionDir, [{
    kind: 'process',
    executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  }], {
    timeoutMs: 1_000,
    wholeGateTimeoutMs: 75,
    isCancelled: () => false,
    onSpawn: async () => await new Promise((resolve) => setTimeout(resolve, 200)),
    onExit: () => {},
  });
  const testResult = results.find((result) => result.command === 'npm run test');
  assert.equal(testResult.status, 'failed');
  assert.equal(testResult.timed_out, true);
  assert.equal(testResult.timeout_kind, 'absolute');
  assert.equal(fs.existsSync(marker), false);
});

test('Citadel timeout drains its ready process tree and suppresses every subsequent check', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = makeTempRoot('pickle-citadel-timeout-quiescence-');
  const sessionDir = makeTempRoot('pickle-citadel-timeout-session-');
  const marker = path.join(cwd, 'subsequent-check-ran');
  const readyMarker = path.join(cwd, 'timed-check-ready');
  fs.writeFileSync(path.join(cwd, 'timeout-fixture.cjs'), [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyMarker)}, 'ready');`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node timeout-fixture.cjs' },
  }));
  let childPid = null;
  let childIdentity = null;
  let readyBeforeTimeout = false;
  const results = await runCitadelChecksMonitored(cwd, sessionDir, [{
    kind: 'process',
    executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  }], {
    timeoutMs: 100,
    isCancelled: () => false,
    onSpawn: (child) => {
      childPid = Number(child.pid);
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(readyMarker) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      readyBeforeTimeout = fs.existsSync(readyMarker);
      const captured = captureSpawnedProcessIdentity(childPid);
      childIdentity = captured ? Object.freeze({ ...captured }) : null;
    },
    onExit: () => {},
  });

  assert.equal(readyBeforeTimeout, true, 'timeout must start only after the inner command is ready');
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.ok(childIdentity, 'the active group leader must have an immutable recovery identity');
  assert.equal(Object.isFrozen(childIdentity), true);
  assert.equal(childIdentity.pid, childPid);
  assert.equal(childIdentity.pgid, childPid, 'the captured child must be the exact process-group leader');
  assert.deepEqual(results.map(({ status }) => status), ['skipped', 'skipped', 'failed']);
  assert.equal(results.at(-1).command, 'npm run test');
  assert.equal(results.at(-1).timed_out, true);
  assert.equal(results.at(-1).timeout_kind, 'inactivity');
  assert.equal(results.at(-1).inactivity_timeout_ms, 100);
  assert.equal(results.at(-1).absolute_timeout_ms, 100);
  assert.ok(results.at(-1).output_bytes >= 0);
  assert.ok(results.at(-1).elapsed_ms >= 100);
  assert.notEqual(results.at(-1).process_tree_quiescent, false);
  assert.match(results.at(-1).output, /timed out/);
  assert.doesNotMatch(results.at(-1).output, /did not quiesce/);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(
    () => process.kill(-childIdentity.pgid, 0),
    (error) => error?.code === 'ESRCH',
    'the exact captured process group must be dead before the result is returned',
  );
});

test('Citadel ignores arbitrary output spam for semantic progress and drains at inactivity timeout', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = makeTempRoot('pickle-citadel-progress-timeout-');
  const spamProgressPath = path.join(cwd, 'spam-progress');
  let childIdentity = null;
  const result = await runMonitoredCitadelCheck({
    command: 'continuous progress fixture',
    executable: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs');",
      'let sequence = 0;',
      'const emitSpam = () => {',
      `  fs.appendFileSync(${JSON.stringify(spamProgressPath)}, String(++sequence) + '\\n');`,
      "  process.stdout.write('extension-test-integration\\nunknown-item\\nextension-test-fast\\nextension-test-fast\\n');",
      '};',
      'emitSpam();',
      'setInterval(emitSpam, 20);',
    ].join(' ')],
  }, cwd, {
    timeoutMs: 300,
    // The absolute execution cap is intentionally well outside the inactivity
    // deadline. Process-tree teardown happens after either deadline fires and
    // is not itself evidence that arbitrary child output extended execution.
    absoluteTimeoutMs: 5_000,
    isCancelled: () => false,
    onSpawn: (child) => { childIdentity = captureSpawnedProcessIdentity(Number(child.pid)); },
    onExit: () => {},
  });

  assert.ok(childIdentity);
  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_kind, 'inactivity');
  assert.equal(result.inactivity_timeout_ms, 300);
  assert.equal(result.absolute_timeout_ms, 5_000);
  assert.ok(result.output_bytes > 0);
  const spamSequence = fs.readFileSync(spamProgressPath, 'utf8').trim().split('\n').map(Number);
  assert.ok(spamSequence.length > 1, 'the child must emit repeated output while the inactivity clock runs');
  assert.deepEqual(spamSequence, spamSequence.map((_value, index) => index + 1));
  assert.match(result.output, /trusted semantic progress/);
  assert.notEqual(result.process_tree_quiescent, false);
  assert.throws(
    () => process.kill(-childIdentity.pgid, 0),
    (error) => error?.code === 'ESRCH',
  );
});

test('Citadel does not let bounded child output forge trusted semantic progress', async () => {
  const cwd = makeTempRoot('pickle-citadel-progress-success-');
  const readyPath = path.join(cwd, 'bounded-output-ready');
  const result = await runMonitoredCitadelCheck({
    command: 'bounded progress fixture',
    executable: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs');",
      "process.stdout.write('tick\\n');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      'setInterval(() => {}, 1_000);',
    ].join(' ')],
  }, cwd, {
    timeoutMs: 1_000,
    absoluteTimeoutMs: 5_000,
    isCancelled: () => false,
    onSpawn: () => {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(readyPath) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.equal(fs.existsSync(readyPath), true, 'the bounded-output child must reach its ready barrier');
    },
    onExit: () => {},
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_kind, 'inactivity');
  assert.match(result.output, /tick/);
});

test('Citadel preserves the active child fence and suppresses later checks when drain cannot prove quiescence', async () => {
  const cwd = makeTempRoot('pickle-citadel-nonquiescent-');
  const sessionDir = makeTempRoot('pickle-citadel-nonquiescent-session-');
  const marker = path.join(cwd, 'subsequent-check-ran');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` },
  }));
  let activeFence = null;
  let exitOutcome = null;
  const results = await runCitadelChecksMonitored(cwd, sessionDir, [{
    kind: 'process',
    executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  }], {
    timeoutMs: 100,
    isCancelled: () => false,
    onSpawn: (child, command) => {
      activeFence = Object.freeze({ pid: child.pid, command });
    },
    onExit: (outcome) => {
      exitOutcome = outcome;
      if (outcome.quiescent) activeFence = null;
    },
    drainProcessTree: async () => false,
  });

  assert.equal(results.at(-1).process_tree_quiescent, false);
  assert.match(results.at(-1).output, /did not quiesce/);
  assert.deepEqual(exitOutcome, { quiescent: false, cancelled: false, timedOut: true });
  assert.equal(activeFence.command, 'npm run test');
  assert.equal(fs.existsSync(marker), false);
});

test('Citadel bounds lifecycle callback and drain failures without cache-passable success', async () => {
  const cwd = makeTempRoot('pickle-citadel-lifecycle-callbacks-');
  let spawnFailureExit = null;
  const spawnFailure = await runMonitoredCitadelCheck({
    command: 'onSpawn failure',
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }, cwd, {
    timeoutMs: 5_000,
    isCancelled: () => false,
    onSpawn: () => { throw new Error('fence persistence failed'); },
    onExit: (outcome) => { spawnFailureExit = outcome; },
  });
  assert.equal(spawnFailure.status, 'failed');
  assert.match(spawnFailure.output, /fence persistence failed/);
  assert.deepEqual(spawnFailureExit, { quiescent: true, cancelled: false, timedOut: false });

  const drainFailure = await runMonitoredCitadelCheck({
    command: 'drain failure',
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }, cwd, {
    timeoutMs: 75,
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => {},
    drainProcessTree: async () => { throw new Error('drain fixture rejected'); },
  });
  assert.equal(drainFailure.status, 'failed');
  assert.equal(drainFailure.process_tree_quiescent, false);
  assert.match(drainFailure.lifecycle_error, /drain fixture rejected/);

  const exitFailure = await runMonitoredCitadelCheck({
    command: 'onExit failure',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  }, cwd, {
    timeoutMs: 5_000,
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => { throw new Error('fence clear failed'); },
  });
  assert.equal(exitFailure.status, 'failed');
  assert.equal(exitFailure.process_tree_quiescent, false);
  assert.match(exitFailure.lifecycle_error, /fence clear failed/);
});

test('Citadel watchdog settles callbacks and drains that never resolve', async () => {
  const cwd = makeTempRoot('pickle-citadel-lifecycle-watchdog-');
  const startedAt = Date.now();
  const spawnHang = await runMonitoredCitadelCheck({
    command: 'onSpawn hangs',
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }, cwd, {
    timeoutMs: 10_000,
    isCancelled: () => false,
    onSpawn: async () => await new Promise(() => {}),
    onExit: () => {},
  });
  assert.equal(spawnHang.status, 'failed');
  assert.match(spawnHang.output, /onSpawn callback did not settle/i);

  const exitHang = await runMonitoredCitadelCheck({
    command: 'onExit hangs',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  }, cwd, {
    timeoutMs: 10_000,
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: async () => await new Promise(() => {}),
  });
  assert.equal(exitHang.status, 'failed');
  assert.equal(exitHang.process_tree_quiescent, false);
  assert.match(exitHang.lifecycle_error, /onExit callback did not settle/i);

  const drainHang = await runMonitoredCitadelCheck({
    command: 'drain hangs',
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }, cwd, {
    timeoutMs: 75,
    isCancelled: () => false,
    onSpawn: () => {},
    onExit: () => {},
    drainProcessTree: async () => await new Promise(() => {}),
  });
  assert.equal(drainHang.status, 'failed');
  assert.equal(drainHang.process_tree_quiescent, false);
  assert.match(drainHang.lifecycle_error, /process-tree drain did not settle/i);
  assert.ok(Date.now() - startedAt < 10_000, 'independent lifecycle watchdogs must bound total settlement');
});

test('Citadel kills descendants that retain inherited pipes after their leader exits', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = makeTempRoot('pickle-citadel-retained-pipes-');
  const releaseMarker = path.join(cwd, 'release-leader');
  let identity = null;
  const result = await runMonitoredCitadelCheck({
    command: 'descendant retains pipes',
    executable: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs');",
      `while (!fs.existsSync(${JSON.stringify(releaseMarker)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      'process.exit(0);',
    ].join(' ')],
  }, cwd, {
    timeoutMs: 100,
    isCancelled: () => false,
    onSpawn: (child) => {
      const deadline = Date.now() + 1_000;
      while (!identity && Date.now() < deadline) {
        identity = captureSpawnedProcessIdentity(Number(child.pid));
      }
      fs.writeFileSync(releaseMarker, 'go');
    },
    onExit: () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.ok(identity);
  assert.throws(() => process.kill(-identity.pgid, 0), (error) => error?.code === 'ESRCH');
});

test('Citadel timeout remains failed when SIGTERM handler exits zero and records bounded output loss', async () => {
  const cwd = makeTempRoot('pickle-citadel-timeout-exit-zero-');
  const readyMarker = path.join(cwd, 'sigterm-handler-ready');
  const result = await runMonitoredCitadelCheck({
    command: 'timeout then zero',
    executable: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs');",
      'process.on(\'SIGTERM\', () => process.exit(0));',
      "process.stdout.write('x'.repeat(150000));",
      `fs.writeFileSync(${JSON.stringify(readyMarker)}, 'ready');`,
      'setInterval(() => {}, 1000);',
    ].join(' ')],
  }, cwd, {
    timeoutMs: 1_000,
    isCancelled: () => false,
    onSpawn: async () => {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(readyMarker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(fs.existsSync(readyMarker), true, 'child installed its SIGTERM handler before timeout');
    },
    onExit: () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.output_bytes, 150_000);
  assert.equal(result.output_truncated, true);
  assert.ok(result.output_dropped_bytes >= 50_000);
});

test('Citadel cooperatively terminates a long deterministic check after lease loss', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('The handoff drains Citadel.');
  const startedMarker = path.join(sessionDir, 'citadel-check-started');
  const drainedMarker = path.join(sessionDir, 'citadel-check-drained');
  fs.writeFileSync(path.join(cwd, 'citadel-drain-fixture.cjs'), [
    "const fs = require('node:fs');",
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(drainedMarker)}, 'drained'); process.exit(0); });`,
    `fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node citadel-drain-fixture.cjs' },
  }));
  execFileSync('git', ['add', 'package.json', 'citadel-drain-fixture.cjs'], { cwd });
  execFileSync('git', ['commit', '-qm', 'long check fixture'], { cwd });
  const statePath = path.join(sessionDir, 'state.json');
  new StateManager().update(statePath, (state) => {
    state.start_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    return state;
  });
  await assert.rejects(
    () => runCitadel(sessionDir, {
      assertDurableOwnership: () => {
        if (fs.existsSync(startedMarker)) throw new Error('fixture lease ownership changed');
      },
    }),
    /fixture lease ownership changed/,
  );
  assert.equal(fs.readFileSync(drainedMarker, 'utf8'), 'drained');
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
  assert.equal(await runCitadel(noCriteria), 'citadel-system-blocked');
  const noCriteriaBlock = readCitadelSystemBlock(noCriteria);
  assert.equal(noCriteriaBlock.code, 'acceptance_criteria_missing');
  assert.equal(noCriteriaBlock.recovery_action, 'request_prd_revision');
  assert.equal(noCriteriaBlock.next_action, 'retry_phase');
  assert.equal(fs.existsSync(path.join(noCriteria, 'citadel-report.json')), false);
  assert.equal(await runCitadel(noCriteria), 'citadel-system-blocked');
  assert.equal(readCitadelSystemBlock(noCriteria).next_action, 'restart_executor');

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
  assert.equal(await runCitadel(malformedScope), 'citadel-system-blocked');
  const scopeBlock = readCitadelSystemBlock(malformedScope);
  assert.equal(scopeBlock.code, 'scope_contract_invalid');
  assert.equal(scopeBlock.recovery_action, 'request_prd_revision');
  assert.match(scopeBlock.evidence, /scope\.json identity is malformed/);
  assert.equal(fs.existsSync(path.join(malformedScope, 'citadel-report.json')), false);
  assert.equal(citadelSystemBlockPath(malformedScope), path.join(malformedScope, 'citadel-system-block.json'));
});

test('runCitadel persists deterministic failures as typed system recovery, never canonical findings', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('The deterministic release gate passes.');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].verification = ['npm test'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.stderr.write(\'deterministic failure\\n\'); process.exit(7)"' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'make deterministic gate fail'], { cwd });

  assert.equal(await runCitadel(sessionDir), 'citadel-system-blocked');
  const systemBlock = readCitadelSystemBlock(sessionDir);
  assert.equal(systemBlock.code, 'deterministic_check_failed');
  assert.equal(systemBlock.recovery_action, 'retry_checks');
  assert.equal(systemBlock.checks.some((check) => check.status === 'failed'), true);
  assert.match(systemBlock.evidence, /deterministic failure/);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-report.json')), false);
  assert.equal(await runCitadel(sessionDir), 'citadel-system-blocked');
  const repeated = readCitadelSystemBlock(sessionDir);
  assert.equal(repeated.failure_identity, systemBlock.failure_identity);
  assert.equal(repeated.attempt, 2);
  assert.equal(repeated.bounded_attempt, 2);

  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.stderr.write(\'changed deterministic evidence\\n\'); process.exit(7)"' },
  }));
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'change deterministic diagnostic evidence'], { cwd });
  assert.equal(await runCitadel(sessionDir), 'citadel-system-blocked');
  const changedEvidence = readCitadelSystemBlock(sessionDir);
  assert.notEqual(changedEvidence.failure_identity, systemBlock.failure_identity);
  assert.match(changedEvidence.checks.find((check) => check.status === 'failed').output, /changed deterministic evidence/);
  assert.equal(changedEvidence.attempt, 1);
  assert.equal(changedEvidence.bounded_attempt, 1);
});

test('runCitadel assigns an unavailable substantive gate to exact verification-contract repair tickets', async () => {
  const { cwd, sessionDir } = makeCitadelLifecycleSession('The ticket declares a substantive deterministic gate.');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'no-release-gate-fixture' }));
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'remove package release gate'], { cwd });

  assert.equal(await runCitadel(sessionDir), 'citadel-system-blocked');
  const systemBlock = readCitadelSystemBlock(sessionDir);
  assert.equal(systemBlock.code, 'deterministic_gate_unavailable');
  assert.equal(systemBlock.recovery_action, 'repair_verification_contract');
  assert.deepEqual(systemBlock.recovery_ticket_ids, ['T-1']);
  assert.equal(systemBlock.checks.find((check) => check.command === 'git diff --check').status, 'passed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-report.json')), false);
});

test('sealed Citadel classifies a malformed authorized manifest verifier for repair without weakening drift checks', async () => {
  const criterion = 'The sealed deterministic verifier remains mandatory.';
  const authorized = [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }];
  const malformed = makeCitadelLifecycleSession(criterion);
  fs.writeFileSync(path.join(malformed.sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{
      id: 'T-1', acceptance_criteria: [criterion],
      verification: [{ kind: 'process', executable: 'node', args: 'not-an-array' }],
    }],
  }));
  sealCitadelSession(malformed.sessionDir, malformed.cwd, 'AC-SEALED-01', criterion, authorized);

  assert.equal(await runCitadel(malformed.sessionDir), 'citadel-system-blocked');
  const systemBlock = readCitadelSystemBlock(malformed.sessionDir);
  assert.equal(systemBlock.code, 'deterministic_gate_unavailable');
  assert.equal(systemBlock.recovery_action, 'repair_verification_contract');
  assert.deepEqual(systemBlock.recovery_ticket_ids, ['T-1']);

  const drift = makeCitadelLifecycleSession(criterion);
  fs.writeFileSync(path.join(drift.sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{
      id: 'T-1', acceptance_criteria: [criterion],
      verification: [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(9)'] }],
    }],
  }));
  sealCitadelSession(drift.sessionDir, drift.cwd, 'AC-SEALED-01', criterion, authorized);
  await assert.rejects(() => runCitadel(drift.sessionDir), /sealed-verification-semantic-drift/);
});

test('validateCitadelRecoveryEvidence authenticates runtime output and rejects bundle or repository drift', async () => {
  const fakeBin = makeTempRoot('pickle-citadel-recovery-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const candidatePath = prompt.match(/Citadel report path: ([^\\n]+)/)?.[1]?.trim();
const criteria = JSON.parse(prompt.match(/Required acceptance criteria .*: (\\[[^\\n]+\\])/)?.[1] || '[]');
const reviewedRange = prompt.match(/Review git range: ([^\\n]+)/)?.[1]?.trim();
fs.writeFileSync(candidatePath, JSON.stringify({
  schema_version: 1,
  verdict: 'approve',
  reviewed_range: reviewedRange,
  acceptance_criteria_checked: criteria,
  findings: [],
  generated_at: '2026-08-09T00:00:00.000Z'
}));
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], '<promise>THE_CITADEL_APPROVES</promise>');
console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 1 } }));
`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  try {
    const fixture = makeCitadelLifecycleSession('recovery evidence remains exactly bound');
    fs.writeFileSync(path.join(fixture.sessionDir, 'refinement_manifest.json'), JSON.stringify({
      tickets: [{
        id: 'T-1',
        acceptance_criteria: ['recovery evidence remains exactly bound'],
        verification: [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }],
      }],
    }));
    assert.equal(await runCitadel(fixture.sessionDir), 'success');
    const state = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, 'state.json'), 'utf8'));
    const authority = validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state);
    assert.equal(authority.repository_head, execFileSync(
      'git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf8' },
    ).trim());
    assert.equal(authority.release_fingerprint, getCitadelRepositoryFingerprint(fixture.cwd));
    assert.equal(authority.reviewed_range, `${state.start_commit}..HEAD`);
    assert.equal(authority.report_verdict, 'approve');
    for (const field of [
      'manifest_sha256', 'checks_sha256', 'journal_sha256', 'review_state_sha256',
      'report_sha256', 'checks_binding_hash', 'verification_hash',
      'acceptance_criteria_hash', 'review_identity',
    ]) assert.match(authority[field], /^[a-f0-9]{64}$/);

    const checksPath = path.join(fixture.sessionDir, 'citadel-checks.json');
    const checksBytes = fs.readFileSync(checksPath);
    const forgedChecks = JSON.parse(checksBytes.toString('utf8'));
    forgedChecks.binding.release_fingerprint = 'forged';
    fs.writeFileSync(checksPath, JSON.stringify(forgedChecks));
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /release authority/,
    );
    fs.writeFileSync(checksPath, checksBytes);

    const forgedExecutionIdentity = JSON.parse(checksBytes.toString('utf8'));
    forgedExecutionIdentity.binding.deterministic_timeout_policy.executions[0].execution_identity = '0'.repeat(64);
    const journalPath = path.join(fixture.sessionDir, 'citadel-deterministic-check-journal.json');
    const journalBytes = fs.readFileSync(journalPath);
    const forgedIdentityJournal = JSON.parse(journalBytes.toString('utf8'));
    forgedIdentityJournal.binding_hash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedExecutionIdentity.binding)).digest('hex');
    forgedExecutionIdentity.journal_hash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedIdentityJournal)).digest('hex');
    fs.writeFileSync(checksPath, JSON.stringify(forgedExecutionIdentity));
    fs.writeFileSync(journalPath, JSON.stringify(forgedIdentityJournal));
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /accepted review for the current evidence/,
    );
    fs.writeFileSync(checksPath, checksBytes);
    fs.writeFileSync(journalPath, journalBytes);

    const forgedJournal = JSON.parse(journalBytes.toString('utf8'));
    forgedJournal.status = 'running';
    fs.writeFileSync(journalPath, JSON.stringify(forgedJournal));
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /completed journal/,
    );
    fs.writeFileSync(journalPath, journalBytes);

    const reviewStatePath = path.join(fixture.sessionDir, 'citadel-review-state.json');
    const reviewStateBytes = fs.readFileSync(reviewStatePath);
    const forgedReviewState = JSON.parse(reviewStateBytes.toString('utf8'));
    forgedReviewState.attempts.at(-1).candidate_hash = '0'.repeat(64);
    fs.writeFileSync(reviewStatePath, JSON.stringify(forgedReviewState));
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /candidate digest changed/,
    );
    fs.writeFileSync(reviewStatePath, reviewStateBytes);

    const reportPath = path.join(fixture.sessionDir, 'citadel-report.json');
    const reportBytes = fs.readFileSync(reportPath);
    const forgedReport = JSON.parse(reportBytes.toString('utf8'));
    forgedReport.generated_at = '2026-08-10T00:00:00.000Z';
    fs.writeFileSync(reportPath, JSON.stringify(forgedReport));
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /accepted reviewer candidate/,
    );
    fs.writeFileSync(reportPath, reportBytes);

    fs.writeFileSync(path.join(fixture.cwd, 'unattributed.txt'), 'dirty');
    assert.throws(
      () => validateCitadelRecoveryEvidence(fixture.sessionDir, fixture.cwd, state),
      /clean release tree/,
    );
    fs.rmSync(path.join(fixture.cwd, 'unattributed.txt'));
  } finally {
    process.env.PATH = originalPath;
  }
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
if (prompt.includes('Closed reviewer execution mechanism:')) {
  fs.writeFileSync(path.join(path.dirname(path.dirname(reportPath)), '..', 'citadel-recovery-prompt-' + count + '.txt'), prompt);
}
let findings = [];
if (mode.includes('malformed once') && count === 1) findings = {};
if (mode.includes('repeated malformed') && !prompt.includes('strict-minimal-json')) findings = {};
if (mode.includes('catalog exhaustion') && !prompt.includes('artifact-contract-reconstruction')) findings = {};
if (mode.includes('oversize artifact')) findings = ['x'.repeat(1024 * 1024 + 1)];
if (mode.includes('substantive block')) findings = [{
  severity: 'high',
  title: 'Release invariant is violated',
  evidence: 'A valid blocking finding.',
  file: 'package.json',
  line: 1,
  recommendation: 'Fix the release invariant.',
  ticket_ids: ['T-1'],
  acceptance_criteria: criteria,
  paths: ['package.json']
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

    const cacheBound = makeCitadelLifecycleSession('deterministic cache is policy and journal bound');
    const gateCountPath = path.join(cacheBound.sessionDir, 'deterministic-gate-count');
    fs.writeFileSync(path.join(cacheBound.cwd, 'package.json'), JSON.stringify({
      scripts: {
        test: `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
          "const fs = require('node:fs');",
          `const p = ${JSON.stringify(gateCountPath)};`,
          "fs.writeFileSync(p, String((fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0) + 1));",
        ].join(' '))}`,
      },
    }));
    execFileSync('git', ['add', 'package.json'], { cwd: cacheBound.cwd });
    execFileSync('git', ['commit', '-qm', 'cache-bound deterministic gate'], { cwd: cacheBound.cwd });
    assert.equal(await runCitadel(cacheBound.sessionDir), 'success');
    assert.equal(fs.readFileSync(gateCountPath, 'utf8'), '1');
    assert.equal(await runCitadel(cacheBound.sessionDir), 'success');
    assert.equal(fs.readFileSync(gateCountPath, 'utf8'), '1', 'completed bound journal should permit reuse');
    new StateManager().update(path.join(cacheBound.sessionDir, 'state.json'), (current) => {
      current.worker_timeout_seconds = 901;
      return current;
    });
    assert.equal(await runCitadel(cacheBound.sessionDir), 'success');
    assert.equal(fs.readFileSync(gateCountPath, 'utf8'), '2', 'timeout policy drift must invalidate reuse');
    const deterministicJournalPath = path.join(
      cacheBound.sessionDir, 'citadel-deterministic-check-journal.json',
    );
    const interruptedJournal = JSON.parse(fs.readFileSync(deterministicJournalPath, 'utf8'));
    interruptedJournal.status = 'running';
    fs.writeFileSync(deterministicJournalPath, JSON.stringify(interruptedJournal));
    assert.equal(await runCitadel(cacheBound.sessionDir), 'success');
    assert.equal(fs.readFileSync(gateCountPath, 'utf8'), '3', 'crash journal must never cache-pass');

    const invalid = makeCitadelLifecycleSession('invalid evidence');
    fs.writeFileSync(path.join(invalid.sessionDir, 'refinement_manifest.json'), JSON.stringify({
      tickets: [{ acceptance_criteria: ['invalid evidence', `Long criterion ${'x   '.repeat(600)}`] }],
    }));
    await assert.rejects(() => runCitadel(invalid.sessionDir), (error) => {
      assert.equal(error.code, 'CITADEL_REVIEWER_ARTIFACT_INVALID');
      assert.match(error.message, /coverage is incomplete/i);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(invalid.sessionDir, 'citadel-review-count'), 'utf8'), '2');
    const invalidState = JSON.parse(fs.readFileSync(
      path.join(invalid.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    assert.equal(invalidState.attempts[1].retry_feedback.length, 1_000);
    assert.doesNotMatch(invalidState.attempts[1].retry_feedback, /\s{2,}/);
    assert.notEqual(invalidState.attempts[0].strategy_hash, invalidState.attempts[1].strategy_hash);

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

    const catalog = makeCitadelLifecycleSession('catalog exhaustion remains malformed');
    for (let epoch = 1; epoch <= 5; epoch += 1) {
      await assert.rejects(() => runCitadel(catalog.sessionDir), /findings must be an array/i);
      const catalogState = JSON.parse(fs.readFileSync(
        path.join(catalog.sessionDir, 'citadel-review-state.json'), 'utf8',
      ));
      assert.equal(catalogState.recovery_epoch, epoch);
      assert.equal(catalogState.status, 'exhausted');
    }
    assert.equal(fs.readFileSync(path.join(catalog.sessionDir, 'citadel-review-count'), 'utf8'), '10');
    assert.equal(await runCitadel(catalog.sessionDir), 'citadel-system-blocked');
    assert.equal(fs.readFileSync(path.join(catalog.sessionDir, 'citadel-review-count'), 'utf8'), '10');
    const catalogState = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    assert.equal(catalogState.status, 'diagnostic_scheduled');
    assert.equal(catalogState.attempts.length, 10);
    assert.equal(new Set(catalogState.attempts.map((entry) => entry.strategy_id)).size, 5);
    assert.equal(new Set(catalogState.attempts.map((entry) => entry.material_strategy_hash)).size, 5);
    assert.equal(new Set(catalogState.attempts.map((entry) => entry.strategy_hash)).size, 6);
    assert.equal(catalogState.attempts[0].retry_feedback, null);
    assert.match(catalogState.attempts[1].retry_feedback, /findings must be an array/i);
    assert.notEqual(catalogState.attempts[0].strategy_hash, catalogState.attempts[1].strategy_hash);
    for (const epoch of [2, 3, 4, 5]) {
      const attempts = catalogState.attempts.filter((entry) => entry.epoch === epoch);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].retry_feedback, attempts[1].retry_feedback);
      assert.equal(attempts[0].strategy_hash, attempts[1].strategy_hash);
      assert.notEqual(attempts[0].material_strategy_hash, catalogState.attempts[0].material_strategy_hash);
    }
    const catalogTelemetry = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'execution-telemetry.json'), 'utf8',
    )).events.filter((event) => event.phase === 'citadel');
    assert.deepEqual(
      catalogTelemetry.map((event) => event.strategy_hash),
      catalogState.attempts.map((entry) => entry.strategy_hash),
    );
    const catalogBlock = readCitadelSystemBlock(catalog.sessionDir);
    assert.equal(catalogBlock.code, 'reviewer_artifact_strategy_exhausted');
    assert.equal(catalogBlock.recovery_action, 'repair_reviewer_artifact_contract');
    assert.equal(catalogBlock.next_action, 'retry_phase');
    assert.match(catalogBlock.evidence, /all bounded reviewer artifact strategies are exhausted/i);
    assert.match(catalogBlock.evidence, /findings must be an array/i);
    assert.equal(catalogBlock.checks.some((check) => check.status === 'passed'), true);
    const priorMaterialHashes = new Set(catalogState.attempts.map((attempt) => attempt.material_strategy_hash));
    const failedCandidateHashes = catalogState.attempts.map((attempt) => attempt.candidate_hash);
    assert.equal(failedCandidateHashes.every((candidateHash) => /^[a-f0-9]{64}$/.test(candidateHash)), true);
    const diagnosticPath = path.join(catalog.sessionDir, 'citadel-reviewer-artifact-contract-diagnostic.json');
    fs.writeFileSync(diagnosticPath, JSON.stringify({ mechanism: 'schema_scaffold_replay' }));
    const runtimeDir = path.join(
      catalog.sessionDir, 'citadel-reviewer-contract-runtime', 'd'.repeat(64),
    );
    fs.mkdirSync(runtimeDir, { recursive: true });
    const scaffoldPath = path.join(runtimeDir, 'citadel-report-scaffold.json');
    const validatorPath = path.join(runtimeDir, 'validate-citadel-candidate.mjs');
    const manifestPath = path.join(runtimeDir, 'runtime-manifest.json');
    const expectedCriteria = deriveCitadelAcceptanceCriteria(catalog.sessionDir);
    fs.writeFileSync(scaffoldPath, JSON.stringify({
      schema_version: 1,
      verdict: '<approve-or-block>',
      reviewed_range: catalogBlock.reviewed_range,
      acceptance_criteria_checked: expectedCriteria,
      findings: [],
      generated_at: '<ISO-8601 timestamp>',
    }));
    fs.writeFileSync(validatorPath, [
      "import fs from 'node:fs';",
      `const expectedRange = ${JSON.stringify(catalogBlock.reviewed_range)};`,
      `const expectedCriteria = ${JSON.stringify(expectedCriteria)};`,
      "const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
      "if (value.reviewed_range !== expectedRange) throw new Error('reviewed range drift');",
      "if (JSON.stringify(value.acceptance_criteria_checked) !== JSON.stringify(expectedCriteria)) throw new Error('criteria drift');",
      "if (!Array.isArray(value.findings)) throw new Error('findings must be an array');",
    ].join('\n'));
    const digest = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema_version: 1,
      mechanism: 'schema_scaffold_replay',
      diagnostic_identity: 'd'.repeat(64),
      scaffold: { path: scaffoldPath, sha256: digest(scaffoldPath) },
      evidence_bundle: null,
      validator: { path: validatorPath, sha256: digest(validatorPath) },
    }));
    catalogState.recovery_epoch += 1;
    catalogState.strategy_id = 'artifact-contract-reconstruction';
    catalogState.status = 'running';
    catalogState.artifact_contract_recovery = {
      schema_version: 1,
      status: 'resolved',
      diagnostic_identity: 'd'.repeat(64),
      artifact_path: diagnosticPath,
      instruction: 'Construct the canonical report from a strict schema scaffold before serializing findings.',
      resolved_at: new Date().toISOString(),
      mechanism: 'schema_scaffold_replay',
      failed_candidate_hashes: failedCandidateHashes,
      validator_invariants: ['findings is an array', 'acceptance criteria exactly match the sealed contract'],
      mechanism_history: ['schema_scaffold_replay'],
      runtime_artifacts: {
        schema_version: 1,
        mechanism: 'schema_scaffold_replay',
        scaffold_path: scaffoldPath,
        evidence_bundle_path: null,
        manifest_path: manifestPath,
        validator_path: validatorPath,
        validator_command: `node ${JSON.stringify(validatorPath)} <candidate-path>`,
      },
    };
    fs.writeFileSync(path.join(catalog.sessionDir, 'citadel-review-state.json'), JSON.stringify(catalogState));
    assert.equal(await runCitadel(catalog.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(catalog.sessionDir, 'citadel-review-count'), 'utf8'), '11');
    const reconstructedState = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    assert.equal(reconstructedState.status, 'accepted');
    assert.equal(reconstructedState.attempts.length, 11);
    assert.equal(reconstructedState.attempts.at(-1).strategy_id, 'artifact-contract-reconstruction');
    assert.equal(priorMaterialHashes.has(reconstructedState.attempts.at(-1).material_strategy_hash), false);
    const reconstructedAttempt = reconstructedState.attempts.at(-1);
    assert.equal(reconstructedAttempt.recovery_mechanism, 'schema_scaffold_replay');
    const attemptRuntimeDir = path.join(path.dirname(reconstructedAttempt.candidate_path), 'artifact-contract-runtime');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(attemptRuntimeDir, 'citadel-report-scaffold.json'), 'utf8')),
      JSON.parse(fs.readFileSync(scaffoldPath, 'utf8')),
    );
    const validatorEvidence = JSON.parse(fs.readFileSync(reconstructedAttempt.validator_evidence_path, 'utf8'));
    assert.equal(validatorEvidence.exit_code, 0);
    assert.equal(validatorEvidence.mechanism, 'schema_scaffold_replay');
    assert.equal(validatorEvidence.candidate_hash, reconstructedAttempt.candidate_hash);
    const attempt11Prompt = fs.readFileSync(path.join(catalog.sessionDir, 'citadel-recovery-prompt-11.txt'), 'utf8');
    assert.match(attempt11Prompt, /Closed reviewer execution mechanism: schema_scaffold_replay/);
    assert.match(attempt11Prompt, /candidate path is preseeded.*canonical exact-range\/exact-criteria scaffold/i);
    assert.match(attempt11Prompt, /Deterministic validator invocation: node/);
    assert.match(attempt11Prompt, /persists deterministic validator evidence/);
    assert.doesNotMatch(attempt11Prompt, /Construct the canonical report from a strict schema scaffold before serializing findings/);

    const evidenceDiagnosticIdentity = 'e'.repeat(64);
    const evidenceRuntimeDir = path.join(
      catalog.sessionDir, 'citadel-reviewer-contract-runtime', evidenceDiagnosticIdentity,
    );
    fs.mkdirSync(evidenceRuntimeDir, { recursive: true });
    const evidenceBundlePath = path.join(evidenceRuntimeDir, 'evidence-bundle.json');
    const evidenceValidatorPath = path.join(evidenceRuntimeDir, 'validate-citadel-candidate.mjs');
    const evidenceManifestPath = path.join(evidenceRuntimeDir, 'runtime-manifest.json');
    fs.writeFileSync(evidenceBundlePath, JSON.stringify({
      schema_version: 1,
      review_identity: reconstructedState.review_identity,
      diagnostic_identity: evidenceDiagnosticIdentity,
      reviewed_range: catalogBlock.reviewed_range,
      acceptance_criteria: expectedCriteria,
      deterministic_checks: catalogBlock.checks,
      failed_candidate_hashes: failedCandidateHashes,
      validation_failures: reconstructedState.attempts.map((attempt) => ({
        ordinal: attempt.ordinal,
        candidate_hash: attempt.candidate_hash || null,
        validation_error: attempt.validation_error || null,
      })),
      validator_invariants: ['findings is an array', 'acceptance criteria exactly match the sealed contract'],
    }));
    fs.copyFileSync(validatorPath, evidenceValidatorPath);
    fs.writeFileSync(evidenceManifestPath, JSON.stringify({
      schema_version: 1,
      mechanism: 'evidence_bundle_reconstruction',
      diagnostic_identity: evidenceDiagnosticIdentity,
      scaffold: null,
      evidence_bundle: { path: evidenceBundlePath, sha256: digest(evidenceBundlePath) },
      validator: { path: evidenceValidatorPath, sha256: digest(evidenceValidatorPath) },
    }));
    reconstructedState.recovery_epoch += 1;
    reconstructedState.status = 'running';
    reconstructedState.attempts.at(-1).status = 'accepted';
    reconstructedState.artifact_contract_recovery = {
      schema_version: 1,
      status: 'resolved',
      diagnostic_identity: evidenceDiagnosticIdentity,
      artifact_path: diagnosticPath,
      instruction: 'Free-form prose must not establish this recovery mechanism.',
      resolved_at: new Date().toISOString(),
      mechanism: 'evidence_bundle_reconstruction',
      failed_candidate_hashes: failedCandidateHashes,
      validator_invariants: ['findings is an array', 'acceptance criteria exactly match the sealed contract'],
      mechanism_history: ['schema_scaffold_replay', 'evidence_bundle_reconstruction'],
      runtime_artifacts: {
        schema_version: 1,
        mechanism: 'evidence_bundle_reconstruction',
        scaffold_path: null,
        evidence_bundle_path: evidenceBundlePath,
        manifest_path: evidenceManifestPath,
        validator_path: evidenceValidatorPath,
        validator_command: `node ${JSON.stringify(evidenceValidatorPath)} <candidate-path>`,
      },
    };
    fs.rmSync(path.join(catalog.sessionDir, 'citadel-report.json'), { force: true });
    fs.writeFileSync(path.join(catalog.sessionDir, 'citadel-review-state.json'), JSON.stringify(reconstructedState));
    assert.equal(await runCitadel(catalog.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(catalog.sessionDir, 'citadel-review-count'), 'utf8'), '12');
    const bundleState = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    const bundleAttempt = bundleState.attempts.at(-1);
    assert.equal(bundleAttempt.recovery_mechanism, 'evidence_bundle_reconstruction');
    assert.notEqual(bundleAttempt.material_strategy_hash, reconstructedAttempt.material_strategy_hash);
    const bundleAttemptDir = path.join(path.dirname(bundleAttempt.candidate_path), 'artifact-contract-runtime');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(bundleAttemptDir, 'evidence-bundle.json'), 'utf8')),
      JSON.parse(fs.readFileSync(evidenceBundlePath, 'utf8')),
    );
    assert.equal(JSON.parse(fs.readFileSync(bundleAttempt.validator_evidence_path, 'utf8')).exit_code, 0);
    const attempt12Prompt = fs.readFileSync(path.join(catalog.sessionDir, 'citadel-recovery-prompt-12.txt'), 'utf8');
    assert.match(attempt12Prompt, /Closed reviewer execution mechanism: evidence_bundle_reconstruction/);
    assert.match(attempt12Prompt, /immutable deterministic evidence bundle/);
    assert.match(attempt12Prompt, /exact checks, failed-candidate hashes, validation failures, range, criteria/i);
    assert.doesNotMatch(attempt12Prompt, /Free-form prose must not establish this recovery mechanism/);

    const shardDiagnosticIdentity = 'c'.repeat(64);
    const shardPlanIdentity = 'b'.repeat(64);
    const shardRuntimeDir = path.join(
      catalog.sessionDir, 'citadel-reviewer-contract-runtime', shardDiagnosticIdentity,
    );
    fs.mkdirSync(shardRuntimeDir, { recursive: true });
    const shardBundlePath = path.join(shardRuntimeDir, 'criterion-shard-bundle.json');
    const shardValidatorPath = path.join(shardRuntimeDir, 'validate-citadel-candidate.mjs');
    const shardManifestPath = path.join(shardRuntimeDir, 'runtime-manifest.json');
    const catalogWorkingDir = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'state.json'), 'utf8',
    )).working_dir;
    const shardCheckpointHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: catalogWorkingDir, encoding: 'utf8',
    }).trim();
    let shardRepositoryPaths = execFileSync('git', ['diff', '--name-only', catalogBlock.reviewed_range], {
      cwd: catalogWorkingDir, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    if (shardRepositoryPaths.length === 0) {
      shardRepositoryPaths = execFileSync('git', ['ls-files'], {
        cwd: catalogWorkingDir, encoding: 'utf8',
      }).trim().split('\n').filter(Boolean);
    }
    const shardEvidencePath = shardRepositoryPaths[0];
    const shardEvidenceSha = digest(path.join(catalogWorkingDir, shardEvidencePath));
    const shardResults = expectedCriteria.map((criterion, index) => ({
      schema_version: 1,
      shard_id: `criterion-${index + 1}`,
      criterion,
      checkpoint_head: shardCheckpointHead,
      reviewed_range: catalogBlock.reviewed_range,
      status: 'pass',
      evidence: [`Inspected ${shardEvidencePath} at the immutable checkpoint.`],
      repository_paths: [shardEvidencePath],
      repository_evidence: [{
        path: shardEvidencePath,
        sha256: shardEvidenceSha,
        observation: `Read the exact bytes of ${shardEvidencePath} while assessing this criterion.`,
      }],
      checks_cited: [catalogBlock.checks[0].command],
      findings: [],
    }));
    const shardResultFiles = shardResults.map((result) => {
      const resultPath = path.join(shardRuntimeDir, `${result.shard_id}-result.json`);
      fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      return { shard_id: result.shard_id, path: resultPath, sha256: digest(resultPath) };
    });
    const directInstruction = 'Read the eligible changed files directly, hash their bytes, and construct the shard result from repository evidence.';
    const citationInstruction = 'Complete the runtime-provided citation scaffold only after independently checking every preseeded repository identity.';
    const diffInstruction = 'First audit the authenticated diff inventory against the repository; then perform an independent criterion decision pass and serialize only the audited result.';
    const replanInstruction = 'Use the authenticated rejection ledger to avoid every prior material approach, re-derive evidence from exact repository bytes, and produce a new independently checked result.';
    const strategyMaterialHash = (result, strategy, artifactSha256) => crypto.createHash('sha256')
      .update(JSON.stringify({
        id: strategy.id,
        route: strategy.route,
        epoch: strategy.epoch,
        instruction: strategy.instruction,
        artifact_sha256: artifactSha256,
        checkpoint_head: shardCheckpointHead,
        reviewed_range: catalogBlock.reviewed_range,
        shard_id: result.shard_id,
        criterion: result.criterion,
      })).digest('hex');
    const writeShardRuntimeJson = (fileName, value) => {
      const filePath = path.join(shardRuntimeDir, fileName);
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
      return { path: filePath, sha256: digest(filePath) };
    };
    const shardFileInventory = shardRepositoryPaths.map((repositoryPath) => ({
      path: repositoryPath,
      sha256: digest(path.join(catalogWorkingDir, repositoryPath)),
    }));
    const shardDiff = execFileSync('git', ['diff', '--binary', catalogBlock.reviewed_range], {
      cwd: catalogWorkingDir, encoding: 'utf8',
    });
    const strategyExecutions = shardResults.map((result, index) => {
      const directStrategy = {
        id: 'direct_repository_evidence', route: 'direct_review', epoch: 1, instruction: directInstruction,
      };
      if (index > 0) return {
        shard_id: result.shard_id,
        attempts: [{
          ordinal: 1,
          strategy_id: directStrategy.id,
          evidence_route: directStrategy.route,
          strategy_epoch: directStrategy.epoch,
          strategy_instruction: directStrategy.instruction,
          strategy_material_hash: strategyMaterialHash(result, directStrategy, null),
          strategy_artifact: null,
          candidate: { path: shardResultFiles[index].path, sha256: shardResultFiles[index].sha256 },
          status: 'resolved',
          error: null,
        }],
      };
      const rejectedDirect = writeShardRuntimeJson('criterion-1-rejected-direct.json', {});
      const citationArtifact = writeShardRuntimeJson('criterion-1-citation-scaffold.json', {
        schema_version: 1,
        artifact_kind: 'criterion_citation_scaffold',
        shard_id: result.shard_id,
        criterion: result.criterion,
        checkpoint_head: shardCheckpointHead,
        reviewed_range: catalogBlock.reviewed_range,
        eligible_repository_evidence: shardFileInventory,
        eligible_checks: catalogBlock.checks.map((check) => check.command),
        required_observation: '<concrete observation from exact file bytes>',
      });
      const rejectedCitation = writeShardRuntimeJson('criterion-1-rejected-citation.json', {});
      const diffArtifact = writeShardRuntimeJson('criterion-1-diff-inventory.json', {
        schema_version: 1,
        artifact_kind: 'authenticated_diff_inventory',
        shard_id: result.shard_id,
        checkpoint_head: shardCheckpointHead,
        reviewed_range: catalogBlock.reviewed_range,
        diff_sha256: crypto.createHash('sha256').update(shardDiff).digest('hex'),
        files: shardFileInventory,
        deterministic_checks: catalogBlock.checks.map((check) => check.command),
      });
      const rejectedDiff = writeShardRuntimeJson('criterion-1-rejected-diff.json', {});
      const citationStrategy = {
        id: 'runtime_citation_scaffold', route: 'preseeded_citation', epoch: 1,
        instruction: citationInstruction,
      };
      const diffStrategy = {
        id: 'authenticated_diff_inventory_two_pass', route: 'diff_inventory', epoch: 1,
        instruction: diffInstruction,
      };
      const directMaterialHash = strategyMaterialHash(result, directStrategy, null);
      const citationMaterialHash = strategyMaterialHash(result, citationStrategy, citationArtifact.sha256);
      const diffMaterialHash = strategyMaterialHash(result, diffStrategy, diffArtifact.sha256);
      const replanStrategy = {
        id: 'failure_bound_evidence_replan', route: 'replanned_evidence_inventory', epoch: 1,
        instruction: replanInstruction,
      };
      const replanArtifact = writeShardRuntimeJson('criterion-1-evidence-replan.json', {
        schema_version: 1,
        artifact_kind: 'criterion_evidence_replan',
        shard_id: result.shard_id,
        checkpoint_head: shardCheckpointHead,
        reviewed_range: catalogBlock.reviewed_range,
        evidence_inventory: shardFileInventory,
        deterministic_checks: catalogBlock.checks.map((check) => check.command),
        rejected_candidates: [
          {
            ordinal: 1,
            strategy_id: directStrategy.id,
            material_hash: directMaterialHash,
            candidate_sha256: rejectedDirect.sha256,
            error: 'generic direct result rejected',
          },
          {
            ordinal: 2,
            strategy_id: citationStrategy.id,
            material_hash: citationMaterialHash,
            candidate_sha256: rejectedCitation.sha256,
            error: 'generic scaffold result rejected',
          },
          {
            ordinal: 3,
            strategy_id: diffStrategy.id,
            material_hash: diffMaterialHash,
            candidate_sha256: rejectedDiff.sha256,
            error: 'generic diff result rejected',
          },
        ],
        replan_epoch: 1,
      });
      return {
        shard_id: result.shard_id,
        attempts: [
          {
            ordinal: 1,
            strategy_id: directStrategy.id,
            evidence_route: directStrategy.route,
            strategy_epoch: directStrategy.epoch,
            strategy_instruction: directStrategy.instruction,
            strategy_material_hash: directMaterialHash,
            strategy_artifact: null,
            candidate: rejectedDirect,
            status: 'rejected',
            error: 'generic direct result rejected',
          },
          {
            ordinal: 2,
            strategy_id: citationStrategy.id,
            evidence_route: citationStrategy.route,
            strategy_epoch: citationStrategy.epoch,
            strategy_instruction: citationStrategy.instruction,
            strategy_material_hash: citationMaterialHash,
            strategy_artifact: citationArtifact,
            candidate: rejectedCitation,
            status: 'rejected',
            error: 'generic scaffold result rejected',
          },
          {
            ordinal: 3,
            strategy_id: diffStrategy.id,
            evidence_route: diffStrategy.route,
            strategy_epoch: diffStrategy.epoch,
            strategy_instruction: diffStrategy.instruction,
            strategy_material_hash: diffMaterialHash,
            strategy_artifact: diffArtifact,
            candidate: rejectedDiff,
            status: 'rejected',
            error: 'generic diff result rejected',
          },
          {
            ordinal: 4,
            strategy_id: replanStrategy.id,
            evidence_route: replanStrategy.route,
            strategy_epoch: replanStrategy.epoch,
            strategy_instruction: replanStrategy.instruction,
            strategy_material_hash: strategyMaterialHash(result, replanStrategy, replanArtifact.sha256),
            strategy_artifact: replanArtifact,
            candidate: { path: shardResultFiles[index].path, sha256: shardResultFiles[index].sha256 },
            status: 'resolved',
            error: null,
          },
        ],
      };
    });
    fs.writeFileSync(shardBundlePath, JSON.stringify({
      schema_version: 1,
      review_identity: bundleState.review_identity,
      diagnostic_identity: shardDiagnosticIdentity,
      shard_plan_identity: shardPlanIdentity,
      bounded_strategy_limit: 3,
      replan_after_attempt: 3,
      checkpoint_head: shardCheckpointHead,
      reviewed_range: catalogBlock.reviewed_range,
      repository_paths: shardRepositoryPaths,
      acceptance_criteria: expectedCriteria,
      deterministic_checks: catalogBlock.checks,
      failed_candidate_hashes: failedCandidateHashes,
      validator_invariants: ['findings is an array', 'acceptance criteria exactly match the sealed contract'],
      result_files: shardResultFiles,
      strategy_executions: strategyExecutions,
      results: shardResults,
    }));
    fs.copyFileSync(validatorPath, shardValidatorPath);
    fs.writeFileSync(shardManifestPath, JSON.stringify({
      schema_version: 1,
      mechanism: 'criterion_sharded_reconstruction',
      diagnostic_identity: shardDiagnosticIdentity,
      scaffold: null,
      evidence_bundle: null,
      criterion_shards: {
        path: shardBundlePath,
        sha256: digest(shardBundlePath),
        shard_plan_identity: shardPlanIdentity,
      },
      validator: { path: shardValidatorPath, sha256: digest(shardValidatorPath) },
    }));
    bundleState.recovery_epoch += 1;
    bundleState.status = 'running';
    bundleState.artifact_contract_recovery = {
      schema_version: 1,
      status: 'resolved',
      diagnostic_identity: shardDiagnosticIdentity,
      artifact_path: diagnosticPath,
      instruction: 'This prose cannot substitute for executed criterion shard work.',
      resolved_at: new Date().toISOString(),
      mechanism: 'criterion_sharded_reconstruction',
      failed_candidate_hashes: failedCandidateHashes,
      validator_invariants: ['findings is an array', 'acceptance criteria exactly match the sealed contract'],
      mechanism_history: [
        'schema_scaffold_replay', 'evidence_bundle_reconstruction', 'criterion_sharded_reconstruction',
      ],
      runtime_artifacts: {
        schema_version: 1,
        mechanism: 'criterion_sharded_reconstruction',
        scaffold_path: null,
        evidence_bundle_path: null,
        criterion_shard_bundle_path: shardBundlePath,
        manifest_path: shardManifestPath,
        validator_path: shardValidatorPath,
        validator_command: `node ${JSON.stringify(shardValidatorPath)} <candidate-path>`,
      },
    };
    fs.rmSync(path.join(catalog.sessionDir, 'citadel-report.json'), { force: true });
    fs.writeFileSync(path.join(catalog.sessionDir, 'citadel-review-state.json'), JSON.stringify(bundleState));
    assert.equal(await runCitadel(catalog.sessionDir), 'success');
    assert.equal(fs.readFileSync(path.join(catalog.sessionDir, 'citadel-review-count'), 'utf8'), '13');
    const shardState = JSON.parse(fs.readFileSync(
      path.join(catalog.sessionDir, 'citadel-review-state.json'), 'utf8',
    ));
    const shardAttempt = shardState.attempts.at(-1);
    assert.equal(shardAttempt.recovery_mechanism, 'criterion_sharded_reconstruction');
    assert.notEqual(shardAttempt.material_strategy_hash, bundleAttempt.material_strategy_hash);
    const shardAttemptDir = path.join(path.dirname(shardAttempt.candidate_path), 'artifact-contract-runtime');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(shardAttemptDir, 'criterion-shard-bundle.json'), 'utf8')),
      JSON.parse(fs.readFileSync(shardBundlePath, 'utf8')),
    );
    assert.equal(JSON.parse(fs.readFileSync(shardAttempt.validator_evidence_path, 'utf8')).exit_code, 0);
    const attempt13Prompt = fs.readFileSync(path.join(catalog.sessionDir, 'citadel-recovery-prompt-13.txt'), 'utf8');
    assert.match(attempt13Prompt, /Closed reviewer execution mechanism: criterion_sharded_reconstruction/);
    assert.match(attempt13Prompt, /independently reviewed typed criterion shards/);
    assert.match(attempt13Prompt, /Cover every exact acceptance criterion once/);
    assert.doesNotMatch(attempt13Prompt, /This prose cannot substitute for executed criterion shard work/);

    const resetShardValidationState = (epochOffset) => {
      const retryState = structuredClone(shardState);
      retryState.recovery_epoch += epochOffset;
      retryState.status = 'running';
      fs.rmSync(path.join(catalog.sessionDir, 'citadel-report.json'), { force: true });
      fs.writeFileSync(
        path.join(catalog.sessionDir, 'citadel-review-state.json'),
        JSON.stringify(retryState),
      );
    };
    const citationArtifactBytes = fs.readFileSync(
      strategyExecutions[0].attempts[1].strategy_artifact.path,
    );
    const rejectedCandidatePath = strategyExecutions[0].attempts[0].candidate.path;
    const rejectedCandidateBytes = fs.readFileSync(rejectedCandidatePath);
    fs.appendFileSync(rejectedCandidatePath, '\nmutated after rejection\n');
    resetShardValidationState(1);
    await assert.rejects(
      () => runCitadel(catalog.sessionDir),
      /criterion shard bundle|strategy|candidate/i,
    );
    fs.writeFileSync(rejectedCandidatePath, rejectedCandidateBytes);

    fs.appendFileSync(strategyExecutions[0].attempts[1].strategy_artifact.path, '\ntampered\n');
    resetShardValidationState(2);
    await assert.rejects(
      () => runCitadel(catalog.sessionDir),
      /criterion shard bundle|runtime manifest|strategy artifact/i,
    );
    fs.writeFileSync(strategyExecutions[0].attempts[1].strategy_artifact.path, citationArtifactBytes);

    const historyTamperBundle = JSON.parse(fs.readFileSync(shardBundlePath, 'utf8'));
    historyTamperBundle.strategy_executions[0].attempts[1].evidence_route = 'direct_review';
    fs.writeFileSync(shardBundlePath, JSON.stringify(historyTamperBundle));
    const historyTamperManifest = JSON.parse(fs.readFileSync(shardManifestPath, 'utf8'));
    historyTamperManifest.criterion_shards.sha256 = digest(shardBundlePath);
    fs.writeFileSync(shardManifestPath, JSON.stringify(historyTamperManifest));
    resetShardValidationState(3);
    await assert.rejects(
      () => runCitadel(catalog.sessionDir),
      /criterion shard bundle|strategy/i,
    );

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
    assert.deepEqual(
      validateCitadelReport(
        blockedReport,
        blockedReport.reviewed_range,
        deriveCitadelAcceptanceCriteria(blocked.sessionDir),
      ),
      blockedReport,
    );
    assert.equal(blockedReport.findings[0].title, 'Release invariant is violated');
    assert.equal(fs.existsSync(citadelSystemBlockPath(blocked.sessionDir)), false);
    assert.equal(
      fs.readdirSync(blocked.sessionDir).some((name) => /^citadel-review-attempt-.*\.json$/.test(name)),
      false,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
