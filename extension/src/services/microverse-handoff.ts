import path from 'node:path';
import {
  isMicroverseExperimentPlanFrozen,
  readExperimentLedger,
  researchConvergenceState,
  type MicroverseExperimentRecord,
} from './experiment-ledger.js';
import { atomicWriteJson } from './pickle-utils.js';
import type { MetricConvergenceState } from './metric-convergence.js';

export const MICROVERSE_RECENT_HANDOFF_LIMIT = 5;
export const MICROVERSE_WORKER_HANDOFF_MAX_CHARS = 24_576;
export const MICROVERSE_FROZEN_PLAN_FIELDS = [
  'hypothesis',
  'hypothesis_family',
  'differentiator',
  'rationale',
  'target_paths',
] as const;

interface MicroverseHandoffLoopConfig {
  task?: unknown;
  metric?: unknown;
  goal?: unknown;
  direction?: unknown;
  tolerance?: unknown;
  target?: unknown;
  target_relation?: unknown;
  stall_limit?: unknown;
  protected_paths?: unknown;
}

export interface WriteMicroverseWorkerHandoffInput {
  sessionDir: string;
  workerArtifactDir: string;
  workingDir: string;
  iteration: number;
  loopConfig: MicroverseHandoffLoopConfig;
  metricState: MetricConvergenceState;
  experiment: MicroverseExperimentRecord;
  experimentArtifactPath: string;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…[${normalized.length - maxChars} chars omitted; read durable reference]`;
}

function boundedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .slice(0, 4)
    .map((entry) => boundedText(entry, 192) as string);
}

function recentExperiment(record: MicroverseExperimentRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    classification: record.classification,
    result_score: record.result_score,
    hypothesis: boundedText(record.hypothesis, 384),
    hypothesis_family: boundedText(record.hypothesis_family, 128),
    differentiator: boundedText(record.differentiator, 256),
    target_paths: boundedPaths(record.target_paths),
    insight: boundedText(record.insight, 384),
  };
}

/**
 * Persist the variable Microverse context outside the Codex input. Workers get
 * a small current handoff and can query the authoritative session files only
 * when older evidence is relevant to the next hypothesis.
 */
export function writeMicroverseWorkerHandoff(input: WriteMicroverseWorkerHandoffInput): string {
  const {
    sessionDir,
    workerArtifactDir,
    workingDir,
    iteration,
    loopConfig,
    metricState,
    experiment,
    experimentArtifactPath,
  } = input;
  const ledger = readExperimentLedger(sessionDir);
  if (!ledger) throw new Error('Cannot build Microverse worker handoff without an experiment ledger.');
  const terminal = ledger.experiments.filter((record) => ['accepted', 'rejected', 'invalid'].includes(record.status));
  const convergence = researchConvergenceState(ledger);
  const handoffPath = path.join(workerArtifactDir, 'microverse-handoff.json');
  const frozenPlan = isMicroverseExperimentPlanFrozen(experiment);
  if (frozenPlan) {
    atomicWriteJson(experimentArtifactPath, {
      experiment_id: experiment.id,
      hypothesis: experiment.hypothesis,
      hypothesis_family: experiment.hypothesis_family,
      differentiator: experiment.differentiator,
      rationale: experiment.rationale,
      target_paths: [...experiment.target_paths],
    });
  }
  const handoff = {
    schema_version: 1,
    mode: 'microverse',
    iteration,
    working_directory: workingDir,
    objective: {
      task_preview: boundedText(loopConfig.task, 2_048),
      goal_preview: boundedText(loopConfig.goal, 2_048),
      metric_command_preview: boundedText(loopConfig.metric, 2_048),
      direction: loopConfig.direction ?? metricState.direction,
      tolerance: loopConfig.tolerance ?? metricState.tolerance,
      target: metricState.target,
      target_relation: metricState.target_relation,
    },
    metric: {
      baseline: metricState.baseline.score,
      best: metricState.best.score,
      latest: metricState.latest.score,
      metric_stall_count: metricState.stall_count,
      experiment_stall_count: ledger.experiment_stall_count,
      worker_failure_count: ledger.worker_failure_count,
    },
    current_experiment: {
      id: experiment.id,
      attempt: experiment.attempt,
      baseline_score: experiment.baseline_score,
      artifact_path: experimentArtifactPath,
      plan_contract: frozenPlan
        ? {
          state: 'frozen',
          artifact_preseeded: true,
          immutable_fields: MICROVERSE_FROZEN_PLAN_FIELDS,
          worker_action: 'Preserve the preseeded plan fields exactly; add only insight and verification evidence.',
        }
        : {
          state: 'worker_defined',
          artifact_preseeded: false,
          immutable_fields: [],
          worker_action: 'Define one bounded plan in the experiment artifact before modifying the repository.',
        },
    },
    recent_experiments: terminal.slice(-MICROVERSE_RECENT_HANDOFF_LIMIT).map(recentExperiment),
    history_counts: {
      total: ledger.experiments.length,
      accepted: terminal.filter((record) => record.status === 'accepted').length,
      rejected: terminal.filter((record) => record.status === 'rejected').length,
      invalid: terminal.filter((record) => record.status === 'invalid').length,
    },
    convergence,
    durable_references: {
      loop_config: path.join(sessionDir, 'loop_config.json'),
      metric_state: path.join(sessionDir, 'microverse-metrics.json'),
      experiment_ledger: path.join(sessionDir, 'microverse-experiments.json'),
      metric_summary: path.join(sessionDir, 'microverse-summary.json'),
    },
    read_strategy: 'Use this handoff first. Query durable references narrowly by experiment id, family, or target path only when older evidence is needed; never load the full ledger into context.',
  };
  const serialized = JSON.stringify(handoff);
  if (serialized.length > MICROVERSE_WORKER_HANDOFF_MAX_CHARS) {
    throw new Error(`Microverse worker handoff exceeded ${MICROVERSE_WORKER_HANDOFF_MAX_CHARS} characters.`);
  }
  atomicWriteJson(handoffPath, handoff);
  return handoffPath;
}
