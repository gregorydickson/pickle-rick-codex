// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAcPhaseBoundary } from '../services/ac-phase-gate.js';

function artifact(phase, extra = {}) {
  return { schema_version: 1, phase, ticket_id: 'r1', summary: phase, ...extra };
}

test('AC phase gate requires approved lifecycle boundaries before implementation', () => {
  assert.throws(
    () => assertAcPhaseBoundary('implement', artifact('implement'), [artifact('plan')], ['AC one']),
    /missing lifecycle evidence: plan_review/,
  );
  assert.doesNotThrow(() => assertAcPhaseBoundary(
    'implement',
    artifact('implement'),
    [artifact('research'), artifact('research_review'), artifact('plan'), artifact('plan_review')],
    ['AC one'],
  ));
});

test('AC phase gate requires exact conformance evidence for every criterion', () => {
  const prior = [artifact('implement'), artifact('review'), artifact('simplify')];
  const criteria = ['Exact AC one', 'Exact AC two'];
  assert.throws(
    () => assertAcPhaseBoundary('conformance', artifact('conformance', {
      acceptance_criteria: [{ criterion: 'Exact AC one', status: 'pass', evidence: 'test A' }],
    }), prior, criteria),
    /exact acceptance-criterion evidence/,
  );
  assert.doesNotThrow(() => assertAcPhaseBoundary('conformance', artifact('conformance', {
    acceptance_criteria: criteria.map((criterion) => ({ criterion, status: 'pass', evidence: `verified ${criterion}` })),
  }), prior, criteria));
});
