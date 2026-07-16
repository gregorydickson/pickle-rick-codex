// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromiseTokens, hasToken, wrapToken } from '../types/index.js';
import { PROMISE_TOKENS, FORBIDDEN_WORKER_TOKENS, scrubForbiddenWorkerTokens } from '../services/promise-tokens.js';

// ---------------------------------------------------------------------------
// wrapToken
// ---------------------------------------------------------------------------

test('wrapToken: wraps a simple token', () => {
  assert.equal(wrapToken('EPIC_COMPLETED'), '<promise>EPIC_COMPLETED</promise>');
});

test('wrapToken: wraps a multi-word token', () => {
  assert.equal(wrapToken('I AM DONE'), '<promise>I AM DONE</promise>');
});

// ---------------------------------------------------------------------------
// hasToken
// ---------------------------------------------------------------------------

test('hasToken: detects exact match', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETED</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: no match for different token', () => {
  assert.equal(hasToken('<promise>TASK_COMPLETED</promise>', 'EPIC_COMPLETED'), false);
});

test('hasToken: works with surrounding text', () => {
  assert.equal(
    hasToken('Done!\n<promise>EPIC_COMPLETED</promise>\nGoodbye.', 'EPIC_COMPLETED'),
    true
  );
});

test('hasToken: whitespace inside tags IS matched (tolerant)', () => {
  assert.equal(hasToken('<promise> EPIC_COMPLETED </promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: empty text never matches', () => {
  assert.equal(hasToken('', 'EPIC_COMPLETED'), false);
});

test('hasToken: empty token never matches', () => {
  assert.equal(hasToken('<promise></promise>', ''), false);
});

test('hasToken: partial token not matched', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETE</promise>', 'EPIC_COMPLETED'), false);
});

// ---------------------------------------------------------------------------
// PromiseTokens shape
// ---------------------------------------------------------------------------

test('PromiseTokens: all expected keys are defined', () => {
  const required = [
    'EPIC_COMPLETED',
    'TASK_COMPLETED',
    'WORKER_DONE',
    'PRD_COMPLETE',
    'TICKET_SELECTED',
    'ANALYSIS_DONE',
    'EXISTENCE_IS_PAIN',
    'THE_CITADEL_APPROVES',
  ];
  for (const key of required) {
    assert.ok(key in PromiseTokens, `Missing PromiseTokens.${key}`);
    assert.equal(typeof PromiseTokens[key], 'string', `PromiseTokens.${key} must be a string`);
    assert.ok(PromiseTokens[key].length > 0, `PromiseTokens.${key} must not be empty`);
  }
});

test('PromiseTokens: WORKER_DONE is "I AM DONE"', () => {
  assert.equal(PromiseTokens.WORKER_DONE, 'I AM DONE');
});

test('PromiseTokens: each token self-detects via hasToken', () => {
  for (const [key, token] of Object.entries(PromiseTokens)) {
    assert.equal(
      hasToken(`<promise>${token}</promise>`, token),
      true,
      `PromiseTokens.${key} ("${token}") must self-detect`
    );
  }
});

test('PromiseTokens: each token wrapped by wrapToken is detected by hasToken', () => {
  for (const [key, token] of Object.entries(PromiseTokens)) {
    assert.equal(
      hasToken(wrapToken(token), token),
      true,
      `wrapToken(PromiseTokens.${key}) must be detected by hasToken`
    );
  }
});

test('hasToken: uses PromiseTokens.WORKER_DONE to detect "I AM DONE"', () => {
  assert.equal(
    hasToken('<promise>I AM DONE</promise>', PromiseTokens.WORKER_DONE),
    true
  );
});

test('hasToken: leading whitespace inside tags matched', () => {
  assert.equal(hasToken('<promise>  EPIC_COMPLETED</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: trailing whitespace inside tags matched', () => {
  assert.equal(hasToken('<promise>EPIC_COMPLETED  </promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: newline inside tags matched', () => {
  assert.equal(hasToken('<promise>\nEPIC_COMPLETED\n</promise>', 'EPIC_COMPLETED'), true);
});

test('hasToken: tab inside tags matched', () => {
  assert.equal(hasToken('<promise>\tEPIC_COMPLETED\t</promise>', 'EPIC_COMPLETED'), true);
});

test('PromiseTokens: ANALYSIS_DONE is "ANALYSIS_DONE"', () => {
  assert.equal(PromiseTokens.ANALYSIS_DONE, 'ANALYSIS_DONE');
});

test('hasToken: detects ANALYSIS_DONE with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> ANALYSIS_DONE </promise>', PromiseTokens.ANALYSIS_DONE), true);
});

test('PromiseTokens: EXISTENCE_IS_PAIN is "EXISTENCE_IS_PAIN"', () => {
  assert.equal(PromiseTokens.EXISTENCE_IS_PAIN, 'EXISTENCE_IS_PAIN');
});

test('hasToken: detects EXISTENCE_IS_PAIN with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> EXISTENCE_IS_PAIN </promise>', PromiseTokens.EXISTENCE_IS_PAIN), true);
});

test('PromiseTokens: THE_CITADEL_APPROVES is "THE_CITADEL_APPROVES"', () => {
  assert.equal(PromiseTokens.THE_CITADEL_APPROVES, 'THE_CITADEL_APPROVES');
});

test('hasToken: detects THE_CITADEL_APPROVES with whitespace tolerance', () => {
  assert.equal(hasToken('<promise> THE_CITADEL_APPROVES </promise>', PromiseTokens.THE_CITADEL_APPROVES), true);
});

// ---------------------------------------------------------------------------
// PROMISE_TOKENS constants module
// ---------------------------------------------------------------------------

test('PROMISE_TOKENS: has exactly 8 entries', () => {
  assert.equal(PROMISE_TOKENS.length, 8);
});

test('PROMISE_TOKENS: contains all expected key names', () => {
  const expected = [
    'EPIC_COMPLETED',
    'TASK_COMPLETED',
    'ANALYSIS_DONE',
    'EXISTENCE_IS_PAIN',
    'THE_CITADEL_APPROVES',
    'WORKER_DONE',
    'PRD_COMPLETE',
    'TICKET_SELECTED',
  ];
  for (const name of expected) {
    assert.ok(PROMISE_TOKENS.includes(name), `Missing ${name} from PROMISE_TOKENS`);
  }
});

test('PROMISE_TOKENS: every key name exists as a key in PromiseTokens object', () => {
  for (const key of PROMISE_TOKENS) {
    assert.ok(key in PromiseTokens, `PROMISE_TOKENS key "${key}" not found in PromiseTokens object`);
  }
});

test('PROMISE_TOKENS: no duplicate entries', () => {
  const seen = new Set();
  for (const name of PROMISE_TOKENS) {
    assert.ok(!seen.has(name), `Duplicate entry "${name}" in PROMISE_TOKENS`);
    seen.add(name);
  }
});

// ---------------------------------------------------------------------------
// FORBIDDEN_WORKER_TOKENS / scrubForbiddenWorkerTokens
//
// Regression: a codex worker on the god-fn epic emitted
// `<promise>EPIC_COMPLETED</promise>` instead of `<promise>I AM DONE</promise>`,
// which the manager parrotted into the iteration log. mux-runner's pending-
// tickets fail-loud guard then killed a 74-minute pipeline. The scrub helper
// rewrites worker-emitted forbidden tokens before the manager (or any other
// downstream reader) sees them.
// ---------------------------------------------------------------------------

test('FORBIDDEN_WORKER_TOKENS: does NOT contain WORKER_DONE token "I AM DONE"', () => {
  // The worker's only valid completion signal is `I AM DONE`. Adding it to the
  // forbidden list would scrub legitimate completions into themselves and
  // potentially confuse downstream consumers.
  assert.ok(!FORBIDDEN_WORKER_TOKENS.includes('I AM DONE'),
    'FORBIDDEN_WORKER_TOKENS must NOT include the worker\'s legitimate completion token');
  assert.ok(!FORBIDDEN_WORKER_TOKENS.includes('WORKER_DONE'),
    'FORBIDDEN_WORKER_TOKENS must NOT include WORKER_DONE');
});

test('FORBIDDEN_WORKER_TOKENS: contains EPIC_COMPLETED (the live-bug token)', () => {
  assert.ok(FORBIDDEN_WORKER_TOKENS.includes('EPIC_COMPLETED'),
    'EPIC_COMPLETED must be in the forbidden list — this was the actual production failure mode');
});

test('FORBIDDEN_WORKER_TOKENS: contains every orchestrator-only token', () => {
  for (const expected of [
    'EPIC_COMPLETED',
    'TASK_COMPLETED',
    'PRD_COMPLETE',
    'TICKET_SELECTED',
    'EXISTENCE_IS_PAIN',
    'THE_CITADEL_APPROVES',
    'ANALYSIS_DONE',
  ]) {
    assert.ok(FORBIDDEN_WORKER_TOKENS.includes(expected),
      `FORBIDDEN_WORKER_TOKENS missing ${expected}`);
  }
});

test('scrubForbiddenWorkerTokens: rewrites EPIC_COMPLETED → I AM DONE (the live bug)', () => {
  const input = 'doing stuff\n<promise>EPIC_COMPLETED</promise>\nbye';
  const result = scrubForbiddenWorkerTokens(input);
  assert.equal(result.scrubbed, 'doing stuff\n<promise>I AM DONE</promise>\nbye');
  assert.equal(result.replacements.EPIC_COMPLETED, 1);
});

test('scrubForbiddenWorkerTokens: leaves I AM DONE untouched (worker\'s legitimate token)', () => {
  const input = '<promise>I AM DONE</promise>';
  const result = scrubForbiddenWorkerTokens(input);
  assert.equal(result.scrubbed, input);
  assert.deepEqual(result.replacements, {});
});

test('scrubForbiddenWorkerTokens: handles whitespace-tolerant variants like hasToken', () => {
  const input = '<promise>  EPIC_COMPLETED \n</promise>';
  const result = scrubForbiddenWorkerTokens(input);
  assert.equal(result.scrubbed, '<promise>I AM DONE</promise>');
  assert.equal(result.replacements.EPIC_COMPLETED, 1);
});

test('scrubForbiddenWorkerTokens: rewrites every forbidden token in one pass', () => {
  const input = [
    '<promise>EPIC_COMPLETED</promise>',
    '<promise>TASK_COMPLETED</promise>',
    '<promise>PRD_COMPLETE</promise>',
    '<promise>TICKET_SELECTED</promise>',
    '<promise>EXISTENCE_IS_PAIN</promise>',
    '<promise>THE_CITADEL_APPROVES</promise>',
    '<promise>ANALYSIS_DONE</promise>',
  ].join('\n');
  const result = scrubForbiddenWorkerTokens(input);
  for (const tok of FORBIDDEN_WORKER_TOKENS) {
    assert.ok(!result.scrubbed.includes(`<promise>${tok}</promise>`),
      `scrubbed output still contains <promise>${tok}</promise>`);
    assert.equal(result.replacements[tok], 1, `expected exactly 1 replacement for ${tok}`);
  }
  // Every forbidden line should now be I AM DONE
  const matches = result.scrubbed.match(/<promise>I AM DONE<\/promise>/g) || [];
  assert.equal(matches.length, FORBIDDEN_WORKER_TOKENS.length);
});

test('scrubForbiddenWorkerTokens: counts repeated forbidden tokens', () => {
  const input = '<promise>EPIC_COMPLETED</promise>\n<promise>EPIC_COMPLETED</promise>';
  const result = scrubForbiddenWorkerTokens(input);
  assert.equal(result.replacements.EPIC_COMPLETED, 2);
  assert.equal((result.scrubbed.match(/<promise>I AM DONE<\/promise>/g) || []).length, 2);
});

test('scrubForbiddenWorkerTokens: empty input yields empty output, no replacements', () => {
  const result = scrubForbiddenWorkerTokens('');
  assert.equal(result.scrubbed, '');
  assert.deepEqual(result.replacements, {});
});

test('scrubForbiddenWorkerTokens: pure (no globals, no I/O)', () => {
  // Run twice — same input must yield identical output (no internal state).
  const input = '<promise>EPIC_COMPLETED</promise>';
  const a = scrubForbiddenWorkerTokens(input);
  const b = scrubForbiddenWorkerTokens(input);
  assert.deepEqual(a, b);
});

test('scrubForbiddenWorkerTokens: idempotent (rescrubbing clean output is a fixed point)', () => {
  const input = '<promise>EPIC_COMPLETED</promise>';
  const first = scrubForbiddenWorkerTokens(input);
  const second = scrubForbiddenWorkerTokens(first.scrubbed);
  assert.equal(second.scrubbed, first.scrubbed);
  assert.deepEqual(second.replacements, {});
});

test('scrubForbiddenWorkerTokens: does NOT match partial token strings', () => {
  // Mention of EPIC_COMPLETED in plain text (e.g. a code comment) is NOT
  // wrapped in <promise>...</promise> tags, so it must be left alone.
  const input = 'The orchestrator emits EPIC_COMPLETED when the epic is done.';
  const result = scrubForbiddenWorkerTokens(input);
  assert.equal(result.scrubbed, input);
  assert.deepEqual(result.replacements, {});
});
