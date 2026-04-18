#!/usr/bin/env node
import { launchDetachedLoop } from '../lib/detached-launch.js';

function parseArgs(argv) {
  let metric = null;
  let metricSpecified = false;
  let goal = null;
  let goalSpecified = false;
  let task = null;
  let taskSpecified = false;
  let direction = 'higher';
  let directionSpecified = false;
  let stallLimit = 5;
  let stallLimitSpecified = false;
  let maxIterations = null;
  let resume = null;

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

  return {
    metric,
    metricSpecified,
    goal,
    goalSpecified,
    task,
    taskSpecified,
    direction,
    directionSpecified,
    stallLimit,
    stallLimitSpecified,
    maxIterations,
    resume,
  };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const setupArgs = ['--tmux', '--command-template', 'microverse.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
    if (parsed.resume !== '__LAST__') {
      setupArgs.push(parsed.resume);
    }
  } else {
    if (Number.isInteger(parsed.maxIterations)) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', parsed.task);
  }

  const loopConfig = {
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
