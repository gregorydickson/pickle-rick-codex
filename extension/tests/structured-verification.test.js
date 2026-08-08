// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeVerificationSteps, verificationStepCommand, verificationStepIdentity, VerificationContractError } from '../services/verification-env.js';
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
