#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupSession } from '../lib/setup-session.js';
import { ensureTmuxAvailable, getRuntimeRoot, runTmux, shellQuote } from '../lib/tmux.js';

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'retry-once';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

function usage() {
  return 'Usage: node bin/pickle-tmux.js [--resume [SESSION_DIR]] [--max-iterations N] [--max-time M] [--worker-timeout S] [--on-failure=abort|skip|retry-once] <task>';
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log(usage());
    return;
  }

  ensureTmuxAvailable();
  const onFailure = parseFailureMode(argv);
  const setupArgs = ['--tmux', '--command-template', 'pickle-tmux.md', ...argv.filter((arg) => !arg.startsWith('--on-failure='))];
  const { sessionDir, state } = await setupSession(setupArgs);
  const runtimeRoot = getRuntimeRoot();
  const sessionName = `pickle-${path.basename(sessionDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  runTmux(['new-session', '-d', '-s', sessionName, '-c', state.working_dir]);
  runTmux(['rename-window', '-t', `${sessionName}:0`, 'runner']);

  const runnerCommand = [
    'node',
    shellQuote(path.join(runtimeRoot, 'bin', 'mux-runner.js')),
    shellQuote(sessionDir),
    `--on-failure=${onFailure}`,
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
  const monitorResult = spawnSync('bash', [path.join(runtimeRoot, 'bin', 'tmux-monitor.sh'), sessionName, sessionDir, 'pickle'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  if (monitorResult.status !== 0) {
    throw new Error(monitorResult.stderr || monitorResult.stdout || 'tmux monitor bootstrap failed');
  }

  console.log([
    'Pickle Rick tmux mode launched.',
    `Session: ${sessionName}`,
    `Attach: tmux attach -t ${sessionName}`,
    'Windows: Ctrl+B 0 -> runner | Ctrl+B 1 -> monitor',
    `Cancel: node ${path.join(runtimeRoot, 'bin', 'cancel.js')} --session-dir ${sessionDir}`,
    `State: ${path.join(sessionDir, 'state.json')}`,
    `Runner Log: ${path.join(sessionDir, 'mux-runner.log')}`,
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
