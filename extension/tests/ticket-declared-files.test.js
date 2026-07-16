// @tier: fast
//
// M1 declared-files reader: readDeclaredFiles(sessionDir, ticketId) maps a
// codex ticket's output_artifacts + proof_corpus + freeze_contract.artifact_path
// into a de-duplicated declared-files set, reading either the materialized
// ticket markdown frontmatter or the refinement manifest, never throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readDeclaredFiles } from '../services/ticket-declared-files.js';
import { makeTempRoot, writeJson } from './helpers.js';

// Materializes a ticket markdown file the way services/tickets.ts writes it:
// frontmatter values are JSON-encoded, so arrays/objects land as JSON strings.
function writeTicketFile(sessionDir, ticketId, fields = {}) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `id: ${JSON.stringify(ticketId)}`,
    'title: "Some ticket"',
    'status: "Todo"',
    'order: 1',
    'verify: "npm test"',
  ];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '# Some ticket', '', '## Description', 'Body.', '');
  fs.writeFileSync(path.join(dir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
  return sessionDir;
}

function writeManifest(sessionDir, tickets) {
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    generated_at: '2026-04-15T00:00:00.000Z',
    source: 'test',
    tickets,
  });
  return sessionDir;
}

test('VAL-STAMP-008: readDeclaredFiles maps output_artifacts into the declared set', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    output_artifacts: ['src/a.ts', 'src/b.ts'],
  });
  assert.deepEqual(readDeclaredFiles(sessionDir, 'ticket-a'), ['src/a.ts', 'src/b.ts']);
});

test('VAL-STAMP-009: readDeclaredFiles unions proof_corpus and freeze_contract.artifact_path (deduped)', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    output_artifacts: ['src/a.ts', 'src/b.ts'],
    proof_corpus: ['src/b.ts', 'tests/a.test.ts'],
    freeze_contract: { artifact_path: 'src/c.ts', sibling: '', root_env: '', sha_source: '' },
  });
  const declared = readDeclaredFiles(sessionDir, 'ticket-a');
  assert.deepEqual(declared, ['src/a.ts', 'src/b.ts', 'tests/a.test.ts', 'src/c.ts']);
  assert.equal(new Set(declared).size, declared.length, 'no duplicates');
});

test('VAL-STAMP-009: freeze_contract.artifact_path is included even without the other fields', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    freeze_contract: { artifact_path: 'artifacts/freeze.json', sibling: '', root_env: '', sha_source: '' },
  });
  assert.deepEqual(readDeclaredFiles(sessionDir, 'ticket-a'), ['artifacts/freeze.json']);
});

test('VAL-STAMP-010: returns [] for a ticket declaring none of the three fields', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {});
  let result;
  assert.doesNotThrow(() => {
    result = readDeclaredFiles(sessionDir, 'ticket-a');
  });
  assert.deepEqual(result, []);
});

test('VAL-STAMP-010: returns [] for empty declaration arrays', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    output_artifacts: [],
    proof_corpus: [],
  });
  assert.deepEqual(readDeclaredFiles(sessionDir, 'ticket-a'), []);
});

test('VAL-STAMP-010: returns [] for a nonexistent ticket id without throwing', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    output_artifacts: ['src/a.ts'],
  });
  let result;
  assert.doesNotThrow(() => {
    result = readDeclaredFiles(sessionDir, 'does-not-exist');
  });
  assert.deepEqual(result, []);
});

test('VAL-STAMP-010: returns [] for a nonexistent session dir without throwing', () => {
  const missing = path.join(makeTempRoot(), 'no-such-session');
  let result;
  assert.doesNotThrow(() => {
    result = readDeclaredFiles(missing, 'ticket-a');
  });
  assert.deepEqual(result, []);
});

test('normalizes a leading ./ and de-dupes against the unprefixed form', () => {
  const sessionDir = writeTicketFile(makeTempRoot(), 'ticket-a', {
    output_artifacts: ['./src/dup.ts', 'src/dup.ts'],
    proof_corpus: ['./src/dup.ts'],
  });
  assert.deepEqual(readDeclaredFiles(sessionDir, 'ticket-a'), ['src/dup.ts']);
});

test('reads declared files from the refinement manifest when no ticket file is materialized', () => {
  const sessionDir = writeManifest(makeTempRoot(), [
    {
      id: 'ticket-a',
      title: 'Alpha',
      status: 'Todo',
      output_artifacts: ['src/a.ts'],
      proof_corpus: ['tests/a.test.ts'],
      freeze_contract: { artifact_path: 'src/c.ts', sibling: '', root_env: '', sha_source: '' },
    },
  ]);
  assert.deepEqual(readDeclaredFiles(sessionDir, 'ticket-a'), ['src/a.ts', 'tests/a.test.ts', 'src/c.ts']);
});
