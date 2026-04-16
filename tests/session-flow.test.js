import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { makeTempRoot, repoRoot, runNode, writeJson, prependPath, createFakeTmux, writeExecutable } from './helpers.js';
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
