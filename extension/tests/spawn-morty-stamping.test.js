// @tier: integration
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
  const projectDir = makeTempRoot('pickle-stamp-project-');
  initGitRepo(projectDir);
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\n');
  runGit(projectDir, ['add', 'feature.txt']);
  runGit(projectDir, ['commit', '-m', 'base']);
  return projectDir;
}

function ticketFilePath(sessionDir) {
  return path.join(sessionDir, 'r1', 'linear_ticket_r1.md');
}

function setupSession(projectDir, env, task, ticketOverrides = {}) {
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', task], {
    env,
    cwd: projectDir,
  }).trim();
  // setup --tmux leaves the session inactive until the tmux runner flips it;
  // invoking spawn-morty directly, we activate it the way the runner would.
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.active = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Stamping ticket',
        description: 'Ticket exercising completion-commit stamping.',
        acceptance_criteria: ['The completion commit is stamped into frontmatter.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
        ...ticketOverrides,
      },
    ],
  });
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

test('VAL-STAMP-011/012: spawn-morty owns the commit — stamps a resolvable completion_commit with a Pickle-Ticket trailer', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-stamp-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: makeTempRoot(),
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'agent-change\n',
  });
  const sessionDir = setupSession(projectDir, env, 'stamp happy path');

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.notEqual(head, baseline, 'HEAD advanced past baseline');

  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Done');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.ok(completion, 'completion_commit is stamped');
  assert.equal(completion, head, 'completion_commit equals the completion commit HEAD');
  assert.ok(commitResolves(projectDir, completion), 'stamped sha resolves via git cat-file -e');

  const trailer = runGit(projectDir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)', head]);
  assert.equal(trailer, 'r1', 'completion commit carries the Pickle-Ticket trailer');

  const subject = runGit(projectDir, ['log', '-1', '--pretty=%s', head]);
  assert.equal(subject, 'pickle: r1 - Stamping ticket');
});

test('VAL-STAMP-013: a worker self-commit carrying the Pickle-Ticket trailer is trusted — its sha is stamped, no second pickle commit', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-stamp-selfcommit-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
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
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'base\\nworker-change\\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'worker: real work\\n\\nPickle-Ticket: r1'], { cwd });
}
const lastMessage = phase ? '<promise>' + phase.toUpperCase() + '_COMPLETE</promise>' : '<promise>OK</promise>';
if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, lastMessage);
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'stamp self commit');

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Done');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, head, 'stamped sha equals the worker self-commit HEAD');
  assert.ok(commitResolves(projectDir, completion), 'stamped sha resolves via git cat-file -e');

  const window = runGit(projectDir, ['rev-list', `${baseline}..HEAD`]).split('\n').filter(Boolean);
  assert.equal(window.length, 1, 'exactly one commit past baseline — no second pickle auto-commit');

  const subject = runGit(projectDir, ['log', '-1', '--pretty=%s', head]);
  assert.equal(subject, 'worker: real work', 'the trusted commit is the worker self-commit');

  const trailer = runGit(projectDir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)', head]);
  assert.equal(trailer, 'r1');
});

test('VAL-STAMP-015: a no-diff / no-commit run does not fabricate a completion_commit and never stamps the baseline sha', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-stamp-nodiff-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'stamp no diff');

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.equal(head, baseline, 'HEAD did not advance past baseline');

  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Done');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, null, 'no completion_commit fabricated');
});
