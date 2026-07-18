// @tier: fast
// B-1SEAM WS-1 completion-predicate single-seam call-site audit (codex port).
//
// Pins codex's ONE completion predicate `evaluateCompletionEvidence` in
// ticket-completion-evidence.ts as the sole route to a completion decision.
// Adapted from the claude `completion-predicate-single-seam.test.js`: codex has no
// phantom-done watcher, no auto-fill-completion-commit.ts and no worker-gate, so the
// only completion decision surface is `spawn-morty.ts`.
//
// Four pins + a self-test:
//   1. `readEvidence(<arg>)` callsites OUTSIDE ticket-completion-evidence.ts == 0
//      — every decision site routes through the predicate.
//   2. `evaluateCompletionEvidence(` callsites: exactly 1 in spawn-morty.ts;
//      0 in any other src file outside the oracle module.
//   3. importer files of ticket-completion-evidence == exactly {spawn-morty.ts}
//      (the codex analog of R-AFCC-CALLER-ENUMERATION).
//   4. spawn-morty's completion tail routes through the predicate: it calls
//      `evaluateCompletionEvidence(`, builds an 'attribution' ctx (NOT 'done-flip'),
//      gates `finalizeSuccess(` on the decision `.ok`, retires the old file-only
//      `stampCompletionCommit(`, and has no bare frontmatter-presence Done accept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(testDir, '..', 'src');
const spawnMortyPath = path.join(srcRoot, 'bin', 'spawn-morty.ts');

const ORACLE_BASENAME = 'ticket-completion-evidence.ts';

// A readEvidence CALLSITE passes an argument: `readEvidence({`, `readEvidence(ctx)`.
// The zero-arg prose form `readEvidence().kind` is NOT a callsite — `[^)\s]` after the
// paren excludes it. `\s*` spans newlines so a line-wrapped callsite cannot dodge it.
const READ_EVIDENCE_CALLSITE_RE = /\breadEvidence\(\s*[^)\s]/;

/** Recursively collect every non-`.d.ts` `.ts` file under `dir`. */
function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(full);
    }
  }
  return result;
}

/** Drop comment lines so documented mentions can't trip (or hide) a pin. */
function nonCommentText(content) {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

const spawnMortyContent = fs.readFileSync(spawnMortyPath, 'utf8');
const spawnMortyCode = nonCommentText(spawnMortyContent);

test('PIN 1: zero readEvidence(<arg>) callsites outside ticket-completion-evidence.ts', () => {
  const violations = [];
  for (const filePath of walkTs(srcRoot)) {
    if (path.basename(filePath) === ORACLE_BASENAME) continue;
    const body = nonCommentText(fs.readFileSync(filePath, 'utf8'));
    if (READ_EVIDENCE_CALLSITE_RE.test(body)) {
      violations.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(
    violations,
    [],
    'readEvidence( callsite(s) outside the oracle — a decision site bypassed ' +
      `evaluateCompletionEvidence (B-1SEAM single-seam regression): ${violations.join(', ')}`,
  );
});

test('PIN 2: evaluateCompletionEvidence( callsites are exactly {spawn-morty.ts: 1}', () => {
  const spawnMortyCount = (spawnMortyCode.match(/evaluateCompletionEvidence\(/g) || []).length;
  assert.equal(
    spawnMortyCount,
    1,
    `evaluateCompletionEvidence( callsites in spawn-morty.ts = ${spawnMortyCount}, expected exactly 1 ` +
      '(the single completion decision seam). A dropped site means the Done-flip bypassed the predicate; ' +
      'a new site is a deliberate pin bump.',
  );
  const strays = [];
  for (const filePath of walkTs(srcRoot)) {
    const base = path.basename(filePath);
    if (base === ORACLE_BASENAME || base === 'spawn-morty.ts') continue;
    const body = nonCommentText(fs.readFileSync(filePath, 'utf8'));
    if (/evaluateCompletionEvidence\(/.test(body)) {
      strays.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(
    strays,
    [],
    `evaluateCompletionEvidence( callsite(s) in unexpected file(s): ${strays.join(', ')}`,
  );
});

test('PIN 3: ticket-completion-evidence importer files are exactly {spawn-morty.ts}', () => {
  const importers = walkTs(srcRoot)
    .filter((f) => path.basename(f) !== ORACLE_BASENAME)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('ticket-completion-evidence'))
    .map((f) => path.basename(f))
    .sort();
  assert.deepEqual(
    importers,
    ['spawn-morty.ts'],
    'ticket-completion-evidence importer set drifted from the codex single-seam pin — a new caller ' +
      'requires a deliberate pin update here.',
  );
});

test('PIN 4: spawn-morty completion tail routes Done through the predicate (done-flip, .ok-gated)', () => {
  assert.ok(
    /evaluateCompletionEvidence\(/.test(spawnMortyCode),
    'spawn-morty.ts no longer calls evaluateCompletionEvidence — the completion decision bypassed the predicate.',
  );
  assert.ok(
    /decision:\s*'done-flip'/.test(spawnMortyCode),
    "spawn-morty's completion ctx must use decision:'done-flip' so the portable worker gate is fail-closed.",
  );
  assert.ok(
    /workerGateVerdict:/.test(spawnMortyCode),
    "spawn-morty must inject the worker gate resolver into the single completion oracle.",
  );
  assert.ok(
    /\.ok\b[\s\S]{0,160}finalizeSuccess\(/.test(spawnMortyCode),
    'finalizeSuccess( must be gated on the completion decision `.ok` — Done is flipped only on ok:true.',
  );
  assert.ok(
    !/\bstampCompletionCommit\(/.test(spawnMortyCode),
    'the old file-only stampCompletionCommit( path must be retired — the pointer write is folded into ' +
      "the oracle's persistEvidence promote-once (R-WDTF guarantee).",
  );
});

test('FAIL-INJECTION: the readEvidence callsite regex catches real calls and spares the prose form', () => {
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('const e = readEvidence({ sessionDir, ticketId });'));
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('const e = readEvidence(ctx);'));
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('readEvidence(\n  probe,\n)'), 'line-wrapped callsite must match');
  assert.ok(
    !READ_EVIDENCE_CALLSITE_RE.test("reason: `... readEvidence().kind === 'absent' ...`"),
    'zero-arg prose mention must NOT count as a callsite',
  );
});
