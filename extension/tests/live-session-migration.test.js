// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LIVE_SESSION_MIGRATION_FILE,
  finalizeLiveSessionMigrationAfterHandoff,
  prepareLiveSessionHandoffCheckpoint,
  prepareLiveSessionMigration,
  verifyLiveSessionMigration,
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
