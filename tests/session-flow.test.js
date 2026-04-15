import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, writeJson, prependPath, createFakeTmux } from './helpers.js';
import { createFakeCodex } from './helpers.js';

test('setup command creates a session and get-session resolves it', () => {
  const dataRoot = makeTempRoot();
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'session flow task'], { env }).trim();
  const fetched = runNode([path.join(repoRoot, 'bin/get-session.js'), '--cwd', repoRoot], { env }).trim();

  assert.equal(fetched, sessionDir);
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

test('cancel marks the session inactive and removes the session map entry', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const realProjectDir = fs.realpathSync(projectDir);
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'cancel task'], { env, cwd: realProjectDir }).trim();

  const output = runNode([path.join(repoRoot, 'bin/cancel.js'), '--cwd', realProjectDir], { env }).trim();
  assert.match(output, new RegExp(`^Cancelled ${sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.equal(readJsonFile(path.join(dataRoot, 'current_sessions.json'), {} )[projectDir], undefined);
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

test('pickle-tmux launches detached tmux runner and monitor windows', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-tmux-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux.jsonl');
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const output = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--max-iterations', '5', 'detached epic'], {
    env,
    cwd: projectDir,
  }).trim();

  assert.match(output, /Pickle Rick tmux mode launched/);
  assert.match(output, /Attach: tmux attach -t pickle-/);
  const logLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines[0][0], '-V');
  assert.ok(logLines.some((args) => args[0] === 'new-session'));
  assert.ok(logLines.some((args) => args[0] === 'send-keys'));
  assert.ok(logLines.some((args) => args[0] === 'select-window'));
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
