import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  getSessionMapPath,
  getSessionsRoot,
  readJsonFile,
} from './pickle-utils.js';

function processAlive(pid) {
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

function sessionMapLockPayload() {
  return JSON.stringify({ pid: process.pid, ts: Date.now() });
}

function clearStaleSessionMapLock(filePath, staleMs) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const payload = JSON.parse(raw);
    const stale = Date.now() - Number(payload.ts || 0) > staleMs;
    if (!stale) return false;
    if (processAlive(Number(payload.pid || 0))) return false;
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    try {
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs <= staleMs) {
        return false;
      }
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      const pid = Number(raw);
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

export function sessionStateMatchesCwd(state, cwd) {
  if (typeof cwd !== 'string' || !cwd) {
    return false;
  }

  const aliases = [];
  if (Array.isArray(state?.session_map_cwds)) {
    aliases.push(...state.session_map_cwds);
  }
  if (typeof state?.working_dir === 'string' && state.working_dir) {
    aliases.push(state.working_dir);
  }

  return aliases.includes(cwd);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withSessionMapLock(callback) {
  const filePath = `${getSessionMapPath()}.lock`;
  const deadline = Date.now() + 3_000;
  const staleMs = 5_000;
  let locked = false;
  let lastError = null;

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
        throw new Error(`Failed to acquire session map lock: ${error instanceof Error ? error.message : String(error)}`);
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

export async function updateSessionMap(cwd, sessionDir) {
  await withSessionMapLock(async () => {
    const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
    sessionMap[cwd] = sessionDir;
    atomicWriteJson(getSessionMapPath(), sessionMap);
  });
}

export async function removeSessionMapEntry(cwd, expectedSessionDir = null) {
  await withSessionMapLock(async () => {
    const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
    if (expectedSessionDir && sessionMap[cwd] && sessionMap[cwd] !== expectedSessionDir) {
      return;
    }
    delete sessionMap[cwd];
    atomicWriteJson(getSessionMapPath(), sessionMap);
  });
}

export function getSessionForCwd(cwd) {
  const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
  const sessionDir = sessionMap[cwd];
  return sessionDir && fs.existsSync(sessionDir) ? sessionDir : null;
}

export function listSessions() {
  const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
  return Object.entries(sessionMap).map(([cwd, sessionDir]) => ({ cwd, sessionDir }));
}

export async function pruneSessionMap(maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  await withSessionMapLock(async () => {
    const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
    let changed = false;

    for (const [cwd, sessionDir] of Object.entries(sessionMap)) {
      const statePath = path.join(sessionDir, 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.active === true) continue;
        const startedMs = Number.isFinite(new Date(state.started_at).getTime())
          ? new Date(state.started_at).getTime()
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

export function findLastSessionForCwd(cwd) {
  let newest = null;
  let newestTime = 0;
  try {
    const entries = fs.readdirSync(getSessionsRoot(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(getSessionsRoot(), entry.name);
      const statePath = path.join(sessionDir, 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!sessionStateMatchesCwd(state, cwd)) continue;
        const startedMs = Number.isFinite(new Date(state.started_at).getTime())
          ? new Date(state.started_at).getTime()
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
