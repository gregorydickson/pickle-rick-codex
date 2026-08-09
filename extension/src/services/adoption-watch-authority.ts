import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import {
  reconcileAdoptionWatchMaterialLedger,
  restoreAdoptionWatchMaterialLedger,
  validateAdoptionWatchMaterialMarker,
  type AdoptionWatchMaterialMarker,
} from './adoption-watch-material-ledger.js';
import { validateAdoptionWatchStrategyState, type AdoptionWatchStrategyState } from './adoption-watch-strategies.js';

const AUTHORITY_FILE = 'watch-strategy-authority.json';

export interface AdoptionWatchAuthority {
  schema_version: 1;
  session_id: string;
  strategy_state: AdoptionWatchStrategyState;
  executor_restart_action: unknown | null;
  ledger_count: number;
  ledger_root_hash: string;
  expected_material_hashes: string[];
  expected_markers: AdoptionWatchMaterialMarker[];
  updated_at: string;
  content_hash: string;
  ledger_repaired?: boolean;
  control_artifact_conflict?: boolean;
}

export interface AdoptionWatchAuthorityInspection {
  authority: AdoptionWatchAuthority | null;
  invalid_present: boolean;
  control_artifact_conflict: boolean;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function writeAdoptionWatchAuthority(
  sessionDir: string,
  strategyState: AdoptionWatchStrategyState,
  executorRestartAction: unknown | null,
  updatedAt: string,
): AdoptionWatchAuthority {
  const ledger = reconcileAdoptionWatchMaterialLedger(sessionDir);
  const payload = {
    schema_version: 1 as const, session_id: path.basename(sessionDir), strategy_state: strategyState,
    executor_restart_action: executorRestartAction, ledger_count: ledger.count,
    ledger_root_hash: ledger.root_hash, expected_material_hashes: [...ledger.markers.keys()].sort(),
    expected_markers: [...ledger.markers.values()].sort((left, right) => left.material_hash.localeCompare(right.material_hash)),
    updated_at: updatedAt,
  };
  const authority = { ...payload, content_hash: hash(payload) };
  atomicWriteJson(path.join(sessionDir, AUTHORITY_FILE), authority);
  return authority;
}

export function inspectAdoptionWatchAuthority(sessionDir: string): AdoptionWatchAuthorityInspection {
  const filePath = path.join(sessionDir, AUTHORITY_FILE);
  if (!fs.existsSync(filePath)) return { authority: null, invalid_present: false, control_artifact_conflict: false };
  const authority = readJsonFile<AdoptionWatchAuthority>(filePath, null);
  if (!authority) return { authority: null, invalid_present: true, control_artifact_conflict: true };
  const { content_hash: contentHash, ...payload } = authority;
  delete payload.ledger_repaired;
  delete payload.control_artifact_conflict;
  const expectedMaterials = Array.isArray(authority.expected_markers)
    ? authority.expected_markers.map((marker) => marker.material_hash).sort() : [];
  if (authority.schema_version !== 1 || authority.session_id !== path.basename(sessionDir)
    || validateAdoptionWatchStrategyState(authority.strategy_state)
    || !Number.isInteger(authority.ledger_count) || authority.ledger_count < 0
    || !/^[a-f0-9]{64}$/.test(authority.ledger_root_hash)
    || !Array.isArray(authority.expected_material_hashes)
    || authority.expected_material_hashes.some((material) => !/^[a-f0-9]{64}$/.test(material))
    || !Array.isArray(authority.expected_markers)
    || authority.expected_markers.some((marker) => !validateAdoptionWatchMaterialMarker(marker))
    || new Set(expectedMaterials).size !== expectedMaterials.length
    || authority.ledger_count !== expectedMaterials.length
    || JSON.stringify(authority.expected_material_hashes) !== JSON.stringify(expectedMaterials)
    || typeof authority.updated_at !== 'string' || !Number.isFinite(Date.parse(authority.updated_at))
    || contentHash !== hash(payload)) return { authority: null, invalid_present: true, control_artifact_conflict: true };
  const ledger = restoreAdoptionWatchMaterialLedger(sessionDir, authority.expected_markers);
  const authorityMarkers = new Map(authority.expected_markers.map((marker) => [marker.material_hash, marker]));
  const authorityRoot = reconcileAdoptionWatchMaterialLedgerFromMarkers(authorityMarkers);
  if (authority.ledger_root_hash !== authorityRoot) {
    return { authority: null, invalid_present: true, control_artifact_conflict: true };
  }
  const restored = { ...authority, ledger_repaired: ledger.repaired,
    control_artifact_conflict: ledger.integrity_conflict };
  return { authority: restored, invalid_present: false,
    control_artifact_conflict: ledger.integrity_conflict };
}

export function readAdoptionWatchAuthority(sessionDir: string): AdoptionWatchAuthority | null {
  return inspectAdoptionWatchAuthority(sessionDir).authority;
}

function reconcileAdoptionWatchMaterialLedgerFromMarkers(markers: Map<string, AdoptionWatchMaterialMarker>): string {
  const entries = [...markers.values()].sort((left, right) => left.material_hash.localeCompare(right.material_hash));
  return hash(entries.map((entry) => ({ material_hash: entry.material_hash, content_hash: entry.content_hash })));
}
