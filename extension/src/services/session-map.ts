import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  getSessionMapPath,
  getSessionsRoot,
  readJsonFile,
} from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';

/**
 * A session-map entry value: maps a cwd string to the session directory path.
 * Persisted as `current_sessions.json` under the codex data root.
 */
type SessionMap = Record<string, string>;

/**
 * The minimal subset of a session state artifact consulted by the session map
 * (cwd aliases, liveness, and start time). Kept narrow so the session map does
 * not couple to the full {@link SessionState} shape.
 */
interface SessionMapEntryState {
  active?: boolean;
  started_at?: string;
  session_map_cwds?: string[];
  working_dir?: string;
}

/**
 * State consulted by {@link sessionStateMatchesCwd}. Only the cwd-alias fields
 * are read.
 */
interface CwdMatchableState {
  session_map_cwds?: string[];
  working_dir?: string;
}

interface StructuredLockPayload {
  pid: number;
  ts: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionMapLockPayload(): string {
  return JSON.stringify({ pid: process.pid, ts: Date.now() });
}

function parseStructuredLockPayload(raw: string): StructuredLockPayload {
  const payload = JSON.parse(raw) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('legacy lock format');
  }
  const record = payload as Record<string, unknown>;
  const pid = Number(record.pid);
  const ts = Number(record.ts);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts) || ts <= 0) {
    throw new Error('malformed lock payload');
  }
  return { pid, ts };
}

function clearStaleSessionMapLock(filePath: string, staleMs: number): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const payload = parseStructuredLockPayload(raw);
    const stale = Date.now() - payload.ts > staleMs;
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
      if (Date.now() - stats.mtimeMs <= staleMs) {
        return false;
      }
      if (Number.isInteger(pid) && processAlive(pid)) {
        return false;
      }
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function sessionStateMatchesCwd(state: CwdMatchableState, cwd: string): boolean {
  if (typeof cwd !== 'string' || !cwd) {
    return false;
  }

  const aliases: string[] = [];
  if (Array.isArray(state?.session_map_cwds)) {
    aliases.push(...state.session_map_cwds);
  }
  if (typeof state?.working_dir === 'string' && state.working_dir) {
    aliases.push(state.working_dir);
  }

  return aliases.includes(cwd);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withSessionMapLock<T>(callback: () => T | Promise<T>): Promise<T> {
  const filePath = `${getSessionMapPath()}.lock`;
  const deadline = Date.now() + 3_000;
  const staleMs = 5_000;
  let locked = false;
  let lastError: unknown = null;

  while (!locked) {
    try {
      clearStaleSessionMapLock(filePath, staleMs);
    } catch {
      // Lock missing.
    }

    try {
      const fd = fs.openSync(filePath, 'wx');
      fs.writeFileSync(fd, sessionMapLockPayload());
      fs.closeSync(fd);
      locked = true;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        throw new Error(`Failed to acquire session map lock: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      await sleep(50);
    }
  }

  if (!locked) {
    throw new Error(`Failed to acquire session map lock: ${lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')}`);
  }

  try {
    return await callback();
  } finally {
    if (locked) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

export async function updateSessionMap(cwd: string, sessionDir: string): Promise<void> {
  await withSessionMapLock(() => {
    const sessionMap = readJsonFile<SessionMap>(getSessionMapPath(), {}) ?? {};
    sessionMap[cwd] = sessionDir;
    atomicWriteJson(getSessionMapPath(), sessionMap);
  });
}

export async function removeSessionMapEntry(
  cwd: string,
  expectedSessionDir: string | null = null,
): Promise<void> {
  await withSessionMapLock(() => {
    const sessionMap = readJsonFile<SessionMap>(getSessionMapPath(), {}) ?? {};
    if (expectedSessionDir && sessionMap[cwd] && sessionMap[cwd] !== expectedSessionDir) {
      return;
    }
    delete sessionMap[cwd];
    atomicWriteJson(getSessionMapPath(), sessionMap);
  });
}

export function getSessionForCwd(cwd: string): string | null {
  const sessionMap = readJsonFile<SessionMap>(getSessionMapPath(), {}) ?? {};
  const sessionDir = sessionMap[cwd];
  return sessionDir && fs.existsSync(sessionDir) ? sessionDir : null;
}

export function listSessions(): Array<{ cwd: string; sessionDir: string }> {
  const sessionMap = readJsonFile<SessionMap>(getSessionMapPath(), {}) ?? {};
  return Object.entries(sessionMap).map(([cwd, sessionDir]) => ({ cwd, sessionDir }));
}

export async function pruneSessionMap(maxAgeDays: number = 7): Promise<void> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  await withSessionMapLock(() => {
    const sessionMap = readJsonFile<SessionMap>(getSessionMapPath(), {}) ?? {};
    let changed = false;

    for (const [cwd, sessionDir] of Object.entries(sessionMap)) {
      const statePath = path.join(sessionDir, 'state.json');
      try {
        const state = readRecoverableJsonObject(statePath) as SessionMapEntryState | null;
        if (!state) {
          delete sessionMap[cwd];
          changed = true;
          continue;
        }
        if (state.active === true) continue;
        const startedAt = state.started_at ?? '';
        const startedMs = Number.isFinite(new Date(startedAt).getTime())
          ? new Date(startedAt).getTime()
          : fs.statSync(sessionDir).mtimeMs;
        if (startedMs < cutoff) {
          delete sessionMap[cwd];
          changed = true;
        }
      } catch {
        delete sessionMap[cwd];
        changed = true;
      }
    }

    if (changed) {
      atomicWriteJson(getSessionMapPath(), sessionMap);
    }
  });
}

export function findLastSessionForCwd(cwd: string): string | null {
  let newest: string | null = null;
  let newestTime = 0;
  try {
    const entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(getSessionsRoot(), entry.name);
      const statePath = path.join(sessionDir, 'state.json');
      try {
        const state = readRecoverableJsonObject(statePath) as SessionMapEntryState | null;
        if (!state || !sessionStateMatchesCwd(state, cwd)) continue;
        const startedAt = state.started_at ?? '';
        const startedMs = Number.isFinite(new Date(startedAt).getTime())
          ? new Date(startedAt).getTime()
          : 0;
        if (startedMs > newestTime) {
          newest = sessionDir;
          newestTime = startedMs;
        }
      } catch {
        // Skip unreadable session state.
      }
    }
  } catch {
    return null;
  }
  return newest;
}
