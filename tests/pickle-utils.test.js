import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractFrontmatter,
  getDataRoot,
  parseFrontmatter,
  parseTicketFile,
  statusSymbol,
  updateFrontmatter,
} from '../lib/pickle-utils.js';
import { makeTempRoot } from './helpers.js';

test('getDataRoot uses PICKLE_DATA_ROOT when set', () => {
  const previous = process.env.PICKLE_DATA_ROOT;
  const tempRoot = makeTempRoot();
  process.env.PICKLE_DATA_ROOT = tempRoot;
  try {
    assert.equal(getDataRoot(), tempRoot);
  } finally {
    if (previous === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previous;
  }
});

test('extractFrontmatter and parseFrontmatter handle simple YAML-style fields', () => {
  const content = '---\nid: ticket-1\nstatus: "Todo"\n---\n# Body\n';
  const extracted = extractFrontmatter(content);
  assert.ok(extracted);
  assert.equal(extracted.body, 'id: ticket-1\nstatus: "Todo"');
  assert.deepEqual(parseFrontmatter(content), {
    id: 'ticket-1',
    status: 'Todo',
  });
});

test('updateFrontmatter rewrites existing fields and appends missing ones', () => {
  const content = '---\nid: ticket-1\nstatus: "Todo"\n---\n# Body\n';
  const next = updateFrontmatter(content, {
    status: 'Done',
    completed_at: '2026-04-15T00:00:00.000Z',
  });
  assert.match(next, /status: "Done"/);
  assert.match(next, /completed_at: "2026-04-15T00:00:00.000Z"/);
});

test('parseTicketFile reads ticket metadata and statusSymbol maps expected values', () => {
  const tempRoot = makeTempRoot();
  const ticketPath = path.join(tempRoot, 'ticket-a', 'linear_ticket_ticket-a.md');
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true });
  fs.writeFileSync(ticketPath, '---\nid: "ticket-a"\ntitle: "Alpha"\nstatus: "In Progress"\norder: 2\nverify: "npm test"\n---\n# Alpha\n');

  const ticket = parseTicketFile(ticketPath);
  assert.equal(ticket.id, 'ticket-a');
  assert.equal(ticket.title, 'Alpha');
  assert.equal(ticket.order, 2);
  assert.equal(ticket.verify, 'npm test');
  assert.equal(statusSymbol(ticket.status), '[~]');
  assert.equal(statusSymbol('Done'), '[x]');
});
