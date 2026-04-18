import fs from 'node:fs';
import path from 'node:path';
import { createSession, getSessionMapCwds } from './session.js';
import { loadConfig } from './config.js';
import { findLastSessionForCwd, getSessionForCwd, updateSessionMap } from './session-map.js';
import { StateManager } from './state-manager.js';

function parseArgs(argv) {
  let maxIterations;
  let maxIterationsSpecified = false;
  let maxTimeMinutes;
  let maxTimeMinutesSpecified = false;
  let workerTimeoutSeconds;
  let workerTimeoutSecondsSpecified = false;
  let resume = null;
  let tmuxMode = false;
  let commandTemplate = null;
  let explicitTask = null;
  const taskParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-iterations') {
      maxIterations = Number(argv[index + 1]);
      maxIterationsSpecified = true;
      index += 1;
    } else if (arg === '--max-time') {
      maxTimeMinutes = Number(argv[index + 1]);
      maxTimeMinutesSpecified = true;
      index += 1;
    } else if (arg === '--worker-timeout') {
      workerTimeoutSeconds = Number(argv[index + 1]);
      workerTimeoutSecondsSpecified = true;
      index += 1;
    } else if (arg === '--resume') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        resume = next;
        index += 1;
      } else {
        resume = '__LAST__';
      }
    } else if (arg === '--tmux') {
      tmuxMode = true;
    } else if (arg === '--command-template') {
      commandTemplate = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--task') {
      explicitTask = argv[index + 1] || '';
      index += 1;
    } else {
      taskParts.push(arg);
    }
  }

  if (commandTemplate && /[\\/]|^\.\./.test(commandTemplate)) {
    throw new Error('--command-template must be a plain filename');
  }

  return {
    resume,
    tmuxMode,
    commandTemplate,
    maxIterations,
    maxIterationsSpecified,
    maxTimeMinutes,
    maxTimeMinutesSpecified,
    workerTimeoutSeconds,
    workerTimeoutSecondsSpecified,
    prompt: (explicitTask ?? taskParts.join(' ')).trim(),
  };
}

export async function setupSession(argv, options = {}) {
  const parsed = parseArgs(argv);
  const cwd = fs.realpathSync(options.cwd || process.cwd());
  const shouldUpdateSessionMap = options.updateSessionMap !== false;
  const config = loadConfig();
  const overrides = {
    max_iterations: Number.isInteger(parsed.maxIterations) ? parsed.maxIterations : config.defaults.max_iterations,
    max_time_minutes: Number.isInteger(parsed.maxTimeMinutes) ? parsed.maxTimeMinutes : config.defaults.max_time_minutes,
    worker_timeout_seconds: Number.isInteger(parsed.workerTimeoutSeconds) ? parsed.workerTimeoutSeconds : config.defaults.worker_timeout_seconds,
  };

  if (parsed.resume) {
    const sessionDir = parsed.resume === '__LAST__'
      ? getSessionForCwd(cwd) || findLastSessionForCwd(cwd)
      : parsed.resume;
    if (!sessionDir) {
      throw new Error('No session found to resume');
    }

    const statePath = path.join(sessionDir, 'state.json');
    const manager = new StateManager();
    const state = manager.update(statePath, (current) => {
      if (parsed.maxIterationsSpecified && Number.isInteger(parsed.maxIterations)) {
        current.max_iterations = parsed.maxIterations;
      }
      if (parsed.maxTimeMinutesSpecified && Number.isInteger(parsed.maxTimeMinutes)) {
        current.max_time_minutes = parsed.maxTimeMinutes;
      }
      if (parsed.workerTimeoutSecondsSpecified && Number.isInteger(parsed.workerTimeoutSeconds)) {
        current.worker_timeout_seconds = parsed.workerTimeoutSeconds;
      }
      if (parsed.tmuxMode) {
        current.tmux_mode = true;
        current.active = false;
      }
      if (parsed.commandTemplate) {
        current.command_template = parsed.commandTemplate;
      }
      return current;
    });

    if (shouldUpdateSessionMap) {
      for (const sessionCwd of getSessionMapCwds(state)) {
        await updateSessionMap(sessionCwd, sessionDir);
      }
    }
    return { sessionDir, state };
  }

  if (!parsed.prompt) {
    throw new Error('No task specified');
  }

  return await createSession({
    cwd,
    prompt: parsed.prompt,
    updateMap: shouldUpdateSessionMap,
    overrides: {
      ...overrides,
      tmux_mode: parsed.tmuxMode,
      command_template: parsed.commandTemplate || null,
      active: parsed.tmuxMode ? false : true,
    },
  });
}
