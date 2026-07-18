#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Phase 0 keeps exactly two tiers: pure unit modules (`fast`) and the giants that
// shell out to compiled bin + fake codex/tmux (`integration`). No expensive/contract tier.
const VALID_TIERS = new Set<Tier>(['fast', 'integration']);

type Tier = 'fast' | 'integration';

interface ParsedArgs {
  dryRun: boolean;
  runnerArgs: string[];
  testFiles: string[];
  tier: Tier | null;
}

// node:test does NOT auto-cap an explicit --test-concurrency, so a hardcoded value
// oversubscribes a low-core runner. Clamp (never raise) the requested concurrency to
// the available cores so a caller-requested c=8 stays c=8 on a capable box but drops to
// the core count on a constrained one.
export function clampTestConcurrency(requested: number): number {
  const cap = Math.max(1, availableParallelism());
  if (!Number.isFinite(requested) || requested < 1) {
    return 1;
  }
  return Math.min(Math.floor(requested), cap);
}

function clampConcurrencyArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inlineMatch = /^--test-concurrency=(\d+)$/.exec(arg);
    if (inlineMatch) {
      out.push(`--test-concurrency=${clampTestConcurrency(Number(inlineMatch[1]))}`);
      continue;
    }
    if (arg === '--test-concurrency' && /^\d+$/.test(args[index + 1] ?? '')) {
      out.push(arg, String(clampTestConcurrency(Number(args[index + 1]))));
      index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function exitWithError(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function requireArgValue(args: string[], index: number, flag: string, code = 2): string {
  const value = args[index + 1];
  if (!value) {
    exitWithError(`Missing value for ${flag}`, code);
  }
  return value;
}

function parseTier(value: string): Tier {
  if (VALID_TIERS.has(value as Tier)) {
    return value as Tier;
  }
  exitWithError(`Unknown tier: ${value} (valid: fast, integration)`, 2);
}

function parseArgs(args: string[]): ParsedArgs {
  const runnerArgs: string[] = [];
  const testFiles: string[] = [];
  let dryRun = false;
  let tier: Tier | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--tier':
        tier = parseTier(requireArgValue(args, index, '--tier'));
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        if (arg.startsWith('--')) {
          runnerArgs.push(arg);
        } else {
          testFiles.push(arg);
        }
        break;
    }
  }

  if (tier && testFiles.length > 0) {
    exitWithError('--tier cannot be combined with positional test files', 2);
  }

  return { dryRun, runnerArgs, testFiles, tier };
}

function normalizeTestPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function discoverTestFiles(dir: string, rootDir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return discoverTestFiles(fullPath, rootDir);
      }
      if (!entry.isFile() || !entry.name.endsWith('.test.js')) {
        return [];
      }
      return [normalizeTestPath(path.relative(rootDir, fullPath))];
    })
    .sort();
}

function firstMeaningfulLine(filePath: string): string {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#!')) {
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    return line.trim();
  }
  return '';
}

function tierForTestFile(filePath: string): string | null {
  const match = firstMeaningfulLine(filePath).match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
  return match?.[1] ?? null;
}

function discoverTierFiles(rootDir: string, tier: Tier): string[] {
  const testsDir = path.join(rootDir, 'tests');
  return discoverTestFiles(testsDir, rootDir).filter(
    (relativePath) => tierForTestFile(path.join(rootDir, relativePath)) === tier,
  );
}

function main(): never {
  const { dryRun, runnerArgs, testFiles, tier } = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  const selectedFiles = tier ? discoverTierFiles(rootDir, tier) : testFiles;

  if (tier && selectedFiles.length === 0) {
    process.stderr.write(`[no files for tier ${tier}]\n`);
    process.exit(1);
  }

  if (dryRun) {
    if (selectedFiles.length > 0) {
      process.stdout.write(`${selectedFiles.join('\n')}\n`);
    }
    process.exit(0);
  }

  const nodeArgs = ['--test', ...clampConcurrencyArgs(runnerArgs), ...selectedFiles];
  const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });

  if (result.error) {
    exitWithError(result.error.message, 1);
  }

  process.exit(result.status ?? 1);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
