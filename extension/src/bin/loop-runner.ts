#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexExecMonitored, assertCodexSucceeded } from '../services/codex.js';
import { loadConfig } from '../services/config.js';
import { canExecute, loadCircuitState, recordIteration, resetCircuitBreaker } from '../services/circuit-breaker.js';
import { logActivity } from '../services/activity-logger.js';
import {
  commitTrackedChanges,
  createPatchFromWorktree,
  createIsolatedTicketWorktree,
  commitIsAncestorWithPathsUnchanged,
  fastForwardFromIsolatedCandidate,
  getHeadSha,
  getSymbolicHead,
  getWorkingTreeFingerprint,
  getWorkingTreeStatus,
  isGitRepo,
  isPathTracked,
  isWorkingTreeDirty,
  listChangedPathsSince,
  listWorkingTreeDirtyPaths,
  listUntrackedFiles,
  resetHeadPreservingWorktree,
  normalizeIsolatedCandidateCommit,
  resetGitIndex,
  removeIsolatedTicketWorktree,
} from '../services/git-utils.js';
import { salvageDirtyTree, stageOwnedPaths } from '../services/dirty-tree-salvage.js';
import {
  captureMetricIterationCheckpoint,
  createMetricConvergenceState,
  measureMetric,
  MetricTimeoutError,
  normalizeMetricDirection,
  normalizeMetricTargetContract,
  normalizeMetricTolerance,
  metricStateTargetSatisfied,
  readMetricConvergenceState,
  recordMetricIteration,
  writeMetricConvergenceState,
  type MetricClassification,
  type MetricConvergenceState,
  type MetricIterationCheckpoint,
  type MetricMeasurement,
} from '../services/metric-convergence.js';
import {
  abandonPlannedExperiment,
  assertExperimentStrategy,
  completeExperiment,
  isMicroverseExperimentPlanFrozen,
  MICROVERSE_RUNTIME_PLACEHOLDER_PREFIX,
  planExperiment,
  readExperimentLedger,
  reconcileRunningExperiments,
  recordWorkerAttemptFailure,
  resetWorkerFailureCount,
  researchConvergenceState,
  startExperiment,
  updateExperimentPlan,
  type ExperimentClassification,
  type MicroverseExperimentRecord,
} from '../services/experiment-ledger.js';
import {
  archiveMicroverseExperiment,
  type ArchivedMicroverseExperiment,
} from '../services/microverse-experiment-archive.js';
import { writeMicroverseWorkerHandoff } from '../services/microverse-handoff.js';
import {
  captureProtectedPathManifest,
  changedProtectedPaths,
  type ProtectedPathManifest,
} from '../services/microverse-protection.js';
import { recoverableHardReset } from '../services/recoverable-git.js';
import { enforceLoopMutationScope, PipelineScopeError } from '../services/pipeline-scope.js';
import { captureProgressSnapshot, diffProgressSnapshot } from '../services/progress-snapshot.js';
import { buildLoopPrompt, type LoopPromptConfig, type LoopPromptState } from '../services/prompts.js';
import { appendHistory, getRunStartEpoch } from '../services/session.js';
import {
  claimLoopRunnerStartup,
  enterLoopRunnerPhase,
  exitLoopRunnerPhase,
  readLoopConfig,
} from '../services/pipeline-phase-setup.js';
import { StateManager, type PersistedState } from '../services/state-manager.js';
import { atomicWriteJson, readJsonFile } from '../services/pickle-utils.js';
import { scrubWorkerOutput } from '../services/worker-output.js';
import { captureSpawnedProcessIdentity } from '../services/orphan-reaper.js';
import { acquireSessionOperation } from '../services/session-operation.js';
import type {
  Config,
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

interface ControlFileSnapshot {
  filePath: string;
  existed: boolean;
  content: Buffer | null;
}

interface MicroverseAttemptTransaction {
  schema_version: 1 | 2;
  experiment_id: string;
  iteration: number;
  attempt: number;
  checkpoint: MetricIterationCheckpoint;
  metric_state_before: MetricConvergenceState;
  candidate_worktree?: string;
  candidate_dev?: number;
  candidate_ino?: number;
  live_working_dir?: string;
  live_head?: string;
  live_ref?: string | null;
  live_fingerprint?: string;
  phase?: 'running' | 'promotion_pending' | 'promoted' | 'quarantined';
  quarantine_reason?: string;
  candidate_head?: string;
  promotion_result?: {
    result_score: number;
    metric_state_after: MetricConvergenceState;
    changed_paths: string[];
    diff_artifact: string | null;
    insight: string | null;
    verification: string[];
  };
  archive_receipt?: {
    artifact: string;
    sha256: string;
    experiment_id: string;
    base_ref: string;
  };
  created_at: string;
}

interface MicroverseCandidate {
  worktreeDir: string;
  isolationRoot: string;
  device: number;
  inode: number;
  liveWorkingDir: string;
  liveRef: string | null;
  baseHead: string;
  liveFingerprint: string;
}

class MicroversePromotionDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicroversePromotionDeferredError';
  }
}

class MicroverseCandidateArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MicroverseCandidateArchiveError';
  }
}

class PostWorkerMetricMeasurementError extends Error {
  readonly measurementError: unknown;

  constructor(measurementError: unknown) {
    super(`Post-worker metric measurement failed: ${safeErrorMessage(measurementError)}`);
    this.name = 'PostWorkerMetricMeasurementError';
    this.measurementError = measurementError;
  }
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

const MAX_MICROVERSE_WORKER_TIMEOUT_SECONDS = 86_400;

type MicroverseWorkerFailure = Extract<
  ExperimentClassification,
  'worker_incomplete' | 'worker_error' | 'worker_timeout' | 'protected_path_tamper'
>;

function increaseMicroverseWorkerTimeout(
  manager: StateManager,
  statePath: string,
  config: Config,
): { previous: number; next: number } {
  const current = manager.read(statePath);
  const previous = Math.max(1, Math.ceil(getWorkerTimeoutMs(current, config) / 1000));
  const next = Math.min(MAX_MICROVERSE_WORKER_TIMEOUT_SECONDS, Math.max(previous + 1, previous * 2));
  manager.update(statePath, (state) => {
    state.worker_timeout_seconds = next;
    return state;
  });
  return { previous, next };
}

function recoverMicroverseWorkerFailure(
  sessionDir: string,
  statePath: string,
  manager: StateManager,
  config: Config,
  loopConfig: LoopConfig,
  experiment: MicroverseExperimentRecord,
  failure: MicroverseWorkerFailure,
  detail: string,
  failures: number,
): boolean {
  if (failure === 'worker_timeout') {
    const timeout = increaseMicroverseWorkerTimeout(manager, statePath, config);
    appendRunnerLog(
      sessionDir,
      timeout.next > timeout.previous
        ? `microverse worker timeout increased: ${timeout.previous}s -> ${timeout.next}s`
        : `microverse worker timeout remains at recovery ceiling: ${timeout.next}s`,
    );
  }

  const threshold = Number(loopConfig.worker_failure_limit || 3);
  if (failures < threshold) return true;

  // Control-plane or protected-input tampering is the one worker classification
  // that is unsafe to retry forever. The caller fails closed after the configured
  // evidence window; ordinary transport, timeout, and completion failures recover.
  if (failure === 'protected_path_tamper') return false;

  let recoveryAction = `retrying ${experiment.id}`;
  if (failure === 'worker_incomplete') {
    abandonPlannedExperiment(sessionDir, experiment.id, {
      classification: failure,
      insight: `${detail}; recovery threshold reached, rotating to a new experiment.`,
    });
    recoveryAction = `archived ${experiment.id} and will plan a different experiment`;
  }
  const resetFailures = resetWorkerFailureCount(sessionDir);
  manager.update(statePath, (state) => {
    state.worker_failure_count = 0;
    state.last_loop_message = `${detail}; recovery window reset after ${resetFailures} failures.`;
    return state;
  });
  appendRunnerLog(
    sessionDir,
    `microverse recovery threshold reached after ${resetFailures} worker failures: ${recoveryAction}`,
  );
  return true;
}

function summaryPaths(sessionDir: string, mode: string): SummaryPaths {
  return {
    json: path.join(sessionDir, `${mode}-summary.json`),
    markdown: path.join(sessionDir, `${mode}-summary.md`),
    stopJson: path.join(sessionDir, `${mode}-stop-summary.json`),
    stopMarkdown: path.join(sessionDir, `${mode}-stop-summary.md`),
  };
}

function workerSummaryPaths(workerArtifactDir: string, mode: string): Pick<SummaryPaths, 'json' | 'markdown'> {
  return {
    json: path.join(workerArtifactDir, `${mode}-summary.json`),
    markdown: path.join(workerArtifactDir, `${mode}-summary.md`),
  };
}

function createWorkerArtifactDir(sessionDir: string, mode: string, iteration: number, attempt: number): string {
  const root = path.join(sessionDir, 'worker-artifacts');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const artifactDir = fs.mkdtempSync(path.join(root, `${mode}-${iteration}-attempt-${attempt}-`));
  fs.chmodSync(artifactDir, 0o700);
  return artifactDir;
}

function createOutputLastMessagePath(sessionDir: string, mode: string, iteration: number, attempt: number): string {
  const root = path.join(sessionDir, 'control', 'last-messages');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return path.join(root, `${mode}.${iteration}.attempt-${attempt}.txt`);
}

function assertControlPlaneOutsideWorkerCwd(sessionDir: string, workingDir: string): void {
  const canonicalWorkingDir = fs.realpathSync.native(path.resolve(workingDir));
  const canonicalSessionDir = fs.realpathSync.native(path.resolve(sessionDir));
  const relative = path.relative(canonicalWorkingDir, canonicalSessionDir);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Pickle session control directory must be outside the worker working directory.');
  }
}

function captureControlFiles(sessionDir: string): ControlFileSnapshot[] {
  return ['loop_config.json', 'microverse-metrics.json', 'microverse-experiments.json', 'microverse-attempt.json'].map((name) => {
    const filePath = path.join(sessionDir, name);
    const existed = fs.existsSync(filePath);
    return { filePath, existed, content: existed ? fs.readFileSync(filePath) : null };
  });
}

function restoreTamperedControlFiles(snapshots: ControlFileSnapshot[]): string[] {
  const tampered: string[] = [];
  for (const snapshot of snapshots) {
    const currentExists = fs.existsSync(snapshot.filePath);
    const current = currentExists ? fs.readFileSync(snapshot.filePath) : null;
    const changed = snapshot.existed !== currentExists
      || (snapshot.content !== null && current !== null && !snapshot.content.equals(current));
    if (!changed) continue;
    tampered.push(path.basename(snapshot.filePath));
    if (snapshot.existed && snapshot.content) {
      fs.writeFileSync(snapshot.filePath, snapshot.content, { mode: 0o600 });
    } else {
      fs.rmSync(snapshot.filePath, { force: true });
    }
  }
  return tampered;
}

function promoteWorkerSummaryArtifacts(workerArtifactDir: string, sessionDir: string, mode: string): void {
  if (!['anatomy-park', 'szechuan-sauce'].includes(mode)) return;
  const source = workerSummaryPaths(workerArtifactDir, mode);
  const destination = summaryPaths(sessionDir, mode);
  for (const [sourcePath, destinationPath] of [
    [source.json, destination.json],
    [source.markdown, destination.markdown],
  ]) {
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
      throw new Error(`Invalid worker summary artifact: ${sourcePath}`);
    }
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath), { mode: 0o600 });
  }
}

function readLastMessageArtifact(outputLastMessagePath: string): string {
  return outputLastMessagePath && fs.existsSync(outputLastMessagePath)
    ? fs.readFileSync(outputLastMessagePath, 'utf8')
    : '';
}

type LoopCompletionToken = 'LOOP_COMPLETE' | 'TASK_COMPLETED' | 'CONTINUE';

function authoritativeLoopCompletionToken(outputLastMessagePath: string): LoopCompletionToken | null {
  const persistedMessage = readLastMessageArtifact(outputLastMessagePath);
  const matches = [...persistedMessage.matchAll(/<promise>\s*(LOOP_COMPLETE|TASK_COMPLETED|CONTINUE)\s*<\/promise>/g)];
  if (matches.length !== 1) return null;
  return matches[0][1] as LoopCompletionToken;
}

function loopSuccessCheck(outputLastMessagePath: string): SuccessCheck {
  return () => authoritativeLoopCompletionToken(outputLastMessagePath) !== null;
}

function writeWorkerDiagnostics(
  sessionDir: string,
  mode: string,
  iteration: number,
  attempt: number,
  outputMessagePath: string,
  result: Awaited<ReturnType<typeof runCodexExecMonitored>>,
  completionToken: LoopCompletionToken | null,
): void {
  const scrubbedStderr = scrubWorkerOutput(result.stderr || '');
  const diagnostics = {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    terminated_after_success: result.terminatedAfterSuccess,
    last_message_present: readLastMessageArtifact(outputMessagePath).length > 0,
    completion_token: completionToken,
    stderr_tail: scrubbedStderr.slice(-4_096),
  };
  fs.writeFileSync(
    path.join(sessionDir, `${mode}.${iteration}.attempt-${attempt}.worker-diagnostics.json`),
    JSON.stringify(diagnostics, null, 2),
    { mode: 0o600 },
  );
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

const METRIC_TIMEOUT_HEADROOM_RATIO = 0.75;
const METRIC_TIMEOUT_HEADROOM_MULTIPLIER = 2;
const MAX_AUTO_METRIC_TIMEOUT_MS = 30 * 60 * 1000;

function persistMetricTimeout(
  sessionDir: string,
  loopConfig: LoopConfig,
  timeoutMs: number,
  reason: string,
): void {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  loopConfig.metric_timeout_seconds = timeoutSeconds;
  atomicWriteJson(path.join(sessionDir, 'loop_config.json'), loopConfig);
  appendRunnerLog(sessionDir, `microverse metric timeout increased to ${timeoutSeconds}s: ${reason}`);
}

function ensureMetricTimeoutHeadroom(
  sessionDir: string,
  loopConfig: LoopConfig,
  measurement: MetricMeasurement,
): void {
  const durationMs = Number(measurement.duration_ms ?? 0);
  const currentTimeoutMs = metricTimeoutMs(loopConfig);
  if (!Number.isFinite(durationMs) || durationMs <= 0
      || durationMs < currentTimeoutMs * METRIC_TIMEOUT_HEADROOM_RATIO) {
    return;
  }
  const desiredTimeoutMs = Math.min(
    MAX_AUTO_METRIC_TIMEOUT_MS,
    Math.ceil((durationMs * METRIC_TIMEOUT_HEADROOM_MULTIPLIER) / 1000) * 1000,
  );
  if (desiredTimeoutMs <= currentTimeoutMs) return;
  persistMetricTimeout(
    sessionDir,
    loopConfig,
    desiredTimeoutMs,
    `last successful measurement took ${durationMs}ms`,
  );
}

interface WorkerExperimentArtifact {
  experiment_id: string;
  hypothesis: string;
  hypothesis_family?: string | null;
  differentiator?: string | null;
  rationale: string;
  target_paths?: string[];
  insight?: string | null;
  verification?: string[];
}

function workerExperimentArtifactPath(workerArtifactDir: string): string {
  return path.join(workerArtifactDir, 'microverse-experiment.json');
}

function readWorkerExperimentArtifact(
  workerArtifactDir: string,
  experimentId: string,
  requireCompletionEvidence = false,
): WorkerExperimentArtifact {
  const artifactPath = workerExperimentArtifactPath(workerArtifactDir);
  const artifact = readJsonFile<WorkerExperimentArtifact>(artifactPath, null);
  if (!artifact || artifact.experiment_id !== experimentId
      || typeof artifact.hypothesis !== 'string' || !artifact.hypothesis.trim()
      || typeof artifact.rationale !== 'string' || !artifact.rationale.trim()
      || (artifact.target_paths != null && (!Array.isArray(artifact.target_paths) || artifact.target_paths.some((entry) => typeof entry !== 'string' || !entry.trim())))) {
    throw new Error(`Measured Microverse iteration requires a valid ${artifactPath} for ${experimentId}.`);
  }
  if (artifact.verification != null
      && (!Array.isArray(artifact.verification)
        || artifact.verification.some((entry) => typeof entry !== 'string' || !entry.trim()))) {
    throw new Error(`Measured Microverse artifact ${artifactPath} verification must be a non-empty string array when present; object entries are invalid.`);
  }
  if (requireCompletionEvidence
      && (typeof artifact.insight !== 'string' || !artifact.insight.trim()
        || !Array.isArray(artifact.verification) || artifact.verification.length === 0)) {
    throw new Error(`Frozen Microverse retry artifact ${artifactPath} must add a non-empty insight and verification string array.`);
  }
  return artifact;
}

function adoptOrValidateWorkerExperimentPlan(
  sessionDir: string,
  experimentId: string,
  artifact: WorkerExperimentArtifact,
): void {
  const ledger = readExperimentLedger(sessionDir);
  const record = ledger?.experiments.find((entry) => entry.id === experimentId) || null;
  if (!ledger || !record) throw new Error('Microverse experiment ledger disappeared during plan validation.');
  assertExperimentStrategy(ledger, {
    hypothesisFamily: artifact.hypothesis_family,
    targetPaths: artifact.target_paths,
  });
  if (!isMicroverseExperimentPlanFrozen(record)) {
    updateExperimentPlan(sessionDir, experimentId, {
      hypothesis: artifact.hypothesis,
      hypothesisFamily: artifact.hypothesis_family,
      differentiator: artifact.differentiator,
      rationale: artifact.rationale,
      targetPaths: artifact.target_paths,
    });
    return;
  }
  const clean = (value: string | null | undefined): string | null => value == null ? null : value.trim();
  const paths = (values: string[] | undefined): string[] => [...new Set((values || []).map((entry) => entry.trim()))].sort();
  const samePlan = record.hypothesis === artifact.hypothesis.trim()
    && record.hypothesis_family === clean(artifact.hypothesis_family)
    && record.differentiator === clean(artifact.differentiator)
    && record.rationale === artifact.rationale.trim()
    && JSON.stringify(record.target_paths) === JSON.stringify(paths(artifact.target_paths));
  if (!samePlan) {
    throw new Error(`Retry for ${experimentId} must preserve its frozen hypothesis, family, rationale, differentiator, and target paths.`);
  }
}

function planMicroverseExperiment(
  sessionDir: string,
  loopConfig: LoopConfig,
  iteration: number,
  baselineScore: number,
): MicroverseExperimentRecord {
  const ledger = readExperimentLedger(sessionDir);
  const pending = ledger?.experiments.find((entry) => entry.status === 'planned') || null;
  if (pending) return startExperiment(sessionDir, pending.id);
  const parent = ledger?.experiments.filter((entry) => entry.status === 'accepted').at(-1) || null;
  const sequence = ledger?.next_sequence || 1;
  const record = planExperiment(sessionDir, {
    parentId: parent?.id || null,
    hypothesis: `${MICROVERSE_RUNTIME_PLACEHOLDER_PREFIX}${iteration}`,
    differentiator: `iteration ${iteration}; experiment ${sequence}`,
    rationale: String(loopConfig.task || 'Measured metric improvement'),
    targetPaths: [],
    baselineScore,
  });
  return startExperiment(sessionDir, record.id);
}

function microverseAttemptOrdinal(
  sessionDir: string,
  experiment: MicroverseExperimentRecord | null,
  fallback: number,
): number {
  if (!experiment) return fallback;
  const records = readExperimentLedger(sessionDir)?.experiments || [];
  let priorScientificOutcome = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].status === 'accepted' || records[index].status === 'rejected') {
      priorScientificOutcome = index;
      break;
    }
  }
  return Math.max(
    1,
    records.slice(priorScientificOutcome + 1)
      .reduce((total, record) => total + record.worker_attempts.length, 0),
  );
}

function revertMetricIterationSafely(
  sessionDir: string,
  workingDir: string,
  checkpoint: MetricIterationCheckpoint,
): void {
  const session = path.basename(sessionDir).replace(/[^a-zA-Z0-9._-]/g, '-');
  const changedPaths = listChangedPathsSince(workingDir, checkpoint.head)
    .filter((candidate) => !checkpoint.untracked.includes(candidate));
  recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: checkpoint.head,
    operation: 'microverse-revert',
    ownedPaths: changedPaths
      .filter((candidate) => (checkpoint.ownedPaths || []).some((owned) => (
        candidate === owned || candidate.startsWith(`${owned}/`)
      ))),
    evidencePaths: changedPaths,
    headRecoveryRef: `refs/pickle/microverse-recovery/${session}`,
    log: (message) => appendRunnerLog(sessionDir, message),
  });
}

function microverseAttemptPath(sessionDir: string): string {
  return path.join(sessionDir, 'microverse-attempt.json');
}

function writeMicroverseAttemptTransaction(
  sessionDir: string,
  experiment: MicroverseExperimentRecord,
  iteration: number,
  checkpoint: MetricIterationCheckpoint,
  metricState: MetricConvergenceState,
  candidate?: MicroverseCandidate,
): void {
  atomicWriteJson(microverseAttemptPath(sessionDir), {
    schema_version: candidate ? 2 : 1,
    experiment_id: experiment.id,
    iteration,
    attempt: experiment.attempt,
    checkpoint,
    metric_state_before: metricState,
    candidate_worktree: candidate?.worktreeDir,
    candidate_dev: candidate?.device,
    candidate_ino: candidate?.inode,
    live_working_dir: candidate?.liveWorkingDir,
    live_head: candidate?.baseHead,
    live_ref: candidate?.liveRef,
    live_fingerprint: candidate?.liveFingerprint,
    phase: candidate ? 'running' : undefined,
    created_at: new Date().toISOString(),
  } satisfies MicroverseAttemptTransaction);
}

function persistMicroversePromotion(
  sessionDir: string,
  phase: 'promotion_pending' | 'promoted',
  candidate: MicroverseCandidate,
  metricResult: ReturnType<typeof processMetricIteration>,
  artifact: WorkerExperimentArtifact | null,
): void {
  const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
  if (!transaction || transaction.schema_version !== 2) {
    throw new Error('Cannot persist Microverse promotion without its isolated attempt transaction.');
  }
  atomicWriteJson(microverseAttemptPath(sessionDir), {
    ...transaction,
    phase,
    candidate_head: getHeadSha(candidate.worktreeDir),
    promotion_result: {
      result_score: metricResult.state.latest.score,
      metric_state_after: metricResult.state,
      changed_paths: metricResult.changedPaths,
      diff_artifact: metricResult.diffArtifact,
      insight: artifact?.insight || null,
      verification: artifact?.verification || [],
    },
  } satisfies MicroverseAttemptTransaction);
}

function createMicroverseCandidate(
  sessionDir: string,
  liveWorkingDir: string,
  experiment: MicroverseExperimentRecord,
  checkpoint: MetricIterationCheckpoint,
): MicroverseCandidate {
  const liveFingerprint = getWorkingTreeFingerprint(liveWorkingDir);
  const liveRef = getSymbolicHead(liveWorkingDir);
  const candidate = createIsolatedTicketWorktree({
    repoDir: liveWorkingDir,
    sessionDir: path.join(sessionDir, 'microverse-candidates'),
    ticketId: `${experiment.id}-attempt-${experiment.attempt}`,
    baseRef: checkpoint.head,
  });
  const candidateStat = fs.statSync(candidate.worktreeDir);
  return {
    worktreeDir: candidate.worktreeDir,
    isolationRoot: path.join(sessionDir, 'microverse-candidates', 'isolated-worktrees'),
    device: candidateStat.dev,
    inode: candidateStat.ino,
    liveWorkingDir,
    liveRef,
    baseHead: checkpoint.head,
    liveFingerprint,
  };
}

function discardMicroverseCandidate(candidate: MicroverseCandidate | null): void {
  if (!candidate) return;
  removeIsolatedTicketWorktree(candidate.worktreeDir, candidate.isolationRoot);
}

function archiveMicroverseCandidate(
  sessionDir: string,
  candidate: MicroverseCandidate | null,
  experimentId: string | null,
): ArchivedMicroverseExperiment | null {
  if (!candidate || !experimentId || !fs.existsSync(candidate.worktreeDir)) return null;
  try {
    if (process.env.PICKLE_TEST_MODE === '1' && process.env.PICKLE_TEST_MICROVERSE_ARCHIVE_FAIL === '1') {
      throw new Error('Injected isolated candidate archive failure.');
    }
    const archived = archiveMicroverseExperiment({
      workingDir: candidate.worktreeDir,
      sessionDir,
      experimentId,
      baseRef: candidate.baseHead,
      excludeUntrackedPaths: [],
    });
    const artifactPath = path.resolve(sessionDir, archived.artifact);
    const serialized = fs.readFileSync(artifactPath);
    const digest = crypto.createHash('sha256').update(serialized).digest('hex');
    const payload = JSON.parse(serialized.toString('utf8')) as Record<string, unknown>;
    if (digest !== archived.sha256 || payload.experiment_id !== experimentId || payload.base_ref !== candidate.baseHead) {
      throw new Error('Isolated candidate archive verification failed.');
    }
    const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
    if (transaction?.experiment_id === experimentId) {
      atomicWriteJson(microverseAttemptPath(sessionDir), {
        ...transaction,
        archive_receipt: {
          artifact: archived.artifact,
          sha256: archived.sha256,
          experiment_id: experimentId,
          base_ref: candidate.baseHead,
        },
      } satisfies MicroverseAttemptTransaction);
    }
    return archived;
  } catch (error) {
    const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
    if (transaction?.experiment_id === experimentId) {
      atomicWriteJson(microverseAttemptPath(sessionDir), {
        ...transaction,
        phase: 'quarantined',
        quarantine_reason: safeErrorMessage(error),
      } satisfies MicroverseAttemptTransaction);
    }
    throw new MicroverseCandidateArchiveError(
      `Could not durably archive isolated candidate ${experimentId}; candidate retained for quarantine.`,
      { cause: error },
    );
  }
}

function transactionCandidate(sessionDir: string, transaction: MicroverseAttemptTransaction): MicroverseCandidate | null {
  if (!transaction.candidate_worktree || !transaction.live_working_dir
      || !transaction.live_head || !transaction.live_fingerprint
      || !Object.hasOwn(transaction, 'live_ref')
      || !Number.isInteger(transaction.candidate_dev) || !Number.isInteger(transaction.candidate_ino)) return null;
  const candidateRoot = path.resolve(sessionDir, 'microverse-candidates', 'isolated-worktrees');
  const candidatePath = path.resolve(transaction.candidate_worktree);
  if (candidatePath === candidateRoot || !candidatePath.startsWith(`${candidateRoot}${path.sep}`)) {
    throw new Error('Invalid durable Microverse candidate path.');
  }
  const candidateLstat = fs.lstatSync(candidatePath);
  if (candidateLstat.isSymbolicLink()
      || candidateLstat.dev !== transaction.candidate_dev
      || candidateLstat.ino !== transaction.candidate_ino) {
    throw new Error('Durable Microverse candidate identity changed.');
  }
  return {
    worktreeDir: candidatePath,
    isolationRoot: candidateRoot,
    device: candidateLstat.dev,
    inode: candidateLstat.ino,
    liveWorkingDir: transaction.live_working_dir,
    liveRef: transaction.live_ref ?? null,
    baseHead: transaction.live_head,
    liveFingerprint: transaction.live_fingerprint,
  };
}

function promoteMicroverseCandidate(
  sessionDir: string,
  candidate: MicroverseCandidate,
  experimentId: string,
  expectedCandidateHead: string,
): string[] {
  const changedPaths = listChangedPathsSince(candidate.worktreeDir, candidate.baseHead);
  if (changedPaths.length === 0) return [];
  const liveHead = getHeadSha(candidate.liveWorkingDir);
  const liveFingerprint = getWorkingTreeFingerprint(candidate.liveWorkingDir);
  const liveRef = getSymbolicHead(candidate.liveWorkingDir);
  if (liveHead !== candidate.baseHead || liveRef !== candidate.liveRef
      || liveFingerprint !== candidate.liveFingerprint) {
    const patchDir = path.join(sessionDir, 'microverse-candidate-patches');
    fs.mkdirSync(patchDir, { recursive: true, mode: 0o700 });
    const patchPath = path.join(patchDir, `${experimentId}.patch`);
    createPatchFromWorktree(candidate.worktreeDir, candidate.baseHead, patchPath);
    throw new MicroversePromotionDeferredError(
      `Live workspace changed during ${experimentId}; candidate preserved at ${patchPath} for safe retry.`,
    );
  }

  const patchDir = path.join(sessionDir, 'microverse-candidate-patches');
  fs.mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  const patchPath = path.join(patchDir, `${experimentId}.patch`);
  createPatchFromWorktree(candidate.worktreeDir, candidate.baseHead, patchPath);
  const candidateHead = getHeadSha(candidate.worktreeDir);
  if (!candidateHead || candidateHead === candidate.baseHead || candidateHead !== expectedCandidateHead) {
    throw new Error(`Accepted Microverse candidate ${experimentId} has no committed improvement.`);
  }
  fastForwardFromIsolatedCandidate(
    candidate.liveWorkingDir,
    candidate.worktreeDir,
    candidate.baseHead,
    expectedCandidateHead,
    candidate.liveRef,
  );
  return changedPaths;
}

function clearMicroverseAttemptTransaction(sessionDir: string): void {
  fs.rmSync(microverseAttemptPath(sessionDir), { force: true });
}

function microverseAttemptHasTerminalOutcome(sessionDir: string): boolean {
  const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
  if (!transaction) return false;
  const experiment = readExperimentLedger(sessionDir)?.experiments.find((entry) => entry.id === transaction.experiment_id);
  return experiment?.status === 'accepted' || experiment?.status === 'rejected';
}

function recoverInterruptedMicroverseAttempt(sessionDir: string, workingDir: string): string[] {
  const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
  if (!transaction) return [];
  if (![1, 2].includes(transaction.schema_version) || !/^exp-\d{4,}$/.test(transaction.experiment_id)
      || !Number.isInteger(transaction.iteration) || !Number.isInteger(transaction.attempt)
      || !transaction.checkpoint || !transaction.metric_state_before) {
    throw new Error('Invalid durable Microverse attempt transaction.');
  }
  if (transaction.schema_version === 2) {
    try {
      if (!transactionCandidate(sessionDir, transaction)) {
        throw new Error('Missing durable isolated candidate identity.');
      }
    } catch (error) {
      const reason = safeErrorMessage(error);
      atomicWriteJson(microverseAttemptPath(sessionDir), {
        ...transaction,
        phase: 'quarantined',
        quarantine_reason: reason,
      } satisfies MicroverseAttemptTransaction);
      throw new MicroverseCandidateArchiveError(
        `Isolated candidate ${transaction.experiment_id} identity is invalid; candidate retained for quarantine.`,
        { cause: error },
      );
    }
  }
  if (transaction.schema_version === 2 && transaction.phase === 'quarantined') {
    throw new MicroverseCandidateArchiveError(
      `Isolated candidate ${transaction.experiment_id} remains quarantined: ${transaction.quarantine_reason || 'archive unavailable'}.`,
    );
  }
  const ledger = readExperimentLedger(sessionDir);
  const experiment = ledger?.experiments.find((entry) => entry.id === transaction.experiment_id) || null;
  if (transaction.schema_version === 2
      && (transaction.phase === 'promotion_pending' || transaction.phase === 'promoted')) {
    const candidate = transactionCandidate(sessionDir, transaction)!;
    if (fs.realpathSync(candidate.liveWorkingDir) !== fs.realpathSync(workingDir)) {
      throw new Error('Durable Microverse promotion belongs to a different live checkout.');
    }
    const promotion = transaction.promotion_result;
    if (!promotion || !transaction.candidate_head) {
      throw new Error('Invalid durable Microverse promotion transaction.');
    }
    const liveHead = getHeadSha(workingDir);
    const alreadyPromoted = liveHead === transaction.candidate_head
      || commitIsAncestorWithPathsUnchanged(
        workingDir,
        transaction.candidate_head,
        promotion.changed_paths,
      );
    if (!alreadyPromoted) {
      if (transaction.phase === 'promoted') {
        throw new Error('Promoted Microverse candidate paths no longer match the live repository history.');
      }
      if (liveHead !== transaction.live_head
          || getSymbolicHead(workingDir) !== transaction.live_ref
          || getWorkingTreeFingerprint(workingDir) !== transaction.live_fingerprint) {
        throw new MicroversePromotionDeferredError(
          `Live workspace still differs from the ${transaction.experiment_id} promotion boundary; candidate remains pending.`,
        );
      }
      promoteMicroverseCandidate(sessionDir, candidate, transaction.experiment_id, transaction.candidate_head);
      atomicWriteJson(microverseAttemptPath(sessionDir), { ...transaction, phase: 'promoted' });
    }
    if (experiment && experiment.status === 'running') {
      completeExperiment(sessionDir, experiment.id, {
        status: 'accepted',
        classification: 'improved',
        resultScore: promotion.result_score,
        changedPaths: promotion.changed_paths,
        diffArtifact: promotion.diff_artifact,
        insight: promotion.insight,
        verification: promotion.verification,
      });
    }
    const recoveredLedger = readExperimentLedger(sessionDir);
    writeMetricConvergenceState(sessionDir, promotion.metric_state_after);
    const manager = new StateManager();
    manager.update(path.join(sessionDir, 'state.json'), (current) => {
      current.iteration = Math.max(Number(current.iteration || 0), transaction.iteration);
      current.loop_stall_count = recoveredLedger?.experiment_stall_count || 0;
      current.worker_failure_count = recoveredLedger?.worker_failure_count || 0;
      return current;
    });
    writeMetricSummary(sessionDir, promotion.metric_state_after);
    discardMicroverseCandidate(candidate);
    clearMicroverseAttemptTransaction(sessionDir);
    return [];
  }
  if (experiment && ['accepted', 'rejected', 'invalid'].includes(experiment.status)) {
    if (experiment.status === 'accepted' || experiment.status === 'rejected') {
      const manager = new StateManager();
      manager.update(path.join(sessionDir, 'state.json'), (current) => {
        current.iteration = Math.max(Number(current.iteration || 0), transaction.iteration);
        current.loop_stall_count = ledger?.experiment_stall_count || 0;
        current.worker_failure_count = ledger?.worker_failure_count || 0;
        return current;
      });
    }
    const metric = readMetricConvergenceState(sessionDir);
    if (metric) writeMetricSummary(sessionDir, metric);
    discardMicroverseCandidate(transactionCandidate(sessionDir, transaction));
    clearMicroverseAttemptTransaction(sessionDir);
    return [];
  }
  const candidate = transactionCandidate(sessionDir, transaction);
  if (candidate) {
    if (fs.realpathSync(candidate.liveWorkingDir) !== fs.realpathSync(workingDir)) {
      throw new Error('Durable Microverse candidate belongs to a different live checkout.');
    }
    archiveMicroverseCandidate(sessionDir, candidate, transaction.experiment_id);
    discardMicroverseCandidate(candidate);
  } else {
    // Backward-compatible recovery for transactions created before isolated
    // candidate worktrees were introduced.
    const legacyCheckpoint = transaction.schema_version === 1
        && (!Array.isArray(transaction.checkpoint.ownedPaths) || transaction.checkpoint.ownedPaths.length === 0)
      ? {
        ...transaction.checkpoint,
        ownedPaths: listChangedPathsSince(workingDir, transaction.checkpoint.head),
      }
      : transaction.checkpoint;
    revertMetricIterationSafely(sessionDir, workingDir, legacyCheckpoint);
  }
  writeMetricConvergenceState(sessionDir, transaction.metric_state_before);
  const reconciled = reconcileRunningExperiments(sessionDir, {
    mode: 'resume',
    insight: 'Interrupted attempt restored from its durable repository and metric checkpoint.',
  });
  writeMetricSummary(sessionDir, transaction.metric_state_before);
  clearMicroverseAttemptTransaction(sessionDir);
  return reconciled.reconciled_ids;
}

function finalizeMicroverseAttemptOnExit(sessionDir: string, exitReason: string): string[] {
  const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
  const ledger = readExperimentLedger(sessionDir);
  const experiment = transaction
    ? ledger?.experiments.find((entry) => entry.id === transaction.experiment_id) || null
    : null;
  if (transaction && experiment && (experiment.status === 'accepted' || experiment.status === 'rejected')) {
    const manager = new StateManager();
    manager.update(path.join(sessionDir, 'state.json'), (current) => {
      current.iteration = Math.max(Number(current.iteration || 0), transaction.iteration);
      current.loop_stall_count = ledger?.experiment_stall_count || 0;
      current.worker_failure_count = ledger?.worker_failure_count || 0;
      return current;
    });
    const metric = readMetricConvergenceState(sessionDir);
    if (metric) writeMetricSummary(sessionDir, metric);
    discardMicroverseCandidate(transactionCandidate(sessionDir, transaction));
    clearMicroverseAttemptTransaction(sessionDir);
    return [];
  }
  if (transaction?.metric_state_before) {
    writeMetricConvergenceState(sessionDir, transaction.metric_state_before);
  }
  const reconciled = reconcileRunningExperiments(sessionDir, {
    mode: 'cancel',
    insight: `Worker attempt abandoned when loop stopped with ${exitReason}.`,
  });
  const metric = readMetricConvergenceState(sessionDir);
  if (metric) writeMetricSummary(sessionDir, metric);
  if (transaction) discardMicroverseCandidate(transactionCandidate(sessionDir, transaction));
  clearMicroverseAttemptTransaction(sessionDir);
  return reconciled.reconciled_ids;
}

function ensureMetricBaseline(sessionDir: string, loopConfig: LoopConfig, workingDir: string): MetricConvergenceState | null {
  if (!isMeasuredMicroverse(loopConfig)) return null;
  const command = String(loopConfig.metric).trim();
  const direction = normalizeMetricDirection(loopConfig.direction ?? 'higher');
  const tolerance = normalizeMetricTolerance(loopConfig.tolerance ?? 0);
  const target = normalizeMetricTargetContract(direction, loopConfig.target, loopConfig.target_relation);
  const existing = readMetricConvergenceState(sessionDir);
  if (existing) {
    if (existing.command !== command || existing.direction !== direction || existing.tolerance !== tolerance
        || existing.target !== target.target || existing.target_relation !== target.target_relation) {
      throw new Error('Cannot change the metric command, direction, tolerance, or target while resuming a Microverse session.');
    }
    captureMetricIterationCheckpoint(workingDir);
    return existing;
  }
  const checkpoint = captureMetricIterationCheckpoint(workingDir);
  const baselineSessionDir = path.join(sessionDir, 'microverse-baseline');
  const isolated = createIsolatedTicketWorktree({
    repoDir: workingDir,
    sessionDir: baselineSessionDir,
    ticketId: 'metric-baseline',
    baseRef: checkpoint.head,
  });
  const isolatedRoot = path.join(baselineSessionDir, 'isolated-worktrees');
  let baseline;
  try {
    baseline = measureMetric(command, { cwd: isolated.worktreeDir, timeoutMs: metricTimeoutMs(loopConfig) });
  } finally {
    removeIsolatedTicketWorktree(isolated.worktreeDir, isolatedRoot);
  }
  const state = createMetricConvergenceState(baseline, direction, tolerance, target.target, target.target_relation);
  ensureMetricTimeoutHeadroom(sessionDir, loopConfig, baseline);
  writeMetricConvergenceState(sessionDir, state);
  appendRunnerLog(sessionDir, `microverse baseline measured: ${baseline.score}`);
  return state;
}

function writeMetricSummary(sessionDir: string, state: MetricConvergenceState): void {
  const ledger = readExperimentLedger(sessionDir);
  const convergence = ledger ? researchConvergenceState(ledger) : null;
  const summary = {
    objective: 'measured metric convergence',
    baseline: state.baseline.score,
    latest_result: state.latest.score,
    best_result: state.best.score,
    direction: state.direction,
    tolerance: state.tolerance,
    target: state.target,
    target_relation: state.target_relation,
    target_satisfied: metricStateTargetSatisfied(state),
    stall_count: state.stall_count,
    experiment_stall_count: ledger?.experiment_stall_count || 0,
    worker_failure_count: ledger?.worker_failure_count || 0,
    convergence_level: convergence?.level || 'none',
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
    `- Target: ${state.target === null ? 'not configured' : `${state.target_relation} ${state.target}`}`,
    `- Target satisfied: ${metricStateTargetSatisfied(state)}`,
    `- Experiment stall count: ${ledger?.experiment_stall_count || 0}`,
    `- Worker failure count: ${ledger?.worker_failure_count || 0}`,
    `- Convergence: ${convergence?.level || 'none'}`,
    '',
  ].join('\n'));
}

function processMetricIteration(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  checkpoint: MetricIterationCheckpoint,
  iteration: number,
  experimentId: string,
  archivedEvidence: ArchivedMicroverseExperiment | null,
): { classification: Exclude<MetricClassification, 'baseline'>; state: MetricConvergenceState; changedPaths: string[]; diffArtifact: string | null } {
  const currentState = readMetricConvergenceState(sessionDir);
  if (!currentState) throw new Error('Microverse metric state disappeared during an iteration.');
  const attemptedHead = getHeadSha(workingDir) || checkpoint.head;
  const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  const repositoryChanged = attemptedHead !== checkpoint.head || dirtyPaths.length > 0;
  const evidence = repositoryChanged ? archivedEvidence : null;
  if (repositoryChanged && !evidence) {
    throw new Error(`Microverse candidate ${experimentId} has no verified durable archive.`);
  }
  let measurement;
  try {
    measurement = measureMetric(currentState.command, {
      cwd: workingDir,
      timeoutMs: metricTimeoutMs(loopConfig),
    });
  } catch (error) {
    throw new PostWorkerMetricMeasurementError(error);
  }
  ensureMetricTimeoutHeadroom(sessionDir, loopConfig, measurement);
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
  return {
    ...recorded,
    changedPaths: evidence?.changedPaths ?? [],
    diffArtifact: evidence?.artifact ?? null,
  };
}

function recoverCandidateInducedMetricFailure(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  checkpoint: MetricIterationCheckpoint,
  metricState: MetricConvergenceState,
  failure: PostWorkerMetricMeasurementError,
): string {
  revertMetricIterationSafely(sessionDir, workingDir, checkpoint);

  let restoredMeasurement;
  let restoredTimeoutMs = metricTimeoutMs(loopConfig);
  let timeoutExpansion: string | null = null;
  try {
    restoredMeasurement = measureMetric(metricState.command, {
      cwd: workingDir,
      timeoutMs: restoredTimeoutMs,
    });
  } catch (restoredError) {
    if (restoredError instanceof MetricTimeoutError && restoredTimeoutMs < MAX_AUTO_METRIC_TIMEOUT_MS) {
      const previousTimeoutMs = restoredTimeoutMs;
      restoredTimeoutMs = Math.min(
        MAX_AUTO_METRIC_TIMEOUT_MS,
        restoredTimeoutMs * METRIC_TIMEOUT_HEADROOM_MULTIPLIER,
      );
      timeoutExpansion = `checkpoint replay exceeded ${previousTimeoutMs}ms; expanded metric timeout to ${restoredTimeoutMs}ms`;
      persistMetricTimeout(sessionDir, loopConfig, restoredTimeoutMs, timeoutExpansion);
      try {
        restoredMeasurement = measureMetric(metricState.command, {
          cwd: workingDir,
          timeoutMs: restoredTimeoutMs,
        });
      } catch (expandedError) {
        throw new AggregateError(
          [failure.measurementError, restoredError, expandedError],
          `Post-worker metric measurement failed and the checkpoint metric remained invalid after automatic timeout expansion: ${safeErrorMessage(expandedError)}`,
          { cause: expandedError },
        );
      }
    } else {
      throw new AggregateError(
        [failure.measurementError, restoredError],
        `Post-worker metric measurement failed and the checkpoint metric remained invalid after rollback: ${safeErrorMessage(restoredError)}`,
        { cause: restoredError },
      );
    }
  }

  if (restoredMeasurement.score !== metricState.best.score) {
    throw new Error(
      `Post-worker metric measurement failed and rollback produced score ${restoredMeasurement.score}; expected stable checkpoint score ${metricState.best.score}.`,
    );
  }

  ensureMetricTimeoutHeadroom(sessionDir, loopConfig, restoredMeasurement);
  writeMetricConvergenceState(sessionDir, metricState);
  writeMetricSummary(sessionDir, metricState);
  const expansionDetail = timeoutExpansion ? `; ${timeoutExpansion}` : '';
  return `Post-worker metric validation failed while the restored checkpoint remained valid at ${restoredMeasurement.score}${expansionDetail}: ${safeErrorMessage(failure.measurementError)}`;
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

/**
 * A Microverse experiment owns only the repository paths declared in its
 * experiment artifact.  This is deliberately file- and campaign-agnostic:
 * the experiment contract, rather than a particular scorer or artifact
 * format, defines the writable surface.
 */
function enforceMicroverseExperimentScope(
  sessionDir: string,
  loopConfig: LoopConfig,
  workingDir: string,
  beforeSnapshot: ProgressSnapshot,
  beforeUntrackedFiles: string[],
  experiment: WorkerExperimentArtifact,
): void {
  if (!isMeasuredMicroverse(loopConfig) || loopConfig.dry_run) return;
  const targetPaths = experiment.target_paths ?? [];
  enforceLoopMutationScope({
    sessionDir,
    workingDir,
    mode: loopConfig.mode,
    beforeHead: String(beforeSnapshot.head_sha || ''),
    allowedPaths: targetPaths,
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

interface RunLoopOptions {
  operationLeaseHeld?: boolean;
  launchOwnerPid?: number | null;
  runStartedAtMs?: number;
}

async function runLoopWithLease(sessionDir: string, runStartedAtMs: number): Promise<void> {
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const config = loadConfig();
  const loopConfig = readLoopConfig(sessionDir);
  const initialState = manager.read(statePath);

  claimLoopRunnerStartup(manager, statePath, { runStartedAtMs });
  appendRunnerLog(sessionDir, `loop-runner started (${loopConfig.mode})`);
  assertControlPlaneOutsideWorkerCwd(sessionDir, initialState.working_dir as string);
  if (isMeasuredMicroverse(loopConfig)) {
    const resetFailures = resetWorkerFailureCount(sessionDir);
    if (resetFailures > 0) {
      manager.update(statePath, (current) => {
        current.worker_failure_count = 0;
        return current;
      });
      appendRunnerLog(sessionDir, `microverse reset ${resetFailures} prior-run worker failures on relaunch`);
    }
    let recovered: string[];
    try {
      recovered = recoverInterruptedMicroverseAttempt(sessionDir, initialState.working_dir as string);
    } catch (error) {
      if (error instanceof MicroverseCandidateArchiveError) {
        manager.update(statePath, (current) => {
          current.last_loop_message = error.message;
          return current;
        });
        const finalReason = exitLoopRunnerPhase(manager, statePath, 'error');
        writeStopSummaryArtifacts(sessionDir, loopConfig, manager.read(statePath), finalReason);
        appendRunnerLog(sessionDir, error.message);
        appendRunnerLog(sessionDir, `loop-runner finished: ${finalReason}`);
        throw error;
      }
      if (!(error instanceof MicroversePromotionDeferredError)) throw error;
      manager.update(statePath, (current) => {
        current.last_loop_message = error.message;
        return current;
      });
      const finalReason = exitLoopRunnerPhase(manager, statePath, 'workspace_changed');
      writeStopSummaryArtifacts(sessionDir, loopConfig, manager.read(statePath), finalReason);
      appendRunnerLog(sessionDir, error.message);
      appendRunnerLog(sessionDir, `loop-runner finished: ${finalReason}`);
      return;
    }
    if (recovered.length > 0) {
      appendRunnerLog(sessionDir, `microverse restored interrupted attempt checkpoint: ${recovered.join(', ')}`);
    }
  }
  ensureAdvancedLoopCleanTrackedPreflight(sessionDir, loopConfig, initialState.working_dir as string);
  if (isMeasuredMicroverse(loopConfig)) {
    const reconciled = reconcileRunningExperiments(sessionDir, { mode: 'resume' });
    if (reconciled.reconciled_ids.length > 0) {
      appendRunnerLog(sessionDir, `microverse reconciled interrupted experiments: ${reconciled.reconciled_ids.join(', ')}`);
    }
  }
  ensureMetricBaseline(sessionDir, loopConfig, initialState.working_dir as string);
  enterLoopRunnerPhase(manager, statePath, loopConfig.mode, { runStartedAtMs });

  let exitReason = 'success';
  let thrownError: unknown = null;
  let promotionDeferred = false;
  let pendingMetricIteration: {
    cwd: string;
    checkpoint: MetricIterationCheckpoint;
    candidate: MicroverseCandidate | null;
    experimentId: string | null;
  } | null = null;
  try {
    while (true) {
      const state = manager.read(statePath);
      if (state.active === false) {
        exitReason = (state.last_exit_reason as string | null) || 'cancelled';
        break;
      }
      const currentMetricState = isMeasuredMicroverse(loopConfig)
        ? readMetricConvergenceState(sessionDir)
        : null;
      if (currentMetricState && metricStateTargetSatisfied(currentMetricState)) {
        exitReason = 'success';
        appendRunnerLog(sessionDir, `microverse runtime target satisfied at ${currentMetricState.best.score}`);
        break;
      }
      const currentLedger = currentMetricState ? readExperimentLedger(sessionDir) : null;
      if (currentLedger && researchConvergenceState(currentLedger).level === 'stalled') {
        appendRunnerLog(
          sessionDir,
          'microverse research stall threshold reached; continuing with a mandatory non-exhausted hypothesis family',
        );
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
        if (currentMetricState) {
          resetCircuitBreaker(sessionDir, 'microverse recovery continues below target');
          appendRunnerLog(sessionDir, 'microverse reset an OPEN no-progress circuit and continued below target');
        } else {
          exitReason = 'circuit_open';
          appendRunnerLog(sessionDir, 'refusing iteration: circuit breaker is OPEN');
          break;
        }
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
      const iteration = (state.iteration as number) + 1;
      const experiment = metricCheckpoint && currentMetricState
        ? planMicroverseExperiment(sessionDir, loopConfig, iteration, currentMetricState.best.score)
        : null;
      const candidate = experiment && metricCheckpoint
        ? createMicroverseCandidate(sessionDir, state.working_dir as string, experiment, metricCheckpoint)
        : null;
      const iterationWorkingDir = candidate?.worktreeDir || state.working_dir as string;
      const iterationBeforeSnapshot = candidate
        ? captureProgressSnapshot({
          sessionDir,
          workingDir: iterationWorkingDir,
          mode: loopConfig.mode,
          step: state.step as string | null,
          currentTicket: state.current_ticket as string | null,
        })
        : beforeSnapshot;
      pendingMetricIteration = metricCheckpoint
        ? { cwd: iterationWorkingDir, checkpoint: metricCheckpoint, candidate, experimentId: experiment?.id || null }
        : null;
      if (experiment && metricCheckpoint && currentMetricState) {
        writeMicroverseAttemptTransaction(
          sessionDir,
          experiment,
          iteration,
          metricCheckpoint,
          currentMetricState,
          candidate || undefined,
        );
      }
      const protectedManifest: ProtectedPathManifest | null = metricCheckpoint
        ? captureProtectedPathManifest(iterationWorkingDir, loopConfig.protected_paths)
        : null;
      const beforeUntrackedFiles = isGitRepo(iterationWorkingDir)
        ? listUntrackedFiles(iterationWorkingDir)
        : [];
      manager.update(statePath, (current) => {
        if (!metricCheckpoint) current.iteration = (current.iteration as number) + 1;
        current.step = loopConfig.mode;
        appendHistory(current, loopConfig.mode, current.current_ticket || undefined);
        return current;
      });

      const attempt = experiment?.attempt ?? 1;
      const attemptOrdinal = microverseAttemptOrdinal(sessionDir, experiment, attempt);
      const workerArtifactDir = createWorkerArtifactDir(sessionDir, loopConfig.mode, iteration, attemptOrdinal);
      const workerSummaries = workerSummaryPaths(workerArtifactDir, loopConfig.mode);
      const experimentArtifactPath = experiment
        ? workerExperimentArtifactPath(workerArtifactDir)
        : null;
      const experimentContextPath = experiment && experimentArtifactPath && currentMetricState
        ? writeMicroverseWorkerHandoff({
          sessionDir,
          workerArtifactDir,
          workingDir: iterationWorkingDir,
          iteration,
          loopConfig,
          metricState: currentMetricState,
          experiment,
          experimentArtifactPath,
        })
        : null;
      const controlSnapshots = captureControlFiles(sessionDir);
      const outputLastMessagePath = createOutputLastMessagePath(sessionDir, loopConfig.mode, iteration, attemptOrdinal);
      fs.rmSync(outputLastMessagePath, { force: true });
      const result = await runCodexExecMonitored({
        telemetry: {
          sessionDir,
          ticketId: experiment?.id || loopConfig.mode,
          phase: loopConfig.mode,
          ticketAttempt: iteration,
          phaseAttempt: attemptOrdinal,
        },
        cwd: iterationWorkingDir,
        prompt: buildLoopPrompt({
          mode: loopConfig.mode,
          sessionDir,
          workerArtifactDir,
          workingDir: iterationWorkingDir,
          state: manager.read(statePath) as unknown as LoopPromptState,
          loopConfig: {
            ...loopConfig,
            experiment_id: experiment?.id,
            experiment_artifact_path: experimentArtifactPath || undefined,
            experiment_context_path: experimentContextPath || undefined,
          } as unknown as LoopPromptConfig,
        }),
        timeoutMs: getWorkerTimeoutMs(state, config),
        outputLastMessagePath,
        progressArtifactPaths: Object.values(workerSummaries),
        addDirs: [workerArtifactDir],
        inheritConfiguredAddDirs: false,
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
      const tamperedControlFiles = restoreTamperedControlFiles(controlSnapshots);
      if (result.cancelled || manager.read(statePath).active === false) {
        exitReason = (manager.read(statePath).last_exit_reason as string | null) || 'cancelled';
        break;
      }
      const completionToken = authoritativeLoopCompletionToken(outputLastMessagePath);
      writeWorkerDiagnostics(
        sessionDir,
        loopConfig.mode,
        iteration,
        attemptOrdinal,
        outputLastMessagePath,
        result,
        completionToken,
      );
      let workerFailure: MicroverseWorkerFailure | null = result.timedOut
        ? 'worker_timeout'
        : result.exitCode !== 0
          ? 'worker_error'
          : completionToken
            ? null
            : 'worker_incomplete';
      let workerFailureDetail = workerFailure
        ? `${loopConfig.mode} worker ended as ${workerFailure} (exit ${result.exitCode})`
        : '';
      if (tamperedControlFiles.length > 0) {
        workerFailure = 'protected_path_tamper';
        workerFailureDetail = `Runtime control files changed and were restored: ${tamperedControlFiles.join(', ')}`;
      }
      let experimentArtifact: WorkerExperimentArtifact | null = null;
      if (!workerFailure && experiment) {
        try {
          experimentArtifact = readWorkerExperimentArtifact(
            workerArtifactDir,
            experiment.id,
            isMicroverseExperimentPlanFrozen(experiment),
          );
          adoptOrValidateWorkerExperimentPlan(sessionDir, experiment.id, experimentArtifact);
          if (metricCheckpoint && currentMetricState) {
            metricCheckpoint.ownedPaths = [...new Set(experimentArtifact.target_paths)].sort();
            writeMicroverseAttemptTransaction(
              sessionDir,
              experiment,
              iteration,
              metricCheckpoint,
              currentMetricState,
              candidate || undefined,
            );
          }
        } catch (error) {
          workerFailure = 'worker_incomplete';
          workerFailureDetail = safeErrorMessage(error);
        }
      }
      if (tamperedControlFiles.length > 0 && !metricCheckpoint) {
        throw new Error(workerFailureDetail);
      }
      if (protectedManifest) {
        const protectedChanges = changedProtectedPaths(iterationWorkingDir, protectedManifest);
        if (protectedChanges.length > 0) {
          workerFailure = 'protected_path_tamper';
          workerFailureDetail = `Protected evaluation paths changed: ${protectedChanges.join(', ')}`;
        }
      }
      if (workerFailure && metricCheckpoint && experiment) {
        archiveMicroverseCandidate(sessionDir, candidate, experiment.id);
        revertMetricIterationSafely(sessionDir, iterationWorkingDir, metricCheckpoint);
        discardMicroverseCandidate(candidate);
        pendingMetricIteration = null;
        recordWorkerAttemptFailure(sessionDir, experiment.id, {
          classification: workerFailure,
          insight: workerFailureDetail,
        });
        const failures = readExperimentLedger(sessionDir)?.worker_failure_count || 0;
        manager.update(statePath, (current) => {
          current.worker_failure_count = failures;
          current.last_loop_message = workerFailureDetail;
          return current;
        });
        appendRunnerLog(sessionDir, `microverse ${workerFailure}: ${workerFailureDetail} (${failures} consecutive worker failures)`);
        const recovered = recoverMicroverseWorkerFailure(
          sessionDir,
          statePath,
          manager,
          config,
          loopConfig,
          experiment,
          workerFailure,
          workerFailureDetail,
          failures,
        );
        if (!recovered) {
          abandonPlannedExperiment(sessionDir, experiment.id, {
            classification: workerFailure,
            insight: `${workerFailureDetail}; unsafe worker failure limit reached.`,
          });
          clearMicroverseAttemptTransaction(sessionDir);
          exitReason = 'worker_failure_limit';
          break;
        }
        clearMicroverseAttemptTransaction(sessionDir);
        continue;
      }
      assertCodexSucceeded(result, `${loopConfig.mode} iteration failed`);
      if (!completionToken) throw new Error(`${loopConfig.mode} iteration exited without exactly one authoritative completion token in --output-last-message`);

      const lastMessage = readLastMessageArtifact(outputLastMessagePath);
      appendRunnerLog(sessionDir, `iteration ${iteration} finished`);

      promoteWorkerSummaryArtifacts(workerArtifactDir, sessionDir, loopConfig.mode);

      enforceAdvancedLoopScope(
        sessionDir,
        loopConfig,
        iterationWorkingDir,
        iterationBeforeSnapshot,
        beforeUntrackedFiles,
      );

      autoCommitAdvancedLoopIteration(
        sessionDir,
        loopConfig,
        iterationWorkingDir,
        iterationBeforeSnapshot,
        iteration,
        beforeUntrackedFiles,
      );

      if (metricCheckpoint && experiment && experimentArtifact) {
        try {
          enforceMicroverseExperimentScope(
            sessionDir,
            loopConfig,
            iterationWorkingDir,
            iterationBeforeSnapshot,
            beforeUntrackedFiles,
            experimentArtifact,
          );
        } catch (error) {
          if (!(error instanceof PipelineScopeError)) throw error;
          const workerFailureDetail = safeErrorMessage(error);
          archiveMicroverseCandidate(sessionDir, candidate, experiment.id);
          revertMetricIterationSafely(sessionDir, iterationWorkingDir, metricCheckpoint);
          discardMicroverseCandidate(candidate);
          pendingMetricIteration = null;
          recordWorkerAttemptFailure(sessionDir, experiment.id, {
            classification: 'worker_incomplete',
            insight: workerFailureDetail,
          });
          const failures = readExperimentLedger(sessionDir)?.worker_failure_count || 0;
          manager.update(statePath, (current) => {
            current.worker_failure_count = failures;
            current.last_loop_message = workerFailureDetail;
            return current;
          });
          appendRunnerLog(
            sessionDir,
            `microverse worker_incomplete: ${workerFailureDetail} (${failures} consecutive worker failures)`,
          );
          const recovered = recoverMicroverseWorkerFailure(
            sessionDir,
            statePath,
            manager,
            config,
            loopConfig,
            experiment,
            'worker_incomplete',
            workerFailureDetail,
            failures,
          );
          if (!recovered) {
            abandonPlannedExperiment(sessionDir, experiment.id, {
              classification: 'worker_incomplete',
              insight: `${workerFailureDetail}; unsafe worker failure limit reached.`,
            });
            clearMicroverseAttemptTransaction(sessionDir);
            exitReason = 'worker_failure_limit';
            break;
          }
          clearMicroverseAttemptTransaction(sessionDir);
          continue;
        }
      }

      const candidateEvidence = metricCheckpoint && experiment && candidate
        ? archiveMicroverseCandidate(sessionDir, candidate, experiment.id)
        : null;
      let metricResult: ReturnType<typeof processMetricIteration> | null = null;
      if (metricCheckpoint && experiment && currentMetricState) {
        try {
          metricResult = processMetricIteration(
            sessionDir,
            loopConfig,
            iterationWorkingDir,
            metricCheckpoint,
            iteration,
            experiment.id,
            candidateEvidence,
          );
        } catch (error) {
          if (!(error instanceof PostWorkerMetricMeasurementError)) throw error;

          const workerFailureDetail = recoverCandidateInducedMetricFailure(
            sessionDir,
            loopConfig,
            iterationWorkingDir,
            metricCheckpoint,
            currentMetricState,
            error,
          );
          discardMicroverseCandidate(candidate);
          pendingMetricIteration = null;
          recordWorkerAttemptFailure(sessionDir, experiment.id, {
            classification: 'worker_incomplete',
            insight: workerFailureDetail,
          });
          const failures = readExperimentLedger(sessionDir)?.worker_failure_count || 0;
          manager.update(statePath, (current) => {
            current.worker_failure_count = failures;
            current.last_loop_message = workerFailureDetail;
            return current;
          });
          appendRunnerLog(
            sessionDir,
            `microverse worker_incomplete: ${workerFailureDetail} (${failures} consecutive worker failures)`,
          );
          const recovered = recoverMicroverseWorkerFailure(
            sessionDir,
            statePath,
            manager,
            config,
            loopConfig,
            experiment,
            'worker_incomplete',
            workerFailureDetail,
            failures,
          );
          if (!recovered) {
            abandonPlannedExperiment(sessionDir, experiment.id, {
              classification: 'worker_incomplete',
              insight: `${workerFailureDetail}; unsafe worker failure limit reached.`,
            });
            clearMicroverseAttemptTransaction(sessionDir);
            exitReason = 'worker_failure_limit';
            break;
          }
          clearMicroverseAttemptTransaction(sessionDir);
          continue;
        }
      }

      if (metricResult && experiment) {
        if (metricResult.classification === 'improved' && candidate) {
          const normalizedCandidateHead = normalizeIsolatedCandidateCommit(
            candidate.worktreeDir,
            candidate.baseHead,
            `microverse: accept metric improvement to ${metricResult.state.latest.score}`,
          );
          persistMicroversePromotion(sessionDir, 'promotion_pending', candidate, metricResult, experimentArtifact);
          try {
            promoteMicroverseCandidate(sessionDir, candidate, experiment.id, normalizedCandidateHead);
            persistMicroversePromotion(sessionDir, 'promoted', candidate, metricResult, experimentArtifact);
            if (process.env.PICKLE_TEST_MODE === '1'
                && process.env.PICKLE_TEST_MICROVERSE_THROW_AFTER_PROMOTION === '1') {
              throw new Error('Injected post-promotion Microverse failure.');
            }
          } catch (error) {
            if (!(error instanceof MicroversePromotionDeferredError)) throw error;
            writeMetricConvergenceState(sessionDir, currentMetricState!);
            writeMetricSummary(sessionDir, currentMetricState!);
            manager.update(statePath, (current) => {
              current.last_loop_message = error.message;
              return current;
            });
            appendRunnerLog(sessionDir, error.message);
            promotionDeferred = true;
            exitReason = 'workspace_changed';
            break;
          }
        }
        completeExperiment(sessionDir, experiment.id, {
          status: metricResult.classification === 'improved' ? 'accepted' : 'rejected',
          classification: metricResult.classification,
          resultScore: metricResult.state.latest.score,
          changedPaths: metricResult.changedPaths,
          diffArtifact: metricResult.diffArtifact,
          insight: experimentArtifact?.insight || null,
          verification: experimentArtifact?.verification || [],
        });
        if (process.env.PICKLE_TEST_MODE === '1' && process.env.PICKLE_TEST_MICROVERSE_THROW_AFTER_COMPLETION === '1') {
          throw new Error('Injected post-completion Microverse failure.');
        }
        discardMicroverseCandidate(candidate);
        pendingMetricIteration = null;
        writeMetricSummary(sessionDir, metricResult.state);
      }
      if (!metricResult) pendingMetricIteration = null;

      const afterSnapshot = captureProgressSnapshot({
        sessionDir,
          workingDir: candidate ? candidate.liveWorkingDir : iterationWorkingDir,
        mode: loopConfig.mode,
        step: loopConfig.mode,
        currentTicket: manager.read(statePath).current_ticket as string | null,
      });
      const progressReasons = anatomyParkProgressReasons(
        state.working_dir as string,
        diffProgressSnapshot(beforeSnapshot, afterSnapshot).filter((reason) => reason !== 'initial_snapshot'),
      );
      const latest = manager.update(statePath, (current) => {
        const ledger = metricResult ? readExperimentLedger(sessionDir) : null;
        if (metricResult) current.iteration = (current.iteration as number) + 1;
        current.loop_stall_count = ledger
          ? ledger.experiment_stall_count
          : progressReasons.length ? 0 : Number(current.loop_stall_count || 0) + 1;
        current.worker_failure_count = ledger?.worker_failure_count || 0;
        current.last_loop_message = lastMessage.trim();
        return current;
      });
      if (metricResult) clearMicroverseAttemptTransaction(sessionDir);
      if (progressReasons.length) {
        appendRunnerLog(sessionDir, `iteration ${iteration} progress: ${progressReasons.join(',')}`);
      }

      if (config.defaults.circuit_breaker.enabled) {
        const circuitState = recordIteration(sessionDir, {
          working_dir: latest.working_dir as string,
          step: latest.step as string,
          current_ticket: latest.current_ticket as string | null,
          loop_mode: loopConfig.mode,
        });
        if (!canExecute(circuitState)) {
          if (metricResult) {
            resetCircuitBreaker(sessionDir, 'microverse recovery continues below target');
            appendRunnerLog(
              sessionDir,
              `microverse reset no-progress circuit after iteration ${iteration} and continued below target`,
            );
          } else {
            exitReason = 'circuit_open';
            appendRunnerLog(sessionDir, `circuit breaker opened after iteration ${iteration}`);
            break;
          }
        }
      }

      if (metricResult && metricStateTargetSatisfied(metricResult.state)) {
        exitReason = 'success';
        appendRunnerLog(sessionDir, `microverse runtime target satisfied at ${metricResult.state.best.score}`);
        break;
      }
      if (completionToken === 'LOOP_COMPLETE' && (!metricResult
          || (metricResult.classification === 'improved' && metricResult.state.target === null))) {
        exitReason = 'success';
        break;
      }
      const convergence = metricResult ? readExperimentLedger(sessionDir) : null;
      const scientificallyStalled = convergence
        ? researchConvergenceState(convergence).level === 'stalled'
        : (latest.loop_stall_count as number) >= Number(loopConfig.stall_limit || 8);
      if (scientificallyStalled) {
        if (metricResult) {
          appendRunnerLog(
            sessionDir,
            `microverse research stall threshold reached after iteration ${iteration}; continuing with a mandatory paradigm shift`,
          );
        } else {
          exitReason = 'stalled';
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof MicroverseCandidateArchiveError) promotionDeferred = true;
    const interruptedTransaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
    if (interruptedTransaction?.schema_version === 2
        && (interruptedTransaction.phase === 'promotion_pending' || interruptedTransaction.phase === 'promoted')
        && !microverseAttemptHasTerminalOutcome(sessionDir)) {
      promotionDeferred = true;
    }
    exitReason = manager.read(statePath).active === false
      ? ((manager.read(statePath).last_exit_reason as string | null) || 'cancelled')
      : 'error';
    if (exitReason !== 'cancelled') {
      thrownError = error;
    }
  } finally {
    if (!promotionDeferred && pendingMetricIteration && !microverseAttemptHasTerminalOutcome(sessionDir)) {
      try {
        archiveMicroverseCandidate(sessionDir, pendingMetricIteration.candidate, pendingMetricIteration.experimentId);
        revertMetricIterationSafely(sessionDir, pendingMetricIteration.cwd, pendingMetricIteration.checkpoint);
        appendRunnerLog(sessionDir, `microverse iteration rolled back after ${exitReason}`);
      } catch (rollbackError) {
        if (pendingMetricIteration?.candidate) {
          promotionDeferred = true;
          const transaction = readJsonFile<MicroverseAttemptTransaction>(microverseAttemptPath(sessionDir), null);
          if (transaction?.schema_version === 2) {
            atomicWriteJson(microverseAttemptPath(sessionDir), {
              ...transaction,
              phase: 'quarantined',
              quarantine_reason: safeErrorMessage(rollbackError),
            } satisfies MicroverseAttemptTransaction);
          }
        } else if (rollbackError instanceof MicroverseCandidateArchiveError) {
          promotionDeferred = true;
        }
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
    if (isMeasuredMicroverse(loopConfig) && !promotionDeferred) {
      try {
        const reconciledIds = finalizeMicroverseAttemptOnExit(sessionDir, exitReason);
        if (reconciledIds.length > 0) {
          appendRunnerLog(sessionDir, `microverse abandoned interrupted experiments: ${reconciledIds.join(', ')}`);
        }
      } catch (reconcileError) {
        thrownError = thrownError
          ? new AggregateError([thrownError, reconcileError], 'Microverse failed while reconciling interrupted experiments.')
          : reconcileError;
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

export async function runLoop(sessionDir: string, options: RunLoopOptions = {}): Promise<void> {
  const configuredStart = Number(options.runStartedAtMs);
  const runStartedAtMs = Number.isFinite(configuredStart) && configuredStart > 0
    ? configuredStart
    : Date.now();
  const launchOwnerPid = Number(options.launchOwnerPid);
  const releaseOperation = options.operationLeaseHeld
    ? null
    : acquireSessionOperation(
      sessionDir,
      undefined,
      Number.isInteger(launchOwnerPid) && launchOwnerPid > 0 ? launchOwnerPid : null,
    );
  try {
    await runLoopWithLease(sessionDir, runStartedAtMs);
  } finally {
    releaseOperation?.();
  }
}

function parseRunnerNumber(argv: string[], name: string): number | null {
  const value = Number(argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function main(argv: string[]): Promise<void> {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/loop-runner.js <session-dir>');
  }
  try {
    await runLoop(sessionDir, {
      launchOwnerPid: parseRunnerNumber(argv, '--launch-owner'),
      runStartedAtMs: parseRunnerNumber(argv, '--run-started-at') || undefined,
    });
  } catch (error) {
    const statePath = path.join(sessionDir, 'state.json');
    try {
      const manager = new StateManager();
      const state = manager.read(statePath);
      if (
        Number(state.tmux_runner_pid) === process.pid
        && (state.active !== false || state.runner_starting === true)
      ) {
        const finalReason = exitLoopRunnerPhase(manager, statePath, 'error');
        appendRunnerLog(sessionDir, `loop-runner emergency finalization: ${finalReason}: ${safeErrorMessage(error)}`);
      }
    } catch (finalizeError) {
      console.error(`Loop runner emergency finalization failed: ${safeErrorMessage(finalizeError)}`);
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
