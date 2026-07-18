import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';

export const TICKET_TRANSACTION_SCHEMA_VERSION = 1;
export const TICKET_TRANSACTION_HISTORY_LIMIT = 20;

interface ReverseEntry {
  relative_path: string;
  existed: boolean;
  content: string | null;
}

export interface ActiveTicketTransaction {
  id: string;
  operation: string;
  prepared_at: string;
  reverse: ReverseEntry[];
}

interface TicketTransactionHistoryEntry {
  id: string;
  operation: string;
  status: 'committed' | 'rolled_back' | 'recovered';
  finished_at: string;
}

interface TicketTransactionLedger {
  schema_version: 1;
  active: ActiveTicketTransaction | null;
  history: TicketTransactionHistoryEntry[];
}

function ledgerPath(sessionDir: string): string {
  return path.join(sessionDir, 'ticket-transaction-ledger.json');
}

function lockPath(sessionDir: string): string {
  return `${ledgerPath(sessionDir)}.lock`;
}

function readLedger(sessionDir: string): TicketTransactionLedger {
  const parsed = readJsonFile<Partial<TicketTransactionLedger>>(ledgerPath(sessionDir), null);
  return {
    schema_version: TICKET_TRANSACTION_SCHEMA_VERSION,
    active: parsed?.active || null,
    history: Array.isArray(parsed?.history) ? parsed.history.slice(-TICKET_TRANSACTION_HISTORY_LIMIT) : [],
  };
}

function writeLedger(sessionDir: string, ledger: TicketTransactionLedger): void {
  atomicWriteJson(ledgerPath(sessionDir), {
    ...ledger,
    history: ledger.history.slice(-TICKET_TRANSACTION_HISTORY_LIMIT),
  });
}

function normalizeRelativePath(sessionDir: string, filePath: string): string {
  const relative = path.relative(sessionDir, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Ticket transaction path escapes the session: ${filePath}`);
  }
  return relative;
}

function acquireLock(sessionDir: string): number {
  ensureDir(sessionDir);
  const filePath = lockPath(sessionDir);
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  } catch (error) {
    let owner = 0;
    try { owner = Number(fs.readFileSync(filePath, 'utf8')); } catch { /* stale malformed lock */ }
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        throw new Error(`Ticket transaction is already active under pid ${owner}.`, { cause: error });
      } catch (ownerError) {
        if (ownerError instanceof Error && ownerError.message.startsWith('Ticket transaction is already active')) throw ownerError;
      }
    }
    fs.rmSync(filePath, { force: true });
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  }
}

function releaseLock(sessionDir: string, fd: number): void {
  try { fs.closeSync(fd); } catch { /* best effort */ }
  fs.rmSync(lockPath(sessionDir), { force: true });
}

function replayReverseEntries(sessionDir: string, reverse: ReverseEntry[]): void {
  for (const entry of reverse) {
    const filePath = path.resolve(sessionDir, entry.relative_path);
    normalizeRelativePath(sessionDir, filePath);
    if (entry.existed) {
      ensureDir(path.dirname(filePath));
      atomicWriteFile(filePath, entry.content || '');
    } else {
      fs.rmSync(filePath, { force: true });
      try { fs.rmdirSync(path.dirname(filePath)); } catch { /* retain non-empty ticket artifact directories */ }
    }
  }
}

function finish(
  sessionDir: string,
  ledger: TicketTransactionLedger,
  transaction: ActiveTicketTransaction,
  status: TicketTransactionHistoryEntry['status'],
): void {
  ledger.active = null;
  ledger.history.push({
    id: transaction.id,
    operation: transaction.operation,
    status,
    finished_at: new Date().toISOString(),
  });
  writeLedger(sessionDir, ledger);
}

function recoverWhileLocked(sessionDir: string): boolean {
  const ledger = readLedger(sessionDir);
  if (!ledger.active) return false;
  const active = ledger.active;
  replayReverseEntries(sessionDir, active.reverse);
  finish(sessionDir, ledger, active, 'recovered');
  return true;
}

export function recoverInterruptedTicketTransaction(sessionDir: string): boolean {
  const resolved = path.resolve(sessionDir);
  const fd = acquireLock(resolved);
  try {
    return recoverWhileLocked(resolved);
  } finally {
    releaseLock(resolved, fd);
  }
}

function prepareWhileLocked(
  sessionDir: string,
  operation: string,
  filePaths: string[],
): ActiveTicketTransaction {
  const resolved = path.resolve(sessionDir);
  const ledger = readLedger(resolved);
  if (ledger.active) throw new Error(`Interrupted ticket transaction ${ledger.active.id} must be recovered first.`);
  const transaction: ActiveTicketTransaction = {
    id: crypto.randomUUID(),
    operation,
    prepared_at: new Date().toISOString(),
    reverse: [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].sort().map((filePath) => ({
      relative_path: normalizeRelativePath(resolved, filePath),
      existed: fs.existsSync(filePath),
      content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null,
    })),
  };
  ledger.active = transaction;
  writeLedger(resolved, ledger);
  return transaction;
}

export function prepareTicketTransaction(
  sessionDir: string,
  operation: string,
  filePaths: string[],
): ActiveTicketTransaction {
  const resolved = path.resolve(sessionDir);
  const fd = acquireLock(resolved);
  try {
    recoverWhileLocked(resolved);
    return prepareWhileLocked(resolved, operation, filePaths);
  } finally {
    releaseLock(resolved, fd);
  }
}

export function runTicketTransaction<T>(
  sessionDir: string,
  operation: string,
  filePaths: string[],
  mutate: () => T,
): T {
  const resolved = path.resolve(sessionDir);
  const fd = acquireLock(resolved);
  try {
    recoverWhileLocked(resolved);
    const transaction = prepareWhileLocked(resolved, operation, filePaths);
    try {
      const result = mutate();
      const ledger = readLedger(resolved);
      finish(resolved, ledger, transaction, 'committed');
      return result;
    } catch (error) {
      replayReverseEntries(resolved, transaction.reverse);
      const ledger = readLedger(resolved);
      finish(resolved, ledger, transaction, 'rolled_back');
      throw error;
    }
  } finally {
    releaseLock(resolved, fd);
  }
}
