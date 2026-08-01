import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, readJsonFile } from './pickle-utils.js';

export const MICROVERSE_EXPERIMENT_LEDGER_SCHEMA_VERSION = 1;
export const MICROVERSE_WARN_STALL_COUNT = 3;
export const MICROVERSE_PARADIGM_SHIFT_STALL_COUNT = 5;
export const MICROVERSE_STALLED_COUNT = 8;
export const MICROVERSE_PROMPT_MEMORY_MAX_CHARS = 131_072;

export type ExperimentStatus = 'planned' | 'running' | 'accepted' | 'rejected' | 'invalid';
export type ExperimentClassification =
  | 'improved'
  | 'held'
  | 'regressed'
  | 'worker_incomplete'
  | 'worker_error'
  | 'worker_timeout'
  | 'protected_path_tamper';
export type ResearchConvergenceLevel = 'none' | 'warn' | 'paradigm_shift' | 'stalled';
export type WorkerFailureClassification = Extract<
  ExperimentClassification,
  'worker_incomplete' | 'worker_error' | 'worker_timeout' | 'protected_path_tamper'
>;

export interface ExperimentWorkerAttempt {
  attempt: number;
  status: 'running' | 'completed' | 'invalid';
  classification: ExperimentClassification | null;
  started_at: string;
  completed_at: string | null;
  insight: string | null;
}

export interface MicroverseExperimentRecord {
  id: string;
  parent_id: string | null;
  hypothesis: string;
  hypothesis_key: string;
  hypothesis_family: string | null;
  differentiator: string | null;
  rationale: string;
  target_paths: string[];
  status: ExperimentStatus;
  baseline_score: number;
  result_score: number | null;
  classification: ExperimentClassification | null;
  changed_paths: string[];
  diff_artifact: string | null;
  insight: string | null;
  verification: string[];
  attempt: number;
  retry_count: number;
  worker_attempts: ExperimentWorkerAttempt[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface MicroverseExperimentLedger {
  schema_version: 1;
  next_sequence: number;
  worker_failure_count: number;
  experiment_stall_count: number;
  experiments: MicroverseExperimentRecord[];
  created_at: string;
  updated_at: string;
}

export interface PlanExperimentInput {
  parentId?: string | null;
  hypothesis: string;
  hypothesisFamily?: string | null;
  differentiator?: string | null;
  rationale: string;
  targetPaths?: string[];
  baselineScore: number;
  /** @deprecated New scientific experiments always begin at worker attempt 1. */
  attempt?: number;
}

export interface CompleteExperimentInput {
  status: 'accepted' | 'rejected' | 'invalid';
  classification: ExperimentClassification;
  resultScore?: number | null;
  changedPaths?: string[];
  diffArtifact?: string | null;
  insight?: string | null;
  verification?: string[];
}

export interface UpdateExperimentPlanInput {
  hypothesis: string;
  hypothesisFamily?: string | null;
  differentiator?: string | null;
  rationale: string;
  targetPaths?: string[];
}

export interface ResearchConvergenceState {
  level: ResearchConvergenceLevel;
  experiment_stall_count: number;
  unresolved_planned_count: number;
  family_shift_required: boolean;
  exhausted_hypothesis_families: string[];
}

export interface WorkerAttemptFailureInput {
  classification: WorkerFailureClassification;
  insight?: string | null;
}

export interface ReconcileRunningExperimentsOptions extends MutationOptions {
  mode: 'resume' | 'cancel';
  classification?: WorkerFailureClassification;
  insight?: string;
}

export interface FamilyShiftValidation {
  valid: boolean;
  required: boolean;
  proposed_family: string | null;
  exhausted_families: string[];
  reason: string | null;
}

export interface ExperimentStrategyCandidate {
  hypothesisFamily?: string | null;
  targetPaths?: string[];
}

export interface ExperimentStrategyValidation extends FamilyShiftValidation {
  proposed_target_paths: string[];
  prior_target_paths: string[];
}

interface MutationOptions {
  now?: string;
}

function ledgerPath(sessionDir: string): string {
  return path.join(sessionDir, 'microverse-experiments.json');
}

function nowIso(value?: string): string {
  const result = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid experiment timestamp: ${JSON.stringify(result)}.`);
  return result;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requiredText(value, field);
}

function finiteScore(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function normalizedPaths(values: unknown, field: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return [...new Set(values.map((value) => value.trim()))].sort();
}

/** Stable enough for duplicate detection while retaining the original hypothesis as evidence. */
export function normalizeExperimentHypothesis(value: string): string {
  return requiredText(value, 'hypothesis')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hypothesisKey(hypothesis: string, differentiator: string | null): string {
  const normalized = normalizeExperimentHypothesis(hypothesis);
  return differentiator ? `${normalized}::${normalizeExperimentHypothesis(differentiator)}` : normalized;
}

function normalizedFamily(value: string): string {
  return normalizeExperimentHypothesis(value);
}

export function createExperimentLedger(createdAt?: string): MicroverseExperimentLedger {
  const timestamp = nowIso(createdAt);
  return {
    schema_version: MICROVERSE_EXPERIMENT_LEDGER_SCHEMA_VERSION,
    next_sequence: 1,
    worker_failure_count: 0,
    experiment_stall_count: 0,
    experiments: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function assertRecord(value: unknown): MicroverseExperimentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid experiment ledger record.');
  const record = value as MicroverseExperimentRecord;
  if (!/^exp-\d{4,}$/.test(record.id)) throw new Error(`Invalid experiment id: ${JSON.stringify(record.id)}.`);
  if (!['planned', 'running', 'accepted', 'rejected', 'invalid'].includes(record.status)) {
    throw new Error(`Invalid experiment status for ${record.id}.`);
  }
  requiredText(record.hypothesis, `${record.id}.hypothesis`);
  requiredText(record.hypothesis_key, `${record.id}.hypothesis_key`);
  requiredText(record.rationale, `${record.id}.rationale`);
  finiteScore(record.baseline_score, `${record.id}.baseline_score`);
  nonNegativeInteger(record.attempt, `${record.id}.attempt`, 1);
  nonNegativeInteger(record.retry_count, `${record.id}.retry_count`);
  if (record.retry_count !== record.attempt - 1) throw new Error(`${record.id} has inconsistent retry_count.`);
  if (!Array.isArray(record.worker_attempts)) throw new Error(`${record.id}.worker_attempts must be an array.`);
  for (const workerAttempt of record.worker_attempts) {
    if (!workerAttempt || typeof workerAttempt !== 'object') throw new Error(`${record.id} has an invalid worker attempt.`);
    nonNegativeInteger(workerAttempt.attempt, `${record.id}.worker_attempt.attempt`, 1);
    if (!['running', 'completed', 'invalid'].includes(workerAttempt.status)) {
      throw new Error(`${record.id} has an invalid worker attempt status.`);
    }
    nowIso(workerAttempt.started_at);
    if (workerAttempt.completed_at !== null) nowIso(workerAttempt.completed_at);
    if ((workerAttempt.status === 'running') !== (workerAttempt.completed_at === null)) {
      throw new Error(`${record.id} has inconsistent worker attempt timestamps.`);
    }
  }
  const activeAttempts = record.worker_attempts.filter((workerAttempt) => workerAttempt.status === 'running');
  if (activeAttempts.length > 1) throw new Error(`${record.id} has multiple running worker attempts.`);
  normalizedPaths(record.target_paths, `${record.id}.target_paths`);
  normalizedPaths(record.changed_paths, `${record.id}.changed_paths`);
  if (!Array.isArray(record.verification) || record.verification.some((item) => typeof item !== 'string')) {
    throw new Error(`${record.id}.verification must be a string array.`);
  }
  if (record.result_score !== null) finiteScore(record.result_score, `${record.id}.result_score`);
  if (record.parent_id !== null && typeof record.parent_id !== 'string') throw new Error(`${record.id}.parent_id is invalid.`);
  const terminal = record.status === 'accepted' || record.status === 'rejected' || record.status === 'invalid';
  if (terminal !== (record.completed_at !== null)) throw new Error(`${record.id} has inconsistent terminal timestamps.`);
  if (record.status === 'running' && record.started_at === null) throw new Error(`${record.id} is running without started_at.`);
  if ((record.status === 'running') !== (activeAttempts.length === 1)) {
    throw new Error(`${record.id} has inconsistent experiment and worker attempt status.`);
  }
  if (terminal && record.classification === null) throw new Error(`${record.id} is terminal without a classification.`);
  return record;
}

export function assertExperimentLedger(value: unknown): MicroverseExperimentLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid microverse experiment ledger.');
  const ledger = value as MicroverseExperimentLedger;
  if (ledger.schema_version !== MICROVERSE_EXPERIMENT_LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported microverse experiment ledger schema: ${String(ledger.schema_version)}.`);
  }
  nonNegativeInteger(ledger.next_sequence, 'next_sequence', 1);
  nonNegativeInteger(ledger.worker_failure_count, 'worker_failure_count');
  nonNegativeInteger(ledger.experiment_stall_count, 'experiment_stall_count');
  if (!Array.isArray(ledger.experiments)) throw new Error('experiments must be an array.');
  const records = ledger.experiments.map(assertRecord);
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) throw new Error('Experiment ledger contains duplicate ids.');
  for (const record of records) {
    if (record.parent_id !== null && !ids.has(record.parent_id)) {
      throw new Error(`${record.id} references missing parent ${record.parent_id}.`);
    }
  }
  nowIso(ledger.created_at);
  nowIso(ledger.updated_at);
  return ledger;
}

export function readExperimentLedger(sessionDir: string): MicroverseExperimentLedger | null {
  const filePath = ledgerPath(sessionDir);
  if (!fs.existsSync(filePath)) return null;
  return assertExperimentLedger(readJsonFile(filePath, null));
}

export function writeExperimentLedger(sessionDir: string, ledger: MicroverseExperimentLedger): void {
  atomicWriteJson(ledgerPath(sessionDir), assertExperimentLedger(ledger));
}

function loadOrCreate(sessionDir: string, timestamp: string): MicroverseExperimentLedger {
  return readExperimentLedger(sessionDir) ?? createExperimentLedger(timestamp);
}

export function planExperiment(
  sessionDir: string,
  input: PlanExperimentInput,
  options: MutationOptions = {},
): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = loadOrCreate(sessionDir, timestamp);
  const hypothesis = requiredText(input.hypothesis, 'hypothesis');
  const differentiator = optionalText(input.differentiator, 'differentiator');
  const key = hypothesisKey(hypothesis, differentiator);
  if (ledger.experiments.some((record) => record.hypothesis_key === key)) {
    throw new Error(`Duplicate experiment hypothesis: ${JSON.stringify(hypothesis)}${differentiator ? ` with differentiator ${JSON.stringify(differentiator)}` : ''}.`);
  }
  if (!differentiator) {
    const normalized = normalizeExperimentHypothesis(hypothesis);
    if (ledger.experiments.some((record) => normalizeExperimentHypothesis(record.hypothesis) === normalized)) {
      throw new Error(`Duplicate experiment hypothesis requires an explicit differentiator: ${JSON.stringify(hypothesis)}.`);
    }
  }
  const parentId = input.parentId ?? null;
  if (parentId !== null && !ledger.experiments.some((record) => record.id === parentId)) {
    throw new Error(`Experiment parent does not exist: ${parentId}.`);
  }
  const id = `exp-${String(ledger.next_sequence).padStart(4, '0')}`;
  const record: MicroverseExperimentRecord = {
    id,
    parent_id: parentId,
    hypothesis,
    hypothesis_key: key,
    hypothesis_family: optionalText(input.hypothesisFamily, 'hypothesisFamily'),
    differentiator,
    rationale: requiredText(input.rationale, 'rationale'),
    target_paths: normalizedPaths(input.targetPaths ?? [], 'targetPaths'),
    status: 'planned',
    baseline_score: finiteScore(input.baselineScore, 'baselineScore'),
    result_score: null,
    classification: null,
    changed_paths: [],
    diff_artifact: null,
    insight: null,
    verification: [],
    attempt: 1,
    retry_count: 0,
    worker_attempts: [],
    created_at: timestamp,
    started_at: null,
    completed_at: null,
  };
  ledger.next_sequence += 1;
  ledger.experiments.push(record);
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

export function startExperiment(sessionDir: string, id: string, options: MutationOptions = {}): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot start experiment: ledger does not exist.');
  const record = ledger.experiments.find((entry) => entry.id === id);
  if (!record) throw new Error(`Experiment does not exist: ${id}.`);
  if (record.status !== 'planned') throw new Error(`Experiment ${id} cannot start from status ${record.status}.`);
  record.status = 'running';
  record.started_at = timestamp;
  record.worker_attempts.push({
    attempt: record.attempt,
    status: 'running',
    classification: null,
    started_at: timestamp,
    completed_at: null,
    insight: null,
  });
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

export function updateExperimentPlan(
  sessionDir: string,
  id: string,
  input: UpdateExperimentPlanInput,
  options: MutationOptions = {},
): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot update experiment: ledger does not exist.');
  const record = ledger.experiments.find((entry) => entry.id === id);
  if (!record) throw new Error(`Experiment does not exist: ${id}.`);
  if (record.status !== 'planned' && record.status !== 'running') {
    throw new Error(`Experiment ${id} cannot update its plan from status ${record.status}.`);
  }
  const hypothesis = requiredText(input.hypothesis, 'hypothesis');
  const differentiator = optionalText(input.differentiator, 'differentiator');
  const key = hypothesisKey(hypothesis, differentiator);
  const others = ledger.experiments.filter((entry) => entry.id !== id);
  if (others.some((entry) => entry.hypothesis_key === key)) {
    throw new Error(`Duplicate experiment hypothesis: ${JSON.stringify(hypothesis)}${differentiator ? ` with differentiator ${JSON.stringify(differentiator)}` : ''}.`);
  }
  if (!differentiator) {
    const normalized = normalizeExperimentHypothesis(hypothesis);
    if (others.some((entry) => normalizeExperimentHypothesis(entry.hypothesis) === normalized)) {
      throw new Error(`Duplicate experiment hypothesis requires an explicit differentiator: ${JSON.stringify(hypothesis)}.`);
    }
  }
  record.hypothesis = hypothesis;
  record.hypothesis_key = key;
  record.hypothesis_family = optionalText(input.hypothesisFamily, 'hypothesisFamily');
  record.differentiator = differentiator;
  record.rationale = requiredText(input.rationale, 'rationale');
  record.target_paths = normalizedPaths(input.targetPaths ?? [], 'targetPaths');
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

function classificationMatchesStatus(status: CompleteExperimentInput['status'], classification: ExperimentClassification): boolean {
  if (status === 'accepted') return classification === 'improved';
  if (status === 'rejected') return classification === 'held' || classification === 'regressed';
  return classification === 'worker_incomplete' || classification === 'worker_error'
    || classification === 'worker_timeout' || classification === 'protected_path_tamper';
}

function runningWorkerAttempt(record: MicroverseExperimentRecord): ExperimentWorkerAttempt {
  const attempt = record.worker_attempts.find((entry) => entry.status === 'running');
  if (!attempt) throw new Error(`Experiment ${record.id} has no running worker attempt.`);
  return attempt;
}

export function completeExperiment(
  sessionDir: string,
  id: string,
  input: CompleteExperimentInput,
  options: MutationOptions = {},
): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot complete experiment: ledger does not exist.');
  const record = ledger.experiments.find((entry) => entry.id === id);
  if (!record) throw new Error(`Experiment does not exist: ${id}.`);
  if (record.status !== 'running') throw new Error(`Experiment ${id} cannot complete from status ${record.status}.`);
  if (!classificationMatchesStatus(input.status, input.classification)) {
    throw new Error(`Experiment status ${input.status} is incompatible with classification ${input.classification}.`);
  }
  if (input.status !== 'invalid' && input.resultScore == null) {
    throw new Error(`Experiment ${id} requires a result score.`);
  }
  record.status = input.status;
  record.result_score = input.resultScore == null ? null : finiteScore(input.resultScore, 'resultScore');
  record.classification = input.classification;
  record.changed_paths = normalizedPaths(input.changedPaths ?? [], 'changedPaths');
  record.diff_artifact = optionalText(input.diffArtifact, 'diffArtifact');
  record.insight = optionalText(input.insight, 'insight');
  record.verification = [...new Set((input.verification ?? []).map((item) => requiredText(item, 'verification')))].sort();
  record.completed_at = timestamp;
  const workerAttempt = runningWorkerAttempt(record);
  workerAttempt.status = input.status === 'invalid' ? 'invalid' : 'completed';
  workerAttempt.classification = input.classification;
  workerAttempt.completed_at = timestamp;
  workerAttempt.insight = record.insight;
  if (input.status === 'invalid') {
    ledger.worker_failure_count += 1;
  } else {
    ledger.worker_failure_count = 0;
    ledger.experiment_stall_count = input.status === 'accepted' ? 0 : ledger.experiment_stall_count + 1;
  }
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

/**
 * Records a failed worker transport/contract attempt without terminating or
 * duplicating its scientific experiment. The same experiment id becomes
 * planned again with an incremented attempt number.
 */
export function recordWorkerAttemptFailure(
  sessionDir: string,
  id: string,
  input: WorkerAttemptFailureInput,
  options: MutationOptions = {},
): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot record worker failure: ledger does not exist.');
  const record = ledger.experiments.find((entry) => entry.id === id);
  if (!record) throw new Error(`Experiment does not exist: ${id}.`);
  if (record.status !== 'running') throw new Error(`Experiment ${id} cannot retry from status ${record.status}.`);
  const attempt = runningWorkerAttempt(record);
  attempt.status = 'invalid';
  attempt.classification = input.classification;
  attempt.completed_at = timestamp;
  attempt.insight = optionalText(input.insight, 'insight');
  record.status = 'planned';
  record.started_at = null;
  record.attempt += 1;
  record.retry_count += 1;
  ledger.worker_failure_count += 1;
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

/**
 * A relaunched runner starts a new transport-recovery window. Preserve every
 * recorded attempt, but do not let the previous runner's consecutive failure
 * streak consume the resumed runner's retry budget.
 */
export function resetWorkerFailureCount(sessionDir: string): number {
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger || ledger.worker_failure_count === 0) return 0;
  const previous = ledger.worker_failure_count;
  ledger.worker_failure_count = 0;
  ledger.updated_at = nowIso();
  writeExperimentLedger(sessionDir, ledger);
  return previous;
}

/** Marks a retry-exhausted planned experiment terminal without inventing another worker attempt. */
export function abandonPlannedExperiment(
  sessionDir: string,
  id: string,
  input: WorkerAttemptFailureInput,
  options: MutationOptions = {},
): MicroverseExperimentRecord {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot abandon experiment: ledger does not exist.');
  const record = ledger.experiments.find((entry) => entry.id === id);
  if (!record) throw new Error(`Experiment does not exist: ${id}.`);
  if (record.status !== 'planned') throw new Error(`Experiment ${id} cannot be abandoned from status ${record.status}.`);
  record.status = 'invalid';
  record.classification = input.classification;
  record.insight = optionalText(input.insight, 'insight');
  record.completed_at = timestamp;
  ledger.updated_at = timestamp;
  writeExperimentLedger(sessionDir, ledger);
  return record;
}

/** Resolves interrupted running records deterministically before a resumed or cancelled loop proceeds. */
export function reconcileRunningExperiments(
  sessionDir: string,
  options: ReconcileRunningExperimentsOptions,
): { reconciled_ids: string[]; ledger: MicroverseExperimentLedger } {
  const timestamp = nowIso(options.now);
  const ledger = readExperimentLedger(sessionDir) ?? createExperimentLedger(timestamp);
  const classification = options.classification ?? 'worker_incomplete';
  const insight = optionalText(
    options.insight ?? `Worker attempt reconciled during ${options.mode}.`,
    'insight',
  );
  const reconciled: string[] = [];
  for (const record of ledger.experiments) {
    if (record.status !== 'running') continue;
    const attempt = runningWorkerAttempt(record);
    attempt.status = 'invalid';
    attempt.classification = classification;
    attempt.completed_at = timestamp;
    attempt.insight = insight;
    if (options.mode === 'resume') {
      record.status = 'planned';
      record.started_at = null;
      record.attempt += 1;
      record.retry_count += 1;
    } else {
      record.status = 'invalid';
      record.classification = classification;
      record.insight = insight;
      record.completed_at = timestamp;
    }
    ledger.worker_failure_count += 1;
    reconciled.push(record.id);
  }
  if (reconciled.length > 0 || !fs.existsSync(ledgerPath(sessionDir))) {
    ledger.updated_at = timestamp;
    writeExperimentLedger(sessionDir, ledger);
  }
  return { reconciled_ids: reconciled, ledger };
}

export function archiveExperimentDiff(sessionDir: string, id: string, patch: string): string {
  if (!/^exp-\d{4,}$/.test(id)) throw new Error(`Invalid experiment id: ${JSON.stringify(id)}.`);
  if (typeof patch !== 'string') throw new Error('Experiment diff must be a string.');
  const relative = path.posix.join('experiments', `${id}.patch`);
  atomicWriteFile(path.join(sessionDir, ...relative.split('/')), patch, { mode: 0o600 });
  return relative;
}

export function researchConvergenceState(ledger: MicroverseExperimentLedger): ResearchConvergenceState {
  assertExperimentLedger(ledger);
  const unresolved = ledger.experiments.filter((record) => record.status === 'planned' || record.status === 'running').length;
  const stalls = ledger.experiment_stall_count;
  const rejectedTail = [...ledger.experiments].reverse()
    .filter((record) => record.status === 'rejected')
    .slice(0, stalls);
  const exhaustedFamilies = [...new Set(rejectedTail
    .map((record) => record.hypothesis_family)
    .filter((family): family is string => family !== null)
    .map(normalizedFamily))].sort();
  let level: ResearchConvergenceLevel = 'none';
  if (stalls >= MICROVERSE_STALLED_COUNT && unresolved === 0) level = 'stalled';
  else if (stalls >= MICROVERSE_PARADIGM_SHIFT_STALL_COUNT) level = 'paradigm_shift';
  else if (stalls >= MICROVERSE_WARN_STALL_COUNT) level = 'warn';
  return {
    level,
    experiment_stall_count: stalls,
    unresolved_planned_count: unresolved,
    family_shift_required: level === 'paradigm_shift' || level === 'stalled',
    exhausted_hypothesis_families: exhaustedFamilies,
  };
}

export function validateExperimentFamilyShift(
  ledger: MicroverseExperimentLedger,
  proposedFamily: string | null | undefined,
): FamilyShiftValidation {
  const prior = [...ledger.experiments].reverse().find((record) => record.status === 'rejected') ?? null;
  const strategy = validateExperimentStrategy(ledger, {
    hypothesisFamily: proposedFamily,
    targetPaths: prior?.target_paths ?? [],
  });
  return {
    valid: strategy.valid,
    required: strategy.required,
    proposed_family: strategy.proposed_family,
    exhausted_families: strategy.exhausted_families,
    reason: strategy.reason,
  };
}

/**
 * Enforces the deterministic intervention ladder. At warn, either the target
 * path set or hypothesis family must differ from the latest rejected valid
 * experiment. At paradigm_shift/stalled, a new non-exhausted family is
 * mandatory regardless of target paths.
 */
export function validateExperimentStrategy(
  ledger: MicroverseExperimentLedger,
  candidate: ExperimentStrategyCandidate,
): ExperimentStrategyValidation {
  const convergence = researchConvergenceState(ledger);
  const proposedFamily = candidate.hypothesisFamily;
  const proposed = proposedFamily == null ? null : normalizedFamily(proposedFamily);
  const proposedPaths = normalizedPaths(candidate.targetPaths ?? [], 'targetPaths');
  const prior = [...ledger.experiments].reverse().find((record) => record.status === 'rejected') ?? null;
  const priorPaths = prior?.target_paths ?? [];
  const common = {
    proposed_family: proposed,
    proposed_target_paths: proposedPaths,
    prior_target_paths: priorPaths,
    exhausted_families: convergence.exhausted_hypothesis_families,
  };
  if (convergence.level === 'none') {
    return { ...common, valid: true, required: false, exhausted_families: [], reason: null };
  }
  if (convergence.level === 'warn') {
    const priorFamily = prior?.hypothesis_family == null ? null : normalizedFamily(prior.hypothesis_family);
    const sameFamily = proposed === priorFamily;
    const sameTargets = JSON.stringify(proposedPaths) === JSON.stringify(priorPaths);
    if (sameFamily && sameTargets) {
      return {
        ...common,
        valid: false,
        required: true,
        reason: 'Convergence warning requires a different target path set or hypothesis family.',
      };
    }
    return { ...common, valid: true, required: true, reason: null };
  }
  if (!proposed) {
    return {
      ...common,
      valid: false,
      required: true,
      reason: 'Paradigm shift requires a non-empty hypothesis family.',
    };
  }
  if (convergence.exhausted_hypothesis_families.includes(proposed)) {
    return {
      ...common,
      valid: false,
      required: true,
      reason: `Hypothesis family ${JSON.stringify(proposedFamily)} is exhausted; choose a materially different family.`,
    };
  }
  return {
    ...common,
    valid: true,
    required: true,
    reason: null,
  };
}

export function assertExperimentFamilyShift(
  ledger: MicroverseExperimentLedger,
  proposedFamily: string | null | undefined,
): void {
  const validation = validateExperimentFamilyShift(ledger, proposedFamily);
  if (!validation.valid) throw new Error(validation.reason ?? 'Invalid experiment family shift.');
}

export function assertExperimentStrategy(
  ledger: MicroverseExperimentLedger,
  candidate: ExperimentStrategyCandidate,
): void {
  const validation = validateExperimentStrategy(ledger, candidate);
  if (!validation.valid) throw new Error(validation.reason ?? 'Invalid experiment strategy.');
}

interface CompactExperimentRecord {
  id: string;
  hypothesis: string;
  hypothesis_key: string;
  hypothesis_family: string | null;
  differentiator: string | null;
  target_paths: string[];
  status: ExperimentStatus;
  classification: ExperimentClassification | null;
  result_score: number | null;
  changed_paths: string[];
  insight: string | null;
}

interface CompactInvalidAttempt {
  experiment_id: string;
  attempt: Pick<ExperimentWorkerAttempt, 'attempt' | 'classification' | 'insight'>;
}

export interface CompactExperimentMemory {
  schema_version: 1;
  ordering: 'oldest_to_newest';
  full_ledger_required_for_omitted_details: boolean;
  totals: {
    experiments: number;
    accepted_lineage: number;
    rejected: number;
    invalid: number;
    invalid_attempts: number;
  };
  omitted: {
    accepted_lineage: number;
    rejected: number;
    invalid: number;
    invalid_attempts: number;
  };
  accepted_lineage: CompactExperimentRecord[];
  rejected: CompactExperimentRecord[];
  invalid: CompactExperimentRecord[];
  invalid_attempts: CompactInvalidAttempt[];
  convergence: ResearchConvergenceState;
}

function boundedMemoryText(value: string | null, maxChars: number): string | null {
  if (value === null || value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}…[${omitted} chars omitted]`;
}

function boundedMemoryStrings(values: string[], maxItems = 12, maxChars = 384): string[] {
  const selected = values.slice(0, maxItems).map((value) => boundedMemoryText(value, maxChars) as string);
  if (values.length > maxItems) selected.push(`…[${values.length - maxItems} items omitted]`);
  return selected;
}

function compactExperimentRecord(record: MicroverseExperimentRecord): CompactExperimentRecord {
  return {
    id: record.id,
    hypothesis: boundedMemoryText(record.hypothesis, 2_048) as string,
    hypothesis_key: boundedMemoryText(record.hypothesis_key, 2_048) as string,
    hypothesis_family: boundedMemoryText(record.hypothesis_family, 384),
    differentiator: boundedMemoryText(record.differentiator, 768),
    target_paths: boundedMemoryStrings(record.target_paths),
    status: record.status,
    classification: record.classification,
    result_score: record.result_score,
    changed_paths: boundedMemoryStrings(record.changed_paths),
    insight: boundedMemoryText(record.insight, 2_048),
  };
}

function compactInvalidAttempt(experimentId: string, attempt: ExperimentWorkerAttempt): CompactInvalidAttempt {
  return {
    experiment_id: experimentId,
    attempt: {
      attempt: attempt.attempt,
      classification: attempt.classification,
      insight: boundedMemoryText(attempt.insight, 1_024),
    },
  };
}

function compactMemoryChars(memory: CompactExperimentMemory): number {
  return JSON.stringify(memory).length;
}

function experimentSequence(id: string): number {
  return Number(id.slice('exp-'.length));
}

/**
 * Build a bounded, recent-first prompt projection of the durable ledger. The
 * complete evidence remains in microverse-experiments.json; this projection is
 * only enough context to select the next experiment without growing Codex's
 * initial input on every iteration.
 */
export function compactExperimentMemory(ledger: MicroverseExperimentLedger): CompactExperimentMemory {
  assertExperimentLedger(ledger);
  const accepted = ledger.experiments.filter((record) => record.status === 'accepted');
  const rejected = ledger.experiments.filter((record) => record.status === 'rejected');
  const invalid = ledger.experiments.filter((record) => record.status === 'invalid');
  const invalidAttempts = ledger.experiments.flatMap((record) => record.worker_attempts
    .filter((attempt) => attempt.status === 'invalid')
    .map((attempt) => ({ experimentId: record.id, attempt })));
  const convergence = researchConvergenceState(ledger);
  convergence.exhausted_hypothesis_families = boundedMemoryStrings(
    convergence.exhausted_hypothesis_families,
    12,
    384,
  );
  const memory: CompactExperimentMemory = {
    schema_version: 1,
    ordering: 'oldest_to_newest',
    full_ledger_required_for_omitted_details: false,
    totals: {
      experiments: ledger.experiments.length,
      accepted_lineage: accepted.length,
      rejected: rejected.length,
      invalid: invalid.length,
      invalid_attempts: invalidAttempts.length,
    },
    omitted: {
      accepted_lineage: accepted.length,
      rejected: rejected.length,
      invalid: invalid.length,
      invalid_attempts: invalidAttempts.length,
    },
    accepted_lineage: [],
    rejected: [],
    invalid: [],
    invalid_attempts: [],
    convergence,
  };
  const included = new Set<string>();

  const tryRecord = (record: MicroverseExperimentRecord): boolean => {
    if (included.has(record.id)) return true;
    const key = record.status === 'accepted' ? 'accepted_lineage' : record.status;
    if (key !== 'accepted_lineage' && key !== 'rejected' && key !== 'invalid') return true;
    const target = memory[key];
    const compact = compactExperimentRecord(record);
    target.push(compact);
    memory.omitted[key] -= 1;
    if (compactMemoryChars(memory) > MICROVERSE_PROMPT_MEMORY_MAX_CHARS) {
      target.pop();
      memory.omitted[key] += 1;
      return false;
    }
    included.add(record.id);
    return true;
  };

  // Guarantee recent evidence from every terminal outcome family before using
  // the remaining budget for the newest overall scientific history.
  for (const records of [accepted, rejected, invalid]) {
    for (const record of records.slice(-8).reverse()) tryRecord(record);
  }
  for (const record of [...ledger.experiments].reverse()) {
    if (!tryRecord(record)) break;
  }

  for (const entry of invalidAttempts.slice(-12).reverse()) {
    const compact = compactInvalidAttempt(entry.experimentId, entry.attempt);
    memory.invalid_attempts.push(compact);
    memory.omitted.invalid_attempts -= 1;
    if (compactMemoryChars(memory) > MICROVERSE_PROMPT_MEMORY_MAX_CHARS) {
      memory.invalid_attempts.pop();
      memory.omitted.invalid_attempts += 1;
      break;
    }
  }

  for (const records of [memory.accepted_lineage, memory.rejected, memory.invalid]) {
    records.sort((left, right) => experimentSequence(left.id) - experimentSequence(right.id));
  }
  memory.invalid_attempts.sort((left, right) => {
    const experimentOrder = experimentSequence(left.experiment_id) - experimentSequence(right.experiment_id);
    return experimentOrder || left.attempt.attempt - right.attempt.attempt;
  });
  memory.full_ledger_required_for_omitted_details = Object.values(memory.omitted).some((count) => count > 0);
  if (compactMemoryChars(memory) > MICROVERSE_PROMPT_MEMORY_MAX_CHARS) {
    throw new Error('Internal Microverse prompt memory budget exceeded.');
  }
  return memory;
}
