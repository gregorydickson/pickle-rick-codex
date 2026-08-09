import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { readPrdSeal } from './prd-seal.js';
import { normalizeTicketId } from './tickets.js';
import { recoverInterruptedTicketTransaction } from './ticket-transaction.js';
import { refinementAcceptancePath, type RefinementAcceptance } from './refinement-artifacts.js';
import { normalizeVerificationSteps, verificationStepIdentity } from './verification-env.js';
import type { RefinementManifest, VerificationStep } from '../types/index.js';

export const VERIFICATION_REPAIR_TRANSACTION_FILE = 'verification-contract-repair-transaction.json';

export interface SealedVerificationAuthorization {
  ticket_id: string;
  seal_semantic_hash: string;
  sealed_verification_sha256: string;
  authorized_steps: VerificationStep[];
  authorized_identity: string;
  authorization_kind: 'sealed-exact' | 'legacy-representation-reconstruction';
}

export interface VerificationRepairReceipt {
  schema_version: 1;
  ticket_id: string;
  seal_semantic_hash: string;
  sealed_verification_sha256: string;
  manifest_verification_sha256: string;
  authorized_identity: string;
  authorization_kind: SealedVerificationAuthorization['authorization_kind'];
  strategy_hash: string | null;
  repaired_at: string;
}

export interface VerificationRepairTransaction {
  schema_version: 1;
  status: 'prepared';
  ticket_id: string;
  manifest_before: RefinementManifest;
  repaired_manifest: RefinementManifest;
  receipt: VerificationRepairReceipt;
  acceptance_before?: RefinementAcceptance;
  repaired_acceptance?: RefinementAcceptance;
  prepared_at: string;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function rawVerification(ticket: Record<string, unknown>): unknown {
  return ticket.verification ?? ticket.verify;
}

function deterministicLegacyReconstruction(value: unknown): VerificationStep[] {
  const parsed = typeof value === 'string' && /^[{[]/.test(value.trim())
    ? (() => { try { return JSON.parse(value); } catch { return value; } })()
    : value;
  const source: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (Array.isArray((parsed as Record<string, unknown>).steps)
        ? (parsed as Record<string, unknown>).steps as unknown[]
        : Array.isArray((parsed as Record<string, unknown>).commands)
          ? (parsed as Record<string, unknown>).commands as unknown[]
          : null)
      : null;
  if (!source || source.length === 0) throw new Error('sealed verification has no deterministic representation-only reconstruction');
  return source.flatMap((entry) => {
    if (typeof entry === 'string') return normalizeVerificationSteps([entry]);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('sealed verification contains a non-command legacy entry');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.command === 'string' && record.command.trim()
      && Object.keys(record).every((key) => key === 'command')) {
      return normalizeVerificationSteps([record.command]);
    }
    return normalizeVerificationSteps([record]);
  });
}

function ticketVerificationGate(sealReleaseGates: unknown, ticketId: string): Record<string, unknown> | null {
  if (!sealReleaseGates || typeof sealReleaseGates !== 'object' || Array.isArray(sealReleaseGates)) return null;
  const rows = (sealReleaseGates as Record<string, unknown>).ticket_verification;
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && normalizeTicketId(String((entry as Record<string, unknown>).ticket_id || ''), '') === ticketId);
  if (matches.length !== 1) throw new Error(`sealed-verification-contract-invalid: expected exactly one gate for ${ticketId}`);
  return matches[0] as Record<string, unknown>;
}

export function resolveSealedVerificationAuthorization(
  sessionDir: string,
  ticketId: string,
): SealedVerificationAuthorization | null {
  if (!fs.existsSync(path.join(sessionDir, 'prd.lock.json'))) return null;
  const normalizedTicketId = normalizeTicketId(ticketId, ticketId);
  const seal = readPrdSeal(sessionDir);
  const gate = ticketVerificationGate(seal.release_gates, normalizedTicketId);
  if (!gate) return null;
  const sealed = rawVerification(gate);
  let steps: VerificationStep[];
  let kind: SealedVerificationAuthorization['authorization_kind'] = 'sealed-exact';
  try {
    steps = normalizeVerificationSteps(sealed);
  } catch {
    steps = deterministicLegacyReconstruction(sealed);
    kind = 'legacy-representation-reconstruction';
  }
  if (steps.length === 0) throw new Error(`sealed-verification-contract-invalid: ${normalizedTicketId} has no verifier`);
  return {
    ticket_id: normalizedTicketId,
    seal_semantic_hash: seal.semantic_hash,
    sealed_verification_sha256: sha256(canonicalize(sealed)),
    authorized_steps: steps,
    authorized_identity: verificationStepIdentity(steps),
    authorization_kind: kind,
  };
}

export function verificationRepairReceiptPath(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, 'verification-contract-repair-receipts', `${normalizeTicketId(ticketId, ticketId)}.json`);
}

export function buildVerificationRepairReceipt(
  authorization: SealedVerificationAuthorization,
  manifestVerification: unknown,
  strategyHash: string | null,
): VerificationRepairReceipt {
  return {
    schema_version: 1,
    ticket_id: authorization.ticket_id,
    seal_semantic_hash: authorization.seal_semantic_hash,
    sealed_verification_sha256: authorization.sealed_verification_sha256,
    manifest_verification_sha256: sha256(canonicalize(manifestVerification)),
    authorized_identity: authorization.authorized_identity,
    authorization_kind: authorization.authorization_kind,
    strategy_hash: strategyHash,
    repaired_at: new Date().toISOString(),
  };
}

function validateReceipt(
  receipt: VerificationRepairReceipt | null,
  authorization: SealedVerificationAuthorization,
  manifestVerification: unknown,
): boolean {
  const manifestIdentity = (() => {
    try {
      return verificationStepIdentity(normalizeVerificationSteps(manifestVerification));
    } catch {
      return null;
    }
  })();
  return Boolean(manifestIdentity === authorization.authorized_identity
    && receipt
    && receipt.schema_version === 1
    && receipt.ticket_id === authorization.ticket_id
    && receipt.seal_semantic_hash === authorization.seal_semantic_hash
    && receipt.sealed_verification_sha256 === authorization.sealed_verification_sha256
    && receipt.manifest_verification_sha256 === sha256(canonicalize(manifestVerification))
    && receipt.authorized_identity === authorization.authorized_identity
    && receipt.authorization_kind === authorization.authorization_kind
    && Number.isFinite(Date.parse(receipt.repaired_at)));
}

export function assertTicketVerificationBoundToSeal(
  sessionDir: string,
  ticketId: string,
  workingDir: string,
): VerificationStep[] {
  const rawManifest = readJsonFile<{ tickets?: Array<Record<string, unknown>> }>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const normalizedTicketId = normalizeTicketId(ticketId, ticketId);
  const ticket = rawManifest?.tickets?.find((entry) => normalizeTicketId(String(entry.id || ''), '') === normalizedTicketId);
  if (!ticket) throw new Error(`sealed-verification-manifest-ticket-missing: ${normalizedTicketId}`);
  const manifestVerification = rawVerification(ticket);
  const authorization = resolveSealedVerificationAuthorization(sessionDir, normalizedTicketId);
  const steps = normalizeVerificationSteps(manifestVerification, authorization ? {} : { cwd: workingDir });
  if (!authorization) return steps;
  if (verificationStepIdentity(steps) !== authorization.authorized_identity) {
    throw new Error(`sealed-verification-semantic-drift: ${normalizedTicketId}`);
  }
  if (sha256(canonicalize(manifestVerification)) === authorization.sealed_verification_sha256) return steps;
  const receipt = readJsonFile<VerificationRepairReceipt>(verificationRepairReceiptPath(sessionDir, normalizedTicketId), null);
  if (!validateReceipt(receipt, authorization, manifestVerification)) {
    throw new Error(`sealed-verification-receipt-missing-or-invalid: ${normalizedTicketId}`);
  }
  return steps;
}

export function assertAllTicketVerificationBoundToSeal(sessionDir: string, workingDir: string): void {
  const manifest = readJsonFile<{ tickets?: Array<Record<string, unknown>> }>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!Array.isArray(manifest?.tickets)) throw new Error('sealed-verification-manifest-invalid');
  for (const ticket of manifest.tickets) {
    assertTicketVerificationBoundToSeal(sessionDir, String(ticket.id || ''), workingDir);
  }
}

export function persistVerificationRepairReceipt(sessionDir: string, receipt: VerificationRepairReceipt): void {
  atomicWriteJson(verificationRepairReceiptPath(sessionDir, receipt.ticket_id), receipt);
}

export function reconcileVerificationRepairTransaction(sessionDir: string): 'completed' | 'rolled_back' | null {
  const transactionPath = path.join(sessionDir, VERIFICATION_REPAIR_TRANSACTION_FILE);
  const transaction = readJsonFile<VerificationRepairTransaction>(transactionPath, null);
  if (!transaction) return null;
  if (transaction.schema_version !== 1 || transaction.status !== 'prepared'
    || !transaction.ticket_id || !transaction.manifest_before || !transaction.repaired_manifest || !transaction.receipt) {
    throw new Error('verification-contract-repair-transaction-corrupt');
  }
  recoverInterruptedTicketTransaction(sessionDir);
  const authorization = resolveSealedVerificationAuthorization(sessionDir, transaction.ticket_id);
  if (!authorization) throw new Error('verification-contract-repair-seal-authorization-missing');
  const repairedTicket = transaction.repaired_manifest.tickets.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === transaction.ticket_id);
  if (!repairedTicket || !validateReceipt(transaction.receipt, authorization, repairedTicket.verification)) {
    throw new Error('verification-contract-repair-transaction-receipt-invalid');
  }
  const current = readJsonFile<RefinementManifest>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const acceptancePath = refinementAcceptancePath(sessionDir);
  const currentAcceptance = readJsonFile<RefinementAcceptance>(acceptancePath, null);
  const hasAcceptanceRebind = Boolean(transaction.acceptance_before || transaction.repaired_acceptance);
  if (hasAcceptanceRebind && (!transaction.acceptance_before || !transaction.repaired_acceptance)) {
    throw new Error('verification-contract-repair-transaction-acceptance-corrupt');
  }
  const currentTicket = current?.tickets?.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === transaction.ticket_id);
  if (currentTicket && validateReceipt(transaction.receipt, authorization, currentTicket.verification)) {
    if (transaction.repaired_acceptance
      && JSON.stringify(currentAcceptance) !== JSON.stringify(transaction.repaired_acceptance)) {
      throw new Error('verification-contract-repair-transaction-acceptance-drift');
    }
    persistVerificationRepairReceipt(sessionDir, transaction.receipt);
    fs.rmSync(transactionPath, { force: true });
    return 'completed';
  }
  atomicWriteJson(path.join(sessionDir, 'refinement_manifest.json'), transaction.manifest_before);
  if (transaction.acceptance_before) atomicWriteJson(acceptancePath, transaction.acceptance_before);
  fs.rmSync(transactionPath, { force: true });
  return 'rolled_back';
}
