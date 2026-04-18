#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { launchDetachedLoop } from '../lib/detached-launch.js';

function parseArgs(argv) {
  let dryRun = false;
  let dryRunSpecified = false;
  let stallLimit = 3;
  let stallLimitSpecified = false;
  let maxIterations = null;
  let resume = null;
  const targetParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      dryRunSpecified = true;
    } else if (arg === '--stall-limit') {
      stallLimit = Number(argv[i + 1] || '3');
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
    } else {
      targetParts.push(arg);
    }
  }

  const target = targetParts.join(' ').trim() || process.cwd();
  const targetSpecified = targetParts.length > 0;
  if (!resume && !fs.existsSync(path.resolve(target))) {
    throw new Error(`Target not found: ${target}`);
  }

  return {
    dryRun,
    dryRunSpecified,
    stallLimit,
    stallLimitSpecified,
    maxIterations,
    resume,
    target,
    targetSpecified,
  };
}

function resolveSessionCwd(target) {
  const resolvedTarget = fs.realpathSync(path.resolve(target));
  return fs.statSync(resolvedTarget).isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const sessionCwd = parsed.resume ? null : resolveSessionCwd(parsed.target);
  const setupArgs = ['--tmux', '--command-template', 'anatomy-park.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
    if (parsed.resume !== '__LAST__') {
      setupArgs.push(parsed.resume);
    }
  } else {
    if (Number.isInteger(parsed.maxIterations)) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', `Anatomy Park: deep review ${parsed.target}`);
  }

  const loopConfig = {
    mode: 'anatomy-park',
  };
  if (!parsed.resume || parsed.targetSpecified) {
    loopConfig.target = path.resolve(parsed.target);
  }
  if (!parsed.resume || parsed.dryRunSpecified) {
    loopConfig.dry_run = parsed.dryRun;
  }
  if (!parsed.resume || parsed.stallLimitSpecified) {
    loopConfig.stall_limit = parsed.stallLimit;
  }

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig,
    banner: 'Anatomy Park tmux loop launched.',
    sessionCwd,
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
