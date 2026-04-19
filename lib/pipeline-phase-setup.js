import fs from 'node:fs';
import path from 'node:path';
import { appendHistory, markRunStart } from './session.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { setupSession } from './setup-session.js';

export function resolveLoopTargetCwd(target) {
  const resolvedTarget = fs.realpathSync(path.resolve(target));
  return fs.statSync(resolvedTarget).isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
}

export function buildLoopPhaseSetup({
  mode,
  resume = null,
  maxIterations = null,
  task,
  commandTemplate,
  target = null,
  targetSpecified = false,
  fields = [],
} = {}) {
  const setupArgs = ['--tmux', '--command-template', commandTemplate];
  if (resume) {
    setupArgs.push('--resume');
    if (resume !== '__LAST__') {
      setupArgs.push(resume);
    }
  } else {
    if (Number.isInteger(maxIterations)) {
      setupArgs.push('--max-iterations', String(maxIterations));
    }
    setupArgs.push('--task', task);
  }

  const loopConfig = { mode };
  if (target && (!resume || targetSpecified)) {
    loopConfig.target = path.resolve(target);
  }
  for (const field of fields) {
    if (!resume || field.specified) {
      loopConfig[field.key] = field.value;
    }
  }

  return {
    setupArgs,
    loopConfig,
    sessionCwd: resume ? null : resolveLoopTargetCwd(target || process.cwd()),
  };
}

export function prepareAnatomyParkPhase(parsed) {
  return buildLoopPhaseSetup({
    mode: 'anatomy-park',
    resume: parsed.resume,
    maxIterations: parsed.maxIterations,
    task: `Anatomy Park: deep review ${parsed.target}`,
    commandTemplate: 'anatomy-park.md',
    target: parsed.target,
    targetSpecified: parsed.targetSpecified,
    fields: [
      { key: 'dry_run', value: parsed.dryRun, specified: parsed.dryRunSpecified },
      { key: 'stall_limit', value: parsed.stallLimit, specified: parsed.stallLimitSpecified },
    ],
  });
}

export function preparePipelineAnatomyParkPhase(pipeline) {
  const anatomy = pipeline.anatomy || {};
  return prepareAnatomyParkPhase({
    dryRun: Boolean(anatomy.dry_run),
    dryRunSpecified: Object.hasOwn(anatomy, 'dry_run'),
    stallLimit: Number.isInteger(anatomy.stall_limit) ? anatomy.stall_limit : 3,
    stallLimitSpecified: Object.hasOwn(anatomy, 'stall_limit'),
    maxIterations: Number.isInteger(anatomy.max_iterations) ? anatomy.max_iterations : null,
    resume: null,
    target: pipeline.target,
    targetSpecified: true,
  });
}

export function preparePipelineSzechuanSaucePhase(pipeline) {
  const szechuan = pipeline.szechuan || {};
  return prepareSzechuanSaucePhase({
    focus: typeof szechuan.focus === 'string' ? szechuan.focus : null,
    focusSpecified: Object.hasOwn(szechuan, 'focus'),
    domain: typeof szechuan.domain === 'string' ? szechuan.domain : null,
    domainSpecified: Object.hasOwn(szechuan, 'domain'),
    dryRun: Boolean(szechuan.dry_run),
    dryRunSpecified: Object.hasOwn(szechuan, 'dry_run'),
    stallLimit: Number.isInteger(szechuan.stall_limit) ? szechuan.stall_limit : 5,
    stallLimitSpecified: Object.hasOwn(szechuan, 'stall_limit'),
    maxIterations: Number.isInteger(szechuan.max_iterations) ? szechuan.max_iterations : null,
    resume: null,
    target: pipeline.target,
    targetSpecified: true,
  });
}

export function prepareSzechuanSaucePhase(parsed) {
  return buildLoopPhaseSetup({
    mode: 'szechuan-sauce',
    resume: parsed.resume,
    maxIterations: parsed.maxIterations,
    task: `Szechuan Sauce: deslop ${parsed.target}`,
    commandTemplate: 'szechuan-sauce.md',
    target: parsed.target,
    targetSpecified: parsed.targetSpecified,
    fields: [
      { key: 'focus', value: parsed.focus, specified: parsed.focusSpecified },
      { key: 'domain', value: parsed.domain, specified: parsed.domainSpecified },
      { key: 'dry_run', value: parsed.dryRun, specified: parsed.dryRunSpecified },
      { key: 'stall_limit', value: parsed.stallLimit, specified: parsed.stallLimitSpecified },
    ],
  });
}

export function readLoopConfig(sessionDir) {
  const config = readJsonFile(path.join(sessionDir, 'loop_config.json'), null);
  if (!config || !config.mode) {
    throw new Error(`Missing loop_config.json in ${sessionDir}`);
  }
  return config;
}

export async function preparePipelineLoopPhaseSession(sessionDir, pipeline, preparePhase) {
  const { setupArgs, loopConfig } = preparePhase(pipeline);
  await setupSession(['--resume', sessionDir, ...setupArgs], {
    cwd: pipeline.working_dir,
    updateSessionMap: false,
  });
  atomicWriteJson(path.join(sessionDir, 'loop_config.json'), loopConfig);
  return loopConfig;
}

export function enterLoopRunnerPhase(manager, statePath, loopMode) {
  return manager.update(statePath, (state) => {
    state.active = true;
    state.tmux_runner_pid = process.pid;
    state.step = loopMode;
    state.last_exit_reason = null;
    state.cancel_requested_at = null;
    state.loop_mode = loopMode;
    state.loop_stall_count = 0;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    markRunStart(state);
    appendHistory(state, `${loopMode}_runner_start`, state.current_ticket || undefined);
    return state;
  });
}

export function exitLoopRunnerPhase(manager, statePath, exitReason) {
  const state = manager.update(statePath, (current) => {
    const finalReason = current.active === false && current.last_exit_reason
      ? current.last_exit_reason
      : exitReason;
    current.active = false;
    current.tmux_runner_pid = null;
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.last_exit_reason = finalReason;
    current.step = finalReason === 'success' ? 'complete' : 'paused';
    appendHistory(current, finalReason === 'success' ? 'complete' : finalReason, current.current_ticket || undefined);
    return current;
  });
  return state.last_exit_reason;
}
