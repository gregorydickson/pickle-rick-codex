#!/usr/bin/env node
import { launchDetachedLoop } from '../services/detached-launch.js';

type DetachedLoopConfig = Parameters<typeof launchDetachedLoop>[0]['loopConfig'];

interface MicroverseArgs {
  metric: string | null;
  metricSpecified: boolean;
  goal: string | null;
  goalSpecified: boolean;
  task: string | null;
  taskSpecified: boolean;
  direction: string;
  directionSpecified: boolean;
  tolerance: number;
  toleranceSpecified: boolean;
  metricTimeoutSeconds: number;
  metricTimeoutSpecified: boolean;
  stallLimit: number;
  stallLimitSpecified: boolean;
  maxIterations: number | null;
  resume: string | null;
}

function parseArgs(argv: string[]): MicroverseArgs {
  let metric: string | null = null;
  let metricSpecified = false;
  let goal: string | null = null;
  let goalSpecified = false;
  let task: string | null = null;
  let taskSpecified = false;
  let direction = 'higher';
  let directionSpecified = false;
  let tolerance = 0;
  let toleranceSpecified = false;
  let metricTimeoutSeconds = 120;
  let metricTimeoutSpecified = false;
  let stallLimit = 5;
  let stallLimitSpecified = false;
  let maxIterations: number | null = null;
  let resume: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--metric') {
      metric = argv[i + 1] || '';
      metricSpecified = true;
      i += 1;
    } else if (arg === '--goal') {
      goal = argv[i + 1] || '';
      goalSpecified = true;
      i += 1;
    } else if (arg === '--task') {
      task = argv[i + 1] || '';
      taskSpecified = true;
      i += 1;
    } else if (arg === '--direction') {
      direction = argv[i + 1] || 'higher';
      directionSpecified = true;
      i += 1;
    } else if (arg === '--tolerance') {
      tolerance = Number(argv[i + 1] || '0');
      toleranceSpecified = true;
      i += 1;
    } else if (arg === '--metric-timeout') {
      metricTimeoutSeconds = Number(argv[i + 1] || '120');
      metricTimeoutSpecified = true;
      i += 1;
    } else if (arg === '--stall-limit') {
      stallLimit = Number(argv[i + 1] || '5');
      stallLimitSpecified = true;
      i += 1;
    } else if (arg === '--max-iterations') {
      maxIterations = Number(argv[i + 1] || '0');
      i += 1;
    } else if (arg === '--resume') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        resume = next;
        i += 1;
      } else {
        resume = '__LAST__';
      }
    }
  }

  if (!resume) {
    if ((!metric && !goal) || (metric && goal)) {
      throw new Error('Use exactly one of --metric or --goal');
    }
    if (!task) {
      throw new Error('--task is required unless resuming');
    }
  }
  if (direction !== 'higher' && direction !== 'lower') {
    throw new Error('--direction must be higher or lower');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('--tolerance must be a non-negative finite number');
  }
  if (!Number.isFinite(metricTimeoutSeconds) || metricTimeoutSeconds <= 0) {
    throw new Error('--metric-timeout must be a positive number of seconds');
  }

  return {
    metric,
    metricSpecified,
    goal,
    goalSpecified,
    task,
    taskSpecified,
    direction,
    directionSpecified,
    tolerance,
    toleranceSpecified,
    metricTimeoutSeconds,
    metricTimeoutSpecified,
    stallLimit,
    stallLimitSpecified,
    maxIterations,
    resume,
  };
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const setupArgs = ['--tmux', '--command-template', 'microverse.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
    if (parsed.resume !== '__LAST__') {
      setupArgs.push(parsed.resume);
    }
  } else {
    if (Number.isInteger(parsed.maxIterations)) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', parsed.task ?? '');
  }

  const loopConfig: DetachedLoopConfig = {
    mode: 'microverse',
  };
  if (!parsed.resume || parsed.taskSpecified) {
    loopConfig.task = parsed.task;
  }
  if (!parsed.resume || parsed.metricSpecified) {
    loopConfig.metric = parsed.metric;
  }
  if (!parsed.resume || parsed.goalSpecified) {
    loopConfig.goal = parsed.goal;
  }
  if (!parsed.resume || parsed.directionSpecified) {
    loopConfig.direction = parsed.direction;
  }
  if (!parsed.resume || parsed.toleranceSpecified) {
    loopConfig.tolerance = parsed.tolerance;
  }
  if (!parsed.resume || parsed.metricTimeoutSpecified) {
    loopConfig.metric_timeout_seconds = parsed.metricTimeoutSeconds;
  }
  if (!parsed.resume || parsed.stallLimitSpecified) {
    loopConfig.stall_limit = parsed.stallLimit;
  }

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig,
    banner: 'Pickle Rick microverse tmux loop launched.',
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
