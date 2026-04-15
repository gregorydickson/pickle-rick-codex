import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  getSessionMapPath,
  getSessionsRoot,
  readJsonFile,
} from './pickle-utils.js';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withSessionMapLock(callback) {
  const filePath = `${getSessionMapPath()}.lock`;
  const deadline = Date.now() + 3_000;
  const staleMs = 5_000;
  let locked = false;

  while (!locked) {
    try {
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs > staleMs) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Lock missing.
    }

    try {
      const fd = fs.openSync(filePath, 'wx');
      fs.closeSync(fd);
      locked = true;
    } catch (error) {
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(50);
    }
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

export async function removeSessionMapEntry(cwd) {
  await withSessionMapLock(async () => {
    const sessionMap = readJsonFile(getSessionMapPath(), {}) || {};
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
        if (state.working_dir !== cwd) continue;
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
