// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCodexToolCalls,
  detectOutputFormat,
  extractAssistantContent,
  extractCodexUsage,
  inspectCodexUsage,
  observeCodexToolCallStream,
} from '../services/classifier-utils.js';
import { isAuthenticatedBrokerOnlyShutdownLedger, runCommand } from '../services/codex.js';
import { makeTempRoot } from './helpers.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realJsonl = fs.readFileSync(path.join(fixtures, 'codex-exec-real.jsonl'), 'utf8');
const codexBlock = fs.readFileSync(path.join(fixtures, 'codex-block.txt'), 'utf8');

test('detectOutputFormat discriminates real Codex JSONL, codex blocks, and prose', () => {
  assert.equal(detectOutputFormat(realJsonl), 'stream-json');
  assert.equal(detectOutputFormat(codexBlock), 'codex-block');
  assert.equal(detectOutputFormat('ordinary assistant prose'), 'plain-text');
});

test('real Codex exec JSONL extracts assistant text, usage, and command observations', () => {
  assert.match(extractAssistantContent(realJsonl), /Runtime validated/);
  assert.doesNotMatch(extractAssistantContent(realJsonl), /node .*setup/);
  assert.deepEqual(extractCodexUsage(realJsonl), {
    input_tokens: 120,
    output_tokens: 18,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40,
  });
  const calls = collectCodexToolCalls(realJsonl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].isSetupInvocation, true);
  assert.deepEqual(calls[0].argv.slice(0, 3), ['node', './bin/setup.js', '--resume']);
});

test('codex-block parsing keeps only codex content and observes serialized tool calls', () => {
  assert.equal(extractAssistantContent(codexBlock), 'Runtime validated from block output.\n<promise>WORKER_DONE</promise>');
  const toolLine = codexBlock.split('\n').find((line) => line.startsWith('{'));
  const observation = observeCodexToolCallStream(toolLine, 'codex-block');
  assert.equal(observation?.isSetupInvocation, true);
  assert.equal(observation?.command, 'node bin/setup.js --resume /tmp/session');
});

test('assistant extraction tolerates variant JSONL content blocks and fallback event shapes', () => {
  const completed = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', content: ['first', { text: 'second' }, null] } }),
    JSON.stringify({ type: 'assistant', message: { content: 'ignored fallback' } }),
  ].join('\n');
  assert.equal(extractAssistantContent(completed), 'first\nsecond');

  const fallback = [
    JSON.stringify({ type: 'assistant', message: { content: [{ text: 'assistant block' }] } }),
    JSON.stringify({ type: 'result', result: 'result block' }),
    JSON.stringify({ type: 'response.output_text.done', text: 'response block' }),
  ].join('\n');
  assert.equal(extractAssistantContent(fallback), 'assistant block\nresult block\nresponse block');

  assert.equal(extractAssistantContent('{"metadata":true}\n{"alsoMetadata":1}'), '');
});

test('tool-call observation tolerates malformed arguments and deduplicates equivalent calls', () => {
  const direct = observeCodexToolCallStream('node bin/setup.js --resume "/tmp/session path"', 'codex-block');
  assert.deepEqual(direct?.argv, ['node', 'bin/setup.js', '--resume', '/tmp/session path']);
  assert.equal(direct?.isSetupInvocation, true);

  const malformed = JSON.stringify({
    type: 'function_call',
    name: 'custom',
    arguments: '{not-json',
  });
  const parsed = observeCodexToolCallStream(malformed, 'stream-json');
  assert.equal(parsed?.arguments, '{not-json');
  assert.equal(parsed?.command, null);
  assert.equal(observeCodexToolCallStream('ordinary codex prose', 'codex-block'), null);

  const command = JSON.stringify({
    type: 'command_execution',
    command: 'node ./bin/setup.ts --resume',
    input: ['ignored-non-object'],
  });
  const calls = collectCodexToolCalls([command, command, malformed, '{bad-json'].join('\n'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].isSetupInvocation, true);
  assert.equal(calls[1].name, 'custom');
});

test('usage extraction accumulates direct and nested counters while ignoring non-object events', () => {
  const output = [
    JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 4, cached_input_tokens: 5 } }),
    JSON.stringify({ response: { usage: { input_tokens: 7, cache_read_input_tokens: 11 } } }),
    JSON.stringify({ result: { usage: { output_tokens: 13 } } }),
    JSON.stringify(['ignored']),
    'not-json',
  ].join('\n');
  assert.deepEqual(extractCodexUsage(output), {
    input_tokens: 9,
    output_tokens: 16,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 16,
  });
});

test('installed Codex 0.147 terminal usage recognizes cache-write tokens and completion', () => {
  const installed = fs.readFileSync(path.join(fixtures, 'codex-exec-installed-0.147.jsonl'), 'utf8');
  assert.deepEqual(inspectCodexUsage(installed), {
    usage: {
      input_tokens: 17861,
      output_tokens: 5,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 9984,
    },
    reported: true,
    turnCompleted: true,
  });
  assert.deepEqual(inspectCodexUsage('{"type":"turn.completed"}\n'), {
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    reported: false,
    turnCompleted: true,
  });
});

test('codex runner results and success checks expose classified events without replacing raw stdout', async () => {
  let observed = null;
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.CODEX_FIXTURE || "")'],
    env: { CODEX_FIXTURE: realJsonl },
    successCheck: (context) => {
      observed = context;
      return context.assistantContent.includes('WORKER_DONE');
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputFormat, 'stream-json');
  assert.match(result.stdout, /thread\.started/);
  assert.match(result.assistantContent, /WORKER_DONE/);
  assert.equal(result.toolCalls[0].isSetupInvocation, true);
  assert.equal(result.usage.cache_read_input_tokens, 40);
  assert.equal(observed?.outputFormat, 'stream-json');
});

test('codex runner treats EPIPE from a closed child stdin as a process outcome', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: [
      '-e',
      'require("node:fs").closeSync(0); setTimeout(() => process.exit(0), 50);',
    ],
    input: 'x'.repeat(8 * 1024 * 1024),
    timeoutMs: 2_000,
  });

  assert.equal(result.exitCode, 0, JSON.stringify({
    shutdownCause: result.shutdownCause,
    requestedTerminationCause: result.requestedTerminationCause,
    effectiveTerminationCause: result.effectiveTerminationCause,
    targetOutcome: result.targetOutcome,
  }));
  assert.equal(result.timedOut, false);
});

test('authenticated target exit supersedes a timeout callback that runs before delayed shutdown ack', async () => {
  const result = await runCommand({
    command: '/usr/bin/true',
    args: [],
    input: 'x'.repeat(8 * 1024 * 1024),
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_BROKER_ACK_DELAY_MS: '3000',
    },
    timeoutMs: 2_000,
  });

  assert.equal(result.exitCode, 0, JSON.stringify({
    shutdownCause: result.shutdownCause,
    requestedTerminationCause: result.requestedTerminationCause,
    effectiveTerminationCause: result.effectiveTerminationCause,
    targetOutcome: result.targetOutcome,
  }));
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'target-exit');
  assert.equal(result.requestedTerminationCause, 'timeout');
  assert.equal(result.effectiveTerminationCause, null);
  assert.deepEqual(result.targetOutcome, { code: 0, signal: null });
});

test('target stop attestation retries after one load-delayed indeterminate probe', async () => {
  const result = await runCommand({
    command: '/usr/bin/true',
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_TARGET_STOP_PROBE_FAILURES: '1',
      PICKLE_TEST_TARGET_STOP_PROBE_DELAY_MS: '2000',
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'target-exit');
  assert.ok(result.processIdentities.target, 'the stopped guardian was published after retry');
});

test('authenticated convergence progress prevents force-kill across cumulative slow observations', {
  // Deadlock guard only: injected work is 48s before real identity probes,
  // scheduler contention, acknowledgement delivery, and drain attestation.
  timeout: 120_000,
}, async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("CONVERGENCE_READY\\n"); setInterval(() => {}, 1000)'],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_DISABLE_DESCENDANT_TRACKER: '1',
      PICKLE_TEST_DESCENDANT_CONVERGENCE_DELAY_MS: '24000',
    },
    timeoutMs: 70_000,
    successSignalGraceMs: 0,
    successCheck: ({ stdout }) => stdout.includes('CONVERGENCE_READY'),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'success');
  assert.ok(result.durationMs > 45_000, 'material progress remains authoritative beyond any former hard total');
});

test('a broker wedged after initial convergence authority is still force-killed at the progress lease', {
  timeout: 15_000,
}, async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("WEDGE_READY\\n"); setInterval(() => {}, 1000)'],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_DISABLE_DESCENDANT_TRACKER: '1',
      PICKLE_TEST_DESCENDANT_CONVERGENCE_DELAY_MS: '3000',
      PICKLE_TEST_CONTROLLER_FORCE_KILL_TIMEOUT_MS: '500',
      PICKLE_TEST_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS: '1000',
    },
    timeoutMs: 10_000,
    successSignalGraceMs: 0,
    successCheck: ({ stdout }) => stdout.includes('WEDGE_READY'),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.drainAttested, false);
  assert.match(result.stderr, /shutdown_ack_observed.*false/);
  assert.match(result.stderr, /"attestation_observations":2/,
    'missing acknowledgement remains a failure after the mandatory second absence observation');
  assert.ok(result.durationMs < 8_000, 'silent convergence exceeded its bounded progress lease');
});

test('transient discovery exhaustion advances strategy epoch and later drains exactly', {
  timeout: 15_000,
}, async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("EPOCH_READY\\n"); setInterval(() => {}, 1000)'],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_DISABLE_DESCENDANT_TRACKER: '1',
      PICKLE_TEST_CONVERGENCE_EPOCH_MS: '200',
      PICKLE_TEST_DESCENDANT_DISCOVERY_FAILURES: '3',
      PICKLE_TEST_DESCENDANT_DISCOVERY_FAILURE_DELAY_MS: '100',
    },
    timeoutMs: 10_000,
    successSignalGraceMs: 0,
    successCheck: ({ stdout }) => stdout.includes('EPOCH_READY'),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'success');
});

test('foreign shutdown progress is inert while valid monotonic progress still drains', async () => {
  const result = await runCommand({
    command: '/usr/bin/true',
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_FORGED_SHUTDOWN_PROGRESS: '1',
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'target-exit');
});

test('authenticated A-B-A snapshot oscillation cannot renew the convergence lease', {
  timeout: 15_000,
}, async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("OSCILLATION_READY\\n"); setInterval(() => {}, 1000)'],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_OSCILLATING_SHUTDOWN_PROGRESS: '1',
      PICKLE_TEST_DESCENDANT_CONVERGENCE_DELAY_MS: '3000',
      PICKLE_TEST_CONVERGENCE_PROGRESS_STALL_TIMEOUT_MS: '1000',
    },
    timeoutMs: 10_000,
    successSignalGraceMs: 0,
    successCheck: ({ stdout }) => stdout.includes('OSCILLATION_READY'),
  });

  assert.equal(result.drainAttested, false);
  assert.match(result.stderr, /shutdown_ack_observed.*false/);
  assert.ok(result.durationMs < 8_000, 'oscillating semantic state renewed the progress lease');
});

test('post-ack watchdog reaps a broker wedged before consuming shutdown release', {
  timeout: 15_000,
}, async () => {
  const startedAt = Date.now();
  const result = await runCommand({
    command: '/usr/bin/true',
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_BROKER_WEDGE_AFTER_ACK_MS: '5000',
      PICKLE_TEST_CONTROLLER_FORCE_KILL_TIMEOUT_MS: '500',
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.drainAttested, true, result.stderr);
  assert.equal(result.shutdownCause, 'target-exit');
  assert.ok(Date.now() - startedAt < 4_000, 'post-ack broker wedge exceeded its release/drain watchdog');
});

test('prelaunch stop-attestation failure releases and drains the exact broker-only ledger', {
  timeout: 20_000,
}, async () => {
  const fixtureDir = makeTempRoot('pickle-prelaunch-stop-failure-');
  const targetMarker = path.join(fixtureDir, 'target-ran');
  let drainedTarget = undefined;
  let drainedDescendants = undefined;
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)}, 'ran')`],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_TARGET_STOP_PROBE_FAILURES: '9999',
    },
    timeoutMs: 10_000,
    onDrain: (_broker, target, descendants) => {
      drainedTarget = target;
      drainedDescendants = descendants;
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.drainAttested, true, result.stderr);
  assert.equal(result.shutdownCause, 'target-stop-attestation-failed');
  assert.equal(drainedTarget, null);
  assert.deepEqual(drainedDescendants, []);
  assert.equal(fs.existsSync(targetMarker), false, 'an unattested guardian was never released');
  assert.doesNotMatch(result.stderr, /controller-release-timeout|malformed or conflicted/);
});

test('broker-only shutdown attestation rejects a null target with descendants', () => {
  assert.equal(isAuthenticatedBrokerOnlyShutdownLedger(
    false, null, null, [], 'target-stop-attestation-failed',
  ), true);
  assert.equal(isAuthenticatedBrokerOnlyShutdownLedger(
    false, null, null, [{ pid: 42 }], 'target-stop-attestation-failed',
  ), false);
  assert.equal(isAuthenticatedBrokerOnlyShutdownLedger(
    true, null, null, [], 'target-stop-attestation-failed',
  ), false);
  assert.equal(isAuthenticatedBrokerOnlyShutdownLedger(
    false, null, { pid: 42 }, [], 'target-stop-attestation-failed',
  ), false);
});

test('broker-only shutdown attestation rejects target-shaped and success causes', () => {
  for (const cause of ['success', 'target-exit', 'target-SIGTERM', 'timeout', 'cancel']) {
    assert.equal(isAuthenticatedBrokerOnlyShutdownLedger(false, null, null, [], cause), false, cause);
  }
});

test('a conflicting duplicate cannot replace an authenticated broker-only shutdown ack', {
  timeout: 20_000,
}, async () => {
  const result = await runCommand({
    command: '/usr/bin/true',
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_TARGET_STOP_PROBE_FAILURES: '9999',
      PICKLE_TEST_BROKER_CONFLICTING_SHUTDOWN_ACK: '1',
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.drainAttested, false);
  assert.equal(result.shutdownCause, 'target-stop-attestation-failed');
  assert.match(result.stderr, /conflicting shutdown attestation/);
});

test('explicit cancellation remains terminal when a prior target-exit ack is delayed', async () => {
  const fixtureDir = makeTempRoot('pickle-prior-target-exit-');
  const targetExitMarker = path.join(fixtureDir, 'target-exiting');
  let targetMarkerObservedAt = 0;
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetExitMarker)}, 'exiting')`],
    env: {
      PICKLE_TEST_MODE: '1',
      PICKLE_TEST_BROKER_ACK_DELAY_MS: '3000',
    },
    timeoutMs: 10_000,
    cancelCheck: () => {
      if (!fs.existsSync(targetExitMarker)) return false;
      if (!targetMarkerObservedAt) targetMarkerObservedAt = Date.now();
      return Date.now() - targetMarkerObservedAt >= 1_000;
    },
  });

  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.drainAttested, true);
  assert.equal(result.shutdownCause, 'target-exit');
  assert.equal(result.requestedTerminationCause, 'cancel');
  assert.equal(result.effectiveTerminationCause, 'cancel');
  assert.deepEqual(result.targetOutcome, { code: 0, signal: null });
});

test('codex runner terminates the spawned process when ownership persistence rejects onSpawn', async () => {
  let childPid = 0;
  await assert.rejects(
    () => runCommand({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 10_000,
      onSpawn: (child) => {
        childPid = Number(child.pid);
        throw new Error('ownership persistence failed');
      },
    }),
    /ownership persistence failed/,
  );
  assert.ok(childPid > 0);
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `child ${childPid} survived rejected ownership persistence`);
});

test('codex runner never releases a target when immutable broker identity capture fails', async () => {
  const fixtureDir = makeTempRoot('pickle-broker-capture-failure-');
  const targetMarker = path.join(fixtureDir, 'target-started');
  const statePath = path.join(fixtureDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active_child_pid: null, active_child_identity: null }));
  let brokerPid = 0;
  let publicationCalled = false;
  await assert.rejects(
    () => runCommand({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)}, 'started')`],
      timeoutMs: 10_000,
      captureSpawnedIdentity: (pid) => {
        brokerPid = pid;
        return null;
      },
      onSpawn: (_child, identity) => {
        publicationCalled = true;
        fs.writeFileSync(statePath, JSON.stringify({ active_child_pid: identity.pid, active_child_identity: identity }));
      },
    }),
    /Could not capture immutable monitored process broker identity/,
  );
  assert.equal(publicationCalled, false);
  assert.equal(fs.existsSync(targetMarker), false, 'target started without an immutable broker identity');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    active_child_pid: null, active_child_identity: null,
  });
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(brokerPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `unregistered broker ${brokerPid} survived capture failure`);
});
