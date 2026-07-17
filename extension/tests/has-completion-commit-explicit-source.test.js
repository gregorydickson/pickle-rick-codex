// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';
import { normalizeCompletionCommitField } from '../services/pickle-utils.js';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const dir = makeTempRoot('oracle-src-repo-');
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Pickle Rick Tests']);
  git(dir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

function writeTicketRaw(sessionDir, id, completionLine) {
  const lc = id.toLowerCase();
  const dir = path.join(sessionDir, lc);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `linear_ticket_${lc}.md`);
  fs.writeFileSync(
    filePath,
    `---\nid: "${id}"\ntitle: "Ticket ${id}"\nstatus: "Todo"\n${completionLine}\n---\n\n# Ticket ${id}\n\nBody.\n`,
  );
  return filePath;
}

// R-AICF: an unreachable explicit completion_commit — quoted or unquoted, full or
// short — must FALL THROUGH to the git-log scan and attribute the real fix(r1) commit,
// never hard-absent on the hallucinated stamp.
const UNREACHABLE_FULL = 'a'.repeat(40);
const UNREACHABLE_SHORT = 'abc1234';

const variants = [
  { name: 'quoted full', line: `completion_commit: "${UNREACHABLE_FULL}"` },
  { name: 'unquoted full', line: `completion_commit: ${UNREACHABLE_FULL}` },
  { name: 'quoted short', line: `completion_commit: "${UNREACHABLE_SHORT}"` },
  { name: 'unquoted short', line: `completion_commit: ${UNREACHABLE_SHORT}` },
];

for (const variant of variants) {
  test(`VAL-ORACLE explicit-source: unreachable ${variant.name} SHA falls through to scan`, () => {
    const dir = initRepo();
    git(dir, ['commit', '--allow-empty', '-m', 'fix(r1): the real delivering commit']);
    const realSha = git(dir, ['rev-parse', 'HEAD']);
    const sessionDir = makeTempRoot('oracle-src-session-');
    const ticketPath = writeTicketRaw(sessionDir, 'R1', variant.line);
    const result = readEvidence({ sessionDir, ticketId: 'R1', ticketPath, workingDir: dir });
    assert.deepEqual(result, { kind: 'committed', sha: realSha, via: 'scan' });
  });
}

test('normalizeCompletionCommitField normalizes quoted/unquoted full/short → plain hex', () => {
  assert.equal(normalizeCompletionCommitField(`"${UNREACHABLE_FULL}"`), UNREACHABLE_FULL);
  assert.equal(normalizeCompletionCommitField(UNREACHABLE_FULL), UNREACHABLE_FULL);
  assert.equal(normalizeCompletionCommitField(`'${UNREACHABLE_SHORT}'`), UNREACHABLE_SHORT);
  assert.equal(normalizeCompletionCommitField(UNREACHABLE_SHORT), UNREACHABLE_SHORT);
  assert.equal(normalizeCompletionCommitField('not-a-sha'), null);
  assert.equal(normalizeCompletionCommitField(''), null);
  assert.equal(normalizeCompletionCommitField(null), null);
});
