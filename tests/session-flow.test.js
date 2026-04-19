import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { launchDetachedLoop } from '../lib/detached-launch.js';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { listRunnerDescriptors } from '../lib/runner-descriptors.js';
import { updateSessionMap } from '../lib/session-map.js';
import { makeTempRoot, repoRoot, runNode, writeJson, prependPath, createFakeTmux, writeExecutable, waitFor } from './helpers.js';
import { createFakeCodex } from './helpers.js';

function runGit(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(repoDir) {
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.name', 'Pickle Rick Tests']);
  runGit(repoDir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
}

function createPipelineSession({
  env,
  projectDir,
  task = 'pipeline session task',
  phases = ['pickle', 'anatomy-park'],
  anatomy = {},
  szechuan = {},
} = {}) {
  const realProjectDir = fs.realpathSync(projectDir);
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', task], {
    env,
    cwd: realProjectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Pickle ticket',
        description: 'Complete the pickle phase.',
        acceptance_criteria: ['The phase can advance to the next pipeline phase.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  writeJson(path.join(sessionDir, 'pipeline.json'), {
    schema_version: 1,
    working_dir: realProjectDir,
    target: realProjectDir,
    phases,
    skip_flags: {
      anatomy: !phases.includes('anatomy-park'),
      szechuan: !phases.includes('szechuan-sauce'),
    },
    bootstrap_source: 'task',
    task,
    anatomy,
    szechuan,
  });

  return sessionDir;
}

function sessionDirFromLaunchOutput(output) {
  const statePath = output.match(/^State: (.+\/state\.json)$/m)?.[1];
  assert.ok(statePath, `missing state path in output:\n${output}`);
  return path.dirname(statePath);
}

function createStaleSessionFakeTmux(binDir, sessionName) {
  const staleFile = path.join(binDir, 'fake-tmux-stale-session.txt');
  const runnerDescriptors = listRunnerDescriptors();
  fs.writeFileSync(staleFile, sessionName);
  return writeExecutable(
    path.join(binDir, 'tmux'),
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_TMUX_LOG || '';
const staleFile = ${JSON.stringify(staleFile)};
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

const currentStale = fs.existsSync(staleFile) ? fs.readFileSync(staleFile, 'utf8').trim() : '';
const targetIndex = args.indexOf('-t');
const target = targetIndex === -1 ? '' : (args[targetIndex + 1] || '');

if (args[0] === '-V') {
  console.log('tmux 3.4-test');
  process.exit(0);
}

if (args[0] === 'has-session') {
  process.exit(target === currentStale ? 0 : 1);
}

if (args[0] === 'kill-session') {
  if (target === currentStale) {
    fs.rmSync(staleFile, { force: true });
  }
  process.exit(0);
}

if (args[0] === 'new-session' && args.includes('-s')) {
  const name = args[args.indexOf('-s') + 1] || '';
  if (name === currentStale) {
    console.error('duplicate session: ' + name);
    process.exit(1);
  }
  process.exit(0);
}

if ((args[0] === 'new-window' || args[0] === 'split-window') && args.includes('-P')) {
  console.log('%0');
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

test('setup command creates a session and get-session resolves it', () => {
  const dataRoot = makeTempRoot();
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'session flow task'], { env }).trim();
  const fetched = runNode([path.join(repoRoot, 'bin/get-session.js'), '--cwd', repoRoot], { env }).trim();
  const state = readJsonFile(path.join(sessionDir, 'state.json'));

  assert.equal(fetched, sessionDir);
  assert.equal(state.max_time_minutes, 480);
  const map = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(map[repoRoot], sessionDir);
});

test('setup command honors config defaults and numeric overrides', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: {
      max_iterations: 7,
      max_time_minutes: 9,
      worker_timeout_seconds: 11,
    },
  });

  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode(
    [path.join(repoRoot, 'bin/setup.js'), '--max-iterations', '3', '--max-time', '4', '--worker-timeout', '5', 'setup task'],
    { env, cwd: projectDir },
  ).trim();

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.max_iterations, 3);
  assert.equal(state.max_time_minutes, 4);
  assert.equal(state.worker_timeout_seconds, 5);
  assert.equal(state.working_dir, realProjectDir);
  assert.equal(state.schema_version, 1);
});

test('setup command supports tmux mode and command templates', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode(
    [path.join(repoRoot, 'bin/setup.js'), '--tmux', '--command-template', 'pickle-tmux.md', 'tmux task'],
    { env, cwd: projectDir },
  ).trim();

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.tmux_mode, true);
  assert.equal(state.command_template, 'pickle-tmux.md');
  assert.equal(state.active, false);
  assert.equal(state.run_start_time_epoch, null);
  assert.equal(state.run_started_at, null);

  const output = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], { env }).trim();
  assert.match(output, /Elapsed: 0m 0s/);
});

test('setup command can resume the latest session in tmux mode', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'resume task'], { env, cwd: projectDir }).trim();

  const resumed = runNode(
    [path.join(repoRoot, 'bin/setup.js'), '--resume', '--tmux', '--max-iterations', '9'],
    { env, cwd: projectDir },
  ).trim();

  assert.equal(resumed, sessionDir);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.tmux_mode, true);
  assert.equal(state.active, false);
  assert.equal(state.max_iterations, 9);
});

test('setup command resume preserves stored limits when no numeric overrides are passed', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode(
    [
      path.join(repoRoot, 'bin/setup.js'),
      '--max-iterations', '2',
      '--max-time', '3',
      '--worker-timeout', '4',
      'resume preserve task',
    ],
    { env, cwd: projectDir },
  ).trim();

  const resumed = runNode(
    [path.join(repoRoot, 'bin/setup.js'), '--resume', '--tmux'],
    { env, cwd: projectDir },
  ).trim();

  assert.equal(resumed, sessionDir);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.max_iterations, 2);
  assert.equal(state.max_time_minutes, 3);
  assert.equal(state.worker_timeout_seconds, 4);
  assert.equal(state.active, false);
});

test('get-session lists current mappings and falls back to the newest session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const env = { PICKLE_DATA_ROOT: dataRoot };

  const firstSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'first task'], { env, cwd: realProjectDir }).trim();
  const secondSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'second task'], { env, cwd: realProjectDir }).trim();

  const listOutput = runNode([path.join(repoRoot, 'bin/get-session.js'), '--list'], { env }).trim();
  const listed = JSON.parse(listOutput);
  assert.deepEqual(listed, [{ cwd: realProjectDir, sessionDir: secondSession }]);

  fs.unlinkSync(path.join(dataRoot, 'current_sessions.json'));
  const fallback = runNode([path.join(repoRoot, 'bin/get-session.js'), '--cwd', realProjectDir, '--last'], { env }).trim();
  assert.equal(fallback, secondSession);
  assert.notEqual(firstSession, secondSession);
});

test('status command reports an empty state clearly', () => {
  const dataRoot = makeTempRoot();
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const output = runNode([path.join(repoRoot, 'bin/status.js'), '--cwd', repoRoot], { env }).trim();
  assert.equal(output, 'No active session for this directory.');
});

test('status command reports circuit breaker details for an active session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'status task'], { env, cwd: projectDir }).trim();

  writeJson(path.join(sessionDir, 'circuit_breaker.json'), {
    state: 'OPEN',
    reason: 'progress stalled',
  });

  const output = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], { env }).trim();
  assert.match(output, /Active: Yes/);
  assert.match(output, /Circuit Breaker: OPEN/);
  assert.match(output, /Circuit Reason: progress stalled/);
});

test('status command shows ticket counts, title, verification, and last failure', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'status details task'], { env, cwd: projectDir }).trim();
  const ticketDir = path.join(sessionDir, 'ticket-a');
  const blockedDir = path.join(sessionDir, 'ticket-b');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, 'linear_ticket_ticket-a.md'),
    '---\nid: "ticket-a"\ntitle: "Current Ticket"\nstatus: "In Progress"\norder: 1\nverify: "npm test && npm run lint"\n---\n# body\n',
  );
  fs.writeFileSync(
    path.join(blockedDir, 'linear_ticket_ticket-b.md'),
    '---\nid: "ticket-b"\ntitle: "Blocked Ticket"\nstatus: "Blocked"\norder: 2\nfailure_reason: "verification failed"\nfailed_at: "2026-04-15T12:00:00.000Z"\nverify: "npm test"\n---\n# body\n',
  );

  writeJson(path.join(sessionDir, 'state.json'), {
    active: true,
    working_dir: projectDir,
    step: 'implement',
    iteration: 4,
    max_iterations: 0,
    max_time_minutes: 10,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    original_prompt: 'status details task',
    current_ticket: 'ticket-a',
    history: [],
    started_at: '2026-04-15T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 1,
    tmux_mode: true,
    last_exit_reason: null,
  });

  const output = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], { env }).trim();
  assert.match(output, /Ticket: ticket-a - Current Ticket/);
  assert.match(output, /Tickets: queued 1 \| done 0 \| blocked 1 \| skipped 0/);
  assert.match(output, /Next Verification: npm test && npm run lint/);
  assert.match(output, /Last Failure: verification failed/);
  assert.match(output, /Iteration: 4 \/ unlimited/);
});

test('status renders pipeline metadata without regressing non-pipeline sessions', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const env = { PICKLE_DATA_ROOT: dataRoot };

  const nonPipelineSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'non pipeline status task'], {
    env,
    cwd: projectDir,
  }).trim();
  const nonPipelineTicketDir = path.join(nonPipelineSession, 'ticket-a');
  fs.mkdirSync(nonPipelineTicketDir, { recursive: true });
  fs.writeFileSync(
    path.join(nonPipelineTicketDir, 'linear_ticket_ticket-a.md'),
    '---\nid: "ticket-a"\ntitle: "Current Ticket"\nstatus: "In Progress"\norder: 1\nverify: "npm test && npm run lint"\n---\n# body\n',
  );
  writeJson(path.join(nonPipelineSession, 'state.json'), {
    active: true,
    working_dir: projectDir,
    step: 'implement',
    iteration: 4,
    max_iterations: 0,
    max_time_minutes: 10,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    original_prompt: 'non pipeline status task',
    current_ticket: 'ticket-a',
    history: [],
    started_at: '2026-04-15T00:00:00.000Z',
    session_dir: nonPipelineSession,
    schema_version: 1,
    tmux_mode: true,
    last_exit_reason: null,
  });

  const nonPipelineStatus = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', nonPipelineSession], {
    env,
  }).trim();
  assert.match(nonPipelineStatus, /Ticket: ticket-a - Current Ticket/);
  assert.match(nonPipelineStatus, /Next Verification: npm test && npm run lint/);
  assert.doesNotMatch(nonPipelineStatus, /Pipeline Phase:/);
  assert.doesNotMatch(nonPipelineStatus, /Pipeline Bootstrap:/);

  const pipelineSession = createPipelineSession({
    env,
    projectDir,
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
  });
  writeJson(path.join(pipelineSession, 'pipeline-state.json'), {
    schema_version: 1,
    current_phase: 'anatomy-park',
    current_phase_index: 1,
    phase_statuses: {
      pickle: 'done',
      'anatomy-park': 'running',
      'szechuan-sauce': 'todo',
    },
    started_at: '2026-04-19T00:00:00.000Z',
    phase_started_at: '2026-04-19T00:01:00.000Z',
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
  });

  const pipelineStatus = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', pipelineSession], {
    env,
  }).trim();
  assert.match(pipelineStatus, /Pipeline Phase: anatomy-park \(2 \/ 3\)/);
  assert.match(pipelineStatus, /Pipeline Phases: pickle=done \| anatomy-park=running \| szechuan-sauce=todo/);
  assert.match(pipelineStatus, /Pipeline Bootstrap: task/);
  assert.match(pipelineStatus, /Pipeline Task: pipeline session task/);
  assert.match(pipelineStatus, new RegExp(`Pipeline Target: ${realProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('cancel marks the session inactive and removes the session map entry', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'cancel task'], { env, cwd: realProjectDir }).trim();

  writeJson(path.join(sessionDir, 'pipeline.json'), {
    schema_version: 1,
    working_dir: realProjectDir,
    target: realProjectDir,
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    skip_flags: {
      anatomy: false,
      szechuan: false,
    },
    bootstrap_source: 'task',
    task: 'cancel task',
  });
  writeJson(path.join(sessionDir, 'pipeline-state.json'), {
    schema_version: 1,
    current_phase: 'anatomy-park',
    current_phase_index: 1,
    phase_statuses: {
      pickle: 'done',
      'anatomy-park': 'running',
      'szechuan-sauce': 'todo',
    },
    started_at: '2026-04-19T00:00:00.000Z',
    phase_started_at: '2026-04-19T00:01:00.000Z',
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
  });

  const output = runNode([path.join(repoRoot, 'bin/cancel.js'), '--cwd', realProjectDir], { env }).trim();
  assert.match(output, new RegExp(`^Cancelled ${sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.pipeline_mode, true);
  assert.equal(state.pipeline_phase, 'anatomy-park');
  assert.equal(state.pipeline_phase_index, 1);
  assert.equal(state.pipeline_total_phases, 3);
  assert.equal(pipelineState.current_phase, 'anatomy-park');
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'cancelled');
  assert.equal(pipelineState.last_exit_reason, 'cancelled');
  assert.equal(readJsonFile(path.join(dataRoot, 'current_sessions.json'), {} )[projectDir], undefined);
});

test('cancel stops an in-flight mux-runner worker and clears tracked child state', async () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'cancel in-flight task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Cancel Me',
        description: 'Runner should stop promptly when cancelled.',
        acceptance_criteria: ['Cancellation should stop the active worker.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const runner = spawn('node', [path.join(repoRoot, 'bin/mux-runner.js'), sessionDir], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });

  await waitFor(() => {
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    return Number.isInteger(state?.active_child_pid) && state.active_child_pid > 0;
  }, { timeoutMs: 5_000, message: 'runner never reported an active child pid' });

  const output = runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', sessionDir], {
    env,
    cwd: repoRoot,
  }).trim();
  assert.match(output, /Cancelled/);

  await waitFor(() => runner.exitCode !== null || runner.signalCode !== null, {
    timeoutMs: 5_000,
    message: 'runner did not stop after cancel',
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.active_child_pid, null);
  assert.equal(state.worker_pid, null);
  assert.equal(state.tmux_runner_pid, null);
});

test('canceling an older session does not clear a newer cwd mapping', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const firstSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'older task'], { env, cwd: realProjectDir }).trim();
  const secondSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'newer task'], { env, cwd: realProjectDir }).trim();

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', firstSession], { env, cwd: realProjectDir });

  const map = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(map[realProjectDir], secondSession);
  const resolved = runNode([path.join(repoRoot, 'bin/get-session.js'), '--cwd', realProjectDir], { env, cwd: realProjectDir }).trim();
  assert.equal(resolved, secondSession);
});

test('session-map lock fails closed when the lock cannot be acquired', async () => {
  const dataRoot = makeTempRoot();
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  const lockPath = path.join(dataRoot, 'current_sessions.json.lock');
  fs.writeFileSync(lockPath, 'busy\n');

  try {
    await assert.rejects(
      () => updateSessionMap('/tmp/project-a', '/tmp/session-a'),
      /Failed to acquire session map lock/,
    );
    assert.equal(fs.existsSync(path.join(dataRoot, 'current_sessions.json')), false);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previousRoot;
    }
  }
});

test('retry-ticket reactivates the session and resets the ticket state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'retry task'], { env, cwd: projectDir }).trim();
  const ticketDir = path.join(sessionDir, 'ticket-a');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, 'linear_ticket_ticket-a.md'),
    '---\nid: "ticket-a"\ntitle: "Retry Me"\nstatus: "Blocked"\n---\n# body\n',
  );

  writeJson(path.join(sessionDir, 'state.json'), {
    active: false,
    working_dir: projectDir,
    step: 'blocked',
    iteration: 3,
    max_iterations: 10,
    max_time_minutes: 10,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    original_prompt: 'retry task',
    current_ticket: 'ticket-a',
    history: [],
    started_at: '2026-04-15T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 1,
    last_exit_reason: 'error',
  });

  const output = runNode(
    [path.join(repoRoot, 'bin/retry-ticket.js'), '--session-dir', sessionDir, '--ticket', 'ticket-a'],
    { env, cwd: projectDir },
  ).trim();

  assert.equal(output, 'Retry requested for ticket-a');
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, true);
  assert.equal(state.current_ticket, 'ticket-a');
  assert.equal(state.step, 'research');
  assert.equal(state.last_exit_reason, null);
  assert.equal(state.history.at(-1).step, 'retry');

  const ticket = parseTicketFile(path.join(ticketDir, 'linear_ticket_ticket-a.md'));
  assert.equal(ticket.status, 'Todo');
  assert.equal(ticket.frontmatter.retry_requested_at.length > 0, true);
});

test('pickle-tmux bootstraps from --prd, refines, and launches detached tmux', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux.jsonl');
  const prdSource = path.join(projectDir, 'loan-programs-prd.md');
  fs.writeFileSync(prdSource, '# Loan Programs Decoupling\n\n## Summary\nDetach the implementation from the PRD.\n');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--prd', prdSource], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle Rick tmux mode launched/);
  assert.match(output, /Attach: tmux attach -t pickle-/);
  assert.match(output, /Runnable Tickets: 1/);
  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);
  assert.ok(fs.existsSync(path.join(sessionDir, 'prd.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.max_iterations, 0);
  assert.match(state.tmux_session_name, /^pickle-/);
  const logLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines[0][0], '-V');
  assert.ok(logLines.some((args) => args[0] === 'new-session'));
  assert.ok(logLines.some((args) => args[0] === 'send-keys'));
  assert.ok(logLines.some((args) => args[0] === 'select-window'));
});

test('pickle-tmux --resume refines an existing PRD-only session before launch', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-resume.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'resume detached epic'], {
    env,
    cwd: projectDir,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Existing PRD\n\n## Summary\nResume from this PRD.\n');

  const output = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle Rick tmux mode launched/);
  assert.ok(fs.existsSync(path.join(sessionDir, 'refinement_manifest.json')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-001', 'linear_ticket_ticket-001.md')));
});

test('pickle-tmux honors an explicit --resume session when --resume-ready-only is set', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-explicit-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const mappedSession = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'mapped tmux session'], {
    env,
    cwd: projectDir,
  }).trim();
  const explicitSession = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'explicit tmux session'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(mappedSession, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'mapped-ticket',
        title: 'Mapped Session Ticket',
        description: 'Keep this session runnable but unused.',
        acceptance_criteria: ['It stays out of the way.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  writeJson(path.join(explicitSession, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'explicit-ticket',
        title: 'Explicit Session Ticket',
        description: 'This is the session that should launch.',
        acceptance_criteria: ['It is chosen explicitly.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    await updateSessionMap(realProjectDir, mappedSession);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previousRoot;
    }
  }

  const output = runNode([
    path.join(repoRoot, 'bin/pickle-tmux.js'),
    '--resume',
    explicitSession,
    '--resume-ready-only',
  ], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, new RegExp(`Session: pickle-${path.basename(explicitSession)}`));
  assert.ok(output.includes(`State: ${path.join(explicitSession, 'state.json')}`));
  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(sessionMap[realProjectDir], explicitSession);
});

test('pickle-tmux resume refuses to relaunch a live session before mutating state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-pickle-live-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'pickle tmux live resume'], {
    env,
    cwd: projectDir,
  }).trim();

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const originalState = readJsonFile(path.join(sessionDir, 'state.json'));
    writeJson(path.join(sessionDir, 'state.json'), {
      ...originalState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir, '--resume-ready-only'], {
        env,
        cwd: projectDir,
      }),
      /Session is already running under tmux runner pid \d+\./,
    );

    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    assert.equal(state.active, true);
    assert.equal(state.tmux_runner_pid, runner.pid);
    assert.equal(state.last_exit_reason, null);
    assert.equal(state.command_template, null);
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), '["-V"]\n');
  } finally {
    runner.kill('SIGTERM');
  }
});

test('pickle-tmux clears a stale launch lock before relaunching', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-stale-lock.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'stale lock epic'], {
    env,
    cwd: projectDir,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Existing PRD\n\n## Summary\nResume from this PRD.\n');
  fs.writeFileSync(path.join(sessionDir, '.tmux-launch.lock'), 'not-a-pid\n');

  const output = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle Rick tmux mode launched/);
  assert.equal(fs.existsSync(path.join(sessionDir, '.tmux-launch.lock')), false);
});

test('pickle-tmux replaces a stale tmux session before relaunching', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-stale-session.jsonl');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'stale tmux session epic'], {
    env,
    cwd: projectDir,
  }).trim();
  const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  createStaleSessionFakeTmux(fakeBin, sessionName);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'ticket-001',
        title: 'Replace stale tmux session',
        description: 'Relaunch without manual cleanup.',
        acceptance_criteria: ['The stale tmux session is replaced automatically.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir, '--resume-ready-only'], {
    env,
    cwd: projectDir,
  }).trim();

  const logLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.match(output, /Pickle Rick tmux mode launched/);
  assert.ok(logLines.some((args) => args[0] === 'has-session' && args.includes(sessionName)));
  assert.ok(logLines.some((args) => args[0] === 'kill-session' && args.includes(sessionName)));
  assert.ok(logLines.some((args) => args[0] === 'new-session' && args.includes(sessionName)));
});

test('pickle-tmux ignores stale runner artifacts when resuming a session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-stale-runner-artifacts.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_TMUX_RUNNER_START: 'never',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'stale runner artifacts epic'], {
    env,
    cwd: projectDir,
  }).trim();
  const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'ticket-001',
        title: 'Ignore stale runner artifacts',
        description: 'Only a fresh runner start should satisfy launch readiness.',
        acceptance_criteria: ['Resuming should fail if the new runner never starts.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  writeJson(path.join(sessionDir, 'state.json'), {
    ...readJsonFile(path.join(sessionDir, 'state.json')),
    active: false,
    tmux_session_name: sessionName,
    tmux_runner_pid: 999999,
    last_exit_reason: 'error',
  });
  fs.writeFileSync(path.join(sessionDir, 'mux-runner.log'), '[2026-04-18T00:00:00.000Z] mux-runner started\n');

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir, '--resume-ready-only'], {
      env,
      cwd: projectDir,
    }),
    /tmux runner did not start/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.tmux_session_name, null);
  assert.equal(state.last_exit_reason, 'launch_failed');
});

test('pickle-tmux rolls back tmux launch state when monitor bootstrap fails', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-launch-failure.jsonl');
  const prdSource = path.join(projectDir, 'launch-failure-prd.md');
  fs.writeFileSync(prdSource, '# Launch Failure\n\n## Summary\nTrigger tmux monitor failure.\n');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_TMUX_FAIL_ON: 'new-window',
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--prd', prdSource], {
      env,
      cwd: projectDir,
    }),
    /tmux monitor bootstrap failed|fake tmux forced failure/,
  );

  const sessionsRoot = path.join(dataRoot, 'sessions');
  const [sessionName] = fs.readdirSync(sessionsRoot);
  const sessionDir = path.join(sessionsRoot, sessionName);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const logLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(state.last_exit_reason, 'launch_failed');
  assert.equal(state.tmux_session_name, null);
  assert.ok(logLines.some((args) => args[0] === 'kill-session'));
});

test('pickle-tmux fails launch when tmux accepts commands but the runner never starts', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-runner-never-started.jsonl');
  const prdSource = path.join(projectDir, 'runner-never-started-prd.md');
  fs.writeFileSync(prdSource, '# Runner Never Started\n\n## Summary\nAccept tmux commands without starting the runner.\n');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_TMUX_RUNNER_START: 'never',
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--prd', prdSource], {
      env,
      cwd: projectDir,
    }),
    /tmux runner did not start/,
  );

  const sessionsRoot = path.join(dataRoot, 'sessions');
  const [sessionId] = fs.readdirSync(sessionsRoot);
  const sessionDir = path.join(sessionsRoot, sessionId);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const logLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'launch_failed');
  assert.equal(state.tmux_session_name, null);
  assert.equal(fs.existsSync(path.join(sessionDir, '.tmux-launch.lock')), false);
  assert.ok(logLines.some((args) => args[0] === 'respawn-pane'));
  assert.ok(logLines.some((args) => args[0] === 'send-keys'));
  assert.ok(logLines.some((args) => args[0] === 'kill-session'));
});

test('pickle-tmux --prd preserves the prior session mapping when refinement fails before readiness', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const prdSource = path.join(projectDir, 'broken-bootstrap-prd.md');
  fs.writeFileSync(prdSource, '# Broken Bootstrap\n\n## Summary\nForce refinement failure before tmux launch.\n');
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

fs.writeFileSync(refinedPath, '# Refined PRD\\n\\n## Summary\\nPreflight should fail before tmux launch.\\n');
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    generated_at: '2026-04-15T00:00:00.000Z',
    source: 'preflight-fake-codex',
    tickets: [
      {
        id: 'ticket-001',
        title: 'Require package token',
        description: 'Preflight should block this launch.',
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
  });

  const stableSession = runNode([path.join(repoRoot, 'bin/setup.js'), 'stable mapped session'], {
    env,
    cwd: projectDir,
  }).trim();
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    await updateSessionMap(realProjectDir, stableSession);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previousRoot;
    }
  }

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--prd', prdSource], {
      env,
      cwd: projectDir,
    }),
    /GITHUB_PACKAGES_TOKEN is required for verification/,
  );

  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(sessionMap[realProjectDir], stableSession);
});

test('pickle-tmux rolls back tmux launch state on launch failure', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-launch-failure.jsonl');
  const prdSource = path.join(projectDir, 'launch-failure-prd.md');
  fs.writeFileSync(prdSource, '# Launch Failure\n\n## Summary\nForce tmux launch failure.\n');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_TMUX_FAIL_ON: 'send-keys',
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--prd', prdSource], { env, cwd: projectDir }),
    /fake tmux forced failure on send-keys/,
  );

  const sessionsRoot = path.join(dataRoot, 'sessions');
  const [sessionId] = fs.readdirSync(sessionsRoot);
  const sessionDir = path.join(sessionsRoot, sessionId);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const tmuxLogLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(state.tmux_session_name, null);
  assert.equal(state.last_exit_reason, 'launch_failed');
  assert.equal(state.active, false);
  assert.equal(fs.existsSync(path.join(sessionDir, '.tmux-launch.lock')), false);
  assert.ok(tmuxLogLines.some((args) => args[0] === 'kill-session'));
});

test('mux-runner refreshes the run timer instead of inheriting stale session start time', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const countPath = path.join(dataRoot, 'codex-count.txt');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const counterPath = ${JSON.stringify(countPath)};
const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;
fs.writeFileSync(counterPath, String(current));

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
if (outputLastMessagePath) {
  fs.writeFileSync(outputLastMessagePath, '<promise>OK</promise>');
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'runner timer task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Runner Timer Ticket',
        description: 'Verify the timer refreshes on detached runner start.',
        acceptance_criteria: ['Runner can execute one ticket.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  writeJson(path.join(sessionDir, 'state.json'), {
    ...readJsonFile(path.join(sessionDir, 'state.json')),
    active: false,
    step: 'paused',
    start_time_epoch: 1,
    run_start_time_epoch: 1,
    started_at: '2026-04-15T00:00:00.000Z',
    run_started_at: '2026-04-15T00:00:00.000Z',
    last_exit_reason: null,
  });

  runNode([path.join(repoRoot, 'bin/mux-runner.js'), sessionDir], {
    env,
    cwd: repoRoot,
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(state.start_time_epoch, 1);
  assert.ok(Number(state.run_start_time_epoch) > 1);
  assert.equal(fs.readFileSync(countPath, 'utf8'), '5');

  const output = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], {
    env,
    cwd: repoRoot,
  }).trim();
  assert.match(output, /Elapsed: 0m /);
});

test('mux-runner fails closed when a session has no tickets', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'empty manifest task'], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: [] });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/mux-runner.js'), sessionDir], { env, cwd: projectDir }),
    /Command failed/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.last_exit_reason, 'no_tickets');
  assert.equal(state.step, 'paused');
  assert.match(fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8'), /no tickets found/);
});

test('mux-runner preserves ticket failure when max_time would block a retry', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const countPath = path.join(dataRoot, 'codex-fail-count.txt');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const counterPath = ${JSON.stringify(countPath)};
const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;
fs.writeFileSync(counterPath, String(current));

if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}

await new Promise((resolve) => setTimeout(resolve, 1200));
console.error('fake codex failure');
process.exit(1);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'runner failure task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Runner Failure Ticket',
        description: 'Verify max_time does not hide a real failure.',
        acceptance_criteria: ['Runner should preserve the original failure.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  writeJson(path.join(sessionDir, 'state.json'), {
    ...readJsonFile(path.join(sessionDir, 'state.json')),
    active: false,
    step: 'paused',
    max_time_minutes: 0.005,
    start_time_epoch: 1,
    run_start_time_epoch: 1,
    last_exit_reason: null,
  });

  try {
    runNode([path.join(repoRoot, 'bin/mux-runner.js'), sessionDir, '--on-failure=retry-once'], {
      env,
      cwd: repoRoot,
    });
  } catch {
    // The child process may surface the terminal error directly; session state is the real assertion target.
  }

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const log = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8');

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'error');
  assert.equal(state.step, 'paused');
  assert.equal(state.current_ticket, 'r1');
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.history.at(-1).step, 'failed');
  assert.equal(ticket.status, 'Blocked');
  assert.match(ticket.frontmatter.failure_reason, /fake codex failure/);
  assert.match(log, /ticket r1 failed on attempt 1/);
  assert.match(log, /mux-runner finished: error/);
  assert.doesNotMatch(log, /attempt 2\/2/);
  assert.equal(fs.readFileSync(countPath, 'utf8'), '1');
});

test('mux-runner does not retry verification-contract failures and leaves the ticket blocked', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const countPath = path.join(dataRoot, 'codex-contract-count.txt');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const counterPath = ${JSON.stringify(countPath)};
const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;
fs.writeFileSync(counterPath, String(current));

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

if (outputLastMessagePath) {
  fs.writeFileSync(outputLastMessagePath, '<promise>SIMPLIFY_COMPLETE</promise>');
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'verification contract retry task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Verification contract blocker',
        description: 'Implementation succeeds but the declared contract is wrong.',
        acceptance_criteria: ['Verification contract failures block without replaying the whole ticket.'],
        verification: ['test -f research/proof.txt'],
        output_artifacts: ['research/proof.txt'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  try {
    runNode([path.join(repoRoot, 'bin/mux-runner.js'), sessionDir, '--on-failure=retry-once'], {
      env,
      cwd: repoRoot,
    });
  } catch {
    // Exit code is part of the assertion.
  }

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const log = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8');

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'verification-contract-failed');
  assert.equal(state.step, 'blocked');
  assert.equal(state.current_ticket, 'r1');
  assert.equal(ticket.status, 'Blocked');
  assert.equal(ticket.frontmatter.failure_kind, 'verification-contract-failed');
  assert.match(ticket.frontmatter.failure_reason, /research\/proof\.txt/);
  assert.match(log, /verification contract blocked/);
  assert.match(log, /without retry/);
  assert.doesNotMatch(log, /attempt 2\/2/);
  assert.equal(fs.readFileSync(countPath, 'utf8'), '5');
});

test('loop-runner completes a detached loop after fake codex returns LOOP_COMPLETE', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '2',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'loop task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'microverse',
    task: 'improve something',
    metric: 'echo 1',
    direction: 'higher',
    stall_limit: 5,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(state.iteration, 2);
  assert.match(fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8'), /loop-runner finished: success/);
});

test('loop-runner clears active state after a worker failure', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
console.error('loop worker failed');
process.exit(1);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'loop failure task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'microverse',
    task: 'improve something',
    metric: 'echo 1',
    direction: 'higher',
    stall_limit: 5,
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], {
      env,
      cwd: repoRoot,
    }),
    /Command failed/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'error');
  assert.equal(state.step, 'paused');
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.active_child_pid, null);
});

test('loop-runner cleans session state when an iteration fails', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
console.error('loop failure');
process.exit(1);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'loop failure task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'microverse',
    task: 'fail immediately',
    metric: 'echo 1',
    direction: 'higher',
    stall_limit: 5,
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir }),
    /loop failure/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const log = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  assert.equal(state.active, false);
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.active_child_pid, null);
  assert.equal(state.last_exit_reason, 'error');
  assert.equal(state.step, 'paused');
  assert.match(log, /loop-runner finished: error/);
});

test('loop-runner honors the stored worker timeout when config changes after session setup', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_HANG_MS: '1500',
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: {
      worker_timeout_seconds: 1,
    },
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'loop timeout contract'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 5,
  });

  const statePath = path.join(sessionDir, 'state.json');
  const originalState = readJsonFile(statePath);
  writeJson(statePath, {
    ...originalState,
    worker_timeout_seconds: 3,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const state = readJsonFile(statePath);
  const log = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.active, false);
  assert.match(log, /loop-runner finished: success/);
});

test('loop-runner passes the persisted iteration budget to anatomy-park prompts without a second increment', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'anatomy prompt budget task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 2,
  });

  const statePath = path.join(sessionDir, 'state.json');
  const originalState = readJsonFile(statePath);
  writeJson(statePath, {
    ...originalState,
    iteration: 21,
    max_iterations: 0,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const prompt = fs.readFileSync(path.join(sessionDir, 'loop-iteration-1.txt'), 'utf8');
  assert.match(prompt, /Iteration: 22 \/ unlimited/);
  assert.doesNotMatch(prompt, /Iteration: 23 \/ 0/);
});

test('pickle-pipeline advances from pickle to anatomy-park in one tmux session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline anatomy handoff task',
    phases: ['pickle', 'anatomy-park'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    ...readJsonFile(statePath),
    tmux_session_name: 'pickle-shared-session',
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const state = readJsonFile(statePath);
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  const pipelineLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf8');
  const loopLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  const loopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));

  assert.equal(state.tmux_session_name, 'pickle-shared-session');
  assert.equal(state.command_template, 'anatomy-park.md');
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(pipelineState.current_phase, null);
  assert.equal(pipelineState.phase_statuses.pickle, 'done');
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'done');
  assert.equal(loopConfig.mode, 'anatomy-park');
  assert.equal(loopConfig.target, fs.realpathSync(projectDir));
  assert.match(pipelineLog, /pipeline-runner started/);
  assert.match(loopLog, /loop-runner started \(anatomy-park\)/);
  assert.ok(state.history.some((entry) => entry.step === 'anatomy-park'));
});

test('pickle-pipeline does not launch nested tmux sessions for anatomy', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const tmuxLog = path.join(dataRoot, 'pipeline-anatomy-tmux.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline anatomy without nested tmux',
    phases: ['pickle', 'anatomy-park'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  assert.equal(fs.existsSync(tmuxLog), false);
});

test('pickle-pipeline advances through all configured phases in one tmux session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline full parity task',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
    szechuan: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
      focus: 'shared abstractions',
      domain: 'KISS',
    },
  });
  const statePath = path.join(sessionDir, 'state.json');
  writeJson(statePath, {
    ...readJsonFile(statePath),
    tmux_session_name: 'pickle-shared-session',
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const state = readJsonFile(statePath);
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  const pipelineLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf8');
  const loopLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  const loopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));

  assert.equal(state.tmux_session_name, 'pickle-shared-session');
  assert.equal(state.command_template, 'szechuan-sauce.md');
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(state.pipeline_phase, null);
  assert.equal(state.pipeline_phase_index, null);
  assert.equal(state.pipeline_total_phases, 3);
  assert.equal(pipelineState.current_phase, null);
  assert.equal(pipelineState.phase_statuses.pickle, 'done');
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'done');
  assert.equal(pipelineState.phase_statuses['szechuan-sauce'], 'done');
  assert.ok(pipelineState.completed_at);
  assert.equal(loopConfig.mode, 'szechuan-sauce');
  assert.equal(loopConfig.target, fs.realpathSync(projectDir));
  assert.equal(loopConfig.focus, 'shared abstractions');
  assert.equal(loopConfig.domain, 'KISS');
  assert.match(pipelineLog, /pipeline-runner started/);
  assert.match(pipelineLog, /pipeline-runner finished: success/);
  assert.match(loopLog, /loop-runner started \(anatomy-park\)/);
  assert.match(loopLog, /loop-runner started \(szechuan-sauce\)/);
  assert.ok(state.history.some((entry) => entry.step === 'anatomy-park'));
  assert.ok(state.history.some((entry) => entry.step === 'szechuan-sauce'));
});

test('pickle-pipeline honors immutable skip flags', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-skip-flags.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const skipAnatomyOutput = runNode([
    path.join(repoRoot, 'bin/pickle-pipeline.js'),
    '--skip-anatomy',
    'skip anatomy pipeline task',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  const skipAnatomySession = sessionDirFromLaunchOutput(skipAnatomyOutput);
  const skipAnatomyPipeline = readJsonFile(path.join(skipAnatomySession, 'pipeline.json'));

  assert.deepEqual(skipAnatomyPipeline.phases, ['pickle', 'szechuan-sauce']);
  assert.deepEqual(skipAnatomyPipeline.skip_flags, {
    anatomy: true,
    szechuan: false,
  });

  const skipSzechuanOutput = runNode([
    path.join(repoRoot, 'bin/pickle-pipeline.js'),
    '--skip-szechuan',
    'skip szechuan pipeline task',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  const skipSzechuanSession = sessionDirFromLaunchOutput(skipSzechuanOutput);
  const skipSzechuanPipeline = readJsonFile(path.join(skipSzechuanSession, 'pipeline.json'));

  assert.deepEqual(skipSzechuanPipeline.phases, ['pickle', 'anatomy-park']);
  assert.deepEqual(skipSzechuanPipeline.skip_flags, {
    anatomy: false,
    szechuan: true,
  });
});

test('pickle-pipeline resume rejects immutable contract mutation', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const otherProjectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-resume-mutation.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const launchOutput = runNode([
    path.join(repoRoot, 'bin/pickle-pipeline.js'),
    '--skip-szechuan',
    'immutable pipeline contract task',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  const sessionDir = sessionDirFromLaunchOutput(launchOutput);
  const statePath = path.join(sessionDir, 'state.json');
  const originalPipeline = readJsonFile(path.join(sessionDir, 'pipeline.json'));
  writeJson(statePath, {
    ...readJsonFile(statePath),
    active: false,
    tmux_runner_pid: null,
    tmux_session_name: null,
    last_exit_reason: 'cancelled',
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), '--resume', sessionDir], {
      env,
      cwd: otherProjectDir,
    }),
    /Cannot change pipeline target on resume/,
  );

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-pipeline.js'), '--resume', sessionDir, '--skip-anatomy'], {
      env,
      cwd: projectDir,
    }),
    /Cannot change pipeline skip flags on resume/,
  );

  const pipeline = readJsonFile(path.join(sessionDir, 'pipeline.json'));
  assert.deepEqual(pipeline, originalPipeline);
});

test('pickle-pipeline resumes the first incomplete phase', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline resume first incomplete task',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    szechuan: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  writeJson(path.join(sessionDir, 'pipeline-state.json'), {
    schema_version: 1,
    current_phase: 'pickle',
    current_phase_index: 0,
    phase_statuses: {
      pickle: 'done',
      'anatomy-park': 'done',
      'szechuan-sauce': 'todo',
    },
    started_at: '2026-04-19T00:00:00.000Z',
    phase_started_at: null,
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));
  const loopLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');

  assert.equal(state.command_template, 'szechuan-sauce.md');
  assert.equal(state.last_exit_reason, 'success');
  assert.equal(pipelineState.current_phase, null);
  assert.equal(pipelineState.phase_statuses.pickle, 'done');
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'done');
  assert.equal(pipelineState.phase_statuses['szechuan-sauce'], 'done');
  assert.match(loopLog, /loop-runner started \(szechuan-sauce\)/);
  assert.doesNotMatch(loopLog, /loop-runner started \(anatomy-park\)/);
});

test('pickle-pipeline marks abrupt runner loss before resume', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'pickle-pipeline-runner-loss.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const launchOutput = runNode([
    path.join(repoRoot, 'bin/pickle-pipeline.js'),
    '--skip-anatomy',
    '--skip-szechuan',
    'pipeline runner loss task',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  const sessionDir = sessionDirFromLaunchOutput(launchOutput);
  const statePath = path.join(sessionDir, 'state.json');
  const launchedState = readJsonFile(statePath);

  assert.equal(launchedState.active, true);
  assert.equal(launchedState.tmux_runner_pid, 4242);
  assert.equal(launchedState.last_exit_reason, null);

  const resumeOutput = runNode([
    path.join(repoRoot, 'bin/pickle-pipeline.js'),
    '--resume',
    sessionDir,
    '--resume-ready-only',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  assert.match(resumeOutput, /Pickle pipeline launched/);

  const resumedState = readJsonFile(statePath);
  assert.ok(resumedState.history.some((entry) => entry.step === 'runner_lost'));
  assert.equal(resumedState.active, true);
  assert.equal(resumedState.last_exit_reason, null);
});

test('pickle-pipeline does not launch nested tmux sessions for szechuan', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const tmuxLog = path.join(dataRoot, 'pipeline-szechuan-tmux.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline szechuan without nested tmux',
    phases: ['pickle', 'szechuan-sauce'],
    szechuan: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  assert.equal(fs.existsSync(tmuxLog), false);
});

test('pickle-pipeline preserves anatomy-park dirty-tree auto-commit semantics', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  initGitRepo(projectDir);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  runGit(projectDir, ['add', 'index.js']);
  runGit(projectDir, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 2;\n');

  const beforeHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline anatomy dirty preflight task',
    phases: ['pickle', 'anatomy-park'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    env,
    cwd: projectDir,
  });

  const afterHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const commitSubject = runGit(projectDir, ['log', '-1', '--pretty=%s']);
  const loopLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');

  assert.notEqual(afterHead, beforeHead);
  assert.equal(runGit(projectDir, ['status', '--porcelain']), '');
  assert.equal(commitSubject, 'anatomy-park: auto-commit dirty tree before start');
  assert.match(loopLog, /preflight auto-committed:/);
});

test('pickle-pipeline records cancel against anatomy and does not advance', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
    FAKE_LOOP_HANG_MS: '2000',
  });

  const sessionDir = createPipelineSession({
    env,
    projectDir,
    task: 'pipeline anatomy cancel task',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  const child = spawn('node', [path.join(repoRoot, 'bin/pipeline-runner.js'), sessionDir], {
    cwd: projectDir,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitFor(() => {
    const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'), null);
    return pipelineState?.phase_statuses?.['anatomy-park'] === 'running';
  }, { message: 'pipeline did not enter anatomy-park' });

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', sessionDir], {
    env,
    cwd: projectDir,
  });

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pipeline-runner exited with ${code}`));
    });
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const pipelineState = readJsonFile(path.join(sessionDir, 'pipeline-state.json'));

  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.step, 'paused');
  assert.equal(state.pipeline_phase, 'anatomy-park');
  assert.equal(pipelineState.current_phase, 'anatomy-park');
  assert.equal(pipelineState.phase_statuses.pickle, 'done');
  assert.equal(pipelineState.phase_statuses['anatomy-park'], 'cancelled');
  assert.equal(pipelineState.phase_statuses['szechuan-sauce'], 'todo');
  assert.equal(pipelineState.last_exit_reason, 'cancelled');

  const failingDataRoot = makeTempRoot();
  const failingProjectDir = makeTempRoot('pickle-rick-project-');
  const failingFakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(failingFakeBin);
  const failingEnv = prependPath(failingFakeBin, {
    PICKLE_DATA_ROOT: failingDataRoot,
    FAKE_LOOP_FAIL_AT: '1',
    FAKE_LOOP_ERROR_MESSAGE: 'fake anatomy failure',
  });

  const failingSessionDir = createPipelineSession({
    env: failingEnv,
    projectDir: failingProjectDir,
    task: 'pipeline anatomy failure task',
    phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
    anatomy: {
      max_iterations: 0,
      stall_limit: 2,
      dry_run: false,
    },
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pipeline-runner.js'), failingSessionDir], {
      env: failingEnv,
      cwd: failingProjectDir,
    }),
    /fake anatomy failure/,
  );

  const failingState = readJsonFile(path.join(failingSessionDir, 'state.json'));
  const failingPipelineState = readJsonFile(path.join(failingSessionDir, 'pipeline-state.json'));

  assert.equal(failingState.last_exit_reason, 'error');
  assert.equal(failingState.pipeline_phase, 'anatomy-park');
  assert.equal(failingPipelineState.current_phase, 'anatomy-park');
  assert.equal(failingPipelineState.phase_statuses.pickle, 'done');
  assert.equal(failingPipelineState.phase_statuses['anatomy-park'], 'failed');
  assert.equal(failingPipelineState.phase_statuses['szechuan-sauce'], 'todo');
  assert.equal(failingPipelineState.last_exit_reason, 'error');
});

test('loop-runner auto-commits a dirty anatomy-park git tree before the first iteration', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  initGitRepo(projectDir);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  runGit(projectDir, ['add', 'index.js']);
  runGit(projectDir, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 2;\n');

  const beforeHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'anatomy dirty preflight task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 2,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const afterHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  const commitSubject = runGit(projectDir, ['log', '-1', '--pretty=%s']);

  assert.notEqual(afterHead, beforeHead);
  assert.equal(runGit(projectDir, ['status', '--porcelain']), '');
  assert.equal(commitSubject, 'anatomy-park: auto-commit dirty tree before start');
  assert.match(runnerLog, /preflight auto-committed:/);
});

test('loop-runner auto-commits anatomy-park fix iterations when the worker leaves tracked changes uncommitted', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  initGitRepo(projectDir);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  runGit(projectDir, ['add', 'index.js']);
  runGit(projectDir, ['commit', '-m', 'base']);

  const beforeHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '1',
    FAKE_LOOP_WRITE_SUMMARY: 'changing',
    FAKE_LOOP_MUTATE_FILE: 'index.js',
    FAKE_LOOP_APPEND_TEXT: 'export const healed = true;\n',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'anatomy fix commit task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 2,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const afterHead = runGit(projectDir, ['rev-parse', 'HEAD']);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');
  const commitSubject = runGit(projectDir, ['log', '-1', '--pretty=%s']);

  assert.notEqual(afterHead, beforeHead);
  assert.equal(runGit(projectDir, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(projectDir, 'index.js'), 'utf8'), 'export const value = 1;\nexport const healed = true;\n');
  assert.match(commitSubject, /^anatomy-park: .* - Fake correctness finding #1, trap door$/);
  assert.match(runnerLog, /anatomy-park auto-committed:/);
  assert.match(runnerLog, /iteration 1 progress: .*head_sha/);
});

test('loop-runner counts anatomy-park summary updates as progress and writes stop summaries', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '2',
    FAKE_LOOP_WRITE_SUMMARY: 'changing',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'anatomy progress task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 2,
  });

  const statePath = path.join(sessionDir, 'state.json');
  const originalState = readJsonFile(statePath);
  writeJson(statePath, {
    ...originalState,
    max_iterations: 9,
    max_time_minutes: 0,
    loop_stall_count: 4,
    last_exit_reason: 'stalled',
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const state = readJsonFile(statePath);
  const stopSummary = readJsonFile(path.join(sessionDir, 'anatomy-park-stop-summary.json'));
  const stopMarkdown = fs.readFileSync(path.join(sessionDir, 'anatomy-park-stop-summary.md'), 'utf8');
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');

  assert.equal(state.last_exit_reason, 'success');
  assert.equal(state.step, 'complete');
  assert.equal(state.max_iterations, 9);
  assert.equal(state.max_time_minutes, 0);
  assert.equal(state.loop_stall_count, 0);
  assert.equal(stopSummary.stop_reason, 'success');
  assert.equal(stopSummary.highest_severity_finding, 'Fake correctness finding #2');
  assert.equal(stopSummary.finding_family, 'fake-correctness-family');
  assert.match(stopMarkdown, /Stop Reason: success/);
  assert.match(stopMarkdown, /Highest-Severity Finding: Fake correctness finding #2/);
  assert.match(runnerLog, /iteration 1 progress: .*progress_artifact:anatomy-park-summary\.json/);
});

test('loop-runner stalls anatomy-park when the canonical summary stops changing and writes stop summaries', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_LOOP_COMPLETE_AFTER: '99',
    FAKE_LOOP_WRITE_SUMMARY: 'static',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'anatomy stall task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'anatomy-park',
    target: projectDir,
    stall_limit: 2,
  });

  runNode([path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], { env, cwd: projectDir });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const stopSummary = readJsonFile(path.join(sessionDir, 'anatomy-park-stop-summary.json'));
  const stopMarkdown = fs.readFileSync(path.join(sessionDir, 'anatomy-park-stop-summary.md'), 'utf8');
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');

  assert.equal(state.last_exit_reason, 'stalled');
  assert.equal(state.step, 'paused');
  assert.equal(state.loop_stall_count, 2);
  assert.equal(stopSummary.stop_reason, 'stalled');
  assert.equal(stopSummary.highest_severity_finding, 'Fake correctness finding #1');
  assert.equal(stopSummary.finding_family, 'fake-correctness-family');
  assert.deepEqual(stopSummary.verification, ['node --test tests/session-flow.test.js']);
  assert.deepEqual(stopSummary.trap_doors, ['guard drift']);
  assert.match(stopMarkdown, /Stop Reason: stalled/);
  assert.match(stopMarkdown, /Highest-Severity Finding: Fake correctness finding #1/);
  assert.match(runnerLog, /loop-runner finished: stalled/);
});

test('cancel stops a live loop-runner iteration without rewriting the result as success', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 9.9.9-test');
  process.exit(0);
}
setTimeout(() => process.exit(0), 10000);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'cancel live loop task'], {
    env,
    cwd: projectDir,
  }).trim();

  writeJson(path.join(sessionDir, 'loop_config.json'), {
    mode: 'microverse',
    task: 'wait for cancel',
    metric: 'echo 1',
    direction: 'higher',
    stall_limit: 5,
  });

  const child = spawn('node', [path.join(repoRoot, 'bin/loop-runner.js'), sessionDir], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitFor(() => {
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    return state.active_child_kind === 'codex';
  }, { message: 'loop-runner never entered codex phase' });

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', sessionDir], { env, cwd: projectDir });

  const exit = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const log = fs.readFileSync(path.join(sessionDir, 'loop-runner.log'), 'utf8');

  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.active_child_pid, null);
  assert.equal(state.step, 'paused');
  assert.match(log, /loop-runner finished: cancelled/);
  assert.doesNotMatch(log, /finished: success/);
});

test('cancel stops live verification work without blocking the ticket', async () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  writeExecutable(
    path.join(fakeBin, 'codex'),
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
if (outputLastMessagePath) {
  fs.writeFileSync(outputLastMessagePath, '<promise>OK</promise>');
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  );
  const env = prependPath(fakeBin, { PICKLE_DATA_ROOT: dataRoot });
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'cancel verification task'], {
    env,
    cwd: repoRoot,
  }).trim();

  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Verification Cancel Ticket',
        description: 'Cancel verification mid-flight.',
        acceptance_criteria: ['The ticket can resume after cancel.'],
        verification: ['node -e "setTimeout(() => process.exit(0), 10000)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const child = spawn('node', [path.join(repoRoot, 'bin/mux-runner.js'), sessionDir], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitFor(() => {
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    return state.active_child_kind === 'verification';
  }, { timeoutMs: 10_000, message: 'mux-runner never entered verification phase' });

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--session-dir', sessionDir], { env, cwd: repoRoot });

  await new Promise((resolve) => {
    child.on('close', () => resolve());
  });

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const log = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8');

  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.active, false);
  assert.equal(state.active_child_pid, null);
  assert.equal(ticket.status, 'Todo');
  assert.match(log, /mux-runner finished: cancelled/);
  assert.doesNotMatch(log, /finished: success/);
});

test('pickle-microverse launches detached tmux loop and writes loop config', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-microverse.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([
    path.join(repoRoot, 'bin/pickle-microverse.js'),
    '--metric', 'echo 42',
    '--task', 'improve score',
    '--stall-limit', '4',
  ], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle Rick microverse tmux loop launched/);
  const match = output.match(/State: (.+\/state\.json)/);
  assert.ok(match);
  const sessionDir = path.dirname(match[1]);
  const loopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  assert.equal(loopConfig.mode, 'microverse');
  assert.equal(loopConfig.metric, 'echo 42');
  assert.equal(loopConfig.stall_limit, 4);
});

test('launchDetachedLoop rolls back tmux and session mapping on launch failure', async () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-detached-failure.jsonl');
  createFakeTmux(fakeBin);
  const previousRoot = process.env.PICKLE_DATA_ROOT;
  const previousPath = process.env.PATH;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  process.env.FAKE_TMUX_LOG = tmuxLog;
  process.env.FAKE_TMUX_FAIL_ON = 'send-keys';
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  const previousCwd = process.cwd();
  process.chdir(projectDir);

  try {
    await assert.rejects(
      () => launchDetachedLoop({
        setupArgs: ['--tmux', '--command-template', 'microverse.md', '--task', 'detached failure'],
        loopConfig: {
          mode: 'microverse',
          task: 'detached failure',
          metric: 'echo 1',
          direction: 'higher',
          stall_limit: 3,
        },
      }),
      /fake tmux forced failure on send-keys/,
    );

    const sessionsRoot = path.join(dataRoot, 'sessions');
    const [sessionId] = fs.readdirSync(sessionsRoot);
    const sessionDir = path.join(sessionsRoot, sessionId);
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
    const tmuxLogLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(state.last_exit_reason, 'launch_failed');
    assert.equal(state.tmux_session_name, null);
    assert.equal(sessionMap[fs.realpathSync(projectDir)], undefined);
    assert.ok(tmuxLogLines.some((args) => args[0] === 'kill-session'));
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previousRoot;
    }
    delete process.env.FAKE_TMUX_LOG;
    delete process.env.FAKE_TMUX_FAIL_ON;
    process.env.PATH = previousPath;
  }
});

test('szechuan-sauce and anatomy-park launch detached tmux loops', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sauceOutput = runNode([
    path.join(repoRoot, 'bin/szechuan-sauce.js'),
    '--focus', 'error handling',
    projectDir,
  ], { env, cwd: projectDir }).trim();
  assert.match(sauceOutput, /Szechuan Sauce tmux loop launched/);

  const anatomyOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    projectDir,
  ], { env, cwd: projectDir }).trim();
  assert.match(anatomyOutput, /Anatomy Park tmux loop launched/);
});

test('anatomy-park preserves an explicit unbounded max-iterations override', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: {
      max_iterations: 7,
    },
  });
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-max-iterations-zero.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--max-iterations', '0',
    projectDir,
  ], { env, cwd: projectDir }).trim();
  assert.match(output, /Anatomy Park tmux loop launched/);

  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const state = readJsonFile(statePath);
  assert.equal(state.max_iterations, 0);
});

test('anatomy-park resume preserves the stored loop target and explicit loop settings', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetDir = path.join(projectDir, 'subsystem');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-resume-config.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const initialOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    '--stall-limit', '9',
    targetDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = initialOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);
  const initialLoopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  const initialState = readJsonFile(statePath);
  writeJson(statePath, {
    ...initialState,
    max_iterations: 41,
    max_time_minutes: 0,
    worker_timeout_seconds: 321,
  });

  const resumedOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--resume',
    sessionDir,
  ], { env, cwd: projectDir }).trim();
  assert.match(resumedOutput, /Anatomy Park tmux loop launched/);

  const loopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  const resumedState = readJsonFile(statePath);
  assert.equal(loopConfig.target, initialLoopConfig.target);
  assert.equal(loopConfig.dry_run, initialLoopConfig.dry_run);
  assert.equal(loopConfig.stall_limit, initialLoopConfig.stall_limit);
  assert.equal(resumedState.max_iterations, 41);
  assert.equal(resumedState.max_time_minutes, 0);
  assert.equal(resumedState.worker_timeout_seconds, 321);
});

test('anatomy-park resume rejects retargeting the session and preserves the stored target', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetA = path.join(projectDir, 'subsystem-a');
  const targetB = path.join(projectDir, 'subsystem-b');
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.writeFileSync(path.join(targetA, 'index.js'), 'export const value = "a";\n');
  fs.writeFileSync(path.join(targetB, 'index.js'), 'export const value = "b";\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-retarget-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const initialOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    targetA,
  ], { env, cwd: projectDir }).trim();
  const statePath = initialOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);
  const initialState = readJsonFile(statePath);
  const initialLoopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  writeJson(statePath, {
    ...initialState,
    active: false,
    tmux_runner_pid: null,
    last_exit_reason: 'cancelled',
  });
  const tmuxLogBeforeResume = fs.readFileSync(tmuxLog, 'utf8');

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume', sessionDir, targetB], {
      env,
      cwd: projectDir,
    }),
    /Cannot change target when resuming anatomy-park:/,
  );

  const resumedState = readJsonFile(statePath);
  const resumedLoopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  assert.equal(resumedState.active, false);
  assert.equal(resumedState.tmux_runner_pid, null);
  assert.equal(resumedState.last_exit_reason, 'cancelled');
  assert.equal(resumedLoopConfig.target, initialLoopConfig.target);
  assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeResume}["-V"]\n`);
});

test('anatomy-park launches tmux against the requested target instead of the launcher cwd', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetDir = path.join(projectDir, 'subsystem');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-target-cwd.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    targetDir,
  ], { env, cwd: projectDir }).trim();
  assert.match(output, /Anatomy Park tmux loop launched/);

  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);
  const state = readJsonFile(statePath);
  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
  const tmuxLogLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const newSessionArgs = tmuxLogLines.find((args) => args[0] === 'new-session');
  const realProjectDir = fs.realpathSync(projectDir);
  const realTargetDir = fs.realpathSync(targetDir);

  assert.equal(state.working_dir, realTargetDir);
  assert.equal(sessionMap[realProjectDir], sessionDir);
  assert.equal(sessionMap[realTargetDir], sessionDir);
  assert.equal(newSessionArgs[newSessionArgs.indexOf('-c') + 1], realTargetDir);
});

test('anatomy-park target-based sessions resolve from the target cwd and cancel clears both cwd aliases', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetDir = path.join(projectDir, 'subsystem');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-session-aliases.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    targetDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = output.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);
  const realProjectDir = fs.realpathSync(projectDir);
  const realTargetDir = fs.realpathSync(targetDir);

  assert.equal(runNode([path.join(repoRoot, 'bin/get-session.js'), '--cwd', targetDir], { env }).trim(), sessionDir);

  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(sessionMap[realProjectDir], sessionDir);
  assert.equal(sessionMap[realTargetDir], sessionDir);

  runNode([path.join(repoRoot, 'bin/cancel.js'), '--cwd', projectDir], { env, cwd: projectDir });

  const updatedSessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(updatedSessionMap[realProjectDir], undefined);
  assert.equal(updatedSessionMap[realTargetDir], undefined);
});

test('anatomy-park resume falls back to launcher cwd aliases when the session map is missing', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetDir = path.join(projectDir, 'subsystem');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-anatomy-resume-alias-fallback.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const firstOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    targetDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = firstOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  writeJson(statePath, {
    ...readJsonFile(statePath),
    active: false,
    tmux_runner_pid: null,
    last_exit_reason: 'cancelled',
  });
  fs.rmSync(path.join(dataRoot, 'current_sessions.json'), { force: true });

  const resumedOutput = runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume'], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(resumedOutput, new RegExp(`Session: anatomy-park-${path.basename(sessionDir)}`));
  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(sessionMap[fs.realpathSync(projectDir)], sessionDir);
  assert.equal(sessionMap[fs.realpathSync(targetDir)], sessionDir);
});

test('setup resume restores every stored alias when recovering an anatomy-park session', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetDir = path.join(projectDir, 'subsystem');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-setup-resume-alias-recovery.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const launchOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    '--dry-run',
    targetDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = launchOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  writeJson(statePath, {
    ...readJsonFile(statePath),
    active: false,
    tmux_runner_pid: null,
    last_exit_reason: 'cancelled',
  });
  fs.rmSync(path.join(dataRoot, 'current_sessions.json'), { force: true });

  const resumed = runNode([
    path.join(repoRoot, 'bin/setup.js'),
    '--resume',
    '--tmux',
  ], {
    env,
    cwd: projectDir,
  }).trim();

  assert.equal(resumed, sessionDir);
  const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'), {});
  assert.equal(sessionMap[fs.realpathSync(projectDir)], sessionDir);
  assert.equal(sessionMap[fs.realpathSync(targetDir)], sessionDir);
});

test('advanced loop resume rejects cross-mode session reuse before mutating state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const microverseOutput = runNode([
    path.join(repoRoot, 'bin/pickle-microverse.js'),
    '--metric', 'echo 42',
    '--task', 'improve score',
  ], {
    env,
    cwd: projectDir,
  }).trim();
  const statePath = microverseOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume'], {
      env,
      cwd: projectDir,
    }),
    /Cannot resume anatomy-park: .* is a microverse session\./,
  );

  const loopConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'));
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(loopConfig.mode, 'microverse');
  assert.equal(state.command_template, 'microverse.md');
});

test('advanced loop resume refuses to relaunch a live session before mutating state', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-live-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const anatomyOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = anatomyOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const originalState = readJsonFile(path.join(sessionDir, 'state.json'));
    writeJson(path.join(sessionDir, 'state.json'), {
      ...originalState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });
    const tmuxLogBeforeResume = fs.readFileSync(tmuxLog, 'utf8');

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume'], {
        env,
        cwd: projectDir,
      }),
      /Session is already running under tmux runner pid \d+\./,
    );

    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    assert.equal(state.active, true);
    assert.equal(state.tmux_runner_pid, runner.pid);
    assert.equal(state.last_exit_reason, null);
    assert.equal(state.command_template, 'anatomy-park.md');
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeResume}["-V"]\n`);
  } finally {
    runner.kill('SIGTERM');
  }
});

test('advanced loop fresh launch refuses to start while another tmux runner owns the working tree', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-concurrent-launch.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const firstOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = firstOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const originalState = readJsonFile(path.join(sessionDir, 'state.json'));
    writeJson(path.join(sessionDir, 'state.json'), {
      ...originalState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });
    const tmuxLogBeforeSecondLaunch = fs.readFileSync(tmuxLog, 'utf8');

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), projectDir], {
        env,
        cwd: projectDir,
      }),
      new RegExp(`A tmux runner is already active for ${realProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} under session .* \\(pid ${runner.pid}\\)\\.`),
    );

    const sessionsRoot = path.join(dataRoot, 'sessions');
    const sessionEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(sessionEntries.length, 1);
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    assert.equal(state.active, true);
    assert.equal(state.tmux_runner_pid, runner.pid);
    const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
    assert.equal(sessionMap[fs.realpathSync(projectDir)], sessionDir);
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeSecondLaunch}["-V"]\n`);
  } finally {
    runner.kill('SIGTERM');
  }
});

test('advanced loop fresh launch refuses to reuse the launcher cwd alias for a different target', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const targetA = path.join(projectDir, 'subsystem-a');
  const targetB = path.join(projectDir, 'subsystem-b');
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.writeFileSync(path.join(targetA, 'index.js'), 'export const value = "a";\n');
  fs.writeFileSync(path.join(targetB, 'index.js'), 'export const value = "b";\n');
  const realProjectDir = fs.realpathSync(projectDir);
  const realTargetA = fs.realpathSync(targetA);
  const realTargetB = fs.realpathSync(targetB);
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-launcher-alias-conflict.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const firstOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    targetA,
  ], { env, cwd: projectDir }).trim();
  const statePath = firstOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const originalState = readJsonFile(path.join(sessionDir, 'state.json'));
    writeJson(path.join(sessionDir, 'state.json'), {
      ...originalState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });
    const tmuxLogBeforeSecondLaunch = fs.readFileSync(tmuxLog, 'utf8');

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), targetB], {
        env,
        cwd: projectDir,
      }),
      new RegExp(`A tmux runner is already active for ${realProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} under session .* \\(pid ${runner.pid}\\)\\.`),
    );

    const sessionsRoot = path.join(dataRoot, 'sessions');
    const sessionEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(sessionEntries.length, 1);
    const state = readJsonFile(path.join(sessionDir, 'state.json'));
    assert.equal(state.active, true);
    assert.equal(state.tmux_runner_pid, runner.pid);
    const sessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
    assert.equal(sessionMap[realProjectDir], sessionDir);
    assert.equal(sessionMap[realTargetA], sessionDir);
    assert.equal(sessionMap[realTargetB], undefined);
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeSecondLaunch}["-V"]\n`);
  } finally {
    runner.kill('SIGTERM');
  }
});

test('advanced loop fresh launch refuses to start while a cwd reservation lock is held', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const sessionsRoot = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-cwd-reservation.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  holder.unref();

  try {
    const cwdLockName = `.tmux-cwd-${crypto.createHash('sha256').update(realProjectDir).digest('hex').slice(0, 16)}.lock`;
    fs.writeFileSync(path.join(sessionsRoot, cwdLockName), String(holder.pid));

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), projectDir], {
        env,
        cwd: projectDir,
      }),
      new RegExp(`A tmux launch is already in progress for ${realProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
    );

    const sessionEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(sessionEntries.length, 0);
    assert.deepEqual(readJsonFile(path.join(dataRoot, 'current_sessions.json'), {}), {});
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), '["-V"]\n');
  } finally {
    holder.kill('SIGTERM');
  }
});

test('advanced loop resume honors an explicit session dir instead of the cwd mapping', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-explicit-resume.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const explicitOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const explicitStatePath = explicitOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(explicitStatePath);
  const explicitSession = path.dirname(explicitStatePath);

  const mappedOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const mappedStatePath = mappedOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(mappedStatePath);
  const mappedSession = path.dirname(mappedStatePath);
  assert.notEqual(mappedSession, explicitSession);

  const originalExplicitState = readJsonFile(path.join(explicitSession, 'state.json'));
  writeJson(path.join(explicitSession, 'state.json'), {
    ...originalExplicitState,
    active: false,
    tmux_runner_pid: null,
    last_exit_reason: 'cancelled',
  });
  fs.writeFileSync(path.join(explicitSession, '.tmux-launch.lock'), String(process.pid));
  const tmuxLogBeforeResume = fs.readFileSync(tmuxLog, 'utf8');

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume', explicitSession], {
      env,
      cwd: projectDir,
    }),
    new RegExp(`A tmux launch is already in progress for ${explicitSession.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
  );

  const explicitState = readJsonFile(path.join(explicitSession, 'state.json'));
  assert.equal(explicitState.active, false);
  assert.equal(explicitState.tmux_runner_pid, null);
  assert.equal(explicitState.last_exit_reason, 'cancelled');

  const currentSessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
  assert.equal(currentSessionMap[fs.realpathSync(projectDir)], mappedSession);
  assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeResume}["-V"]\n`);
});

test('advanced loop explicit resume refuses to relaunch while another session owns the working tree', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-explicit-resume-conflict.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const pausedOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const pausedStatePath = pausedOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(pausedStatePath);
  const pausedSession = path.dirname(pausedStatePath);

  const activeOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const activeStatePath = activeOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(activeStatePath);
  const activeSession = path.dirname(activeStatePath);
  assert.notEqual(activeSession, pausedSession);

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const pausedState = readJsonFile(path.join(pausedSession, 'state.json'));
    writeJson(path.join(pausedSession, 'state.json'), {
      ...pausedState,
      active: false,
      tmux_runner_pid: null,
      last_exit_reason: 'cancelled',
    });

    const activeState = readJsonFile(path.join(activeSession, 'state.json'));
    writeJson(path.join(activeSession, 'state.json'), {
      ...activeState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });
    const tmuxLogBeforeResume = fs.readFileSync(tmuxLog, 'utf8');

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume', pausedSession], {
        env,
        cwd: projectDir,
      }),
      new RegExp(`A tmux runner is already active for ${realProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} under session ${activeSession.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(pid ${runner.pid}\\)\\.`),
    );

    const resumedState = readJsonFile(path.join(pausedSession, 'state.json'));
    assert.equal(resumedState.active, false);
    assert.equal(resumedState.tmux_runner_pid, null);
    assert.equal(resumedState.last_exit_reason, 'cancelled');

    const currentSessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
    assert.equal(currentSessionMap[realProjectDir], activeSession);
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeResume}["-V"]\n`);
  } finally {
    runner.kill('SIGTERM');
  }
});

test('advanced loop explicit resume ignores an unrelated launcher cwd reservation', () => {
  const dataRoot = makeTempRoot();
  const projectADir = makeTempRoot('pickle-rick-project-a-');
  const projectBDir = makeTempRoot('pickle-rick-project-b-');
  const realProjectADir = fs.realpathSync(projectADir);
  const realProjectBDir = fs.realpathSync(projectBDir);
  fs.writeFileSync(path.join(projectADir, 'index.js'), 'export const project = "a";\n');
  fs.writeFileSync(path.join(projectBDir, 'index.js'), 'export const project = "b";\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-explicit-resume-cross-project.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const pausedOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectADir,
  ], { env, cwd: projectADir }).trim();
  const pausedStatePath = pausedOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(pausedStatePath);
  const pausedSession = path.dirname(pausedStatePath);

  const activeOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectBDir,
  ], { env, cwd: projectBDir }).trim();
  const activeStatePath = activeOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(activeStatePath);
  const activeSession = path.dirname(activeStatePath);

  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  runner.unref();

  try {
    const pausedState = readJsonFile(path.join(pausedSession, 'state.json'));
    writeJson(path.join(pausedSession, 'state.json'), {
      ...pausedState,
      active: false,
      tmux_runner_pid: null,
      last_exit_reason: 'cancelled',
    });

    const activeState = readJsonFile(path.join(activeSession, 'state.json'));
    writeJson(path.join(activeSession, 'state.json'), {
      ...activeState,
      active: true,
      tmux_runner_pid: runner.pid,
      last_exit_reason: null,
    });

    const resumedOutput = runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume', pausedSession], {
      env,
      cwd: projectBDir,
    }).trim();

    assert.match(resumedOutput, new RegExp(`Session: anatomy-park-${path.basename(pausedSession)}`));
    const currentSessionMap = readJsonFile(path.join(dataRoot, 'current_sessions.json'));
    assert.equal(currentSessionMap[realProjectADir], pausedSession);
    assert.equal(currentSessionMap[realProjectBDir], activeSession);

    const resumedState = readJsonFile(path.join(pausedSession, 'state.json'));
    assert.equal(resumedState.working_dir, realProjectADir);
    assert.ok(!resumedState.session_map_cwds.includes(realProjectBDir));
  } finally {
    runner.kill('SIGTERM');
  }
});

test('advanced loop resume refuses to relaunch while a tmux launch lock is held', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export const value = 1;\n');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-advanced-launch-lock.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const anatomyOutput = runNode([
    path.join(repoRoot, 'bin/anatomy-park.js'),
    projectDir,
  ], { env, cwd: projectDir }).trim();
  const statePath = anatomyOutput.match(/^State: (.+)$/m)?.[1];
  assert.ok(statePath);
  const sessionDir = path.dirname(statePath);

  const originalState = readJsonFile(path.join(sessionDir, 'state.json'));
  writeJson(path.join(sessionDir, 'state.json'), {
    ...originalState,
    active: false,
    tmux_runner_pid: null,
    last_exit_reason: 'cancelled',
  });
  fs.writeFileSync(path.join(sessionDir, '.tmux-launch.lock'), String(process.pid));
  const tmuxLogBeforeResume = fs.readFileSync(tmuxLog, 'utf8');

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/anatomy-park.js'), '--resume'], {
      env,
      cwd: projectDir,
    }),
    new RegExp(`A tmux launch is already in progress for ${sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.tmux_runner_pid, null);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(state.command_template, 'anatomy-park.md');
  assert.equal(fs.readFileSync(tmuxLog, 'utf8'), `${tmuxLogBeforeResume}["-V"]\n`);
});
