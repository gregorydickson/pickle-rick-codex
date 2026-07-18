// @tier: fast

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionForCwd } from '../services/session-map.js';
import { setupSession } from '../services/setup-session.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDataRoot(callback) {
  const previous = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = makeTempDir('pickle-setup-data-');
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = previous;
    }
  }
}

test('setupSession creates an isolated session with parsed overrides and tmux settings', async () => {
  await withDataRoot(async () => {
    const cwd = makeTempDir('pickle-setup-project-');
    const result = await setupSession([
      '--max-iterations', '7',
      '--max-time', '11',
      '--worker-timeout', '13',
      '--tmux',
      '--command-template', 'microverse.md',
      '--task', 'explicit setup task',
      'ignored positional text',
    ], { cwd, updateSessionMap: false });

    assert.equal(result.state.working_dir, fs.realpathSync(cwd));
    assert.equal(result.state.original_prompt, 'explicit setup task');
    assert.equal(result.state.max_iterations, 7);
    assert.equal(result.state.max_time_minutes, 11);
    assert.equal(result.state.worker_timeout_seconds, 13);
    assert.equal(result.state.tmux_mode, true);
    assert.equal(result.state.active, false);
    assert.equal(result.state.command_template, 'microverse.md');
    assert.equal(getSessionForCwd(fs.realpathSync(cwd)), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.sessionDir, 'state.json'), 'utf8')), result.state);
  });
});

test('setupSession resumes an explicit session, applies only valid overrides, and restores all map aliases', async () => {
  await withDataRoot(async () => {
    const cwd = makeTempDir('pickle-setup-project-');
    const alias = makeTempDir('pickle-setup-alias-');
    const created = await setupSession(['positional', 'task'], { cwd, updateSessionMap: false });
    const statePath = path.join(created.sessionDir, 'state.json');
    const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    seeded.session_map_cwds = [fs.realpathSync(cwd), fs.realpathSync(alias)];
    fs.writeFileSync(statePath, `${JSON.stringify(seeded, null, 2)}\n`);

    const resumed = await setupSession([
      '--resume', created.sessionDir,
      '--max-iterations', '19',
      '--max-time', '23',
      '--worker-timeout', '29',
      '--tmux',
      '--command-template', 'pickle.md',
    ], { cwd });

    assert.equal(resumed.sessionDir, created.sessionDir);
    assert.equal(resumed.state.max_iterations, 19);
    assert.equal(resumed.state.max_time_minutes, 23);
    assert.equal(resumed.state.worker_timeout_seconds, 29);
    assert.equal(resumed.state.tmux_mode, true);
    assert.equal(resumed.state.active, false);
    assert.equal(resumed.state.command_template, 'pickle.md');
    assert.equal(getSessionForCwd(fs.realpathSync(cwd)), created.sessionDir);
    assert.equal(getSessionForCwd(fs.realpathSync(alias)), created.sessionDir);
  });
});

test('setupSession implicitly resumes the last session without replacing defaults with invalid numbers', async () => {
  await withDataRoot(async () => {
    const cwd = makeTempDir('pickle-setup-project-');
    const created = await setupSession(['last session task'], { cwd, updateSessionMap: false });
    const resumed = await setupSession([
      '--resume',
      '--max-iterations', 'not-a-number',
      '--max-time', '1.5',
      '--worker-timeout', 'also-invalid',
    ], { cwd, updateSessionMap: false });

    assert.equal(resumed.sessionDir, created.sessionDir);
    assert.equal(resumed.state.max_iterations, created.state.max_iterations);
    assert.equal(resumed.state.max_time_minutes, created.state.max_time_minutes);
    assert.equal(resumed.state.worker_timeout_seconds, created.state.worker_timeout_seconds);
  });
});

test('setupSession rejects unsafe templates, missing tasks, and missing implicit resume targets', async () => {
  await withDataRoot(async () => {
    const cwd = makeTempDir('pickle-setup-project-');
    await assert.rejects(
      setupSession(['--command-template', '../escape.md', '--task', 'unsafe'], { cwd }),
      /plain filename/,
    );
    await assert.rejects(setupSession([], { cwd }), /No task specified/);
    await assert.rejects(setupSession(['--resume'], { cwd }), /No session found to resume/);
  });
});
