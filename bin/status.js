#!/usr/bin/env node
import path from 'node:path';
import { formatDuration } from '../lib/pickle-utils.js';
import { getRunStartEpoch, resolveSessionForCwd } from '../lib/session.js';
import { loadCircuitState } from '../lib/circuit-breaker.js';
import { StateManager } from '../lib/state-manager.js';
import { getTicketById, summarizeTickets } from '../lib/tickets.js';

function formatIterationLimit(maxIterations) {
  return Number.isInteger(maxIterations) && maxIterations > 0 ? String(maxIterations) : 'unlimited';
}

function latestFailureReason(tickets) {
  const failed = tickets
    .filter((ticket) => Boolean(ticket.frontmatter?.failure_reason || ticket.failure_reason))
    .sort((left, right) =>
      String(right.frontmatter?.failed_at || right.failed_at || '').localeCompare(
        String(left.frontmatter?.failed_at || left.failed_at || ''),
      ),
    );
  return failed[0]?.frontmatter?.failure_reason || failed[0]?.failure_reason || null;
}

function ticketVerification(ticket) {
  if (!ticket) return null;
  if (typeof ticket.verify === 'string' && ticket.verify.trim()) return ticket.verify.trim();
  if (Array.isArray(ticket.verification) && ticket.verification.length > 0) {
    return ticket.verification.join(' && ');
  }
  return 'npm test';
}

export async function renderStatus(cwd, options = {}) {
  const sessionDir = options.sessionDir || await resolveSessionForCwd(cwd, { last: options.last });
  if (!sessionDir) {
    return 'No active session for this directory.';
  }

  const manager = new StateManager();
  const state = manager.read(path.join(sessionDir, 'state.json'));
  const runNotStarted = state.active === false && state.last_exit_reason == null
    && state.run_started_at == null && state.run_start_time_epoch == null;
  const elapsed = runNotStarted
    ? 0
    : Math.max(0, Math.floor(Date.now() / 1000) - getRunStartEpoch(state));
  const circuit = loadCircuitState(sessionDir);
  const summary = summarizeTickets(sessionDir);
  const currentTicket = state.current_ticket ? getTicketById(sessionDir, state.current_ticket) : null;
  const nextTicket = currentTicket || summary.runnable[0] || null;
  const currentLabel = currentTicket ? `${currentTicket.id} - ${currentTicket.title}` : (state.current_ticket || 'none');

  return [
    `Active: ${state.active ? 'Yes' : 'No'}`,
    `Tmux Mode: ${state.tmux_mode ? 'Yes' : 'No'}`,
    `Step: ${state.step || 'unknown'}`,
    `Iteration: ${state.iteration} / ${formatIterationLimit(state.max_iterations)}`,
    `Ticket: ${currentLabel}`,
    `Tickets: queued ${summary.queued} | done ${summary.done} | blocked ${summary.blocked} | skipped ${summary.skipped}`,
    nextTicket ? `Next Verification: ${ticketVerification(nextTicket)}` : null,
    latestFailureReason(summary.tickets) ? `Last Failure: ${latestFailureReason(summary.tickets)}` : null,
    state.last_exit_reason ? `Last Exit: ${state.last_exit_reason}` : null,
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
