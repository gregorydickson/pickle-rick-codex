#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored, assertCodexSucceeded } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { getWorkingTreeStatus } from '../lib/git-utils.js';
import { logActivity } from '../lib/activity-logger.js';
import { buildLoopPrompt } from '../lib/prompts.js';
import { appendHistory, getRunStartEpoch, markRunStart } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { readJsonFile } from '../lib/pickle-utils.js';

function appendRunnerLog(sessionDir, message) {
  fs.appendFileSync(path.join(sessionDir, 'loop-runner.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function readLoopConfig(sessionDir) {
  const config = readJsonFile(path.join(sessionDir, 'loop_config.json'), null);
  if (!config || !config.mode) {
    throw new Error(`Missing loop_config.json in ${sessionDir}`);
  }
  return config;
}

export async function runLoop(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const config = loadConfig();
  const loopConfig = readLoopConfig(sessionDir);

  appendRunnerLog(sessionDir, `loop-runner started (${loopConfig.mode})`);
  manager.update(statePath, (state) => {
    state.active = true;
    state.tmux_runner_pid = process.pid;
    state.step = loopConfig.mode;
    state.last_exit_reason = null;
    state.cancel_requested_at = null;
    state.loop_mode = loopConfig.mode;
    state.loop_stall_count = state.loop_stall_count || 0;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    markRunStart(state);
    appendHistory(state, `${loopConfig.mode}_runner_start`, state.current_ticket || undefined);
    return state;
  });

  let exitReason = 'success';
  let thrownError = null;
  try {
    while (true) {
      const state = manager.read(statePath);
      if (state.active === false) {
        exitReason = state.last_exit_reason || 'cancelled';
        break;
      }
      if (Number.isInteger(state.max_iterations) && state.max_iterations > 0 && state.iteration >= state.max_iterations) {
        exitReason = 'max_iterations';
        break;
      }
      if (Number.isFinite(state.max_time_minutes) && state.max_time_minutes > 0) {
        const elapsedMinutes = (Date.now() / 1000 - getRunStartEpoch(state)) / 60;
        if (elapsedMinutes >= state.max_time_minutes) {
          exitReason = 'max_time';
          break;
        }
      }

      const beforeStatus = getWorkingTreeStatus(state.working_dir);
      manager.update(statePath, (current) => {
        current.iteration += 1;
        current.step = loopConfig.mode;
        appendHistory(current, loopConfig.mode, current.current_ticket || undefined);
        return current;
      });

      const result = await runCodexExecMonitored({
        cwd: state.working_dir,
        prompt: buildLoopPrompt({
          mode: loopConfig.mode,
          sessionDir,
          workingDir: state.working_dir,
          state: manager.read(statePath),
          loopConfig,
        }),
        timeoutMs: config.defaults.worker_timeout_seconds * 1000,
        outputLastMessagePath: path.join(sessionDir, `${loopConfig.mode}.${state.iteration + 1}.last-message.txt`),
        addDirs: [sessionDir],
        onSpawn: (child) => {
          manager.update(statePath, (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'codex';
            current.active_child_command = loopConfig.mode;
            return current;
          });
        },
        cancelCheck: () => manager.read(statePath).active === false,
      });
      manager.update(statePath, (current) => {
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        return current;
      });
      if (result.cancelled || manager.read(statePath).active === false) {
        exitReason = manager.read(statePath).last_exit_reason || 'cancelled';
        break;
      }
      assertCodexSucceeded(result, `${loopConfig.mode} iteration failed`);

      const lastMessage = result.lastMessage || '';
      appendRunnerLog(sessionDir, `iteration ${state.iteration + 1} finished`);

      const afterStatus = getWorkingTreeStatus(state.working_dir);
      const progressed = beforeStatus !== afterStatus;
      const latest = manager.update(statePath, (current) => {
        current.loop_stall_count = progressed ? 0 : Number(current.loop_stall_count || 0) + 1;
        current.last_loop_message = lastMessage.trim();
        return current;
      });

      if (/<promise>LOOP_COMPLETE<\/promise>|<promise>TASK_COMPLETED<\/promise>/.test(lastMessage)) {
        exitReason = 'success';
        break;
      }
      if (latest.loop_stall_count >= Number(loopConfig.stall_limit || 5)) {
        exitReason = 'stalled';
        break;
      }
    }
  } catch (error) {
    exitReason = manager.read(statePath).active === false
      ? (manager.read(statePath).last_exit_reason || 'cancelled')
      : 'error';
    if (exitReason !== 'cancelled') {
      thrownError = error;
    }
  } finally {
    manager.update(statePath, (state) => {
      const finalReason = state.active === false && state.last_exit_reason
        ? state.last_exit_reason
        : exitReason;
      state.active = false;
      state.tmux_runner_pid = null;
      state.active_child_pid = null;
      state.active_child_kind = null;
      state.active_child_command = null;
      state.last_exit_reason = finalReason;
      state.step = finalReason === 'success' ? 'complete' : 'paused';
      appendHistory(state, finalReason === 'success' ? 'complete' : finalReason, state.current_ticket || undefined);
      return state;
    });

    appendRunnerLog(sessionDir, `loop-runner finished: ${manager.read(statePath).last_exit_reason}`);
  }

  if (manager.read(statePath).last_exit_reason === 'success') {
    logActivity({
      event: `${loopConfig.mode}_completed`,
      source: 'pickle',
      session: path.basename(sessionDir),
    }, { enabled: config.defaults.activity_logging });
  }

  if (thrownError) {
    throw thrownError;
  }
}

async function main(argv) {
  const [sessionDir] = argv;
  if (!sessionDir) {
    throw new Error('Usage: node bin/loop-runner.js <session-dir>');
  }
  await runLoop(sessionDir);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
