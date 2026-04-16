import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureTicketFilesMaterialized,
  fallbackRefinePrd,
  getTicketById,
  readManifest,
  summarizeTickets,
  writeManifest,
  writeTicketFiles,
} from '../lib/tickets.js';
import { makeTempRoot } from './helpers.js';

test('fallbackRefinePrd builds tickets from the PRD task breakdown table', () => {
  const prd = [
    '# PRD',
    '',
    '## Task Breakdown',
    '| Order | ID | Title | Priority | Phase | Depends On |',
    '|---|---|---|---|---|---|',
    '| 10 | T0 | Repo Bootstrap and Normalization | P0 | 0 | none |',
    '| 20 | T1 | Codex Validation Report | P0 | 0 | T0 |',
  ].join('\n');

  const manifest = fallbackRefinePrd(prd);
  assert.equal(manifest.tickets.length, 2);
  assert.equal(manifest.tickets[0].title, 'Repo Bootstrap and Normalization');
  assert.equal(manifest.tickets[1].priority, 'P0');
});

test('writeManifest and writeTicketFiles materialize refinement output', () => {
  const sessionDir = makeTempRoot();
  const manifest = {
    tickets: [
      {
        id: 'ticket-001',
        title: 'Implement thing',
        description: 'Do the work',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, manifest);
  writeTicketFiles(sessionDir, manifest);

  const written = readManifest(sessionDir);
  assert.equal(written.tickets.length, 1);
  const ticketDir = path.join(sessionDir, 'ticket-001');
  const files = fs.readdirSync(ticketDir);
  assert.ok(files.some((fileName) => fileName === 'linear_ticket_ticket-001.md'));
});

test('readManifest and writeTicketFiles normalize uppercase ticket ids and persist them', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'R1',
        title: 'Uppercase ID Ticket',
        description: 'Do the work',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const manifest = readManifest(sessionDir);
  writeTicketFiles(sessionDir, manifest);

  const rewritten = readManifest(sessionDir);
  assert.equal(rewritten.tickets[0].id, 'r1');
  assert.ok(fs.existsSync(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')));
  assert.equal(getTicketById(sessionDir, 'R1')?.id, 'r1');
});

test('normalizeManifestTicketIds rewrites dependency references to canonical ids', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'R1',
        title: 'Root Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'R2',
        title: 'Dependent Ticket',
        description: 'second',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        depends_on: 'R1',
      },
    ],
  });

  const manifest = readManifest(sessionDir);
  assert.equal(manifest.tickets[0].id, 'r1');
  assert.equal(manifest.tickets[1].id, 'r2');
  assert.equal(manifest.tickets[1].depends_on, 'r1');
});

test('summarizeTickets and ensureTicketFilesMaterialized restore missing ticket files from the manifest', () => {
  const sessionDir = makeTempRoot();
  const manifest = {
    tickets: [
      {
        id: 'ticket-a',
        title: 'First Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'ticket-b',
        title: 'Second Ticket',
        description: 'second',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, manifest);
  writeTicketFiles(sessionDir, { tickets: [manifest.tickets[0]] });

  const materialized = ensureTicketFilesMaterialized(sessionDir);
  const summary = summarizeTickets(sessionDir);
  assert.equal(materialized.length, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.runnable.length, 2);
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-b', 'linear_ticket_ticket-b.md')));
});

test('ticket rematerialization preserves operational frontmatter needed by status and config protection', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'ticket-a',
        title: 'Config Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Blocked',
        config_change: true,
        failed_at: '2026-04-15T12:00:00.000Z',
        failure_reason: 'verification failed',
        retry_requested_at: '2026-04-15T13:00:00.000Z',
      },
    ],
  });

  ensureTicketFilesMaterialized(sessionDir);
  const ticket = getTicketById(sessionDir, 'ticket-a');

  assert.equal(ticket.frontmatter.failed_at, '2026-04-15T12:00:00.000Z');
  assert.equal(ticket.frontmatter.failure_reason, 'verification failed');
  assert.equal(ticket.frontmatter.retry_requested_at, '2026-04-15T13:00:00.000Z');
  assert.match(ticket.content, /config_change: true/);
});
