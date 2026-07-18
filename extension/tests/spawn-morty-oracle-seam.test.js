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
import { makeTempRoot, repoRoot, runNode, writeJson, prependPath, createFakeCodex, writeExecutable, fakeLifecycleArtifactWriterSource } from './helpers.js';

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

function rejectedWorkerRef(sessionDir) {
  return `refs/pickle/rejected/${path.basename(sessionDir)}/r1`;
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
  allowed_paths: ['feature.txt'],
};

// Fake codex that self-commits TWO commits in `implement`, the tip attributed to a
// SIBLING ticket (r2) and never to r1 — a foreign, multi-commit window (no amend).
const FOREIGN_FAKE_CODEX = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${fakeLifecycleArtifactWriterSource()}

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
writeFakeLifecycleArtifact(prompt, phase);
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

// Fake codex that self-commits TWO commits in `implement` with NEUTRAL messages that
// name no ticket id — a multi-commit window (so resolveCompletionCommitSha does NOT
// amend a Pickle-Ticket trailer) with nothing attributable → oracle returns `no_evidence`.
const NEUTRAL_TWO_COMMIT_FAKE_CODEX = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${fakeLifecycleArtifactWriterSource()}

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
writeFakeLifecycleArtifact(prompt, phase);
if (phase === 'implement') {
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'base\\nstep-one\\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'chore: adjust feature step one'], { cwd });
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'base\\nstep-one\\nstep-two\\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@local.invalid', 'commit', '-m', 'chore: adjust feature step two'], { cwd });
}
const lastMessage = phase ? '<promise>' + phase.toUpperCase() + '_COMPLETE</promise>' : '<promise>OK</promise>';
if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, lastMessage);
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`;

// Seeds a reachable foreign commit whose message names sibling ticket r2 (never r1),
// then returns its sha. Used to pre-stamp a surviving, positively-foreign completion_commit.
function seedForeignCommit(projectDir) {
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\nsibling-work\n');
  runGit(projectDir, ['add', 'feature.txt']);
  runGit(projectDir, ['commit', '-m', 'deliver r2 milestone']);
  return runGit(projectDir, ['rev-parse', 'HEAD']);
}

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

test('VAL-ORACLE-030: a HEAD-advancing run with no attributable window fails closed', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-oracle-foreign-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), FOREIGN_FAKE_CODEX);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle foreign refusal', [
    R1_TICKET,
    { ...R1_TICKET, id: 'R2', title: 'Sibling ticket' },
  ]);

  const stdout = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });
  const result = JSON.parse(stdout.trim());

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.equal(head, baseline, 'rejected commits are rolled back to the original HEAD');
  assert.equal(runGit(projectDir, ['status', '--porcelain']), '', 'the original clean tree is restored');
  const recoveryRef = rejectedWorkerRef(sessionDir);
  const rejectedTip = runGit(projectDir, ['rev-parse', recoveryRef]);
  assert.notEqual(rejectedTip, baseline, 'the attempted commit window remains recoverable');
  assert.equal(runGit(projectDir, ['show', `${recoveryRef}:feature.txt`]), 'base\nstep-one\nstep-two');

  assert.equal(result.status, 'incomplete', 'a mutating no_evidence run fails closed');
  assert.equal(result.reason, 'no_evidence');
  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Todo');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, null, 'no completion_commit stamped for the foreign/unattributable tip');
  assert.notEqual(completion, rejectedTip, 'the foreign tip sha is never stamped');
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

test('VAL-ORACLE-035 (F1): a surviving foreign completion_commit is refused even when the run makes NO new commit', () => {
  // The no-new-commit hole: a PRE-EXISTING explicit completion_commit points at a
  // reachable-but-foreign sibling commit; the worker is a no-op so HEAD == baseline.
  // The old HEAD-advancement gate would fall through to finalizeSuccess and flip Done
  // with the foreign pointer intact. Reason-based gating refuses regardless of HEAD.
  const projectDir = baseRepo();
  const foreignSha = seedForeignCommit(projectDir);
  const fakeBin = makeTempRoot('pickle-oracle-f1-bin-');
  createFakeCodex(fakeBin); // no mutate env → the worker produces NO new commit
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle no-new-commit foreign stamp', [
    { ...R1_TICKET, completion_commit: foreignSha },
    { ...R1_TICKET, id: 'R2', title: 'Sibling ticket' },
  ]);

  const stdout = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });
  const result = JSON.parse(stdout.trim());

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.equal(head, foreignSha, 'the worker produced NO new commit (HEAD == baseline)');

  assert.equal(result.status, 'incomplete', 'a surviving foreign stamp is refused, not accepted');
  assert.equal(result.reason, 'baseline_sha', 'the session-start commit cannot prove ticket work');

  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.notEqual(ticket.status, 'Done', 'a foreign completion_commit must NOT flip Done on a no-new-commit run');
});

test('VAL-ORACLE-036 (F2): a real oracle refusal parks the ticket at Todo with a completion_refused verdict (never left In Progress)', () => {
  // Status hygiene: before this fix finalizeRefusal returned {status:'incomplete'}
  // WITHOUT writing the ticket status, leaving it at the start-of-try 'In Progress'
  // write. Under on-failure=abort the ticket then silently re-runs on resume. The
  // refusal must land a parkable Todo + failure_reason/failure_kind on disk.
  const projectDir = baseRepo();
  const foreignSha = seedForeignCommit(projectDir);
  const fakeBin = makeTempRoot('pickle-oracle-f2-bin-');
  createFakeCodex(fakeBin); // no mutate env → real (non-mocked) oracle refusal path
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle refusal status hygiene', [
    { ...R1_TICKET, completion_commit: foreignSha },
    { ...R1_TICKET, id: 'R2', title: 'Sibling ticket' },
  ]);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const ticketPath = ticketFilePath(sessionDir);
  const ticket = parseTicketFile(ticketPath);
  assert.notEqual(ticket.status, 'In Progress', 'a refused ticket is NOT left In Progress');
  assert.equal(ticket.status, 'Todo', 'a refused ticket is parked at Todo');
  assert.equal(
    readFrontmatterField(ticketPath, 'failure_kind'),
    'completion_refused',
    'the refusal verdict is recorded as failure_kind',
  );
  const failureReason = readFrontmatterField(ticketPath, 'failure_reason');
  assert.ok(failureReason, 'a non-null failure_reason is recorded');
  assert.match(String(failureReason), /completion refused by oracle: baseline_sha/, 'the reason carries the oracle verdict');
});

test('VAL-ORACLE-037: a HEAD-advancing verified run with genuinely no evidence fails closed', () => {
  const projectDir = baseRepo();
  const baseline = runGit(projectDir, ['rev-parse', 'HEAD']);
  const fakeBin = makeTempRoot('pickle-oracle-o1-bin-');
  writeExecutable(path.join(fakeBin, 'codex'), NEUTRAL_TWO_COMMIT_FAKE_CODEX);
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: makeTempRoot() });
  const sessionDir = setupSession(projectDir, env, 'oracle no-evidence no-wedge', [R1_TICKET]);

  const stdout = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });
  const result = JSON.parse(stdout.trim());

  const head = runGit(projectDir, ['rev-parse', 'HEAD']);
  assert.equal(head, baseline, 'rejected work is rolled back to the original HEAD');
  assert.equal(runGit(projectDir, ['status', '--porcelain']), '', 'the original clean tree is restored');
  const recoveryRef = rejectedWorkerRef(sessionDir);
  const rejectedTip = runGit(projectDir, ['rev-parse', recoveryRef]);
  assert.notEqual(rejectedTip, baseline, 'the verified attempted work remains recoverable');
  assert.equal(runGit(projectDir, ['show', `${recoveryRef}:feature.txt`]), 'base\nstep-one\nstep-two');

  assert.equal(result.status, 'incomplete', 'unattributable mutating work is refused');
  assert.equal(result.reason, 'no_evidence');
  const ticket = parseTicketFile(ticketFilePath(sessionDir));
  assert.equal(ticket.status, 'Todo');

  const completion = readFrontmatterField(ticketFilePath(sessionDir), 'completion_commit');
  assert.equal(completion, null, 'no completion_commit is stamped when evidence is genuinely absent');
});
