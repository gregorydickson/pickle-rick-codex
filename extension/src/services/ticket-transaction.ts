import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';

export const TICKET_TRANSACTION_SCHEMA_VERSION = 1;
export const TICKET_TRANSACTION_HISTORY_LIMIT = 20;
export const TICKET_TRANSACTION_LOCK_TIMEOUT_MS = 5_000;
export const TICKET_TRANSACTION_LOCK_RETRY_MS = 50;

const lockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds: number): void {
  Atomics.wait(lockSleepBuffer, 0, 0, milliseconds);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  const deadline = Date.now() + TICKET_TRANSACTION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(filePath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, String(process.pid));
        fs.fsyncSync(fd);
        return fd;
      } catch (error) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        fs.rmSync(filePath, { force: true });
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }

    let owner = 0;
    let lockAgeMs = Number.POSITIVE_INFINITY;
    try {
      owner = Number(fs.readFileSync(filePath, 'utf8'));
      lockAgeMs = Date.now() - fs.statSync(filePath).mtimeMs;
    } catch { /* lock disappeared; retry creation */ }

    if (owner === process.pid) {
      throw new Error(`Ticket transaction attempted a nested lock under pid ${owner}.`);
    }
    if ((!Number.isInteger(owner) || owner <= 0) && lockAgeMs >= TICKET_TRANSACTION_LOCK_RETRY_MS) {
      fs.rmSync(filePath, { force: true });
      continue;
    }
    if (Number.isInteger(owner) && owner > 0 && !processAlive(owner)) {
      fs.rmSync(filePath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ticket transaction owned by pid ${owner || 'unknown'}.`);
    }
    sleepSync(TICKET_TRANSACTION_LOCK_RETRY_MS);
  }
}

function releaseLock(sessionDir: string, fd: number): void {
  try { fs.closeSync(fd); } catch { /* best effort */ }
  fs.rmSync(lockPath(sessionDir), { force: true });
}

function replayReverseEntries(
  sessionDir: string,
  reverse: ReverseEntry[],
  preparedAt: string,
): void {
  for (const entry of reverse) {
    const filePath = path.resolve(sessionDir, entry.relative_path);
    normalizeRelativePath(sessionDir, filePath);
    if (entry.existed) {
      ensureDir(path.dirname(filePath));
      if (filePath === path.join(path.resolve(sessionDir), 'state.json')) {
        const restored = JSON.parse(entry.content || '{}') as Record<string, unknown>;
        const preparedAtMs = Date.parse(preparedAt);
        new StateManager().update(filePath, (current) => {
          const cancellationAtMs = Date.parse(String(current.cancel_requested_at || ''));
          if (
            Number.isFinite(preparedAtMs)
            && Number.isFinite(cancellationAtMs)
            && cancellationAtMs >= preparedAtMs
          ) {
            restored.active = false;
            restored.last_exit_reason = 'cancelled';
            restored.cancel_requested_at = current.cancel_requested_at;
          }
          return restored;
        });
      } else {
        atomicWriteFile(filePath, entry.content || '');
      }
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
  replayReverseEntries(sessionDir, active.reverse, active.prepared_at);
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
  filePaths: string[] | (() => string[]),
  mutate: () => T,
): T {
  const resolved = path.resolve(sessionDir);
  const fd = acquireLock(resolved);
  try {
    recoverWhileLocked(resolved);
    const transaction = prepareWhileLocked(
      resolved,
      operation,
      typeof filePaths === 'function' ? filePaths() : filePaths,
    );
    try {
      const result = mutate();
      const ledger = readLedger(resolved);
      finish(resolved, ledger, transaction, 'committed');
      return result;
    } catch (error) {
      replayReverseEntries(resolved, transaction.reverse, transaction.prepared_at);
      const ledger = readLedger(resolved);
      finish(resolved, ledger, transaction, 'rolled_back');
      throw error;
    }
  } finally {
    releaseLock(resolved, fd);
  }
}
