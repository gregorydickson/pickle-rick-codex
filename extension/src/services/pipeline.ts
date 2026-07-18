import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION,
  atomicWriteJson,
  readJsonFile,
} from './pickle-utils.js';
import type {
  PipelineBootstrapSource,
  PipelineContract,
  PipelinePhase,
  PipelineSkipFlags,
} from '../types/index.js';

export { STATE_SCHEMA_VERSION } from '../types/index.js';

export const PIPELINE_SCHEMA_VERSION = STATE_SCHEMA_VERSION;
export const PIPELINE_PHASES: readonly PipelinePhase[] = Object.freeze(['pickle', 'anatomy-park', 'szechuan-sauce', 'citadel']);
export const PIPELINE_PHASE_ALIAS_MAP: Readonly<Record<string, PipelinePhase>> = Object.freeze({
  pickle: 'pickle',
  build: 'pickle',
  citadel: 'citadel',
  review: 'citadel',
  anatomy: 'anatomy-park',
  'anatomy-park': 'anatomy-park',
  szechuan: 'szechuan-sauce',
  'szechuan-sauce': 'szechuan-sauce',
});

const RESUME_IMMUTABLE_FIELDS: ReadonlyArray<readonly [keyof PipelineContract, string]> = Object.freeze([
  ['target', 'target'],
  ['scope', 'scope'],
  ['working_dir', 'working directory'],
  ['bootstrap_source', 'bootstrap source'],
  ['bootstrap_prd', 'bootstrap PRD path'],
  ['task', 'task bootstrap prompt'],
  ['phases', 'phase list'],
  ['skip_flags', 'skip flags'],
]);

/**
 * Input shape accepted by {@link createPipelineContract}. All fields are
 * optional/unknown because the contract is parsed from arbitrary JSON; the
 * normalizers validate and narrow each field.
 */
interface PipelineContractInput {
  working_dir?: unknown;
  target?: unknown;
  scope?: unknown;
  phases?: unknown;
  skip_flags?: unknown;
  bootstrap_source?: unknown;
  task?: unknown;
  bootstrap_prd?: unknown;
  schema_version?: unknown;
  pickle?: unknown;
  citadel?: unknown;
  anatomy?: unknown;
  szechuan?: unknown;
  [key: string]: unknown;
}

/**
 * Mirror of the immutable pipeline launch fields projected onto a
 * {@link SessionState}/pipeline-state artifact by {@link buildPipelineStateMirror}.
 */
export interface PipelineStateMirror {
  pipeline_working_dir: string;
  pipeline_target: string;
  pipeline_scope: string[];
  pipeline_bootstrap_source: PipelineBootstrapSource;
  pipeline_bootstrap_prd: string | null;
  pipeline_task: string | null;
  pipeline_phases: PipelinePhase[];
  pipeline_skip_flags: PipelineSkipFlags;
}

export class PipelineContractError extends Error {
  code: string;
  constructor(message: string, code: string = 'PIPELINE_CONTRACT_INVALID') {
    super(message);
    this.name = 'PipelineContractError';
    this.code = code;
  }
}

export function getPipelinePath(sessionDir: string): string {
  return path.join(sessionDir, 'pipeline.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value.trim());
}

function compareJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizePipelineScope(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new PipelineContractError('Pipeline scope must be an array of repository-relative paths.', 'PIPELINE_SCOPE_INVALID');
  }
  const normalized = new Set<string>();
  for (const entry of value) {
    const raw = String(entry ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!raw || raw === '.' || path.posix.isAbsolute(raw)) {
      throw new PipelineContractError(`Invalid pipeline scope path ${JSON.stringify(entry)}. Repository root and absolute paths are forbidden.`, 'PIPELINE_SCOPE_INVALID');
    }
    const clean = path.posix.normalize(raw);
    if (clean === '..' || clean.startsWith('../')) {
      throw new PipelineContractError(`Pipeline scope escapes the repository: ${JSON.stringify(entry)}.`, 'PIPELINE_SCOPE_INVALID');
    }
    normalized.add(clean);
  }
  return [...normalized].sort();
}

export function normalizePipelinePhase(value: unknown): PipelinePhase {
  const normalized = String(value ?? '').trim().toLowerCase();
  const phase = PIPELINE_PHASE_ALIAS_MAP[normalized];
  if (!phase) {
    throw new PipelineContractError(
      `Unsupported pipeline phase "${value}". Expected one of: ${PIPELINE_PHASES.join(', ')}`,
      'PIPELINE_PHASE_INVALID',
    );
  }
  return phase;
}

export function normalizePipelinePhases(values: unknown): PipelinePhase[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new PipelineContractError('Pipeline phases must be a non-empty array.', 'PIPELINE_PHASES_INVALID');
  }

  const phases: PipelinePhase[] = [];
  for (const value of values) {
    const phase = normalizePipelinePhase(value);
    if (phase === 'citadel') {
      continue;
    }
    if (phases.includes(phase)) {
      throw new PipelineContractError(`Duplicate pipeline phase "${phase}" is not allowed.`, 'PIPELINE_PHASES_INVALID');
    }
    phases.push(phase);
  }
  return [...phases, 'citadel'];
}

function normalizeBootstrapSource(value: unknown): PipelineBootstrapSource {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'task' || normalized === 'prd') {
    return normalized;
  }
  throw new PipelineContractError(
    `Invalid pipeline bootstrap source "${value}". Expected "task" or "prd".`,
    'PIPELINE_BOOTSTRAP_INVALID',
  );
}

function normalizeSkipFlags(
  value: unknown = {},
  phases: readonly PipelinePhase[] = PIPELINE_PHASES,
): PipelineSkipFlags {
  const source = isPlainObject(value) ? value : {};
  const flags: PipelineSkipFlags = {
    anatomy: Boolean(source.anatomy ?? !phases.includes('anatomy-park')),
    szechuan: Boolean(source.szechuan ?? !phases.includes('szechuan-sauce')),
  };

  if (flags.anatomy && phases.includes('anatomy-park')) {
    throw new PipelineContractError(
      'Pipeline skip flags conflict with the phase list: anatomy is marked skipped but anatomy-park is still present.',
      'PIPELINE_SKIP_FLAGS_INVALID',
    );
  }
  if (flags.szechuan && phases.includes('szechuan-sauce')) {
    throw new PipelineContractError(
      'Pipeline skip flags conflict with the phase list: szechuan is marked skipped but szechuan-sauce is still present.',
      'PIPELINE_SKIP_FLAGS_INVALID',
    );
  }

  return flags;
}

function normalizeBootstrapFields(
  contract: PipelineContractInput,
): { bootstrap_source: PipelineBootstrapSource; task: string | null; bootstrap_prd: string | null } {
  const bootstrapSource = normalizeBootstrapSource(contract.bootstrap_source);
  const task = typeof contract.task === 'string' && contract.task.trim() ? contract.task.trim() : null;
  const bootstrapPrd = contract.bootstrap_prd == null ? null : String(contract.bootstrap_prd).trim();

  if (bootstrapSource === 'task') {
    if (!task) {
      throw new PipelineContractError(
        'Pipeline task bootstrap requires a non-empty task string.',
        'PIPELINE_BOOTSTRAP_INVALID',
      );
    }
    if (bootstrapPrd !== null) {
      throw new PipelineContractError(
        'Pipeline task bootstrap may not also declare bootstrap_prd.',
        'PIPELINE_BOOTSTRAP_INVALID',
      );
    }
  }

  if (bootstrapSource === 'prd') {
    if (!isAbsolutePath(bootstrapPrd)) {
      throw new PipelineContractError(
        'Pipeline PRD bootstrap requires an absolute bootstrap_prd path.',
        'PIPELINE_BOOTSTRAP_INVALID',
      );
    }
  }

  return {
    bootstrap_source: bootstrapSource,
    task,
    bootstrap_prd: bootstrapPrd,
  };
}

export function createPipelineContract(contract: unknown): PipelineContract {
  if (!isPlainObject(contract)) {
    throw new PipelineContractError('Pipeline contract must be a JSON object.');
  }

  const input = contract as PipelineContractInput;
  if (!isAbsolutePath(input.working_dir)) {
    throw new PipelineContractError('Pipeline working_dir must be an absolute path.', 'PIPELINE_WORKING_DIR_INVALID');
  }
  if (!isAbsolutePath(input.target)) {
    throw new PipelineContractError('Pipeline target must be an absolute path.', 'PIPELINE_TARGET_INVALID');
  }

  const phases = normalizePipelinePhases(input.phases);
  const bootstrap = normalizeBootstrapFields(input);
  const skipFlags = normalizeSkipFlags(input.skip_flags, phases);

  return {
    schema_version: Number.isInteger(input.schema_version)
      ? (input.schema_version as number)
      : PIPELINE_SCHEMA_VERSION,
    working_dir: path.resolve(input.working_dir as string),
    target: path.resolve(input.target as string),
    scope: normalizePipelineScope(input.scope),
    phases,
    skip_flags: skipFlags,
    ...bootstrap,
    pickle: isPlainObject(input.pickle) ? { ...input.pickle } : {},
    citadel: isPlainObject(input.citadel) ? { ...input.citadel } : {},
    anatomy: isPlainObject(input.anatomy) ? { ...input.anatomy } : {},
    szechuan: isPlainObject(input.szechuan) ? { ...input.szechuan } : {},
  };
}

export function validatePipelineContract(contract: unknown): PipelineContract {
  const normalized = createPipelineContract(contract);
  if (normalized.schema_version > PIPELINE_SCHEMA_VERSION) {
    throw new PipelineContractError(
      `Pipeline schema ${normalized.schema_version} is newer than supported ${PIPELINE_SCHEMA_VERSION}.`,
      'PIPELINE_SCHEMA_MISMATCH',
    );
  }
  return normalized;
}

export function readPipelineContract(sessionDir: string): PipelineContract {
  const filePath = getPipelinePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    throw new PipelineContractError(`Missing pipeline.json in ${sessionDir}.`, 'PIPELINE_CONTRACT_MISSING');
  }
  const parsed = readJsonFile(filePath, null);
  if (!parsed) {
    throw new PipelineContractError(`Unreadable pipeline.json in ${sessionDir}.`, 'PIPELINE_CONTRACT_INVALID');
  }
  return validatePipelineContract(parsed);
}

export function writePipelineContract(sessionDir: string, contract: unknown): PipelineContract {
  const normalized = validatePipelineContract(contract);
  atomicWriteJson(getPipelinePath(sessionDir), normalized);
  return normalized;
}

export function buildPipelineStateMirror(contract: unknown): PipelineStateMirror {
  const normalized = validatePipelineContract(contract);
  return {
    pipeline_working_dir: normalized.working_dir,
    pipeline_target: normalized.target,
    pipeline_scope: [...normalized.scope],
    pipeline_bootstrap_source: normalized.bootstrap_source,
    pipeline_bootstrap_prd: normalized.bootstrap_prd,
    pipeline_task: normalized.task,
    pipeline_phases: [...normalized.phases],
    pipeline_skip_flags: { ...normalized.skip_flags },
  };
}

export function hasPipelineContract(sessionDir: string): boolean {
  return fs.existsSync(getPipelinePath(sessionDir));
}

export function assertPipelineResumeCompatible(
  existingContract: unknown,
  requestedContract: unknown,
): PipelineContract {
  const existing = validatePipelineContract(existingContract);
  const requested = validatePipelineContract(requestedContract);

  for (const [field, label] of RESUME_IMMUTABLE_FIELDS) {
    if (!compareJson(existing[field], requested[field])) {
      throw new PipelineContractError(
        `Cannot change pipeline ${label} on resume.`,
        'PIPELINE_RESUME_IMMUTABLE',
      );
    }
  }

  return existing;
}

export function resolveNextPipelinePhase(
  contract: unknown,
  pipelineState: { phase_statuses?: Record<string, unknown> } | null | undefined,
): PipelinePhase | null {
  const normalizedContract = validatePipelineContract(contract);
  const phaseStatuses = isPlainObject(pipelineState?.phase_statuses) ? pipelineState!.phase_statuses : {};

  for (const phase of normalizedContract.phases) {
    if (phaseStatuses[phase] !== 'done') {
      return phase;
    }
  }
  return null;
}
