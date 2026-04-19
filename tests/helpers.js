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

export async function waitFor(assertReady, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await assertReady();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(options.message || 'Timed out waiting for condition');
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

function extractPathAfter(prefix) {
  const line = prompt.split('\\n').find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.)]+$/, '') : '';
}

function extractTicketPhase() {
  const match = prompt.match(/You are executing the "([^"]+)" phase/);
  return match ? match[1] : '';
}

if (prompt.includes('Loop mode:')) {
  const counterPath = path.join(sessionDir, 'fake-loop-count.txt');
  const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;
  fs.writeFileSync(counterPath, String(current));
  fs.writeFileSync(path.join(sessionDir, 'loop-iteration-' + current + '.txt'), prompt);
  const loopModeMatch = prompt.match(/Loop mode: ([^\\n]+)/);
  const loopMode = loopModeMatch ? loopModeMatch[1].trim() : 'loop';
  const loopMutateFile = process.env.FAKE_LOOP_MUTATE_FILE || '';
  if (loopMutateFile) {
    const targetPath = path.resolve(process.cwd(), loopMutateFile);
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const suffix = process.env.FAKE_LOOP_APPEND_TEXT || '';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, existing + suffix);
  }
  if (process.env.FAKE_LOOP_WRITE_SUMMARY === 'changing' || process.env.FAKE_LOOP_WRITE_SUMMARY === 'static') {
    const summaryVariant = process.env.FAKE_LOOP_WRITE_SUMMARY;
    const summaryId = summaryVariant === 'changing' ? current : 1;
    const finding = 'Fake correctness finding #' + summaryId;
    const summary = {
      finding_family: process.env.FAKE_LOOP_FINDING_FAMILY || 'fake-correctness-family',
      highest_severity_finding: finding,
      data_flow_path: 'input -> parser -> runner -> output',
      fix_applied: summaryVariant === 'changing' ? 'tightened guard #' + summaryId : 'static fix',
      verification: ['node --test tests/session-flow.test.js'],
      trap_doors: ['guard drift'],
      next_action: summaryVariant === 'changing' ? 'continue' : 'new evidence required',
    };
    fs.writeFileSync(path.join(sessionDir, loopMode + '-summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(sessionDir, loopMode + '-summary.md'),
      [
        '# Summary',
        '',
        '- Finding Family: ' + summary.finding_family,
        '- Highest-Severity Finding: ' + summary.highest_severity_finding,
        '- Data Flow Path: ' + summary.data_flow_path,
        '- Fix Applied: ' + summary.fix_applied,
      ].join('\\n'),
    );
  }
  const completeAfter = Number(process.env.FAKE_LOOP_COMPLETE_AFTER || '2');
  lastMessage = current >= completeAfter ? '<promise>LOOP_COMPLETE</promise>' : '<promise>CONTINUE</promise>';
} else if (prompt.includes('Refinement analyst role:')) {
  const analysisPath = extractPathAfter('Write your analyst report to ');
  if (!analysisPath) {
    console.error('missing analysis path in analyst prompt');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
  fs.writeFileSync(
    analysisPath,
    [
      '# Analyst Report',
      '',
      '## Findings',
      '- Fake codex found a refinement issue.',
      '',
      '## Recommended Changes',
      '- Clarify acceptance criteria and execution order.',
      '',
      '## Verification Gaps',
      '- Add at least one concrete verification command.',
      '',
      '## Ticketing Notes',
      '- Keep the first ticket atomic and runnable.',
      '',
    ].join('\\n'),
  );
  lastMessage = '<promise>ANALYST_COMPLETE</promise>';
} else if (prompt.includes('You are synthesizing parallel PRD refinement analyst reports')) {
  fs.writeFileSync(
    refinedPath,
    '# Refined PRD\\n\\n## Summary\\nSynthesized from analyst reports.\\n\\n## Execution Notes\\n- Start with the safest atomic ticket.\\n',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      generated_at: '2026-04-15T00:00:00.000Z',
      source: 'fake-codex-synthesis',
      tickets: [
        {
          id: 'ticket-001',
          title: 'Harden tests',
          description: 'Stub ticket emitted by fake codex synthesis.',
          acceptance_criteria: [
            'The refined ticket carries concrete acceptance criteria.',
            'The refined ticket carries at least one ticket-specific verification command.',
          ],
          verification: ['test -f README.md'],
          priority: 'P1',
          status: 'Todo',
        },
      ],
    }, null, 2),
  );
  lastMessage = '<promise>REFINEMENT_COMPLETE</promise>';
} else if (!fs.existsSync(prdPath)) {
  fs.writeFileSync(
    prdPath,
    '# PRD\\n\\n## Summary\\nFake codex produced a draft.\\n\\n## Verification\\n- \`npm test\`\\n',
  );
  lastMessage = '<promise>PRD_COMPLETE</promise>';
} else if (prompt.includes('You are executing the "')) {
  const phase = extractTicketPhase();
  const mutatePhase = process.env.FAKE_CODEX_MUTATE_PHASE || 'implement';
  const mutateFile = process.env.FAKE_CODEX_MUTATE_FILE || '';
  if (mutateFile && phase === mutatePhase) {
    const targetPath = path.resolve(process.cwd(), mutateFile);
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const suffix = process.env.FAKE_CODEX_APPEND_TEXT || '';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, existing + suffix);
  }
  lastMessage = phase ? '<promise>' + phase.toUpperCase() + '_COMPLETE</promise>' : '<promise>OK</promise>';
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
          acceptance_criteria: [
            'The refined ticket carries concrete acceptance criteria.',
            'The refined ticket carries at least one ticket-specific verification command.',
          ],
          verification: ['test -f README.md'],
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
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_TMUX_LOG || '';

function latestSessionDir() {
  const dataRoot = process.env.PICKLE_DATA_ROOT || '';
  const sessionsRoot = dataRoot ? path.join(dataRoot, 'sessions') : '';
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) {
    return '';
  }
  const sessionDirs = fs.readdirSync(sessionsRoot)
    .map((name) => path.join(sessionsRoot, name))
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return sessionDirs[0] || '';
}

function simulateRunnerStart(mode) {
  if (process.env.FAKE_TMUX_RUNNER_START === 'never') {
    return;
  }
  const sessionDir = latestSessionDir();
  if (!sessionDir) {
    return;
  }
  const statePath = path.join(sessionDir, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.active = true;
    state.tmux_runner_pid = 4242;
    state.last_exit_reason = null;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  const runnerLogName = mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log';
  const runnerMarker = mode === 'pickle' ? 'mux-runner started' : 'loop-runner started (fake)';
  fs.appendFileSync(path.join(sessionDir, runnerLogName), '[2026-04-18T00:00:00.000Z] ' + runnerMarker + '\\n');
}

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
}

if (args[0] === '-V') {
  console.log('tmux 3.4-test');
  process.exit(0);
}

const failOn = process.env.FAKE_TMUX_FAIL_ON || '';
if (failOn && args[0] === failOn) {
  console.error('fake tmux forced failure on ' + failOn);
  process.exit(1);
}

if ((args[0] === 'new-window' || args[0] === 'split-window') && args.includes('-P')) {
  const counterPath = (logPath || '/tmp/fake-tmux') + '.pane-counter';
  const next = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '-1') + 1;
  fs.writeFileSync(counterPath, String(next));
  const paneId = '%' + next;
  console.log(paneId);
  process.exit(0);
}

if (args[0] === 'respawn-pane') {
  const command = args.at(-1) || '';
  if (command.includes('mux-runner.js')) {
    simulateRunnerStart('pickle');
  } else if (command.includes('loop-runner.js')) {
    simulateRunnerStart('loop');
  }
  process.exit(0);
}

process.exit(0);
`,
  );
}
