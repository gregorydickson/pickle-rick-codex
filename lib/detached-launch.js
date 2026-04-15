import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setupSession } from './setup-session.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote } from './tmux.js';

export async function launchDetachedLoop({
  setupArgs,
  loopConfig,
  onFailure = 'retry-once',
  banner = 'Detached loop launched.',
}) {
  ensureTmuxAvailable();
  const { sessionDir, state } = await setupSession(setupArgs);
  const runtimeRoot = getRuntimeRoot();
  const existingConfig = readJsonFile(path.join(sessionDir, 'loop_config.json'), {}) || {};
  const mergedConfig = Object.fromEntries(
    Object.entries({ ...existingConfig, ...loopConfig }).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
  atomicWriteJson(path.join(sessionDir, 'loop_config.json'), mergedConfig);
  const sessionName = `${loopConfig.mode}-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir]);
  runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

  const runnerBin = mergedConfig.mode === 'pickle' ? 'mux-runner.js' : 'loop-runner.js';
  const runnerArgs = mergedConfig.mode === 'pickle'
    ? `${shellQuote(sessionDir)} --on-failure=${onFailure}`
    : `${shellQuote(sessionDir)}`;
  const runnerCommand = [
    'node',
    shellQuote(path.join(runtimeRoot, 'bin', runnerBin)),
    runnerArgs,
    ';',
    'echo',
    shellQuote(''),
    ';',
    'echo',
    shellQuote('Runner finished.  Ctrl+B 1 -> monitor  |  Ctrl+B D -> detach'),
    ';',
    'read',
  ].join(' ');
  runTmux(['send-keys', '-t', `${sessionName}:0`, runnerCommand, 'Enter']);

  const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, mergedConfig.mode], {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  if (monitorResult.status !== 0) {
    throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
  }

  const runnerLogName = mergedConfig.mode === 'pickle' ? 'mux-runner.log' : 'loop-runner.log';
  return [
    banner,
    `Session: ${sessionName}`,
    `Attach: tmux attach -t ${sessionName}`,
    'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
    `State: ${path.join(sessionDir, 'state.json')}`,
    `Runner Log: ${path.join(sessionDir, runnerLogName)}`,
  ].join('\n');
}
