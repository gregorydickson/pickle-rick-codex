#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  LEGACY_ADOPTION_FILE,
  adoptActiveLegacyMuxSession,
  launchAdoptedLegacySession,
  runtimeRootMatchesDescriptor,
} from '../services/legacy-session-adoption.js';
import type { LegacyAdoptionRecord } from '../services/legacy-session-adoption.js';
import type { InstalledRuntimeDescriptor } from '../services/durable-supervisor.js';
import { atomicWriteJson, readJsonFile } from '../services/pickle-utils.js';
import {
  adoptionWatchEvidenceHash,
  adoptionWatchStrategyStateLaunched,
  beginAdoptionWatchStrategy,
  createAdoptionWatchTerminalRecoveryState,
  createAdoptionWatchStrategyState,
  finishAdoptionWatchStrategy,
  validateAdoptionWatchStrategyState,
} from '../services/adoption-watch-strategies.js';
import type { AdoptionWatchStrategyId, AdoptionWatchStrategyState } from '../services/adoption-watch-strategies.js';
import {
  archiveAdoptionWatchTerminalState,
  validateAdoptionWatchTerminalRecoveryRefs,
} from '../services/adoption-watch-terminal-recovery.js';
import type { AdoptionWatchTerminalRecoveryRef } from '../services/adoption-watch-terminal-recovery.js';

interface Args {
  command: 'prepare' | 'launch' | 'watch';
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
  validationSessionDir: string;
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
export const LEGACY_ADOPTION_WATCH_STATUS_FILE = 'legacy-session-adoption-watch.json';

export interface LegacyAdoptionWatchFailure {
  kind: 'migration-continuity-failed' | 'runtime-mismatch' | 'ownership-conflict'
    | 'lock-unavailable' | 'launch-failed' | 'watch-status-invalid'
    | 'terminal-inconsistency' | 'adoption-failed';
  name: string;
  message: string;
  recoverable: true;
  first_observed_at: string;
  last_observed_at: string;
}

export interface LegacyAdoptionWatchStatus {
  schema_version: 1;
  status: 'watching' | 'retrying' | 'launched';
  session_id: string;
  watcher_pid: number;
  started_at: string;
  updated_at: string;
  attempt_count: number;
  consecutive_failures: number;
  last_attempt_at: string | null;
  retry_scheduled_at?: string | null;
  next_retry_at: string | null;
  retry_delay_ms: number | null;
  last_failure: LegacyAdoptionWatchFailure | null;
  launched_runtime_root: string | null;
  strategy_state?: AdoptionWatchStrategyState;
  terminal_recovery_refs?: AdoptionWatchTerminalRecoveryRef[];
}

interface LegacyAdoptionWatchDependencies {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  watcherPid?: number;
  adopt?: typeof adoptActiveLegacyMuxSession;
  launch?: typeof launchAdoptedLegacySession;
  chooseRuntime?: typeof chooseLegacyLaunchRuntime;
  runtimeMatches?: typeof runtimeRootMatchesDescriptor;
  executeStrategy?: (strategyId: AdoptionWatchStrategyId) => LegacyAdoptionRecord;
  checkpoint?: (point: 'strategy_persisted') => void;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function legacyAdoptionWatchDelayBounds(options: { baseDelayMs?: number; maxDelayMs?: number } = {}): {
  baseDelayMs: number;
  maxDelayMs: number;
} {
  const maxDelayMs = Math.max(1, finiteNonNegative(options.maxDelayMs ?? 60_000, 60_000));
  const baseDelayMs = Math.min(maxDelayMs, Math.max(1, finiteNonNegative(options.baseDelayMs ?? 1_000, 1_000)));
  return {
    baseDelayMs,
    maxDelayMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

const watchFailureKinds = new Set<LegacyAdoptionWatchFailure['kind']>([
  'migration-continuity-failed', 'runtime-mismatch', 'ownership-conflict', 'lock-unavailable',
  'launch-failed', 'watch-status-invalid', 'terminal-inconsistency', 'adoption-failed',
]);

function invalidWatchStatusReason(
  value: unknown,
  sessionDir: string,
  expectedSessionId: string,
  nowMs: number,
  maxDelayMs: number,
): string | null {
  if (!isRecord(value)) return 'status must be a JSON object';
  if (value.schema_version !== 1) return 'schema_version must equal 1';
  if (!['watching', 'retrying', 'launched'].includes(String(value.status))) return 'status is invalid';
  if (value.session_id !== expectedSessionId) return 'session_id does not match the containing session';
  if (!Number.isInteger(value.watcher_pid) || Number(value.watcher_pid) <= 0) return 'watcher_pid must be a positive integer';
  if (!isIsoTimestamp(value.started_at) || !isIsoTimestamp(value.updated_at)) return 'lifecycle timestamps must be canonical ISO timestamps';
  if (!isNonNegativeInteger(value.attempt_count) || !isNonNegativeInteger(value.consecutive_failures)) {
    return 'attempt counters must be non-negative integers';
  }
  if (value.last_attempt_at !== null && !isIsoTimestamp(value.last_attempt_at)) return 'last_attempt_at must be null or a canonical ISO timestamp';
  if (value.retry_scheduled_at !== undefined && value.retry_scheduled_at !== null
    && !isIsoTimestamp(value.retry_scheduled_at)) return 'retry_scheduled_at must be null or a canonical ISO timestamp';
  if (value.next_retry_at !== null && !isIsoTimestamp(value.next_retry_at)) return 'next_retry_at must be null or a canonical ISO timestamp';
  if (value.retry_delay_ms !== null && (!Number.isInteger(value.retry_delay_ms) || Number(value.retry_delay_ms) < 1)) {
    return 'retry_delay_ms must be null or a positive integer';
  }
  if (typeof value.retry_delay_ms === 'number' && value.retry_delay_ms > maxDelayMs) {
    return 'retry_delay_ms exceeds the configured watchdog backoff cap';
  }
  if (value.launched_runtime_root !== null && typeof value.launched_runtime_root !== 'string') {
    return 'launched_runtime_root must be null or a string';
  }
  if (value.last_failure !== null) {
    if (!isRecord(value.last_failure)
      || !watchFailureKinds.has(value.last_failure.kind as LegacyAdoptionWatchFailure['kind'])
      || typeof value.last_failure.name !== 'string' || !value.last_failure.name
      || typeof value.last_failure.message !== 'string' || !value.last_failure.message
      || value.last_failure.recoverable !== true
      || !isIsoTimestamp(value.last_failure.first_observed_at)
      || !isIsoTimestamp(value.last_failure.last_observed_at)) return 'last_failure is invalid';
  }
  if (value.status === 'retrying' && (Number(value.consecutive_failures) < 1 || value.last_failure === null
    || value.next_retry_at === null || value.retry_delay_ms === null)) return 'retrying status lacks its failure or retry schedule';
  if (value.status === 'retrying') {
    const anchor = value.retry_scheduled_at === undefined || value.retry_scheduled_at === null
      ? value.updated_at : value.retry_scheduled_at;
    if (!isIsoTimestamp(anchor) || !isIsoTimestamp(value.next_retry_at)
      || Date.parse(value.next_retry_at) !== Date.parse(anchor) + Number(value.retry_delay_ms)) {
      return 'next_retry_at does not match its scheduling timestamp plus retry_delay_ms';
    }
    if (Date.parse(value.next_retry_at) - nowMs > maxDelayMs) {
      return 'remaining persisted retry wait exceeds the configured watchdog backoff cap';
    }
  }
  if (value.status !== 'retrying' && (value.next_retry_at !== null || value.retry_delay_ms !== null)) {
    return 'non-retrying status has a retry schedule';
  }
  if (value.status !== 'retrying' && value.retry_scheduled_at !== undefined && value.retry_scheduled_at !== null) {
    return 'non-retrying status has a retry scheduling timestamp';
  }
  if (value.status === 'launched' && Number(value.consecutive_failures) !== 0) return 'launched status has consecutive failures';
  if (value.strategy_state !== undefined) {
    const strategyError = validateAdoptionWatchStrategyState(value.strategy_state);
    if (strategyError) return strategyError;
    const strategy = value.strategy_state as AdoptionWatchStrategyState;
    const strategyLaunched = strategy.history.at(-1)?.outcome === 'launched'
      || (strategy.history.length === 0 && strategy.history_base_checkpoint.launched);
    if (strategyLaunched && value.status !== 'launched') return 'non-launched watch status follows a launched strategy';
  }
  if (value.terminal_recovery_refs !== undefined) {
    const recoveryError = validateAdoptionWatchTerminalRecoveryRefs(sessionDir, value.terminal_recovery_refs);
    if (recoveryError) return recoveryError;
  }
  return null;
}

export function legacyAdoptionWatchDelayMs(
  consecutiveFailures: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number; random?: () => number } = {},
): number {
  const { baseDelayMs: base, maxDelayMs: cap } = legacyAdoptionWatchDelayBounds(options);
  const jitter = Math.min(1, finiteNonNegative(options.jitterRatio ?? 0.2, 0.2));
  const exponent = Math.min(30, Math.max(0, Math.floor(consecutiveFailures) - 1));
  const unjittered = Math.min(cap, base * (2 ** exponent));
  const sample = Math.min(1, Math.max(0, finiteNonNegative((options.random || Math.random)(), 0.5)));
  return Math.min(cap, Math.max(1, Math.round(unjittered * (1 - jitter + (2 * jitter * sample)))));
}

export function classifyLegacyAdoptionWatchFailure(error: unknown): LegacyAdoptionWatchFailure['kind'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/migration continuity|continuity failed|migration manifest|preserved artifact/i.test(message)) {
    return 'migration-continuity-failed';
  }
  if (/runtime hash|runtime descriptor|runtime identity|target runtime/i.test(message)) return 'runtime-mismatch';
  if (/owner|ownership|lease|tmux|runner|active child/i.test(message)) return 'ownership-conflict';
  if (/lock|fence.*available|timed out acquiring/i.test(message)) return 'lock-unavailable';
  if (/launch/i.test(message)) return 'launch-failed';
  return 'adoption-failed';
}

function launchedRecord(sessionDir: string): LegacyAdoptionRecord | null {
  const record = readJsonFile<LegacyAdoptionRecord>(path.join(sessionDir, LEGACY_ADOPTION_FILE), null);
  return record?.schema_version === 1 && record.status === 'launched' ? record : null;
}

function executeAdoptionWatchStrategy(
  strategyId: AdoptionWatchStrategyId,
  args: Pick<Args, 'sessionDir' | 'sourceRuntimeRoot' | 'targetRuntimeRoot' | 'validationSessionDir'>,
  deps: LegacyAdoptionWatchDependencies,
): LegacyAdoptionRecord {
  if (deps.executeStrategy) return deps.executeStrategy(strategyId);
  const adopt = deps.adopt || adoptActiveLegacyMuxSession;
  const launch = deps.launch || launchAdoptedLegacySession;
  const chooseRuntime = deps.chooseRuntime || chooseLegacyLaunchRuntime;

  if (strategyId === 'sealed-launch-transaction-reconstruction') {
    const record = readJsonFile<LegacyAdoptionRecord>(path.join(args.sessionDir, LEGACY_ADOPTION_FILE), null);
    if (!record || record.schema_version !== 1) {
      throw new Error('Sealed launch-transaction reconstruction requires a durable adoption record.');
    }
    const selected = chooseRuntime(args.sourceRuntimeRoot, args.targetRuntimeRoot, record.target_runtime);
    return launch(args.sessionDir, selected.runtimeRoot);
  }

  if (strategyId === 'authenticated-runtime-revalidation') {
    const record = readJsonFile<LegacyAdoptionRecord>(path.join(args.sessionDir, LEGACY_ADOPTION_FILE), null);
    const transaction = readJsonFile<Record<string, unknown>>(
      path.join(args.sessionDir, 'legacy-session-adoption-transaction.json'), null,
    );
    const sourceRuntime = transaction?.source_runtime as InstalledRuntimeDescriptor | undefined;
    const targetRuntime = record?.target_runtime
      || transaction?.target_runtime as InstalledRuntimeDescriptor | undefined;
    const matches = deps.runtimeMatches || runtimeRootMatchesDescriptor;
    if (!(sourceRuntime && matches(args.sourceRuntimeRoot, sourceRuntime))
      && !(targetRuntime && matches(args.targetRuntimeRoot, targetRuntime))) {
      throw new Error('Authenticated runtime revalidation found no persisted runtime identity to authorize repin.');
    }
  }

  const adopted = adopt(args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot, {
    startWatchdog: () => undefined, validationSessionDir: args.validationSessionDir || undefined,
  });
  const selected = chooseRuntime(args.sourceRuntimeRoot, args.targetRuntimeRoot, adopted.target_runtime);
  if (strategyId === 'authenticated-runtime-revalidation') {
    const matches = deps.runtimeMatches || runtimeRootMatchesDescriptor;
    if (!matches(selected.runtimeRoot, adopted.target_runtime)) {
      throw new Error('Authenticated runtime revalidation rejected the selected adoption runtime.');
    }
  }
  return launch(args.sessionDir, selected.runtimeRoot);
}

export function runLegacyAdoptionWatch(
  args: Pick<Args, 'sessionDir' | 'sourceRuntimeRoot' | 'targetRuntimeRoot' | 'validationSessionDir'>,
  deps: LegacyAdoptionWatchDependencies = {},
): LegacyAdoptionRecord {
  const now = deps.now || Date.now;
  const wait = deps.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
  const statusPath = path.join(args.sessionDir, LEGACY_ADOPTION_WATCH_STATUS_FILE);
  const rawPrior = readJsonFile<unknown>(statusPath, null);
  const readAt = now();
  const delayBounds = legacyAdoptionWatchDelayBounds(deps);
  const invalidPrior = fs.existsSync(statusPath)
    ? invalidWatchStatusReason(rawPrior, args.sessionDir, path.basename(args.sessionDir),
      readAt, delayBounds.maxDelayMs) : null;
  let prior = invalidPrior ? null : rawPrior as LegacyAdoptionWatchStatus | null;
  const startedAt = prior?.started_at || new Date(readAt).toISOString();
  let attemptCount = prior?.attempt_count || 0;
  let consecutiveFailures = prior?.status === 'retrying' ? prior.consecutive_failures : 0;
  let lastFailure = prior?.last_failure || null;
  let initialDelay = 0;
  const currentEvidenceHash = () => adoptionWatchEvidenceHash(
    args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot,
  );
  let strategyState = prior?.strategy_state
    || createAdoptionWatchStrategyState(path.basename(args.sessionDir), currentEvidenceHash());
  let terminalRecoveryRefs = prior?.terminal_recovery_refs || [];

  if (invalidPrior) {
    const observedAt = new Date(now()).toISOString();
    const delay = legacyAdoptionWatchDelayMs(1, {
      baseDelayMs: deps.baseDelayMs, maxDelayMs: deps.maxDelayMs,
      jitterRatio: deps.jitterRatio, random: deps.random,
    });
    lastFailure = {
      kind: 'watch-status-invalid', name: 'LegacyAdoptionWatchStatusError',
      message: `Malformed persisted adoption watchdog status: ${invalidPrior}.`, recoverable: true,
      first_observed_at: observedAt, last_observed_at: observedAt,
    };
    prior = {
      schema_version: 1, status: 'retrying', session_id: path.basename(args.sessionDir),
      watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: observedAt,
      attempt_count: 0, consecutive_failures: 1, last_attempt_at: null,
      retry_scheduled_at: observedAt, next_retry_at: new Date(Date.parse(observedAt) + delay).toISOString(), retry_delay_ms: delay,
      last_failure: lastFailure, launched_runtime_root: null, strategy_state: strategyState,
      terminal_recovery_refs: terminalRecoveryRefs,
    };
    atomicWriteJson(statusPath, prior);
    consecutiveFailures = 1;
    initialDelay = delay;
  }

  if (!invalidPrior && strategyState.active) {
    const observedAt = new Date(now()).toISOString();
    strategyState = finishAdoptionWatchStrategy(
      strategyState, 'interrupted', 'watcher-restarted-with-active-strategy', observedAt,
    );
    consecutiveFailures += 1;
    const delay = legacyAdoptionWatchDelayMs(consecutiveFailures, {
      baseDelayMs: deps.baseDelayMs, maxDelayMs: deps.maxDelayMs,
      jitterRatio: deps.jitterRatio, random: deps.random,
    });
    lastFailure = {
      kind: 'adoption-failed', name: 'LegacyAdoptionWatchInterrupted',
      message: 'Watcher restarted with an unfinished recovery strategy.', recoverable: true,
      first_observed_at: observedAt, last_observed_at: observedAt,
    };
    prior = {
      ...prior!, status: 'retrying', watcher_pid: deps.watcherPid ?? process.pid, updated_at: observedAt,
      consecutive_failures: consecutiveFailures, retry_scheduled_at: observedAt,
      next_retry_at: new Date(Date.parse(observedAt) + delay).toISOString(), retry_delay_ms: delay,
      last_failure: lastFailure, strategy_state: strategyState,
      terminal_recovery_refs: terminalRecoveryRefs,
    };
    atomicWriteJson(statusPath, prior);
    initialDelay = delay;
  }

  if (!invalidPrior && prior?.status === 'retrying' && prior.next_retry_at) {
    const remaining = Date.parse(prior.next_retry_at) - now();
    if (remaining > 0) initialDelay = remaining;
  }

  for (;;) {
    const converged = launchedRecord(args.sessionDir);
    if (converged) {
      const timestamp = new Date(now()).toISOString();
      atomicWriteJson(statusPath, {
        schema_version: 1, status: 'launched', session_id: path.basename(args.sessionDir),
        watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: timestamp,
        attempt_count: attemptCount, consecutive_failures: 0, last_attempt_at: prior?.last_attempt_at || null,
        retry_scheduled_at: null, next_retry_at: null, retry_delay_ms: null, last_failure: lastFailure,
        launched_runtime_root: converged.launched_runtime_root || null, strategy_state: strategyState,
        terminal_recovery_refs: terminalRecoveryRefs,
      } satisfies LegacyAdoptionWatchStatus);
      return converged;
    }
    if (adoptionWatchStrategyStateLaunched(strategyState)) {
      const observedAt = new Date(now()).toISOString();
      const evidenceHash = currentEvidenceHash();
      const archive = archiveAdoptionWatchTerminalState(
        args.sessionDir, strategyState, evidenceHash, prior?.updated_at || observedAt,
      );
      terminalRecoveryRefs = [...terminalRecoveryRefs, archive].slice(-16);
      strategyState = createAdoptionWatchTerminalRecoveryState(
        path.basename(args.sessionDir), evidenceHash, strategyState,
      );
      consecutiveFailures += 1;
      const delay = legacyAdoptionWatchDelayMs(consecutiveFailures, {
        baseDelayMs: deps.baseDelayMs, maxDelayMs: deps.maxDelayMs,
        jitterRatio: deps.jitterRatio, random: deps.random,
      });
      lastFailure = {
        kind: 'terminal-inconsistency', name: 'LegacyAdoptionWatchTerminalInconsistency',
        message: 'Persisted launched strategy lacks its authoritative launched adoption record.', recoverable: true,
        first_observed_at: observedAt, last_observed_at: observedAt,
      };
      atomicWriteJson(statusPath, {
        schema_version: 1, status: 'retrying', session_id: path.basename(args.sessionDir),
        watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: observedAt,
        attempt_count: attemptCount, consecutive_failures: consecutiveFailures,
        last_attempt_at: prior?.last_attempt_at || null, retry_scheduled_at: observedAt,
        next_retry_at: new Date(Date.parse(observedAt) + delay).toISOString(), retry_delay_ms: delay,
        last_failure: lastFailure, launched_runtime_root: null, strategy_state: strategyState,
        terminal_recovery_refs: terminalRecoveryRefs,
      } satisfies LegacyAdoptionWatchStatus);
      initialDelay = delay;
      continue;
    }
    if (initialDelay > 0) {
      const delay = initialDelay;
      initialDelay = 0;
      wait(delay);
      continue;
    }

    const attemptAt = new Date(now()).toISOString();
    attemptCount += 1;
    const begun = beginAdoptionWatchStrategy(strategyState, currentEvidenceHash(), attemptAt);
    strategyState = begun.state;
    atomicWriteJson(statusPath, {
      schema_version: 1, status: 'watching', session_id: path.basename(args.sessionDir),
      watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: attemptAt,
      attempt_count: attemptCount, consecutive_failures: consecutiveFailures, last_attempt_at: attemptAt,
      retry_scheduled_at: null, next_retry_at: null, retry_delay_ms: null, last_failure: lastFailure,
      launched_runtime_root: null, strategy_state: strategyState,
      terminal_recovery_refs: terminalRecoveryRefs,
    } satisfies LegacyAdoptionWatchStatus);
    deps.checkpoint?.('strategy_persisted');
    try {
      const result = executeAdoptionWatchStrategy(begun.attempt.strategy_id, args, deps);
      const timestamp = new Date(now()).toISOString();
      strategyState = finishAdoptionWatchStrategy(strategyState, 'launched', null, timestamp);
      atomicWriteJson(statusPath, {
        schema_version: 1, status: 'launched', session_id: path.basename(args.sessionDir),
        watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: timestamp,
        attempt_count: attemptCount, consecutive_failures: 0, last_attempt_at: attemptAt,
        retry_scheduled_at: null, next_retry_at: null, retry_delay_ms: null, last_failure: lastFailure,
        launched_runtime_root: result.launched_runtime_root || args.targetRuntimeRoot,
        strategy_state: strategyState,
        terminal_recovery_refs: terminalRecoveryRefs,
      } satisfies LegacyAdoptionWatchStatus);
      return result;
    } catch (error) {
      consecutiveFailures += 1;
      const observedAt = new Date(now()).toISOString();
      const delay = legacyAdoptionWatchDelayMs(consecutiveFailures, {
        baseDelayMs: deps.baseDelayMs, maxDelayMs: deps.maxDelayMs,
        jitterRatio: deps.jitterRatio, random: deps.random,
      });
      const message = error instanceof Error ? error.message : String(error);
      const failureKind = classifyLegacyAdoptionWatchFailure(error);
      strategyState = finishAdoptionWatchStrategy(
        strategyState, 'failed', `${failureKind}:${message}`.slice(0, 2_000), observedAt,
      );
      lastFailure = {
        kind: failureKind,
        name: error instanceof Error ? error.name : 'Error',
        message,
        recoverable: true,
        first_observed_at: lastFailure?.message === message ? lastFailure.first_observed_at : observedAt,
        last_observed_at: observedAt,
      };
      atomicWriteJson(statusPath, {
        schema_version: 1, status: 'retrying', session_id: path.basename(args.sessionDir),
        watcher_pid: deps.watcherPid ?? process.pid, started_at: startedAt, updated_at: observedAt,
        attempt_count: attemptCount, consecutive_failures: consecutiveFailures, last_attempt_at: attemptAt,
        retry_scheduled_at: observedAt, next_retry_at: new Date(Date.parse(observedAt) + delay).toISOString(), retry_delay_ms: delay,
        last_failure: lastFailure, launched_runtime_root: null, strategy_state: strategyState,
        terminal_recovery_refs: terminalRecoveryRefs,
      } satisfies LegacyAdoptionWatchStatus);
      wait(delay);
    }
  }
}

export function chooseLegacyLaunchRuntime(
  canonicalRuntimeRoot: string,
  fallbackRuntimeRoot: string,
  targetRuntime: InstalledRuntimeDescriptor,
  options: { timeoutMs?: number; intervalMs?: number; now?: () => number; wait?: (milliseconds: number) => void } = {},
): { runtimeRoot: string; fallback: boolean } {
  const timeoutMs = options.timeoutMs ?? Number(process.env.PICKLE_ADOPTION_CANONICAL_WAIT_MS || 30_000);
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now || Date.now;
  const wait = options.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    if (runtimeRootMatchesDescriptor(canonicalRuntimeRoot, targetRuntime)) {
      return { runtimeRoot: canonicalRuntimeRoot, fallback: false };
    }
    if (now() >= deadline) return { runtimeRoot: fallbackRuntimeRoot, fallback: true };
    wait(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
}

function valueAfter(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return path.resolve(value);
}

function optionalValueAfter(argv: string[], name: string): string {
  return argv.includes(name) ? valueAfter(argv, name) : '';
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'prepare' && command !== 'launch' && command !== 'watch') {
    throw new Error('Usage: adopt-legacy-session.js prepare|watch --session-dir DIR --source-runtime-root DIR --target-runtime-root DIR | launch --session-dir DIR --target-runtime-root DIR');
  }
  return {
    command,
    sessionDir: valueAfter(argv, '--session-dir'),
    sourceRuntimeRoot: command !== 'launch' ? valueAfter(argv, '--source-runtime-root') : '',
    targetRuntimeRoot: valueAfter(argv, '--target-runtime-root'),
    validationSessionDir: command !== 'launch' ? optionalValueAfter(argv, '--validation-session') : '',
  };
}

export function runLegacyAdoptionCli(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.command === 'watch') {
    const result = runLegacyAdoptionWatch(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = args.command === 'prepare'
    ? adoptActiveLegacyMuxSession(args.sessionDir, args.sourceRuntimeRoot, args.targetRuntimeRoot, {
      startWatchdog: (sessionDir, sourceRoot, targetRoot) => {
        const supervisorBin = fileURLToPath(new URL('./legacy-adoption-executor-supervisor.js', import.meta.url));
        const childArgs = [supervisorBin, '--session-dir', sessionDir,
          '--source-runtime-root', sourceRoot, '--target-runtime-root', targetRoot];
        if (args.validationSessionDir) childArgs.push('--validation-session', args.validationSessionDir);
        const child = spawn(process.execPath, childArgs, {
          detached: true, stdio: 'ignore', env: process.env,
        });
        child.unref();
      }, validationSessionDir: args.validationSessionDir || undefined,
    })
    : launchAdoptedLegacySession(args.sessionDir, args.targetRuntimeRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runLegacyAdoptionCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
