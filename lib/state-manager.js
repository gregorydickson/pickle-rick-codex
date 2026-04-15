import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION,
  atomicWriteJson,
  backupFile,
  ensureDir,
  safeErrorMessage,
} from './pickle-utils.js';

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
export const LOCK_RETRY_BACKOFF_BASE_MS = 50;
export const STALE_LOCK_THRESHOLD_MS = 30_000;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function lockPath(statePath) {
  return `${statePath}.lock`;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  constructor(message) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  constructor(message, rollbackErrors = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

export class StateManager {
  constructor(options = {}) {
    this.options = {
      schemaVersion: STATE_SCHEMA_VERSION,
      retryBaseMs: LOCK_RETRY_BACKOFF_BASE_MS,
      acquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
      staleLockThresholdMs: STALE_LOCK_THRESHOLD_MS,
      ...options,
    };
  }

  acquireLock(statePath) {
    ensureDir(path.dirname(statePath));
    const filePath = lockPath(statePath);
    const deadline = Date.now() + this.options.acquireTimeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        return;
      } catch {
        if (this.tryStealStaleLock(filePath)) {
          continue;
        }

        const backoff = Math.min(
          this.options.retryBaseMs * Math.pow(2, attempt),
          this.options.acquireTimeoutMs,
        );
        sleepSync(backoff);
        attempt += 1;
      }
    }

    throw new LockError(`Failed to acquire lock for ${statePath}`);
  }

  tryStealStaleLock(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const payload = JSON.parse(raw);
      const stale = Date.now() - Number(payload.ts || 0) > this.options.staleLockThresholdMs;
      if (!stale) return false;
      if (processAlive(Number(payload.pid || 0))) return false;
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      try {
        const stats = fs.statSync(filePath);
        if (Date.now() - stats.mtimeMs > this.options.staleLockThresholdMs) {
          fs.rmSync(filePath, { force: true });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
  }

  releaseLock(statePath) {
    fs.rmSync(lockPath(statePath), { force: true });
  }

  read(statePath) {
    if (!fs.existsSync(statePath)) {
      throw new StateError('MISSING', `State file not found: ${statePath}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      throw new StateError('CORRUPT', `Unreadable state file: ${safeErrorMessage(error)}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StateError('CORRUPT', `State file must contain a JSON object: ${statePath}`);
    }

    if (parsed.schema_version === undefined) {
      parsed.schema_version = this.options.schemaVersion;
      atomicWriteJson(statePath, parsed);
    }

    if (parsed.schema_version > this.options.schemaVersion) {
      throw new StateError(
        'SCHEMA_MISMATCH',
        `State schema ${parsed.schema_version} is newer than supported ${this.options.schemaVersion}`,
      );
    }

    return parsed;
  }

  readOrReinitialize(statePath, createDefault) {
    try {
      return this.read(statePath);
    } catch (error) {
      if (!(error instanceof StateError)) throw error;
      if (error.code === 'SCHEMA_MISMATCH') throw error;

      ensureDir(path.dirname(statePath));
      if (fs.existsSync(statePath)) {
        backupFile(statePath, 'corrupt');
      }

      const state = createDefault();
      state.schema_version ??= this.options.schemaVersion;
      atomicWriteJson(statePath, state);
      return state;
    }
  }

  update(statePath, mutator, options = {}) {
    this.acquireLock(statePath);
    try {
      const state = options.createDefault
        ? this.readOrReinitialize(statePath, options.createDefault)
        : this.read(statePath);
      const result = mutator(state) ?? state;
      result.schema_version ??= this.options.schemaVersion;
      atomicWriteJson(statePath, result);
      return result;
    } finally {
      this.releaseLock(statePath);
    }
  }

  forceWrite(statePath, state) {
    try {
      state.schema_version ??= this.options.schemaVersion;
      atomicWriteJson(statePath, state);
    } catch {
      // Best effort.
    }
  }

  transaction(filePaths, mutator) {
    const ordered = [...filePaths].sort();
    const locked = [];
    const original = new Map();

    try {
      for (const filePath of ordered) {
        this.acquireLock(filePath);
        locked.push(filePath);
        original.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
      }

      const states = ordered.map((filePath) => this.read(filePath));
      const result = mutator(states) ?? states;
      result.forEach((state) => {
        state.schema_version ??= this.options.schemaVersion;
      });
      for (let index = 0; index < ordered.length; index += 1) {
        atomicWriteJson(ordered[index], result[index]);
      }
      return result;
    } catch (error) {
      const rollbackErrors = [];
      for (const filePath of ordered) {
        const snapshot = original.get(filePath);
        try {
          if (snapshot === null) {
            fs.rmSync(filePath, { force: true });
          } else if (snapshot !== undefined) {
            fs.writeFileSync(filePath, snapshot);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      throw new TransactionError(safeErrorMessage(error), rollbackErrors);
    } finally {
      for (const filePath of locked.reverse()) {
        this.releaseLock(filePath);
      }
    }
  }
}
