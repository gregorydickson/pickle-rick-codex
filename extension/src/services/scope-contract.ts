import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { resolveTicketScope, type ScopeVerdict } from './execution-gate.js';
import type { Ticket } from '../types/index.js';

export const SCOPE_SCHEMA_VERSION = 1;
export const SCOPE_ONE_HOP_MAX = 8;
const CALLER_SCAN_MAX = 512;

export interface PersistedScopeContract {
  schema_version: 1;
  ticket_id: string;
  review_base: string;
  declared_paths: string[];
  expanded_paths: string[];
  declaration_hash: string;
  generated_at: string;
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim();
  } catch {
    return '';
  }
}

function declarationHash(ticketId: string, reviewBase: string, paths: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([ticketId, reviewBase, paths])).digest('hex');
}

function scopePath(sessionDir: string): string {
  return path.join(sessionDir, 'scope.json');
}

function within(relativePath: string, allowed: string[]): boolean {
  return allowed.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

export function persistTicketScope(
  sessionDir: string,
  ticket: Ticket,
  ticketId: string,
  reviewBase: string,
): PersistedScopeContract {
  const resolved = resolveTicketScope(ticket);
  if (resolved.error) throw new Error(`scope-contract-invalid: ${resolved.error}`);
  if (!reviewBase) throw new Error('scope-contract-invalid: review base is absent');
  const contract: PersistedScopeContract = {
    schema_version: SCOPE_SCHEMA_VERSION,
    ticket_id: ticketId,
    review_base: reviewBase,
    declared_paths: resolved.allowedPaths,
    expanded_paths: [],
    declaration_hash: declarationHash(ticketId, reviewBase, resolved.allowedPaths),
    generated_at: new Date().toISOString(),
  };
  atomicWriteJson(scopePath(sessionDir), contract);
  return contract;
}

export function readFreshTicketScope(
  sessionDir: string,
  ticket: Ticket,
  ticketId: string,
  reviewBase: string,
): PersistedScopeContract {
  const raw = readJsonFile<Partial<PersistedScopeContract>>(scopePath(sessionDir), null);
  const resolved = resolveTicketScope(ticket);
  if (resolved.error || !raw || raw.schema_version !== SCOPE_SCHEMA_VERSION
      || raw.ticket_id !== ticketId || raw.review_base !== reviewBase
      || !Array.isArray(raw.declared_paths) || !Array.isArray(raw.expanded_paths)
      || raw.declaration_hash !== declarationHash(ticketId, reviewBase, resolved.allowedPaths)
      || JSON.stringify(raw.declared_paths) !== JSON.stringify(resolved.allowedPaths)) {
    throw new Error('scope-contract-stale: malformed scope.json or ticket/review-base drift');
  }
  return raw as PersistedScopeContract;
}

function exportedSymbols(workingDir: string, changedPath: string, reviewBase: string): string[] {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(changedPath)) return [];
  const diff = runGit(workingDir, ['diff', '--unified=0', reviewBase, '--', changedPath]);
  if (!diff) return [];
  let content: string;
  try { content = fs.readFileSync(path.join(workingDir, changedPath), 'utf8'); } catch { return []; }
  return [...content.matchAll(/\bexport\s+(?:(?:default|declare|abstract|async)\s+)*(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
}

export interface SignatureCallerGap {
  symbol: string;
  callers: string[];
}

export function detectSignatureCallerGaps(
  workingDir: string,
  contract: PersistedScopeContract,
  changedPaths: string[],
): { expansions: string[]; gaps: SignatureCallerGap[] } {
  const declared = [...contract.declared_paths, ...contract.expanded_paths];
  const symbols = new Set<string>();
  for (const changedPath of changedPaths.filter((entry) => within(entry, contract.declared_paths))) {
    for (const symbol of exportedSymbols(workingDir, changedPath, contract.review_base)) symbols.add(symbol);
  }
  if (symbols.size === 0) return { expansions: [], gaps: [] };
  const candidates = runGit(workingDir, ['ls-files']).split('\n')
    .filter((entry) => /\.(?:[cm]?[jt]sx?)$/.test(entry))
    .slice(0, CALLER_SCAN_MAX);
  const bySymbol = new Map<string, string[]>();
  for (const symbol of symbols) bySymbol.set(symbol, []);
  for (const candidate of candidates) {
    if (within(candidate, declared)) continue;
    let content: string;
    try { content = fs.readFileSync(path.join(workingDir, candidate), 'utf8'); } catch { continue; }
    for (const symbol of symbols) {
      if (new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)) {
        bySymbol.get(symbol)?.push(candidate);
      }
    }
  }
  const expansions = [...new Set([...bySymbol.values()].flat())].sort();
  const gaps = expansions.length > SCOPE_ONE_HOP_MAX
    ? [...bySymbol].filter(([, callers]) => callers.length).map(([symbol, callers]) => ({ symbol, callers }))
    : [];
  return { expansions: gaps.length ? [] : expansions, gaps };
}

export function evaluatePersistedTicketScope(
  sessionDir: string,
  ticket: Ticket,
  ticketId: string,
  reviewBase: string,
  workingDir: string,
  changedPaths: string[],
): ScopeVerdict {
  const contract = readFreshTicketScope(sessionDir, ticket, ticketId, reviewBase);
  const { expansions, gaps } = detectSignatureCallerGaps(workingDir, contract, changedPaths);
  if (gaps.length) {
    const violations = gaps.flatMap((gap) => gap.callers);
    return { ok: false, allowedPaths: contract.declared_paths, changedPaths, violations, reason: `signature-caller-gap: one-hop callers exceed cap ${SCOPE_ONE_HOP_MAX}: ${violations.join(', ')}` };
  }
  contract.expanded_paths = [...new Set([...contract.expanded_paths, ...expansions])].sort();
  atomicWriteJson(scopePath(sessionDir), contract);
  const allowedPaths = [...contract.declared_paths, ...contract.expanded_paths];
  const violations = changedPaths.filter((entry) => !within(entry, allowedPaths));
  return { ok: violations.length === 0, allowedPaths, changedPaths, violations, reason: violations.length ? `ticket changed paths outside persisted scope: ${violations.join(', ')}` : undefined };
}

/** Citadel audit for the latest worker scope. Absent is a legacy session; once
 * scope.json exists, malformed identity/base/declarations fail closed. */
export function auditPersistedScopeForCitadel(sessionDir: string, workingDir: string): string | null {
  if (!fs.existsSync(scopePath(sessionDir))) return null;
  const raw = readJsonFile<Partial<PersistedScopeContract>>(scopePath(sessionDir), null);
  const manifest = readJsonFile<{ tickets?: Ticket[] }>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const ticket = raw && Array.isArray(manifest?.tickets)
    ? manifest.tickets.find((entry) => entry.id.toLowerCase() === String(raw.ticket_id || '').toLowerCase())
    : null;
  if (!raw || !ticket || typeof raw.review_base !== 'string') return 'scope.json identity is malformed or no longer matches the refinement manifest';
  try {
    readFreshTicketScope(sessionDir, ticket, String(raw.ticket_id), raw.review_base);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!runGit(workingDir, ['rev-parse', '--verify', `${raw.review_base}^{commit}`])) return 'scope.json review base is not a reachable commit';
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', raw.review_base, 'HEAD'], {
      cwd: workingDir,
      stdio: 'ignore',
      timeout: 30_000,
    });
  } catch {
    return 'scope.json review base drifted from the reviewed release history';
  }
  return null;
}
