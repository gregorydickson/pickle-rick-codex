// @tier: fast
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  prepareTicketTransaction,
  recoverInterruptedTicketTransaction,
  runTicketTransaction,
} from '../services/ticket-transaction.js';
import { updateTicketStatus, writeTicketFiles } from '../services/tickets.js';
import { makeTempRoot, writeJson } from './helpers.js';

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function ticket(id, status = 'Todo') {
  return {
    id,
    title: `Ticket ${id}`,
    description: `Implement ${id}.`,
    acceptance_criteria: [`${id} has durable evidence.`],
    verification: ['node -e "process.exit(0)"'],
    allowed_paths: [`${id}.txt`],
    priority: 'P1',
    status,
  };
}

test('interrupted ticket restructuring replays exact prior files and removes new ticket paths', () => {
  const sessionDir = makeTempRoot('pickle-ticket-transaction-');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const ticketPath = path.join(sessionDir, 'r1', 'linear_ticket_r1.md');
  const newTicketPath = path.join(sessionDir, 'r2', 'linear_ticket_r2.md');
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true });
  const originalManifest = `${JSON.stringify({ tickets: [ticket('r1', 'Done')] }, null, 2)}\n`;
  const originalTicket = '---\nid: "r1"\nstatus: "Done"\ncompletion_commit: "abc1234"\n---\nOriginal evidence body\n';
  fs.writeFileSync(manifestPath, originalManifest);
  fs.writeFileSync(ticketPath, originalTicket);

  prepareTicketTransaction(sessionDir, 'test-interruption', [manifestPath, ticketPath, newTicketPath]);
  writeJson(manifestPath, { tickets: [ticket('r2')] });
  fs.writeFileSync(ticketPath, 'corrupt partial rewrite\n');
  fs.mkdirSync(path.dirname(newTicketPath), { recursive: true });
  fs.writeFileSync(newTicketPath, 'new partial ticket\n');

  assert.equal(recoverInterruptedTicketTransaction(sessionDir), true);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), originalManifest);
  assert.equal(fs.readFileSync(ticketPath, 'utf8'), originalTicket);
  assert.equal(fs.existsSync(newTicketPath), false);
  const ledger = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-transaction-ledger.json'), 'utf8'));
  assert.equal(ledger.active, null);
  assert.equal(ledger.history.at(-1).status, 'recovered');
});

test('ticket transaction rolls back all touched files when a multi-file mutation throws', () => {
  const sessionDir = makeTempRoot('pickle-ticket-rollback-');
  const first = path.join(sessionDir, 'refinement_manifest.json');
  const second = path.join(sessionDir, 'r1', 'linear_ticket_r1.md');
  fs.writeFileSync(first, 'original manifest\n');

  assert.throws(() => runTicketTransaction(sessionDir, 'throwing-test', [first, second], () => {
    fs.writeFileSync(first, 'partial manifest\n');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(second, 'partial ticket\n');
    throw new Error('injected interruption');
  }), /injected interruption/);

  assert.equal(fs.readFileSync(first, 'utf8'), 'original manifest\n');
  assert.equal(fs.existsSync(second), false);
  const ledger = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-transaction-ledger.json'), 'utf8'));
  assert.equal(ledger.history.at(-1).status, 'rolled_back');
});

test('ticket transaction waits for a live foreign owner instead of failing the worker', async () => {
  const sessionDir = makeTempRoot('pickle-ticket-live-contention-');
  const lockFile = path.join(sessionDir, 'ticket-transaction-ledger.json.lock');
  const child = spawn(process.execPath, [
    '-e',
    `const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,String(process.pid));setTimeout(()=>{fs.rmSync(p,{force:true});process.exit(0)},250)`,
    lockFile,
  ], { stdio: 'ignore' });
  await waitForFile(lockFile);

  const startedAt = Date.now();
  assert.equal(recoverInterruptedTicketTransaction(sessionDir), false);
  assert.ok(Date.now() - startedAt >= 150, 'transaction should wait for the live owner to release');
  assert.equal(fs.existsSync(lockFile), false);
  if (child.exitCode === null) {
    await new Promise((resolve, reject) => {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
      child.once('error', reject);
    });
  } else {
    assert.equal(child.exitCode, 0);
  }
});

test('ticket transaction reclaims a dead-owner lock without consuming worker retries', () => {
  const sessionDir = makeTempRoot('pickle-ticket-dead-contention-');
  const lockFile = path.join(sessionDir, 'ticket-transaction-ledger.json.lock');
  fs.writeFileSync(lockFile, '2147483647');

  assert.equal(recoverInterruptedTicketTransaction(sessionDir), false);
  assert.equal(fs.existsSync(lockFile), false);
});

test('ticket transaction treats nested state.json as an ordinary artifact', () => {
  const sessionDir = makeTempRoot('pickle-ticket-nested-state-');
  const nestedState = path.join(sessionDir, 'fixtures', 'state.json');
  fs.mkdirSync(path.dirname(nestedState), { recursive: true });
  fs.writeFileSync(nestedState, '{"fixture":true}\n');

  assert.throws(() => runTicketTransaction(sessionDir, 'nested-state-test', [nestedState], () => {
    fs.writeFileSync(nestedState, '{"fixture":false}\n');
    throw new Error('rollback nested state');
  }), /rollback nested state/);

  assert.equal(fs.readFileSync(nestedState, 'utf8'), '{"fixture":true}\n');
});

test('status and rematerialization transactions preserve completion_commit evidence', () => {
  const sessionDir = makeTempRoot('pickle-ticket-evidence-');
  const manifest = { source: 'codex-refinement', tickets: [ticket('r1')] };
  writeTicketFiles(sessionDir, manifest);
  updateTicketStatus(sessionDir, 'r1', { completion_commit: 'abc1234' });
  const ticketPath = path.join(sessionDir, 'r1', 'linear_ticket_r1.md');
  const evidenceBefore = fs.readFileSync(ticketPath, 'utf8').match(/^completion_commit:\s*.*$/m)?.[0];

  updateTicketStatus(sessionDir, 'r1', { status: 'Done', failure_reason: null });
  const evidenceAfterStatus = fs.readFileSync(ticketPath, 'utf8').match(/^completion_commit:\s*.*$/m)?.[0];
  writeTicketFiles(sessionDir, JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8')));
  const evidenceAfterMaterialize = fs.readFileSync(ticketPath, 'utf8').match(/^completion_commit:\s*.*$/m)?.[0];

  assert.equal(evidenceBefore, 'completion_commit: "abc1234"');
  assert.equal(evidenceAfterStatus, evidenceBefore);
  assert.equal(evidenceAfterMaterialize, evidenceBefore);
  const ledger = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-transaction-ledger.json'), 'utf8'));
  assert.equal(ledger.active, null);
  assert.ok(ledger.history.every((entry) => entry.status === 'committed'));
});
