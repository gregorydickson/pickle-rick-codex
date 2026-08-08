// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored } from '../services/codex.js';
import {
  executionTelemetrySummary,
  recordExecutionControlTelemetry,
} from '../services/productive-autonomy.js';
import { makeTempRoot, repoRoot } from './helpers.js';

function fakeCodex(runtimeDir) {
  const executable = path.join(runtimeDir, 'codex-telemetry');
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({ usage: { input_tokens: 11, cache_creation_input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 3 } }));
if (process.env.FAKE_OUTCOME === 'failed') process.exit(7);
if (process.env.FAKE_OUTCOME === 'wait') {
  if (process.env.FAKE_MARKER) require('node:fs').writeFileSync(process.env.FAKE_MARKER, 'ready');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

async function invoke(sessionDir, command, outcome, phase, options = {}) {
  return await runCodexExecMonitored({
    command,
    prompt: phase,
    timeoutMs: options.timeoutMs || 2_000,
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
  const timedOut = await invoke(sessionDir, command, 'wait', 'implement', { timeoutMs: 80 });
  const cancelMarker = path.join(sessionDir, 'cancel-ready');
  const cancelled = await invoke(sessionDir, command, 'wait', 'review', {
    env: { FAKE_MARKER: cancelMarker },
    cancelCheck: () => fs.existsSync(cancelMarker),
  });

  assert.equal(success.exitCode, 0);
  assert.equal(failed.exitCode, 7);
  assert.equal(timedOut.timedOut, true);
  assert.equal(cancelled.cancelled, true);
  for (const result of [success, failed, timedOut, cancelled]) {
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

  const output = execFileSync(process.execPath, [path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.match(output, /Executor Restarts: 3/);
  assert.match(output, /Checkpoints: reused 4 \| invalidated 1/);
  assert.match(output, /Autonomy Score: 1 \| post-seal human interventions 0/);
  assert.match(output, /Reliability Score: 1 \| unexpected terminal exits 0/);
});
