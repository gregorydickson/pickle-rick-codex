import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, createFakeCodex, prependPath } from './helpers.js';

test('validate-codex reports the configured codex version and guaranteed path', () => {
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const output = runNode([path.join(repoRoot, 'bin/validate-codex.js')], {
    env: prependPath(fakeBin),
  }).trim();

  const parsed = JSON.parse(output);
  assert.match(parsed.validation_date, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(parsed.codex_version, 'codex 9.9.9-test');
  assert.equal(parsed.guaranteed_path, 'codex exec --full-auto');
});

test('draft-prd writes a PRD and advances the session state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  createFakeCodex(fakeBin);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'draft this task'], {
    cwd: projectDir,
    env,
  }).trim();

  runNode([path.join(repoRoot, 'bin/draft-prd.js'), sessionDir, 'draft this task'], {
    cwd: projectDir,
    env,
  });

  const prdPath = path.join(sessionDir, 'prd.md');
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.ok(fs.existsSync(prdPath));
  assert.match(fs.readFileSync(prdPath, 'utf8'), /Fake codex produced a draft/);
  assert.equal(state.step, 'refine');
  assert.equal(state.history.at(-1).step, 'prd');
});

test('draft-prd exits promptly after success artifacts even if codex lingers', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_HANG_MS: '10000',
  });
  createFakeCodex(fakeBin);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'draft this task'], {
    cwd: projectDir,
    env,
  }).trim();

  const started = Date.now();
  runNode([path.join(repoRoot, 'bin/draft-prd.js'), sessionDir, 'draft this task'], {
    cwd: projectDir,
    env,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `draft-prd took too long after success: ${elapsed}ms`);
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd.md')));
});

test('spawn-refinement-team writes the manifest and ticket files', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  createFakeCodex(fakeBin);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(
    path.join(sessionDir, 'prd.md'),
    '# PRD\n\n## Summary\nRefinement test\n\n## Task Breakdown\n| Order | ID | Title | Priority | Phase | Depends On |\n|---|---|---|---|---|---|\n| 10 | ticket-001 | Harden tests | P1 | 0 | none |\n',
  );

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  assert.equal(manifest.tickets.length, 1);
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd_refined.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));

  const ticket = parseTicketFile(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md'));
  assert.equal(ticket.status, 'Todo');
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'research');
  assert.equal(state.history.at(-1).step, 'refine');
});

test('spawn-refinement-team exits promptly after success artifacts even if codex lingers', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_HANG_MS: '10000',
  });
  createFakeCodex(fakeBin);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(
    path.join(sessionDir, 'prd.md'),
    '# PRD\n\n## Summary\nRefinement test\n\n## Task Breakdown\n| Order | ID | Title | Priority | Phase | Depends On |\n|---|---|---|---|---|---|\n| 10 | ticket-001 | Harden tests | P1 | 0 | none |\n',
  );

  const started = Date.now();
  runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `spawn-refinement-team took too long after success: ${elapsed}ms`);
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd_refined.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')));
});
