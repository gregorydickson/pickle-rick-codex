import fs from 'node:fs';
import path from 'node:path';
import { appendHistory, markRunStart } from './session.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { setupSession } from './setup-session.js';
import { StateManager, type PersistedState } from './state-manager.js';
import { finalizeTerminalStateObject } from './state-terminal.js';
import type { PipelineContract } from '../types/index.js';

interface LoopConfig {
  mode: string;
  target?: string;
  [key: string]: unknown;
}

interface LoopPhaseField {
  key: string;
  value: unknown;
  specified?: boolean;
}

interface BuildLoopPhaseSetupOptions {
  mode: string;
  resume?: string | null;
  maxIterations?: number | null;
  task: string;
  commandTemplate: string;
  target?: string | null;
  targetSpecified?: boolean;
  fields?: LoopPhaseField[];
}

interface LoopPhaseSetup {
  setupArgs: string[];
  loopConfig: LoopConfig;
  sessionCwd: string | null;
}

interface AnatomyParkParsed {
  resume?: string | null;
  maxIterations?: number | null;
  target: string;
  targetSpecified?: boolean;
  dryRun?: boolean;
  dryRunSpecified?: boolean;
  stallLimit?: number | null;
  stallLimitSpecified?: boolean;
}

interface SzechuanSauceParsed {
  resume?: string | null;
  maxIterations?: number | null;
  target: string;
  targetSpecified?: boolean;
  focus?: string | null;
  focusSpecified?: boolean;
  domain?: string | null;
  domainSpecified?: boolean;
  dryRun?: boolean;
  dryRunSpecified?: boolean;
  stallLimit?: number | null;
  stallLimitSpecified?: boolean;
}

export function resolveLoopTargetCwd(target: string): string {
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
}: BuildLoopPhaseSetupOptions): LoopPhaseSetup {
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

  const loopConfig: LoopConfig = { mode };
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

export function prepareAnatomyParkPhase(parsed: AnatomyParkParsed): LoopPhaseSetup {
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

export function preparePipelineAnatomyParkPhase(pipeline: PipelineContract): LoopPhaseSetup {
  const anatomy = pipeline.anatomy || {};
  return prepareAnatomyParkPhase({
    dryRun: Boolean(anatomy.dry_run),
    dryRunSpecified: Object.hasOwn(anatomy, 'dry_run'),
    stallLimit: Number.isInteger(anatomy.stall_limit) ? (anatomy.stall_limit as number) : 3,
    stallLimitSpecified: Object.hasOwn(anatomy, 'stall_limit'),
    maxIterations: Number.isInteger(anatomy.max_iterations) ? (anatomy.max_iterations as number) : null,
    resume: null,
    target: pipeline.target,
    targetSpecified: true,
  });
}

export function preparePipelineSzechuanSaucePhase(pipeline: PipelineContract): LoopPhaseSetup {
  const szechuan = pipeline.szechuan || {};
  return prepareSzechuanSaucePhase({
    focus: typeof szechuan.focus === 'string' ? szechuan.focus : null,
    focusSpecified: Object.hasOwn(szechuan, 'focus'),
    domain: typeof szechuan.domain === 'string' ? szechuan.domain : null,
    domainSpecified: Object.hasOwn(szechuan, 'domain'),
    dryRun: Boolean(szechuan.dry_run),
    dryRunSpecified: Object.hasOwn(szechuan, 'dry_run'),
    stallLimit: Number.isInteger(szechuan.stall_limit) ? (szechuan.stall_limit as number) : 5,
    stallLimitSpecified: Object.hasOwn(szechuan, 'stall_limit'),
    maxIterations: Number.isInteger(szechuan.max_iterations) ? (szechuan.max_iterations as number) : null,
    resume: null,
    target: pipeline.target,
    targetSpecified: true,
  });
}

export function prepareSzechuanSaucePhase(parsed: SzechuanSauceParsed): LoopPhaseSetup {
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

export function readLoopConfig(sessionDir: string): LoopConfig {
  const config = readJsonFile<LoopConfig>(path.join(sessionDir, 'loop_config.json'), null);
  if (!config || !config.mode) {
    throw new Error(`Missing loop_config.json in ${sessionDir}`);
  }
  return config;
}

export async function preparePipelineLoopPhaseSession(
  sessionDir: string,
  pipeline: PipelineContract,
  preparePhase: (pipeline: PipelineContract) => LoopPhaseSetup,
  allowedPaths: string[],
): Promise<LoopConfig> {
  const { setupArgs, loopConfig } = preparePhase(pipeline);
  await setupSession(['--resume', sessionDir, ...setupArgs], {
    cwd: pipeline.working_dir,
    updateSessionMap: false,
  });
  loopConfig.allowed_paths = [...allowedPaths];
  atomicWriteJson(path.join(sessionDir, 'loop_config.json'), loopConfig);
  return loopConfig;
}

export function enterLoopRunnerPhase(
  manager: StateManager,
  statePath: string,
  loopMode: string,
): PersistedState {
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
    appendHistory(state, `${loopMode}_runner_start`, (state.current_ticket as string | null) || undefined);
    return state;
  });
}

export function exitLoopRunnerPhase(
  manager: StateManager,
  statePath: string,
  exitReason: string,
): string {
  const state = manager.update(statePath, (current) => {
    const finalReason = finalizeTerminalStateObject(current, { exitReason });
    current.step = finalReason === 'success' ? 'complete' : 'paused';
    appendHistory(current, finalReason === 'success' ? 'complete' : finalReason, (current.current_ticket as string | null) || undefined);
    return current;
  });
  return state.last_exit_reason as string;
}
