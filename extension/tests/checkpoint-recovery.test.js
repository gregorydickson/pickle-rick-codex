// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lifecycleContextInputHash, readLifecycleContextCheckpoint, writeLifecycleContextCheckpoint } from '../services/lifecycle-checkpoints.js';
import { makeTempRoot } from './helpers.js';

const ticket = {
  id: 'C1', title: 'Checkpoint', description: 'reuse research and plan',
  acceptance_criteria: ['reuse'], allowed_paths: ['src'],
  verification: [{ kind: 'process', executable: 'node', args: ['--test'] }],
};

test('content-addressed context checkpoint reuses only an exact input identity', () => {
  const sessionDir = makeTempRoot('pickle-checkpoint-');
  const inputHash = lifecycleContextInputHash(ticket, 'abc123');
  const artifacts = ['research', 'research_review', 'plan', 'plan_review'].map((phase) => ({
    schema_version: 1, phase, ticket_id: 'c1', summary: `${phase} approved`,
    ...(phase.endsWith('review') ? { verdict: 'approved', evidence: ['ok'] } : {}),
  }));
  const written = writeLifecycleContextCheckpoint(sessionDir, 'c1', inputHash, artifacts);
  assert.match(written.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(readLifecycleContextCheckpoint(sessionDir, 'c1', inputHash), written);
  assert.equal(readLifecycleContextCheckpoint(sessionDir, 'c1', lifecycleContextInputHash({ ...ticket, title: 'changed' }, 'abc123')), null);
  const remediatingHash = lifecycleContextInputHash({
    ...ticket,
    citadel_remediation: { failure_kind: 'citadel_refused', findings: [{ title: 'release defect' }] },
  }, 'abc123');
  assert.notEqual(remediatingHash, inputHash);
  assert.equal(readLifecycleContextCheckpoint(sessionDir, 'c1', remediatingHash), null);

  const storedPath = path.join(sessionDir, 'worker-lifecycle-checkpoints', 'c1', `${written.digest}.json`);
  const tampered = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  tampered.artifacts[0].summary = 'tampered';
  fs.writeFileSync(storedPath, JSON.stringify(tampered));
  assert.equal(readLifecycleContextCheckpoint(sessionDir, 'c1', inputHash), null);
});
