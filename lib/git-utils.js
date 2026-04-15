import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ensureDir, slugify } from './pickle-utils.js';

function runGit(args, cwd, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 15_000,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

export function isGitRepo(cwd) {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true }) === 'true';
}

export function getRepoRoot(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true }) || null;
}

export function getHeadSha(cwd) {
  return runGit(['rev-parse', 'HEAD'], cwd, { allowFailure: true }) || '';
}

export function getWorkingTreeStatus(cwd) {
  return runGit(['status', '--porcelain'], cwd, { allowFailure: true }) || '';
}

export function createTicketWorktree({ repoDir, sessionDir, ticketId, baseRef = 'HEAD' }) {
  const baseSha = runGit(['rev-parse', baseRef], repoDir);
  const worktreeRoot = ensureDir(path.join(sessionDir, 'worktrees'));
  const worktreeDir = path.join(worktreeRoot, `${slugify(ticketId) || 'ticket'}-${baseSha.slice(0, 8)}`);
  runGit(['worktree', 'add', '--detach', worktreeDir, baseSha], repoDir);
  return { worktreeDir, baseSha };
}

export function removeTicketWorktree(worktreeDir) {
  const repoDir = getRepoRoot(worktreeDir) || worktreeDir;
  runGit(['worktree', 'remove', '--force', worktreeDir], repoDir, { allowFailure: true });
}

export function worktreeHasDiff(worktreeDir, baseSha) {
  const diff = runGit(['diff', '--stat', baseSha], worktreeDir, { allowFailure: true });
  return diff.length > 0;
}

export function createPatchFromWorktree(worktreeDir, baseSha, outputPath) {
  const patch = runGit(['diff', '--binary', baseSha], worktreeDir, { allowFailure: true });
  atomicWriteFile(outputPath, patch, { mode: 0o600 });
  return outputPath;
}

export function canApplyPatch(targetDir, patchPath) {
  try {
    runGit(['apply', '--check', '--3way', patchPath], targetDir);
    return true;
  } catch {
    return false;
  }
}

export function applyPatch(targetDir, patchPath) {
  runGit(['apply', '--3way', patchPath], targetDir);
}

export function writePatchSummary(sessionDir, ticketId, patchPath, details = {}) {
  const outputPath = path.join(sessionDir, `${slugify(ticketId) || 'ticket'}.patch.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ ticketId, patchPath, ...details }, null, 2));
  return outputPath;
}
