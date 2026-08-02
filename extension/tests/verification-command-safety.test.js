// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertTicketVerificationReady,
  normalizeVerificationCommands,
  PreflightError,
} from '../services/verification-env.js';

function writePackage(packageDir, name, testScript = 'vitest watch --config vitest.config.mjs') {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify({
    name,
    scripts: { test: testScript },
  }, null, 2)}\n`);
}

test('verification preflight rejects a command whose executable is missing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-preflight-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['definitely-not-a-real-pickle-executable --version'] },
      config: null,
      cwd,
      ambientEnv: { PATH: cwd },
    }),
    (error) => error instanceof PreflightError
      && error.kind === 'preflight-missing-executable'
      && error.prerequisite === 'definitely-not-a-real-pickle-executable',
  );
});

test('verification preflight rejects unquoted glob expansion but accepts an explicitly quoted pattern', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-glob-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['/usr/bin/find src/*.ts'] },
      config: null,
      cwd,
    }),
    (error) => error instanceof PreflightError && error.kind === 'preflight-unsafe-glob',
  );
  assert.doesNotThrow(() => assertTicketVerificationReady({
    ticket: { id: 'R1', verification: ["/usr/bin/find 'src/*.ts'"] },
    config: null,
    cwd,
  }));
});

test('verification normalization quotes generated Jest pattern flags before preflight', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-pattern-'));
  const [normalized] = normalizeVerificationCommands([
    '/usr/bin/true --testPathPattern=appraisal.*evaluator',
  ]);

  assert.equal(normalized, "/usr/bin/true '--testPathPattern=appraisal.*evaluator'");
  assert.doesNotThrow(() => assertTicketVerificationReady({
    ticket: { id: 'R1', verification: [normalized] },
    config: null,
    cwd,
  }));
});

test('verification preflight checks every executable in a compound command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-compound-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['/usr/bin/true && missing-after-and'] },
      config: null,
      cwd,
      ambientEnv: { PATH: cwd },
    }),
    /preflight-missing-executable/,
  );
});

test('scoped Vitest commands normalize package-manager execution without running it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-scoped-vitest-'));
  const packageDir = path.join(cwd, "package's app");
  writePackage(packageDir, '@pickle/app');

  const cases = [
    {
      command: `npm --prefix "package's app" test -- tests/unit.test.ts --watch=false`,
      exec: "'npm' 'exec' '--'",
    },
    {
      command: `yarn --cwd "package's app" test -- tests/unit.test.ts --watch=false`,
      exec: "'yarn' 'exec'",
    },
    {
      command: `bun --dir="package's app" test -- tests/unit.test.ts --watch=false`,
      exec: "'bun' 'x'",
    },
  ];

  for (const { command, exec } of cases) {
    const [normalized] = normalizeVerificationCommands([command], { cwd });
    assert.equal(
      normalized,
      `cd '${packageDir.replace(/'/g, `'\\''`)}' && ${exec} 'vitest' 'run' '--config' 'vitest.config.mjs' 'tests/unit.test.ts' '--watch=false'`,
    );
  }
});

test('pnpm scoped Vitest normalization resolves workspace names and path selectors', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pnpm-workspace-'));
  writePackage(cwd, 'pickle-workspace', 'node --test');
  const packageDir = path.join(cwd, 'packages', 'app');
  writePackage(packageDir, '@pickle/app', 'node_modules/vitest/vitest.mjs run --config config.mjs');
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, 'node_modules', 'ignored-package'), { recursive: true });
  writePackage(path.join(cwd, 'node_modules', 'ignored-package'), '@pickle/app');

  for (const selector of ['@pickle/app', '...@pickle/app...', '{@pickle/app}', './packages/app']) {
    const [normalized] = normalizeVerificationCommands(
      [`pnpm --filter ${selector} test -- tests/scoped.test.ts`],
      { cwd },
    );
    assert.equal(
      normalized,
      `cd '${packageDir}' && 'pnpm' 'exec' 'vitest' 'run' '--config' 'config.mjs' 'tests/scoped.test.ts'`,
    );
  }
});

test('scoped normalization preserves commands when safe rewriting cannot be proven', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-vitest-passthrough-'));
  writePackage(path.join(cwd, 'non-vitest'), 'non-vitest', 'node --test');
  const invalidPackageDir = path.join(cwd, 'invalid-package');
  fs.mkdirSync(invalidPackageDir);
  fs.writeFileSync(path.join(invalidPackageDir, 'package.json'), '{not-json\n');
  const unchanged = [
    'node --test tests/unit.test.js',
    'npm --prefix non-vitest test -- tests/unit.test.js',
    'npm --prefix invalid-package test -- tests/unit.test.js',
    'pnpm --filter missing test -- tests/unit.test.js',
    'pnpm test tests/unit.test.js',
    'pnpm test -- tests/unit.test.js && echo done',
  ];

  assert.deepEqual(normalizeVerificationCommands(unchanged, { cwd }), unchanged);
  assert.deepEqual(
    normalizeVerificationCommands([], { cwd, verify: { command: 'node --test fallback.test.js' } }),
    ['node --test fallback.test.js'],
  );
});
