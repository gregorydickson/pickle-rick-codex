// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, repoRoot, runNode, writeJson } from './helpers.js';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
import { muxRunnerExitFailed, runSequential } from '../bin/mux-runner.js';
import { StateManager } from '../services/state-manager.js';
import { updateTicketStatus } from '../services/tickets.js';
import { writeRefinementAcceptance } from '../services/refinement-artifacts.js';
import { WorkerLifecycleRefusalError } from '../services/worker-lifecycle.js';
import {
  buildTicketRecoveryFailureIdentity,
  recordTicketRecoveryFailure,
} from '../services/recovery-controller.js';

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
        allowed_paths: ['README.md'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Runner fixture PRD\n');
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# Runner fixture refined PRD\n');
  writeRefinementAcceptance(sessionDir);
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

test('mux-runner adaptive recovery continues when review findings or remediation content change', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive changed-lineage task');
  let calls = 0;
  const attempts = [
    { finding: 'first blocker', remediation: 'tree-a' },
    { finding: 'second blocker', remediation: 'tree-a' },
    { finding: 'second blocker', remediation: 'tree-b' },
  ];

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls <= attempts.length) {
          const artifact = {
            schema_version: 1,
            phase: 'review',
            ticket_id: 'r1',
            summary: 'Review requested changes.',
            verdict: 'changes_requested',
            findings: [attempts[calls - 1].finding],
          };
          const refusal = new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
          refusal.remediationIdentity = attempts[calls - 1].remediation;
          throw refusal;
        }
        return { status: 'done', applied: true };
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 4);
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.deepEqual(history.events.map((event) => event.changed_lineage), [true, true, true]);
});

test('mux-runner adaptive recovery rolls repeated unchanged findings into a new strategy epoch', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive unchanged-lineage task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 3 } },
  });
  let calls = 0;

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 4) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'Review requested changes.',
          verdict: 'changes_requested',
          findings: ['unchanged blocker'],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 4);
  const circuit = JSON.parse(fs.readFileSync(path.join(sessionDir, 'circuit_breaker.json'), 'utf8'));
  assert.equal(circuit.state, 'CLOSED');
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.deepEqual(history.events.map((event) => event.consecutive_same_lineage), [1, 2, 3]);
  const authorizations = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-authorizations.json'), 'utf8'));
  assert.equal(authorizations.authorizations.at(-1).authorized_by, 'runner');
});

test('mux-runner adaptive recovery rolls interleaved recurring lineages into a new strategy epoch', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive interleaved-lineage task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 3, no_progress_threshold: 5 } },
  });
  let calls = 0;

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 6) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'Review requested changes.',
          verdict: 'changes_requested',
          findings: [calls % 2 === 0 ? 'blocker B' : 'blocker A'],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 6);
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.deepEqual(history.events.map((event) => event.lineage_occurrences), [1, 1, 2, 2, 3]);
});

test('mux-runner adaptive recovery converts the durable ticket budget into a strategy epoch', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive global-budget task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 30, no_progress_threshold: 30 } },
  });
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 26) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'Review requested changes.',
          verdict: 'changes_requested',
          findings: [`unique blocker ${calls}`],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 26);
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.equal(history.events.length, 25, 'automatic epoch preserves prior recovery evidence');
  const authorizations = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-authorizations.json'), 'utf8'));
  assert.equal(authorizations.authorizations.length, 1);
  assert.equal(authorizations.authorizations[0].authorized_by, 'runner');
});

test('mux-runner resumes a previously exhausted ticket through an automatic strategy epoch', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive exhausted resume task');
  const identity = buildTicketRecoveryFailureIdentity({
    failureKind: 'worker_failure',
    message: 'legacy unique failure',
  });
  for (let index = 0; index < 25; index += 1) {
    recordTicketRecoveryFailure({
      sessionDir,
      ticketId: 'r1',
      failureKind: 'worker_failure',
      identity: { ...identity, signature: index.toString(16).padStart(64, '0') },
    });
  }
  let calls = 0;

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 1);
  const authorizations = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-authorizations.json'), 'utf8'));
  assert.equal(authorizations.authorizations.at(-1).authorized_by, 'runner');
});

test('disabled circuit ignores lineage thresholds and rolls the absolute recovery budget forward', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('disabled circuit budget task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { enabled: false, same_error_threshold: 2 } },
  });
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 26) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'Review requested changes.',
          verdict: 'changes_requested',
          findings: ['same blocker'],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 26);
  const circuitPath = path.join(sessionDir, 'circuit_breaker.json');
  const circuit = fs.existsSync(circuitPath)
    ? JSON.parse(fs.readFileSync(circuitPath, 'utf8'))
    : { state: 'CLOSED' };
  assert.notEqual(circuit.state, 'OPEN');
});

test('adaptive recovery permits success on the final budgeted attempt', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('adaptive boundary success task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 30 } },
  });
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 25) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'Review requested changes.',
          verdict: 'changes_requested',
          findings: [`unique blocker ${calls}`],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/${calls}.json`, artifact);
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(calls, 25);
  assert.match(readRunnerLog(sessionDir), /completed ticket r1/);
});

test('mux-runner CLI treats recovery blocks as failures', () => {
  assert.equal(muxRunnerExitFailed('recovery_exhausted'), true);
  assert.equal(muxRunnerExitFailed('recovery_required'), true);
  assert.equal(muxRunnerExitFailed('success'), false);
});

test('mux-runner refuses ticket execution while the circuit is OPEN', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('open circuit task');
  writeJson(path.join(sessionDir, 'circuit_breaker.json'), {
    state: 'OPEN',
    reason: 'stalled',
  });
  let calls = 0;

  const finalReason = await withDataRoot(dataRoot, () =>
    runSequential(sessionDir, { onFailure: 'retry-once', runnerMode: 'pickle' }, {
      runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      },
    }),
  );

  assert.equal(calls, 0);
  assert.equal(finalReason, 'circuit_open');
  assert.match(readRunnerLog(sessionDir), /refusing ticket r1: circuit breaker is OPEN/);
});

test('mux-runner chooses dependency-runnable work even when the manifest is not topologically sorted', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('dependency order task');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'dependent',
        title: 'Dependent ticket',
        description: 'Runs after its prerequisite.',
        acceptance_criteria: ['The prerequisite is Done first.'],
        verification: ['node -e "process.exit(0)"'],
        allowed_paths: ['dependent.txt'],
        priority: 'P1',
        status: 'Todo',
        depends_on: ['root'],
      },
      {
        id: 'root',
        title: 'Root ticket',
        description: 'Runs before its dependent.',
        acceptance_criteria: ['The root ticket is executable immediately.'],
        verification: ['node -e "process.exit(0)"'],
        allowed_paths: ['root.txt'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const calls = [];

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'abort', runnerMode: 'pickle' },
    {
      runTicket: async (_sessionDir, ticketId) => {
        calls.push(ticketId);
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.deepEqual(calls, ['root', 'dependent']);
});

test('mux-runner schedules diagnostic work instead of terminating when all tickets are blocked', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('all blocked repair task');
  updateTicketStatus(sessionDir, 'r1', { status: 'Blocked', failure_reason: 'contract needs repair' });
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      },
    },
  ));
  assert.equal(finalReason, 'success');
  assert.equal(calls, 1);
  assert.match(readRunnerLog(sessionDir), /all tickets blocked; scheduled diagnose-and-select-material-repair-strategy/);
});

test('mux-runner yields a repairing ticket to independent dependency-ready work', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('scheduler continuity task');
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  manifest.tickets.push({
    ...manifest.tickets[0],
    id: 'r2',
    title: 'Independent ticket',
    allowed_paths: ['independent.txt'],
    status: 'Todo',
  });
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), manifest);
  const calls = [];
  let r1Attempts = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async (_dir, ticketId) => {
        calls.push(ticketId);
        if (ticketId === 'r1' && r1Attempts++ === 0) throw new Error('transient worker transport');
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ));
  assert.equal(finalReason, 'success');
  assert.deepEqual(calls, ['r1', 'r2', 'r1']);
});

test('mux-runner turns an iteration threshold into a strategy epoch instead of terminal exhaustion', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('iteration strategy transition task');
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.iteration = 2;
  state.max_iterations = 2;
  writeJson(statePath, state);
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      },
    },
  ));
  assert.equal(finalReason, 'success');
  assert.equal(calls, 1);
  const strategies = JSON.parse(fs.readFileSync(path.join(sessionDir, 'recovery-strategies.json'), 'utf8'));
  assert.equal(strategies.epochs[0].trigger, 'time_threshold');
});

test('mux-runner refuses to overlap another live session operation', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('operation lease task');
  const manager = new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  const leasePath = path.join(sessionDir, '.session-operation');
  manager.acquireLock(leasePath);
  try {
    await assert.rejects(
      () => withDataRoot(dataRoot, () => runSequential(sessionDir)),
      /Another session operation is already running/,
    );
  } finally {
    manager.releaseLock(leasePath);
  }
});

test('mux-runner preserves cancellation requested during startup', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('startup cancellation task');
  const statePath = path.join(sessionDir, 'state.json');
  const runStartedAtMs = Date.now();
  new StateManager().update(statePath, (state) => {
    state.active = false;
    state.last_exit_reason = 'cancelled';
    state.cancel_requested_at = new Date(runStartedAtMs + 1).toISOString();
    return state;
  });
  let calls = 0;

  await assert.rejects(
    () => withDataRoot(dataRoot, () => runSequential(
      sessionDir,
      { runStartedAtMs },
      { runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      } },
    )),
    /cancelled during runner startup/,
  );
  assert.equal(calls, 0);
  const state = readJsonFile(statePath);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.ok(state.cancel_requested_at);
  assert.equal(fs.existsSync(path.join(sessionDir, '.session-operation.lock')), false);
});

test('mux-runner requires the live tmux launch owner for operation handoff', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('launch handoff task');
  const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(launcher.pid);
  fs.writeFileSync(path.join(sessionDir, '.tmux-launch.lock'), String(launcher.pid));
  try {
    await assert.rejects(
      () => withDataRoot(dataRoot, () => runSequential(sessionDir)),
      /tmux launch is already in progress/,
    );
    const result = await withDataRoot(dataRoot, () => runSequential(
      sessionDir,
      { launchOwnerPid: launcher.pid },
      { runTicket: async (_sessionDir, ticketId) => {
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      } },
    ));
    assert.equal(result, 'success');
  } finally {
    launcher.kill('SIGTERM');
    fs.rmSync(path.join(sessionDir, '.tmux-launch.lock'), { force: true });
  }
});
