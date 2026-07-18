import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRunnerDescriptors } from '../services/runner-descriptors.js';

// repoRoot resolves to the extension/ package root (parent of extension/tests/).
// runNode/runBash bin invocations therefore target the COMPILED extension/bin/*.js.
export const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

// projectRoot is the git repository root (parent of extension/), where install.sh lives.
export const projectRoot = path.resolve(repoRoot, '..');

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
    PICKLE_TEST_MODE: '1',
    PICKLE_TEST_QUALITY_COMMANDS: '["node -e \\\"process.exit(0)\\\""]',
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
}

// Source injected into bespoke fake-Codex executables so every worker test honors
// the same persisted lifecycle-artifact contract as the shared fake.
export function fakeLifecycleArtifactWriterSource() {
  return String.raw`
function writeFakeLifecycleArtifact(prompt, phase) {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('Lifecycle artifact path: '));
  const artifactPath = line ? line.slice('Lifecycle artifact path: '.length).trim() : '';
  if (!artifactPath) return;
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const ticketId = path.basename(path.dirname(artifactPath));
  const criteriaLine = prompt.split('\n').find((candidate) => candidate.startsWith('Required acceptance criteria JSON: '));
  const criteria = criteriaLine ? JSON.parse(criteriaLine.slice('Required acceptance criteria JSON: '.length)) : [];
  const base = { schema_version: 1, phase, ticket_id: ticketId, summary: 'approved ' + phase };
  const artifact = phase === 'research' ? { ...base, evidence: ['research evidence'] }
    : phase === 'research_review' || phase === 'plan_review' ? { ...base, verdict: 'approved', evidence: ['review evidence'] }
    : phase === 'plan' ? { ...base, steps: ['implement the ticket'] }
    : phase === 'implement' ? { ...base, files_changed: [], verification: ['fake verification'] }
    : phase === 'review' ? { ...base, verdict: 'approved', implementation_reviewed: true, evidence: ['implementation reviewed'] }
    : phase === 'simplify' ? { ...base, verification: ['fake verification'] }
    : { ...base, verdict: 'all_pass', implementation_reviewed: true, acceptance_criteria: criteria.map((criterion) => ({ criterion, status: 'pass', evidence: 'fake evidence' })) };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
}
`;
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

if (args[0] === 'exec' && args[1] === '--help') {
  console.log('Usage: codex exec [--cd DIR] [--json] [--add-dir DIR] [--output-last-message FILE]');
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

function writeLifecycleArtifact(phase) {
  const artifactPath = extractPathAfter('Lifecycle artifact path: ');
  const missingPhase = process.env.FAKE_LIFECYCLE_MISSING_PHASE || '';
  if (!artifactPath || phase === missingPhase) return;
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const ticketId = path.basename(path.dirname(artifactPath));
  const criteriaLine = prompt.split('\\n').find((candidate) => candidate.startsWith('Required acceptance criteria JSON: '));
  const criteria = criteriaLine ? JSON.parse(criteriaLine.slice('Required acceptance criteria JSON: '.length)) : [];
  const base = { schema_version: 1, phase, ticket_id: ticketId, summary: 'approved ' + phase + ' marker' };
  const artifact = phase === 'research'
    ? { ...base, evidence: ['approved research marker'] }
    : phase === 'research_review' || phase === 'plan_review'
      ? { ...base, verdict: 'approved', evidence: ['approved ' + phase + ' evidence'] }
      : phase === 'plan'
        ? { ...base, steps: ['approved plan marker'] }
        : phase === 'implement'
          ? { ...base, files_changed: process.env.FAKE_CODEX_MUTATE_FILE ? [process.env.FAKE_CODEX_MUTATE_FILE] : [], verification: ['fake implementation verification'] }
          : phase === 'review'
            ? { ...base, verdict: 'approved', implementation_reviewed: true, evidence: ['reviewed implementation diff'] }
            : phase === 'simplify'
              ? { ...base, verification: ['fake simplification verification'] }
              : { ...base, verdict: 'all_pass', implementation_reviewed: true, acceptance_criteria: criteria.map((criterion) => ({ criterion, status: 'pass', evidence: 'fake conformance evidence' })) };
  if (phase === (process.env.FAKE_LIFECYCLE_INVALID_PHASE || '')) artifact.summary = '';
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  const promptLog = process.env.FAKE_LIFECYCLE_PROMPT_LOG || '';
  if (promptLog) {
    fs.mkdirSync(promptLog, { recursive: true });
    fs.writeFileSync(path.join(promptLog, phase + '.prompt.txt'), prompt);
  }
}

if (prompt.includes('You are the Citadel release reviewer')) {
  const reportPath = extractPathAfter('Citadel report path: ');
  const criteriaLine = prompt.split('\\n').find((candidate) => candidate.startsWith('Required acceptance criteria '));
  const expectedCriteria = criteriaLine ? JSON.parse(criteriaLine.slice(criteriaLine.indexOf(': ') + 2)) : [];
  if (!reportPath) {
    console.error('missing Citadel report path');
    process.exit(1);
  }
  fs.writeFileSync(reportPath, JSON.stringify({
    schema_version: 1,
    verdict: process.env.FAKE_CITADEL_VERDICT || 'approve',
    reviewed_range: 'fake..HEAD',
    acceptance_criteria_checked: process.env.FAKE_CITADEL_INCOMPLETE_COVERAGE === '1'
      ? expectedCriteria.slice(0, Math.max(0, expectedCriteria.length - 1))
      : expectedCriteria,
    findings: process.env.FAKE_CITADEL_VERDICT === 'block'
      ? [{ severity: 'high', title: 'Fake blocker', evidence: 'fake evidence', file: 'fake.js', line: 1, recommendation: 'fix it' }]
      : [],
    generated_at: '2026-07-18T00:00:00.000Z',
  }, null, 2));
  lastMessage = process.env.FAKE_CITADEL_NO_PROMISE === '1'
    ? JSON.stringify({ reviewed: true })
    : '<promise>THE_CITADEL_APPROVES</promise>';
} else if (prompt.includes('Loop mode:')) {
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
  const failAt = Number(process.env.FAKE_LOOP_FAIL_AT || '0');
  if (failAt > 0 && current === failAt) {
    console.error(process.env.FAKE_LOOP_ERROR_MESSAGE || 'fake loop failure');
    process.exit(Number(process.env.FAKE_LOOP_EXIT_CODE || '1'));
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
          allowed_paths: ['README.md'],
          priority: 'P1',
          status: 'Todo',
        },
      ],
    }, null, 2),
  );
  lastMessage = '<promise>REFINEMENT_COMPLETE</promise>';
} else if (!fs.existsSync(prdPath) && !prompt.includes('You are executing the "')) {
  fs.writeFileSync(
    prdPath,
    '# PRD\\n\\n## Summary\\nFake codex produced a draft.\\n\\n## Verification\\n- \`npm test\`\\n',
  );
  lastMessage = '<promise>PRD_COMPLETE</promise>';
} else if (prompt.includes('You are executing the "')) {
  const phase = extractTicketPhase();
  writeLifecycleArtifact(phase);
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
          allowed_paths: ['README.md'],
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
const loopHangMs = prompt.includes('Loop mode:') ? Number(process.env.FAKE_LOOP_HANG_MS || '0') : 0;
const effectiveHangMs = loopHangMs || hangMs;
if (effectiveHangMs > 0) {
  setTimeout(() => process.exit(0), effectiveHangMs);
} else {
process.exit(0);
}
`,
  );
}

export function createFakeTmux(binDir) {
  const runnerDescriptors = listRunnerDescriptors();
  return writeExecutable(
    path.join(binDir, 'tmux'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_TMUX_LOG || '';
const runnerDescriptors = ${JSON.stringify(runnerDescriptors)};

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
    state.tmux_runner_pid = Number(process.env.FAKE_TMUX_RUNNER_PID || 4242);
    state.last_exit_reason = null;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  const descriptor = runnerDescriptors[mode];
  if (!descriptor) {
    return;
  }
  fs.appendFileSync(
    path.join(sessionDir, descriptor.runnerLog),
    '[2026-04-18T00:00:00.000Z] ' + descriptor.runnerStartMarker + ' (fake)\\n',
  );
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
  const runnerMode = Object.entries(runnerDescriptors).find(([, descriptor]) => command.includes(descriptor.runnerBin))?.[0];
  if (runnerMode) {
    simulateRunnerStart(runnerMode);
  }
  process.exit(0);
}

process.exit(0);
`,
  );
}
