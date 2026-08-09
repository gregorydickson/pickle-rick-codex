import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHeadSha, getWorkingTreeFingerprint } from './git-utils.js';

function repositoryFingerprint(workingDir: string): string {
  const index = spawnSync('git', ['diff', '--cached', '--binary', '--no-ext-diff'], {
    cwd: workingDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (index.error || index.status !== 0) {
    throw new Error(`Could not fingerprint repository index: ${index.error?.message || index.stderr || index.status}`);
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    head: getHeadSha(workingDir),
    index: index.stdout,
    files: getWorkingTreeFingerprint(workingDir),
  })).digest('hex');
}

export interface DisposableWorktree {
  workingDir: string;
  checkpointHead: string;
  assertLiveUnchanged: () => void;
  cleanup: () => void;
}

export function createDisposableDetachedWorktree(
  liveWorkingDir: string,
  prefix: string = 'pickle-disposable-review-',
): DisposableWorktree {
  const checkpointHead = getHeadSha(liveWorkingDir);
  const liveFingerprint = repositoryFingerprint(liveWorkingDir);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workingDir = path.join(parent, 'repository');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', workingDir, checkpointHead], {
      cwd: liveWorkingDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    workingDir,
    checkpointHead,
    assertLiveUnchanged: () => {
      if (repositoryFingerprint(liveWorkingDir) !== liveFingerprint) {
        throw new Error('Disposable worker detected a mutation in the live repository; user state was preserved.');
      }
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        execFileSync('git', ['worktree', 'remove', '--force', workingDir], {
          cwd: liveWorkingDir,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 30_000,
        });
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  };
}
