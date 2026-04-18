import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setupSession } from './setup-session.js';
import { atomicWriteJson, ensureDir, getSessionsRoot, readJsonFile } from './pickle-utils.js';
import { appendHistory } from './session.js';
import { findLastSessionForCwd, getSessionForCwd, removeSessionMapEntry, sessionStateMatchesCwd, updateSessionMap } from './session-map.js';
import { StateManager } from './state-manager.js';
import { clearTmuxSession, ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote, waitForTmuxRunnerStart } from './tmux.js';

function parseResumeTarget(setupArgs) {
  const resumeIndex = setupArgs.indexOf('--resume');
  if (resumeIndex === -1) return null;
  const explicitSessionDir = setupArgs[resumeIndex + 1];
  if (explicitSessionDir && !explicitSessionDir.startsWith('--')) {
    return explicitSessionDir;
  }
  return '__LAST__';
}

function resolveResumeSessionDir(setupArgs, cwd = fs.realpathSync(process.cwd())) {
  const resumeTarget = parseResumeTarget(setupArgs);
  if (!resumeTarget) return null;
  if (resumeTarget !== '__LAST__') {
    return resumeTarget;
  }
  return getSessionForCwd(cwd) || findLastSessionForCwd(cwd);
}

function assertCompatibleLoopResume(sessionDir, expectedMode) {
  if (!sessionDir) {
    return;
  }
  const existingConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'), null);
  const existingMode = existingConfig?.mode || null;
  if (!existingMode) {
    throw new Error(`Cannot resume ${expectedMode}: ${sessionDir} is not an advanced loop session.`);
  }
  if (existingMode !== expectedMode) {
    throw new Error(`Cannot resume ${expectedMode}: ${sessionDir} is a ${existingMode} session.`);
  }
}

function assertResumeTargetUnchanged(sessionDir, loopConfig, existingConfig) {
  if (!sessionDir || !loopConfig || typeof loopConfig.target !== 'string' || !loopConfig.target) {
    return;
  }

  const existingTarget = typeof existingConfig?.target === 'string' && existingConfig.target
    ? path.resolve(existingConfig.target)
    : null;
  const requestedTarget = path.resolve(loopConfig.target);

  if (!existingTarget || existingTarget !== requestedTarget) {
    throw new Error(
      `Cannot change target when resuming ${existingConfig?.mode || loopConfig.mode || 'detached loop'}: ${sessionDir} is pinned to ${existingTarget || 'its original target'}. Start a new session for ${requestedTarget}.`,
    );
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertLoopSessionNotRunning(sessionDir) {
  if (!sessionDir) {
    return;
  }
  const state = readJsonFile(path.join(sessionDir, 'state.json'), null);
  const runnerPid = Number(state?.tmux_runner_pid);
  if (processAlive(runnerPid)) {
    throw new Error(`Session is already running under tmux runner pid ${runnerPid}.`);
  }
}

function getReservedCwdsForSession(sessionDir, fallbackCwds = []) {
  const state = readJsonFile(path.join(sessionDir, 'state.json'), null);
  return uniqueCwds([
    ...(Array.isArray(state?.session_map_cwds) ? state.session_map_cwds : []),
    state?.working_dir,
    ...fallbackCwds,
  ]);
}

function launchLockPath(sessionDir) {
  return path.join(sessionDir, '.tmux-launch.lock');
}

function cwdReservationLockPath(cwd) {
  const digest = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return path.join(getSessionsRoot(), `.tmux-cwd-${digest}.lock`);
}

function findTmuxReservationForCwd(cwd, options = {}) {
  const excluded = options.excludeSessionDir ? path.resolve(options.excludeSessionDir) : null;
  let entries = [];
  try {
    entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(getSessionsRoot(), entry.name);
    if (excluded && path.resolve(sessionDir) === excluded) continue;
    const state = readJsonFile(path.join(sessionDir, 'state.json'), null);
    if (!state || !sessionStateMatchesCwd(state, cwd)) continue;

    const runnerPid = Number(state.tmux_runner_pid);
    if (processAlive(runnerPid)) {
      return {
        kind: 'runner',
        pid: runnerPid,
        sessionDir,
      };
    }

    try {
      const rawLock = fs.readFileSync(launchLockPath(sessionDir), 'utf8').trim();
      const lockPid = Number(rawLock);
      if (processAlive(lockPid)) {
        return {
          kind: 'launch',
          pid: lockPid,
          sessionDir,
        };
      }
    } catch {
      // Ignore missing or unreadable lock files.
    }
  }

  return null;
}

function assertNoTmuxReservationForCwd(cwd, options = {}) {
  const reservation = findTmuxReservationForCwd(cwd, options);
  if (!reservation) {
    return;
  }
  if (reservation.kind === 'launch') {
    throw new Error(`A tmux launch is already in progress for ${cwd} under session ${reservation.sessionDir}.`);
  }
  throw new Error(`A tmux runner is already active for ${cwd} under session ${reservation.sessionDir} (pid ${reservation.pid}).`);
}

function assertNoTmuxReservationForCwds(cwds, options = {}) {
  for (const cwd of uniqueCwds(cwds)) {
    assertNoTmuxReservationForCwd(cwd, options);
  }
}

function acquirePidLock(lockPath, busyMessage) {
  ensureDir(path.dirname(lockPath));
  let fd = null;
  for (let attempts = 0; attempts < 3; attempts += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      let lockPid = Number.NaN;
      try {
        lockPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      } catch {
        // Another launcher removed the lock between open and inspection.
      }
      if (Number.isInteger(lockPid) && processAlive(lockPid)) {
        throw new Error(busyMessage);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  if (fd == null) {
    throw new Error(`Failed to acquire lock ${lockPath}.`);
  }
  fs.writeFileSync(fd, String(process.pid));
  return () => {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close failures during teardown.
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  };
}

function acquireLaunchLock(sessionDir) {
  return acquirePidLock(launchLockPath(sessionDir), `A tmux launch is already in progress for ${sessionDir}.`);
}

function acquireCwdReservationLocks(cwds) {
  const releases = [];
  try {
    for (const cwd of uniqueCwds(cwds).sort()) {
      releases.push(acquirePidLock(cwdReservationLockPath(cwd), `A tmux launch is already in progress for ${cwd}.`));
    }
  } catch (error) {
    while (releases.length) {
      releases.pop()?.();
    }
    throw error;
  }
  return () => {
    while (releases.length) {
      releases.pop()?.();
    }
  };
}

function uniqueCwds(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

export async function launchDetachedLoop({
  setupArgs,
  loopConfig,
  onFailure = 'retry-once',
  banner = 'Detached loop launched.',
  sessionCwd = null,
  sessionMapCwd = null,
}) {
  ensureTmuxAvailable();
  const launcherCwd = fs.realpathSync(process.cwd());
  const effectiveSessionCwd = fs.realpathSync(sessionCwd || launcherCwd);
  const effectiveSessionMapCwd = fs.realpathSync(sessionMapCwd || launcherCwd);
  const resumeTarget = parseResumeTarget(setupArgs);
  const resumed = resumeTarget !== null;
  const explicitResume = resumeTarget !== null && resumeTarget !== '__LAST__';
  const resumeSessionDir = resolveResumeSessionDir(setupArgs, effectiveSessionMapCwd);
  assertCompatibleLoopResume(resumeSessionDir, loopConfig.mode);
  const reservedCwds = resumeSessionDir
    ? getReservedCwdsForSession(
      resumeSessionDir,
      explicitResume ? [] : [effectiveSessionMapCwd, effectiveSessionCwd],
    )
    : [effectiveSessionMapCwd, effectiveSessionCwd];
  const releaseCwdLocks = acquireCwdReservationLocks(reservedCwds);
  if (resumeSessionDir) {
    assertLoopSessionNotRunning(resumeSessionDir);
    assertNoTmuxReservationForCwds(
      reservedCwds,
      { excludeSessionDir: resumeSessionDir },
    );
  } else {
    assertNoTmuxReservationForCwds(reservedCwds);
  }
  let releaseLock = resumeSessionDir ? acquireLaunchLock(resumeSessionDir) : null;
  try {
    const { sessionDir, state } = await setupSession(setupArgs, {
      updateSessionMap: false,
      cwd: resumed ? effectiveSessionMapCwd : effectiveSessionCwd,
    });
    const sessionMapCwds = uniqueCwds([
      ...(explicitResume ? [] : [effectiveSessionMapCwd]),
      state.working_dir,
    ]);
    releaseLock ??= acquireLaunchLock(sessionDir);
    const previousSessionDir = getSessionForCwd(effectiveSessionMapCwd);
    const runtimeRoot = getRuntimeRoot();
    const existingConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'), {}) || {};
    if (resumed) {
      assertResumeTargetUnchanged(sessionDir, loopConfig, existingConfig);
    }
    const mergedConfig = Object.fromEntries(
      Object.entries({ ...existingConfig, ...loopConfig }).filter(([, value]) => value !== null && value !== undefined && value !== ''),
    );
    atomicWriteJson(path.join(sessionDir, 'loop_config.json'), mergedConfig);
    const sessionName = `${loopConfig.mode}-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const statePath = path.join(sessionDir, 'state.json');
    const runnerLogPath = path.join(sessionDir, mergedConfig.mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log');
    const manager = new StateManager();
    let launchStarted = false;
    const existingLogSizeBytes = fs.existsSync(runnerLogPath) ? fs.statSync(runnerLogPath).size : 0;

    try {
      manager.update(statePath, (current) => {
        current.active = false;
        current.tmux_runner_pid = null;
        current.tmux_session_name = sessionName;
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.last_exit_reason = null;
        current.session_map_cwds = uniqueCwds([...(current.session_map_cwds || []), ...sessionMapCwds]);
        appendHistory(current, 'tmux_launch_requested', current.current_ticket || undefined);
        return current;
      });
      clearTmuxSession(sessionName);
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
        'status=$?',
        ';',
        'echo',
        shellQuote(''),
        ';',
        'echo',
        shellQuote('Runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
        ';',
        'exit',
        '$status',
      ].join(' ');
      runTmux(['set-option', '-w', '-t', `${sessionName}:0`, 'remain-on-exit', 'on']);
      runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0`, `bash -lc ${shellQuote(runnerCommand)}`]);

      const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, mergedConfig.mode], {
        encoding: 'utf8',
        timeout: 30_000,
        env: process.env,
      });
      if (monitorResult.status !== 0) {
        throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
      }
      await waitForTmuxRunnerStart(sessionDir, sessionName, mergedConfig.mode, { existingLogSizeBytes });
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
            await updateSessionMap(effectiveSessionMapCwd, previousSessionDir);
          } else {
            await removeSessionMapEntry(effectiveSessionMapCwd, sessionDir);
          }
        } catch {
          // Best-effort map rollback for never-launched sessions.
        }
      }
      throw error;
    }

    for (const cwd of sessionMapCwds) {
      await updateSessionMap(cwd, sessionDir);
    }

    const runnerLogName = mergedConfig.mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log';
    return [
      banner,
      `Session: ${sessionName}`,
      `Attach: tmux attach -t ${sessionName}`,
      'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
      `State: ${path.join(sessionDir, 'state.json')}`,
      `Runner Log: ${path.join(sessionDir, runnerLogName)}`,
    ].join('\n');
  } finally {
    releaseLock?.();
    releaseCwdLocks();
  }
}
