// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeCodex, makeTempRoot, prependPath, waitFor, writeJson } from './helpers.js';
import {
  enqueueCitadelRemediation,
  enqueueCitadelRemediationResult,
  repairCitadelAttribution,
  reconcileCitadelAttributionRepair,
  reconcileCitadelRemediation,
} from '../services/citadel-remediation.js';
import { readManifest } from '../services/tickets.js';
import { DurableOwnershipDrainError, isDurableOwnershipDrainError } from '../services/durable-runtime.js';
import { StateManager } from '../services/state-manager.js';

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

test('malicious attribution worker cannot mutate live tickets while returning a valid artifact', async () => {
  const sessionDir = multiTicketSession();
  const workingDir = makeTempRoot('citadel-attribution-live-repo-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    active: true,
    working_dir: workingDir,
    worker_timeout_seconds: 30,
    history: [],
  });
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{ severity: 'high', title: 'Cross-cutting reviewer finding.', evidence: 'Release proof is incomplete.' }],
  });
  assert.equal(enqueueCitadelRemediationResult(sessionDir).kind, 'attribution_repair_scheduled');
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const originalManifest = fs.readFileSync(manifestPath, 'utf8');
  const binDir = makeTempRoot('citadel-attribution-malicious-bin-');
  const invocationLog = path.join(sessionDir, 'fake-attribution-invocations.jsonl');
  createFakeCodex(binDir);
  const prior = {
    PATH: process.env.PATH,
    PICKLE_TEST_MODE: process.env.PICKLE_TEST_MODE,
    FAKE_ATTRIBUTION_MUTATE_SESSION: process.env.FAKE_ATTRIBUTION_MUTATE_SESSION,
    FAKE_CODEX_INVOCATION_LOG: process.env.FAKE_CODEX_INVOCATION_LOG,
  };
  Object.assign(process.env, prependPath(binDir, {
    PICKLE_TEST_MODE: '1',
    FAKE_ATTRIBUTION_MUTATE_SESSION: sessionDir,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
  }));
  let result;
  try {
    result = await repairCitadelAttribution(sessionDir, { timeoutMs: 10_000 });
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(result.kind, 'attribution_repair_scheduled');
  assert.match(result.reason, /citadel-attribution-authoritative-drift/);
  assert.match(result.reason, /refinement_manifest\.json/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), originalManifest);
  const independent = readManifest(sessionDir).tickets.find((ticket) => ticket.id === 'independent');
  assert.equal(independent.status, 'Done');
  assert.deepEqual(independent.acceptance_criteria, ['Independent behavior remains correct.']);
  assert.equal(independent.completion_commit, '69696969696969');
  assert.equal(fs.existsSync(path.join(sessionDir, 'independent', 'linear_ticket_independent.md')), false);
  const liveState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(liveState.active, true);
  assert.equal(liveState.active_child_pid, null);
  const pending = reconcileCitadelAttributionRepair(sessionDir);
  assert.equal(pending.attempt_count, 1);
  assert.equal(pending.strategy_history.at(-1).status, 'failed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
  assert.equal(fs.readdirSync(path.join(sessionDir, 'citadel-attribution-quarantine')).length, 1);
  const invocation = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse)
    .find((entry) => entry.prompt.includes('autonomous Citadel finding attribution repair worker'));
  assert.notEqual(invocation.cwd, sessionDir);
  assert.equal(invocation.args.includes('--add-dir'), false);
  assert.doesNotMatch(invocation.prompt, new RegExp(sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('operator cancellation dominates an in-flight attribution repair and cannot restore its lease', async () => {
  const sessionDir = multiTicketSession();
  const workingDir = makeTempRoot('citadel-attribution-cancel-repo-');
  const statePath = path.join(sessionDir, 'state.json');
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  writeJson(statePath, {
    schema_version: 1,
    active: true,
    working_dir: workingDir,
    worker_timeout_seconds: 30,
    history: [],
  });
  writeJson(logicalPath, {
    schema_version: 1,
    pipeline_id: path.basename(sessionDir),
    control_state: 'autonomous_execution',
    terminal_state: null,
    prd_seal_hash: 'a'.repeat(64),
    lease: {
      owner_id: `runner:${process.pid}:attribution-cancel-test`,
      token: 'cancel-test-token',
      generation: 1,
      acquired_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    lease_generation: 1,
    executor_restart_count: 0,
    events: [],
  });
  writeJson(path.join(sessionDir, 'citadel-report.json'), {
    schema_version: 1,
    verdict: 'block',
    acceptance_criteria_checked: [],
    findings: [{ severity: 'high', title: 'Concurrent cancellation finding.', evidence: 'Attribution is ambiguous.' }],
  });
  assert.equal(enqueueCitadelRemediationResult(sessionDir).kind, 'attribution_repair_scheduled');

  const binDir = makeTempRoot('citadel-attribution-cancel-bin-');
  const invocationLog = path.join(sessionDir, 'fake-attribution-cancel-invocations.jsonl');
  createFakeCodex(binDir);
  const prior = {
    PATH: process.env.PATH,
    PICKLE_TEST_MODE: process.env.PICKLE_TEST_MODE,
    FAKE_ATTRIBUTION_DELAY_MS: process.env.FAKE_ATTRIBUTION_DELAY_MS,
    FAKE_CODEX_INVOCATION_LOG: process.env.FAKE_CODEX_INVOCATION_LOG,
  };
  Object.assign(process.env, prependPath(binDir, {
    PICKLE_TEST_MODE: '1',
    FAKE_ATTRIBUTION_DELAY_MS: '500',
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
  }));

  try {
    const repair = repairCitadelAttribution(sessionDir, {
      timeoutMs: 10_000,
      assertDurableOwnership: () => {
        const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
        if (logical.terminal_state === 'cancelled' || logical.lease === null) {
          throw new DurableOwnershipDrainError('operator cancellation drained durable ownership');
        }
      },
    });
    await waitFor(() => fs.existsSync(invocationLog) && fs.readFileSync(invocationLog, 'utf8').includes(
      'autonomous Citadel finding attribution repair worker',
    ));
    new StateManager().update(statePath, (state) => {
      state.active = false;
      state.last_exit_reason = 'cancelled';
      state.cancel_requested_at = new Date().toISOString();
      return state;
    });
    const logicalManager = new StateManager();
    logicalManager.acquireLock(logicalPath);
    try {
      const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
      logical.terminal_state = 'cancelled';
      logical.lease = null;
      writeJson(logicalPath, logical);
    } finally {
      logicalManager.releaseLock(logicalPath);
    }
    await assert.rejects(repair, (error) => isDurableOwnershipDrainError(error));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const logical = JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.ok(state.cancel_requested_at);
  assert.equal(logical.terminal_state, 'cancelled');
  assert.equal(logical.lease, null);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-remediation-pending.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'citadel-attribution-repair-current.json')), false);
  assert.notEqual(state.last_exit_reason, 'citadel_attribution_repair_scheduled');
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
