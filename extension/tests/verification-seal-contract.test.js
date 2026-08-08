// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, prependPath, writeExecutable, writeJson } from './helpers.js';
import { repairTicketVerificationContract, runTicket } from '../bin/spawn-morty.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  assertTicketVerificationBoundToSeal,
  buildVerificationRepairReceipt,
  reconcileVerificationRepairTransaction,
  resolveSealedVerificationAuthorization,
  verificationRepairReceiptPath,
} from '../services/verification-seal-contract.js';

function fixture(sealedVerification, manifestVerification = sealedVerification) {
  const dataRoot = makeTempRoot('verification-seal-data-');
  const workingDir = makeTempRoot('verification-seal-repo-');
  const sessionDir = makeTempRoot('verification-seal-session-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1, active: true, working_dir: workingDir, worker_timeout_seconds: 10,
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'r1', title: 'Sealed verifier', description: 'Preserve verification.', status: 'Todo',
      acceptance_criteria: ['The nontrivial verifier remains mandatory.'],
      allowed_paths: ['proof.txt'], verification: manifestVerification,
    }],
  });
  const prd = '# Sealed verification fixture\n';
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), prd);
  writePrdSeal(sessionDir, {
    prd,
    repository: { identity: 'fixture@base', working_directory: workingDir, execution_base_policy: 'sealed' },
    acceptance_criteria: [{ id: 'AC-1', text: 'The nontrivial verifier remains mandatory.' }],
    scope_and_ownership: [], dependencies_and_external_prerequisites: [], risk: [], decision_precedence: [],
    preservation_and_rollback: {}, completion_definition: {},
    release_gates: {
      ticket_verification: [{ ticket_id: 'r1', acceptance_criteria: ['The nontrivial verifier remains mandatory.'], verification: sealedVerification }],
      final_gate: 'citadel',
    },
  });
  return { dataRoot, workingDir, sessionDir };
}

async function withEnvironment(environment, callback) {
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeRepairWorker(mode) {
  const binDir = makeTempRoot('verification-seal-bin-');
  writeExecutable(path.join(binDir, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
const value = (prefix) => prompt.split('\\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
const verification = process.env.REPAIR_MODE === 'always-pass'
  ? [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }]
  : JSON.parse(value('Authorized sealed verification steps JSON: '));
fs.writeFileSync(value('Contract repair artifact path: '), JSON.stringify({
  schema_version: 1, ticket_id: value('Ticket ID: '), verification, rationale: 'deterministic sealed reconstruction',
}));
console.log('<promise>CONTRACT_REPAIR_COMPLETE</promise>');
`);
  return { ...prependPath(binDir), REPAIR_MODE: mode };
}

test('sealed nontrivial verification cannot be repaired into an always-pass command', async () => {
  const sealed = [{ kind: 'process', executable: 'node', args: ['-e', "if (!require('node:fs').existsSync('proof.txt')) process.exit(9)"] }];
  const malformed = [{ kind: 'process', executable: 'node', args: 'not-an-array' }];
  const { dataRoot, sessionDir } = fixture(sealed, malformed);
  const before = fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8');

  await assert.rejects(
    () => withEnvironment({ PICKLE_DATA_ROOT: dataRoot, ...fakeRepairWorker('always-pass') }, () => (
      repairTicketVerificationContract(sessionDir, 'r1')
    )),
    /weakens or changes the sealed deterministic obligation/,
  );
  assert.equal(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'), before);
  assert.equal(fs.existsSync(verificationRepairReceiptPath(sessionDir, 'r1')), false);
});

test('representation-only legacy malformation is reconstructed with a crash-reconcilable seal receipt', async () => {
  const sealed = [
    { kind: 'process', executable: 'node', args: ['--version'] },
    { command: 'node -e "process.exit(7)"' },
  ];
  const { dataRoot, workingDir, sessionDir } = fixture(sealed);
  await assert.rejects(
    () => withEnvironment({ PICKLE_DATA_ROOT: dataRoot, ...fakeRepairWorker('authorized') }, () => (
      repairTicketVerificationContract(sessionDir, 'r1', { afterMaterialization: () => { throw new Error('simulated crash'); } })
    )),
    /simulated crash/,
  );
  assert.equal(fs.existsSync(path.join(sessionDir, 'verification-contract-repair-transaction.json')), true);
  assert.equal(fs.existsSync(verificationRepairReceiptPath(sessionDir, 'r1')), false);
  assert.throws(() => assertTicketVerificationBoundToSeal(sessionDir, 'r1', workingDir), /receipt-missing-or-invalid/);

  assert.equal(reconcileVerificationRepairTransaction(sessionDir), 'completed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'verification-contract-repair-transaction.json')), false);
  assert.equal(fs.existsSync(verificationRepairReceiptPath(sessionDir, 'r1')), true);
  assert.doesNotThrow(() => assertTicketVerificationBoundToSeal(sessionDir, 'r1', workingDir));
});

test('ticket execution rejects sealed verification drift before spawning a worker', async () => {
  const sealed = [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(8)'] }];
  const alwaysPass = [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }];
  const { sessionDir } = fixture(sealed, alwaysPass);
  await assert.rejects(() => runTicket(sessionDir, 'r1'), /sealed-verification-semantic-drift/);
});

test('restart rolls a prepared pre-materialization repair back to the malformed sealed manifest', () => {
  const sealed = [{ kind: 'process', executable: 'node', args: ['--version'] }];
  const malformed = [{ kind: 'process', executable: 'node', args: 'not-an-array' }];
  const { sessionDir } = fixture(sealed, malformed);
  const manifestBefore = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  const authorization = resolveSealedVerificationAuthorization(sessionDir, 'r1');
  assert.ok(authorization);
  const repairedManifest = structuredClone(manifestBefore);
  repairedManifest.tickets[0].verification = authorization.authorized_steps;
  const receipt = buildVerificationRepairReceipt(authorization, authorization.authorized_steps, null);
  writeJson(path.join(sessionDir, 'verification-contract-repair-transaction.json'), {
    schema_version: 1, status: 'prepared', ticket_id: 'r1', manifest_before: manifestBefore,
    repaired_manifest: repairedManifest, receipt, prepared_at: new Date().toISOString(),
  });

  assert.equal(reconcileVerificationRepairTransaction(sessionDir), 'rolled_back');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8')), manifestBefore);
  assert.equal(fs.existsSync(path.join(sessionDir, 'verification-contract-repair-transaction.json')), false);
});
