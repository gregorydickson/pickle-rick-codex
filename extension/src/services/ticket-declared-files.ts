/**
 * M1 declared-files reader (codex adaptation of claude's `ticket-declared-files`).
 *
 * `readDeclaredFiles(sessionDir, ticketId)` resolves a ticket's declared/owned
 * output files by unioning its `output_artifacts`, `proof_corpus`, and
 * `freeze_contract.artifact_path` fields into a de-duplicated, first-seen-order
 * set. It reads the materialized ticket markdown frontmatter (where these fields
 * are stored as JSON-encoded strings) and falls back to the refinement manifest.
 *
 * Consumed by the completion-evidence oracle's declared-file-touch pass. It only
 * depends on `pickle-utils` + node builtins (never `tickets.ts`) so the oracle →
 * declared-files → tickets import chain cannot cycle. Never throws: missing,
 * empty, or absent declarations (and a nonexistent ticket id) yield `[]`.
 */

import path from 'node:path';
import { listTicketFiles, parseTicketFile, readJsonFile, slugify } from './pickle-utils.js';
import type { RefinementManifest } from '../types/index.js';

function normalizeTicketId(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return slugify(raw) || raw;
}

/** Parses a JSON-array/object string in place; leaves other values untouched. */
function coerceJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !(trimmed.startsWith('[') || trimmed.startsWith('{'))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toStringArray(value: unknown): string[] {
  const parsed = coerceJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function freezeArtifactPath(value: unknown): string {
  const parsed = coerceJson(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const artifact = (parsed as Record<string, unknown>).artifact_path;
    if (typeof artifact === 'string' && artifact.trim().length > 0) {
      return artifact.trim();
    }
  }
  return '';
}

type DeclaredSource = Record<string, unknown>;

function findTicketSource(sessionDir: string, ticketId: string): DeclaredSource | null {
  const targetId = normalizeTicketId(ticketId);
  if (!targetId) return null;

  try {
    for (const filePath of listTicketFiles(sessionDir)) {
      const ticket = parseTicketFile(filePath);
      if (!ticket) continue;
      const candidateId = normalizeTicketId(ticket.id ?? path.basename(path.dirname(filePath)));
      if (candidateId === targetId) {
        return ticket.frontmatter;
      }
    }
  } catch {
    /* fall through to the manifest */
  }

  try {
    const manifest = readJsonFile<RefinementManifest>(path.join(sessionDir, 'refinement_manifest.json'), null);
    const tickets = Array.isArray(manifest?.tickets) ? manifest!.tickets : [];
    for (const ticket of tickets) {
      if (normalizeTicketId(ticket?.id) === targetId) {
        return ticket as DeclaredSource;
      }
    }
  } catch {
    /* no manifest available */
  }

  return null;
}

export function readDeclaredFiles(sessionDir: string, ticketId: string): string[] {
  const source = findTicketSource(sessionDir, ticketId);
  if (!source) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const normalized = raw.startsWith('./') ? raw.slice(2) : raw;
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const candidate of toStringArray(source.output_artifacts)) add(candidate);
  for (const candidate of toStringArray(source.proof_corpus)) add(candidate);
  const freeze = freezeArtifactPath(source.freeze_contract);
  if (freeze) add(freeze);

  return out;
}
