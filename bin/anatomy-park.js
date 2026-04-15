#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { launchDetachedLoop } from '../lib/detached-launch.js';

function parseArgs(argv) {
  let dryRun = false;
  let stallLimit = 3;
  let maxIterations = null;
  let resume = false;
  const targetParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--stall-limit') {
      stallLimit = Number(argv[i + 1] || '3');
      i += 1;
    } else if (arg === '--max-iterations') {
      maxIterations = Number(argv[i + 1] || '0');
      i += 1;
    } else if (arg === '--resume') {
      resume = true;
    } else {
      targetParts.push(arg);
    }
  }

  const target = targetParts.join(' ').trim() || process.cwd();
  if (!resume && !fs.existsSync(path.resolve(target))) {
    throw new Error(`Target not found: ${target}`);
  }

  return { dryRun, stallLimit, maxIterations, resume, target };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const setupArgs = ['--tmux', '--command-template', 'anatomy-park.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
  } else {
    if (parsed.maxIterations) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', `Anatomy Park: deep review ${parsed.target}`);
  }

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig: {
      mode: 'anatomy-park',
      target: path.resolve(parsed.target),
      dry_run: parsed.dryRun,
      stall_limit: parsed.stallLimit,
    },
    banner: 'Anatomy Park tmux loop launched.',
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
