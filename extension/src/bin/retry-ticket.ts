#!/usr/bin/env node
import path from 'node:path';
import { logActivity } from '../services/activity-logger.js';
import { loadConfig } from '../services/config.js';
import { resolveSessionForCwd } from '../services/session.js';
import { StateManager } from '../services/state-manager.js';
import { getTicketById, updateTicketStatus } from '../services/tickets.js';
import { resetCircuitBreaker } from '../services/circuit-breaker.js';
import { authorizeTicketRecoveryEpoch } from '../services/recovery-controller.js';
import { acquireSessionOperation } from '../services/session-operation.js';

async function main(argv: string[]): Promise<void> {
  let cwd = process.cwd();
  let sessionDir: string | undefined;
  let ticketId: string | undefined;

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

  const releaseOperation = acquireSessionOperation(
    resolved,
    `Cannot authorize retry while another session operation is running: ${resolved}`,
  );
  try {
    const manager = new StateManager();
    const statePath = path.join(resolved, 'state.json');
    const state = manager.read(statePath);
    if (state.active !== false) {
      throw new Error('Cannot authorize retry while the session is active. Cancel it first.');
    }
    const requestedTicket = ticketId || state.current_ticket;
    if (!requestedTicket) {
      throw new Error('No current ticket to retry.');
    }
    const ticket = getTicketById(resolved, requestedTicket as string);
    if (!ticket) {
      throw new Error(`Unknown ticket: ${requestedTicket as string}`);
    }
    const targetTicket = ticket.id;

    authorizeTicketRecoveryEpoch(resolved, targetTicket);
    resetCircuitBreaker(resolved, `operator authorized retry for ${targetTicket}`);

    updateTicketStatus(resolved, targetTicket, {
      status: 'Todo',
      retry_requested_at: new Date().toISOString(),
    });

    manager.update(statePath, (current) => {
      current.active = true;
      current.current_ticket = targetTicket;
      current.last_exit_reason = null;
      current.step = 'research';
      (current.history as unknown[]).push({
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
  } finally {
    releaseOperation();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
