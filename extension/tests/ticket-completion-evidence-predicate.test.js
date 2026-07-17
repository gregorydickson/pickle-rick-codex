// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import {
  readEvidence,
  evaluateCompletionEvidence,
  gateForPhantomDoneRevert,
} from '../services/ticket-completion-evidence.js';
import { readFrontmatterField } from '../services/pickle-utils.js';
import { updateTicketStatus, writeTicketFiles, getTicketById } from '../services/tickets.js';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const dir = makeTempRoot('oracle-repo-');
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Pickle Rick Tests']);
  git(dir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-m', 'base']);
  return { dir, baseline: git(dir, ['rev-parse', 'HEAD']) };
}

function commit(dir, message) {
  git(dir, ['commit', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function mkSession() {
  return makeTempRoot('oracle-session-');
}

function writeTicket(sessionDir, id, fields = {}) {
  const lc = id.toLowerCase();
  const dir = path.join(sessionDir, lc);
  fs.mkdirSync(dir, { recursive: true });
  const fm = { id, title: `Ticket ${id}`, status: 'Todo', ...fields };
  const lines = Object.entries(fm)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`);
  const filePath = path.join(dir, `linear_ticket_${lc}.md`);
  fs.writeFileSync(filePath, `---\n${lines.join('\n')}\n---\n\n# Ticket ${id}\n\nBody.\n`);
  return filePath;
}

const BOGUS_A = 'a'.repeat(40);
const BOGUS_B = 'b'.repeat(40);

// --- readEvidence decision ladder ---------------------------------------

test('VAL-ORACLE-001: explicit reachable own SHA → committed via explicit', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1 feature');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'committed', sha, via: 'explicit' });
});

test('VAL-ORACLE-002: explicit-reachable-wins over a scan-attributable commit', () => {
  const { dir } = initRepo();
  const explicitSha = commit(dir, 'implement r1 core');
  commit(dir, 'more r1 follow-up work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: explicitSha });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.equal(result.via, 'explicit');
  assert.equal(result.sha, explicitSha);
});

test('VAL-ORACLE-003: explicit SHA == startCommit → hard-absent baseline_sha (even with attributable commit)', () => {
  const { dir, baseline } = initRepo();
  commit(dir, 'real r1 post-baseline work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: baseline });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir, startCommit: baseline });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'baseline_sha' });
});

test('VAL-ORACLE-004: explicit SHA == pinnedSha → hard-absent baseline_sha', () => {
  const { dir, baseline } = initRepo();
  commit(dir, 'real r1 post-baseline work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: baseline });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir, startCommit: null, pinnedSha: baseline });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'baseline_sha' });
});

test('VAL-ORACLE-005: explicit reachable but foreign-attributed → hard-absent foreign_attribution', () => {
  const { dir } = initRepo();
  const foreignSha = commit(dir, 'deliver r2 milestone');
  const sessionDir = mkSession();
  writeTicket(sessionDir, 'R2', {});
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: foreignSha });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'foreign_attribution' });
});

test('VAL-ORACLE-006: explicit UNREACHABLE → falls through to scan (R-AICF)', () => {
  const { dir } = initRepo();
  const realSha = commit(dir, 'implement r1 behavior');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: BOGUS_A });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'committed', sha: realSha, via: 'scan' });
});

test('VAL-ORACLE-007: explicit UNREACHABLE, nothing attributable → unreachable_explicit_unattributable', () => {
  const { dir } = initRepo();
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: BOGUS_A });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'unreachable_explicit_unattributable' });
});

test('VAL-ORACLE-008: no evidence at all → absent no_evidence', () => {
  const { dir } = initRepo();
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'no_evidence' });
});

test('VAL-ORACLE-009: inferred field git-verified → committed via inferred', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'some untagged work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit_inferred: sha });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'committed', sha, via: 'inferred' });
});

test('VAL-ORACLE-010: inferred field present but not git-verifiable → short-circuit absent', () => {
  const { dir } = initRepo();
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit_inferred: BOGUS_B });
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.equal(result.kind, 'absent');
});

test('VAL-ORACLE-011: git-log scan word-boundary ticket-id match → committed via scan', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'fix(r1): real work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'committed', sha, via: 'scan' });
});

test('VAL-ORACLE-012: scan requires WORD-BOUNDARY id match (substring near-miss does not attribute)', () => {
  const { dir } = initRepo();
  commit(dir, 'fix(r10): superset token only');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
  assert.deepEqual(result, { kind: 'absent', absentReason: 'no_evidence' });
});

// --- evaluateCompletionEvidence predicate --------------------------------

function attributionCtx(extra) {
  return { startCommit: null, pinnedSha: null, decision: 'attribution', rereadBackoffMs: 0, ...extra };
}

test('VAL-ORACLE-013: accepted evidence returns {ok:true, sha, via}', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.equal(decision.ok, true);
  assert.equal(decision.sha, sha);
  assert.equal(decision.via, 'explicit');
});

test('VAL-ORACLE-014: absent evidence returns {ok:false, reason}', () => {
  const { dir } = initRepo();
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.deepEqual(decision, { ok: false, reason: 'no_evidence' });
});

test('VAL-ORACLE-015: baseline refusal reason surfaces through the predicate', () => {
  const { dir, baseline } = initRepo();
  commit(dir, 'real r1 work');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: baseline });
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir, startCommit: baseline }));
  assert.deepEqual(decision, { ok: false, reason: 'baseline_sha' });
});

test('VAL-ORACLE-016: foreign-attribution refusal reason surfaces through the predicate', () => {
  const { dir } = initRepo();
  const foreignSha = commit(dir, 'deliver r2 milestone');
  const sessionDir = mkSession();
  writeTicket(sessionDir, 'R2', {});
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: foreignSha });
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.deepEqual(decision, { ok: false, reason: 'foreign_attribution' });
});

test('VAL-ORACLE-017: promote-once durably writes accepted SHA into completion_commit (scan start)', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'fix(r1): scan attributable');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), null);
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.equal(decision.ok, true);
  assert.equal(decision.via, 'scan');
  assert.equal(decision.sha, sha);
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), sha);
});

test('VAL-ORACLE-018: promote-once idempotent when completion_commit already present', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const before = readFrontmatterField(ticketPath, 'completion_commit');
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.equal(decision.ok, true);
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), before);
});

test('VAL-ORACLE-019: announcement recovery persists completion_commit_inferred and accepts via announcement', () => {
  const { dir } = initRepo();
  const announced = commit(dir, 'worker announced commit unrelated to id');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const decision = evaluateCompletionEvidence(attributionCtx({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir, announcedSha: () => announced,
  }));
  assert.equal(decision.ok, true);
  assert.equal(decision.via, 'announcement');
  assert.equal(decision.sha, announced);
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit_inferred'), announced);
});

test('VAL-ORACLE-020: single backoff re-read picks up evidence written after the first read (R-CCGR)', async () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'late r1 evidence');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', {});
  const inject = `completion_commit: ${JSON.stringify(sha)}`;
  const script =
    `const fs=require('fs');` +
    `setTimeout(()=>{const p=${JSON.stringify(ticketPath)};` +
    `let c=fs.readFileSync(p,'utf8');` +
    `c=c.replace('---\\n','---\\n'+${JSON.stringify(inject)}+'\\n');` +
    `fs.writeFileSync(p,c);},120);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  try {
    const decision = evaluateCompletionEvidence({
      sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
      startCommit: null, pinnedSha: null, decision: 'attribution', rereadBackoffMs: 800,
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.sha, sha);
  } finally {
    await new Promise((resolve) => child.on('exit', resolve));
  }
});

test('VAL-ORACLE-021: decision:attribution NEVER consults a worker-gate verdict', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence(attributionCtx({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
    workerGateVerdict: () => ({ verdict: 'red', computedVia: 'test' }),
  }));
  assert.equal(decision.ok, true);
});

test('VAL-ORACLE-022: decision:phantom-watch NEVER consults a worker-gate verdict', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
    startCommit: null, pinnedSha: null, decision: 'phantom-watch', rereadBackoffMs: 0,
    workerGateVerdict: () => ({ verdict: 'absent', computedVia: 'test' }),
  });
  assert.equal(decision.ok, true);
});

test('VAL-ORACLE-023: decision:done-flip with NO injected worker gate refuses worker_gate_unavailable', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
    startCommit: null, pinnedSha: null, decision: 'done-flip', rereadBackoffMs: 0,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'worker_gate_unavailable');
});

test('VAL-ORACLE-024: decision:done-flip with injected GREEN verdict accepts', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
    startCommit: null, pinnedSha: null, decision: 'done-flip', rereadBackoffMs: 0,
    workerGateVerdict: () => ({ verdict: 'green', computedVia: 'test' }),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.sha, sha);
});

test('VAL-ORACLE-025: decision:done-flip with injected RED verdict refuses worker_gate_red', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'implement r1');
  const sessionDir = mkSession();
  const ticketPath = writeTicket(sessionDir, 'R1', { completion_commit: sha });
  const decision = evaluateCompletionEvidence({
    sessionDir, ticketId: 'R1', ticketPath, workingDir: dir,
    startCommit: null, pinnedSha: null, decision: 'done-flip', rereadBackoffMs: 0,
    workerGateVerdict: () => ({ verdict: 'red', computedVia: 'test' }),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'worker_gate_red');
});

// --- gateForPhantomDoneRevert --------------------------------------------

test('VAL-ORACLE-026: gateForPhantomDoneRevert keeps a hallucinated-stamp ticket whose real work is scan-attributable', () => {
  const { dir } = initRepo();
  commit(dir, 'fix(r1): real scan-attributable work');
  const sessionDir = mkSession();
  writeTicket(sessionDir, 'R1', { completion_commit: BOGUS_A });
  const revert = gateForPhantomDoneRevert({ sessionDir, ticketId: 'R1', workingDir: dir, startCommit: null, pinnedSha: null });
  assert.equal(revert.action, 'keep');
});

test('VAL-ORACLE-027: gateForPhantomDoneRevert reverts when there is no usable evidence', () => {
  const { dir } = initRepo();
  const sessionDir = mkSession();
  writeTicket(sessionDir, 'R1', {});
  const revert = gateForPhantomDoneRevert({ sessionDir, ticketId: 'R1', workingDir: dir, startCommit: null, pinnedSha: null });
  assert.deepEqual(revert, { action: 'revert', kind: 'absent' });
});

test('VAL-ORACLE-028: completion_commit survives a Done → re-flip status-rewrite cycle (R-WDTF)', () => {
  const { dir } = initRepo();
  const sha = commit(dir, 'fix(r1): durable pointer work');
  const sessionDir = mkSession();
  writeTicketFiles(sessionDir, {
    tickets: [{
      id: 'R1',
      title: 'Durable ticket',
      description: 'Ticket exercising R-WDTF durability.',
      acceptance_criteria: ['Pointer survives status re-flips.'],
      verification: ['node -e "process.exit(0)"'],
      priority: 'P1',
      status: 'Todo',
    }],
  });
  const ticketPath = getTicketById(sessionDir, 'R1').filePath;
  const decision = evaluateCompletionEvidence(attributionCtx({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir }));
  assert.equal(decision.ok, true);
  const stamped = readFrontmatterField(ticketPath, 'completion_commit');
  assert.equal(stamped, sha);

  updateTicketStatus(sessionDir, 'R1', { status: 'Done' });
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), stamped, 'survives Done flip');
  updateTicketStatus(sessionDir, 'R1', { status: 'Todo' });
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), stamped, 'survives re-open');
  updateTicketStatus(sessionDir, 'R1', { status: 'Done' });
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), stamped, 'survives Done re-flip');
});
