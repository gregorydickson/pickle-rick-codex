import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ADOPTION_WATCH_STRATEGY_IDS = [
  'standard-adopt-launch',
  'authenticated-runtime-revalidation',
  'sealed-launch-transaction-reconstruction',
] as const;

export type AdoptionWatchStrategyId = typeof ADOPTION_WATCH_STRATEGY_IDS[number];
export type AdoptionWatchStrategyOutcome = 'failed' | 'interrupted' | 'launched';

export interface AdoptionWatchStrategyAttempt {
  epoch: number;
  strategy_id: AdoptionWatchStrategyId;
  epoch_seed: string;
  evidence_hash: string;
  constraints_hash: string;
  material_hash: string;
  started_at: string;
}

export interface AdoptionWatchStrategyHistoryEntry extends AdoptionWatchStrategyAttempt {
  sequence: number;
  outcome: AdoptionWatchStrategyOutcome;
  failure_signature: string | null;
  finished_at: string;
  previous_hash: string;
  entry_hash: string;
}

export interface AdoptionWatchStrategyState {
  schema_version: 1;
  epoch: number;
  cursor: number;
  epoch_seed: string;
  history_base_checkpoint: AdoptionWatchStrategyCheckpoint;
  history: AdoptionWatchStrategyHistoryEntry[];
  active: AdoptionWatchStrategyAttempt | null;
  state_hash: string;
}

export interface AdoptionWatchStrategyCheckpoint {
  epoch: number;
  cursor: number;
  epoch_seed: string;
  evidence_hash: string;
  used_material_hashes: string[];
  sequence: number;
  previous_hash: string;
  launched: boolean;
  checkpoint_hash: string;
}

const ZERO_HASH = '0'.repeat(64);
const MAX_HISTORY = 64;
const strategyConstraints = Object.fromEntries(ADOPTION_WATCH_STRATEGY_IDS.map((strategyId) => [
  strategyId,
  hash(`pickle-rick-adoption-watch:${strategyId}:v1`),
])) as Record<AdoptionWatchStrategyId, string>;
const evidenceFiles = [
  'legacy-session-adoption.json',
  'legacy-session-adoption-transaction.json',
  'installed-runtime-migration.json',
];

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  const content = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalize(value);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function adoptionWatchEvidenceHash(
  sessionDir: string,
  sourceRuntimeRoot: string,
  targetRuntimeRoot: string,
): string {
  const artifacts = evidenceFiles.map((name) => {
    const filePath = path.join(sessionDir, name);
    if (!fs.existsSync(filePath)) return { name, sha256: null };
    return { name, sha256: hash(fs.readFileSync(filePath)) };
  });
  const runtimeEvidence = [sourceRuntimeRoot, targetRuntimeRoot].map((root) => {
    const descriptorPath = path.join(root, '.runtime-descriptor.json');
    return {
      root,
      descriptor_sha256: fs.existsSync(descriptorPath) ? hash(fs.readFileSync(descriptorPath)) : null,
    };
  });
  const supervisorPath = path.join(sessionDir, 'legacy-session-adoption-executor.json');
  let supervisorEvidence: Record<string, unknown> | null = null;
  if (fs.existsSync(supervisorPath)) {
    try {
      const status = JSON.parse(fs.readFileSync(supervisorPath, 'utf8')) as Record<string, unknown>;
      const manager = status.manager_identity as Record<string, unknown> | undefined;
      const executor = status.executor_identity as Record<string, unknown> | undefined;
      supervisorEvidence = {
        schema_version: status.schema_version,
        executor_generation: status.executor_generation,
        executor_spec_sha256: status.executor_spec_sha256,
        manager_fingerprint: manager?.fingerprint || null,
        executor_fingerprint: executor?.fingerprint || null,
        executor_pid: executor?.pid || null,
      };
    } catch {
      supervisorEvidence = { invalid: true };
    }
  }
  return hash({ session_id: path.basename(sessionDir), source_runtime_root: sourceRuntimeRoot,
    target_runtime_root: targetRuntimeRoot, artifacts, runtime_evidence: runtimeEvidence,
    supervisor_evidence: supervisorEvidence });
}

export function createAdoptionWatchStrategyState(
  sessionId: string,
  evidenceHash: string,
  cursor = 0,
  usedMaterialHashes: string[] = [],
): AdoptionWatchStrategyState {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > ADOPTION_WATCH_STRATEGY_IDS.length) {
    throw new Error('adoption-watch-strategy-initial-cursor-invalid');
  }
  const epochSeed = hash({ session_id: sessionId, evidence_hash: evidenceHash, epoch: 1 });
  return sealStrategyState({
    schema_version: 1,
    epoch: 1,
    cursor,
    epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch: 1, cursor, epoch_seed: epochSeed, evidence_hash: evidenceHash,
      used_material_hashes: [...usedMaterialHashes], sequence: 0, previous_hash: ZERO_HASH, launched: false,
    }),
    history: [],
    active: null,
  });
}

export function createAdoptionWatchLedgerRecoveryState(
  evidenceHash: string,
  epoch: number,
  epochSeed: string,
  cursor: number,
  usedMaterialHashes: string[],
): AdoptionWatchStrategyState {
  if (!Number.isInteger(epoch) || epoch < 1 || !isHash(epochSeed)
    || !Number.isInteger(cursor) || cursor < 0 || cursor > ADOPTION_WATCH_STRATEGY_IDS.length) {
    throw new Error('adoption-watch-ledger-recovery-header-invalid');
  }
  return sealStrategyState({
    schema_version: 1, epoch, cursor, epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch, cursor, epoch_seed: epochSeed, evidence_hash: evidenceHash,
      used_material_hashes: [...usedMaterialHashes], sequence: 0, previous_hash: ZERO_HASH, launched: false,
    }),
    history: [], active: null,
  });
}

export function adoptionWatchStrategyStateLaunched(state: AdoptionWatchStrategyState): boolean {
  return state.history.at(-1)?.outcome === 'launched'
    || (state.history.length === 0 && state.history_base_checkpoint.launched);
}

export function createAdoptionWatchTerminalRecoveryState(
  sessionId: string,
  evidenceHash: string,
  prior: AdoptionWatchStrategyState,
  cursor = 0,
  usedMaterialHashes: string[] = [],
): AdoptionWatchStrategyState {
  if (!adoptionWatchStrategyStateLaunched(prior)) throw new Error('adoption-watch-terminal-recovery-not-launched');
  const epoch = prior.epoch + 1;
  const epochSeed = hash({ session_id: sessionId, evidence_hash: evidenceHash,
    prior_terminal_state_hash: prior.state_hash, epoch, reason: 'missing-or-regressed-launch-record' });
  return sealStrategyState({
    schema_version: 1, epoch, cursor, epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch, cursor, epoch_seed: epochSeed, evidence_hash: evidenceHash,
      used_material_hashes: [...usedMaterialHashes], sequence: 0, previous_hash: ZERO_HASH, launched: false,
    }),
    history: [], active: null,
  });
}

export function createAdoptionWatchEvidenceRecoveryState(
  sessionId: string,
  evidenceHash: string,
  prior: AdoptionWatchStrategyState,
  restartReceiptHash: string,
  cursor = 0,
  usedMaterialHashes: string[] = [],
): AdoptionWatchStrategyState {
  if (prior.cursor !== ADOPTION_WATCH_STRATEGY_IDS.length || prior.active
    || adoptionWatchStrategyStateLaunched(prior)) throw new Error('adoption-watch-evidence-recovery-not-exhausted');
  if (evidenceHash === prior.history_base_checkpoint.evidence_hash) {
    throw new Error('adoption-watch-evidence-recovery-unchanged');
  }
  const epoch = prior.epoch + 1;
  const epochSeed = hash({ session_id: sessionId, evidence_hash: evidenceHash,
    prior_exhausted_state_hash: prior.state_hash, restart_receipt_hash: restartReceiptHash, epoch });
  return sealStrategyState({
    schema_version: 1, epoch, cursor, epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch, cursor, epoch_seed: epochSeed, evidence_hash: evidenceHash,
      used_material_hashes: [...usedMaterialHashes], sequence: 0, previous_hash: ZERO_HASH, launched: false,
    }),
    history: [], active: null,
  });
}

function strategyStateHash(state: Omit<AdoptionWatchStrategyState, 'state_hash'>): string {
  return hash({ schema_version: state.schema_version, epoch: state.epoch, cursor: state.cursor,
    epoch_seed: state.epoch_seed, history_base_checkpoint: state.history_base_checkpoint,
    history_head_hash: state.history.at(-1)?.entry_hash || state.history_base_checkpoint.previous_hash,
    active: state.active });
}

function sealStrategyState(state: Omit<AdoptionWatchStrategyState, 'state_hash'>): AdoptionWatchStrategyState {
  return { ...state, state_hash: strategyStateHash(state) };
}

function unsealStrategyState(state: AdoptionWatchStrategyState): Omit<AdoptionWatchStrategyState, 'state_hash'> {
  return {
    schema_version: state.schema_version, epoch: state.epoch, cursor: state.cursor,
    epoch_seed: state.epoch_seed, history_base_checkpoint: state.history_base_checkpoint,
    history: state.history, active: state.active,
  };
}

function checkpointHash(checkpoint: Omit<AdoptionWatchStrategyCheckpoint, 'checkpoint_hash'>): string {
  return hash(checkpoint);
}

function sealCheckpoint(
  checkpoint: Omit<AdoptionWatchStrategyCheckpoint, 'checkpoint_hash'>,
): AdoptionWatchStrategyCheckpoint {
  return { ...checkpoint, checkpoint_hash: checkpointHash(checkpoint) };
}

function advanceCheckpoint(
  checkpoint: AdoptionWatchStrategyCheckpoint,
  entry: AdoptionWatchStrategyHistoryEntry,
): AdoptionWatchStrategyCheckpoint {
  if (entry.outcome === 'launched') {
    return sealCheckpoint({ ...checkpoint, used_material_hashes: [...checkpoint.used_material_hashes, entry.material_hash],
      sequence: entry.sequence, previous_hash: entry.entry_hash, launched: true });
  }
  if (checkpoint.launched) throw new Error('adoption-watch-strategy-follows-launched-checkpoint');
  const cursor = Math.min(checkpoint.cursor + 1, ADOPTION_WATCH_STRATEGY_IDS.length);
  return sealCheckpoint({ ...checkpoint, cursor,
    used_material_hashes: [...checkpoint.used_material_hashes, entry.material_hash],
    sequence: entry.sequence, previous_hash: entry.entry_hash, launched: false });
}

export function adoptionWatchStrategyMaterialHash(strategyId: AdoptionWatchStrategyId, evidenceHash: string): string {
  return hash({ strategy_id: strategyId, evidence_hash: evidenceHash,
    constraints_hash: strategyConstraints[strategyId] });
}

export function beginAdoptionWatchStrategy(
  state: AdoptionWatchStrategyState,
  evidenceHash: string,
  startedAt: string,
  priorMaterialHashes: Iterable<string> = [],
): { state: AdoptionWatchStrategyState; attempt: AdoptionWatchStrategyAttempt } {
  if (state.active) throw new Error('adoption-watch-strategy-active');
  if (adoptionWatchStrategyStateLaunched(state)) throw new Error('adoption-watch-strategy-already-launched');
  if (state.cursor >= ADOPTION_WATCH_STRATEGY_IDS.length) throw new Error('adoption-watch-strategy-catalog-exhausted');
  if (evidenceHash !== state.history_base_checkpoint.evidence_hash) {
    throw new Error('adoption-watch-strategy-evidence-transition-unrecorded');
  }
  const strategyId = ADOPTION_WATCH_STRATEGY_IDS[state.cursor];
  if (!strategyId) throw new Error('adoption-watch-strategy-cursor-invalid');
  const attempt = {
    epoch: state.epoch, strategy_id: strategyId, epoch_seed: state.epoch_seed, evidence_hash: evidenceHash,
    constraints_hash: strategyConstraints[strategyId],
    material_hash: adoptionWatchStrategyMaterialHash(strategyId, evidenceHash), started_at: startedAt,
  };
  if (new Set(priorMaterialHashes).has(attempt.material_hash)
    || state.history_base_checkpoint.used_material_hashes.includes(attempt.material_hash)
    || state.history.some((entry) => entry.material_hash === attempt.material_hash)) {
    throw new Error('adoption-watch-strategy-reuse-rejected');
  }
  return { state: sealStrategyState({ ...unsealStrategyState(state), active: attempt }), attempt };
}

function historyEntryHash(entry: Omit<AdoptionWatchStrategyHistoryEntry, 'entry_hash'>): string {
  return hash(entry);
}

export function finishAdoptionWatchStrategy(
  state: AdoptionWatchStrategyState,
  outcome: AdoptionWatchStrategyOutcome,
  failureSignature: string | null,
  finishedAt: string,
): AdoptionWatchStrategyState {
  if (!state.active) throw new Error('adoption-watch-strategy-not-active');
  const previousHash = state.history.at(-1)?.entry_hash || state.history_base_checkpoint.previous_hash;
  const payload = {
    ...state.active,
    sequence: (state.history.at(-1)?.sequence || state.history_base_checkpoint.sequence) + 1,
    outcome,
    failure_signature: failureSignature,
    finished_at: finishedAt,
    previous_hash: previousHash,
  };
  const entry = { ...payload, entry_hash: historyEntryHash(payload) };
  const history = [...state.history, entry];
  let historyBaseCheckpoint = state.history_base_checkpoint;
  if (history.length > MAX_HISTORY) {
    const removed = history.splice(0, history.length - MAX_HISTORY);
    for (const removedEntry of removed) historyBaseCheckpoint = advanceCheckpoint(historyBaseCheckpoint, removedEntry);
  }
  const epoch = state.epoch;
  let cursor = state.cursor;
  const epochSeed = state.epoch_seed;
  if (outcome !== 'launched') {
    cursor = Math.min(cursor + 1, ADOPTION_WATCH_STRATEGY_IDS.length);
  }
  return { ...sealStrategyState({ ...unsealStrategyState(state), epoch, cursor, epoch_seed: epochSeed,
    history_base_checkpoint: historyBaseCheckpoint, history, active: null }) };
}

export function validateAdoptionWatchStrategyState(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'strategy_state must be an object';
  const state = value as Partial<AdoptionWatchStrategyState>;
  if (state.schema_version !== 1 || !Number.isInteger(state.epoch) || Number(state.epoch) < 1
    || !Number.isInteger(state.cursor) || Number(state.cursor) < 0 || Number(state.cursor) > ADOPTION_WATCH_STRATEGY_IDS.length
    || !isHash(state.epoch_seed) || !Array.isArray(state.history)
    || !isHash(state.state_hash)) {
    return 'strategy_state header is invalid';
  }
  const base = state.history_base_checkpoint;
  if (!base || !Number.isInteger(base.epoch) || base.epoch < 1
    || !Number.isInteger(base.cursor) || base.cursor < 0 || base.cursor > ADOPTION_WATCH_STRATEGY_IDS.length
    || !Number.isInteger(base.sequence) || base.sequence < 0
    || typeof base.launched !== 'boolean'
    || !isHash(base.evidence_hash) || !Array.isArray(base.used_material_hashes)
    || base.used_material_hashes.some((material) => !isHash(material))
    || new Set(base.used_material_hashes).size !== base.used_material_hashes.length
    || !isHash(base.epoch_seed) || !isHash(base.previous_hash) || !isHash(base.checkpoint_hash)) {
    return 'strategy semantic base checkpoint is invalid';
  }
  const { checkpoint_hash: checkpointDigest, ...checkpointPayload } = base;
  if (checkpointDigest !== checkpointHash(checkpointPayload)) return 'strategy semantic base checkpoint hash is invalid';
  if (state.history.length > MAX_HISTORY) return 'strategy history exceeds its durable bound';
  let semantic = base;
  let launched = base.launched;
  const usedMaterials = new Set(base.used_material_hashes);
  for (const raw of state.history) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'strategy history entry must be an object';
    const entry = raw as AdoptionWatchStrategyHistoryEntry;
    if (launched || !Number.isInteger(entry.sequence) || entry.sequence !== semantic.sequence + 1
      || entry.epoch !== semantic.epoch
      || entry.strategy_id !== ADOPTION_WATCH_STRATEGY_IDS[semantic.cursor]
      || entry.epoch_seed !== semantic.epoch_seed
      || entry.evidence_hash !== semantic.evidence_hash
      || entry.constraints_hash !== strategyConstraints[entry.strategy_id]
      || !isHash(entry.epoch_seed) || !isHash(entry.evidence_hash) || !isHash(entry.material_hash)
      || entry.material_hash !== hash({ strategy_id: entry.strategy_id,
        evidence_hash: entry.evidence_hash, constraints_hash: entry.constraints_hash })
      || !isIsoTimestamp(entry.started_at) || !isIsoTimestamp(entry.finished_at)
      || !['failed', 'interrupted', 'launched'].includes(entry.outcome)
      || (entry.failure_signature !== null && typeof entry.failure_signature !== 'string')
      || entry.previous_hash !== semantic.previous_hash) return 'strategy history entry is invalid';
    if (usedMaterials.has(entry.material_hash)) return 'strategy material repeats across recovery history';
    usedMaterials.add(entry.material_hash);
    const { entry_hash: entryHash, ...payload } = entry;
    if (!isHash(entryHash) || entryHash !== historyEntryHash(payload)) return 'strategy history hash chain is invalid';
    semantic = advanceCheckpoint(semantic, entry);
    launched = entry.outcome === 'launched';
  }
  if (state.epoch !== semantic.epoch || state.cursor !== semantic.cursor || state.epoch_seed !== semantic.epoch_seed) {
    return 'strategy state head does not match semantic history replay';
  }
  if (state.active !== null) {
    const active = state.active as AdoptionWatchStrategyAttempt;
    if (!active || !Number.isInteger(active.epoch) || active.epoch !== state.epoch
      || active.strategy_id !== ADOPTION_WATCH_STRATEGY_IDS[Number(state.cursor)]
      || active.epoch_seed !== state.epoch_seed
      || active.evidence_hash !== semantic.evidence_hash
      || active.constraints_hash !== strategyConstraints[active.strategy_id]
      || !isHash(active.evidence_hash) || !isHash(active.material_hash)
      || active.material_hash !== adoptionWatchStrategyMaterialHash(active.strategy_id, active.evidence_hash)
      || !isIsoTimestamp(active.started_at)) return 'active strategy attempt is invalid';
    if (launched || usedMaterials.has(active.material_hash)) {
      return 'active strategy repeats completed material or follows launch';
    }
  }
  const { state_hash: stateHash, ...unsealed } = state as AdoptionWatchStrategyState;
  if (stateHash !== strategyStateHash(unsealed)) return 'strategy state hash is invalid';
  return null;
}
