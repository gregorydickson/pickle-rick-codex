// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreflightError,
  VerificationContractError,
  assertTicketVerificationReady,
  describeVerificationContract,
  isPreflightError,
  isVerificationContractError,
  normalizeVerificationEnvContract,
  resolveTicketVerificationContract,
  resolveVerificationEnv,
} from '../services/verification-env.js';

test('normalizeVerificationEnvContract canonicalizes aliases, formats, variables, and mode', () => {
  assert.equal(normalizeVerificationEnvContract(null), null);
  assert.equal(normalizeVerificationEnvContract('[]'), null);

  const contract = normalizeVerificationEnvContract(JSON.stringify({
    mode: 'replace',
    required: ['TOKEN', { name: ' ENDPOINT ', format: 'url' }, { name: '' }, 42],
    requiredEnv: [{ name: 'TOKEN', format: 'url' }, ' CACHE '],
    vars: {
      LITERAL: { value: 17 },
      EMPTY: { value: null },
      COPIED: { fromEnv: ' SOURCE ' },
      JSON_SPEC: '{"from_env":"JSON_SOURCE"}',
      BOOLEAN: true,
      INVALID: [],
    },
  }));

  assert.deepEqual(contract, {
    mode: 'replace',
    required: [
      { name: 'TOKEN', format: 'url' },
      { name: 'ENDPOINT', format: 'url' },
      { name: 'CACHE', format: 'string' },
    ],
    vars: {
      LITERAL: { type: 'literal', value: '17' },
      EMPTY: { type: 'literal', value: '' },
      COPIED: { type: 'env', fromEnv: 'SOURCE' },
      JSON_SPEC: { type: 'env', fromEnv: 'JSON_SOURCE' },
      BOOLEAN: { type: 'literal', value: 'true' },
    },
  });
  assert.equal(normalizeVerificationEnvContract({ mode: 'unknown' }).mode, 'inherit');
});

test('resolveTicketVerificationContract merges defaults, ticket aliases, and inferred requirements', () => {
  const contract = resolveTicketVerificationContract({
    config: {
      defaults: {
        verification_env: {
          mode: 'merge',
          required: ['BASE_TOKEN', { name: 'SHARED', format: 'url' }],
          vars: { FROM_BASE: { value: 'base' }, SHARED_VAR: { value: 'base' } },
        },
      },
    },
    ticket: {
      verificationEnv: {
        mode: 'replace',
        requiredEnv: ['TICKET_TOKEN', { name: 'SHARED', format: 'string' }],
        vars: { SHARED_VAR: { value: 'ticket' }, DECLARED: { from_env: 'SOURCE' } },
      },
      verification: [
        'TOKEN=local echo "$TOKEN" "$REAL_TOKEN" "${OPTIONAL:-fallback}" "$PATH"',
        'npm run check:env',
      ],
    },
  });

  assert.equal(contract.mode, 'replace');
  assert.deepEqual(contract.required, [
    { name: 'BASE_TOKEN', format: 'string' },
    { name: 'SHARED', format: 'string' },
    { name: 'TICKET_TOKEN', format: 'string' },
    { name: 'REAL_TOKEN', format: 'string' },
    { name: 'ATTRACTOR_ROOT', format: 'string' },
    { name: 'DIPPIN_ROOT', format: 'string' },
  ]);
  assert.deepEqual(contract.vars, {
    FROM_BASE: { type: 'literal', value: 'base' },
    SHARED_VAR: { type: 'literal', value: 'ticket' },
    DECLARED: { type: 'env', fromEnv: 'SOURCE' },
  });
});

test('legacy required_env declarations and absent contracts retain their public semantics', () => {
  assert.equal(resolveTicketVerificationContract({ ticket: {}, config: null }), null);
  assert.deepEqual(resolveTicketVerificationContract({
    ticket: { required_env: ' LEGACY_TOKEN ' },
    config: null,
  }), {
    mode: 'inherit',
    required: [{ name: 'LEGACY_TOKEN', format: 'string' }],
    vars: {},
  });
});

test('resolveVerificationEnv isolates replace mode, resolves variables, and reports bad requirements', () => {
  const resolved = resolveVerificationEnv({
    ticket: {
      verification_env: {
        mode: 'replace',
        required: [
          'MISSING',
          { name: 'BAD_URL', format: 'url' },
          { name: 'GOOD_URL', format: 'url' },
        ],
        vars: {
          COPIED: { from_env: 'SOURCE' },
          FIXED: { value: 'literal' },
          BAD_URL: { from_env: 'BAD_URL' },
          GOOD_URL: { from_env: 'GOOD_URL' },
        },
      },
    },
    config: null,
    cwd: '/tmp',
    ambientEnv: {
      HOME: '/safe-home',
      PATH: '/safe-bin',
      SECRET: 'must-not-leak',
      SOURCE: 'copied-value',
      BAD_URL: 'not a url',
      GOOD_URL: 'https://example.test/path',
    },
  });

  assert.equal(resolved.env.HOME, '/safe-home');
  assert.equal(resolved.env.PATH, '/safe-bin');
  assert.equal(resolved.env.SECRET, undefined);
  assert.equal(resolved.env.SOURCE, undefined);
  assert.equal(resolved.env.COPIED, 'copied-value');
  assert.equal(resolved.env.FIXED, 'literal');
  assert.deepEqual(resolved.diagnostics.map(({ kind, name }) => ({ kind, name })), [
    { kind: 'preflight-missing-env', name: 'MISSING' },
    { kind: 'preflight-invalid-env', name: 'BAD_URL' },
  ]);
});

test('assertTicketVerificationReady throws a typed first-diagnostic error and returns ready contracts', () => {
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R-ENV', requiredEnv: 'TOKEN' },
      config: null,
      ambientEnv: {},
      cwd: '/tmp',
    }),
    (error) => {
      assert.equal(isPreflightError(error), true);
      assert.equal(error.name, 'PreflightError');
      assert.equal(error.kind, 'preflight-missing-env');
      assert.equal(error.ticketId, 'R-ENV');
      assert.equal(error.prerequisite, 'TOKEN');
      return true;
    },
  );

  const ready = assertTicketVerificationReady({
    ticket: { id: 'R-READY', requiredEnv: 'TOKEN' },
    config: null,
    ambientEnv: { TOKEN: 'present' },
    cwd: '/tmp',
  });
  assert.deepEqual(ready.diagnostics, []);
  assert.equal(ready.env.TOKEN, 'present');
});

test('verification error predicates and contract descriptions expose stable operator context', () => {
  const preflight = new PreflightError({
    kind: 'preflight-missing-env',
    ticketId: '',
    prerequisite: '',
    message: 'TOKEN is required',
  });
  const contractError = new VerificationContractError({
    ticketId: 'R-VERIFY',
    command: 'npm test',
    message: 'command escaped ticket scope',
  });

  assert.equal(isPreflightError(preflight), true);
  assert.equal(isPreflightError(contractError), false);
  assert.equal(preflight.ticketId, null);
  assert.equal(preflight.prerequisite, null);
  assert.equal(isVerificationContractError(contractError), true);
  assert.equal(isVerificationContractError(new Error('nope')), false);
  assert.equal(contractError.kind, 'verification-contract-failed');
  assert.equal(contractError.ticketId, 'R-VERIFY');
  assert.equal(contractError.command, 'npm test');
  assert.equal(describeVerificationContract(null), '');
  assert.equal(describeVerificationContract({
    mode: 'replace',
    required: [
      { name: 'TOKEN', format: 'string' },
      { name: 'ENDPOINT', format: 'url' },
    ],
    vars: {
      FIXED: { type: 'literal', value: 'value' },
      COPIED: { type: 'env', fromEnv: 'SOURCE' },
    },
  }), [
    'mode: replace',
    'required: TOKEN, ENDPOINT (url)',
    'vars: FIXED <- "value", COPIED <- $SOURCE',
  ].join('\n'));
});
