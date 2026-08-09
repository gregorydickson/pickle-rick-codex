import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import {
  ADOPTION_WATCH_STRATEGY_IDS,
  adoptionWatchStrategyMaterialHash,
  type AdoptionWatchStrategyAttempt,
  type AdoptionWatchStrategyId,
} from './adoption-watch-strategies.js';

export interface AdoptionWatchMaterialMarker {
  schema_version: 1;
  epoch: number;
  epoch_seed: string;
  material_hash: string;
  strategy_id: AdoptionWatchStrategyId;
  evidence_hash: string;
  constraints_hash: string;
  first_started_at: string;
  content_hash: string;
}

interface MaterialLedgerManifest {
  schema_version: 1;
  entries: AdoptionWatchMaterialMarker[];
  count: number;
  root_hash: string;
  content_hash: string;
}

export interface AdoptionWatchMaterialLedger {
  markers: Map<string, AdoptionWatchMaterialMarker>;
  count: number;
  root_hash: string;
  repaired: boolean;
  integrity_conflict: boolean;
}

export function validateAdoptionWatchMaterialMarker(value: unknown): value is AdoptionWatchMaterialMarker {
  return validMarker(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function markerPayload(attempt: AdoptionWatchStrategyAttempt): Omit<AdoptionWatchMaterialMarker, 'content_hash'> {
  return {
    schema_version: 1, epoch: attempt.epoch, epoch_seed: attempt.epoch_seed,
    material_hash: attempt.material_hash, strategy_id: attempt.strategy_id,
    evidence_hash: attempt.evidence_hash, constraints_hash: attempt.constraints_hash,
    first_started_at: attempt.started_at,
  };
}

function markerContentHash(payload: Omit<AdoptionWatchMaterialMarker, 'content_hash'>): string {
  return hash(canonicalize(payload));
}

function ledgerDir(sessionDir: string): string {
  return path.join(sessionDir, 'watch-materials');
}

function manifestPath(sessionDir: string): string {
  return path.join(sessionDir, 'watch-material-ledger.json');
}

function validMarker(value: unknown, expectedName?: string): value is AdoptionWatchMaterialMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as AdoptionWatchMaterialMarker;
  const { content_hash: contentHash, ...payload } = marker;
  return marker.schema_version === 1
    && Number.isInteger(marker.epoch) && marker.epoch >= 1
    && /^[a-f0-9]{64}$/.test(marker.epoch_seed)
    && (!expectedName || `${marker.material_hash}.json` === expectedName)
    && /^[a-f0-9]{64}$/.test(marker.material_hash)
    && /^[a-f0-9]{64}$/.test(marker.evidence_hash)
    && /^[a-f0-9]{64}$/.test(marker.constraints_hash)
    && typeof marker.first_started_at === 'string' && Number.isFinite(Date.parse(marker.first_started_at))
    && ADOPTION_WATCH_STRATEGY_IDS.includes(marker.strategy_id)
    && marker.material_hash === adoptionWatchStrategyMaterialHash(marker.strategy_id, marker.evidence_hash)
    && contentHash === markerContentHash(payload);
}

function sortedEntries(markers: Map<string, AdoptionWatchMaterialMarker>): AdoptionWatchMaterialMarker[] {
  return [...markers.values()].sort((left, right) => left.material_hash.localeCompare(right.material_hash));
}

function ledgerRoot(entries: AdoptionWatchMaterialMarker[]): string {
  return hash(canonicalize(entries.map((entry) => ({ material_hash: entry.material_hash, content_hash: entry.content_hash }))));
}

function writeManifest(sessionDir: string, markers: Map<string, AdoptionWatchMaterialMarker>): void {
  const entries = sortedEntries(markers);
  const payload = { schema_version: 1 as const, entries, count: entries.length, root_hash: ledgerRoot(entries) };
  atomicWriteJson(manifestPath(sessionDir), { ...payload, content_hash: hash(canonicalize(payload)) });
}

function readMarkerFiles(sessionDir: string): Map<string, AdoptionWatchMaterialMarker> {
  const directory = ledgerDir(sessionDir);
  const markers = new Map<string, AdoptionWatchMaterialMarker>();
  if (!fs.existsSync(directory)) return markers;
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Adoption watchdog material ledger contains an invalid file.');
    const marker = readJsonFile<AdoptionWatchMaterialMarker>(path.join(directory, name), null);
    if (!validMarker(marker, name)) throw new Error('Adoption watchdog material marker contract is invalid.');
    markers.set(marker.material_hash, marker);
  }
  return markers;
}

function readManifest(sessionDir: string): MaterialLedgerManifest | null {
  const manifest = readJsonFile<MaterialLedgerManifest>(manifestPath(sessionDir), null);
  if (!manifest) return null;
  const { content_hash: contentHash, ...payload } = manifest;
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries)
    || manifest.entries.some((entry) => !validMarker(entry))
    || new Set(manifest.entries.map((entry) => entry.material_hash)).size !== manifest.entries.length
    || manifest.count !== manifest.entries.length || manifest.root_hash !== ledgerRoot(manifest.entries)
    || contentHash !== hash(canonicalize(payload))) return null;
  return manifest;
}

/** Reconciles either durable half from the other; callers surface `repaired` as typed recovery. */
export function reconcileAdoptionWatchMaterialLedger(sessionDir: string): AdoptionWatchMaterialLedger {
  const fileMarkers = readMarkerFiles(sessionDir);
  const manifestExists = fs.existsSync(manifestPath(sessionDir));
  const manifest = readManifest(sessionDir);
  const integrityConflict = manifestExists && !manifest;
  let repaired = manifestExists && !manifest;
  if (manifest) {
    for (const marker of manifest.entries) {
      const existing = fileMarkers.get(marker.material_hash);
      if (existing && existing.content_hash !== marker.content_hash) {
        throw new Error('Adoption watchdog material marker conflicts with its durable manifest.');
      }
      if (!existing) {
        fs.mkdirSync(ledgerDir(sessionDir), { recursive: true });
        atomicWriteJson(path.join(ledgerDir(sessionDir), `${marker.material_hash}.json`), marker);
        fileMarkers.set(marker.material_hash, marker);
        repaired = true;
      }
    }
  }
  if (!manifest || manifest.entries.length !== fileMarkers.size
    || manifest.root_hash !== ledgerRoot(sortedEntries(fileMarkers))
    || manifest.entries.some((entry) => !fileMarkers.has(entry.material_hash))) {
    if (fileMarkers.size > 0 || manifestExists) writeManifest(sessionDir, fileMarkers);
    repaired = repaired || fileMarkers.size > 0 || manifestExists;
  }
  const entries = sortedEntries(fileMarkers);
  return { markers: fileMarkers, count: entries.length, root_hash: ledgerRoot(entries), repaired,
    integrity_conflict: integrityConflict };
}

/** Restores exact durable reservations from the higher-authority strategy snapshot before ledger reconciliation. */
export function restoreAdoptionWatchMaterialLedger(
  sessionDir: string,
  expectedMarkers: AdoptionWatchMaterialMarker[],
): AdoptionWatchMaterialLedger {
  if (!Array.isArray(expectedMarkers) || expectedMarkers.some((marker) => !validMarker(marker))
    || new Set(expectedMarkers.map((marker) => marker.material_hash)).size !== expectedMarkers.length) {
    throw new Error('Adoption watchdog authority contains invalid material reservations.');
  }
  let repaired = false;
  fs.mkdirSync(ledgerDir(sessionDir), { recursive: true });
  for (const marker of expectedMarkers) {
    const filePath = path.join(ledgerDir(sessionDir), `${marker.material_hash}.json`);
    const existing = readJsonFile<AdoptionWatchMaterialMarker>(filePath, null);
    if (!validMarker(existing, `${marker.material_hash}.json`) || existing.content_hash !== marker.content_hash) {
      atomicWriteJson(filePath, marker);
      repaired = true;
    }
  }
  const ledger = reconcileAdoptionWatchMaterialLedger(sessionDir);
  return { ...ledger, repaired: repaired || ledger.repaired };
}

/** Reservation is durable before the active dispatch checkpoint is published. */
export function recordAdoptionWatchMaterialMarker(sessionDir: string, attempt: AdoptionWatchStrategyAttempt): void {
  const ledger = reconcileAdoptionWatchMaterialLedger(sessionDir);
  const existing = ledger.markers.get(attempt.material_hash);
  if (existing) {
    const payload = markerPayload(attempt);
    if (existing.content_hash !== markerContentHash(payload)) {
      throw new Error('Adoption watchdog material marker collision or tamper.');
    }
    return;
  }
  const payload = markerPayload(attempt);
  const marker = { ...payload, content_hash: markerContentHash(payload) };
  fs.mkdirSync(ledgerDir(sessionDir), { recursive: true });
  atomicWriteJson(path.join(ledgerDir(sessionDir), `${attempt.material_hash}.json`), marker);
  ledger.markers.set(attempt.material_hash, marker);
  writeManifest(sessionDir, ledger.markers);
}

export function readAdoptionWatchMaterialMarkers(sessionDir: string): Set<string> {
  return new Set(reconcileAdoptionWatchMaterialLedger(sessionDir).markers.keys());
}
