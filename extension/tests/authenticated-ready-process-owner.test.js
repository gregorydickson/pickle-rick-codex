// @tier: fast
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  authenticatedReadyProcessOwner,
  deriveAutonomousProcessOwnerSpec,
  observeProcessLivenessTopology,
} from '../services/autonomous-owner-recovery.js';
import { makeTempRoot } from './helpers.js';

function identity(pid) {
  const startTime = `start-${pid}`;
  return {
    pid,
    pgid: pid,
    start_time: startTime,
    fingerprint: crypto.createHash('sha256').update(`${pid}\0${pid}\0${startTime}`).digest('hex'),
  };
}

function fixture() {
  const sessionDir = makeTempRoot('pickle-ready-owner-session-');
  const workingDir = makeTempRoot('pickle-ready-owner-work-');
  const runtimeBin = makeTempRoot('pickle-ready-owner-runtime-');
  fs.writeFileSync(path.join(runtimeBin, 'supervised-runner.js'), '// exact supervisor\n');
  fs.writeFileSync(path.join(runtimeBin, 'mux-runner.js'), '// exact runner\n');
  const spec = deriveAutonomousProcessOwnerSpec(
    sessionDir, workingDir, 'mux-runner.js', ['--on-failure=retry'], runtimeBin,
  );
  const supervisor = identity(71001);
  const recoveryDaemon = identity(71002);
  const challenge = 'exact-adoption-challenge';
  const unsignedReceipt = {
    schema_version: 1,
    owner_spec_id: spec.spec_id,
    supervisor_identity: supervisor,
    node_path: spec.node_path,
    supervisor_path: spec.supervisor_path,
    working_dir: spec.working_dir,
    session_dir: spec.session_dir,
    runner_bin: spec.runner_bin,
    runner_args: [...spec.runner_args],
    recovery_daemon_identity: recoveryDaemon,
    adoption_challenge: challenge,
    ready_at: '2026-08-10T00:00:00.000Z',
  };
  const receipt = {
    ...unsignedReceipt,
    receipt_id: crypto.createHash('sha256').update(JSON.stringify(unsignedReceipt)).digest('hex'),
  };
  const state = {
    autonomous_owner_spec: spec,
    autonomous_supervisor_pid: supervisor.pid,
    autonomous_supervisor_identity: supervisor,
    autonomous_supervisor_ready_receipt: receipt,
    autonomous_owner_recovery_daemon_pid: recoveryDaemon.pid,
    autonomous_owner_recovery_daemon_identity: recoveryDaemon,
    legacy_adoption_supervisor_challenge: challenge,
  };
  return { sessionDir, state, supervisor, recoveryDaemon, challenge };
}

function countedTopology(supervisorState = 'matched', daemonState = 'matched') {
  const counts = { parent: 0, supervisor: 0, daemon: 0 };
  return {
    counts,
    observe: (supervisor, recoveryDaemon) => observeProcessLivenessTopology(
      supervisor,
      recoveryDaemon,
      {
        parentPid: () => {
          counts.parent += 1;
          return recoveryDaemon.pid;
        },
        inspect: (candidate) => {
          if (candidate.pid === supervisor.pid) {
            counts.supervisor += 1;
            return supervisorState;
          }
          counts.daemon += 1;
          return daemonState;
        },
      },
    ),
  };
}

test('challenged ready-owner authentication performs one probe per topology fact', () => {
  const value = fixture();
  const topology = countedTopology();

  assert.deepEqual(authenticatedReadyProcessOwner(
    value.sessionDir,
    value.state,
    value.recoveryDaemon,
    value.challenge,
    true,
    topology.observe,
  ), value.supervisor);
  assert.deepEqual(topology.counts, { parent: 1, supervisor: 1, daemon: 1 });
});

test('a reused supervisor or recovery-daemon identity invalidates the sampled topology', () => {
  for (const reused of ['supervisor', 'daemon']) {
    const value = fixture();
    const topology = countedTopology(
      reused === 'supervisor' ? 'reused' : 'matched',
      reused === 'daemon' ? 'reused' : 'matched',
    );

    assert.equal(authenticatedReadyProcessOwner(
      value.sessionDir,
      value.state,
      value.recoveryDaemon,
      value.challenge,
      true,
      topology.observe,
    ), null, reused);
    assert.deepEqual(topology.counts, { parent: 1, supervisor: 1, daemon: 1 }, reused);
  }
});
