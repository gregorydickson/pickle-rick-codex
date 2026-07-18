// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  buildVerificationCommandScope,
  buildVerificationFailureSet,
} from '../services/pipeline-state.js';

function makeWorkspace() {
  const root = makeTempRoot('pickle-verification-scope-');
  const packageDir = path.join(root, 'packages', 'app');
  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'ignored'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@loanlight/app',
    private: true,
  });
  return { root, packageDir };
}

test('node:test command scopes preserve quoted and escaped explicit targets', () => {
  const cwd = makeTempRoot('pickle-node-scope-');
  const scope = buildVerificationCommandScope(
    'node --test "tests/quoted target.test.js" tests/escaped\\ target.test.js --test-name-pattern "focused test" --test-reporter spec',
    cwd,
  );

  assert.deepEqual(scope, {
    key: 'node-test:tests/quoted target.test.js|tests/escaped target.test.js',
    kind: 'node-test',
    command: 'node --test "tests/quoted target.test.js" tests/escaped\\ target.test.js --test-name-pattern "focused test" --test-reporter spec',
    targets: ['tests/quoted target.test.js', 'tests/escaped target.test.js'],
  });
  assert.equal(buildVerificationCommandScope('node --test --test-reporter=spec', cwd).kind, 'command');
});

test('package-manager scopes resolve positional, inline, and pnpm workspace roots', () => {
  const { root, packageDir } = makeWorkspace();
  const expectedTarget = 'packages/app/tests/unit.test.js';

  for (const command of [
    'npm --prefix packages/app test -- tests/unit.test.js --watch',
    'yarn --cwd=packages/app test -- tests/unit.test.js',
    'bun --dir packages/app test -- tests/unit.test.js',
    'pnpm --filter @loanlight/app test -- tests/unit.test.js',
    'pnpm -F=@loanlight/app test -- tests/unit.test.js',
    'pnpm --filter ...@loanlight/app... test -- tests/unit.test.js',
    'pnpm --filter ./packages/app test -- tests/unit.test.js',
  ]) {
    const scope = buildVerificationCommandScope(command, root);
    assert.equal(scope.kind, 'package-test', command);
    assert.deepEqual(scope.targets, [expectedTarget], command);
  }

  const absoluteTarget = path.join(packageDir, 'tests', 'absolute.test.js');
  assert.deepEqual(
    buildVerificationCommandScope(`npm test -- ${absoluteTarget} && --ignored`, root).targets,
    ['packages/app/tests/absolute.test.js'],
  );
  assert.equal(buildVerificationCommandScope('npm test tests/unit.test.js', root).kind, 'command');
  assert.equal(buildVerificationCommandScope('pnpm --filter missing test -- tests/unit.test.js', root).targets[0], 'tests/unit.test.js');
});

test('rewritten Vitest scopes ignore option values and retain only test targets', () => {
  const { root } = makeWorkspace();
  const command = 'cd packages/app && node_modules/vitest/vitest.mjs run --config vitest.config.mjs --reporter verbose tests/one.test.ts --watch tests/two.test.ts';
  const scope = buildVerificationCommandScope(command, root);

  assert.deepEqual(scope, {
    key: 'package-test:packages/app/tests/one.test.ts|packages/app/tests/two.test.ts',
    kind: 'package-test',
    command,
    targets: ['packages/app/tests/one.test.ts', 'packages/app/tests/two.test.ts'],
  });
  assert.equal(buildVerificationCommandScope('cd packages/app && node test.js', root).kind, 'command');
  assert.equal(buildVerificationCommandScope('cd packages/app && vitest --config config.mjs', root).kind, 'command');
});

test('node:test failure extraction normalizes scope, defaults fields, and removes duplicates', () => {
  const cwd = makeTempRoot('pickle-node-failures-');
  const command = 'node --test tests/scoped.test.js';
  const stdout = [
    'failing tests:',
    'test at tests/scoped.test.js:3:1',
    '✖ scoped failure (1.25ms)',
    'test at tests/scoped.test.js:8:1',
    '✖ scoped failure (2ms)',
    'test at tests/unrelated.test.js:4:1',
    '✖ unrelated failure',
  ].join('\n');

  assert.deepEqual(buildVerificationFailureSet({ command, cwd, stdout, exitCode: 1 }), [
    {
      identity: 'tests/scoped.test.js::scoped failure',
      file: 'tests/scoped.test.js',
      testName: 'scoped failure',
      in_scope: true,
      source: 'node-test',
    },
    {
      identity: 'tests/unrelated.test.js::unrelated failure',
      file: 'tests/unrelated.test.js',
      testName: 'unrelated failure',
      in_scope: false,
      source: 'node-test',
    },
  ]);
  assert.deepEqual(buildVerificationFailureSet({ command, exitCode: 0 }), []);
});

test('Vitest failure extraction strips ANSI and resolves rewritten command paths', () => {
  const { root } = makeWorkspace();
  const command = 'cd packages/app && node_modules/vitest/vitest.mjs run tests/scoped.test.ts';
  const stdout = [
    '\u001b[31mFAIL\u001b[0m tests/scoped.test.ts > scoped failure',
    'FAIL tests/scoped.test.ts > scoped failure',
    'FAIL tests/unrelated.test.ts > unrelated failure',
  ].join('\n');

  assert.deepEqual(buildVerificationFailureSet({ command, cwd: root, stdout, exitCode: 1 }), [
    {
      identity: 'packages/app/tests/scoped.test.ts::scoped failure',
      file: 'packages/app/tests/scoped.test.ts',
      testName: 'scoped failure',
      in_scope: true,
      source: 'vitest',
    },
    {
      identity: 'packages/app/tests/unrelated.test.ts::unrelated failure',
      file: 'packages/app/tests/unrelated.test.ts',
      testName: 'unrelated failure',
      in_scope: false,
      source: 'vitest',
    },
  ]);
});

test('unstructured command failures retain a deterministic blocking identity', () => {
  const command = 'custom-check --verify';
  assert.deepEqual(buildVerificationFailureSet({
    command,
    stdout: 'no parseable failure details',
    stderr: 'command failed',
    exitCode: 2,
  }), [{
    identity: `command:${command}`,
    file: null,
    testName: null,
    in_scope: true,
    source: 'command-exit',
  }]);
});
