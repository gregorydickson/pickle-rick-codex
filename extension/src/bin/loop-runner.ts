#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexExecMonitored, assertCodexSucceeded, hasPromiseToken } from '../services/codex.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState, recordIteration } from '../services/circuit-breaker.js';
import { logActivity } from '../services/activity-logger.js';
import {
  commitTrackedChanges,
  getHeadSha,
  getWorkingTreeStatus,
  isGitRepo,
  isPathTracked,
  isWorkingTreeDirty,
  listWorkingTreeDirtyPaths,
  listUntrackedFiles,
  resetHeadPreservingWorktree,
  resetGitIndex,
} from '../services/git-utils.js';
import { salvageDirtyTree, stageOwnedPaths } from '../services/dirty-tree-salvage.js';
import {
  captureMetricIterationCheckpoint,
  createMetricConvergenceState,
  measureMetric,
  normalizeMetricDirection,
  normalizeMetricTolerance,
  readMetricConvergenceState,
  recordMetricIteration,
  writeMetricConvergenceState,
  type MetricClassification,
  type MetricConvergenceState,
  type MetricIterationCheckpoint,
} from '../services/metric-convergence.js';
import { recoverableHardReset } from '../services/recoverable-git.js';
import { enforceLoopMutationScope } from '../services/pipeline-scope.js';
import { captureProgressSnapshot, diffProgressSnapshot } from '../services/progress-snapshot.js';
import { buildLoopPrompt, type LoopPromptConfig, type LoopPromptState } from '../services/prompts.js';
import { appendHistory, getRunStartEpoch } from '../services/session.js';
import { enterLoopRunnerPhase, exitLoopRunnerPhase, readLoopConfig } from '../services/pipeline-phase-setup.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import { readJsonFile } from '../services/pickle-utils.js';
import { readScrubbedWorkerMessage, scrubWorkerOutput } from '../services/worker-output.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
import type {
  Config,
  CodexSpawnResult,
  ProgressSnapshot,
  SuccessCheck,
} from '../types/index.js';

type LoopConfig = ReturnType<typeof readLoopConfig>;

interface SummaryPaths {
  json: string;
  markdown: string;
  stopJson: string;
  stopMarkdown: string;
}

function appendRunnerLog(sessionDir: string, message: string): void {
  fs.appendFileSync(path.join(sessionDir, 'loop-runner.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function getWorkerTimeoutMs(state: PersistedState, config: Config): number {
  const timeoutSeconds = Number.isFinite(state?.worker_timeout_seconds)
    ? Number(state.worker_timeout_seconds)
    : config.defaults.worker_timeout_seconds;
  return timeoutSeconds * 1000;
}

function summaryPaths(sessionDir: string, mode: string): SummaryPaths {
  return {
    json: path.join(sessionDir, `${mode}-summary.json`),
    markdown: path.join(sessionDir, `${mode}-summary.md`),
    stopJson: path.join(sessionDir, `${mode}-stop-summary.json`),
    stopMarkdown: path.join(sessionDir, `${mode}-stop-summary.md`),
  };
}

function readLastMessageArtifact(outputLastMessagePath: string): string {
  return readScrubbedWorkerMessage(outputLastMessagePath);
}

function loopSuccessCheck(outputLastMessagePath: string): SuccessCheck {
  const tokens = ['LOOP_COMPLETE', 'TASK_COMPLETED', 'CONTINUE'];
  return ({ stdout, lastMessage }) => {
    const persistedMessage = readLastMessageArtifact(outputLastMessagePath);
    const scrubbedStdout = scrubWorkerOutput(stdout || '');
    const scrubbedLastMessage = scrubWorkerOutput(lastMessage || '');
    return tokens.some((token) =>
      hasPromiseToken(scrubbedLastMessage, token)
      || hasPromiseToken(scrubbedStdout, token)
      || hasPromiseToken(persistedMessage, token),
    );
  };
}

function loopShouldExit(outputLastMessagePath: string, result: CodexSpawnResult): boolean {
  const persistedMessage = readLastMessageArtifact(outputLastMessagePath);
  return hasPromiseToken(scrubWorkerOutput(result?.lastMessage || ''), 'LOOP_COMPLETE')
    || hasPromiseToken(scrubWorkerOutput(result?.stdout || ''), 'LOOP_COMPLETE')
    || hasPromiseToken(persistedMessage, 'LOOP_COMPLETE');
}

function normalizeLoopMessage(message: unknown): string {
  return String(message || '')
    .replace(/<promise>[^<]+<\/promise>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    return stderr.trim();
  }
  if (Buffer.isBuffer(stderr)) {
    const text = stderr.toString('utf8').trim();
    if (text) return text;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function summarizeVerification(summary: Record<string, unknown>): string[] {
  if (Array.isArray(summary.verification)) {
    return summary.verification as string[];
  }
  if (typeof summary.verification === 'string' && summary.verification.trim()) {
    return [summary.verification.trim()];
  }
  return [];
}

function summarizeTrapDoors(summary: Record<string, unknown>): string[] {
  if (Array.isArray(summary.trap_doors)) {
    return summary.trap_doors.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return [];
}

function anatomyParkSummary(sessionDir: string): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(summaryPaths(sessionDir, 'anatomy-park').json, {}) ?? {};
}

function anatomyParkCommitMessage(sessionDir: string, loopConfig: LoopConfig, iteration: number): string {
  const summary = anatomyParkSummary(sessionDir);
  const targetLabel = path.basename(path.resolve(loopConfig.target || 'target')) || 'target';
  const finding = normalizeLoopMessage(
    summary.highest_severity_finding
    || summary.finding_family
    || `iteration ${iteration}`,
  );
  const trapDoorSuffix = summarizeTrapDoors(summary).length ? ', trap door' : '';
  return `anatomy-park: ${targetLabel} - ${finding}${trapDoorSuffix}`;
}

function anatomyParkProgressReasons(workingDir: string, reasons: string[]): string[] {
  if (!isGitRepo(workingDir)) {
    return reasons;
  }
  return reasons.filter((reason) => reason !== 'worktree_fingerprint');
}

function isMeasuredMicroverse(loopConfig: LoopConfig): boolean {
  return loopConfig.mode === 'microverse'
    && typeof loopConfig.metric === 'string'
    && loopConfig.metric.trim().length > 0;
}

function metricTimeoutMs(loopConfig: LoopConfig): number {
  const seconds = Number(loopConfig.metric_timeout_seconds ?? 120);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Microverse metric_timeout_seconds must be positive.');
  }
  return seconds * 1000;
}

function revertMetricIterationSafely(
  sessionDir: string,
  workingDir: string,
  checkpoint: MetricIterationCheckpoint,
): void {
  const session = path.basename(sessionDir).replace(/[^a-zA-Z0-9._-]/g, '-');
  recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: checkpoint.head,
    operation: 'microverse-revert',
    preserveUntracked: checkpoint.untracked,
    headRecoveryRef: `refs/pickle/microverse-recovery/${session}`,
    log: (message) => appendRunnerLog(sessionDir, message),
  });
}

function ensureMetricBaseline(sessionDir: string, loopConfig: LoopConfig, workingDir: string): MetricConvergenceState | null {
  if (!isMeasuredMicroverse(loopConfig)) return null;
  const command = String(loopConfig.metric).trim();
  const direction = normalizeMetricDirection(loopConfig.direction ?? 'higher');
  const tolerance = normalizeMetricTolerance(loopConfig.tolerance ?? 0);
  const existing = readMetricConvergenceState(sessionDir);
  if (existing) {
    if (existing.command !== command || existing.direction !== direction || existing.tolerance !== tolerance) {
      throw new Error('Cannot change the metric command, direction, or tolerance while resuming a Microverse session.');
    }
    captureMetricIterationCheckpoint(workingDir);
    return existing;
  }
  const checkpoint = captureMetricIterationCheckpoint(workingDir);
  let baseline;
  try {
    baseline = measureMetric(command, { cwd: workingDir, timeoutMs: metricTimeoutMs(loopConfig) });
  } catch (error) {
    revertMetricIterationSafely(sessionDir, workingDir, checkpoint);
    throw error;
  }
  const state = createMetricConvergenceState(baseline, direction, tolerance);
  writeMetricConvergenceState(sessionDir, state);
  appendRunnerLog(sessionDir, `microverse baseline measured: ${baseline.score}`);
  return state;
}

function writeMetricSummary(sessionDir: string, state: MetricConvergenceState): void {
  const summary = {
    objective: 'measured metric convergence',
    baseline: state.baseline.score,
    latest_result: state.latest.score,
    best_result: state.best.score,
    direction: state.direction,
    tolerance: state.tolerance,
    stall_count: state.stall_count,
    failed_approaches: state.failed_approaches,
    verification: [`${state.command} => ${state.latest.score}`],
    next_action: state.stall_count > 0 ? 'Try a materially different approach.' : 'Continue toward convergence or stop when the target is met.',
  };
  fs.writeFileSync(summaryPaths(sessionDir, 'microverse').json, JSON.stringify(summary, null, 2));
  fs.writeFileSync(summaryPaths(sessionDir, 'microverse').markdown, [
    '# Microverse Metric Summary',
    '',
    `- Command: \`${state.command}\``,
    `- Direction: ${state.direction}`,
    `- Baseline: ${state.baseline.score}`,
    `- Best: ${state.best.score}`,
    `- Latest: ${state.latest.score}`,
    `- Stall count: ${state.stall_count}`,
    '',
  ].join('\n'));
}

function processMetricIteration(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  checkpoint: MetricIterationCheckpoint,
  iteration: number,
): { classification: Exclude<MetricClassification, 'baseline'>; state: MetricConvergenceState } {
  const currentState = readMetricConvergenceState(sessionDir);
  if (!currentState) throw new Error('Microverse metric state disappeared during an iteration.');
  const measurement = measureMetric(currentState.command, {
    cwd: workingDir,
    timeoutMs: metricTimeoutMs(loopConfig),
  });
  const attemptedHead = getHeadSha(workingDir) || checkpoint.head;
  const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  const repositoryChanged = attemptedHead !== checkpoint.head || dirtyPaths.length > 0;
  const natural = recordMetricIteration(currentState, measurement, {
    iteration,
    headBefore: checkpoint.head,
    headAfter: attemptedHead,
  }).classification;
  const classification = natural === 'improved' && !repositoryChanged ? 'held' : natural;

  if (classification === 'improved') {
    if (dirtyPaths.length > 0) {
      const plan = salvageDirtyTree({
        workingDir,
        sessionDir,
        owned: dirtyPaths,
        foreign: [],
        log: (message) => appendRunnerLog(sessionDir, message),
      });
      stageOwnedPaths(workingDir, plan.stagePaths);
      commitTrackedChanges(workingDir, `microverse: accept metric improvement to ${measurement.score}`);
    }
  } else {
    revertMetricIterationSafely(sessionDir, workingDir, checkpoint);
  }

  const recorded = recordMetricIteration(currentState, measurement, {
    iteration,
    headBefore: checkpoint.head,
    headAfter: attemptedHead,
    classificationOverride: classification,
  });
  writeMetricConvergenceState(sessionDir, recorded.state);
  writeMetricSummary(sessionDir, recorded.state);
  appendRunnerLog(sessionDir, `microverse metric ${classification}: ${currentState.best.score} -> ${measurement.score} (${recorded.state.stall_count} stalled)`);
  return recorded;
}

function ensureAdvancedLoopCleanTrackedPreflight(sessionDir: string, loopConfig: LoopConfig, workingDir: string): void {
  if (!['anatomy-park', 'szechuan-sauce'].includes(loopConfig.mode) || loopConfig.dry_run) {
    return;
  }
  if (!isGitRepo(workingDir)) {
    if (isWorkingTreeDirty(workingDir)) {
      throw new Error(`Working tree is dirty - not a git repo, cannot establish ${loopConfig.mode} change ownership`);
    }
    return;
  }
  const statusLines = getWorkingTreeStatus(workingDir)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length === 0) {
    return;
  }
  const tracked = statusLines.filter((line) => !line.startsWith('?? '));
  if (tracked.length > 0) {
    appendRunnerLog(sessionDir, `refusing ${loopConfig.mode} start with ${tracked.length} pre-existing tracked change(s)`);
    throw new Error(`${loopConfig.mode} requires a clean tracked working tree; commit or stash pre-existing tracked changes before starting`);
  }
  const untracked = statusLines.filter((line) => line.startsWith('?? '));
  appendRunnerLog(sessionDir, `refusing ${loopConfig.mode} start with ${untracked.length} pre-existing untracked path(s)`);
  throw new Error(`${loopConfig.mode} requires a completely clean working tree; remove, commit, or stash pre-existing untracked paths before starting`);
}

function autoCommitAdvancedLoopIteration(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  beforeSnapshot: ProgressSnapshot,
  iteration: number,
  beforeUntrackedFiles: string[] = [],
): boolean {
  if (!['anatomy-park', 'szechuan-sauce'].includes(loopConfig.mode) || loopConfig.dry_run) {
    return false;
  }
  if (!isGitRepo(workingDir)) {
    return false;
  }
  const capturedUntracked = beforeUntrackedFiles.filter((relativePath) => isPathTracked(workingDir, relativePath));
  if (capturedUntracked.length > 0) {
    if (beforeSnapshot.head_sha && getHeadSha(workingDir) !== beforeSnapshot.head_sha) {
      resetHeadPreservingWorktree(workingDir, beforeSnapshot.head_sha);
    } else {
      resetGitIndex(workingDir);
    }
    throw new Error(`${loopConfig.mode} worker committed pre-existing untracked paths: ${capturedUntracked.join(', ')}`);
  }
  const baselineUntracked = new Set(beforeUntrackedFiles);
  const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  const foreign = dirtyPaths.filter((relativePath) => baselineUntracked.has(relativePath));
  const owned = dirtyPaths.filter((relativePath) => !baselineUntracked.has(relativePath));
  if (beforeSnapshot.head_sha && getHeadSha(workingDir) !== beforeSnapshot.head_sha) {
    if (owned.length > 0) {
      throw new Error(`${loopConfig.mode} worker advanced HEAD but left an ambiguous dirty tree`);
    }
    return false;
  }
  if (owned.length === 0) {
    if (foreign.length > 0) {
      appendRunnerLog(sessionDir, `no owned ${loopConfig.mode} changes to commit; preserving ${foreign.length} pre-existing path(s)`);
    }
    return false;
  }

  appendRunnerLog(sessionDir, `no ${loopConfig.mode} commit detected after iteration; auto-committing iteration changes`);
  try {
    const plan = salvageDirtyTree({
      workingDir,
      sessionDir,
      owned,
      foreign,
      log: (message) => appendRunnerLog(sessionDir, message),
    });
    stageOwnedPaths(workingDir, plan.stagePaths);
    const commitMessage = loopConfig.mode === 'anatomy-park'
      ? anatomyParkCommitMessage(sessionDir, loopConfig, iteration)
      : `szechuan-sauce: iteration ${iteration}`;
    commitTrackedChanges(workingDir, commitMessage);
    const remainingOwned = listWorkingTreeDirtyPaths(workingDir)
      .filter((relativePath) => !baselineUntracked.has(relativePath));
    if (remainingOwned.length > 0) {
      throw new Error(`${loopConfig.mode} auto-commit left iteration-owned dirty paths: ${remainingOwned.join(', ')}`);
    }
    appendRunnerLog(sessionDir, `${loopConfig.mode} auto-committed: ${getHeadSha(workingDir)}`);
    return true;
  } catch (error) {
    resetGitIndex(workingDir);
    appendRunnerLog(sessionDir, `${loopConfig.mode} auto-commit failed: ${safeErrorMessage(error)}`);
    throw error;
  }
}

function enforceAdvancedLoopScope(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  beforeSnapshot: ProgressSnapshot,
  beforeUntrackedFiles: string[],
): void {
  if (!['anatomy-park', 'szechuan-sauce'].includes(loopConfig.mode) || loopConfig.dry_run) return;
  if (!Array.isArray(loopConfig.allowed_paths)) return;
  enforceLoopMutationScope({
    sessionDir,
    workingDir,
    mode: loopConfig.mode,
    beforeHead: String(beforeSnapshot.head_sha || ''),
    allowedPaths: loopConfig.allowed_paths.map((entry) => String(entry)),
    preserveUntracked: beforeUntrackedFiles,
    log: (message) => appendRunnerLog(sessionDir, message),
  });
}

function stopSummaryFromState(state: PersistedState, loopConfig: LoopConfig, exitReason: string, sessionDir: string) {
  const paths = summaryPaths(sessionDir, loopConfig.mode);
  const persistedSummary = readJsonFile<Record<string, unknown>>(paths.json, {}) ?? {};
  const lastMessage = normalizeLoopMessage(state.last_loop_message);
  return {
    mode: loopConfig.mode,
    target: loopConfig.target || null,
    stop_reason: exitReason,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    max_time_minutes: state.max_time_minutes,
    highest_severity_finding: persistedSummary.highest_severity_finding || (lastMessage.split('\n')[0] || null),
    finding_family: persistedSummary.finding_family || null,
    data_flow_path: persistedSummary.data_flow_path || null,
    fix_applied: persistedSummary.fix_applied || null,
    verification: summarizeVerification(persistedSummary),
    trap_doors: summarizeTrapDoors(persistedSummary),
    next_action: persistedSummary.next_action || null,
    last_loop_message: state.last_loop_message || null,
    summary_generated_at: new Date().toISOString(),
  };
}

function writeStopSummaryArtifacts(sessionDir: string, loopConfig: LoopConfig, state: PersistedState, exitReason: string): void {
  const paths = summaryPaths(sessionDir, loopConfig.mode);
  const summary = stopSummaryFromState(state, loopConfig, exitReason, sessionDir);
  fs.writeFileSync(paths.stopJson, JSON.stringify(summary, null, 2));

  const markdown = [
    `# ${loopConfig.mode} Stop Summary`,
    '',
    `- Stop Reason: ${summary.stop_reason}`,
    `- Iteration: ${summary.iteration}`,
    `- Highest-Severity Finding: ${summary.highest_severity_finding || 'n/a'}`,
    `- Finding Family: ${summary.finding_family || 'n/a'}`,
    `- Data Flow Path: ${summary.data_flow_path || 'n/a'}`,
    `- Fix Applied: ${summary.fix_applied || 'n/a'}`,
    `- Next Action: ${summary.next_action || 'n/a'}`,
    '',
    '## Verification',
    ...(summary.verification.length ? summary.verification.map((entry) => `- ${entry}`) : ['- n/a']),
    '',
    '## Trap Doors',
    ...(summary.trap_doors.length ? summary.trap_doors.map((entry) => `- ${entry}`) : ['- none recorded']),
    '',
    '## Last Loop Message',
    '',
    '```text',
    summary.last_loop_message || 'n/a',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(paths.stopMarkdown, markdown);
}

export async function runLoop(sessionDir: string): Promise<void> {
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const config = loadConfig();
  const loopConfig = readLoopConfig(sessionDir);
  const initialState = manager.read(statePath);

  appendRunnerLog(sessionDir, `loop-runner started (${loopConfig.mode})`);
  ensureAdvancedLoopCleanTrackedPreflight(sessionDir, loopConfig, initialState.working_dir as string);
  ensureMetricBaseline(sessionDir, loopConfig, initialState.working_dir as string);
  enterLoopRunnerPhase(manager, statePath, loopConfig.mode);

  let exitReason = 'success';
  let thrownError: unknown = null;
  let pendingMetricIteration: { cwd: string; checkpoint: MetricIterationCheckpoint } | null = null;
  try {
    while (true) {
      const state = manager.read(statePath);
      if (state.active === false) {
        exitReason = (state.last_exit_reason as string | null) || 'cancelled';
        break;
      }
      if (Number.isInteger(state.max_iterations) && (state.max_iterations as number) > 0 && (state.iteration as number) >= (state.max_iterations as number)) {
        exitReason = 'max_iterations';
        break;
      }
      if (Number.isFinite(state.max_time_minutes) && (state.max_time_minutes as number) > 0) {
        const elapsedMinutes = (Date.now() / 1000 - getRunStartEpoch(state)) / 60;
        if (elapsedMinutes >= (state.max_time_minutes as number)) {
          exitReason = 'max_time';
          break;
        }
      }
      if (config.defaults.circuit_breaker.enabled && !canExecute(loadCircuitState(sessionDir))) {
        exitReason = 'circuit_open';
        appendRunnerLog(sessionDir, 'refusing iteration: circuit breaker is OPEN');
        break;
      }

      const beforeSnapshot = captureProgressSnapshot({
        sessionDir,
        workingDir: state.working_dir as string,
        mode: loopConfig.mode,
        step: state.step as string | null,
        currentTicket: state.current_ticket as string | null,
      });
      const metricCheckpoint = isMeasuredMicroverse(loopConfig)
        ? captureMetricIterationCheckpoint(state.working_dir as string)
        : null;
      pendingMetricIteration = metricCheckpoint
        ? { cwd: state.working_dir as string, checkpoint: metricCheckpoint }
        : null;
      const beforeUntrackedFiles = isGitRepo(state.working_dir as string)
        ? listUntrackedFiles(state.working_dir as string)
        : [];
      manager.update(statePath, (current) => {
        current.iteration = (current.iteration as number) + 1;
        current.step = loopConfig.mode;
        appendHistory(current, loopConfig.mode, current.current_ticket || undefined);
        return current;
      });

      const outputLastMessagePath = path.join(sessionDir, `${loopConfig.mode}.${(state.iteration as number) + 1}.last-message.txt`);
      const result = await runCodexExecMonitored({
        cwd: state.working_dir as string,
        prompt: buildLoopPrompt({
          mode: loopConfig.mode,
          sessionDir,
          workingDir: state.working_dir as string,
          state: manager.read(statePath) as unknown as LoopPromptState,
          loopConfig: loopConfig as unknown as LoopPromptConfig,
        }),
        timeoutMs: getWorkerTimeoutMs(state, config),
        outputLastMessagePath,
        progressArtifactPaths: Object.values(summaryPaths(sessionDir, loopConfig.mode)),
        addDirs: [sessionDir],
        successCheck: loopSuccessCheck(outputLastMessagePath),
        successSignalGraceMs: 150,
        successPollMs: 50,
        onSpawn: (child) => {
          manager.update(statePath, (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'codex';
            current.active_child_command = loopConfig.mode;
            current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        cancelCheck: () => manager.read(statePath).active === false,
      });
      manager.update(statePath, (current) => {
        current.active_child_pid = null;
        current.active_child_kind = null;
        current.active_child_command = null;
        current.active_child_identity = null;
        current.active_child_controller_pid = null;
        return current;
      });
      if (result.cancelled || manager.read(statePath).active === false) {
        exitReason = (manager.read(statePath).last_exit_reason as string | null) || 'cancelled';
        break;
      }
      assertCodexSucceeded(result, `${loopConfig.mode} iteration failed`);

      const lastMessage = scrubWorkerOutput(result.lastMessage || '');
      appendRunnerLog(sessionDir, `iteration ${(state.iteration as number) + 1} finished`);

      enforceAdvancedLoopScope(
        sessionDir,
        loopConfig,
        state.working_dir as string,
        beforeSnapshot,
        beforeUntrackedFiles,
      );

      autoCommitAdvancedLoopIteration(
        sessionDir,
        loopConfig,
        state.working_dir as string,
        beforeSnapshot,
        (state.iteration as number) + 1,
        beforeUntrackedFiles,
      );

      const metricResult = metricCheckpoint
        ? processMetricIteration(
          sessionDir,
          loopConfig,
          state.working_dir as string,
          metricCheckpoint,
          (state.iteration as number) + 1,
        )
        : null;
      pendingMetricIteration = null;

      const afterSnapshot = captureProgressSnapshot({
        sessionDir,
        workingDir: state.working_dir as string,
        mode: loopConfig.mode,
        step: loopConfig.mode,
        currentTicket: manager.read(statePath).current_ticket as string | null,
      });
      const progressReasons = anatomyParkProgressReasons(
        state.working_dir as string,
        diffProgressSnapshot(beforeSnapshot, afterSnapshot).filter((reason) => reason !== 'initial_snapshot'),
      );
      const latest = manager.update(statePath, (current) => {
        current.loop_stall_count = metricResult
          ? metricResult.state.stall_count
          : progressReasons.length ? 0 : Number(current.loop_stall_count || 0) + 1;
        current.last_loop_message = lastMessage.trim();
        return current;
      });
      if (progressReasons.length) {
        appendRunnerLog(sessionDir, `iteration ${(state.iteration as number) + 1} progress: ${progressReasons.join(',')}`);
      }

      if (config.defaults.circuit_breaker.enabled) {
        const circuitState = recordIteration(sessionDir, {
          working_dir: latest.working_dir as string,
          step: latest.step as string,
          current_ticket: latest.current_ticket as string | null,
          loop_mode: loopConfig.mode,
        });
        if (!canExecute(circuitState)) {
          exitReason = 'circuit_open';
          appendRunnerLog(sessionDir, `circuit breaker opened after iteration ${(state.iteration as number) + 1}`);
          break;
        }
      }

      if (loopShouldExit(outputLastMessagePath, result) && (!metricResult || metricResult.classification === 'improved')) {
        exitReason = 'success';
        break;
      }
      if ((latest.loop_stall_count as number) >= Number(loopConfig.stall_limit || 5)) {
        exitReason = 'stalled';
        break;
      }
    }
  } catch (error) {
    exitReason = manager.read(statePath).active === false
      ? ((manager.read(statePath).last_exit_reason as string | null) || 'cancelled')
      : 'error';
    if (exitReason !== 'cancelled') {
      thrownError = error;
    }
  } finally {
    if (pendingMetricIteration) {
      try {
        revertMetricIterationSafely(sessionDir, pendingMetricIteration.cwd, pendingMetricIteration.checkpoint);
        appendRunnerLog(sessionDir, `microverse iteration rolled back after ${exitReason}`);
      } catch (rollbackError) {
        appendRunnerLog(sessionDir, `microverse rollback failed after ${exitReason}: ${safeErrorMessage(rollbackError)}`);
        thrownError = thrownError
          ? new AggregateError(
            [thrownError, rollbackError],
            `Microverse iteration failed and rollback did not complete: ${safeErrorMessage(rollbackError)}`,
          )
          : rollbackError;
        exitReason = 'error';
      }
    }
    const finalReason = exitLoopRunnerPhase(manager, statePath, exitReason);
    writeStopSummaryArtifacts(sessionDir, loopConfig, manager.read(statePath), finalReason);
    appendRunnerLog(sessionDir, `loop-runner finished: ${finalReason}`);
  }

  if (manager.read(statePath).last_exit_reason === 'success') {
    logActivity({
      event: `${loopConfig.mode}_completed`,
      source: 'pickle',
      session: path.basename(sessionDir),
    }, { enabled: config.defaults.activity_logging });
  }

  if (thrownError) {
    throw thrownError;
  }
}

async function main(argv: string[]): Promise<void> {
  const [sessionDir] = argv;
  if (!sessionDir) {
    throw new Error('Usage: node bin/loop-runner.js <session-dir>');
  }
  await runLoop(sessionDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
