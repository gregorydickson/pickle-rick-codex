// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  enqueueCitadelRemediation,
  enqueueCitadelRemediationResult,
  repairCitadelAttribution,
  reconcileCitadelAttributionRepair,
  reconcileCitadelRemediation,
} from '../services/citadel-remediation.js';
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

test('ambiguous Citadel attribution schedules durable repair without resetting tickets', () => {
  const sessionDir = multiTicketSession();
  const report = {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{ severity: 'high', title: 'Cross-cutting concern.', evidence: 'The release proof is incomplete.' }],
  };
  writeJson(path.join(sessionDir, 'citadel-report.json'), report);
  const result = enqueueCitadelRemediationResult(sessionDir);
  assert.equal(result.kind, 'attribution_repair_scheduled');
  assert.deepEqual(result.candidate_ticket_ids, ['affected', 'independent', 'dependent']);
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Done', 'Done', 'Done']);
  const repair = JSON.parse(fs.readFileSync(result.repair_intent_path, 'utf8'));
  assert.equal(repair.schema_version, 3);
  assert.equal(repair.failure_kind, 'citadel_attribution_repair_required');
  assert.equal(repair.status, 'pending');
  assert.match(repair.repair_task, /Attribute each preserved blocking finding/);
  assert.deepEqual(repair.candidate_ticket_ids, ['affected', 'independent', 'dependent']);
  assert.deepEqual(JSON.parse(fs.readFileSync(repair.archive_path, 'utf8')), report);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);

  const archiveCount = fs.readdirSync(path.join(sessionDir, 'citadel-remediation')).length;
  const resumed = enqueueCitadelRemediationResult(sessionDir);
  assert.equal(resumed.kind, 'attribution_repair_scheduled');
  assert.equal(resumed.archive_path, result.archive_path);
  assert.equal(fs.readdirSync(path.join(sessionDir, 'citadel-remediation')).length, archiveCount);
  assert.deepEqual(reconcileCitadelAttributionRepair(sessionDir), repair);
});

test('Citadel attribution resolves criterion IDs and ticket-owned paths without explicit ticket ids', () => {
  const sessionDir = multiTicketSession();
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  manifest.tickets[0].acceptance_criteria = ['AC-AFFECTED: Affected behavior remains correct.'];
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), manifest);
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{
      severity: 'high',
      title: 'Affected implementation violates its contract.',
      evidence: 'The affected implementation is incomplete.',
      acceptance_criteria: ['AC-AFFECTED'],
      paths: ['src/affected.ts'],
    }],
  });

  const result = enqueueCitadelRemediationResult(sessionDir);
  assert.equal(result.kind, 'remediation_enqueued');
  assert.deepEqual(result.ticket_ids, ['affected', 'dependent']);
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Todo', 'Done', 'Todo']);
});

test('legacy ambiguous attribution state migrates to restart-safe typed repair intent', () => {
  const sessionDir = multiTicketSession();
  const archivePath = path.join(sessionDir, 'citadel-remediation', 'ambiguous-report.json');
  const report = {
    schema_version: 1,
    verdict: 'block',
    findings: [{ severity: 'high', title: 'Cross-cutting concern.', evidence: 'Proof is incomplete.' }],
    acceptance_criteria_checked: [],
  };
  writeJson(archivePath, report);
  writeJson(path.join(sessionDir, 'citadel-remediation-attribution-blocked.json'), {
    schema_version: 1,
    failure_kind: 'citadel_attribution_ambiguous',
    archive_path: archivePath,
    report_path: path.join(sessionDir, 'citadel-report.json'),
    findings: report.findings,
    acceptance_criteria_checked: [],
    reason: 'finding 1 cannot be attributed to exactly one completed ticket',
    recorded_at: '2026-08-08T01:00:00.000Z',
  });

  assert.equal(reconcileCitadelRemediation(sessionDir), false);
  const migrated = reconcileCitadelAttributionRepair(sessionDir);
  assert.equal(migrated.schema_version, 3);
  assert.equal(migrated.failure_kind, 'citadel_attribution_repair_required');
  assert.deepEqual(migrated.candidate_ticket_ids, ['affected', 'independent', 'dependent']);
  assert.equal(migrated.archive_path, archivePath);
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Done', 'Done', 'Done']);
});

test('deterministic attribution repair narrows evidence and preserves unrelated Done checkpoints', async () => {
  const sessionDir = multiTicketSession();
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{
      severity: 'high',
      title: 'Affected contract evidence is invalid.',
      evidence: 'Affected behavior remains correct.',
      acceptance_criteria: ['Affected behavior remains correct.'],
      paths: ['not-owned/invalid.ts'],
    }],
  });
  assert.equal(enqueueCitadelRemediationResult(sessionDir).kind, 'attribution_repair_scheduled');

  const result = await repairCitadelAttribution(sessionDir);
  assert.equal(result.kind, 'remediation_enqueued');
  assert.deepEqual(result.ticket_ids, ['affected', 'dependent']);
  const byId = Object.fromEntries(readManifest(sessionDir).tickets.map((entry) => [entry.id, entry]));
  assert.equal(byId.affected.status, 'Todo');
  assert.equal(byId.dependent.status, 'Todo');
  assert.equal(byId.independent.status, 'Done');
  assert.equal(byId.independent.completion_commit, '69696969696969');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-attribution-blocked.json')), false);
});

test('strict attribution artifact converges narrowly and invalid retries use novel durable strategies', async () => {
  const sessionDir = multiTicketSession();
  const report = {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{ severity: 'high', title: 'Cross-cutting concern.', evidence: 'The release proof is incomplete.' }],
  };
  writeJson(path.join(sessionDir, 'citadel-report.json'), report);
  const scheduled = enqueueCitadelRemediationResult(sessionDir);
  assert.equal(scheduled.kind, 'attribution_repair_scheduled');

  const invalid = await repairCitadelAttribution(sessionDir, { artifact: {
    schema_version: 1,
    report_sha256: 'wrong',
    attributions: [{ finding_index: 0, ticket_id: 'affected', rationale: 'Guess.' }],
  } });
  assert.equal(invalid.kind, 'attribution_repair_scheduled');
  assert.equal(invalid.attempt_count, 1);
  assert.deepEqual(readManifest(sessionDir).tickets.map((entry) => entry.status), ['Done', 'Done', 'Done']);

  const intent = reconcileCitadelAttributionRepair(sessionDir);
  const resolved = await repairCitadelAttribution(sessionDir, { artifact: {
    schema_version: 1,
    report_sha256: intent.report_sha256,
    attributions: [{ finding_index: 0, ticket_id: 'affected', rationale: 'The evidence concerns the affected contract.' }],
  } });
  assert.equal(resolved.kind, 'remediation_enqueued');
  assert.deepEqual(resolved.ticket_ids, ['affected', 'dependent']);
  const completed = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel-attribution-repair-current.json'), 'utf8'));
  assert.equal(completed.strategy_history.length, 2);
  assert.equal(new Set(completed.strategy_history.map((entry) => entry.strategy_hash)).size, 2);
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
