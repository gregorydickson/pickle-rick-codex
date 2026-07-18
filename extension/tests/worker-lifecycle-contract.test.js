// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKER_LIFECYCLE_PHASES,
  prepareWorkerLifecycleArtifact,
  readAndValidateWorkerLifecycleArtifact,
  serializeApprovedWorkerContext,
  workerLifecycleArtifactPath,
} from '../services/worker-lifecycle.js';

const ticketId = 'ticket-7';
const acceptanceCriteria = ['preserves behavior', 'keeps fast tests green'];

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-lifecycle-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifact(phase, overrides = {}) {
  return {
    schema_version: 1,
    phase,
    ticket_id: ticketId,
    summary: `${phase} completed`,
    ...overrides,
  };
}

function writeArtifact(t, phase, value) {
  const filePath = workerLifecycleArtifactPath(tempRoot(t), ticketId, phase);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  return filePath;
}

test('worker lifecycle exposes its ordered eight-phase contract', () => {
  assert.deepEqual(WORKER_LIFECYCLE_PHASES, [
    'research',
    'research_review',
    'plan',
    'plan_review',
    'implement',
    'review',
    'simplify',
    'conformance',
  ]);
});

test('workerLifecycleArtifactPath and prepareWorkerLifecycleArtifact create a clean destination', (t) => {
  const root = tempRoot(t);
  const filePath = workerLifecycleArtifactPath(root, ticketId, 'research');
  assert.equal(filePath, path.join(root, 'worker-lifecycle', ticketId, 'research.json'));

  prepareWorkerLifecycleArtifact(filePath);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  fs.writeFileSync(filePath, 'stale');
  prepareWorkerLifecycleArtifact(filePath);

  assert.equal(fs.existsSync(filePath), false);
});

test('readAndValidateWorkerLifecycleArtifact accepts every valid phase schema', (t) => {
  const validArtifacts = {
    research: artifact('research', { evidence: ['source inspection'] }),
    research_review: artifact('research_review', { verdict: 'approved', evidence: ['research is sufficient'] }),
    plan: artifact('plan', { steps: ['add focused tests'] }),
    plan_review: artifact('plan_review', { verdict: 'approved', evidence: ['plan is safe'] }),
    implement: artifact('implement', { files_changed: [], verification: ['node --test'] }),
    review: artifact('review', {
      verdict: 'approved',
      evidence: ['implementation inspected'],
      implementation_reviewed: true,
    }),
    simplify: artifact('simplify', { verification: ['no unnecessary complexity'] }),
    conformance: artifact('conformance', {
      verdict: 'all_pass',
      implementation_reviewed: true,
      acceptance_criteria: acceptanceCriteria.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: `${criterion} verified`,
      })),
    }),
  };

  for (const phase of WORKER_LIFECYCLE_PHASES) {
    const expected = validArtifacts[phase];
    const filePath = writeArtifact(t, phase, expected);
    assert.deepEqual(
      readAndValidateWorkerLifecycleArtifact(filePath, phase, ticketId, acceptanceCriteria),
      expected,
    );
  }
});

test('artifact validation rejects missing files, invalid JSON, and non-object JSON', (t) => {
  const missing = workerLifecycleArtifactPath(tempRoot(t), ticketId, 'research');
  assert.throws(
    () => readAndValidateWorkerLifecycleArtifact(missing, 'research', ticketId, acceptanceCriteria),
    /worker-lifecycle-missing-artifact/,
  );

  const invalidJson = writeArtifact(t, 'research', '{');
  assert.throws(
    () => readAndValidateWorkerLifecycleArtifact(invalidJson, 'research', ticketId, acceptanceCriteria),
    (error) => error.message.includes('wrote invalid JSON') && error.cause instanceof SyntaxError,
  );

  const arrayJson = writeArtifact(t, 'research', []);
  assert.throws(
    () => readAndValidateWorkerLifecycleArtifact(arrayJson, 'research', ticketId, acceptanceCriteria),
    /artifact must be a JSON object/,
  );
});

test('artifact validation rejects mismatched identity and blank summaries', (t) => {
  for (const invalid of [
    artifact('research', { schema_version: 2, evidence: ['evidence'] }),
    artifact('plan', { steps: ['step'] }),
    artifact('research', { ticket_id: 'other', evidence: ['evidence'] }),
  ]) {
    const filePath = writeArtifact(t, 'research', invalid);
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(filePath, 'research', ticketId, acceptanceCriteria),
      /artifact identity does not match/,
    );
  }

  const blankSummary = writeArtifact(t, 'research', artifact('research', {
    summary: '   ',
    evidence: ['evidence'],
  }));
  assert.throws(
    () => readAndValidateWorkerLifecycleArtifact(blankSummary, 'research', ticketId, acceptanceCriteria),
    /non-empty summary/,
  );
});

test('phase validation rejects incomplete research, planning, implementation, and simplification artifacts', (t) => {
  const cases = [
    ['research', artifact('research', { evidence: [] }), /research must include non-empty evidence/],
    ['plan', artifact('plan', { steps: ['   '] }), /plan must include non-empty steps/],
    ['implement', artifact('implement', { files_changed: 'file.js', verification: ['pass'] }), /implement must include/],
    ['simplify', artifact('simplify', { verification: [] }), /simplify must include non-empty verification/],
  ];

  for (const [phase, value, expected] of cases) {
    const filePath = writeArtifact(t, phase, value);
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(filePath, phase, ticketId, acceptanceCriteria),
      expected,
    );
  }
});

test('review validation requires approval, evidence, and implementation inspection', (t) => {
  const cases = [
    artifact('review', { verdict: 'changes_requested', evidence: ['finding'], implementation_reviewed: true }),
    artifact('review', { verdict: 'approved', evidence: [], implementation_reviewed: true }),
    artifact('review', { verdict: 'approved', evidence: ['reviewed'], implementation_reviewed: false }),
  ];
  const expected = [/verdict "approved"/, /non-empty evidence/, /confirm implementation_reviewed/];

  cases.forEach((value, index) => {
    const filePath = writeArtifact(t, 'review', value);
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(filePath, 'review', ticketId, acceptanceCriteria),
      expected[index],
    );
  });
});

test('research and plan reviews share the approved-review contract', (t) => {
  for (const phase of ['research_review', 'plan_review']) {
    const filePath = writeArtifact(t, phase, artifact(phase, {
      verdict: 'approved',
      evidence: [''],
    }));
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(filePath, phase, ticketId, acceptanceCriteria),
      new RegExp(`${phase} must include non-empty evidence`),
    );
  }
});

test('conformance validation requires implementation review and exact evidenced criteria', (t) => {
  const base = {
    verdict: 'all_pass',
    implementation_reviewed: true,
    acceptance_criteria: acceptanceCriteria.map((criterion) => ({
      criterion,
      status: 'pass',
      evidence: 'verified',
    })),
  };
  const cases = [
    [artifact('conformance', { ...base, verdict: 'failed' }), /record all_pass/],
    [artifact('conformance', { ...base, implementation_reviewed: false }), /record all_pass/],
    [artifact('conformance', { ...base, acceptance_criteria: base.acceptance_criteria.slice(0, 1) }), /pass every exact/],
    [artifact('conformance', {
      ...base,
      acceptance_criteria: base.acceptance_criteria.map((check, index) => (
        index === 0 ? { ...check, status: 'fail' } : check
      )),
    }), /pass every exact/],
    [artifact('conformance', {
      ...base,
      acceptance_criteria: base.acceptance_criteria.map((check, index) => (
        index === 0 ? { ...check, evidence: ' ' } : check
      )),
    }), /pass every exact/],
  ];

  for (const [value, expected] of cases) {
    const filePath = writeArtifact(t, 'conformance', value);
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(filePath, 'conformance', ticketId, acceptanceCriteria),
      expected,
    );
  }
});

test('serializeApprovedWorkerContext handles empty and ordered approved context', () => {
  assert.equal(
    serializeApprovedWorkerContext([]),
    'No earlier lifecycle artifacts exist for this phase.',
  );

  const approved = [
    artifact('research', { evidence: ['source inspection'] }),
    artifact('plan', { steps: ['add tests'] }),
  ];
  const serialized = serializeApprovedWorkerContext(approved);
  assert.match(serialized, /^Approved research artifact:/);
  assert.match(serialized, /"evidence": \[/);
  assert.match(serialized, /\n\nApproved plan artifact:/);
  assert.match(serialized, /"steps": \[/);
});
