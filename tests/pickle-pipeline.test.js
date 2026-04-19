import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import {
  createFakeCodex,
  createFakeTmux,
  makeTempRoot,
  prependPath,
  repoRoot,
  runNode,
  writeExecutable,
  writeJson,
} from './helpers.js';

function sessionDirFromOutput(output) {
  const statePath = output.match(/^State: (.+\/state\.json)$/m)?.[1];
  assert.ok(statePath, `missing state path in output:\n${output}`);
  return path.dirname(statePath);
}

test('pickle-pipeline bootstraps from task and launches detached tmux', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-task.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), 'bootstrap the pickle phase'], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle pipeline launched/);
  assert.match(output, /Attach: tmux attach -t pickle-/);
  const sessionDir = sessionDirFromOutput(output);
  const pipeline = readJsonFile(path.join(sessionDir, 'pipeline.json'));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(pipeline.bootstrap_source, 'task');
  assert.equal(pipeline.task, 'bootstrap the pickle phase');
  assert.deepEqual(pipeline.phases, ['pickle', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(pipeline.skip_flags, {
    anatomy: false,
    szechuan: false,
  });
  assert.equal(state.pipeline_mode, true);
  assert.equal(state.pipeline_phase, 'pickle');
  assert.match(state.tmux_session_name, /^pickle-/);
  assert.ok(tmuxLines.some((args) => args[0] === 'new-session'));
});

test('pipeline-runner executes the configured phases to completion', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'pipeline runner task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Pickle ticket',
        description: 'Complete the pickle phase only.',
        acceptance_criteria: ['The phase can advance to the next pipeline phase.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  writeJson(path.join(sessionDir, 'pipeline.json'), {
    schema_version: 1,
    working_dir: fs.realpathSync(projectDir),
    target: fs.realpathSync(projectDir),
    phases: ['pickle', 'szechuan-sauce'],
    skip_flags: {
      anatomy: true,
      szechuan: false,
    },
    bootstrap_source: 'task',
    task: 'pipeline runner task',
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf8');

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(state.pipeline_mode, true);
  assert.equal(state.pipeline_phase, null);
  assert.equal(state.pipeline_phase_index, null);
  assert.equal(pipelineState.current_phase, null);
  assert.equal(pipelineState.phase_statuses.pickle, 'done');
  assert.equal(pipelineState.phase_statuses['szechuan-sauce'], 'done');
  assert.match(runnerLog, /pipeline-runner started/);
  assert.match(runnerLog, /pipeline-runner finished: success/);
});

test('pickle-pipeline refuses launch on verification preflight block before tmux detach', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-preflight.jsonl');
  const prdSource = path.join(projectDir, 'pipeline-preflight-prd.md');
  fs.writeFileSync(prdSource, '# Pipeline Preflight\n\n## Summary\nBlock before detached launch.\n');
  createFakeTmux(fakeBin);
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

const sessionDir = addDirs.at(-1) || process.cwd();
const prompt = fs.readFileSync(0, 'utf8');
const refinedPath = path.join(sessionDir, 'prd_refined.md');
const manifestPath = path.join(sessionDir, 'refinement_manifest.json');

if (prompt.includes('Refinement analyst role:')) {
  if (outputLastMessagePath) {
    fs.writeFileSync(outputLastMessagePath, '<promise>ANALYST_COMPLETE</promise>');
  }
  console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
}

fs.writeFileSync(refinedPath, '# Refined PRD\\n\\n## Summary\\nPreflight should block this launch.\\n');
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    generated_at: '2026-04-19T00:00:00.000Z',
    source: 'pipeline-preflight-fake-codex',
    tickets: [
      {
        id: 'ticket-001',
        title: 'Require package token',
        description: 'Preflight should block this pipeline launch.',
        acceptance_criteria: ['Verification env must be present.'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        required_env: ['GITHUB_PACKAGES_TOKEN'],
      },
    ],
  }, null, 2),
);
if (outputLastMessagePath) {
  fs.writeFileSync(outputLastMessagePath, '<promise>REFINEMENT_COMPLETE</promise>');
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  );
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), '--prd', prdSource], {
      env,
      cwd: projectDir,
    }),
    /GITHUB_PACKAGES_TOKEN is required for verification/,
  );

  const sessionsRoot = path.join(dataRoot, 'sessions');
  const [sessionId] = fs.readdirSync(sessionsRoot);
  const sessionDir = path.join(sessionsRoot, sessionId);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(state.last_exit_reason, 'preflight-missing-env');
  assert.equal(state.step, 'blocked');
  assert.ok(!tmuxLines.some((args) => args[0] === 'new-session'));
});

test('pickle-pipeline rolls back launch state when the runner never starts', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-runner-never-started.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_TMUX_RUNNER_START: 'never',
  });

  const stableSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'stable mapped session'], {
    env,
    cwd: projectDir,
  }).trim();

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), 'runner never starts'], {
      env,
      cwd: projectDir,
    }),
    /tmux runner did not start/,
  );

  const sessionsRoot = path.join(dataRoot, 'sessions');
  const sessionDirs = fs.readdirSync(sessionsRoot).map((entry) => path.join(sessionsRoot, entry));
  const failedSessionDir = sessionDirs.find((candidate) => candidate !== stableSession);
  assert.ok(failedSessionDir, 'missing failed pipeline session');

  const state = readJsonFile(path.join(failedSessionDir, 'state.json'));
  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'launch_failed');
  assert.equal(state.tmux_session_name, null);
  assert.equal(fs.existsSync(path.join(failedSessionDir, '.tmux-launch.lock')), false);
  assert.equal(sessionMap[realProjectDir], stableSession);
  assert.ok(tmuxLines.some((args) => args[0] === 'kill-session'));
});

test('pipeline-runner treats verification-contract failures as blocked and exits non-zero', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'pipeline verification contract failure'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Verification contract blocker',
        description: 'Implementation succeeds but the declared verification contract is wrong.',
        acceptance_criteria: ['Pipeline mode preserves blocked ticket context for contract failures.'],
        verification: ['test -f research/proof.txt'],
        output_artifacts: ['research/proof.txt'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  writeJson(path.join(sessionDir, 'pipeline.json'), {
    schema_version: 1,
    working_dir: fs.realpathSync(projectDir),
    target: fs.realpathSync(projectDir),
    phases: ['pickle', 'szechuan-sauce'],
    skip_flags: {
      anatomy: true,
      szechuan: false,
    },
    bootstrap_source: 'task',
    task: 'pipeline verification contract failure',
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
      env,
      cwd: projectDir,
    }),
    (error) => error && error.status === 1,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf8');

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'verification-contract-failed');
  assert.equal(state.step, 'blocked');
  assert.equal(state.current_ticket, 'r1');
  assert.equal(state.pipeline_phase, 'pickle');
  assert.equal(state.pipeline_phase_index, 0);
  assert.equal(pipelineState.current_phase, 'pickle');
  assert.equal(pipelineState.current_phase_index, 0);
  assert.equal(pipelineState.phase_statuses.pickle, 'failed');
  assert.equal(pipelineState.phase_statuses['szechuan-sauce'], 'todo');
  assert.equal(pipelineState.last_exit_reason, 'verification-contract-failed');
  assert.equal(ticket.status, 'Blocked');
  assert.equal(ticket.frontmatter.failure_kind, 'verification-contract-failed');
  assert.match(runnerLog, /pipeline-runner finished: verification-contract-failed/);
});

test('pickle-pipeline resume rejects non-pipeline sessions without mutating state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = {
    PICKLE_DATA_ROOT: dataRoot,
  };

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'plain session'], {
    env,
    cwd: projectDir,
  }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  const originalState = readJsonFile(statePath);

  const expectedState = {
    ...originalState,
    active: true,
    tmux_runner_pid: 999999,
    tmux_session_name: 'pickle-non-pipeline',
    last_exit_reason: null,
    step: 'implement',
    current_ticket: 'r1',
  };
  writeJson(statePath, expectedState);

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), '--resume'], {
      env,
      cwd: projectDir,
    }),
    /Missing pipeline\.json/,
  );

  const stateAfter = readJsonFile(statePath);
  assert.deepEqual(stateAfter, expectedState);
});
