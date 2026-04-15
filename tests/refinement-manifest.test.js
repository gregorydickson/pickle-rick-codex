import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fallbackRefinePrd, readManifest, writeManifest, writeTicketFiles } from '../lib/tickets.js';
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
