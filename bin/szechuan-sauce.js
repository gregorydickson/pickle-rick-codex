#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { launchDetachedLoop } from '../lib/detached-launch.js';

function parseArgs(argv) {
  let focus = null;
  let domain = null;
  let dryRun = false;
  let stallLimit = 5;
  let maxIterations = null;
  let resume = false;
  const targetParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--focus') {
      focus = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--domain') {
      domain = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--stall-limit') {
      stallLimit = Number(argv[i + 1] || '5');
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

  return { focus, domain, dryRun, stallLimit, maxIterations, resume, target };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const setupArgs = ['--tmux', '--command-template', 'szechuan-sauce.md'];
  if (parsed.resume) {
    setupArgs.push('--resume');
  } else {
    if (parsed.maxIterations) setupArgs.push('--max-iterations', String(parsed.maxIterations));
    setupArgs.push('--task', `Szechuan Sauce: deslop ${parsed.target}`);
  }

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig: {
      mode: 'szechuan-sauce',
      target: path.resolve(parsed.target),
      focus: parsed.focus,
      domain: parsed.domain,
      dry_run: parsed.dryRun,
      stall_limit: parsed.stallLimit,
    },
    banner: 'Szechuan Sauce tmux loop launched.',
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
