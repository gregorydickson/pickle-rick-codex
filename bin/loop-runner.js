#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored, assertCodexSucceeded } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { logActivity } from '../lib/activity-logger.js';
import {
  commitTrackedChanges,
  getHeadSha,
  isGitRepo,
  isWorkingTreeDirty,
  resetGitIndex,
  stageTrackedChanges,
} from '../lib/git-utils.js';
import { captureProgressSnapshot, diffProgressSnapshot } from '../lib/progress-snapshot.js';
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

function getWorkerTimeoutMs(state, config) {
  const timeoutSeconds = Number.isFinite(state?.worker_timeout_seconds)
    ? Number(state.worker_timeout_seconds)
    : config.defaults.worker_timeout_seconds;
  return timeoutSeconds * 1000;
}

function summaryPaths(sessionDir, mode) {
  return {
    json: path.join(sessionDir, `${mode}-summary.json`),
    markdown: path.join(sessionDir, `${mode}-summary.md`),
    stopJson: path.join(sessionDir, `${mode}-stop-summary.json`),
    stopMarkdown: path.join(sessionDir, `${mode}-stop-summary.md`),
  };
}

function normalizeLoopMessage(message) {
  return String(message || '')
    .replace(/<promise>[^<]+<\/promise>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeErrorMessage(error) {
  if (typeof error?.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }
  if (Buffer.isBuffer(error?.stderr)) {
    const stderr = error.stderr.toString('utf8').trim();
    if (stderr) return stderr;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function summarizeVerification(summary) {
  if (Array.isArray(summary.verification)) {
    return summary.verification;
  }
  if (typeof summary.verification === 'string' && summary.verification.trim()) {
    return [summary.verification.trim()];
  }
  return [];
}

function summarizeTrapDoors(summary) {
  if (Array.isArray(summary.trap_doors)) {
    return summary.trap_doors.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return [];
}

function anatomyParkSummary(sessionDir) {
  return readJsonFile(summaryPaths(sessionDir, 'anatomy-park').json, {});
}

function anatomyParkCommitMessage(sessionDir, loopConfig, iteration) {
  const summary = anatomyParkSummary(sessionDir);
  const targetLabel = path.basename(path.resolve(loopConfig.target || 'target')) || 'target';
  const finding = normalizeLoopMessage(
    summary.highest_severity_finding
    || summary.finding_family
    || `iteration ${iteration}`,
  );
  const trapDoorSuffix = summarizeTrapDoors(summary).length ? ', trap door' : '';
  return `anatomy-park: ${targetLabel} - ${finding}${trapDoorSuffix}`;
}

function anatomyParkProgressReasons(workingDir, reasons) {
  if (!isGitRepo(workingDir)) {
    return reasons;
  }
  return reasons.filter((reason) => reason !== 'worktree_fingerprint');
}

function ensureAnatomyParkPreflightCommit(sessionDir, loopConfig, workingDir) {
  if (loopConfig.mode !== 'anatomy-park' || loopConfig.dry_run) {
    return;
  }
  if (!isWorkingTreeDirty(workingDir)) {
    return;
  }
  if (!isGitRepo(workingDir)) {
    throw new Error('Working tree is dirty - not a git repo, cannot auto-commit before anatomy-park start');
  }

  appendRunnerLog(sessionDir, 'working tree is dirty before anatomy-park start; auto-committing tracked changes');
  try {
    stageTrackedChanges(workingDir);
    commitTrackedChanges(workingDir, 'anatomy-park: auto-commit dirty tree before start');
    appendRunnerLog(sessionDir, `preflight auto-committed: ${getHeadSha(workingDir)}`);
  } catch (error) {
    resetGitIndex(workingDir);
    throw new Error(`Working tree is dirty and anatomy-park preflight auto-commit failed: ${safeErrorMessage(error)}`);
  }
}

function autoCommitAnatomyParkIteration(sessionDir, loopConfig, workingDir, beforeSnapshot, iteration) {
  if (loopConfig.mode !== 'anatomy-park' || loopConfig.dry_run) {
    return false;
  }
  if (!isGitRepo(workingDir) || !isWorkingTreeDirty(workingDir)) {
    return false;
  }
  if (beforeSnapshot.head_sha && getHeadSha(workingDir) !== beforeSnapshot.head_sha) {
    return false;
  }

  appendRunnerLog(sessionDir, 'no anatomy-park commit detected after iteration; auto-committing tracked changes');
  try {
    stageTrackedChanges(workingDir);
    commitTrackedChanges(workingDir, anatomyParkCommitMessage(sessionDir, loopConfig, iteration));
    appendRunnerLog(sessionDir, `anatomy-park auto-committed: ${getHeadSha(workingDir)}`);
    return true;
  } catch (error) {
    resetGitIndex(workingDir);
    appendRunnerLog(sessionDir, `anatomy-park auto-commit failed: ${safeErrorMessage(error)}`);
    return false;
  }
}

function stopSummaryFromState(state, loopConfig, exitReason, sessionDir) {
  const paths = summaryPaths(sessionDir, loopConfig.mode);
  const persistedSummary = readJsonFile(paths.json, {});
  const lastMessage = normalizeLoopMessage(state.last_loop_message);
  return {
    mode: loopConfig.mode,
    target: loopConfig.target || null,
    stop_reason: exitReason,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    max_time_minutes: state.max_time_minutes,
    highest_severity_finding: persistedSummary.highest_severity_finding || (lastMessage.split('\n')[0] || null),
    finding_family: persistedSummary.finding_family || null,
    data_flow_path: persistedSummary.data_flow_path || null,
    fix_applied: persistedSummary.fix_applied || null,
    verification: summarizeVerification(persistedSummary),
    trap_doors: summarizeTrapDoors(persistedSummary),
    next_action: persistedSummary.next_action || null,
    last_loop_message: state.last_loop_message || null,
    summary_generated_at: new Date().toISOString(),
  };
}

function writeStopSummaryArtifacts(sessionDir, loopConfig, state, exitReason) {
  const paths = summaryPaths(sessionDir, loopConfig.mode);
  const summary = stopSummaryFromState(state, loopConfig, exitReason, sessionDir);
  fs.writeFileSync(paths.stopJson, JSON.stringify(summary, null, 2));

  const markdown = [
    `# ${loopConfig.mode} Stop Summary`,
    '',
    `- Stop Reason: ${summary.stop_reason}`,
    `- Iteration: ${summary.iteration}`,
    `- Highest-Severity Finding: ${summary.highest_severity_finding || 'n/a'}`,
    `- Finding Family: ${summary.finding_family || 'n/a'}`,
    `- Data Flow Path: ${summary.data_flow_path || 'n/a'}`,
    `- Fix Applied: ${summary.fix_applied || 'n/a'}`,
    `- Next Action: ${summary.next_action || 'n/a'}`,
    '',
    '## Verification',
    ...(summary.verification.length ? summary.verification.map((entry) => `- ${entry}`) : ['- n/a']),
    '',
    '## Trap Doors',
    ...(summary.trap_doors.length ? summary.trap_doors.map((entry) => `- ${entry}`) : ['- none recorded']),
    '',
    '## Last Loop Message',
    '',
    '```text',
    summary.last_loop_message || 'n/a',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(paths.stopMarkdown, markdown);
}

export async function runLoop(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const config = loadConfig();
  const loopConfig = readLoopConfig(sessionDir);
  const initialState = manager.read(statePath);

  appendRunnerLog(sessionDir, `loop-runner started (${loopConfig.mode})`);
  ensureAnatomyParkPreflightCommit(sessionDir, loopConfig, initialState.working_dir);
  manager.update(statePath, (state) => {
    state.active = true;
    state.tmux_runner_pid = process.pid;
    state.step = loopConfig.mode;
    state.last_exit_reason = null;
    state.cancel_requested_at = null;
    state.loop_mode = loopConfig.mode;
    state.loop_stall_count = 0;
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

      const beforeSnapshot = captureProgressSnapshot({
        sessionDir,
        workingDir: state.working_dir,
        mode: loopConfig.mode,
        step: state.step,
        currentTicket: state.current_ticket,
      });
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
        timeoutMs: getWorkerTimeoutMs(state, config),
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

      autoCommitAnatomyParkIteration(
        sessionDir,
        loopConfig,
        state.working_dir,
        beforeSnapshot,
        state.iteration + 1,
      );

      const afterSnapshot = captureProgressSnapshot({
        sessionDir,
        workingDir: state.working_dir,
        mode: loopConfig.mode,
        step: loopConfig.mode,
        currentTicket: manager.read(statePath).current_ticket,
      });
      const progressReasons = anatomyParkProgressReasons(
        state.working_dir,
        diffProgressSnapshot(beforeSnapshot, afterSnapshot).filter((reason) => reason !== 'initial_snapshot'),
      );
      const latest = manager.update(statePath, (current) => {
        current.loop_stall_count = progressReasons.length ? 0 : Number(current.loop_stall_count || 0) + 1;
        current.last_loop_message = lastMessage.trim();
        return current;
      });
      if (progressReasons.length) {
        appendRunnerLog(sessionDir, `iteration ${state.iteration + 1} progress: ${progressReasons.join(',')}`);
      }

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

    writeStopSummaryArtifacts(sessionDir, loopConfig, manager.read(statePath), manager.read(statePath).last_exit_reason);
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
