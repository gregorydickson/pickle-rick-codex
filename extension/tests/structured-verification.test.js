// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertTicketVerificationReady,
  assertVerificationStepSafe,
  normalizeVerificationSteps,
  verificationStepCommand,
  verificationStepIdentity,
  VerificationContractError,
} from '../services/verification-env.js';
import { parseTicketFile } from '../services/pickle-utils.js';
import { writeTicketFiles } from '../services/tickets.js';
import { makeTempRoot } from './helpers.js';

test('structured verification preserves argv without a shell', () => {
  const [step] = normalizeVerificationSteps([{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)', 'a; echo unsafe'] }]);
  assert.deepEqual(step, { kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)', 'a; echo unsafe'] });
  assert.deepEqual(verificationStepCommand(step), {
    executable: 'node',
    args: ['-e', 'process.exit(0)', 'a; echo unsafe'],
    shell: false,
    display: "node -e 'process.exit(0)' 'a; echo unsafe'",
  });
});

test('legacy package scripts migrate and unsafe field command is rejected before execution', () => {
  assert.deepEqual(normalizeVerificationSteps(['pnpm run test -- target.test.ts']), [{
    kind: 'package_script', manager: 'pnpm', script: 'test', args: ['target.test.ts'],
  }]);
  const fieldCommand = 'node -e "const ids=[...s.matchAll(new RegExp(`('+"'AR-'"+'+p+)`,`g`))]"';
  assert.throws(() => normalizeVerificationSteps([fieldCommand]), (error) => {
    assert.ok(error instanceof VerificationContractError);
    assert.match(error.message, /repair it into a structured/);
    return true;
  });
});

test('structured shell steps require safe balanced syntax and reject command substitution', () => {
  assert.throws(
    () => normalizeVerificationSteps([{
      kind: 'shell',
      script: 'echo `whoami`',
      justification: 'compatibility fixture',
    }]),
    /invalid structured verification step/,
  );
  assert.throws(
    () => normalizeVerificationSteps([{
      kind: 'shell',
      script: 'echo "unterminated',
      justification: 'compatibility fixture',
    }]),
    /invalid structured verification step/,
  );
  for (const script of ['echo $(whoami)', 'rm -rf build', 'git reset --hard HEAD', 'echo changed > result.txt']) {
    assert.throws(
      () => normalizeVerificationSteps([{
        kind: 'shell',
        script,
        justification: 'compatibility fixture',
      }]),
      /invalid structured verification step/,
    );
  }
  assert.deepEqual(normalizeVerificationSteps([{
    kind: 'shell',
    script: 'for file in src/*.ts; do test -f "$file"; done',
    justification: 'legacy loop cannot be represented as one process',
  }]), [{
    kind: 'shell',
    script: 'for file in src/*.ts; do test -f "$file"; done',
    justification: 'legacy loop cannot be represented as one process',
  }]);
});

test('ticket materialization reloads the exact structured verification semantics', () => {
  const sessionDir = makeTempRoot('pickle-structured-ticket-');
  const steps = [
    { kind: 'process', executable: 'node', args: ['--test', 'a b.test.js'], cwd: 'extension' },
    { kind: 'shell', script: 'git diff --check && true', justification: 'legacy compatibility' },
  ];
  const [ticketPath] = writeTicketFiles(sessionDir, { tickets: [{
    id: 'S1', title: 'Structured', description: 'roundtrip', status: 'Todo',
    acceptance_criteria: ['roundtrip'], allowed_paths: ['extension'], verification: steps,
  }] });
  const parsed = parseTicketFile(ticketPath);
  assert.ok(parsed);
  assert.equal(verificationStepIdentity(parsed.verification), verificationStepIdentity(steps));
  assert.match(fs.readFileSync(path.resolve(ticketPath), 'utf8'), /^verification: \[/m);
});

function ready(ticket, cwd, allowedRoots = []) {
  return assertTicketVerificationReady({ ticket, config: null, cwd, allowedRoots });
}

test('structured verification realpath-confines cwd to repository and session roots', () => {
  const root = makeTempRoot('pickle-verification-cwd-');
  const repo = path.join(root, 'repo');
  const session = path.join(root, 'session');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(session);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'escape-link'));
  const valid = { id: 'safe', verification: [{ kind: 'process', executable: process.execPath, args: ['--version'], cwd: session }] };
  assert.doesNotThrow(() => ready(valid, repo, [session]));
  for (const cwd of ['../outside', outside, 'escape-link']) {
    assert.throws(
      () => ready({ id: 'escape', verification: [{ kind: 'process', executable: process.execPath, args: ['--version'], cwd }] }, repo, [session]),
      /cwd is missing or escapes repository\/session roots/,
    );
  }
});

test('structured process policy rejects destructive executables, git mutations, and shell wrappers', () => {
  const repo = makeTempRoot('pickle-verification-process-');
  const forbidden = [
    { executable: '/bin/rm', args: ['-rf', '.'] },
    { executable: 'git', args: ['reset', '--hard', 'HEAD'] },
    { executable: 'git', args: ['-C', repo, 'checkout', '--', '.'] },
    { executable: 'git', args: ['clean', '-fdx'] },
    { executable: 'git', args: ['stash', 'push'] },
    { executable: '/bin/bash', args: ['-lc', 'rm -rf build'] },
    { executable: '/usr/bin/env', args: ['bash', '-c', 'git reset --hard HEAD'] },
  ];
  for (const command of forbidden) {
    assert.throws(
      () => ready({ id: 'unsafe', verification: [{ kind: 'process', ...command }] }, repo),
      /not permitted|forbidden by verification policy/,
      `${command.executable} ${command.args.join(' ')}`,
    );
  }
  assert.doesNotThrow(() => ready({
    id: 'safe',
    verification: [
      { kind: 'process', executable: process.execPath, args: ['-e', 'process.exit(0)', 'rm -rf is inert argv'] },
      { kind: 'process', executable: 'git', args: ['diff', '--check'] },
    ],
  }, repo));
});

test('package verification validates script existence and lifecycle bodies before implementation and at runtime', () => {
  const repo = makeTempRoot('pickle-verification-package-');
  const packagePath = path.join(repo, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify({ scripts: { test: 'node --version', wipe: 'rm -rf build' } }));
  const safe = { kind: 'package_script', manager: 'npm', script: 'test' };
  assert.deepEqual(ready({ id: 'safe', verification: [safe] }, repo).steps, [safe]);
  for (const step of [
    { kind: 'package_script', manager: 'npm', script: 'missing' },
    { kind: 'package_script', manager: 'npm', script: 'wipe' },
    { kind: 'process', executable: 'npm', args: ['install'] },
    { kind: 'process', executable: 'npm', args: ['--prefix', '..', 'test'] },
  ]) {
    assert.throws(() => ready({ id: 'unsafe', verification: [step] }, repo), /does not exist|forbidden|not permitted|escapes repository/);
  }
  fs.writeFileSync(packagePath, JSON.stringify({ scripts: { pretest: 'git clean -fdx', test: 'node --version' } }));
  assert.throws(() => assertVerificationStepSafe(safe, { cwd: repo }), /pretest.*forbidden/);
});

test('structured verification rejects malformed fields and control-word shell mutations', () => {
  const repo = makeTempRoot('pickle-verification-schema-');
  for (const step of [
    { kind: 'process', executable: process.execPath, args: [], cwd: 42 },
    { kind: 'process', executable: process.execPath, args: [], command: 'ignored typo' },
    { kind: 'package_script', manager: 'npm', script: 'test', shell: true },
  ]) {
    assert.throws(() => normalizeVerificationSteps([step]), /invalid structured verification step/);
  }
  assert.throws(() => normalizeVerificationSteps([{
    kind: 'shell', script: 'if true; then rm -rf build; fi', justification: 'not authority',
  }]), /invalid structured verification step/);
  assert.throws(() => ready({
    id: 'wrapped',
    verification: { steps: [{ kind: 'process', executable: 'git', args: ['clean', '-fdx'] }] },
  }, repo), /git clean is not permitted/);
});
