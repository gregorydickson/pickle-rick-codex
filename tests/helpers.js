import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

export function makeTempRoot(prefix = 'pickle-rick-codex-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runNode(args, options = {}) {
  return execFileSync('node', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
    input: options.input,
  });
}

export function runBash(args, options = {}) {
  return execFileSync('bash', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
    input: options.input,
  });
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

export function prependPath(binDir, env = {}) {
  return {
    ...env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
}

export function createFakeCodex(binDir) {
  return writeExecutable(
    path.join(binDir, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');

if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}

if (args[0] !== 'exec') {
  console.error('unexpected codex invocation');
  process.exit(1);
}

let outputLastMessagePath = '';
const addDirs = [];
for (let index = 1; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--output-last-message') {
    outputLastMessagePath = args[index + 1] || '';
    index += 1;
  } else if (arg === '--add-dir') {
    addDirs.push(args[index + 1] || '');
    index += 1;
  }
}

const sessionDir = addDirs.at(-1) || process.cwd();
const prdPath = path.join(sessionDir, 'prd.md');
const refinedPath = path.join(sessionDir, 'prd_refined.md');
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
let lastMessage = JSON.stringify({ ok: true }, null, 2);

if (prompt.includes('Loop mode:')) {
  const counterPath = path.join(sessionDir, 'fake-loop-count.txt');
  const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;
  fs.writeFileSync(counterPath, String(current));
  fs.writeFileSync(path.join(sessionDir, 'loop-iteration-' + current + '.txt'), prompt);
  const completeAfter = Number(process.env.FAKE_LOOP_COMPLETE_AFTER || '2');
  lastMessage = current >= completeAfter ? '<promise>LOOP_COMPLETE</promise>' : '<promise>CONTINUE</promise>';
} else if (!fs.existsSync(prdPath)) {
  fs.writeFileSync(
    prdPath,
    '# PRD\\n\\n## Summary\\nFake codex produced a draft.\\n\\n## Verification\\n- \`npm test\`\\n',
  );
  lastMessage = '<promise>PRD_COMPLETE</promise>';
} else {
  fs.writeFileSync(
    refinedPath,
    '# Refined PRD\\n\\n## Task Breakdown\\n| Order | ID | Title | Priority | Phase | Depends On |\\n|---|---|---|---|---|---|\\n| 10 | T0 | Harden tests | P1 | 0 | none |\\n',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-04-15T00:00:00.000Z',
      source: 'fake-codex',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Harden tests',
          description: 'Stub ticket emitted by fake codex.',
          acceptance_criteria: ['The ticket exists.'],
          verification: ['npm test'],
          priority: 'P1',
          status: 'Todo',
        },
      ],
    }, null, 2),
  );
  lastMessage = '<promise>REFINEMENT_COMPLETE</promise>';
}

if (outputLastMessagePath) {
  fs.writeFileSync(outputLastMessagePath, lastMessage);
}

console.log(JSON.stringify({
  usage: {
    input_tokens: 11,
    output_tokens: 22,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4,
  },
}));

const hangMs = Number(process.env.FAKE_CODEX_HANG_MS || '0');
if (hangMs > 0) {
  setTimeout(() => process.exit(0), hangMs);
} else {
process.exit(0);
}
`,
  );
}

export function createFakeTmux(binDir) {
  return writeExecutable(
    path.join(binDir, 'tmux'),
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_TMUX_LOG || '';

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
}

if (args[0] === '-V') {
  console.log('tmux 3.4-test');
  process.exit(0);
}

process.exit(0);
`,
  );
}
