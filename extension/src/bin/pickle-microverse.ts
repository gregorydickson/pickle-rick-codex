#!/usr/bin/env node
import { launchDetachedLoop } from '../services/detached-launch.js';
import { normalizeMetricTargetContract } from '../services/metric-convergence.js';

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
  target: number | null;
  targetSpecified: boolean;
  targetRelation: string | null;
  targetRelationSpecified: boolean;
  protectedPaths: string[];
  protectedPathsSpecified: boolean;
  workerFailureLimit: number;
  workerFailureLimitSpecified: boolean;
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
  let target: number | null = null;
  let targetSpecified = false;
  let targetRelation: string | null = null;
  let targetRelationSpecified = false;
  const protectedPaths: string[] = [];
  let protectedPathsSpecified = false;
  let workerFailureLimit = 3;
  let workerFailureLimitSpecified = false;
  let tolerance = 0;
  let toleranceSpecified = false;
  let metricTimeoutSeconds = 120;
  let metricTimeoutSpecified = false;
  let stallLimit = 8;
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
    } else if (arg === '--target') {
      target = Number(argv[i + 1] ?? '');
      targetSpecified = true;
      i += 1;
    } else if (arg === '--target-relation') {
      targetRelation = argv[i + 1] || '';
      targetRelationSpecified = true;
      i += 1;
    } else if (arg === '--protected-path') {
      protectedPaths.push(argv[i + 1] || '');
      protectedPathsSpecified = true;
      i += 1;
    } else if (arg === '--worker-failure-limit') {
      workerFailureLimit = Number(argv[i + 1] || '0');
      workerFailureLimitSpecified = true;
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
      stallLimit = Number(argv[i + 1] || '8');
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
  const targetContract = normalizeMetricTargetContract(direction, target, targetRelation);
  if (!resume && targetContract.target !== null && !metric) {
    throw new Error('--target requires --metric; free-form --goal sessions do not produce a runtime score.');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('--tolerance must be a non-negative finite number');
  }
  if (!Number.isFinite(metricTimeoutSeconds) || metricTimeoutSeconds <= 0) {
    throw new Error('--metric-timeout must be a positive number of seconds');
  }
  if (protectedPaths.some((entry) => !entry.trim())) {
    throw new Error('--protected-path requires a non-empty repository-relative path or glob');
  }
  if (!Number.isInteger(workerFailureLimit) || workerFailureLimit <= 0) {
    throw new Error('--worker-failure-limit must be a positive integer');
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
    target: targetContract.target,
    targetSpecified,
    targetRelation: targetContract.target_relation,
    targetRelationSpecified,
    protectedPaths,
    protectedPathsSpecified,
    workerFailureLimit,
    workerFailureLimitSpecified,
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
  // Microverse owns target completion and recovery. A wall-clock default can
  // stop a healthy experiment before the metric converges, so sessions are
  // deliberately unbounded in time; stalls and ordinary worker failures are
  // recovery signals rather than terminal conditions.
  const setupArgs = [
    '--tmux',
    '--command-template',
    'microverse.md',
    '--max-time',
    '0',
    '--max-iterations',
    String(parsed.maxIterations ?? 0),
  ];
  if (parsed.resume) {
    setupArgs.push('--resume');
    if (parsed.resume !== '__LAST__') {
      setupArgs.push(parsed.resume);
    }
  } else {
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
  if (parsed.targetSpecified && parsed.target !== null) {
    loopConfig.target = parsed.target;
  }
  if (parsed.targetRelationSpecified) {
    loopConfig.target_relation = parsed.targetRelation;
  }
  if (!parsed.resume || parsed.protectedPathsSpecified) {
    loopConfig.protected_paths = parsed.protectedPaths;
  }
  if (!parsed.resume || parsed.workerFailureLimitSpecified) {
    loopConfig.worker_failure_limit = parsed.workerFailureLimit;
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
