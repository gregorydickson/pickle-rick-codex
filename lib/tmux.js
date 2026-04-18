import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function getRuntimeRoot() {
  return path.resolve(new URL('..', import.meta.url).pathname);
}

export function ensureTmuxAvailable() {
  const result = spawnSync('tmux', ['-V'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error('tmux is required. Install it with `brew install tmux` or your package manager.');
  }
  return (result.stdout || result.stderr || '').trim();
}

export function tmuxSessionExists(sessionName, options = {}) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  return result.status === 0;
}

export function clearTmuxSession(sessionName, options = {}) {
  if (!tmuxSessionExists(sessionName, options)) return false;
  runTmux(['kill-session', '-t', sessionName], options);
  return true;
}

export function runTmux(args, options = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `tmux ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}
