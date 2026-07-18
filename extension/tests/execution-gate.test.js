// @tier: fast
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  captureQualityBaseline,
  assertQualityBaselineFresh,
  captureWorkspaceSnapshot,
  changedPathsSinceSnapshot,
  discoverQualityCommands,
  evaluateTicketScope,
  evaluateWorkerQualityGate,
  resolveTicketScope,
  runQualityCommand,
  persistFreshQualityBaseline,
  QualityBaselineError,
} from '../services/execution-gate.js';
import { createInitialState } from '../services/session.js';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-execution-gate-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'owned.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'foreign.js'), 'export const foreign = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('portable quality gate discovers declared standard scripts only', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'node -e ""', lint: 'node -e ""', custom: 'node -e ""' },
  }));
  assert.deepEqual(discoverQualityCommands(root), ['npm run typecheck', 'npm run lint']);
});

test('portable quality gate discovers Cargo, Go, and configured Python checks', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/demo\n');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  assert.deepEqual(discoverQualityCommands(root), ['cargo test', 'go test ./...', 'python -m pytest']);
  fs.writeFileSync(path.join(root, 'uv.lock'), 'version = 1\n');
  assert.deepEqual(discoverQualityCommands(root), ['cargo test', 'go test ./...', 'uv run pytest']);
});

test('quality baseline subtracts an identical pre-existing failure but rejects a changed failure', async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'node check.cjs' },
  }));
  fs.writeFileSync(path.join(root, 'check.cjs'), "console.error('known failure'); process.exit(1);\n");
  const baseline = await captureQualityBaseline(root, 5_000);
  assert.equal((await evaluateWorkerQualityGate(root, baseline, 5_000)).verdict, 'green');

  fs.writeFileSync(path.join(root, 'check.cjs'), "console.error('new failure'); process.exit(1);\n");
  const verdict = await evaluateWorkerQualityGate(root, baseline, 5_000);
  assert.equal(verdict.verdict, 'red');
  assert.deepEqual(verdict.failures.map((failure) => failure.command), ['npm run typecheck']);
});

test('quality gate retries one-off flakes and compares persistent failures independent of order and timestamps', async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'node check.cjs' },
  }));
  const checkPath = path.join(root, 'check.cjs');
  fs.writeFileSync(checkPath, "console.log('clean');\n");
  const cleanBaseline = await captureQualityBaseline(root, 5_000);

  fs.writeFileSync(checkPath, `
const fs = require('node:fs');
const marker = 'flake-count';
const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
fs.writeFileSync(marker, String(count + 1));
if (count === 0) { console.error('one-off failure at 2026-07-18T12:13:14Z'); process.exit(1); }
`);
  assert.equal((await evaluateWorkerQualityGate(root, cleanBaseline, 5_000)).verdict, 'green');

  fs.rmSync(path.join(root, 'flake-count'), { force: true });
  fs.writeFileSync(checkPath, `
const fs = require('node:fs');
const marker = 'flake-count';
const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
fs.writeFileSync(marker, String(count + 1));
const lines = count % 2 === 0 ? ['failure A', 'failure B'] : ['failure B', 'failure A'];
for (const line of lines) console.error(line);
console.error('time=' + (count + 1) + 'ms');
process.exit(1);
`);
  const persistentBaseline = await captureQualityBaseline(root, 5_000);
  const persistentVerdict = await evaluateWorkerQualityGate(root, persistentBaseline, 5_000);
  assert.equal(persistentVerdict.verdict, 'green');

  fs.writeFileSync(checkPath, "console.error('genuinely new persistent failure'); process.exit(1);\n");
  assert.equal((await evaluateWorkerQualityGate(root, persistentBaseline, 5_000)).verdict, 'red');
});

test('quality gate never treats two silent failed attempts as a passing flake', async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'node check.cjs' },
  }));
  const checkPath = path.join(root, 'check.cjs');
  fs.writeFileSync(checkPath, 'process.exit(0);\n');
  const cleanBaseline = await captureQualityBaseline(root, 5_000);
  fs.writeFileSync(checkPath, 'process.exit(1);\n');
  const verdict = await evaluateWorkerQualityGate(root, cleanBaseline, 5_000);
  assert.equal(verdict.verdict, 'red');
  assert.equal(verdict.failures[0]?.ok, false);
  assert.ok((verdict.failures[0]?.failure_set || []).length > 0);
});

test('quality baseline freshness reports typed missing, stale HEAD, stale contract, and write failures', async () => {
  const root = tempRepo();
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify({ scripts: { typecheck: 'node -e ""' } }));
  execFileSync('git', ['add', 'package.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'quality contract'], { cwd: root });

  assert.throws(
    () => assertQualityBaselineFresh(null, root),
    (error) => error instanceof QualityBaselineError && error.kind === 'quality-baseline-missing',
  );
  const baseline = await captureQualityBaseline(root, 5_000);
  assert.equal(assertQualityBaselineFresh(baseline, root), baseline);

  fs.writeFileSync(path.join(root, 'head.txt'), 'next\n');
  execFileSync('git', ['add', 'head.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'advance head'], { cwd: root });
  assert.throws(
    () => assertQualityBaselineFresh(baseline, root),
    (error) => error instanceof QualityBaselineError && error.kind === 'quality-baseline-stale',
  );

  const headBaseline = await captureQualityBaseline(root, 5_000);
  process.env.PICKLE_TEST_MODE = '1';
  process.env.PICKLE_TEST_QUALITY_COMMANDS = '["node -e \\"process.exit(0)\\""]';
  try {
    assert.throws(
      () => assertQualityBaselineFresh(headBaseline, root),
      (error) => error instanceof QualityBaselineError && error.kind === 'quality-baseline-stale',
    );
  } finally {
    delete process.env.PICKLE_TEST_MODE;
    delete process.env.PICKLE_TEST_QUALITY_COMMANDS;
  }

  assert.throws(
    () => persistFreshQualityBaseline(headBaseline, root, () => { throw new Error('write denied'); }, () => null),
    (error) => error instanceof QualityBaselineError && error.kind === 'quality-baseline-write-failed',
  );
});

test('quality gate pins baseline commands and rejects removed or redefined scripts', async () => {
  const root = tempRepo();
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify({
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }));
  const baseline = await captureQualityBaseline(root, 5_000);

  fs.writeFileSync(packagePath, JSON.stringify({ scripts: {} }));
  let verdict = await evaluateWorkerQualityGate(root, baseline, 5_000);
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.failures[0].output, /removed/);

  fs.writeFileSync(packagePath, JSON.stringify({
    scripts: { typecheck: 'node -e "console.log(\'replacement\')"' },
  }));
  verdict = await evaluateWorkerQualityGate(root, baseline, 5_000);
  assert.equal(verdict.verdict, 'red');
  assert.match(verdict.failures[0].output, /definition changed/);
});

test('quality gate is unavailable when the repository declares no portable checks', async () => {
  const root = tempRepo();
  const baseline = await captureQualityBaseline(root, 5_000);
  const verdict = await evaluateWorkerQualityGate(root, baseline, 5_000);
  assert.equal(verdict.verdict, 'absent');
  assert.deepEqual(verdict.failures, []);
});

test('quality gate executes checks introduced after baseline capture', async () => {
  const root = tempRepo();
  const packagePath = path.join(root, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify({
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }));
  const baseline = await captureQualityBaseline(root, 5_000);
  fs.writeFileSync(packagePath, JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(7)"',
    },
  }));
  const verdict = await evaluateWorkerQualityGate(root, baseline, 5_000);
  assert.equal(verdict.verdict, 'red');
  assert.deepEqual(verdict.failures.map((failure) => failure.command), ['npm run lint']);
});

test('quality command timeout escalates from TERM to KILL', { skip: process.platform === 'win32' }, async () => {
  const root = tempRepo();
  const started = Date.now();
  const result = await runQualityCommand(
    `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
    root,
    250,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.match(result.output, /quality gate timed out/);
  assert.ok(elapsed >= 1_000, 'TERM-ignoring command should survive until the KILL grace period');
  assert.ok(elapsed < 3_000, 'TERM-ignoring command should be killed after the grace period');
});

test('workspace snapshot subtracts unchanged pre-existing dirt and identifies ticket changes', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'foreign.js'), 'pre-existing user edit\n');
  const baseline = captureWorkspaceSnapshot(root);
  fs.writeFileSync(path.join(root, 'src', 'owned.js'), 'ticket edit\n');
  assert.deepEqual(changedPathsSinceSnapshot(root, baseline), ['src/owned.js']);
});

test('session state pins the verified start commit for later completion and Citadel ranges', () => {
  const root = tempRepo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const state = createInitialState({
    cwd: root,
    prompt: 'test',
    sessionDir: path.join(root, '.session'),
    config: { defaults: { max_iterations: 10, max_time_minutes: 10, worker_timeout_seconds: 10 } },
  });
  assert.equal(state.start_commit, head);
  assert.equal(state.pinned_sha, head);
  assert.equal(state.quality_baseline, null);
});

test('scope resolution rejects missing, traversal, and out-of-scope changes', () => {
  assert.match(resolveTicketScope({ id: 'x', title: 'x' }).error, /declares no/);
  assert.match(resolveTicketScope({ id: 'x', title: 'x', allowed_paths: ['../escape'] }).error, /invalid/);
  assert.match(resolveTicketScope({ id: 'x', title: 'x', allowed_paths: ['.'] }).error, /invalid ticket scope path/);
  assert.deepEqual(resolveTicketScope({
    id: 'x',
    title: 'x',
    allowed_paths: ['src'],
    output_artifacts: ['proof/result.json'],
  }).allowedPaths, ['proof/result.json', 'src']);

  const verdict = evaluateTicketScope(
    { id: 'x', title: 'x', allowed_paths: ['src'] },
    ['src/owned.js', 'foreign.js'],
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.violations, ['foreign.js']);
});
