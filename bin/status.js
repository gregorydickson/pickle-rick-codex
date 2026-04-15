#!/usr/bin/env node
import path from 'node:path';
import { formatDuration } from '../lib/pickle-utils.js';
import { resolveSessionForCwd } from '../lib/session.js';
import { loadCircuitState } from '../lib/circuit-breaker.js';
import { StateManager } from '../lib/state-manager.js';

export async function renderStatus(cwd, options = {}) {
  const sessionDir = options.sessionDir || await resolveSessionForCwd(cwd, { last: options.last });
  if (!sessionDir) {
    return 'No active session for this directory.';
  }

  const manager = new StateManager();
  const state = manager.read(path.join(sessionDir, 'state.json'));
  const elapsed = Math.floor(Date.now() / 1000) - Number(state.start_time_epoch || 0);
  const circuit = loadCircuitState(sessionDir);

  return [
    `Active: ${state.active ? 'Yes' : 'No'}`,
    `Tmux Mode: ${state.tmux_mode ? 'Yes' : 'No'}`,
    `Step: ${state.step || 'unknown'}`,
    `Iteration: ${state.iteration} / ${state.max_iterations}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Elapsed: ${formatDuration(elapsed)}`,
    `Session: ${path.basename(sessionDir)}`,
    `Circuit Breaker: ${circuit.state}`,
    circuit.state === 'CLOSED' ? null : `Circuit Reason: ${circuit.reason || 'n/a'}`,
  ].filter(Boolean).join('\n');
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node bin/status.js [--cwd DIR] [--last] [--session-dir DIR]');
    return;
  }

  let cwd = process.cwd();
  let sessionDir;
  let last = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--last') {
      last = true;
    } else if (arg === '--session-dir') {
      sessionDir = argv[index + 1];
      index += 1;
    }
  }

  console.log(await renderStatus(cwd, { last, sessionDir }));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
