// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import { enqueueCitadelRemediation, reconcileCitadelRemediation } from '../services/citadel-remediation.js';
import { readManifest } from '../services/tickets.js';

function ticket(id, ownedPath, criterion, dependsOn = []) {
  return {
    id,
    title: `${id} ticket`,
    description: `Implement ${id}.`,
    acceptance_criteria: [criterion],
    verification: ['node -e "process.exit(0)"'],
    allowed_paths: [ownedPath],
    depends_on: dependsOn,
    priority: 'P1',
    status: 'Done',
    completion_commit: `${id.charCodeAt(0).toString(16).repeat(7)}`,
  };
}

function multiTicketSession() {
  const sessionDir = makeTempRoot('citadel-remediation-slice-');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      ticket('affected', 'src/affected.ts', 'Affected behavior remains correct.'),
      ticket('independent', 'src/independent.ts', 'Independent behavior remains correct.'),
      ticket('dependent', 'src/dependent.ts', 'Dependent behavior consumes affected output.', ['affected']),
    ],
  });
  return sessionDir;
}

test('Citadel remediation resets one attributed ticket and true dependents only', () => {
  const sessionDir = multiTicketSession();
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [
      'Affected behavior remains correct.',
      'Independent behavior remains correct.',
      'Dependent behavior consumes affected output.',
    ],
    findings: [{
      severity: 'high',
      title: 'Affected implementation violates its contract.',
      evidence: 'src/affected.ts does not satisfy the affected criterion.',
      file: 'src/affected.ts',
      ticket_ids: ['affected'],
      acceptance_criteria: ['Affected behavior remains correct.'],
      paths: ['src/affected.ts'],
      recommendation: 'Repair only the affected implementation and revalidate its dependent.',
    }],
  });

  const archivePath = enqueueCitadelRemediation(sessionDir);
  const byId = Object.fromEntries(readManifest(sessionDir).tickets.map((entry) => [entry.id, entry]));
  assert.equal(byId.affected.status, 'Todo');
  assert.equal(byId.dependent.status, 'Todo');
  assert.equal(byId.independent.status, 'Done');
  assert.equal(byId.independent.completion_commit, '69696969696969');
  const intent = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-remediation-current.json'), 'utf8'));
  assert.equal(intent.schema_version, 3);
  assert.deepEqual(intent.direct_ticket_ids, ['affected']);
  assert.deepEqual(intent.ticket_ids, ['affected', 'dependent']);
  assert.deepEqual(intent.affected_tickets.map(({ id, role }) => ({ id, role })), [
    { id: 'affected', role: 'direct' },
    { id: 'dependent', role: 'dependent' },
  ]);
  assert.deepEqual(intent.finding_attribution, [{
    finding_index: 0,
    ticket_ids: ['affected'],
    criteria: [{ value: 'Affected behavior remains correct.', ticket_ids: ['affected'] }],
    paths: [{ value: 'src/affected.ts', ticket_ids: ['affected'] }],
    method: 'explicit_ticket',
  }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(archivePath, 'utf8')).findings[0].evidence,
    'src/affected.ts does not satisfy the affected criterion.');
});

test('ambiguous Citadel attribution preserves refusal evidence and completed tickets', () => {
  const sessionDir = multiTicketSession();
  const report = {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{ severity: 'high', title: 'Cross-cutting concern.', evidence: 'The release proof is incomplete.' }],
  };
  writeJson(path.join(sessionDir, 'citadel-report.json'), report);
  assert.throws(() => enqueueCitadelRemediation(sessionDir), /attribution is ambiguous.*archived/);
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Done', 'Done', 'Done']);
  const blocked = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-remediation-attribution-blocked.json'), 'utf8'));
  assert.equal(blocked.failure_kind, 'citadel_attribution_ambiguous');
  assert.deepEqual(JSON.parse(fs.readFileSync(blocked.archive_path, 'utf8')), report);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});

test('schema-2 pending remediation migrates durably on restart without widening its ticket slice', () => {
  const sessionDir = multiTicketSession();
  const archivePath = path.join(sessionDir, 'citadel-remediation', 'legacy-report.json');
  const findings = [{ severity: 'high', title: 'Legacy finding.', evidence: 'Preserve me.' }];
  writeJson(archivePath, { schema_version: 1, verdict: 'block', findings, acceptance_criteria_checked: [] });
  writeJson(path.join(sessionDir, 'citadel-remediation-pending.json'), {
    schema_version: 2,
    failure_kind: 'citadel_refused',
    archive_path: archivePath,
    report_path: path.join(sessionDir, 'citadel-report.json'),
    ticket_ids: ['affected'],
    affected_tickets: [{ id: 'affected', acceptance_criteria: ['Affected behavior remains correct.'] }],
    findings,
    acceptance_criteria_checked: [],
    summary: 'Legacy finding.',
    enqueued_at: '2026-08-08T01:00:00.000Z',
  });

  assert.equal(reconcileCitadelRemediation(sessionDir), true);
  const intent = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-remediation-current.json'), 'utf8'));
  assert.equal(intent.schema_version, 3);
  assert.deepEqual(intent.ticket_ids, ['affected']);
  assert.equal(intent.finding_attribution[0].method, 'legacy');
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Todo', 'Done', 'Done']);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
});
