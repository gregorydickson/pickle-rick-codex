// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  evaluatePersistedTicketScope,
  auditPersistedScopeForCitadel,
  persistTicketScope,
  readFreshTicketScope,
  SCOPE_ONE_HOP_MAX,
} from '../services/scope-contract.js';
import { makeTempRoot } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoFixture(callerCount = 1) {
  const workingDir = makeTempRoot('pickle-scope-repo-');
  const sessionDir = makeTempRoot('pickle-scope-session-');
  git(workingDir, ['init']);
  git(workingDir, ['config', 'user.name', 'Pickle Rick']);
  git(workingDir, ['config', 'user.email', 'pickle@local.invalid']);
  fs.mkdirSync(path.join(workingDir, 'src'));
  fs.writeFileSync(path.join(workingDir, 'src/api.ts'), 'export function calculate(value: number): number { return value; }\n');
  for (let index = 0; index < callerCount; index += 1) {
    fs.writeFileSync(path.join(workingDir, `src/caller-${index}.ts`), `import { calculate } from './api.js';\nexport const v${index} = calculate(${index});\n`);
  }
  git(workingDir, ['add', '.']);
  git(workingDir, ['commit', '-m', 'baseline']);
  return { workingDir, sessionDir, base: git(workingDir, ['rev-parse', 'HEAD']) };
}

const ticket = { id: 'r1', allowed_paths: ['src/api.ts'] };

test('scope.json is versioned and fails closed on review-base or declaration drift', () => {
  const { workingDir, sessionDir, base } = repoFixture();
  const contract = persistTicketScope(sessionDir, ticket, 'r1', base);
  assert.equal(contract.schema_version, 1);
  assert.throws(() => readFreshTicketScope(sessionDir, ticket, 'r1', `${base}bad`), /scope-contract-stale/);
  assert.throws(() => readFreshTicketScope(sessionDir, { ...ticket, allowed_paths: ['src/other.ts'] }, 'r1', base), /scope-contract-stale/);
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), '{broken');
  assert.throws(() => readFreshTicketScope(sessionDir, ticket, 'r1', base), /scope-contract-stale/);
  assert.ok(workingDir);
});

test('changed exported signature expands scope by one hop to a tracked caller', () => {
  const { workingDir, sessionDir, base } = repoFixture();
  persistTicketScope(sessionDir, ticket, 'r1', base);
  fs.writeFileSync(path.join(workingDir, 'src/api.ts'), 'export function calculate(value: number, scale = 1): number { return value * scale; }\n');
  fs.writeFileSync(path.join(workingDir, 'src/caller-0.ts'), `import { calculate } from './api.js';\nexport const v0 = calculate(0, 2);\n`);
  const verdict = evaluatePersistedTicketScope(sessionDir, ticket, 'r1', base, workingDir, ['src/api.ts', 'src/caller-0.ts']);
  assert.equal(verdict.ok, true);
  assert.deepEqual(readFreshTicketScope(sessionDir, ticket, 'r1', base).expanded_paths, ['src/caller-0.ts']);
});

test('signature caller gaps beyond the bounded one-hop cap block execution', () => {
  const { workingDir, sessionDir, base } = repoFixture(SCOPE_ONE_HOP_MAX + 1);
  persistTicketScope(sessionDir, ticket, 'r1', base);
  fs.writeFileSync(path.join(workingDir, 'src/api.ts'), 'export function calculate(value: number, scale = 1): number { return value * scale; }\n');
  const verdict = evaluatePersistedTicketScope(sessionDir, ticket, 'r1', base, workingDir, ['src/api.ts']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /signature-caller-gap/);
  assert.equal(verdict.violations.length, SCOPE_ONE_HOP_MAX + 1);
});

test('Citadel audits persisted scope identity and reachable shared review base', () => {
  const { workingDir, sessionDir, base } = repoFixture();
  persistTicketScope(sessionDir, ticket, 'r1', base);
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({ tickets: [ticket] }));
  assert.equal(auditPersistedScopeForCitadel(sessionDir, workingDir), null);
  const scopePath = path.join(sessionDir, 'scope.json');
  const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
  scope.ticket_id = 'missing-ticket';
  fs.writeFileSync(scopePath, JSON.stringify(scope));
  assert.match(auditPersistedScopeForCitadel(sessionDir, workingDir), /identity is malformed/);
});
