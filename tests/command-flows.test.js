import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored } from '../lib/codex.js';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, createFakeCodex, prependPath, waitFor, writeExecutable } from './helpers.js';

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

test('spawn-refinement-team rejects fallback task-table manifests instead of materializing placeholder tickets', () => {
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
const prompt = fs.readFileSync(0, 'utf8');

if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}

let outputLastMessagePath = '';
const addDirs = [];
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--output-last-message') {
    outputLastMessagePath = args[index + 1] || '';
    index += 1;
  } else if (args[index] === '--add-dir') {
    addDirs.push(args[index + 1] || '');
    index += 1;
  }
}

const sessionDir = addDirs.at(-1) || process.cwd();
const refinedPath = path.join(sessionDir, 'prd_refined.md');
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

if (prompt.includes('Refinement analyst role:')) {
  const analysisPath = extractPathAfter('Write your analyst report to ');
  fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
  fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n## Findings\\n- keep synthesis empty\\n');
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  fs.writeFileSync(refinedPath, '# Refined PRD\\n');
  fs.writeFileSync(manifestPath, JSON.stringify({ source: 'empty-synthesis', tickets: [] }, null, 2));
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
} else {
  console.error('unexpected prompt');
  process.exit(1);
}

console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(
    path.join(sessionDir, 'prd.md'),
    '# PRD\n\n## Summary\nRefinement test\n\n## Task Breakdown\n| Order | ID | Title | Priority | Phase | Depends On |\n|---|---|---|---|---|---|\n| 10 | ticket-001 | Harden tests | P1 | 0 | none |\n',
  );

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
      cwd: projectDir,
      env,
    }),
    /Refinement manifest rejected/,
  );
  assert.ok(!fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
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

test('spawn-refinement-team records refine phase transitions and progress logs', async () => {
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
const prompt = fs.readFileSync(0, 'utf8');

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

const sessionDir = addDirs.at(-1) || process.cwd();
const refinedPath = path.join(sessionDir, 'prd_refined.md');
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  if (prompt.includes('Refinement analyst role:')) {
    const analysisPath = extractPathAfter('Write your analyst report to ');
    if (!analysisPath) {
      console.error('missing analysis path');
      process.exit(1);
      return;
    }
    await sleep(150);
    fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
    fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n- Slow analyst output.\\n');
    if (outputLastMessagePath) {
      fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
    }
  } else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
    await sleep(350);
    fs.writeFileSync(refinedPath, '# Refined PRD\\n\\n## Summary\\nSlow synthesis complete.\\n');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        generated_at: '2026-04-15T00:00:00.000Z',
        source: 'slow-fake-codex',
        tickets: [
          {
            id: 'ticket-001',
            title: 'Observe refine phases',
            description: 'Keep the synthesis path slow enough to observe progress.',
            acceptance_criteria: ['The refinement completes.'],
            verification: ['npm test'],
            priority: 'P1',
            status: 'Todo',
          },
        ],
      }, null, 2),
    );
    if (outputLastMessagePath) {
      fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
    }
  } else {
    console.error('unexpected prompt');
    process.exit(1);
    return;
  }

  console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine phases task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(
    path.join(sessionDir, 'prd.md'),
    '# PRD\n\n## Summary\nRefinement phases test.\n\n## Task Breakdown\n| Order | ID | Title | Priority | Phase | Depends On |\n|---|---|---|---|---|---|\n| 10 | ticket-001 | Observe refine phases | P1 | 0 | none |\n',
  );

  const child = spawn('node', [path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(() => readJsonFile(path.join(sessionDir, 'state.json')).step === 'refine:analysts', {
    timeoutMs: 5_000,
    message: 'refinement never entered analyst phase',
  });
  await waitFor(() => {
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    const log = fs.existsSync(path.join(sessionDir, 'refine.log'))
      ? fs.readFileSync(path.join(sessionDir, 'refine.log'), 'utf8')
      : '';
    return state.step === 'refine:synthesis'
      && /Starting analyst fanout\./.test(log)
      && /Analyst fanout complete\./.test(log)
      && /Starting refinement synthesis\./.test(log);
  }, {
    timeoutMs: 5_000,
    message: 'refinement never reported synthesis progress',
  });

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 0, stderr);

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const refineLog = fs.readFileSync(path.join(sessionDir, 'refine.log'), 'utf8');
  assert.equal(state.step, 'research');
  assert.match(refineLog, /Starting analyst fanout\./);
  assert.match(refineLog, /Analyst fanout complete\./);
  assert.match(refineLog, /Starting refinement synthesis\./);
  assert.match(refineLog, /Materializing ticket files\./);
  assert.match(refineLog, /Refinement complete\./);
  assert.match(stderr, /\[refine\] Starting analyst fanout\./);
  assert.match(stderr, /\[refine\] Starting refinement synthesis\./);
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

test('runCodexExecMonitored treats observed success as success even if the process exits non-zero afterward', async () => {
  const runtimeDir = makeTempRoot('pickle-rick-codex-bin-');
  const artifactDir = makeTempRoot('pickle-rick-artifacts-');
  const artifactPath = path.join(artifactDir, 'phase.txt');
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

let outputLastMessagePath = '';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--output-last-message') {
    outputLastMessagePath = args[index + 1] || '';
    index += 1;
  }
}

setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(artifactPath)}, 'phase-complete\\n');
  if (outputLastMessagePath) {
    fs.writeFileSync(outputLastMessagePath, '<promise>IMPLEMENT_COMPLETE</promise>');
  }
  console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  setTimeout(() => process.exit(23), 150);
}, 50);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(codexPath, 0o755);

  const result = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'run implement phase',
    timeoutMs: 2_000,
    outputLastMessagePath: path.join(artifactDir, 'phase.last-message.txt'),
    successSignalGraceMs: 500,
    successPollMs: 25,
    successCheck: ({ lastMessage }) =>
      fs.existsSync(artifactPath) && /<promise>\s*IMPLEMENT_COMPLETE\s*<\/promise>/.test(lastMessage),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminatedAfterSuccess, false);
  assert.match(result.lastMessage, /IMPLEMENT_COMPLETE/);
});
