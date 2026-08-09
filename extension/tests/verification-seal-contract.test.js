// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempRoot, prependPath, writeExecutable, writeJson } from './helpers.js';
import { repairTicketVerificationContract, runTicket } from '../bin/spawn-morty.js';
import { writePrdSeal } from '../services/prd-seal.js';
import {
  beginRefinementRepositoryAdvance,
  clearRefinementRepositoryAdvance,
  validateRefinementAcceptance,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import {
  assertTicketVerificationBoundToSeal,
  buildVerificationRepairReceipt,
  reconcileVerificationRepairTransaction,
  resolveSealedVerificationAuthorization,
  verificationRepairReceiptPath,
} from '../services/verification-seal-contract.js';

function fixture(sealedVerification, manifestVerification = sealedVerification, accepted = false) {
  const dataRoot = makeTempRoot('verification-seal-data-');
  const workingDir = makeTempRoot('verification-seal-repo-');
  const sessionDir = makeTempRoot('verification-seal-session-');
  execFileSync('git', ['init', '-q'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.name', 'Verification Seal Test'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.email', 'seal@example.com'], { cwd: workingDir });
  fs.writeFileSync(path.join(workingDir, 'package.json'), '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}\n');
  execFileSync('git', ['add', 'package.json'], { cwd: workingDir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workingDir });
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
  if (accepted) {
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Refined sealed verification fixture\n');
    writeRefinementAcceptance(sessionDir, { workingDir, preserveMalformedVerification: true });
  }
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
if (process.env.REPAIR_MODE === 'mutate-workspace') {
  fs.writeFileSync('malicious-contract-repair.txt', 'must remain isolated\\n');
}
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

test('verification contract repair confines malicious repository mutation to a disposable worktree', async () => {
  const sealed = [{ kind: 'process', executable: 'node', args: ['--version'] }];
  const { dataRoot, workingDir, sessionDir } = fixture(sealed, sealed, true);
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' });
  const worktreesBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: workingDir, encoding: 'utf8',
  });

  await withEnvironment({ PICKLE_DATA_ROOT: dataRoot, ...fakeRepairWorker('mutate-workspace') }, () => (
    repairTicketVerificationContract(sessionDir, 'r1')
  ));

  assert.equal(fs.existsSync(path.join(workingDir, 'malicious-contract-repair.txt')), false);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim(), headBefore);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' }), statusBefore);
  assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: workingDir, encoding: 'utf8',
  }), worktreesBefore);
});

test('adopted trap/mktemp repair atomically rebinds acceptance and restart can begin ticket execution', async () => {
  const command = 'runtime_root="$(mktemp -d)"; trap \'rm -rf "$runtime_root"\' EXIT; CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" bash install.sh && CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" npm run test:installed';
  const legacy = [{ command }];
  const { dataRoot, workingDir, sessionDir } = fixture(legacy, legacy, true);
  const sealBefore = fs.readFileSync(path.join(sessionDir, 'prd.lock.json'), 'utf8');
  const acceptanceBefore = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement-acceptance.json'), 'utf8'));

  await assert.rejects(
    () => withEnvironment({ PICKLE_DATA_ROOT: dataRoot, ...fakeRepairWorker('authorized') }, () => (
      repairTicketVerificationContract(sessionDir, 'r1', { afterMaterialization: () => { throw new Error('restart now'); } })
    )),
    /restart now/,
  );
  assert.equal(validateRefinementAcceptance(sessionDir, { workingDir, verifyRepository: true }).ok, true);
  const acceptanceAfter = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement-acceptance.json'), 'utf8'));
  assert.equal(acceptanceAfter.prd_sha256, acceptanceBefore.prd_sha256);
  assert.equal(acceptanceAfter.refined_prd_sha256, acceptanceBefore.refined_prd_sha256);
  assert.equal(acceptanceAfter.repository_identity, acceptanceBefore.repository_identity);
  assert.match(acceptanceAfter.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'prd.lock.json'), 'utf8'), sealBefore);

  assert.equal(reconcileVerificationRepairTransaction(sessionDir), 'completed');
  assert.equal(reconcileVerificationRepairTransaction(sessionDir), null);
  assert.doesNotThrow(() => beginRefinementRepositoryAdvance({
    sessionDir, workingDir, ticketId: 'r1', requiresCleanCommit: false,
  }));
  clearRefinementRepositoryAdvance(sessionDir);
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
