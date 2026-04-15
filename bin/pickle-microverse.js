#!/usr/bin/env node
import { launchDetachedLoop } from '../lib/detached-launch.js';

function parseArgs(argv) {
  let metric = null;
  let goal = null;
  let task = null;
  let direction = 'higher';
  let stallLimit = 5;
  let maxIterations = null;
  let resume = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--metric') {
      metric = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--goal') {
      goal = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--task') {
      task = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--direction') {
      direction = argv[i + 1] || 'higher';
      i += 1;
    } else if (arg === '--stall-limit') {
      stallLimit = Number(argv[i + 1] || '5');
      i += 1;
    } else if (arg === '--max-iterations') {
      maxIterations = Number(argv[i + 1] || '0');
      i += 1;
    } else if (arg === '--resume') {
      resume = true;
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

  return { metric, goal, task, direction, stallLimit, maxIterations, resume };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const setupArgs = ['--tmux', '--command-template', 'microverse.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
  } else {
    if (parsed.maxIterations) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', parsed.task);
  }

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig: {
      mode: 'microverse',
      task: parsed.task,
      metric: parsed.metric,
      goal: parsed.goal,
      direction: parsed.direction,
      stall_limit: parsed.stallLimit,
    },
    banner: 'Pickle Rick microverse tmux loop launched.',
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
