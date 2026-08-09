import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './pickle-utils.js';
import {
  adoptionWatchStrategyStateLaunched,
  validateAdoptionWatchStrategyState,
  type AdoptionWatchStrategyState,
} from './adoption-watch-strategies.js';

export interface AdoptionWatchTerminalRecoveryRef {
  path: string;
  sha256: string;
  content_hash: string;
}

interface AdoptionWatchTerminalRecoveryArtifact {
  schema_version: 1;
  reason: 'missing-or-regressed-launch-record' | 'executor-topology-evidence-changed';
  archived_at: string;
  prior_strategy_state: AdoptionWatchStrategyState;
  prior_state_hash: string;
  prior_evidence_hash: string;
  replacement_evidence_hash: string;
  content_hash: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function archiveAdoptionWatchTerminalState(
  sessionDir: string,
  prior: AdoptionWatchStrategyState,
  replacementEvidenceHash: string,
  archivedAt: string,
): AdoptionWatchTerminalRecoveryRef {
  return archiveAdoptionWatchStrategyState(
    sessionDir, prior, replacementEvidenceHash, archivedAt, 'missing-or-regressed-launch-record',
  );
}

export function archiveAdoptionWatchExhaustedState(
  sessionDir: string,
  prior: AdoptionWatchStrategyState,
  replacementEvidenceHash: string,
  archivedAt: string,
): AdoptionWatchTerminalRecoveryRef {
  return archiveAdoptionWatchStrategyState(
    sessionDir, prior, replacementEvidenceHash, archivedAt, 'executor-topology-evidence-changed',
  );
}

function archiveAdoptionWatchStrategyState(
  sessionDir: string,
  prior: AdoptionWatchStrategyState,
  replacementEvidenceHash: string,
  archivedAt: string,
  reason: AdoptionWatchTerminalRecoveryArtifact['reason'],
): AdoptionWatchTerminalRecoveryRef {
  const expected = reason === 'missing-or-regressed-launch-record'
    ? adoptionWatchStrategyStateLaunched(prior)
    : prior.cursor === 3 && !prior.active && !adoptionWatchStrategyStateLaunched(prior);
  if (!expected || validateAdoptionWatchStrategyState(prior)) {
    throw new Error('Cannot archive an invalid or non-launched adoption watchdog strategy state.');
  }
  const priorEvidenceHash = prior.history.at(-1)?.evidence_hash
    || prior.active?.evidence_hash || '0'.repeat(64);
  const payload = {
    schema_version: 1 as const,
    reason,
    archived_at: archivedAt,
    prior_strategy_state: prior,
    prior_state_hash: prior.state_hash,
    prior_evidence_hash: priorEvidenceHash,
    replacement_evidence_hash: replacementEvidenceHash,
  };
  const contentHash = hash(canonicalize(payload));
  const artifact: AdoptionWatchTerminalRecoveryArtifact = { ...payload, content_hash: contentHash };
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  const relative = path.join('watch-terminal-recovery', `${contentHash}.json`);
  const filePath = path.join(sessionDir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, 'utf8') !== content) throw new Error('Adoption watchdog terminal archive collision.');
  } else {
    atomicWriteFile(filePath, content);
  }
  return { path: relative, sha256: hash(content), content_hash: contentHash };
}

export function validateAdoptionWatchTerminalRecoveryRefs(
  sessionDir: string,
  refs: unknown,
): string | null {
  if (!Array.isArray(refs) || refs.length > 16) return 'terminal recovery references are invalid or unbounded';
  const seen = new Set<string>();
  for (const raw of refs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'terminal recovery reference is invalid';
    const ref = raw as AdoptionWatchTerminalRecoveryRef;
    if (typeof ref.path !== 'string' || !/^watch-terminal-recovery\/[a-f0-9]{64}\.json$/.test(ref.path)
      || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-f0-9]{64}$/.test(ref.content_hash)) {
      return 'terminal recovery reference fields are invalid';
    }
    if (seen.has(ref.path) || path.basename(ref.path) !== `${ref.content_hash}.json`) {
      return 'terminal recovery reference is duplicated or not content-addressed';
    }
    seen.add(ref.path);
    const filePath = path.join(sessionDir, ref.path);
    if (!fs.existsSync(filePath)) return 'terminal recovery archive is missing';
    const content = fs.readFileSync(filePath);
    if (hash(content) !== ref.sha256) return 'terminal recovery archive bytes are invalid';
    let artifact: AdoptionWatchTerminalRecoveryArtifact;
    try {
      artifact = JSON.parse(content.toString('utf8')) as AdoptionWatchTerminalRecoveryArtifact;
    } catch {
      return 'terminal recovery archive JSON is invalid';
    }
    const { content_hash: contentHash, ...payload } = artifact;
    if (contentHash !== ref.content_hash || contentHash !== hash(canonicalize(payload))
      || artifact.schema_version !== 1
      || !['missing-or-regressed-launch-record', 'executor-topology-evidence-changed'].includes(artifact.reason)
      || !Number.isFinite(Date.parse(artifact.archived_at))
      || !/^[a-f0-9]{64}$/.test(artifact.prior_evidence_hash)
      || !/^[a-f0-9]{64}$/.test(artifact.replacement_evidence_hash)
      || artifact.prior_state_hash !== artifact.prior_strategy_state?.state_hash
      || validateAdoptionWatchStrategyState(artifact.prior_strategy_state)
      || (artifact.reason === 'missing-or-regressed-launch-record'
        ? !adoptionWatchStrategyStateLaunched(artifact.prior_strategy_state)
        : artifact.prior_strategy_state.cursor !== 3 || artifact.prior_strategy_state.active
          || adoptionWatchStrategyStateLaunched(artifact.prior_strategy_state))) {
      return 'terminal recovery archive contract is invalid';
    }
  }
  return null;
}

export function adoptionWatchArchivedMaterialHashes(
  sessionDir: string,
  refs: AdoptionWatchTerminalRecoveryRef[],
): Set<string> {
  const validation = validateAdoptionWatchTerminalRecoveryRefs(sessionDir, refs);
  if (validation) throw new Error(validation);
  const materials = new Set<string>();
  for (const ref of refs) {
    const artifact = JSON.parse(fs.readFileSync(path.join(sessionDir, ref.path), 'utf8')) as AdoptionWatchTerminalRecoveryArtifact;
    for (const material of artifact.prior_strategy_state.history_base_checkpoint.used_material_hashes) materials.add(material);
    for (const entry of artifact.prior_strategy_state.history) materials.add(entry.material_hash);
  }
  return materials;
}
