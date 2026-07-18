// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findLastSessionForCwd,
  getSessionForCwd,
  listSessions,
  pruneSessionMap,
  removeSessionMapEntry,
  sessionStateMatchesCwd,
  updateSessionMap,
  withSessionMapLock,
} from '../services/session-map.js';

const DEAD_PID = 99_999_999;
const OLD_DATE = '2020-01-01T00:00:00.000Z';
const RECENT_DATE = '2099-01-01T00:00:00.000Z';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

async function withDataRoot(callback) {
  const previous = process.env.PICKLE_DATA_ROOT;
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-map-contract-')));
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    await callback(dataRoot);
  } finally {
    if (previous === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previous;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('sessionStateMatchesCwd accepts declared aliases and rejects invalid inputs', () => {
  assert.equal(sessionStateMatchesCwd({}, ''), false);
  assert.equal(sessionStateMatchesCwd({}, null), false);
  assert.equal(sessionStateMatchesCwd({ working_dir: '/project' }, '/project'), true);
  assert.equal(sessionStateMatchesCwd({ session_map_cwds: ['/old', '/new'] }, '/old'), true);
  assert.equal(sessionStateMatchesCwd({ session_map_cwds: ['/old'], working_dir: '/new' }, '/other'), false);
});

test('withSessionMapLock serializes the callback and removes its lock', async () => {
  await withDataRoot(async (dataRoot) => {
    const lockPath = path.join(dataRoot, 'current_sessions.json.lock');
    const result = await withSessionMapLock(async () => {
      assert.equal(fs.existsSync(lockPath), true);
      const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(payload.pid, process.pid);
      assert.equal(Number.isFinite(payload.ts), true);
      return 'locked-result';
    });

    assert.equal(result, 'locked-result');
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('withSessionMapLock releases ownership when the callback throws', async () => {
  await withDataRoot(async (dataRoot) => {
    const lockPath = path.join(dataRoot, 'current_sessions.json.lock');
    await assert.rejects(
      () => withSessionMapLock(() => {
        throw new Error('callback failed');
      }),
      /callback failed/,
    );
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('withSessionMapLock waits for brief contention and then acquires ownership', async () => {
  await withDataRoot(async (dataRoot) => {
    const lockPath = path.join(dataRoot, 'current_sessions.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const release = setTimeout(() => fs.rmSync(lockPath, { force: true }), 10);
    try {
      assert.equal(await withSessionMapLock(() => 'acquired'), 'acquired');
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      clearTimeout(release);
    }
  });
});

test('session map lock reclaims stale, invalid-owner, and malformed locks', async () => {
  await withDataRoot(async (dataRoot) => {
    const lockPath = path.join(dataRoot, 'current_sessions.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, ts: Date.now() - 10_000 }));
    await updateSessionMap('/project-a', '/session-a');

    fs.writeFileSync(lockPath, String(DEAD_PID));
    const stale = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, stale, stale);
    await updateSessionMap('/project-b', '/session-b');

    fs.writeFileSync(lockPath, '0');
    fs.utimesSync(lockPath, stale, stale);
    await updateSessionMap('/project-c', '/session-c');

    fs.writeFileSync(lockPath, 'not-a-pid');
    await updateSessionMap('/project-d', '/session-d');

    assert.deepEqual(listSessions(), [
      { cwd: '/project-a', sessionDir: '/session-a' },
      { cwd: '/project-b', sessionDir: '/session-b' },
      { cwd: '/project-c', sessionDir: '/session-c' },
      { cwd: '/project-d', sessionDir: '/session-d' },
    ]);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('map mutation resolves existing sessions and guards replacement mappings', async () => {
  await withDataRoot(async (dataRoot) => {
    const project = '/project';
    const first = path.join(dataRoot, 'sessions', 'first');
    const second = path.join(dataRoot, 'sessions', 'second');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });

    assert.equal(getSessionForCwd(project), null);
    await updateSessionMap(project, first);
    assert.equal(getSessionForCwd(project), first);

    await updateSessionMap(project, second);
    await removeSessionMapEntry(project, first);
    assert.equal(getSessionForCwd(project), second);

    await removeSessionMapEntry(project, second);
    assert.equal(getSessionForCwd(project), null);
    assert.deepEqual(listSessions(), []);
  });
});

test('pruneSessionMap retains active, recoverable, and recent sessions only', async () => {
  await withDataRoot(async (dataRoot) => {
    const sessionsRoot = path.join(dataRoot, 'sessions');
    const entries = {
      '/active': path.join(sessionsRoot, 'active'),
      '/recovery': path.join(sessionsRoot, 'recovery'),
      '/recent': path.join(sessionsRoot, 'recent'),
      '/old': path.join(sessionsRoot, 'old'),
      '/fallback-old': path.join(sessionsRoot, 'fallback-old'),
      '/invalid': path.join(sessionsRoot, 'invalid'),
      '/missing': path.join(sessionsRoot, 'missing'),
    };
    writeJson(path.join(entries['/active'], 'state.json'), { active: true, started_at: OLD_DATE });
    writeJson(path.join(entries['/recovery'], 'state.json'), { recovery_required: true, started_at: OLD_DATE });
    writeJson(path.join(entries['/recent'], 'state.json'), { active: false, started_at: RECENT_DATE });
    writeJson(path.join(entries['/old'], 'state.json'), { active: false, started_at: OLD_DATE });
    writeJson(path.join(entries['/fallback-old'], 'state.json'), { active: false, started_at: 'invalid' });
    const oldMtime = new Date(OLD_DATE);
    fs.utimesSync(entries['/fallback-old'], oldMtime, oldMtime);
    writeJson(path.join(entries['/invalid'], 'state.json'), ['not-an-object']);
    writeJson(path.join(dataRoot, 'current_sessions.json'), entries);

    await pruneSessionMap(7);

    assert.deepEqual(Object.fromEntries(listSessions().map(({ cwd, sessionDir }) => [cwd, sessionDir])), {
      '/active': entries['/active'],
      '/recovery': entries['/recovery'],
      '/recent': entries['/recent'],
    });
  });
});

test('findLastSessionForCwd selects the newest matching alias and tolerates bad entries', async () => {
  await withDataRoot(async (dataRoot) => {
    assert.equal(findLastSessionForCwd('/project'), null);

    const sessionsRoot = path.join(dataRoot, 'sessions');
    writeJson(path.join(sessionsRoot, 'older', 'state.json'), {
      working_dir: '/project',
      started_at: '2025-01-01T00:00:00.000Z',
    });
    writeJson(path.join(sessionsRoot, 'newer', 'state.json'), {
      session_map_cwds: ['/project'],
      working_dir: '/renamed-project',
      started_at: '2026-01-01T00:00:00.000Z',
    });
    writeJson(path.join(sessionsRoot, 'other', 'state.json'), {
      working_dir: '/other',
      started_at: RECENT_DATE,
    });
    fs.mkdirSync(path.join(sessionsRoot, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, 'broken', 'state.json'), '{bad json');
    fs.writeFileSync(path.join(sessionsRoot, 'not-a-directory'), 'ignored');

    assert.equal(findLastSessionForCwd('/project'), path.join(sessionsRoot, 'newer'));
    assert.equal(findLastSessionForCwd('/absent'), null);
  });
});
