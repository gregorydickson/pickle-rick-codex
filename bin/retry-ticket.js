#!/usr/bin/env node
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { resolveSessionForCwd } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { getTicketById, updateTicketStatus } from '../lib/tickets.js';

async function main(argv) {
  let cwd = process.cwd();
  let sessionDir;
  let ticketId;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--session-dir') {
      sessionDir = argv[index + 1];
      index += 1;
    } else if (arg === '--ticket') {
      ticketId = argv[index + 1];
      index += 1;
    }
  }

  const resolved = sessionDir || await resolveSessionForCwd(cwd, { last: true });
  if (!resolved) {
    throw new Error('No session found.');
  }

  const manager = new StateManager();
  const statePath = path.join(resolved, 'state.json');
  const state = manager.read(statePath);
  const targetTicket = ticketId || state.current_ticket;
  if (!targetTicket) {
    throw new Error('No current ticket to retry.');
  }
  if (!getTicketById(resolved, targetTicket)) {
    throw new Error(`Unknown ticket: ${targetTicket}`);
  }

  updateTicketStatus(resolved, targetTicket, {
    status: 'Todo',
    retry_requested_at: new Date().toISOString(),
  });

  manager.update(statePath, (current) => {
    current.active = true;
    current.current_ticket = targetTicket;
    current.last_exit_reason = null;
    current.step = 'research';
    current.history.push({
      step: 'retry',
      ticket: targetTicket,
      timestamp: new Date().toISOString(),
    });
    return current;
  });

  const config = loadConfig();
  logActivity({
    event: 'iteration_start',
    source: 'pickle',
    session: path.basename(resolved),
    ticket: targetTicket,
    step: 'retry',
  }, { enabled: config.defaults.activity_logging });
  console.log(`Retry requested for ${targetTicket}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
