import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored } from '../lib/codex.js';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, createFakeCodex, prependPath, writeExecutable } from './helpers.js';

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

test('draft-prd ignores stale success artifacts from an earlier attempt', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}

let outputLastMessagePath = '';
const addDirs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--output-last-message') {
    outputLastMessagePath = args[index + 1] || '';
    index += 1;
  } else if (args[index] === '--add-dir') {
    addDirs.push(args[index + 1] || '');
    index += 1;
  }
}

const sessionDir = addDirs.at(-1);
const prdPath = path.join(sessionDir, 'prd.md');
setTimeout(() => {
  fs.writeFileSync(prdPath, '# PRD\\n\\n## Summary\\nFresh draft after stale cleanup.\\n');
  if (outputLastMessagePath) {
    fs.writeFileSync(outputLastMessagePath, '<promise>PRD_COMPLETE</promise>');
  }
  console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
}, 1200);
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'draft this task'], {
    cwd: projectDir,
    env,
  }).trim();

  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nStale draft.\n');
  fs.writeFileSync(path.join(sessionDir, 'draft-prd.last-message.txt'), '<promise>PRD_COMPLETE</promise>');

  const started = Date.now();
  runNode([path.join(repoRoot, 'bin/draft-prd.js'), sessionDir, 'draft this task'], {
    cwd: projectDir,
    env,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 1000, `draft-prd returned too early from stale artifacts: ${elapsed}ms`);
  assert.match(fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf8'), /Fresh draft after stale cleanup/);
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
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-requirements.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-codebase.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-risk.md')));
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
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-requirements.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-codebase.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'analyst-risk.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd_refined.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')));
});

test('runCodexExecMonitored ignores stale last-message success artifacts', async () => {
  const runtimeDir = makeTempRoot('pickle-rick-codex-bin-');
  const artifactDir = makeTempRoot('pickle-rick-artifacts-');
  const prdPath = path.join(artifactDir, 'prd.md');
  const messagePath = path.join(artifactDir, 'draft-prd.last-message.txt');
  fs.writeFileSync(prdPath, '# stale prd\n');
  fs.writeFileSync(messagePath, '<promise>PRD_COMPLETE</promise>');

  const codexPath = path.join(runtimeDir, 'codex');
  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}

setTimeout(() => {
  console.error('fake codex failed');
  process.exit(1);
}, 600);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(codexPath, 0o755);

  const started = Date.now();
  const result = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'draft prd',
    timeoutMs: 2_000,
    outputLastMessagePath: messagePath,
    successCheck: ({ lastMessage }) =>
      fs.existsSync(prdPath) && /<promise>\s*PRD_COMPLETE\s*<\/promise>/.test(lastMessage),
  });

  assert.ok(Date.now() - started >= 500);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.cancelled, false);
  assert.equal(result.lastMessage, '');
});
