// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, repoRoot, runNode, writeJson } from './helpers.js';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
import { runSequential } from '../bin/mux-runner.js';

function createSessionWithTodoTicket(taskLabel) {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), taskLabel], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Oracle refusal ticket',
        description: 'Runner must honor the oracle completion verdict.',
        acceptance_criteria: ['The runner only marks Done when the oracle accepts completion.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  return { dataRoot, sessionDir };
}

function readRunnerLog(sessionDir) {
  return fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf8');
}

function readTicket(sessionDir) {
  return parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
}

async function withDataRoot(dataRoot, fn) {
  const previous = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previous;
    }
  }
}

test('mux-runner does not mark an oracle-refused ticket Done and aborts under on-failure=abort', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('oracle refusal abort task');

  const finalReason = await withDataRoot(dataRoot, () =>
    runSequential(sessionDir, { onFailure: 'abort', runnerMode: 'pickle' }, {
      runTicket: async () => ({ status: 'incomplete', applied: false, reason: 'foreign_attribution' }),
    }),
  );

  const log = readRunnerLog(sessionDir);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = readTicket(sessionDir);

  assert.equal(finalReason, 'error');
  assert.doesNotMatch(log, /completed ticket r1/);
  assert.match(log, /ticket r1 not completed: oracle refusal foreign_attribution/);
  assert.notEqual(ticket.status, 'Done');
  assert.equal(state.last_exit_reason, 'error');
  assert.equal(state.current_ticket, 'r1');
});

test('mux-runner marks a ticket Done and logs completion when the oracle accepts (status:done)', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('oracle accept task');

  const finalReason = await withDataRoot(dataRoot, () =>
    runSequential(sessionDir, { onFailure: 'abort', runnerMode: 'pickle' }, {
      runTicket: async () => ({ status: 'done', applied: true }),
    }),
  );

  const log = readRunnerLog(sessionDir);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));

  assert.equal(finalReason, 'success');
  assert.match(log, /completed ticket r1/);
  assert.doesNotMatch(log, /not completed: oracle refusal/);
  assert.equal(state.last_exit_reason, 'success');
});

test('mux-runner skips an oracle-refused ticket under on-failure=skip and continues', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('oracle refusal skip task');

  const finalReason = await withDataRoot(dataRoot, () =>
    runSequential(sessionDir, { onFailure: 'skip', runnerMode: 'pickle' }, {
      runTicket: async () => ({ status: 'incomplete', applied: false, reason: 'foreign_attribution' }),
    }),
  );

  const log = readRunnerLog(sessionDir);
  const ticket = readTicket(sessionDir);

  assert.equal(finalReason, 'success');
  assert.doesNotMatch(log, /completed ticket r1/);
  assert.match(log, /ticket r1 not completed: oracle refusal foreign_attribution/);
  assert.match(log, /skipping ticket r1/);
  assert.equal(ticket.status, 'Skipped');
});

test('mux-runner retries an oracle-refused ticket once then aborts under on-failure=retry-once', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('oracle refusal retry task');

  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () =>
    runSequential(sessionDir, { onFailure: 'retry-once', runnerMode: 'pickle' }, {
      runTicket: async () => {
        calls += 1;
        return { status: 'incomplete', applied: false, reason: 'foreign_attribution' };
      },
    }),
  );

  const log = readRunnerLog(sessionDir);
  const ticket = readTicket(sessionDir);

  assert.equal(calls, 2);
  assert.equal(finalReason, 'error');
  assert.doesNotMatch(log, /completed ticket r1/);
  assert.notEqual(ticket.status, 'Done');
});
