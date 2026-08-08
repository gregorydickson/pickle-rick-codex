// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored } from '../services/codex.js';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
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
  assert.equal(parsed.guaranteed_path, 'codex exec --sandbox workspace-write');
  assert.deepEqual(parsed.exec_capabilities, {
    '--cd': true,
    '--json': true,
    '--add-dir': true,
    '--output-last-message': true,
  });
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

test('draft-prd does not advance to refine when codex fails before producing a PRD', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
console.error('fake draft failure');
process.exit(1);
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'draft failing task'], {
    cwd: projectDir,
    env,
  }).trim();

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/draft-prd.js'), sessionDir, 'draft failing task'], {
      cwd: projectDir,
      env,
    }),
    /PRD drafting failed: fake draft failure/,
  );

  assert.equal(fs.existsSync(path.join(sessionDir, 'prd.md')), false);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'prd');
});

test('spawn-refinement-team writes the manifest and ticket files', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const invocationLog = path.join(makeTempRoot('pickle-refinement-invocations-'), 'calls.jsonl');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
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
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(invocations.length, 4);
  const workerRoot = fs.realpathSync(path.join(sessionDir, '.refinement-workers')) + path.sep;
  for (const invocation of invocations) {
    assert.ok(fs.realpathSync(invocation.cwd).startsWith(workerRoot));
    assert.ok(invocation.args.includes('--sandbox'));
    assert.ok(invocation.args.includes('workspace-write'));
    assert.equal(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(invocation.args.includes('--add-dir'), false);
    assert.match(invocation.prompt, /working repository is read-only/i);
  }
});

test('spawn-refinement-team falls back when an analyst exits zero without completing its artifact contract', () => {
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

function writeRefinement(source) {
  fs.writeFileSync(refinedPath, '# Refined PRD\\n');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-08-01T00:00:00.000Z',
      source,
      tickets: [
        {
          id: 'ticket-001',
          title: 'Require complete analyst evidence',
          description: 'Only a complete analyst fanout may enter synthesis.',
          acceptance_criteria: ['Incomplete analyst output forces the single-pass fallback.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
}

if (prompt.includes('Refinement analyst role:')) {
  const analysisPath = extractPathAfter('Write your analyst report to ');
  fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
  fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n- Partial analyst output.\\n');
  if (!prompt.includes('Refinement analyst role: requirements-gaps') && outputLastMessagePath) {
    fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
  }
  // The requirements analyst exits zero without its ANALYST_COMPLETE promise.
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  writeRefinement('synthesis-with-partial-analyst');
} else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
  writeRefinement('fallback-after-partial-analyst');
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
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  assert.equal(manifest.source, 'fallback-after-partial-analyst');
  assert.equal(fs.existsSync(path.join(sessionDir, 'analyst-requirements.md')), false);
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const refineLog = fs.readFileSync(path.join(sessionDir, 'refine.log'), 'utf8');
  assert.match(refineLog, /Analyst retries exhausted; using explicit single-pass fallback\./);
  assert.doesNotMatch(refineLog, /Starting refinement synthesis\./);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'research');
});

test('spawn-refinement-team drains failed analyst fanout before starting fallback', () => {
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
const sourcePrd = prompt.match(/^Read (.+)$/m)?.[1]?.trim().replace(/\.$/, '') || path.join(sessionDir, 'prd.md');
const controlSessionDir = path.dirname(sourcePrd);

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function analystRole() {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith('Refinement analyst role: '));
  return line ? line.slice('Refinement analyst role: '.length).trim() : '';
}

async function main() {
  if (prompt.includes('Refinement analyst role:')) {
    const role = analystRole();
    if (role === 'requirements-gaps') {
      await sleep(300);
      console.error('requirements analyst failed');
      process.exit(1);
      return;
    }

    const activePath = path.join(controlSessionDir, 'analyst-active-' + role);
    fs.writeFileSync(activePath, String(process.pid));
    const stop = () => {
      fs.rmSync(activePath, { force: true });
      process.exit(130);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    await sleep(3000);
    fs.rmSync(activePath, { force: true });
    const analysisPath = extractPathAfter('Write your analyst report to ');
    fs.writeFileSync(analysisPath, '# Late Analyst Report\\n');
    if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
  } else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
    const activeAnalysts = fs.readdirSync(controlSessionDir).filter((entry) => entry.startsWith('analyst-active-'));
    if (activeAnalysts.length > 0) {
      console.error('fallback overlapped active analysts: ' + activeAnalysts.join(', '));
      process.exit(1);
      return;
    }
    fs.writeFileSync(refinedPath, '# Refined PRD after drained fanout\\n');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        source: 'fallback-after-drained-fanout',
        tickets: [
          {
            id: 'ticket-001',
            title: 'Drain analyst fanout',
            description: 'Fallback starts only after every failed-fanout child has stopped.',
            acceptance_criteria: ['No analyst process overlaps fallback refinement.'],
            verification: ['test -f README.md'],
            allowed_paths: ['README.md'],
            priority: 'P1',
            status: 'Todo'
          }
        ]
      }, null, 2),
    );
    if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
  } else {
    console.error('synthesis must not run after failed analyst fanout');
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

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  assert.equal(manifest.source, 'fallback-after-drained-fanout');
  assert.deepEqual(
    fs.readdirSync(sessionDir).filter((entry) => entry.startsWith('analyst-active-')),
    [],
  );
  assert.equal(fs.existsSync(path.join(sessionDir, 'analyst-codebase.md')), true);
  assert.equal(fs.existsSync(path.join(sessionDir, 'analyst-risk.md')), true);
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'research');
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

test('spawn-refinement-team preserves canonical artifacts when candidate synthesis is rejected', () => {
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
  fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n- Complete.\\n');
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  fs.writeFileSync(refinedPath, '# Rejected Refined PRD\\n');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      source: 'rejected-synthesis',
      tickets: [
        {
          id: 'API Client',
          title: 'Implement API client',
          description: 'First ticket at the normalized file key.',
          acceptance_criteria: ['The client sends authenticated requests.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        },
        {
          id: 'api-client',
          title: 'Verify API client retries',
          description: 'Second ticket colliding at the same normalized file key.',
          acceptance_criteria: ['Transient failures retry within the configured limit.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
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
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');
  const priorRefined = '# Previously accepted refined PRD\n';
  const priorManifest = JSON.stringify({
    source: 'previously-accepted',
    tickets: [{
      id: 'existing-ticket',
      title: 'Keep accepted output',
      description: 'A rejected replacement cannot overwrite the last accepted refinement.',
      acceptance_criteria: ['The canonical artifacts remain byte-identical after rejection.'],
      verification: ['test -f README.md'],
      allowed_paths: ['README.md'],
      priority: 'P1',
      status: 'Todo',
    }],
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), priorRefined);
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), priorManifest);

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
      cwd: projectDir,
      env,
    }),
    /duplicate normalized ticket id "api-client"/,
  );

  assert.equal(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'), priorManifest);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'prd_refined.md'), 'utf8'), priorRefined);
  assert.equal(fs.existsSync(path.join(sessionDir, 'api-client', 'linear_ticket_api-client.md')), false);
});

test('spawn-refinement-team stops when analyst fallback refinement fails before synthesis', () => {
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

if (prompt.includes('Refinement analyst role:')) {
  console.error('fake analyst failure');
  process.exit(1);
} else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
  console.error('fake fallback failure');
  process.exit(1);
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  fs.writeFileSync(refinedPath, '# Synthesized Refined PRD\\n');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-06-24T00:00:00.000Z',
      source: 'masked-synthesis',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Should never materialize',
          description: 'Synthesis should not run after a failed fallback refinement.',
          acceptance_criteria: ['Unreachable.'],
          verification: ['npm test'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
  process.exit(0);
}

console.error('unexpected prompt');
process.exit(1);
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
    /PRD refinement fallback failed: fake fallback failure/,
  );

  assert.ok(!fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'refine:fallback');
});

test('spawn-refinement-team materializes successful fallback output without running synthesis', () => {
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

if (prompt.includes('Refinement analyst role:')) {
  console.error('fake analyst failure');
  process.exit(1);
} else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
  fs.writeFileSync(refinedPath, '# Fallback Refined PRD\\n');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-08-01T00:00:00.000Z',
      source: 'single-pass-fallback',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Preserve fallback output',
          description: 'Use successful single-pass refinement after analyst failure.',
          acceptance_criteria: ['The fallback ticket is materialized without a synthesis pass.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
  console.log(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3 } }));
  process.exit(0);
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  console.error('synthesis must not run after successful fallback');
  process.exit(1);
}

console.error('unexpected prompt');
process.exit(1);
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  assert.equal(manifest.source, 'single-pass-fallback');
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd_refined.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'research');
  assert.equal(state.history.at(-1).step, 'refine');
});

test('spawn-refinement-team blocks recursive refinement inherited by a fallback leaf worker', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    REFINEMENT_ENTRY_PATH: path.join(repoRoot, 'bin/spawn-refinement-team.js'),
  });
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
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

if (prompt.includes('Refinement analyst role:')) {
  console.error('force single-pass fallback');
  process.exit(1);
} else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
  const sourcePrd = prompt.match(/^Read (.+)$/m)?.[1]?.trim().replace(/\.$/, '') || path.join(sessionDir, 'prd.md');
  const controlSessionDir = process.env.CONTROL_SESSION_DIR || path.dirname(sourcePrd);
  const nested = spawnSync(
    process.execPath,
    [process.env.REFINEMENT_ENTRY_PATH, controlSessionDir],
    { env: process.env, encoding: 'utf8' },
  );
  fs.writeFileSync(
    path.join(controlSessionDir, 'nested-refinement-result.json'),
    JSON.stringify({ status: nested.status, stderr: nested.stderr }, null, 2),
  );
  if (
    process.env.PICKLE_REFINEMENT_LEAF !== '1' ||
    nested.status === 0 ||
    !nested.stderr.includes('Refinement leaf workers cannot launch refinement orchestration.')
  ) {
    console.error('recursive refinement was not blocked');
    process.exit(1);
  }
  fs.writeFileSync(refinedPath, '# Leaf-safe Fallback Refined PRD\\n');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      source: 'leaf-safe-fallback',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Block recursive refinement',
          description: 'A refinement leaf worker cannot relaunch its own orchestrator.',
          acceptance_criteria: ['The nested refinement entrypoint fails before mutating session state.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
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
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');
  env.CONTROL_SESSION_DIR = sessionDir;

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  const nested = readJsonFile(path.join(sessionDir, 'nested-refinement-result.json'));
  assert.equal(manifest.source, 'leaf-safe-fallback');
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /Refinement leaf workers cannot launch refinement orchestration/);
  const refineLog = fs.readFileSync(path.join(sessionDir, 'refine.log'), 'utf8');
  assert.equal((refineLog.match(/Starting analyst fanout\./g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(sessionDir, '.refinement-run.lock')), false);
});

test('spawn-refinement-team refuses a second live owner for the same session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  createFakeCodex(fakeBin);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'refine this task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');
  const lockPath = path.join(sessionDir, '.refinement-run.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));

  try {
    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
        cwd: projectDir,
        env,
      }),
      /Refinement is already running for session/,
    );
    assert.equal(fs.existsSync(path.join(sessionDir, 'refine.log')), false);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('spawn-refinement-team rejects partial fallback output after a clean codex exit', () => {
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

const addDirs = [];
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--add-dir') {
    addDirs.push(args[index + 1] || '');
    index += 1;
  }
}

const sessionDir = addDirs.at(-1) || process.cwd();
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

if (prompt.includes('Refinement analyst role:')) {
  console.error('fake analyst failure');
  process.exit(1);
} else if (prompt.includes('Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.')) {
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-08-01T00:00:00.000Z',
      source: 'partial-fallback',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Partial fallback must not run',
          description: 'This manifest was written before fallback completed its artifact contract.',
          acceptance_criteria: ['Only complete fallback output can become executable work.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
  // Exit zero without prd_refined.md or the REFINEMENT_COMPLETE promise.
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
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
      cwd: projectDir,
      env,
    }),
    /Refinement manifest rejected after bounded fallback repair/,
  );

  assert.equal(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'prd_refined.md')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')), false);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'refine:fallback');
});

test('spawn-refinement-team rejects partial synthesis output after a clean codex exit', () => {
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
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

if (prompt.includes('Refinement analyst role:')) {
  const analysisPath = extractPathAfter('Write your analyst report to ');
  fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
  fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n- Complete.\\n');
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-08-01T00:00:00.000Z',
      source: 'partial-failed-synthesis',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Partial synthesis must not run',
          description: 'This manifest was written before synthesis completed its artifact contract.',
          acceptance_criteria: ['Only complete synthesis output can become executable work.'],
          verification: ['test -f README.md'],
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo'
        }
      ]
    }, null, 2),
  );
  // Exit zero without prd_refined.md or the REFINEMENT_COMPLETE promise.
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
    '# PRD\n\n## Summary\nRefinement test\n',
  );

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
      cwd: projectDir,
      env,
    }),
    /Refinement manifest rejected after bounded synthesis repair/,
  );

  assert.equal(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'prd_refined.md')), false);
  assert.ok(!fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'refine:fallback');
});

test('spawn-refinement-team feeds semantic validation errors into one clean synthesis repair', () => {
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
const sourcePrd = prompt.match(/^Read (.+)$/m)?.[1]?.trim().replace(/\.$/, '') || path.join(sessionDir, 'prd.md');
const attemptsPath = process.env.SYNTHESIS_ATTEMPTS_PATH || path.join(path.dirname(sourcePrd), 'synthesis-attempts.txt');

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

if (prompt.includes('Refinement analyst role:')) {
  const analysisPath = extractPathAfter('Write your analyst report to ');
  fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
  fs.writeFileSync(analysisPath, '# Analyst Report\\n\\n- Complete.\\n');
  if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  const attempt = Number(fs.existsSync(attemptsPath) ? fs.readFileSync(attemptsPath, 'utf8') : '0') + 1;
  fs.writeFileSync(attemptsPath, String(attempt));
  if (attempt === 1) {
    fs.writeFileSync(refinedPath, '# Semantically invalid refined PRD\\n');
    fs.writeFileSync(manifestPath, JSON.stringify({
      source: 'invalid-first-synthesis',
      tickets: [{
        id: 'ticket-001',
        title: 'Reject glob scope',
        description: 'The first candidate contains a scope contract the runtime cannot enforce.',
        acceptance_criteria: ['The repair replaces the glob with a literal path.'],
        verification: ['test -f README.md'],
        allowed_paths: ['**/*.ts'],
        priority: 'P1',
        status: 'Todo'
      }]
    }, null, 2));
    if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
  } else if (attempt === 2) {
    if (!prompt.includes('allowed_paths must contain at least one literal repo-relative path')) {
      console.error('repair prompt omitted the production validator diagnostics');
      process.exit(1);
    }
    if (fs.existsSync(refinedPath) || fs.existsSync(manifestPath)) {
      console.error('partial synthesis artifacts were not discarded before retry');
      process.exit(1);
    }
    fs.writeFileSync(refinedPath, '# Recovered Refined PRD\\n');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        source: 'bounded-synthesis-recovery',
        tickets: [
          {
            id: 'ticket-001',
            title: 'Recover partial synthesis',
            description: 'Replay synthesis from preserved analyst checkpoints.',
            acceptance_criteria: ['One incomplete synthesis receives exactly one clean retry.'],
            verification: ['test -f README.md'],
            allowed_paths: ['README.md'],
            priority: 'P1',
            status: 'Todo'
          }
        ]
      }, null, 2),
    );
    if (outputLastMessagePath) fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
  } else {
    console.error('synthesis retried more than once');
    process.exit(1);
  }
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
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nRefinement test\n');
  env.SYNTHESIS_ATTEMPTS_PATH = path.join(sessionDir, 'synthesis-attempts.txt');

  const output = runNode([path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env,
  }).trim();

  const manifest = JSON.parse(output);
  assert.equal(manifest.source, 'bounded-synthesis-recovery');
  assert.equal(fs.readFileSync(path.join(sessionDir, 'synthesis-attempts.txt'), 'utf8'), '2');
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  assert.match(
    fs.readFileSync(path.join(sessionDir, 'refine.log'), 'utf8'),
    /synthesis attempt 1 rejected; retrying once from preserved checkpoints/,
  );
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.step, 'research');
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
            allowed_paths: ['README.md'],
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

test('cancel stops every concurrent refinement analyst and releases session ownership', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
fs.readFileSync(0, 'utf8');
const stop = () => process.exit(143);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1000);
`,
  );

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'cancel refinement task'], {
    cwd: projectDir,
    env,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\n## Summary\nCancel the analyst fanout.\n');
  const controller = spawn('node', [path.join(repoRoot, 'bin/spawn-refinement-team.js'), sessionDir], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  controller.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const identities = await waitFor(() => {
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    return Array.isArray(state.refinement_child_identities) && state.refinement_child_identities.length === 3
      ? state.refinement_child_identities
      : null;
  }, { timeoutMs: 5_000, message: 'refinement did not persist all analyst identities' });

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', sessionDir], {
    cwd: projectDir,
    env,
  });
  const exitCode = await new Promise((resolve) => controller.on('exit', resolve));
  assert.notEqual(exitCode, 0, stderr);
  for (const identity of identities) {
    assert.throws(() => process.kill(identity.pid, 0));
  }
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.deepEqual(state.refinement_child_identities, []);
  assert.equal(fs.existsSync(path.join(sessionDir, '.session-operation.lock')), false);
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

test('runCodexExecMonitored drains SIGTERM final output and does not truncate last-message artifacts', async () => {
  const runtimeDir = makeTempRoot('pickle-codex-drain-');
  const artifactDir = makeTempRoot('pickle-codex-drain-artifacts-');
  const messagePath = path.join(artifactDir, 'phase.last-message.txt');
  const artifactPath = path.join(artifactDir, 'phase.json');
  const signalCountPath = path.join(artifactDir, 'sigterm-count.txt');
  const codexPath = path.join(runtimeDir, 'codex');
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex test'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, '<promise>DONE</promise>');
fs.writeFileSync(${JSON.stringify(artifactPath)}, '{"stage":"started"');
let signalCount = 0;
process.on('SIGTERM', () => {
  signalCount += 1;
  fs.writeFileSync(${JSON.stringify(signalCountPath)}, String(signalCount));
  if (signalCount > 1) return;
  fs.appendFileSync(output, '\\nFINAL-DRAINED');
  fs.appendFileSync(${JSON.stringify(artifactPath)}, ',"final":true}');
  setTimeout(() => process.exit(0), 180);
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  const result = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'drain',
    timeoutMs: 2_000,
    outputLastMessagePath: messagePath,
    progressArtifactPaths: [artifactPath],
    successSignalGraceMs: 100,
    successPollMs: 20,
    successCheck: ({ lastMessage }) => lastMessage.includes('<promise>DONE</promise>'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.terminatedAfterSuccess, true);
  assert.match(result.lastMessage, /FINAL-DRAINED/);
  assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), { stage: 'started', final: true });
  assert.equal(fs.readFileSync(signalCountPath, 'utf8'), '1');
});

test('terminal-usage grace yields before the absolute deadline and drains observed JSONL success', async () => {
  const runtimeDir = makeTempRoot('pickle-codex-usage-deadline-');
  const artifactDir = makeTempRoot('pickle-codex-usage-deadline-artifacts-');
  const messagePath = path.join(artifactDir, 'phase.last-message.txt');
  const artifactPath = path.join(artifactDir, 'phase.json');
  const codexPath = path.join(runtimeDir, 'codex');
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'deadline-test' }));
fs.writeFileSync(output, '<promise>DONE</promise>');
fs.writeFileSync(${JSON.stringify(artifactPath)}, JSON.stringify({ stage: 'started' }));
process.on('SIGTERM', () => {
  fs.appendFileSync(output, '\\nUSAGE-WAIT-DRAINED');
  fs.writeFileSync(${JSON.stringify(artifactPath)}, JSON.stringify({ stage: 'started', final: true }));
  setTimeout(() => process.exit(0), 30);
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  const result = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'bounded usage wait',
    timeoutMs: 800,
    outputLastMessagePath: messagePath,
    progressArtifactPaths: [artifactPath],
    successSignalGraceMs: 100,
    successPollMs: 20,
    successCheck: ({ lastMessage }) => lastMessage.includes('<promise>DONE</promise>'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminatedAfterSuccess, true);
  assert.equal(result.usageReported, false);
  assert.match(result.lastMessage, /USAGE-WAIT-DRAINED/);
  assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), { stage: 'started', final: true });
});

test('absolute deadline recognizes unpolled success before classifying the command as timed out', async () => {
  const runtimeDir = makeTempRoot('pickle-codex-deadline-success-');
  const artifactDir = makeTempRoot('pickle-codex-deadline-success-artifacts-');
  const messagePath = path.join(artifactDir, 'phase.last-message.txt');
  const codexPath = path.join(runtimeDir, 'codex');
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
process.on('SIGTERM', () => {
  fs.appendFileSync(output, '\\nDEADLINE-DRAINED');
  setTimeout(() => process.exit(0), 30);
});
setTimeout(() => fs.writeFileSync(output, '<promise>DONE</promise>'), 50);
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  const result = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'deadline success check',
    timeoutMs: 400,
    outputLastMessagePath: messagePath,
    successSignalGraceMs: 100,
    successPollMs: 1_000,
    successCheck: ({ lastMessage }) => lastMessage.includes('<promise>DONE</promise>'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminatedAfterSuccess, true);
  assert.match(result.lastMessage, /DEADLINE-DRAINED/);
});

test('artifact progress extends success shutdown grace but never the absolute timeout', async () => {
  const runtimeDir = makeTempRoot('pickle-codex-progress-');
  const artifactDir = makeTempRoot('pickle-codex-progress-artifacts-');
  const messagePath = path.join(artifactDir, 'phase.last-message.txt');
  const artifactPath = path.join(artifactDir, 'progress.txt');
  const codexPath = path.join(runtimeDir, 'codex');
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex test'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, '<promise>DONE</promise>');
let count = 0;
const timer = setInterval(() => {
  fs.appendFileSync(${JSON.stringify(artifactPath)}, String(count++));
  if (process.env.FINITE_PROGRESS === '1' && count === 5) { clearInterval(timer); process.exit(0); }
}, 70);
`, { mode: 0o755 });

  const finite = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'progress',
    env: { FINITE_PROGRESS: '1' },
    timeoutMs: 2_000,
    outputLastMessagePath: messagePath,
    progressArtifactPaths: [artifactPath],
    successSignalGraceMs: 100,
    successPollMs: 20,
    successCheck: ({ lastMessage }) => lastMessage.includes('<promise>DONE</promise>'),
  });
  assert.equal(finite.exitCode, 0);
  assert.equal(finite.terminatedAfterSuccess, false);
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), '01234');

  const absolute = await runCodexExecMonitored({
    command: codexPath,
    prompt: 'progress forever',
    timeoutMs: 350,
    outputLastMessagePath: messagePath,
    progressArtifactPaths: [artifactPath],
    successSignalGraceMs: 100,
    successPollMs: 20,
    successCheck: ({ lastMessage }) => lastMessage.includes('<promise>DONE</promise>'),
  });
  assert.equal(absolute.exitCode, 124);
  assert.equal(absolute.timedOut, true);
});
