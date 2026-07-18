import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recoverableHardReset } from './recoverable-git.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';

export type MetricDirection = 'higher' | 'lower';
export type MetricClassification = 'baseline' | 'improved' | 'held' | 'regressed';

export interface MetricMeasurement {
  command: string;
  score: number;
  raw: string;
  measured_at: string;
}

export interface MetricHistoryEntry extends MetricMeasurement {
  iteration: number;
  classification: MetricClassification;
  action: 'baseline' | 'accept' | 'revert';
  head_before: string | null;
  head_after: string | null;
}

export interface MetricConvergenceState {
  schema_version: 1;
  command: string;
  direction: MetricDirection;
  tolerance: number;
  baseline: MetricMeasurement;
  best: MetricMeasurement;
  latest: MetricMeasurement;
  stall_count: number;
  failed_approaches: Array<{
    iteration: number;
    classification: Exclude<MetricClassification, 'baseline' | 'improved'>;
    head: string | null;
    score: number;
  }>;
  history: MetricHistoryEntry[];
}

export interface MeasureMetricOptions {
  cwd: string;
  timeoutMs?: number;
  shell?: string;
}

export interface MetricIterationCheckpoint {
  head: string;
  untracked: string[];
}

export class MetricMutationError extends Error {
  constructor() {
    super('Metric command modified the target repository; metric commands must be read-only.');
    this.name = 'MetricMutationError';
  }
}

function convergencePath(sessionDir: string): string {
  return path.join(sessionDir, 'microverse-metrics.json');
}

function parseFiniteScore(output: string): number {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('Metric command produced no output; expected one finite numeric score.');
  }
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    throw new Error(`Metric command output must be exactly one finite numeric score; received: ${JSON.stringify(trimmed)}`);
  }
  const score = Number(trimmed);
  if (!Number.isFinite(score)) {
    throw new Error(`Metric command produced a non-finite score: ${trimmed}`);
  }
  return score;
}

export function normalizeMetricDirection(value: unknown): MetricDirection {
  if (value === 'higher' || value === 'lower') return value;
  throw new Error(`Metric direction must be "higher" or "lower"; received ${JSON.stringify(value)}.`);
}

export function normalizeMetricTolerance(value: unknown): number {
  const tolerance = value == null ? 0 : Number(value);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`Metric tolerance must be a non-negative finite number; received ${JSON.stringify(value)}.`);
  }
  return tolerance;
}

export function measureMetric(command: string, options: MeasureMetricOptions): MetricMeasurement {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('A non-empty metric command is required.');
  }
  const before = repositoryFingerprint(options.cwd);
  const shell = options.shell || process.env.SHELL || '/bin/sh';
  const result = spawnSync(shell, ['-lc', command], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  const after = repositoryFingerprint(options.cwd);
  if (before !== null && after !== before) {
    throw new MetricMutationError();
  }
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new Error(timedOut
      ? `Metric command timed out after ${options.timeoutMs ?? 120_000}ms.`
      : `Metric command failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Metric command exited ${result.status}${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  const raw = String(result.stdout || '').trim();
  return {
    command: command.trim(),
    score: parseFiniteScore(raw),
    raw,
    measured_at: new Date().toISOString(),
  };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`git ${args.join(' ')} failed${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  return String(result.stdout || '').trim();
}

function untrackedPaths(cwd: string): string[] {
  const output = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return output.split('\0').filter(Boolean).sort();
}

function repositoryFingerprint(cwd: string): string | null {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (probe.status !== 0 || String(probe.stdout).trim() !== 'true') return null;
  return `${runGit(cwd, ['rev-parse', 'HEAD'])}\n${runGit(cwd, ['status', '--porcelain=v1', '-z'])}`;
}

export function anchorMetricIterationRecovery(cwd: string, sessionDir: string, sha: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error('Cannot anchor metric recovery: invalid HEAD.');
  }
  const session = path.basename(sessionDir).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!session) throw new Error('Cannot anchor metric recovery: invalid session identifier.');
  const ref = `refs/pickle/microverse-recovery/${session}`;
  runGit(cwd, ['update-ref', ref, sha]);
  return ref;
}

export function captureMetricIterationCheckpoint(cwd: string): MetricIterationCheckpoint {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (status.trim()) {
    throw new Error('Microverse metric iterations require a completely clean working tree.');
  }
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  if (!head) throw new Error('Microverse metric iterations require a repository with an existing HEAD commit.');
  return { head, untracked: untrackedPaths(cwd) };
}

export function revertMetricIteration(cwd: string, checkpoint: MetricIterationCheckpoint, sessionDir: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(checkpoint.head)) {
    throw new Error('Cannot revert metric iteration: invalid checkpoint HEAD.');
  }
  recoverableHardReset({
    workingDir: cwd,
    sessionDir,
    targetHead: checkpoint.head,
    operation: 'microverse-revert',
    preserveUntracked: checkpoint.untracked,
    headRecoveryRef: `refs/pickle/microverse-recovery/${path.basename(sessionDir).replace(/[^a-zA-Z0-9._-]/g, '-')}`,
  });
}

export function classifyMetric(
  current: number,
  previousBest: number,
  direction: MetricDirection,
  tolerance: number,
): Exclude<MetricClassification, 'baseline'> {
  if (![current, previousBest, tolerance].every(Number.isFinite) || tolerance < 0) {
    throw new Error('Metric comparison requires finite scores and a non-negative tolerance.');
  }
  const delta = direction === 'higher' ? current - previousBest : previousBest - current;
  if (delta > tolerance) return 'improved';
  if (delta < -tolerance) return 'regressed';
  return 'held';
}

export function createMetricConvergenceState(
  baseline: MetricMeasurement,
  direction: MetricDirection,
  tolerance: number,
): MetricConvergenceState {
  return {
    schema_version: 1,
    command: baseline.command,
    direction,
    tolerance,
    baseline,
    best: baseline,
    latest: baseline,
    stall_count: 0,
    failed_approaches: [],
    history: [{
      ...baseline,
      iteration: 0,
      classification: 'baseline',
      action: 'baseline',
      head_before: null,
      head_after: null,
    }],
  };
}

function assertStateShape(value: unknown): MetricConvergenceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid microverse metric state: expected an object.');
  }
  const state = value as MetricConvergenceState;
  if (state.schema_version !== 1 || typeof state.command !== 'string') {
    throw new Error('Invalid microverse metric state: unsupported schema or command.');
  }
  normalizeMetricDirection(state.direction);
  normalizeMetricTolerance(state.tolerance);
  if (!Number.isFinite(state.baseline?.score) || !Number.isFinite(state.best?.score) || !Number.isFinite(state.latest?.score)) {
    throw new Error('Invalid microverse metric state: baseline, best, and latest scores must be finite.');
  }
  if (!Array.isArray(state.history) || !Array.isArray(state.failed_approaches)) {
    throw new Error('Invalid microverse metric state: history arrays are required.');
  }
  return state;
}

export function readMetricConvergenceState(sessionDir: string): MetricConvergenceState | null {
  const filePath = convergencePath(sessionDir);
  if (!fs.existsSync(filePath)) return null;
  return assertStateShape(readJsonFile(filePath, null));
}

export function writeMetricConvergenceState(sessionDir: string, state: MetricConvergenceState): void {
  atomicWriteJson(convergencePath(sessionDir), assertStateShape(state));
}

export function recordMetricIteration(
  state: MetricConvergenceState,
  measurement: MetricMeasurement,
  options: {
    iteration: number;
    headBefore: string | null;
    headAfter: string | null;
    classificationOverride?: Exclude<MetricClassification, 'baseline'>;
  },
): { state: MetricConvergenceState; classification: Exclude<MetricClassification, 'baseline'> } {
  if (measurement.command !== state.command) {
    throw new Error('Metric command changed during a convergence session; start a new session instead.');
  }
  const classification = options.classificationOverride ?? classifyMetric(
    measurement.score,
    state.best.score,
    state.direction,
    state.tolerance,
  );
  const action = classification === 'improved' ? 'accept' : 'revert';
  const entry: MetricHistoryEntry = {
    ...measurement,
    iteration: options.iteration,
    classification,
    action,
    head_before: options.headBefore,
    head_after: options.headAfter,
  };
  const next: MetricConvergenceState = {
    ...state,
    best: classification === 'improved' ? measurement : state.best,
    latest: measurement,
    stall_count: classification === 'improved' ? 0 : state.stall_count + 1,
    failed_approaches: classification === 'improved'
      ? state.failed_approaches
      : [...state.failed_approaches, {
        iteration: options.iteration,
        classification,
        head: options.headAfter,
        score: measurement.score,
      }],
    history: [...state.history, entry],
  };
  return { state: next, classification };
}
