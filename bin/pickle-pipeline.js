#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLaunchLock } from '../lib/detached-launch.js';
import { appendHistory } from '../lib/session.js';
import { getSessionForCwd, removeSessionMapEntry, updateSessionMap } from '../lib/session-map.js';
import {
  assertBootstrapSessionNotRunning,
  ensureBootstrapSessionReady,
  isProcessAlive,
  materializeBootstrapSession,
  recordBootstrapPreflightBlocked,
  resolveBootstrapResumeSessionDir,
} from '../lib/pipeline-bootstrap.js';
import {
  assertPipelineResumeCompatible,
  createPipelineContract,
  readPipelineContract,
  writePipelineContract,
} from '../lib/pipeline.js';
import { ensurePipelineState } from '../lib/pipeline-state.js';
import { getRunnerDescriptor } from '../lib/runner-descriptors.js';
import { StateManager } from '../lib/state-manager.js';
import { clearTmuxSession, ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote, waitForTmuxRunnerStart } from '../lib/tmux.js';
import { isPreflightError } from '../lib/verification-env.js';

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'retry-once';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function parseArgs(argv) {
  const parsed = {
    taskPrompt: null,
    resume: null,
    prdPath: null,
    resumeReadyOnly: false,
    maxTime: null,
    workerTimeout: null,
    skipAnatomy: false,
    skipAnatomySpecified: false,
    skipSzechuan: false,
    skipSzechuanSpecified: false,
  };
  const taskParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--resume') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        parsed.resume = next;
        index += 1;
      } else {
        parsed.resume = '__LAST__';
      }
    } else if (arg === '--prd' || arg === '--bootstrap-from') {
      parsed.prdPath = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--task') {
      parsed.taskPrompt = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--resume-ready-only') {
      parsed.resumeReadyOnly = true;
    } else if (arg === '--max-time') {
      parsed.maxTime = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--worker-timeout') {
      parsed.workerTimeout = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--skip-anatomy') {
      parsed.skipAnatomy = true;
      parsed.skipAnatomySpecified = true;
    } else if (arg === '--skip-szechuan') {
      parsed.skipSzechuan = true;
      parsed.skipSzechuanSpecified = true;
    } else if (arg === '--help' || arg.startsWith('--on-failure=')) {
      continue;
    } else if (arg === '--max-iterations') {
      throw new Error('pickle-pipeline does not support --max-iterations. Detached pipeline runs are unbounded in this slice.');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      taskParts.push(arg);
    }
  }

  const positionalTask = taskParts.join(' ').trim();
  if (parsed.taskPrompt && positionalTask) {
    throw new Error('Specify the pipeline task once, either positionally or with --task.');
  }
  parsed.taskPrompt = (parsed.taskPrompt || positionalTask || '').trim() || null;

  if (parsed.resume && (parsed.prdPath || parsed.taskPrompt)) {
    throw new Error('Use either a fresh task/PRD launch or --resume, not both.');
  }
  if (parsed.prdPath && parsed.taskPrompt) {
    throw new Error('Use either a task string or --prd/--bootstrap-from, not both.');
  }
  if (!parsed.resume && !parsed.prdPath && !parsed.taskPrompt) {
    throw new Error('Usage requires a task string, --prd <path>, or --resume [session-dir].');
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  node bin/pickle-pipeline.js "task string" [--skip-anatomy] [--skip-szechuan] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-pipeline.js --task "task string" [--skip-anatomy] [--skip-szechuan] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-pipeline.js --prd path/to/prd.md [--skip-anatomy] [--skip-szechuan] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
    '  node bin/pickle-pipeline.js --resume [SESSION_DIR] [--resume-ready-only] [--worker-timeout S] [--max-time M] [--on-failure=abort|skip|retry-once]',
  ].join('\n');
}

function buildPipelinePhases(parsed) {
  const phases = ['pickle'];
  if (!parsed.skipAnatomy) {
    phases.push('anatomy-park');
  }
  if (!parsed.skipSzechuan) {
    phases.push('szechuan-sauce');
  }
  return phases;
}

function createPipelineLaunchContract(state, parsed) {
  const phases = buildPipelinePhases(parsed);
  return createPipelineContract({
    working_dir: state.working_dir,
    target: state.working_dir,
    phases,
    skip_flags: {
      anatomy: parsed.skipAnatomy,
      szechuan: parsed.skipSzechuan,
    },
    bootstrap_source: parsed.prdPath ? 'prd' : 'task',
    bootstrap_prd: parsed.prdPath ? path.resolve(parsed.prdPath) : null,
    task: parsed.taskPrompt,
  });
}

function assertResumeSkipFlagsUnchanged(parsed) {
  if (parsed.skipAnatomySpecified || parsed.skipSzechuanSpecified) {
    throw new Error('Cannot change pipeline skip flags on resume.');
  }
}

function markAbruptRunnerLossBeforeResume(sessionDir, manager = new StateManager()) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const runnerPid = Number(state.tmux_runner_pid);
  if (state.active !== true || !Number.isInteger(runnerPid) || runnerPid <= 0 || isProcessAlive(runnerPid)) {
    return;
  }

  manager.update(statePath, (current) => {
    current.active = false;
    current.tmux_runner_pid = null;
    current.tmux_session_name = null;
    current.worker_pid = null;
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.last_exit_reason = 'runner_lost';
    current.step = 'paused';
    appendHistory(current, 'runner_lost', current.current_ticket || undefined);
    return current;
  });
}

function createResumeValidationContract(existingPipeline, cwd) {
  return createPipelineContract({
    ...existingPipeline,
    working_dir: cwd,
    target: cwd,
  });
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log(usage());
    return;
  }

  const onFailure = parseFailureMode(argv);
  const parsed = parseArgs(argv);
  const resumeSessionDir = resolveBootstrapResumeSessionDir(parsed.resume);
  if (parsed.resume) {
    if (!resumeSessionDir) {
      throw new Error('No pipeline session found to resume.');
    }
    assertResumeSkipFlagsUnchanged(parsed);
    const existingPipeline = readPipelineContract(resumeSessionDir);
    markAbruptRunnerLossBeforeResume(resumeSessionDir);
    assertBootstrapSessionNotRunning(resumeSessionDir);
    assertPipelineResumeCompatible(
      existingPipeline,
      createResumeValidationContract(existingPipeline, fs.realpathSync(process.cwd())),
    );
  }
  ensureTmuxAvailable();

  const sessionDir = await materializeBootstrapSession({
    prdPath: parsed.prdPath,
    taskPrompt: parsed.taskPrompt,
    resume: parsed.resume,
    maxTime: parsed.maxTime,
    workerTimeout: parsed.workerTimeout,
  });
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const pipeline = parsed.resume
    ? readPipelineContract(sessionDir)
    : writePipelineContract(sessionDir, createPipelineLaunchContract(manager.read(statePath), parsed));
  const pipelineState = ensurePipelineState(sessionDir, pipeline, manager);
  if (pipelineState.current_phase == null) {
    throw new Error(`Pipeline session is already complete: ${sessionDir}`);
  }

  const releaseLock = acquireLaunchLock(sessionDir);
  const runtimeRoot = getRuntimeRoot();
  let previousSessionDir = null;

  try {
    let state;
    let summary;
    try {
      ({ state, summary } = await ensureBootstrapSessionReady(sessionDir, { resumeReadyOnly: parsed.resumeReadyOnly }));
    } catch (error) {
      if (isPreflightError(error)) {
        recordBootstrapPreflightBlocked(sessionDir, error);
      }
      throw error;
    }

    assertBootstrapSessionNotRunning(sessionDir);
    previousSessionDir = getSessionForCwd(state.working_dir);
    await updateSessionMap(state.working_dir, sessionDir);

    const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const runnerDescriptor = getRunnerDescriptor('pipeline');
    const runnerLogPath = path.join(sessionDir, runnerDescriptor.runnerLog);
    const existingLogSizeBytes = fs.existsSync(runnerLogPath) ? fs.statSync(runnerLogPath).size : 0;
    let launchStarted = false;

    manager.update(statePath, (current) => {
      current.tmux_mode = true;
      current.active = false;
      current.max_iterations = 0;
      current.tmux_runner_pid = null;
      current.tmux_session_name = sessionName;
      current.last_exit_reason = null;
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.worker_pid = null;
      appendHistory(current, 'tmux_launch_requested');
      return current;
    });

    try {
      clearTmuxSession(sessionName);
      runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir]);
      launchStarted = true;
      runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

      const runnerCommand = [
        'node',
        shellQuote(path.join(runtimeRoot, 'bin', runnerDescriptor.runnerBin)),
        shellQuote(sessionDir),
        `--on-failure=${onFailure}`,
        ';',
        'status=$?',
        ';',
        'echo',
        shellQuote(''),
        ';',
        'echo',
        shellQuote('Pipeline runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
        ';',
        'exit',
        '$status',
      ].join(' ');

      runTmux(['set-option', '-w', '-t', `${sessionName}:0`, 'remain-on-exit', 'on']);
      runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0`, `bash -lc ${shellQuote(runnerCommand)}`]);
      const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, runnerDescriptor.monitorMode], {
        encoding: 'utf8',
        timeout: 30_000,
        env: process.env,
      });
      if (monitorResult.status !== 0) {
        throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
      }
      await waitForTmuxRunnerStart(sessionDir, sessionName, runnerDescriptor.mode, { existingLogSizeBytes });
    } catch (error) {
      if (launchStarted) {
        try {
          runTmux(['kill-session', '-t', sessionName]);
        } catch {
          // Best-effort cleanup for partially created tmux sessions.
        }
      }
      manager.update(statePath, (current) => {
        current.active = false;
        current.tmux_runner_pid = null;
        current.tmux_session_name = null;
        current.worker_pid = null;
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.last_exit_reason = 'launch_failed';
        appendHistory(current, 'tmux_launch_failed', current.current_ticket || undefined);
        return current;
      });
      try {
        if (previousSessionDir) {
          await updateSessionMap(state.working_dir, previousSessionDir);
        } else {
          await removeSessionMapEntry(state.working_dir, sessionDir);
        }
      } catch {
        // Best-effort map rollback for failed tmux launches.
      }
      throw error;
    }

    console.log([
      'Pickle pipeline launched.',
      `Session: ${sessionName}`,
      `Attach: tmux attach -t ${sessionName}`,
      'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
      `Phase: ${pipelineState.current_phase}`,
      `Runnable Tickets: ${summary.runnable.length} (done=${summary.done} blocked=${summary.blocked} skipped=${summary.skipped})`,
      `Cancel: node ${path.join(runtimeRoot, 'bin', 'cancel.js')} --session-dir ${sessionDir}`,
      `State: ${path.join(sessionDir, 'state.json')}`,
      `Runner Log: ${path.join(sessionDir, runnerDescriptor.runnerLog)}`,
    ].join('\n'));
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
