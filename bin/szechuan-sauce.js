#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { launchDetachedLoop } from '../lib/detached-launch.js';
import { prepareSzechuanSaucePhase } from '../lib/pipeline-phase-setup.js';

function parseArgs(argv) {
  let focus = null;
  let focusSpecified = false;
  let domain = null;
  let domainSpecified = false;
  let dryRun = false;
  let dryRunSpecified = false;
  let stallLimit = 5;
  let stallLimitSpecified = false;
  let maxIterations = null;
  let resume = null;
  const targetParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--focus') {
      focus = argv[i + 1] || '';
      focusSpecified = true;
      i += 1;
    } else if (arg === '--domain') {
      domain = argv[i + 1] || '';
      domainSpecified = true;
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
      dryRunSpecified = true;
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
    focus,
    focusSpecified,
    domain,
    domainSpecified,
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

async function main(argv) {
  const parsed = parseArgs(argv);
  const { setupArgs, loopConfig, sessionCwd } = prepareSzechuanSaucePhase(parsed);

  const output = await launchDetachedLoop({
    setupArgs,
    loopConfig,
    banner: 'Szechuan Sauce tmux loop launched.',
    sessionCwd,
  });
  console.log(output);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
