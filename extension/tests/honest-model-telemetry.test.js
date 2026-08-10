// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CodexCancelCheckError, runCodexExecMonitored } from '../services/codex.js';
import {
  executionTelemetrySummary,
  reconcileInterruptedModelCallTelemetry,
  recordExecutionControlTelemetry,
  reserveModelCallTelemetry,
} from '../services/productive-autonomy.js';
import { inspectProcessLivenessIdentity } from '../services/orphan-reaper.js';
import { fileURLToPath } from 'node:url';
import { makeTempRoot, repoRoot } from './helpers.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fakeCodex(runtimeDir) {
  const executable = path.join(runtimeDir, 'codex-telemetry');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const usage = JSON.stringify({ usage: { input_tokens: 11, cache_creation_input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 3 } });
fs.writeSync(1, usage + '\\n');
if (process.env.FAKE_OUTCOME === 'failed') process.exit(7);
if (process.env.FAKE_OUTCOME === 'wait') {
  if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, 'ready');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

function assertExactDrain(result) {
  assert.equal(result.drainAttested, true);
  const identities = [
    result.processIdentities.broker,
    result.processIdentities.target,
    ...result.processIdentities.descendants,
  ].filter(Boolean);
  assert.ok(identities.length >= 2);
  for (const identity of identities) {
    assert.equal(inspectProcessLivenessIdentity(identity), 'not-running');
  }
}

async function invoke(sessionDir, command, outcome, phase, options = {}) {
  return await runCodexExecMonitored({
    command,
    prompt: phase,
    // This suite validates telemetry classification, not broker startup latency.
    // Keep the non-timeout cases outside the deadline under parallel suite load.
    timeoutMs: options.timeoutMs ?? 15_000,
    env: { FAKE_OUTCOME: outcome, ...(options.env || {}) },
    cancelCheck: options.cancelCheck,
    telemetry: { sessionDir, ticketId: 'T1', phase, ticketAttempt: 2, phaseAttempt: 1, recoveryEpoch: 1 },
  });
}

test('successful, failed, timed-out, and cancelled model calls retain actual usage and duration', async () => {
  const sessionDir = makeTempRoot('pickle-honest-telemetry-');
  const command = fakeCodex(makeTempRoot('pickle-honest-codex-'));
  const success = await invoke(sessionDir, command, 'success', 'research');
  const failed = await invoke(sessionDir, command, 'failed', 'plan');
  const timeoutMarker = path.join(sessionDir, 'timeout-ready');
  const timedOut = await invoke(sessionDir, command, 'wait', 'implement', {
    timeoutMs: 500,
    env: { FAKE_MARKER: timeoutMarker },
  });
  const cancelMarker = path.join(sessionDir, 'cancel-ready');
  const cancelled = await invoke(sessionDir, command, 'wait', 'review', {
    env: { FAKE_MARKER: cancelMarker },
    cancelCheck: () => fs.existsSync(cancelMarker),
  });

  assert.equal(success.exitCode, 0);
  assert.equal(success.timedOut, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.timedOut, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(fs.readFileSync(timeoutMarker, 'utf8'), 'ready');
  assert.ok(timedOut.durationMs >= 500);
  assertExactDrain(timedOut);
  assert.equal(cancelled.cancelled, true);
  for (const result of [success, failed, timedOut, cancelled]) {
    assert.equal(result.usageReported, true);
    assert.deepEqual(result.usage, {
      input_tokens: 11,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 2,
      output_tokens: 3,
    });
    assert.ok(result.durationMs > 0);
  }

  const summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.successfulCalls, 1);
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.timedOutCalls, 1);
  assert.equal(summary.cancelledCalls, 1);
  assert.equal(summary.inputTokens, 44);
  assert.equal(summary.cachedInputTokens, 8);
  assert.equal(summary.cacheCreationInputTokens, 16);
  assert.equal(summary.outputTokens, 12);
  assert.equal(summary.durationMs, success.durationMs + failed.durationMs + timedOut.durationMs + cancelled.durationMs);
  const events = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8')).events;
  assert.deepEqual(events.map((event) => event.model_attempt_id), [1, 2, 3, 4]);
  assert.deepEqual(events.map((event) => event.ticket_attempt), [2, 2, 2, 2]);
  assert.deepEqual(events.map((event) => event.phase_attempt), [1, 1, 1, 1]);
});

test('a true no-usage timeout persists unavailable telemetry without fabricated zero tokens', async () => {
  const sessionDir = makeTempRoot('pickle-no-usage-timeout-');
  const executable = path.join(makeTempRoot('pickle-no-usage-timeout-bin-'), 'codex');
  const startMarker = path.join(sessionDir, 'started');
  fs.writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FAKE_MARKER, 'ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  const result = await runCodexExecMonitored({
    command: executable,
    prompt: 'no usage timeout',
    timeoutMs: 8_000,
    env: { FAKE_MARKER: startMarker },
    telemetry: { sessionDir, ticketId: 'T1', phase: 'no_usage_timeout' },
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(fs.readFileSync(startMarker, 'utf8'), 'ready');
  assert.equal(result.usageReported, false);
  assert.deepEqual(result.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.ok(result.durationMs >= 8_000);
  assertExactDrain(result);
  const event = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8')).events[0];
  assert.equal(event.outcome, 'timed_out');
  assert.equal(event.telemetry_status, 'telemetry_unavailable');
  assert.equal(event.telemetry_failure, 'call_ended_without_usage');
  assert.equal(event.input_tokens, null);
  assert.equal(event.cached_input_tokens, null);
  assert.equal(event.cache_creation_input_tokens, null);
  assert.equal(event.output_tokens, null);
});

test('cancel-check failure retains parsed usage and duration in failed telemetry', async () => {
  const sessionDir = makeTempRoot('pickle-cancel-check-telemetry-');
  const runtimeDir = makeTempRoot('pickle-cancel-check-bin-');
  const executable = path.join(runtimeDir, 'codex');
  const marker = path.join(sessionDir, 'usage-written');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeSync(1, JSON.stringify({ usage: {
  input_tokens: 23,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 7,
  output_tokens: 11,
} }) + '\\n');
fs.writeFileSync(process.env.FAKE_MARKER, 'ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const cause = new Error('cancellation state unreadable');
  let failure;
  try {
    await runCodexExecMonitored({
      command: executable,
      prompt: 'cancel check failure',
      timeoutMs: 2_000,
      env: { FAKE_MARKER: marker },
      cancelCheck: () => {
        if (!fs.existsSync(marker)) return false;
        throw cause;
      },
      telemetry: { sessionDir, ticketId: 'T1', phase: 'cancel_check_failure' },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof CodexCancelCheckError);
  assert.equal(failure.cause, cause);
  assert.ok(failure.result);
  assert.equal(failure.result.usageReported, true);
  assert.deepEqual(failure.result.usage, {
    input_tokens: 23,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 7,
    output_tokens: 11,
  });
  assert.ok(failure.result.durationMs >= 100);
  assert.equal(failure.result.timedOut, false);

  const event = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8')).events[0];
  assert.equal(event.outcome, 'failed');
  assert.equal(event.telemetry_status, 'reported');
  assert.equal(event.telemetry_failure, null);
  assert.equal(event.duration_ms, failure.result.durationMs);
  assert.equal(event.input_tokens, 23);
  assert.equal(event.cache_creation_input_tokens, 5);
  assert.equal(event.cached_input_tokens, 7);
  assert.equal(event.output_tokens, 11);
});

test('cancel-check failure without usage remains typed and records unavailable telemetry', async () => {
  const sessionDir = makeTempRoot('pickle-cancel-check-no-usage-');
  const runtimeDir = makeTempRoot('pickle-cancel-check-no-usage-bin-');
  const executable = path.join(runtimeDir, 'codex');
  const marker = path.join(sessionDir, 'started');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_MARKER, 'ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const cause = new Error('cancellation state unavailable');
  let failure;
  try {
    await runCodexExecMonitored({
      command: executable,
      prompt: 'cancel check failure without usage',
      timeoutMs: 2_000,
      env: { FAKE_MARKER: marker },
      cancelCheck: () => {
        if (!fs.existsSync(marker)) return false;
        throw cause;
      },
      telemetry: { sessionDir, ticketId: 'T1', phase: 'cancel_check_no_usage' },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof CodexCancelCheckError);
  assert.equal(failure.cause, cause);
  assert.equal(failure.result.usageReported, false);
  const event = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8')).events[0];
  assert.equal(event.outcome, 'failed');
  assert.equal(event.telemetry_status, 'telemetry_unavailable');
  assert.equal(event.telemetry_failure, 'call_ended_without_usage');
  assert.equal(event.duration_ms, failure.result.durationMs);
  assert.equal(event.input_tokens, null);
  assert.equal(event.cached_input_tokens, null);
  assert.equal(event.cache_creation_input_tokens, null);
  assert.equal(event.output_tokens, null);
});

test('installed-runtime JSONL retains terminal usage and allocates durable Citadel ordinals across calls', async () => {
  const sessionDir = makeTempRoot('pickle-installed-codex-telemetry-');
  const runtimeDir = makeTempRoot('pickle-installed-codex-bin-');
  const executable = path.join(runtimeDir, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const lines = fs.readFileSync(process.env.INSTALLED_CODEX_FIXTURE, 'utf8').trim().split('\\n');
process.stdout.write(lines.slice(0, -1).join('\\n') + '\\n');
setTimeout(() => process.stdout.write(lines.at(-1) + '\\n'), 900);
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  const invokeInstalled = async () => await runCodexExecMonitored({
    command: executable,
    prompt: 'citadel',
    timeoutMs: 4_000,
    env: { INSTALLED_CODEX_FIXTURE: path.join(fixtures, 'codex-exec-installed-0.147.jsonl') },
    successCheck: ({ assistantContent }) => assistantContent.includes('CITADEL_COMPLETE'),
    telemetry: { sessionDir, ticketId: 'citadel', phase: 'citadel' },
  });

  const first = await invokeInstalled();
  const second = await invokeInstalled();
  for (const result of [first, second]) {
    assert.equal(result.usageReported, true);
    assert.deepEqual(result.usage, {
      input_tokens: 17861,
      output_tokens: 5,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 9984,
    });
  }
  const journal = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8'));
  assert.deepEqual(journal.events.map((event) => event.model_attempt_id), [1, 2]);
  assert.deepEqual(journal.events.map((event) => event.ticket_attempt), [1, 2]);
  assert.deepEqual(journal.events.map((event) => event.phase_attempt), [1, 2]);
  assert.deepEqual(journal.events.map((event) => event.input_tokens), [17861, 17861]);
  assert.deepEqual(journal.events.map((event) => event.telemetry_status), ['reported', 'reported']);
  assert.equal(journal.next_model_attempt_id, 3);
});

test('completed Codex call without usage persists typed telemetry unavailability instead of zero tokens', async () => {
  const sessionDir = makeTempRoot('pickle-unavailable-codex-telemetry-');
  const executable = path.join(makeTempRoot('pickle-unavailable-codex-bin-'), 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write([
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<promise>DONE</promise>' } }),
  JSON.stringify({ type: 'turn.completed' }),
].join('\\n'));
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  const result = await runCodexExecMonitored({
    command: executable,
    prompt: '',
    timeoutMs: 2_000,
    successCheck: ({ assistantContent }) => assistantContent.includes('<promise>DONE</promise>'),
    telemetry: { sessionDir, ticketId: 'citadel', phase: 'citadel' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.usageReported, false);
  const event = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8')).events[0];
  assert.equal(event.outcome, 'success');
  assert.equal(event.telemetry_status, 'telemetry_unavailable');
  assert.equal(event.telemetry_failure, 'completed_without_usage');
  assert.equal(event.input_tokens, null);
  assert.equal(event.cached_input_tokens, null);
  assert.equal(event.cache_creation_input_tokens, null);
  assert.equal(event.output_tokens, null);
});

test('control telemetry exposes checkpoint and post-seal binary scoring without inventing model calls', () => {
  const sessionDir = makeTempRoot('pickle-control-telemetry-');
  recordExecutionControlTelemetry(sessionDir, { checkpoints_reused: 4, checkpoints_invalidated: 2 });
  let summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.phaseAttempts, 0);
  assert.equal(summary.checkpointsReused, 4);
  assert.equal(summary.checkpointsInvalidated, 2);
  assert.equal(summary.autonomyScore, 1);
  assert.equal(summary.reliabilityScore, 1);

  recordExecutionControlTelemetry(sessionDir, { post_seal_human_interventions: 1, unexpected_terminal_exits: 1 });
  summary = executionTelemetrySummary(sessionDir);
  assert.equal(summary.autonomyScore, 0);
  assert.equal(summary.reliabilityScore, 0);
});

test('status exposes durable executor restarts, checkpoint counters, and zero-intervention scores', () => {
  const sessionDir = makeTempRoot('pickle-telemetry-status-');
  const projectDir = makeTempRoot('pickle-telemetry-project-');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 1, active: true, working_dir: projectDir, step: 'review', iteration: 3,
    max_iterations: 0, start_time_epoch: Math.floor(Date.now() / 1000), current_ticket: 'T1', history: [],
    session_dir: sessionDir, tmux_mode: false,
  }));
  fs.writeFileSync(path.join(sessionDir, 'refinement_manifest.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'Telemetry', status: 'Todo', verification: ['node --test'] }],
  }));
  fs.writeFileSync(path.join(sessionDir, 'logical-pipeline.json'), JSON.stringify({ executor_restart_count: 3 }));
  recordExecutionControlTelemetry(sessionDir, { checkpoints_reused: 4, checkpoints_invalidated: 1 });
  reserveModelCallTelemetry(sessionDir, { ticketId: 'T1', phase: 'review' });
  reconcileInterruptedModelCallTelemetry(sessionDir, {
    reason: 'supervised_executor_exit', sourceOwnerId: 'process:77', now: new Date(),
  });

  const output = execFileSync(process.execPath, [path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.match(output, /Executor Restarts: 3/);
  assert.match(output, /Checkpoints: reused 4 \| invalidated 1/);
  assert.match(output, /Phase Attempts: 1/);
  assert.match(output, /Work: productive 0 \| discarded 1/);
  assert.match(output, /Model Calls: success 0 \| failed 0 \| interrupted 1 \| timed out 0 \| cancelled 0/);
  assert.match(output, /Autonomy Score: 1 \| post-seal human interventions 0/);
  assert.match(output, /Reliability Score: 1 \| unexpected terminal exits 0/);
  assert.match(output, /Quality Score: 1 \| unexpected non-completion no/);
});
