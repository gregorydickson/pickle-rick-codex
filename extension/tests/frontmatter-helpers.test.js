// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeCompletionCommitField,
  parseFrontmatter,
  readFrontmatterField,
  upsertFrontmatterField,
} from '../services/pickle-utils.js';
import { makeTempRoot } from './helpers.js';

function writeTicket(content) {
  const tempRoot = makeTempRoot();
  const ticketPath = path.join(tempRoot, 'ticket-a', 'linear_ticket_ticket-a.md');
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true });
  fs.writeFileSync(ticketPath, content);
  return ticketPath;
}

const SHORT_SHA = '724f69d';
const FULL_SHA = '724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8';

test('VAL-STAMP-001: completion_commit write→read round-trips the exact sha', () => {
  const ticketPath = writeTicket('---\nid: "ticket-a"\nstatus: "Todo"\n---\n# Body\n');
  upsertFrontmatterField(ticketPath, 'completion_commit', FULL_SHA);
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), FULL_SHA);
});

test('VAL-STAMP-002: reading an absent completion_commit yields null', () => {
  const withField = writeTicket('---\nid: "ticket-a"\nstatus: "Todo"\n---\n# Body\n');
  assert.equal(readFrontmatterField(withField, 'completion_commit'), null);

  const noFrontmatter = writeTicket('# Body only, no frontmatter\n');
  assert.equal(readFrontmatterField(noFrontmatter, 'completion_commit'), null);

  assert.equal(readFrontmatterField(path.join(makeTempRoot(), 'missing.md'), 'completion_commit'), null);
});

test('VAL-STAMP-003: upsert does not disturb sibling frontmatter fields', () => {
  const original = '---\nid: "ticket-a"\ntitle: "Alpha"\nstatus: "Todo"\norder: 2\nverify: "npm test"\n---\n# Alpha body\n';
  const ticketPath = writeTicket(original);
  const before = parseFrontmatter(fs.readFileSync(ticketPath, 'utf8'));

  upsertFrontmatterField(ticketPath, 'completion_commit', FULL_SHA);

  const after = parseFrontmatter(fs.readFileSync(ticketPath, 'utf8'));
  for (const key of Object.keys(before)) {
    assert.equal(after[key], before[key], `sibling field ${key} must be unchanged`);
  }
  assert.equal(after.completion_commit, FULL_SHA);

  const finalContent = fs.readFileSync(ticketPath, 'utf8');
  assert.ok(finalContent.endsWith('# Alpha body\n'), 'body separation preserved');
  assert.ok(/^---\n[\s\S]*\n---\n/.test(finalContent), 'frontmatter fence preserved');
});

test('VAL-STAMP-004: upsert replaces an existing completion_commit in place', () => {
  const ticketPath = writeTicket('---\nid: "ticket-a"\nstatus: "Todo"\n---\n# Body\n');
  upsertFrontmatterField(ticketPath, 'completion_commit', SHORT_SHA);
  upsertFrontmatterField(ticketPath, 'completion_commit', FULL_SHA);

  const content = fs.readFileSync(ticketPath, 'utf8');
  const occurrences = content.match(/^completion_commit:/gm) || [];
  assert.equal(occurrences.length, 1, 'exactly one completion_commit line');
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), FULL_SHA);
});

test('VAL-STAMP-004b: upsert replaces a pre-existing EMPTY key line in place (no duplicate)', () => {
  const original = '---\nid: "ticket-a"\ntitle: "Alpha"\nstatus: "Todo"\ncompletion_commit:\norder: 2\n---\n# Alpha body\n';
  const ticketPath = writeTicket(original);

  upsertFrontmatterField(ticketPath, 'completion_commit', FULL_SHA);

  const content = fs.readFileSync(ticketPath, 'utf8');
  const occurrences = content.match(/^completion_commit:/gm) || [];
  assert.equal(occurrences.length, 1, 'exactly one completion_commit line — the empty line was replaced in place');
  assert.equal(readFrontmatterField(ticketPath, 'completion_commit'), FULL_SHA);

  const after = parseFrontmatter(content);
  assert.equal(after.id, 'ticket-a');
  assert.equal(after.title, 'Alpha');
  assert.equal(after.status, 'Todo');
  assert.equal(after.order, '2');
  assert.ok(content.endsWith('# Alpha body\n'), 'body preserved');
});

test('VAL-STAMP-002b: reading an EMPTY key line returns null, not the next frontmatter line', () => {
  const emptyThenSha = writeTicket(
    `---\nid: "ticket-a"\nstatus: "Todo"\ncompletion_commit:\nstart_commit: ${FULL_SHA}\n---\n# Body\n`,
  );
  assert.equal(readFrontmatterField(emptyThenSha, 'completion_commit'), null);
  assert.equal(readFrontmatterField(emptyThenSha, 'start_commit'), FULL_SHA);

  const emptyWithTrailingSpaces = writeTicket(
    `---\nid: "ticket-a"\ncompletion_commit:   \nstart_commit: ${SHORT_SHA}\n---\n# Body\n`,
  );
  assert.equal(readFrontmatterField(emptyWithTrailingSpaces, 'completion_commit'), null);
});

test('VAL-STAMP-005: normalizeCompletionCommitField accepts short and full shas unchanged', () => {
  assert.equal(normalizeCompletionCommitField(SHORT_SHA), SHORT_SHA);
  assert.equal(normalizeCompletionCommitField(FULL_SHA), FULL_SHA);
  assert.equal(normalizeCompletionCommitField('ABCDEF0'), 'ABCDEF0');
});

test('VAL-STAMP-006: normalizeCompletionCommitField strips surrounding quotes and whitespace', () => {
  assert.equal(normalizeCompletionCommitField('  "724f69d4db8a"  '), '724f69d4db8a');
  assert.equal(normalizeCompletionCommitField("'724f69d'"), '724f69d');
  assert.equal(normalizeCompletionCommitField('\t724f69d\n'), '724f69d');
});

test('VAL-STAMP-007: normalizeCompletionCommitField rejects blank, placeholder, and non-hex values', () => {
  assert.equal(normalizeCompletionCommitField(''), null);
  assert.equal(normalizeCompletionCommitField('   '), null);
  assert.equal(normalizeCompletionCommitField(null), null);
  assert.equal(normalizeCompletionCommitField(undefined), null);
  assert.equal(normalizeCompletionCommitField('724f6'), null); // 5 chars < 7
  assert.equal(normalizeCompletionCommitField('a'.repeat(41)), null); // > 40
  assert.equal(normalizeCompletionCommitField('TBD'), null);
  assert.equal(normalizeCompletionCommitField('pending'), null);
  assert.equal(normalizeCompletionCommitField('none'), null);
  assert.equal(normalizeCompletionCommitField('zzzzzzz'), null); // right length, non-hex
});
