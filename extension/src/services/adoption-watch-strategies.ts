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
  sequence: number;
  previous_hash: string;
  launched: boolean;
  checkpoint_hash: string;
}

const ZERO_HASH = '0'.repeat(64);
const MAX_HISTORY = 64;
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
  return hash({ session_id: path.basename(sessionDir), source_runtime_root: sourceRuntimeRoot,
    target_runtime_root: targetRuntimeRoot, artifacts, runtime_evidence: runtimeEvidence });
}

export function createAdoptionWatchStrategyState(sessionId: string, evidenceHash: string): AdoptionWatchStrategyState {
  const epochSeed = hash({ session_id: sessionId, evidence_hash: evidenceHash, epoch: 1 });
  return sealStrategyState({
    schema_version: 1,
    epoch: 1,
    cursor: 0,
    epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch: 1, cursor: 0, epoch_seed: epochSeed, sequence: 0, previous_hash: ZERO_HASH, launched: false,
    }),
    history: [],
    active: null,
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
): AdoptionWatchStrategyState {
  if (!adoptionWatchStrategyStateLaunched(prior)) throw new Error('adoption-watch-terminal-recovery-not-launched');
  const epoch = prior.epoch + 1;
  const epochSeed = hash({ session_id: sessionId, evidence_hash: evidenceHash,
    prior_terminal_state_hash: prior.state_hash, epoch, reason: 'missing-or-regressed-launch-record' });
  return sealStrategyState({
    schema_version: 1, epoch, cursor: 0, epoch_seed: epochSeed,
    history_base_checkpoint: sealCheckpoint({
      epoch, cursor: 0, epoch_seed: epochSeed, sequence: 0, previous_hash: ZERO_HASH, launched: false,
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
    return sealCheckpoint({ ...checkpoint, sequence: entry.sequence, previous_hash: entry.entry_hash, launched: true });
  }
  if (checkpoint.launched) throw new Error('adoption-watch-strategy-follows-launched-checkpoint');
  let cursor = checkpoint.cursor + 1;
  let epoch = checkpoint.epoch;
  let epochSeed = checkpoint.epoch_seed;
  if (cursor >= ADOPTION_WATCH_STRATEGY_IDS.length) {
    cursor = 0;
    epoch += 1;
    epochSeed = hash({ prior_epoch_seed: checkpoint.epoch_seed, history_head: entry.entry_hash,
      evidence_hash: entry.evidence_hash, epoch });
  }
  return sealCheckpoint({ epoch, cursor, epoch_seed: epochSeed,
    sequence: entry.sequence, previous_hash: entry.entry_hash, launched: false });
}

function materialHash(state: AdoptionWatchStrategyState, strategyId: AdoptionWatchStrategyId, evidenceHash: string): string {
  return hash({ strategy_id: strategyId, evidence_hash: evidenceHash, epoch_seed: state.epoch_seed });
}

export function beginAdoptionWatchStrategy(
  state: AdoptionWatchStrategyState,
  evidenceHash: string,
  startedAt: string,
): { state: AdoptionWatchStrategyState; attempt: AdoptionWatchStrategyAttempt } {
  if (state.active) throw new Error('adoption-watch-strategy-active');
  if (adoptionWatchStrategyStateLaunched(state)) throw new Error('adoption-watch-strategy-already-launched');
  const strategyId = ADOPTION_WATCH_STRATEGY_IDS[state.cursor];
  if (!strategyId) throw new Error('adoption-watch-strategy-cursor-invalid');
  const attempt = {
    epoch: state.epoch, strategy_id: strategyId, epoch_seed: state.epoch_seed, evidence_hash: evidenceHash,
    material_hash: materialHash(state, strategyId, evidenceHash), started_at: startedAt,
  };
  if (state.history.some((entry) => entry.epoch === state.epoch && entry.material_hash === attempt.material_hash)) {
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
  let epoch = state.epoch;
  let cursor = state.cursor;
  let epochSeed = state.epoch_seed;
  if (outcome !== 'launched') {
    cursor += 1;
    if (cursor >= ADOPTION_WATCH_STRATEGY_IDS.length) {
      cursor = 0;
      epoch += 1;
      epochSeed = hash({ prior_epoch_seed: state.epoch_seed, history_head: entry.entry_hash,
        evidence_hash: state.active.evidence_hash, epoch });
    }
  }
  return { ...sealStrategyState({ ...unsealStrategyState(state), epoch, cursor, epoch_seed: epochSeed,
    history_base_checkpoint: historyBaseCheckpoint, history, active: null }) };
}

export function validateAdoptionWatchStrategyState(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'strategy_state must be an object';
  const state = value as Partial<AdoptionWatchStrategyState>;
  if (state.schema_version !== 1 || !Number.isInteger(state.epoch) || Number(state.epoch) < 1
    || !Number.isInteger(state.cursor) || Number(state.cursor) < 0 || Number(state.cursor) >= ADOPTION_WATCH_STRATEGY_IDS.length
    || !isHash(state.epoch_seed) || !Array.isArray(state.history)
    || !isHash(state.state_hash)) {
    return 'strategy_state header is invalid';
  }
  const base = state.history_base_checkpoint;
  if (!base || !Number.isInteger(base.epoch) || base.epoch < 1
    || !Number.isInteger(base.cursor) || base.cursor < 0 || base.cursor >= ADOPTION_WATCH_STRATEGY_IDS.length
    || !Number.isInteger(base.sequence) || base.sequence < 0
    || typeof base.launched !== 'boolean'
    || !isHash(base.epoch_seed) || !isHash(base.previous_hash) || !isHash(base.checkpoint_hash)) {
    return 'strategy semantic base checkpoint is invalid';
  }
  const { checkpoint_hash: checkpointDigest, ...checkpointPayload } = base;
  if (checkpointDigest !== checkpointHash(checkpointPayload)) return 'strategy semantic base checkpoint hash is invalid';
  if (state.history.length > MAX_HISTORY) return 'strategy history exceeds its durable bound';
  let semantic = base;
  let launched = base.launched;
  const materialsByEpoch = new Map<number, Set<string>>();
  for (const raw of state.history) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'strategy history entry must be an object';
    const entry = raw as AdoptionWatchStrategyHistoryEntry;
    if (launched || !Number.isInteger(entry.sequence) || entry.sequence !== semantic.sequence + 1
      || entry.epoch !== semantic.epoch
      || entry.strategy_id !== ADOPTION_WATCH_STRATEGY_IDS[semantic.cursor]
      || entry.epoch_seed !== semantic.epoch_seed
      || !isHash(entry.epoch_seed) || !isHash(entry.evidence_hash) || !isHash(entry.material_hash)
      || entry.material_hash !== hash({ strategy_id: entry.strategy_id,
        evidence_hash: entry.evidence_hash, epoch_seed: entry.epoch_seed })
      || !isIsoTimestamp(entry.started_at) || !isIsoTimestamp(entry.finished_at)
      || !['failed', 'interrupted', 'launched'].includes(entry.outcome)
      || (entry.failure_signature !== null && typeof entry.failure_signature !== 'string')
      || entry.previous_hash !== semantic.previous_hash) return 'strategy history entry is invalid';
    const epochMaterials = materialsByEpoch.get(entry.epoch) || new Set<string>();
    if (epochMaterials.has(entry.material_hash)) return 'strategy material repeats within one recovery epoch';
    epochMaterials.add(entry.material_hash);
    materialsByEpoch.set(entry.epoch, epochMaterials);
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
      || !isHash(active.evidence_hash) || !isHash(active.material_hash)
      || active.material_hash !== materialHash(state as AdoptionWatchStrategyState, active.strategy_id, active.evidence_hash)
      || !isIsoTimestamp(active.started_at)) return 'active strategy attempt is invalid';
    if (launched || materialsByEpoch.get(active.epoch)?.has(active.material_hash)) {
      return 'active strategy repeats completed material or follows launch';
    }
  }
  const { state_hash: stateHash, ...unsealed } = state as AdoptionWatchStrategyState;
  if (stateHash !== strategyStateHash(unsealed)) return 'strategy state hash is invalid';
  return null;
}
