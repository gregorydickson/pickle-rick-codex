// @tier: integration
// Single completion-evidence seam, observed through the spawn-morty bin.
// VAL-ORACLE-029/030/031: spawn-morty flips Done ONLY when the oracle accepts,
// stamps a resolvable completion_commit equal to the completion HEAD, refuses on
// unattributable (baseline/foreign) evidence without stamping, and never fabricates
// a completion_commit on a no-diff run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatterField, parseTicketFile } from '../services/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, writeJson, prependPath, createFakeCodex, writeExecutable } from './helpers.js';

function runGit(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir) {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Pickle Rick Tests']);
  runGit(dir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
}

function baseRepo() {
  const projectDir = makeTempRoot('pickle-oracle-project-');
  initGitRepo(projectDir);
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\n');
  runGit(projectDir, ['add', 'feature.txt']);
  runGit(projectDir, ['commit', '-m', 'base']);
  return projectDir;
}

function ticketFilePath(sessionDir) {
  return path.join(sessionDir, 'r1', 'linear_ticket_r1.md');
}

function setupSession(projectDir, env, task, tickets) {
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', task], { env, cwd: projectDir }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.active = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets });
  return sessionDir;
}

function commitResolves(dir, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const R1_TICKET = {
  id: 'R1',
  title: 'Oracle seam ticket',
  description: 'Ticket exercising completion routed through the oracle.',
  acceptance_criteria: ['Completion is decided by the oracle.'],
  verification: ['node -e "process.exit(0)"'],
  priority: 'P1',
  status: 'Todo',
};

// Fake codex that self-commits TWO commits in `implement`, the tip attributed to a
// SIBLING ticket (r2) and never to r1 — a foreign, multi-commit window (no amend).
const FOREIGN_FAKE_CODEX = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 9.9.9-test'); process.exit(0); }
if (args[0] !== 'exec') { console.error('unexpected codex invocation'); process.exit(1); }
const prompt = fs.readFileSync(0, 'utf8');
let outputLastMessagePath = '';
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--output-last-message') { outputLastMessagePath = args[index + 1] || ''; index += 1; }
}
const match = prompt.match(/You are executing the "([^"]+)" phase/);
const phase = match ? match[1] : '';
if (phase === 'implement') {
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'base\\nstep-one\\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'wip: intermediate'], { cwd });
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'base\\nstep-one\\nstep-two\\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'deliver r2 milestone'], { cwd });
}
const lastMessage = phase ? '<promise>' + phase.toUpperCase() + '_COMPLETE</promise>' : '<promise>OK</promise>';
if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, lastMessage);
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`;

test('VAL-ORACLE-029: spawn-morty flips Done only when the oracle accepts (happy path)', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-oracle-happy-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: makeTempRoot(),
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'agent-change\n',
  });
  const sessionDir = setupSession(projectDir, env, 'oracle happy path', [R1_TICKET]);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.notEqual(head, baseline, 'HEAD advanced past baseline');

  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Done', 'ticket flipped to Done on accepted evidence');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.ok(completion, 'completion_commit is stamped');
  assert.equal(completion, head, 'completion_commit equals the completion HEAD');
  assert.ok(commitResolves(projectDir, completion), 'stamped sha resolves via git cat-file -e');
});

test('VAL-ORACLE-030: spawn-morty does NOT flip Done when the oracle refuses a foreign/unattributable commit', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-oracle-foreign-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), FOREIGN_FAKE_CODEX);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle foreign refusal', [
    R1_TICKET,
    { ...R1_TICKET, id: 'R2', title: 'Sibling ticket' },
  ]);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.notEqual(head, baseline, 'the worker did commit — the tip exists');

  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.notEqual(ticket.status, 'Done', 'ticket is NOT flipped to Done on refused evidence');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, null, 'no completion_commit stamped for the foreign/unattributable tip');
  assert.notEqual(completion, head, 'the foreign tip sha is never stamped');
  assert.notEqual(completion, baseline, 'the baseline sha is never stamped');
});

test('VAL-ORACLE-031: a no-diff / no-commit run never fabricates or baseline-stamps completion_commit', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-oracle-nodiff-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle no diff', [R1_TICKET]);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.equal(head, baseline, 'HEAD did not advance past baseline');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, null, 'no completion_commit fabricated on a no-diff run');
});
