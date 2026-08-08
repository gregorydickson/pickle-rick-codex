// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, writeJson } from './helpers.js';
import {
  applyTicketDependencyRepairArtifact,
  reconcileDependencyRepairTransaction,
} from '../services/dependency-contract-repair.js';
import { createPrdSeal } from '../services/prd-seal.js';
import { readManifest } from '../services/tickets.js';

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ticket(id, dependsOn = []) {
  return {
    id, title: id, description: id, status: 'Todo', depends_on: dependsOn,
    acceptance_criteria: [`${id} remains correct.`], verification: ['node -e "process.exit(0)"'], allowed_paths: [`${id}.txt`],
  };
}

function artifact(sessionDir, target, tickets) {
  return {
    schema_version: 1,
    target_ticket_id: target,
    manifest_sha256: hashFile(path.join(sessionDir, 'refinement_manifest.json')),
    prd_seal_sha256: fs.existsSync(path.join(sessionDir, 'prd.lock.json'))
      ? hashFile(path.join(sessionDir, 'prd.lock.json'))
      : crypto.createHash('sha256').update('unsealed').digest('hex'),
    tickets,
    rationale: 'Restore the exact authorized dependency graph.',
  };
}

test('sealed dependency repair reconstructs the exact seal graph and rejects semantic substitution', () => {
  const sessionDir = makeTempRoot('dependency-seal-reconstruction-');
  const prd = '# Sealed dependency fixture\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  const sealedTickets = [ticket('a'), ticket('b', ['a']), ticket('c')];
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: sealedTickets });
  const seal = createPrdSeal({
    prd,
    repository: { identity: 'fixture@base', working_directory: sessionDir, execution_base_policy: 'sealed' },
    acceptance_criteria: sealedTickets.map((entry, index) => ({ id: `AC-${index + 1}`, text: entry.acceptance_criteria[0] })),
    scope_and_ownership: [],
    dependencies_and_external_prerequisites: sealedTickets.map((entry) => ({ ticket_id: entry.id, depends_on: entry.depends_on })),
    risk: [], decision_precedence: [], preservation_and_rollback: {}, completion_definition: {}, release_gates: {},
  });
  writeJson(path.join(sessionDir, 'prd.lock.json'), seal);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: [ticket('a'), ticket('b', ['missing']), ticket('c')] });

  const substituted = artifact(sessionDir, 'b', [
    { ticket_id: 'a', depends_on: [] }, { ticket_id: 'b', depends_on: ['c'] }, { ticket_id: 'c', depends_on: [] },
  ]);
  assert.throws(
    () => applyTicketDependencyRepairArtifact(sessionDir, 'b', substituted),
    /does not match the sealed dependency contract/,
  );
  const reconstructed = artifact(sessionDir, 'b', [
    { ticket_id: 'a', depends_on: [] }, { ticket_id: 'b', depends_on: ['a'] }, { ticket_id: 'c', depends_on: [] },
  ]);
  assert.deepEqual(applyTicketDependencyRepairArtifact(sessionDir, 'b', reconstructed), reconstructed.tickets);
  assert.deepEqual(readManifest(sessionDir).tickets.find((entry) => entry.id === 'b').depends_on, ['a']);
});

test('prepared dependency repair transaction completes durable evidence after a post-materialization crash', () => {
  const sessionDir = makeTempRoot('dependency-crash-reconcile-');
  const manifestBefore = { tickets: [ticket('orphan', ['missing'])] };
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), manifestBefore);
  const repairArtifact = artifact(sessionDir, 'orphan', [{ ticket_id: 'orphan', depends_on: [] }]);
  writeJson(path.join(sessionDir, 'dependency-repair-transaction.json'), {
    schema_version: 1,
    status: 'prepared',
    ticket_id: 'orphan',
    strategy_hash: 'a'.repeat(64),
    manifest_before: manifestBefore,
    manifest_sha256: repairArtifact.manifest_sha256,
    prd_seal_sha256: repairArtifact.prd_seal_sha256,
    artifact: repairArtifact,
    prepared_at: new Date().toISOString(),
  });
  applyTicketDependencyRepairArtifact(sessionDir, 'orphan', repairArtifact);
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-current.json')), false);

  assert.equal(reconcileDependencyRepairTransaction(sessionDir), 'completed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-transaction.json')), false);
  const current = JSON.parse(fs.readFileSync(path.join(sessionDir, 'dependency-repair-current.json'), 'utf8'));
  assert.equal(current.strategy_hash, 'a'.repeat(64));
  assert.deepEqual(current.graph, [{ ticket_id: 'orphan', depends_on: [] }]);
});

test('prepared dependency repair transaction rolls partial materialization back before reuse', () => {
  const sessionDir = makeTempRoot('dependency-crash-rollback-');
  const manifestBefore = { tickets: [ticket('a'), ticket('b', ['missing'])] };
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), manifestBefore);
  const repairArtifact = artifact(sessionDir, 'b', [
    { ticket_id: 'a', depends_on: [] },
    { ticket_id: 'b', depends_on: ['a'] },
  ]);
  writeJson(path.join(sessionDir, 'dependency-repair-transaction.json'), {
    schema_version: 1,
    status: 'prepared',
    ticket_id: 'b',
    strategy_hash: 'b'.repeat(64),
    manifest_before: manifestBefore,
    manifest_sha256: repairArtifact.manifest_sha256,
    prd_seal_sha256: repairArtifact.prd_seal_sha256,
    artifact: repairArtifact,
    prepared_at: new Date().toISOString(),
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [ticket('a'), ticket('b', ['a']), ticket('partial-extra')],
  });

  assert.equal(reconcileDependencyRepairTransaction(sessionDir), 'rolled_back');
  assert.deepEqual(
    readManifest(sessionDir).tickets.map((entry) => ({ id: entry.id, depends_on: entry.depends_on })),
    manifestBefore.tickets.map((entry) => ({ id: entry.id, depends_on: entry.depends_on })),
  );
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-transaction.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-current.json')), false);
});
