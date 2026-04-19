import fs from 'node:fs';
import path from 'node:path';
import { STATE_SCHEMA_VERSION, atomicWriteJson, readJsonFile } from './pickle-utils.js';

export const PIPELINE_SCHEMA_VERSION = STATE_SCHEMA_VERSION;
export const PIPELINE_PHASES = Object.freeze(['pickle', 'anatomy-park', 'szechuan-sauce']);
export const PIPELINE_PHASE_ALIAS_MAP = Object.freeze({
  pickle: 'pickle',
  build: 'pickle',
  anatomy: 'anatomy-park',
  'anatomy-park': 'anatomy-park',
  szechuan: 'szechuan-sauce',
  'szechuan-sauce': 'szechuan-sauce',
});

const RESUME_IMMUTABLE_FIELDS = Object.freeze([
  ['target', 'target'],
  ['working_dir', 'working directory'],
  ['bootstrap_source', 'bootstrap source'],
  ['bootstrap_prd', 'bootstrap PRD path'],
  ['task', 'task bootstrap prompt'],
  ['phases', 'phase list'],
  ['skip_flags', 'skip flags'],
]);

export class PipelineContractError extends Error {
  constructor(message, code = 'PIPELINE_CONTRACT_INVALID') {
    super(message);
    this.name = 'PipelineContractError';
    this.code = code;
  }
}

export function getPipelinePath(sessionDir) {
  return path.join(sessionDir, 'pipeline.json');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value.trim());
}

function compareJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizePipelinePhase(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const phase = PIPELINE_PHASE_ALIAS_MAP[normalized];
  if (!phase) {
    throw new PipelineContractError(
      `Unsupported pipeline phase "${value}". Expected one of: ${PIPELINE_PHASES.join(', ')}`,
      'PIPELINE_PHASE_INVALID',
    );
  }
  return phase;
}

export function normalizePipelinePhases(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new PipelineContractError('Pipeline phases must be a non-empty array.', 'PIPELINE_PHASES_INVALID');
  }

  const phases = [];
  for (const value of values) {
    const phase = normalizePipelinePhase(value);
    if (phases.includes(phase)) {
      throw new PipelineContractError(`Duplicate pipeline phase "${phase}" is not allowed.`, 'PIPELINE_PHASES_INVALID');
    }
    phases.push(phase);
  }
  return phases;
}

function normalizeBootstrapSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'task' || normalized === 'prd') {
    return normalized;
  }
  throw new PipelineContractError(
    `Invalid pipeline bootstrap source "${value}". Expected "task" or "prd".`,
    'PIPELINE_BOOTSTRAP_INVALID',
  );
}

function normalizeSkipFlags(value = {}, phases = PIPELINE_PHASES) {
  const source = isPlainObject(value) ? value : {};
  const flags = {
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

function normalizeBootstrapFields(contract) {
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

export function createPipelineContract(contract) {
  if (!isPlainObject(contract)) {
    throw new PipelineContractError('Pipeline contract must be a JSON object.');
  }

  if (!isAbsolutePath(contract.working_dir)) {
    throw new PipelineContractError('Pipeline working_dir must be an absolute path.', 'PIPELINE_WORKING_DIR_INVALID');
  }
  if (!isAbsolutePath(contract.target)) {
    throw new PipelineContractError('Pipeline target must be an absolute path.', 'PIPELINE_TARGET_INVALID');
  }

  const phases = normalizePipelinePhases(contract.phases);
  const bootstrap = normalizeBootstrapFields(contract);
  const skipFlags = normalizeSkipFlags(contract.skip_flags, phases);

  return {
    schema_version: Number.isInteger(contract.schema_version)
      ? contract.schema_version
      : PIPELINE_SCHEMA_VERSION,
    working_dir: path.resolve(contract.working_dir),
    target: path.resolve(contract.target),
    phases,
    skip_flags: skipFlags,
    ...bootstrap,
    pickle: isPlainObject(contract.pickle) ? { ...contract.pickle } : {},
    anatomy: isPlainObject(contract.anatomy) ? { ...contract.anatomy } : {},
    szechuan: isPlainObject(contract.szechuan) ? { ...contract.szechuan } : {},
  };
}

export function validatePipelineContract(contract) {
  const normalized = createPipelineContract(contract);
  if (normalized.schema_version > PIPELINE_SCHEMA_VERSION) {
    throw new PipelineContractError(
      `Pipeline schema ${normalized.schema_version} is newer than supported ${PIPELINE_SCHEMA_VERSION}.`,
      'PIPELINE_SCHEMA_MISMATCH',
    );
  }
  return normalized;
}

export function readPipelineContract(sessionDir) {
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

export function writePipelineContract(sessionDir, contract) {
  const normalized = validatePipelineContract(contract);
  atomicWriteJson(getPipelinePath(sessionDir), normalized);
  return normalized;
}

export function buildPipelineStateMirror(contract) {
  const normalized = validatePipelineContract(contract);
  return {
    pipeline_working_dir: normalized.working_dir,
    pipeline_target: normalized.target,
    pipeline_bootstrap_source: normalized.bootstrap_source,
    pipeline_bootstrap_prd: normalized.bootstrap_prd,
    pipeline_task: normalized.task,
    pipeline_phases: [...normalized.phases],
    pipeline_skip_flags: { ...normalized.skip_flags },
  };
}

export function hasPipelineContract(sessionDir) {
  return fs.existsSync(getPipelinePath(sessionDir));
}

export function assertPipelineResumeCompatible(existingContract, requestedContract) {
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

export function resolveNextPipelinePhase(contract, pipelineState) {
  const normalizedContract = validatePipelineContract(contract);
  const phaseStatuses = isPlainObject(pipelineState?.phase_statuses) ? pipelineState.phase_statuses : {};

  for (const phase of normalizedContract.phases) {
    if (phaseStatuses[phase] !== 'done') {
      return phase;
    }
  }
  return null;
}
