// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeCodex, makeTempRoot, prependPath, repoRoot, runNode, writeExecutable, writeJson } from './helpers.js';
import { parseTicketFile, readJsonFile } from '../services/pickle-utils.js';
import { muxRunnerExitFailed, runSequential } from '../bin/mux-runner.js';
import { StateManager } from '../services/state-manager.js';
import { readManifest, updateTicketStatus } from '../services/tickets.js';
import { writeRefinementAcceptance } from '../services/refinement-artifacts.js';
import { WorkerLifecycleRefusalError } from '../services/worker-lifecycle.js';
import { VerificationCommandError } from '../bin/spawn-morty.js';
import {
  beginRecoveryStrategyEpoch,
  executionTelemetrySummary,
  nextMaterialApproach,
  readRecoveryStrategyEpochs,
} from '../services/productive-autonomy.js';
import {
  buildTicketRecoveryFailureIdentity,
  recordTicketRecoveryFailure,
} from '../services/recovery-controller.js';
import { DependencyRepairIsolationError } from '../services/dependency-contract-repair.js';

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

async function withDataRoot(dataRoot, fn, environment = {}) {
  const overrides = { PICKLE_DATA_ROOT: dataRoot, ...environment };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

test('mux-runner production routing repairs exhausted review and conformance artifacts', async () => {
  const expectedInvalidate = ['implement', 'verify', 'review', 'conformance', 'quality', 'promote'];
  for (const phase of ['review', 'conformance']) {
    const { dataRoot, sessionDir } = createSessionWithTodoTicket(`${phase} artifact recovery task`);
    let calls = 0;
    const finalReason = await withDataRoot(dataRoot, () => runSequential(
      sessionDir,
      { onFailure: 'retry', runnerMode: 'pickle' },
      {
        runTicket: async (_dir, _ticketId, options) => {
          calls += 1;
          if (calls === 1) {
            new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
              state.step = phase;
              return state;
            });
            throw new Error(`worker-lifecycle-invalid-artifact: ${phase} exhausted bounded artifact recovery`);
          }
          assert.equal(options.recoveryStrategy.handler, 'repair_artifact');
          assert.equal(options.recoveryStrategy.checkpoint, 'implement');
          return { status: 'done', applied: true };
        },
      },
    ));

    assert.equal(finalReason, 'success');
    assert.equal(calls, 2);
    const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
    assert.equal(history.events[0].failure_domain, 'infrastructure');
    assert.equal(history.events[0].recovery_handler, 'repair_artifact');
    assert.deepEqual(history.events[0].invalidated_checkpoints, expectedInvalidate);
  }
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

test('literal no-progress run selects three material strategies without human input or an intermediate terminal stop', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('three-strategy no-progress task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 3, no_progress_threshold: 3 } },
  });
  let calls = 0;
  let contractRepairs = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async () => {
        calls += 1;
        if (calls === 13) return { status: 'done', applied: true };
        const artifact = {
          schema_version: 1,
          phase: 'review',
          ticket_id: 'r1',
          summary: 'The candidate made no progress.',
          verdict: 'changes_requested',
          findings: ['literal unchanged no-progress blocker'],
        };
        throw new WorkerLifecycleRefusalError('review', `/evidence/no-progress-${calls}.json`, artifact);
      },
      repairTicketVerificationContract: async () => {
        contractRepairs += 1;
        return [{ kind: 'process', executable: process.execPath, args: ['--version'] }];
      },
    },
  ));

  const strategies = readRecoveryStrategyEpochs(sessionDir).filter((epoch) => epoch.ticketId === 'r1');
  const authorizations = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-authorizations.json'), 'utf8'));
  assert.equal(finalReason, 'success');
  assert.equal(calls, 13);
  assert.equal(contractRepairs, 1);
  assert.ok(strategies.length >= 4);
  assert.equal(new Set(strategies.slice(0, 3).map((epoch) => epoch.materialApproach)).size, 3);
  assert.equal(new Set(strategies.slice(0, 3).map((epoch) => epoch.strategyHash)).size, 3);
  assert.ok(authorizations.authorizations.length >= 3);
  assert.equal(strategies[3].handler, 'repair_contract');
  assert.ok(authorizations.authorizations.every((authorization) => authorization.authorized_by === 'runner'));
  assert.equal(executionTelemetrySummary(sessionDir).postSealHumanInterventions, 0);
  assert.doesNotMatch(readRunnerLog(sessionDir), /paused for explicit PRD revision approval|stopping during ticket|refusing ticket/);
});

test('mux-runner resumes a persisted strategy-exhaustion stop through durable escalation', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('strategy exhaustion relaunch task');
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: { circuit_breaker: { same_error_threshold: 3, no_progress_threshold: 3 } },
  });
  const base = {
    ticketId: 'r1', domain: 'review', handler: 'remediate_candidate', checkpoint: 'implement',
    constraints: ['unchanged review refusal'],
  };
  for (let index = 0; index < 3; index += 1) {
    beginRecoveryStrategyEpoch(sessionDir, {
      ...base, materialApproach: nextMaterialApproach('review', index),
    }, 'circuit_threshold');
  }
  const identity = buildTicketRecoveryFailureIdentity({
    failureKind: 'worker_failure', message: 'unchanged review refusal', phase: 'review',
  });
  for (let index = 0; index < 3; index += 1) {
    recordTicketRecoveryFailure({ sessionDir, ticketId: 'r1', failureKind: 'worker_failure', identity });
  }
  new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
    state.recovery_required = true;
    state.recovery_kind = 'ticket_recovery_history';
    state.recovery_reason = 'recovery-strategy-not-novel: predecessor exhausted A/B/C';
    return state;
  });

  let contractRepairs = 0;
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      repairTicketVerificationContract: async () => {
        contractRepairs += 1;
        return [{ kind: 'process', executable: process.execPath, args: ['--version'] }];
      },
      runTicket: async (_dir, ticketId, options) => {
        calls += 1;
        assert.equal(options.recoveryStrategy.handler, 'repair_contract');
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ));

  assert.equal(finalReason, 'success');
  assert.equal(contractRepairs, 1);
  assert.equal(calls, 1);
  assert.equal(new StateManager().read(path.join(sessionDir, 'state.json')).recovery_required, false);
  assert.match(readRunnerLog(sessionDir), /resumed obsolete strategy-exhaustion stop through autonomous escalation/);
  const strategies = readRecoveryStrategyEpochs(sessionDir);
  assert.equal(strategies.length, 4);
  assert.equal(strategies[3].handler, 'repair_contract');
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

test('mux-runner CLI treats terminal recovery blocks as failures and dependency wakeups as nonterminal', () => {
  assert.equal(muxRunnerExitFailed('recovery_exhausted'), true);
  assert.equal(muxRunnerExitFailed('recovery_required'), true);
  assert.equal(muxRunnerExitFailed('dependency_repair_scheduled'), false);
  assert.equal(muxRunnerExitFailed('autonomous_budget_rollover'), false);
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
  let repairs = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      repairTicketVerificationContract: async () => {
        repairs += 1;
        return [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }];
      },
      runTicket: async () => {
        calls += 1;
        return { status: 'done', applied: true };
      },
    },
  ));
  assert.equal(finalReason, 'success');
  assert.equal(calls, 1);
  assert.equal(repairs, 1);
  assert.match(readRunnerLog(sessionDir), /all tickets blocked; scheduled diagnose-and-select-material-repair-strategy/);
  assert.match(readRunnerLog(sessionDir), /executed diagnostic contract repair/);
});

test('mux-runner repairs a dependency-ready prerequisite when every ticket is blocked', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('blocked dependency graph repair task');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'dependent',
        title: 'Blocked dependent',
        description: 'Must not implement before its prerequisite.',
        acceptance_criteria: ['The prerequisite remains required.'],
        verification: ['node -e "process.exit(0)"'],
        allowed_paths: ['dependent.txt'],
        priority: 'P1',
        status: 'Blocked',
        depends_on: ['root'],
      },
      {
        id: 'root',
        title: 'Blocked prerequisite',
        description: 'Can be repaired without violating dependency order.',
        acceptance_criteria: ['Repair executes before implementation.'],
        verification: ['node -e "process.exit(0)"'],
        allowed_paths: ['root.txt'],
        priority: 'P1',
        status: 'Blocked',
      },
    ],
  });
  const repairs = [];
  const calls = [];

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      repairTicketVerificationContract: async (_dir, ticketId) => {
        repairs.push(ticketId);
        return [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(0)'] }];
      },
      runTicket: async (_dir, ticketId) => {
        calls.push(ticketId);
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ));

  assert.equal(finalReason, 'success', readRunnerLog(sessionDir));
  assert.deepEqual(repairs, ['root']);
  assert.deepEqual(calls, ['root']);
  assert.doesNotMatch(readRunnerLog(sessionDir), /no dependency-runnable ticket remains/);
  assert.match(readRunnerLog(sessionDir), /executed diagnostic contract repair for root/);
});

test('mux-runner production dependency worker repairs a cycle before implementation', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('cyclic dependency repair task');
  const binDir = makeTempRoot('dependency-repair-bin-');
  createFakeCodex(binDir);
  const fakeEnv = prependPath(binDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'a', title: 'Cycle A', description: 'Depends on B.',
        acceptance_criteria: ['Cycle is repaired before implementation.'],
        verification: ['node -e "process.exit(0)"'], allowed_paths: ['a.txt'],
        priority: 'P1', status: 'Todo', depends_on: ['b'], custom_contract: { owner: 'alpha' },
      },
      {
        id: 'b', title: 'Cycle B', description: 'Depends on A.',
        acceptance_criteria: ['A completes first after repair.'],
        verification: ['node -e "process.exit(0)"'], allowed_paths: ['b.txt'],
        priority: 'P1', status: 'Todo', depends_on: ['a'],
      },
    ],
  });
  const originalA = readManifest(sessionDir).tickets.find((ticket) => ticket.id === 'a');
  const calls = [];
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async (_dir, ticketId) => {
        calls.push(ticketId);
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ), { PATH: fakeEnv.PATH, PICKLE_TEST_MODE: '1' });

  assert.equal(finalReason, 'success', readRunnerLog(sessionDir));
  assert.deepEqual(calls, ['a', 'b']);
  const strategies = readRecoveryStrategyEpochs(sessionDir).filter((epoch) => epoch.ticketId === 'a');
  assert.equal(strategies.length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  const repairedA = persisted.tickets.find((ticket) => ticket.id === 'a');
  assert.deepEqual(repairedA.depends_on, []);
  assert.equal(repairedA.description, originalA.description);
  assert.deepEqual(repairedA.acceptance_criteria, originalA.acceptance_criteria);
  assert.deepEqual(repairedA.verification, originalA.verification);
  assert.deepEqual(repairedA.allowed_paths, originalA.allowed_paths);
  assert.deepEqual(repairedA.custom_contract, originalA.custom_contract);
  const transactionLedger = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-transaction-ledger.json'), 'utf8'));
  assert.equal(transactionLedger.active, null);
  assert.equal(transactionLedger.history.at(-1).status, 'committed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-current.json')), true);
});

test('mux-runner repairs a missing dependency before implementation dispatch', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('missing dependency repair task');
  const binDir = makeTempRoot('dependency-repair-bin-');
  createFakeCodex(binDir);
  const fakeEnv = prependPath(binDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'orphan', title: 'Orphan ticket', description: 'References a missing prerequisite.',
      acceptance_criteria: ['Missing dependency is repaired before implementation.'],
      verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'],
      priority: 'P1', status: 'Todo', depends_on: ['missing'],
    }],
  });
  const events = [];

  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async (_dir, ticketId) => {
        events.push(ticketId);
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ), { PATH: fakeEnv.PATH, PICKLE_TEST_MODE: '1' });

  assert.equal(finalReason, 'success', readRunnerLog(sessionDir));
  assert.deepEqual(events, ['orphan']);
  assert.deepEqual(readManifest(sessionDir).tickets[0].depends_on, []);
  assert.doesNotMatch(readRunnerLog(sessionDir), /no dependency-runnable ticket remains/);
});

test('mixed runnable and cyclic work completes independent work before production graph repair', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('mixed dependency graph task');
  const binDir = makeTempRoot('dependency-mixed-bin-');
  createFakeCodex(binDir);
  const fakeEnv = prependPath(binDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      { id: 'independent', title: 'Independent', status: 'Todo', depends_on: [], acceptance_criteria: ['Independent runs.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['independent.txt'] },
      { id: 'a', title: 'A', status: 'Todo', depends_on: ['b'], acceptance_criteria: ['A runs.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['a.txt'] },
      { id: 'b', title: 'B', status: 'Todo', depends_on: ['a'], acceptance_criteria: ['B runs.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['b.txt'] },
    ],
  });
  const calls = [];
  const reason = await withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
    runTicket: async (dir, ticketId) => {
      calls.push(ticketId);
      updateTicketStatus(dir, ticketId, { status: 'Done' });
      return { status: 'done', applied: true };
    },
  }), { PATH: fakeEnv.PATH, PICKLE_TEST_MODE: '1' });
  assert.equal(reason, 'success', readRunnerLog(sessionDir));
  assert.deepEqual(calls, ['independent', 'a', 'b']);
  assert.doesNotMatch(readRunnerLog(sessionDir), /no dependency-runnable ticket remains/);
});

test('malformed dependency field shapes route through production graph repair before dispatch', async () => {
  for (const [label, malformed] of [['object', { ticket_id: 'root' }], ['number', 7], ['mixed-array', ['root', 7]]]) {
    const { dataRoot, sessionDir } = createSessionWithTodoTicket(`malformed ${label} dependency`);
    const binDir = makeTempRoot(`dependency-malformed-${label}-`);
    createFakeCodex(binDir);
    const fakeEnv = prependPath(binDir);
    writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
      tickets: [{ id: 'root', title: 'Root', status: 'Todo', depends_on: malformed, acceptance_criteria: ['Root runs after repair.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['root.txt'] }],
    });
    const calls = [];
    const reason = await withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
      runTicket: async (dir, ticketId) => {
        calls.push(ticketId);
        updateTicketStatus(dir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    }), { PATH: fakeEnv.PATH, PICKLE_TEST_MODE: '1' });
    assert.equal(reason, 'success', `${label}: ${readRunnerLog(sessionDir)}`);
    assert.deepEqual(calls, ['root'], label);
    assert.deepEqual(readManifest(sessionDir).tickets[0].depends_on, [], label);
  }
});

test('malicious dependency drift quarantines session mutation without rolling back concurrent user git work', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('concurrent dependency repair');
  const workingDir = String(new StateManager().read(path.join(sessionDir, 'state.json')).working_dir);
  const trackedFile = path.join(workingDir, 'tracked.txt');
  const stagedFile = path.join(workingDir, 'staged.txt');
  const committedFile = path.join(workingDir, 'committed.txt');
  const untrackedFile = path.join(workingDir, 'user-untracked.txt');
  fs.writeFileSync(trackedFile, 'original tracked\n');
  fs.writeFileSync(stagedFile, 'original staged\n');
  fs.writeFileSync(committedFile, 'original committed\n');
  execFileSync('git', ['init', '-q'], { cwd: workingDir });
  execFileSync('git', ['add', 'tracked.txt', 'staged.txt', 'committed.txt'], { cwd: workingDir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'], { cwd: workingDir });
  const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      { id: 'orphan', title: 'Orphan', status: 'Todo', depends_on: ['missing'], acceptance_criteria: ['Repair safely.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'] },
      { id: 'independent', title: 'Independent', status: 'Done', depends_on: [], acceptance_criteria: ['Stay complete.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['independent.txt'], completion_commit: 'abc123' },
    ],
  });
  const binDir = makeTempRoot('dependency-malicious-bin-');
  const readyPath = path.join(binDir, 'ready');
  const continuePath = path.join(binDir, 'continue');
  writeExecutable(path.join(binDir, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
const value = (prefix) => prompt.split('\\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
const graph = JSON.parse(value('Current ticket graph JSON: '));
const target = value('Target ticket ID: ');
fs.writeFileSync(process.env.CONCURRENT_READY, 'ready');
while (!fs.existsSync(process.env.CONCURRENT_CONTINUE)) await new Promise((resolve) => setTimeout(resolve, 10));
const manifest = JSON.parse(fs.readFileSync(process.env.MALICIOUS_MANIFEST, 'utf8'));
manifest.tickets.find((ticket) => ticket.id === 'independent').status = 'Todo';
fs.writeFileSync(process.env.MALICIOUS_MANIFEST, JSON.stringify(manifest, null, 2));
fs.writeFileSync(value('Dependency repair artifact path: '), JSON.stringify({ schema_version: 1, target_ticket_id: target, manifest_sha256: value('Authoritative manifest SHA-256: '), prd_seal_sha256: value('Authoritative PRD seal SHA-256: '), tickets: graph.map((ticket) => ticket.ticket_id === target ? { ...ticket, depends_on: [] } : ticket), rationale: 'valid artifact plus forbidden drift' }));
console.log('<promise>DEPENDENCY_REPAIR_COMPLETE</promise>');
`);
  const run = withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
    runTicket: async () => { throw new Error('implementation must not run'); },
  }), {
    ...prependPath(binDir), CONCURRENT_READY: readyPath, CONCURRENT_CONTINUE: continuePath,
    MALICIOUS_MANIFEST: path.join(sessionDir, 'refinement_manifest.json'),
  });
  while (!fs.existsSync(readyPath)) await new Promise((resolve) => setTimeout(resolve, 10));
  execFileSync('git', ['switch', '-qc', 'user/concurrent-work'], { cwd: workingDir });
  fs.writeFileSync(committedFile, 'user committed\n');
  execFileSync('git', ['add', 'committed.txt'], { cwd: workingDir });
  execFileSync('git', ['-c', 'user.name=User', '-c', 'user.email=user@example.invalid', 'commit', '-qm', 'user commit'], { cwd: workingDir });
  const concurrentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim();
  fs.writeFileSync(trackedFile, 'user tracked\n');
  fs.writeFileSync(stagedFile, 'user staged\n');
  execFileSync('git', ['add', 'staged.txt'], { cwd: workingDir });
  fs.writeFileSync(untrackedFile, 'user untracked\n');
  fs.writeFileSync(continuePath, 'continue');
  const reason = await run;
  assert.equal(reason, 'dependency_repair_scheduled');
  assert.notEqual(concurrentHead, originalHead);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf8' }).trim(), concurrentHead);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: workingDir, encoding: 'utf8' }).trim(), 'user/concurrent-work');
  assert.equal(fs.readFileSync(trackedFile, 'utf8'), 'user tracked\n');
  assert.equal(fs.readFileSync(stagedFile, 'utf8'), 'user staged\n');
  assert.equal(fs.readFileSync(untrackedFile, 'utf8'), 'user untracked\n');
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' });
  assert.match(status, / M tracked\.txt/);
  assert.match(status, /M  staged\.txt/);
  assert.match(status, /\?\? user-untracked\.txt/);
  assert.match(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'), /"status": "Todo"/);
  const quarantine = JSON.parse(fs.readFileSync(path.join(sessionDir, 'dependency-repair-quarantine.json'), 'utf8'));
  assert.equal(quarantine.repository.attribution, 'ambiguous-preserved');
  assert.equal(quarantine.repository.recovery, 'none');
  assert.equal(quarantine.repository.after.head, concurrentHead);
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-current.json')), false);
});

test('invalid dependency artifact yields one durable nonterminal attempt per invocation', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('invalid dependency artifact');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: [{ id: 'orphan', title: 'Orphan', status: 'Todo', depends_on: ['missing'], acceptance_criteria: ['Repair.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'] }] });
  const binDir = makeTempRoot('dependency-invalid-artifact-bin-');
  const invocationLog = path.join(binDir, 'invocations.log');
  writeExecutable(path.join(binDir, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
const value = (prefix) => prompt.split('\\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
const graph = JSON.parse(value('Current ticket graph JSON: '));
const target = value('Target ticket ID: ');
fs.appendFileSync(process.env.INVALID_ARTIFACT_INVOCATIONS, '1\\n');
fs.writeFileSync(value('Dependency repair artifact path: '), JSON.stringify({ schema_version: 1, target_ticket_id: target, manifest_sha256: value('Authoritative manifest SHA-256: '), prd_seal_sha256: value('Authoritative PRD seal SHA-256: '), tickets: graph.map((ticket) => ticket.ticket_id === target ? { ...ticket, depends_on: [] } : ticket), rationale: 'invalid extra field', extra: true }));
console.log('<promise>DEPENDENCY_REPAIR_COMPLETE</promise>');
`);
  const runOnce = () => withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
    runTicket: async () => { throw new Error('implementation must not run'); },
  }), { ...prependPath(binDir), INVALID_ARTIFACT_INVOCATIONS: invocationLog });
  assert.equal(await runOnce(), 'dependency_repair_scheduled');
  assert.equal(fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length, 1);
  assert.equal(await runOnce(), 'dependency_repair_scheduled');
  assert.equal(fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length, 2);
  const strategies = readRecoveryStrategyEpochs(sessionDir).filter((epoch) => epoch.ticketId === 'orphan');
  assert.equal(new Set(strategies.map((epoch) => epoch.strategyHash)).size, 2);
  assert.ok(new StateManager().read(path.join(sessionDir, 'state.json')).history.filter((event) => event.step === 'dependency_repair_wakeup_persisted').length >= 2);
});

test('exhausted dependency recovery still performs one bounded worker attempt before durable wakeup', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('dependency threshold wakeup');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), { tickets: [{ id: 'orphan', title: 'Orphan', status: 'Todo', depends_on: ['missing'], acceptance_criteria: ['Repair.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'] }] });
  const identity = buildTicketRecoveryFailureIdentity({ failureKind: 'worker_failure', message: 'dependency repair failed' });
  for (let index = 0; index < 25; index += 1) {
    recordTicketRecoveryFailure({ sessionDir, ticketId: 'orphan', failureKind: 'worker_failure', identity });
  }
  writeJson(path.join(sessionDir, 'circuit_breaker.json'), { state: 'OPEN' });
  let repairs = 0;
  const reason = await withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
    repairTicketDependencyContract: async () => {
      repairs += 1;
      throw new Error('still invalid after bounded attempt');
    },
    runTicket: async () => { throw new Error('implementation must not run'); },
  }));
  assert.equal(reason, 'dependency_repair_scheduled');
  assert.equal(repairs, 1);
});

test('hostile dependency artifact capture stays bounded without overwriting corrupt authoritative state', async () => {
  for (const artifactMode of ['symlink', 'oversize']) {
    const { dataRoot, sessionDir } = createSessionWithTodoTicket(`dependency ${artifactMode} fence`);
    writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
      tickets: [
        { id: 'orphan', title: 'Orphan', status: 'Todo', depends_on: ['missing'], acceptance_criteria: ['Repair safely.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'] },
        { id: 'independent', title: 'Independent', status: 'Done', depends_on: [], acceptance_criteria: ['Stay complete.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['independent.txt'], completion_commit: 'checkpoint' },
      ],
    });
    const binDir = makeTempRoot(`dependency-${artifactMode}-bin-`);
    writeExecutable(path.join(binDir, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const prompt = fs.readFileSync(0, 'utf8');
const value = (prefix) => prompt.split('\\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
// Let the parent persist child ownership and complete one healthy cancellation
// poll before corrupting the authoritative state.
await new Promise((resolve) => setTimeout(resolve, 150));
fs.writeFileSync(process.env.HOSTILE_MANIFEST, '{"poisoned":true}');
fs.writeFileSync(process.env.HOSTILE_STATE, '{');
const artifact = value('Dependency repair artifact path: ');
if (process.env.HOSTILE_MODE === 'symlink') fs.symlinkSync(path.dirname(artifact), artifact);
else { const fd = fs.openSync(artifact, 'w'); fs.ftruncateSync(fd, 2 * 1024 * 1024); fs.closeSync(fd); }
// Stay alive until the cancellation poll observes the corrupt authoritative
// state. This makes the timer/error race deterministic.
setInterval(() => {}, 1000);
`);
    await assert.rejects(() => withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
        runTicket: async () => { throw new Error('implementation must not run'); },
      }), {
        ...prependPath(binDir), HOSTILE_MODE: artifactMode,
        HOSTILE_MANIFEST: path.join(sessionDir, 'refinement_manifest.json'),
        HOSTILE_STATE: path.join(sessionDir, 'state.json'),
      }), (error) => error instanceof DependencyRepairIsolationError
        && error.code === 'DEPENDENCY_REPAIR_ISOLATED'
        && error.drift.includes('state.json'), artifactMode);
    assert.equal(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'), '{', artifactMode);
    assert.match(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'), /poisoned/, artifactMode);
    const quarantine = JSON.parse(fs.readFileSync(path.join(sessionDir, 'dependency-repair-quarantine.json'), 'utf8'));
    assert.equal(quarantine.reason, 'dependency-repair-unattributed-authoritative-drift', artifactMode);
    assert.ok(quarantine.drift.includes('state.json'), artifactMode);
    assert.equal(quarantine.candidate_artifact.kind, artifactMode === 'symlink' ? 'unsafe-file' : 'oversize');
    assert.deepEqual(quarantine.authoritative_drift['state.json'], {
      kind: 'content', size: 1, content_base64: Buffer.from('{').toString('base64'),
    }, artifactMode);
    assert.match(quarantine.cleanup_failure, /State file must contain a JSON object/);
    assert.match(quarantine.monitor_error, /Codex cancellation check failed.*State file must contain a JSON object/, `${artifactMode}: ${quarantine.worker_error}`);
  }
});

test('cancellation during malicious dependency drift remains terminal and emits no repair wakeup', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('dependency cancellation fence');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      { id: 'orphan', title: 'Orphan', status: 'Todo', depends_on: ['missing'], acceptance_criteria: ['Repair safely.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'] },
      { id: 'independent', title: 'Independent', status: 'Done', depends_on: [], acceptance_criteria: ['Stay complete.'], verification: ['node -e "process.exit(0)"'], allowed_paths: ['independent.txt'], completion_commit: 'cancel-checkpoint' },
    ],
  });
  const statePath = path.join(sessionDir, 'state.json');
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  writeJson(logicalPath, { lease: { token: 'live-before-cancel' } });
  const binDir = makeTempRoot('dependency-cancel-bin-');
  const readyPath = path.join(binDir, 'ready');
  writeExecutable(path.join(binDir, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.CANCEL_MANIFEST, '{"poisoned":true}');
fs.writeFileSync(process.env.CANCEL_READY, 'ready');
await new Promise(() => {});
`);
  const run = withDataRoot(dataRoot, () => runSequential(sessionDir, { onFailure: 'retry', runnerMode: 'pickle' }, {
    runTicket: async () => { throw new Error('implementation must not run'); },
  }), {
    ...prependPath(binDir), CANCEL_READY: readyPath,
    CANCEL_MANIFEST: path.join(sessionDir, 'refinement_manifest.json'),
  });
  while (!fs.existsSync(readyPath)) await new Promise((resolve) => setTimeout(resolve, 10));
  new StateManager().update(statePath, (state) => {
    state.active = false;
    state.last_exit_reason = 'cancelled';
    state.cancel_requested_at = new Date().toISOString();
    return state;
  });
  writeJson(logicalPath, { lease: null, release_marker: 'concurrent-cancel' });

  assert.equal(await run, 'cancelled');
  const state = new StateManager().read(statePath);
  assert.equal(state.active, false);
  assert.equal(state.last_exit_reason, 'cancelled');
  assert.ok(state.cancel_requested_at);
  assert.equal(state.history.filter((event) => event.step === 'dependency_repair_wakeup_persisted').length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(logicalPath, 'utf8')), { lease: null, release_marker: 'concurrent-cancel' });
  assert.match(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'), /poisoned/);
  assert.equal(fs.existsSync(path.join(sessionDir, 'dependency-repair-quarantine.json')), true);
  assert.equal(fs.existsSync(path.join(sessionDir, '.session-operation.lock')), false);
});

test('unresolved dependency repair persists one nonterminal wakeup and resumes with a novel production strategy', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('dependency wakeup restart task');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'orphan', title: 'Orphan', description: 'Missing dependency.',
      acceptance_criteria: ['The dependency repair is durable.'],
      verification: ['node -e "process.exit(0)"'], allowed_paths: ['orphan.txt'],
      priority: 'P1', status: 'Todo', depends_on: ['missing'],
    }],
  });
  let implementations = 0;
  const firstReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      repairTicketDependencyContract: async () => [],
      runTicket: async () => { implementations += 1; return { status: 'done', applied: true }; },
    },
  ));
  assert.equal(firstReason, 'dependency_repair_scheduled');
  assert.equal(muxRunnerExitFailed(firstReason), false);
  assert.equal(implementations, 0);
  assert.ok(new StateManager().read(path.join(sessionDir, 'state.json')).history
    .some((event) => event.step === 'dependency_repair_wakeup_persisted'));

  const binDir = makeTempRoot('dependency-repair-bin-');
  createFakeCodex(binDir);
  const fakeEnv = prependPath(binDir);
  const secondReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async (_dir, ticketId) => {
        implementations += 1;
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ), { PATH: fakeEnv.PATH, PICKLE_TEST_MODE: '1' });
  assert.equal(secondReason, 'success');
  assert.equal(implementations, 1);
  const strategies = readRecoveryStrategyEpochs(sessionDir).filter((epoch) => epoch.ticketId === 'orphan');
  assert.equal(strategies.length, 2);
  assert.equal(new Set(strategies.map((epoch) => epoch.strategyHash)).size, 2);
});

test('mux-runner records verification command failures as typed verification recovery', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('typed verification failure task');
  let calls = 0;
  const finalReason = await withDataRoot(dataRoot, () => runSequential(
    sessionDir,
    { onFailure: 'retry', runnerMode: 'pickle' },
    {
      runTicket: async (_dir, ticketId, options) => {
        calls += 1;
        if (calls === 1) {
          throw new VerificationCommandError({
            command: 'node --test', stdout: '', stderr: 'assertion failed', exitCode: 1, failures: [],
          });
        }
        assert.match(options.recoveryStrategy.materialApproach, /obligation|verification|diagnostic|fixture/);
        updateTicketStatus(sessionDir, ticketId, { status: 'Done' });
        return { status: 'done', applied: true };
      },
    },
  ));
  assert.equal(finalReason, 'success', readRunnerLog(sessionDir));
  const history = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ticket-recovery-history.json'), 'utf8'));
  assert.equal(history.events[0].failure_kind, 'verification_failed');
  assert.equal(history.events[0].failure_domain, 'verification');
  assert.notEqual(history.events[0].failure_kind, 'worker_failure');
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

test('mux-runner preserves terminal cancellation regardless of its timestamp', async () => {
  const { dataRoot, sessionDir } = createSessionWithTodoTicket('startup cancellation task');
  const statePath = path.join(sessionDir, 'state.json');
  const runStartedAtMs = Date.now();
  new StateManager().update(statePath, (state) => {
    state.active = false;
    state.last_exit_reason = 'cancelled';
    state.cancel_requested_at = new Date(runStartedAtMs - 60_000).toISOString();
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
