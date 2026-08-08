// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  LIVE_SESSION_MIGRATION_FILE,
  prepareLiveSessionMigration,
  verifyLiveSessionMigration,
} from '../services/live-session-migration.js';

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
  writeJson(path.join(sessionDir, 'ticket-recovery-history.json'), { schema_version: 1, events: [{ strategy: 'repair' }] });
  writeJson(path.join(sessionDir, 'completion-evidence.json'), { commit: 'abc123' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', `refs/pickle/salvage/${path.basename(sessionDir)}`, sha]);
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
  assert.equal(migration.salvage_refs.length, 1);
  assert.match(migration.salvage_refs[0], /^refs\/pickle\/salvage\/field-session-1:/);
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
