import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';
import { StateManager } from './state-manager.js';

export const PRD_SEAL_SCHEMA_VERSION = 1;
export const PRD_SEAL_FILE_NAME = 'prd.lock.json';
const sealStateManager = new StateManager({ acquireTimeoutMs: 5_000, staleLockThresholdMs: 30_000 });

export interface PrdAcceptanceCriterion {
  id: string;
  text: string;
}

export interface PrdSealContract {
  repository: {
    identity: string;
    working_directory: string;
    execution_base_policy: string;
  };
  acceptance_criteria: PrdAcceptanceCriterion[];
  scope_and_ownership: unknown;
  dependencies_and_external_prerequisites: unknown;
  risk: unknown;
  decision_precedence: unknown;
  preservation_and_rollback: unknown;
  completion_definition: unknown;
  release_gates: unknown;
}

export interface PrdSeal extends PrdSealContract {
  schema_version: number;
  prd_sha256: string;
  semantic_hash: string;
  sealed_at: string;
}

export interface CreatePrdSealInput extends PrdSealContract {
  prd: string;
  sealedAt?: string;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid PRD seal: ${field} must be a non-empty string.`);
  }
}

function requireBoundValue(value: unknown, field: string): void {
  if (value === undefined || value === null) {
    throw new Error(`Invalid PRD seal: ${field} must be present.`);
  }
}

function semanticPayload(seal: Omit<PrdSeal, 'semantic_hash'>): unknown {
  return seal;
}

export function createPrdSeal(input: CreatePrdSealInput): PrdSeal {
  requireNonEmptyString(input.prd, 'prd');
  const withoutHash: Omit<PrdSeal, 'semantic_hash'> = {
    schema_version: PRD_SEAL_SCHEMA_VERSION,
    prd_sha256: sha256(input.prd),
    repository: input.repository,
    acceptance_criteria: input.acceptance_criteria,
    scope_and_ownership: input.scope_and_ownership,
    dependencies_and_external_prerequisites: input.dependencies_and_external_prerequisites,
    risk: input.risk,
    decision_precedence: input.decision_precedence,
    preservation_and_rollback: input.preservation_and_rollback,
    completion_definition: input.completion_definition,
    release_gates: input.release_gates,
    sealed_at: input.sealedAt ?? new Date().toISOString(),
  };
  const seal: PrdSeal = {
    ...withoutHash,
    semantic_hash: sha256(canonicalize(semanticPayload(withoutHash))),
  };
  return validatePrdSeal(seal);
}

export function validatePrdSeal(value: unknown): PrdSeal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid PRD seal: expected an object.');
  }
  const seal = value as PrdSeal;
  if (seal.schema_version !== PRD_SEAL_SCHEMA_VERSION) {
    throw new Error(`Invalid PRD seal: unsupported schema version ${String(seal.schema_version)}.`);
  }
  requireNonEmptyString(seal.prd_sha256, 'prd_sha256');
  requireNonEmptyString(seal.semantic_hash, 'semantic_hash');
  requireNonEmptyString(seal.sealed_at, 'sealed_at');
  if (!/^[a-f0-9]{64}$/.test(seal.prd_sha256) || !/^[a-f0-9]{64}$/.test(seal.semantic_hash)) {
    throw new Error('Invalid PRD seal: hashes must be lowercase SHA-256 values.');
  }
  if (!Number.isFinite(Date.parse(seal.sealed_at))) throw new Error('Invalid PRD seal: sealed_at must be an ISO timestamp.');
  if (!seal.repository || typeof seal.repository !== 'object') {
    throw new Error('Invalid PRD seal: repository must be an object.');
  }
  requireNonEmptyString(seal.repository.identity, 'repository.identity');
  requireNonEmptyString(seal.repository.working_directory, 'repository.working_directory');
  requireNonEmptyString(seal.repository.execution_base_policy, 'repository.execution_base_policy');
  if (!Array.isArray(seal.acceptance_criteria) || seal.acceptance_criteria.length === 0) {
    throw new Error('Invalid PRD seal: acceptance_criteria must be non-empty.');
  }
  const ids = new Set<string>();
  for (const [index, criterion] of seal.acceptance_criteria.entries()) {
    requireNonEmptyString(criterion?.id, `acceptance_criteria[${index}].id`);
    requireNonEmptyString(criterion?.text, `acceptance_criteria[${index}].text`);
    if (ids.has(criterion.id)) throw new Error(`Invalid PRD seal: duplicate acceptance criterion ${criterion.id}.`);
    ids.add(criterion.id);
  }
  requireBoundValue(seal.scope_and_ownership, 'scope_and_ownership');
  requireBoundValue(seal.dependencies_and_external_prerequisites, 'dependencies_and_external_prerequisites');
  requireBoundValue(seal.risk, 'risk');
  requireBoundValue(seal.decision_precedence, 'decision_precedence');
  requireBoundValue(seal.preservation_and_rollback, 'preservation_and_rollback');
  requireBoundValue(seal.completion_definition, 'completion_definition');
  requireBoundValue(seal.release_gates, 'release_gates');

  const withoutHash = Object.fromEntries(
    Object.entries(seal).filter(([key]) => key !== 'semantic_hash'),
  ) as Omit<PrdSeal, 'semantic_hash'>;
  const expectedHash = sha256(canonicalize(semanticPayload(withoutHash)));
  if (seal.semantic_hash !== expectedHash) {
    throw new Error('Invalid PRD seal: semantic hash does not match the sealed contract.');
  }
  return seal;
}

export function assertPrdSealMatchesPrd(seal: PrdSeal, prd: string): void {
  validatePrdSeal(seal);
  if (seal.prd_sha256 !== sha256(prd)) {
    throw new Error('PRD content does not match the approved seal.');
  }
}

export function readPrdSeal(sessionDir: string): PrdSeal {
  const sealPath = path.join(sessionDir, PRD_SEAL_FILE_NAME);
  return validatePrdSeal(JSON.parse(fs.readFileSync(sealPath, 'utf8')) as unknown);
}

export function writePrdSeal(sessionDir: string, input: CreatePrdSealInput): PrdSeal {
  const sealPath = path.join(sessionDir, PRD_SEAL_FILE_NAME);
  sealStateManager.acquireLock(sealPath);
  try {
    if (fs.existsSync(sealPath)) {
      const existing = readPrdSeal(sessionDir);
      const candidate = createPrdSeal({ ...input, sealedAt: existing.sealed_at });
      if (canonicalize(existing) !== canonicalize(candidate)) {
        throw new Error('PRD is already sealed; enter prd_revision_required before replacing the contract.');
      }
      return existing;
    }
    const seal = createPrdSeal(input);
    atomicWriteJson(sealPath, seal);
    const readBack = readPrdSeal(sessionDir);
    if (canonicalize(readBack) !== canonicalize(seal)) {
      throw new Error('PRD seal read-back validation failed.');
    }
    assertPrdSealMatchesPrd(readBack, input.prd);
    return readBack;
  } finally {
    sealStateManager.releaseLock(sealPath);
  }
}

/** Called only while the logical control plane holds prd_revision_required. */
export function replacePrdSealAfterRevision(sessionDir: string, input: CreatePrdSealInput): PrdSeal {
  const sealPath = path.join(sessionDir, PRD_SEAL_FILE_NAME);
  sealStateManager.acquireLock(sealPath);
  try {
    if (!fs.existsSync(sealPath)) throw new Error('Cannot replace a PRD seal that does not exist.');
    const seal = createPrdSeal(input);
    atomicWriteJson(sealPath, seal);
    const readBack = readPrdSeal(sessionDir);
    if (canonicalize(readBack) !== canonicalize(seal)) throw new Error('Revised PRD seal read-back validation failed.');
    assertPrdSealMatchesPrd(readBack, input.prd);
    return readBack;
  } finally {
    sealStateManager.releaseLock(sealPath);
  }
}
