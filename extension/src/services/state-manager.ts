import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_SCHEMA_VERSION,
  atomicWriteJson,
  backupFile,
  ensureDir,
  safeErrorMessage,
} from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
export const LOCK_RETRY_BACKOFF_BASE_MS = 50;
export const STALE_LOCK_THRESHOLD_MS = 30_000;
export const RUNTIME_STATE_SCHEMA_VERSION = 1;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function lockPath(statePath: string): string {
  return `${statePath}.lock`;
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

interface StructuredLockPayload {
  pid: number;
  ts: number;
}

function parseStructuredLockPayload(raw: string): StructuredLockPayload {
  const payload = JSON.parse(raw) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('legacy lock format');
  }
  const obj = payload as Record<string, unknown>;
  const pid = Number(obj.pid);
  const ts = Number(obj.ts);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts) || ts <= 0) {
    throw new Error('malformed lock payload');
  }
  return { pid, ts };
}

export class StateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  constructor(message: string) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  rollbackErrors: Error[];
  constructor(message: string, rollbackErrors: Error[] = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

export class SchemaVersionDeployDriftError extends StateError {
  readonly runtimeVersion: number;
  readonly sourceVersion: number | null;

  constructor(runtimeVersion: number, sourceVersion: number | null) {
    super(
      'SCHEMA_DEPLOY_DRIFT',
      `Runtime state schema ${runtimeVersion} does not match source schema ${sourceVersion}; rebuild/reinstall pickle-rick-codex.`,
    );
    this.name = 'SchemaVersionDeployDriftError';
    this.runtimeVersion = runtimeVersion;
    this.sourceVersion = sourceVersion;
  }
}

export class SchemaVersionAheadError extends StateError {
  readonly statePath: string;
  readonly writtenValue: number;
  readonly maxSupported: number;

  constructor(statePath: string, writtenValue: number, maxSupported: number) {
    super(
      'SCHEMA_MISMATCH',
      `State schema ${writtenValue} at ${statePath} is newer than supported ${maxSupported}.`,
    );
    this.name = 'SchemaVersionAheadError';
    this.statePath = statePath;
    this.writtenValue = writtenValue;
    this.maxSupported = maxSupported;
  }
}

export function assertSchemaVersionDeployParity(
  runtimeVersion = RUNTIME_STATE_SCHEMA_VERSION,
  sourceVersion: number | null = readDeployedSchemaVersion(),
): void {
  if (runtimeVersion !== sourceVersion || sourceVersion !== STATE_SCHEMA_VERSION) {
    throw new SchemaVersionDeployDriftError(runtimeVersion, sourceVersion);
  }
}

export function readDeployedSchemaVersion(
  manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'state-schema.json'),
): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return Number.isInteger(parsed.schema_version) ? Number(parsed.schema_version) : null;
  } catch {
    return null;
  }
}

function assertSchemaVersionWithinCeiling(
  statePath: string,
  state: PersistedState,
  maxSupported: number,
): void {
  const value = Number(state.schema_version);
  if (Number.isFinite(value) && value > maxSupported) {
    throw new SchemaVersionAheadError(statePath, value, maxSupported);
  }
}

/**
 * Shape of every JSON state blob persisted by StateManager. The index signature
 * keeps the loose runtime behaviour (callers freely read/mutate arbitrary keys)
 * while `schema_version` is typed for the schema guard.
 */
export interface PersistedState {
  schema_version?: number;
  [key: string]: unknown;
}

export type StateMutator = (state: PersistedState) => PersistedState | null | undefined;

export interface StateManagerOptions {
  schemaVersion?: number;
  retryBaseMs?: number;
  acquireTimeoutMs?: number;
  staleLockThresholdMs?: number;
}

interface ResolvedStateManagerOptions {
  schemaVersion: number;
  retryBaseMs: number;
  acquireTimeoutMs: number;
  staleLockThresholdMs: number;
}

export interface UpdateOptions {
  createDefault?: () => PersistedState;
}

export class StateManager {
  options: ResolvedStateManagerOptions;

  constructor(options: StateManagerOptions = {}) {
    assertSchemaVersionDeployParity();
    this.options = {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      retryBaseMs: LOCK_RETRY_BACKOFF_BASE_MS,
      acquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
      staleLockThresholdMs: STALE_LOCK_THRESHOLD_MS,
      ...options,
    };
  }

  acquireLock(statePath: string): void {
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

  tryStealStaleLock(filePath: string): boolean {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const payload = parseStructuredLockPayload(raw);
      const stale = Date.now() - payload.ts > this.options.staleLockThresholdMs;
      if (!stale) return false;
      if (processAlive(payload.pid)) return false;
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      try {
        const stats = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        const pid = Number(raw);
        if (raw && (!Number.isInteger(pid) || pid <= 0)) {
          fs.rmSync(filePath, { force: true });
          return true;
        }
        if (Date.now() - stats.mtimeMs <= this.options.staleLockThresholdMs) return false;
        if (Number.isInteger(pid) && processAlive(pid)) return false;
        fs.rmSync(filePath, { force: true });
        return true;
      } catch {
        return false;
      }
    }
  }

  releaseLock(statePath: string): void {
    fs.rmSync(lockPath(statePath), { force: true });
  }

  read(statePath: string): PersistedState {
    const recovered = readRecoverableJsonObject(statePath);
    if (recovered === null) {
      if (!fs.existsSync(statePath)) {
        throw new StateError('MISSING', `State file not found: ${statePath}`);
      }
      throw new StateError('CORRUPT', `State file must contain a JSON object: ${statePath}`);
    }

    const state = recovered as PersistedState;
    let schemaVersion = state.schema_version;
    if (schemaVersion === undefined) {
      schemaVersion = this.options.schemaVersion;
      state.schema_version = schemaVersion;
    }

    if (schemaVersion > this.options.schemaVersion) {
      throw new SchemaVersionAheadError(statePath, schemaVersion, this.options.schemaVersion);
    }

    return state;
  }

  readOrReinitialize(statePath: string, createDefault: () => PersistedState): PersistedState {
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

  update(statePath: string, mutator: StateMutator, options: UpdateOptions = {}): PersistedState {
    this.acquireLock(statePath);
    try {
      const state = options.createDefault
        ? this.readOrReinitialize(statePath, options.createDefault)
        : this.read(statePath);
      const result = mutator(state) ?? state;
      result.schema_version ??= this.options.schemaVersion;
      assertSchemaVersionWithinCeiling(statePath, result, this.options.schemaVersion);
      atomicWriteJson(statePath, result);
      return result;
    } finally {
      this.releaseLock(statePath);
    }
  }

  forceWrite(statePath: string, state: PersistedState): void {
    state.schema_version ??= this.options.schemaVersion;
    assertSchemaVersionWithinCeiling(statePath, state, this.options.schemaVersion);
    try {
      atomicWriteJson(statePath, state);
    } catch {
      // Best effort.
    }
  }

  transaction(filePaths: string[], mutator: (states: PersistedState[]) => PersistedState[] | null | undefined): PersistedState[] {
    const ordered = [...filePaths].sort();
    const locked: string[] = [];
    const original = new Map<string, string | null>();

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
      result.forEach((state, index) => {
        assertSchemaVersionWithinCeiling(ordered[index], state, this.options.schemaVersion);
      });
      for (let index = 0; index < ordered.length; index += 1) {
        atomicWriteJson(ordered[index], result[index]);
      }
      return result;
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const filePath of ordered) {
        const snapshot = original.get(filePath);
        try {
          if (snapshot === null) {
            fs.rmSync(filePath, { force: true });
          } else if (snapshot !== undefined) {
            fs.writeFileSync(filePath, snapshot);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError as Error);
        }
      }
      if (error instanceof SchemaVersionAheadError && rollbackErrors.length === 0) {
        throw error;
      }
      throw new TransactionError(safeErrorMessage(error), rollbackErrors);
    } finally {
      for (const filePath of locked.reverse()) {
        this.releaseLock(filePath);
      }
    }
  }
}
