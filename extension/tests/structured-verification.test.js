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

test('shell verification confines cd and pushd transitions while preserving in-repo directory changes', () => {
  const root = makeTempRoot('pickle-verification-shell-cwd-');
  const repo = path.join(root, 'repo');
  const inside = path.join(repo, 'inside');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'escape-link'));
  for (const script of [
    'cd inside && node --version',
    'pushd inside && node --version && popd',
  ]) {
    assert.doesNotThrow(() => ready({
      id: 'safe-shell-cwd', verification: [{ kind: 'shell', script, justification: 'multi-command verification' }],
    }, repo));
  }
  for (const script of [
    'cd ../outside && node --version',
    `cd ${outside} && node --version`,
    'pushd escape-link && node --version',
  ]) {
    assert.throws(() => ready({
      id: 'unsafe-shell-cwd', verification: [{ kind: 'shell', script, justification: 'multi-command verification' }],
    }, repo), /escapes repository\/session roots|dynamic or implicit cwd/);
  }
  assert.throws(() => assertVerificationStepSafe({
    kind: 'shell', script: 'cd "$DYNAMIC_ROOT" && node --version', justification: 'multi-command verification',
  }, { cwd: repo }), /dynamic or implicit cwd/);
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
    { executable: '/usr/bin/env', args: ['-S', 'bash -c "rm -rf build"'] },
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

test('shell and package lifecycle policy unwraps command and env before destructive checks', () => {
  const repo = makeTempRoot('pickle-verification-shell-wrapper-');
  for (const script of [
    'command rm -rf build',
    'command -p rm -rf build',
    'env rm -rf build',
    'command git reset --hard HEAD',
    'if true; then command rm -rf build; fi',
    '{ command rm -rf build; }',
  ]) {
    assert.throws(() => ready({
      id: 'unsafe-wrapper', verification: [{ kind: 'shell', script, justification: 'legacy verification' }],
    }, repo), /invalid structured verification step|forbidden by verification policy|not permitted in verification/);
  }

  const packagePath = path.join(repo, 'package.json');
  for (const script of ['command rm -rf build', 'env git reset --hard HEAD', 'cd ../outside && node --version']) {
    fs.writeFileSync(packagePath, JSON.stringify({ scripts: { test: script } }));
    assert.throws(() => ready({
      id: 'unsafe-package-wrapper', verification: [{ kind: 'package_script', manager: 'npm', script: 'test' }],
    }, repo), /package lifecycle script test.*(?:not permitted|escapes repository\/session roots)/);
  }
  fs.writeFileSync(packagePath, JSON.stringify({ scripts: { test: 'node --version' } }));
  assert.doesNotThrow(() => ready({
    id: 'safe-command-query',
    verification: [{ kind: 'shell', script: 'command -v node', justification: 'resolve verifier' }],
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

test('package-manager cwd flags are contained regardless of placement and forwarded flags remain argv', () => {
  const root = makeTempRoot('pickle-verification-package-flags-');
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  for (const step of [
    { kind: 'process', executable: 'npm', args: ['--prefix', outside, 'run', 'test'] },
    { kind: 'process', executable: 'npm', args: ['run', '--prefix', outside, 'test'] },
    { kind: 'process', executable: 'npm', args: ['run', 'test', '--prefix', outside] },
    { kind: 'process', executable: 'pnpm', args: ['run', 'test', '--dir', outside] },
    { kind: 'process', executable: 'yarn', args: ['run', 'test', '--cwd', outside] },
  ]) {
    assert.throws(() => assertVerificationStepSafe(step, { cwd: repo }), /package verification cwd escapes/);
  }
  assert.doesNotThrow(() => assertVerificationStepSafe({
    kind: 'process', executable: 'npm', args: ['run', 'test', '--', '--prefix', '../outside'],
  }, { cwd: repo }));
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
