import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setupSession } from './setup-session.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { appendHistory } from './session.js';
import { getSessionForCwd, removeSessionMapEntry, updateSessionMap } from './session-map.js';
import { StateManager } from './state-manager.js';
import { ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote } from './tmux.js';

export async function launchDetachedLoop({
  setupArgs,
  loopConfig,
  onFailure = 'retry-once',
  banner = 'Detached loop launched.',
}) {
  ensureTmuxAvailable();
  const { sessionDir, state } = await setupSession(setupArgs, { updateSessionMap: false });
  const previousSessionDir = getSessionForCwd(state.working_dir);
  const resumed = setupArgs.includes('--resume');
  const runtimeRoot = getRuntimeRoot();
  const existingConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'), {}) || {};
  const mergedConfig = Object.fromEntries(
    Object.entries({ ...existingConfig, ...loopConfig }).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
  atomicWriteJson(path.join(sessionDir, 'loop_config.json'), mergedConfig);
  const sessionName = `${loopConfig.mode}-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  let launchStarted = false;

  try {
    runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir]);
    launchStarted = true;
    runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

    const runnerBin = mergedConfig.mode === 'pickle' ? 'mux-runner.js' : 'loop-runner.js';
    const runnerArgs = mergedConfig.mode === 'pickle'
      ? `${shellQuote(sessionDir)} --on-failure=${onFailure}`
      : `${shellQuote(sessionDir)}`;
    const runnerCommand = [
      'node',
      shellQuote(path.join(runtimeRoot, 'bin', runnerBin)),
      runnerArgs,
      ';',
      'echo',
      shellQuote(''),
      ';',
      'echo',
      shellQuote('Runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
      ';',
      'read',
    ].join(' ');
    runTmux(['send-keys', '-t', `${sessionName}:0`, runnerCommand, 'Enter']);

    const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, mergedConfig.mode], {
      encoding: 'utf8',
      timeout: 30_000,
      env: process.env,
    });
    if (monitorResult.status !== 0) {
      throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
    }
  } catch (error) {
    if (launchStarted) {
      try {
        runTmux(['kill-session', '-t', sessionName]);
      } catch {
        // Best-effort cleanup for partially created tmux sessions.
      }
    }
    try {
      manager.update(statePath, (current) => {
        current.active = false;
        current.tmux_runner_pid = null;
        current.tmux_session_name = null;
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.last_exit_reason = 'launch_failed';
        appendHistory(current, 'tmux_launch_failed', current.current_ticket || undefined);
        return current;
      });
    } catch {
      // Best-effort state rollback.
    }
    if (!resumed) {
      try {
        if (previousSessionDir) {
          await updateSessionMap(state.working_dir, previousSessionDir);
        } else {
          await removeSessionMapEntry(state.working_dir, sessionDir);
        }
      } catch {
        // Best-effort map rollback for never-launched sessions.
      }
    }
    throw error;
  }

  await updateSessionMap(state.working_dir, sessionDir);

  const runnerLogName = mergedConfig.mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log';
  return [
    banner,
    `Session: ${sessionName}`,
    `Attach: tmux attach -t ${sessionName}`,
    'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
    `State: ${path.join(sessionDir, 'state.json')}`,
    `Runner Log: ${path.join(sessionDir, runnerLogName)}`,
  ].join('\n');
}
