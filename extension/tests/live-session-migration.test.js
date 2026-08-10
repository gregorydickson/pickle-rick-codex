// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LIVE_SESSION_MIGRATION_FILE,
  LiveSessionMigrationContentionError,
  deriveRepinnedLiveSessionMigration,
  finalizeLiveSessionMigrationAfterHandoff,
  prepareLiveSessionHandoffCheckpoint,
  prepareLiveSessionMigration,
  verifyLiveSessionMigration,
  verifyLiveSessionMigrationDomainBoundary,
} from '../services/live-session-migration.js';
import {
  acceptRuntimeHandoff,
  acquireSupervisorLease,
  beginAutonomousExecution,
  createLogicalPipeline,
  releaseRuntimeHandoffLease,
  requestRuntimeHandoff,
} from '../services/durable-supervisor.js';
import { writePrdSeal } from '../services/prd-seal.js';

const sourceRuntime = { runtime_id: 'installed-blue', version: '0.2.17', build_hash: '1'.repeat(64), min_state_schema: 1, max_state_schema: 1 };
const targetRuntime = { runtime_id: 'candidate-green', version: '0.3.0', build_hash: '2'.repeat(64), min_state_schema: 1, max_state_schema: 2 };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function fixture() {
  const repo = makeTempRoot('pickle-migration-repo-');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Migration Test']);
  git(repo, ['config', 'user.email', 'migration@example.test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'preserved\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'fixture']);
  const sessionDir = path.join(makeTempRoot('pickle-migration-data-'), 'field-session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    active: true,
    working_dir: repo,
    current_ticket: 'P1R-001',
    step: 'conformance',
    history: [{ step: 'research' }, { step: 'review' }],
    unknown_legacy_field: { must_survive: true },
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{ id: 'P1R-001', status: 'Todo', verification: ['node -e "const x = `unsafe`"'] }],
  });
  const lifecycleDir = path.join(sessionDir, 'worker-lifecycle', 'p1r-001');
  fs.mkdirSync(lifecycleDir, { recursive: true });
  for (const phase of ['research', 'research_review', 'plan', 'plan_review']) {
    writeJson(path.join(lifecycleDir, `${phase}.json`), {
      schema_version: 1, phase, ticket_id: 'p1r-001', summary: phase,
      ...(phase.endsWith('review') ? { verdict: 'approved', evidence: ['preserved'] } : {}),
    });
  }
  writeJson(path.join(sessionDir, 'worker-lifecycle-refusals.json'), { refusals: ['review', 'review'] });
  const refusalDir = path.join(sessionDir, 'worker-lifecycle-refusals', 'r1');
  fs.mkdirSync(refusalDir, { recursive: true });
  writeJson(path.join(refusalDir, '0001-review.json'), {
    schema_version: 1,
    phase: 'review',
    ticket_id: 'r1',
    verdict: 'changes_requested',
    findings: ['preserve this refusal across runtime ownership transfer'],
  });
  writeJson(path.join(sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [{ strategy: 'repair' }] });
  writeJson(path.join(sessionDir, 'completion-evidence.json'), { commit: 'abc123' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', `refs/pickle/salvage/${path.basename(sessionDir)}`, sha]);
  const recoveryRef = `refs/pickle/salvage-history/${path.basename(sessionDir)}/r1/0001`;
  git(repo, ['update-ref', recoveryRef, sha]);
  writeJson(path.join(sessionDir, 'rejected-candidates', 'r1.json'), {
    schema_version: 1,
    ticket_id: 'r1',
    recovery_ref: recoveryRef,
    rejected_at: '2026-08-08T17:59:00.000Z',
    changed_paths: ['tracked.txt'],
  });
  return { repo, sessionDir };
}

test('active legacy session migrates in place to contract repair without losing durable evidence', () => {
  const { sessionDir } = fixture();
  const before = new Map();
  for (const relative of ['state.json', 'refinement_manifest.json', 'worker-lifecycle-refusals.json', 'ticket-recovery-history.json', 'completion-evidence.json']) {
    before.set(relative, fs.readFileSync(path.join(sessionDir, relative), 'utf8'));
  }

  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date('2026-08-08T18:00:00.000Z'));
  assert.equal(migration.resume_checkpoint.phase, 'verification_contract_repair');
  assert.deepEqual(migration.resume_checkpoint.reuse_phases, ['research', 'research_review', 'plan', 'plan_review']);
  assert.equal(migration.resume_checkpoint.history_length, 2);
  assert.equal(migration.salvage_refs.length, 2);
  assert.ok(migration.salvage_refs.some((ref) => /^refs\/pickle\/salvage\/field-session-1:/.test(ref)));
  assert.ok(fs.existsSync(path.join(sessionDir, LIVE_SESSION_MIGRATION_FILE)));
  verifyLiveSessionMigration(sessionDir, migration);

  for (const [relative, content] of before) {
    assert.equal(fs.readFileSync(path.join(sessionDir, relative), 'utf8'), content, `${relative} changed during migration`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')).unknown_legacy_field, { must_survive: true });
});

test('migration recaptures bounded transient active-session contention and seals the new snapshot', () => {
  const { sessionDir } = fixture();
  const telemetryPath = path.join(sessionDir, 'ticket-recovery-history.json');
  const attempts = [];
  const waits = [];
  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date(), {
    maxSnapshotAttempts: 3,
    retryDelayMs: 17,
    wait: (milliseconds) => waits.push(milliseconds),
    checkpoint: (_stage, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) writeJson(telemetryPath, { schema_version: 1, events: [{ strategy: 'advanced' }] });
    },
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(waits, [17]);
  assert.equal(migration.preserved_artifacts.find(({ path: artifactPath }) => (
    artifactPath === 'ticket-recovery-history.json'
  )).sha256, crypto.createHash('sha256').update(fs.readFileSync(telemetryPath)).digest('hex'));
  assert.doesNotThrow(() => verifyLiveSessionMigration(sessionDir, migration));
});

test('migration exhaustion fails closed without deleting another writer receipt', () => {
  const { sessionDir } = fixture();
  const migrationPath = path.join(sessionDir, LIVE_SESSION_MIGRATION_FILE);
  const foreign = { schema_version: 1, migration_id: 'foreign-writer', content_hash: 'f'.repeat(64) };
  assert.throws(() => prepareLiveSessionMigration(
    sessionDir, sourceRuntime, targetRuntime, new Date(), {
      maxSnapshotAttempts: 3,
      checkpoint: () => writeJson(migrationPath, foreign),
    },
  ), (error) => error instanceof LiveSessionMigrationContentionError);
  assert.deepEqual(JSON.parse(fs.readFileSync(migrationPath, 'utf8')), foreign);
});

test('migration fails closed after bounded repeated artifact contention', () => {
  const { sessionDir } = fixture();
  const telemetryPath = path.join(sessionDir, 'ticket-recovery-history.json');
  let attempts = 0;
  assert.throws(() => prepareLiveSessionMigration(
    sessionDir, sourceRuntime, targetRuntime, new Date(), {
      maxSnapshotAttempts: 2,
      checkpoint: (_stage, attempt) => {
        attempts = attempt;
        writeJson(telemetryPath, { schema_version: 1, events: [{ attempt }] });
      },
    },
  ), (error) => error instanceof LiveSessionMigrationContentionError);
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(path.join(sessionDir, LIVE_SESSION_MIGRATION_FILE)), false);
});

test('installed runtime migration fails closed when target cannot read the active schema', () => {
  const { sessionDir } = fixture();
  assert.throws(
    () => prepareLiveSessionMigration(sessionDir, sourceRuntime, { ...targetRuntime, min_state_schema: 2 }, new Date()),
    /cannot read session schema 1/,
  );
  assert.equal(fs.existsSync(path.join(sessionDir, LIVE_SESSION_MIGRATION_FILE)), false);
});

test('migration continuity detects post-handoff evidence mutation', () => {
  const { sessionDir } = fixture();
  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date());
  writeJson(path.join(sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [] });
  assert.throws(() => verifyLiveSessionMigration(sessionDir, migration), /continuity failed for ticket-recovery-history.json/);
});

test('bounded readiness telemetry remains mutable across new and legacy sealed migrations', () => {
  const { sessionDir } = fixture();
  const historyPath = path.join(sessionDir, 'readiness-history.json');
  const firstHistory = Buffer.from(`${JSON.stringify({
    schema_version: 1, cycles: [{ checked_at: '2026-08-08T18:00:00.000Z', ready: false }],
  }, null, 2)}\n`);
  fs.writeFileSync(historyPath, firstHistory);
  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date());
  assert.equal(migration.preserved_artifacts.some((entry) => entry.path === 'readiness-history.json'), false);

  const legacyPayload = {
    ...migration,
    preserved_artifacts: [...migration.preserved_artifacts, {
      path: 'readiness-history.json',
      sha256: crypto.createHash('sha256').update(firstHistory).digest('hex'),
      size: firstHistory.length,
    }].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  delete legacyPayload.content_hash;
  const legacyMigration = {
    ...legacyPayload,
    content_hash: crypto.createHash('sha256').update(canonicalize(legacyPayload)).digest('hex'),
  };
  writeJson(historyPath, {
    schema_version: 1,
    cycles: [
      { checked_at: '2026-08-08T18:00:00.000Z', ready: false },
      { checked_at: '2026-08-10T17:09:33.186Z', ready: true },
    ],
  });

  assert.doesNotThrow(() => verifyLiveSessionMigration(sessionDir, migration));
  assert.doesNotThrow(() => verifyLiveSessionMigration(sessionDir, legacyMigration));
  assert.doesNotThrow(() => verifyLiveSessionMigrationDomainBoundary(
    sessionDir, legacyMigration, sourceRuntime, targetRuntime,
  ));
  assert.equal(deriveRepinnedLiveSessionMigration(
    legacyMigration, targetRuntime,
  ).preserved_artifacts.some((entry) => entry.path === 'readiness-history.json'), false);
});

test('migration preserves verification repair receipts and prepared crash transactions', () => {
  const { sessionDir } = fixture();
  writeJson(path.join(sessionDir, 'verification-contract-repair-receipts', 'p1r-001.json'), {
    schema_version: 1, ticket_id: 'p1r-001', seal_semantic_hash: 'a'.repeat(64),
  });
  writeJson(path.join(sessionDir, 'verification-contract-repair-transaction.json'), {
    schema_version: 1, status: 'prepared', ticket_id: 'p1r-001',
  });

  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date());
  assert.ok(migration.preserved_artifacts.some((entry) => entry.path === 'verification-contract-repair-receipts/p1r-001.json'));
  assert.ok(migration.preserved_artifacts.some((entry) => entry.path === 'verification-contract-repair-transaction.json'));
  verifyLiveSessionMigration(sessionDir, migration);
  writeJson(path.join(sessionDir, 'verification-contract-repair-receipts', 'p1r-001.json'), { schema_version: 1 });
  assert.throws(() => verifyLiveSessionMigration(sessionDir, migration), /continuity failed for verification-contract-repair-receipts/);
});

test('migration inventory includes and validates the authoritative logical journal', () => {
  const { sessionDir } = fixture();
  createLogicalPipeline(sessionDir, 'migration-journal');
  writePrdSeal(sessionDir, {
    prd: '# Approved\n', repository: { identity: 'repo@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'AC-1', text: 'Preserve journal.' }], scope_and_ownership: {},
    dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [], preservation_and_rollback: {},
    completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir);
  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime, new Date());
  assert.ok(migration.preserved_artifacts.some((entry) => entry.path === 'logical-pipeline.json'));
  writeJson(path.join(sessionDir, 'logical-pipeline.json'), { schema_version: 1, events: [] });
  assert.throws(() => verifyLiveSessionMigration(sessionDir, migration), /logical pipeline|journal/i);
});

test('rejected candidate and refusal archive survive a real durable runtime handoff', () => {
  const { repo, sessionDir } = fixture();
  createLogicalPipeline(sessionDir, 'artifact-handoff');
  writePrdSeal(sessionDir, {
    prd: '# Approved handoff\n', repository: { identity: 'repo@base', working_directory: repo, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'AC-1', text: 'Preserve rejected work.' }], scope_and_ownership: {},
    dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [], preservation_and_rollback: {},
    completion_definition: {}, release_gates: [],
  });
  beginAutonomousExecution(sessionDir);
  const candidatePath = path.join(sessionDir, 'rejected-candidates', 'r1.json');
  const refusalPath = path.join(sessionDir, 'worker-lifecycle-refusals', 'r1', '0001-review.json');
  const candidateBefore = fs.readFileSync(candidatePath, 'utf8');
  const refusalBefore = fs.readFileSync(refusalPath, 'utf8');
  const recoveryRef = JSON.parse(candidateBefore).recovery_ref;
  const recoverySha = git(repo, ['rev-parse', recoveryRef]);

  const blue = acquireSupervisorLease(sessionDir, { ownerId: 'installed-blue', ttlMs: 10_000, nowMs: 1_000 });
  const checkpoint = prepareLiveSessionHandoffCheckpoint(sessionDir, sourceRuntime, targetRuntime);
  const requestId = requestRuntimeHandoff(
    sessionDir, blue.owner_id, blue.token, sourceRuntime, targetRuntime, checkpoint, { nowMs: 1_100 },
  );
  releaseRuntimeHandoffLease(sessionDir, blue.owner_id, blue.token, requestId, { nowMs: 1_200 });
  const accepted = acceptRuntimeHandoff(sessionDir, requestId, 'candidate-green', 10_000, targetRuntime, { nowMs: 1_300 });
  const migration = finalizeLiveSessionMigrationAfterHandoff(sessionDir, requestId, targetRuntime);

  assert.deepEqual(accepted.resume_checkpoint, checkpoint);
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), candidateBefore);
  assert.equal(fs.readFileSync(refusalPath, 'utf8'), refusalBefore);
  assert.equal(git(repo, ['rev-parse', recoveryRef]), recoverySha);
  assert.ok(migration.preserved_artifacts.some((entry) => entry.path === 'rejected-candidates/r1.json'));
  assert.ok(migration.preserved_artifacts.some((entry) => entry.path === 'worker-lifecycle-refusals/r1/0001-review.json'));
  assert.ok(migration.salvage_refs.some((entry) => entry.startsWith(`${recoveryRef}:`)));
  verifyLiveSessionMigration(sessionDir, migration);
});
