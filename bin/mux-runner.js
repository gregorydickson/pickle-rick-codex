#!/usr/bin/env node
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { readManifest, updateTicketStatus } from '../lib/tickets.js';
import { runTicket } from './spawn-morty.js';

function parseFailureMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--on-failure='));
  if (!modeArg) return 'abort';
  const [, mode] = modeArg.split('=');
  if (!['abort', 'skip', 'retry-once'].includes(mode)) {
    throw new Error(`Invalid on-failure mode: ${mode}`);
  }
  return mode;
}

export async function runSequential(sessionDir, options = {}) {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const manifest = readManifest(sessionDir);
  const failureMode = options.onFailure || 'abort';
  const config = loadConfig();

  for (const ticket of manifest.tickets) {
    if (ticket.status === 'Done' || ticket.status === 'Skipped') continue;

    let attempts = 0;
    const maxAttempts = failureMode === 'retry-once' ? 2 : 1;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        await runTicket(sessionDir, ticket.id, options);
        ticket.status = 'Done';
        break;
      } catch (error) {
        if (attempts < maxAttempts) {
          continue;
        }
        if (failureMode === 'skip') {
          ticket.status = 'Skipped';
          updateTicketStatus(sessionDir, ticket.id, { status: 'Skipped', skipped_at: new Date().toISOString() });
          break;
        }
        manager.update(statePath, (state) => {
          state.active = false;
          state.last_exit_reason = 'error';
          appendHistory(state, 'failed', ticket.id);
          return state;
        });
        throw error;
      }
    }
  }

  manager.update(statePath, (state) => {
    state.active = false;
    state.current_ticket = null;
    state.step = 'complete';
    state.last_exit_reason = 'success';
    appendHistory(state, 'complete');
    return state;
  });

  logActivity({
    event: 'epic_completed',
    source: 'pickle',
    session: path.basename(sessionDir),
  }, { enabled: config.defaults.activity_logging });
}

async function main(argv) {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/mux-runner.js <session-dir> [--on-failure=abort|skip|retry-once]');
  }
  await runSequential(sessionDir, { onFailure: parseFailureMode(argv) });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
