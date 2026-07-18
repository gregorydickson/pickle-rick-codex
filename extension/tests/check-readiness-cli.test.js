// @tier: integration
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempRoot, repoRoot, runNode, writeJson } from './helpers.js';

test('check-readiness --json emits structured blockers and persists a cycle', () => {
  const sessionDir = makeTempRoot('pickle-readiness-cli-');
  writeJson(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    active: false,
    working_dir: makeTempRoot('pickle-readiness-nongit-'),
    quality_baseline: null,
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: [] });
  let error;
  try {
    runNode([path.join(repoRoot, 'bin', 'check-readiness.js'), '--session-dir', sessionDir, '--json']);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  const report = JSON.parse(error.stdout);
  assert.equal(report.ready, false);
  assert.ok(report.findings.every((entry) => entry.severity && entry.code && entry.evidence));
  assert.ok(report.findings.some((entry) => entry.code === 'git-unavailable'));
  assert.equal(fs.existsSync(path.join(sessionDir, 'readiness-history.json')), true);
});
