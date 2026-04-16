#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../lib/activity-logger.js';
import { assertCodexSucceeded, runCodexExec } from '../lib/codex.js';
import { loadConfig } from '../lib/config.js';
import { recordIteration } from '../lib/circuit-breaker.js';
import {
  applyPatch,
  classifyPatchApplyError,
  checkPatchApply,
  createPatchFromWorktree,
  createTicketWorktree,
  removeTicketWorktree,
  worktreeHasDiff,
  writePatchSummary,
} from '../lib/git-utils.js';
import { buildTicketPhasePrompt } from '../lib/prompts.js';
import { appendHistory } from '../lib/session.js';
import { StateManager } from '../lib/state-manager.js';
import { normalizeTicketId, readManifest, updateTicketStatus } from '../lib/tickets.js';

function splitVerificationCommands(ticket) {
  if (Array.isArray(ticket.verification)) return ticket.verification;
  if (typeof ticket.verify === 'string' && ticket.verify.trim()) {
    return ticket.verify.split('&&').map((item) => item.trim()).filter(Boolean);
  }
  return ['npm test'];
}

function runShell(command, cwd, timeoutMs) {
  const result = spawnSync(process.env.SHELL || 'zsh', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Verification failed: ${command}`);
  }
}

function summarizePatchApplyError(errorText) {
  return String(errorText || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || 'git apply --check failed';
}

export async function runTicket(sessionDir, ticketId, options = {}) {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const manifest = readManifest(sessionDir);
  const normalizedTicketId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  const manifestTicket = manifest.tickets.find((ticket) => normalizeTicketId(ticket.id, ticket.id) === normalizedTicketId);
  if (!manifestTicket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }

  const { worktreeDir, baseSha } = createTicketWorktree({
    repoDir: state.working_dir,
    sessionDir,
    ticketId: normalizedTicketId,
  });

  const config = loadConfig();
  const phases = ['research', 'plan', 'implement', 'review', 'simplify'];
  updateTicketStatus(sessionDir, normalizedTicketId, { status: 'In Progress', started_at: new Date().toISOString() });

  try {
    for (const phase of phases) {
      manager.update(statePath, (current) => {
        current.current_ticket = normalizedTicketId;
        current.step = phase;
        current.iteration += 1;
        appendHistory(current, phase, normalizedTicketId);
        return current;
      });

      const result = runCodexExec({
        cwd: worktreeDir,
        prompt: buildTicketPhasePrompt({
          phase,
          ticket: manifestTicket,
          sessionDir,
          worktreeDir,
        }),
        timeoutMs: options.timeoutMs || config.defaults.worker_timeout_seconds * 1000,
        outputLastMessagePath: path.join(sessionDir, `${normalizedTicketId}.${phase}.last-message.txt`),
        addDirs: [sessionDir],
      });
      assertCodexSucceeded(result, `Ticket ${normalizedTicketId} failed in ${phase}`);
      recordIteration(sessionDir, manager.read(statePath));
    }

    for (const command of splitVerificationCommands(manifestTicket)) {
      runShell(command, worktreeDir, config.defaults.worker_timeout_seconds * 1000);
    }

    if (!worktreeHasDiff(worktreeDir, baseSha)) {
      updateTicketStatus(sessionDir, normalizedTicketId, { status: 'Done', completed_at: new Date().toISOString() });
      return { status: 'done', applied: false, reason: 'No diff generated.' };
    }

    const patchPath = path.join(sessionDir, `${normalizedTicketId}.patch`);
    createPatchFromWorktree(worktreeDir, baseSha, patchPath);
    const patchCheck = checkPatchApply(state.working_dir, patchPath);
    if (!patchCheck.ok) {
      const reason = classifyPatchApplyError(patchCheck.error);
      writePatchSummary(sessionDir, normalizedTicketId, patchPath, {
        applied: false,
        reason,
        error: patchCheck.error,
      });
      throw new Error(
        `Patch for ${normalizedTicketId} could not be applied safely to ${state.working_dir}: ${summarizePatchApplyError(patchCheck.error)}`,
      );
    }

    applyPatch(state.working_dir, patchPath);
    updateTicketStatus(sessionDir, normalizedTicketId, { status: 'Done', completed_at: new Date().toISOString() });
    manager.update(statePath, (current) => {
      current.step = 'done';
      appendHistory(current, 'done', normalizedTicketId);
      return current;
    });

    logActivity({
      event: 'ticket_completed',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket: normalizedTicketId,
    }, { enabled: config.defaults.activity_logging });

    return { status: 'done', applied: true, patchPath };
  } catch (error) {
    updateTicketStatus(sessionDir, normalizedTicketId, {
      status: 'Blocked',
      failed_at: new Date().toISOString(),
      failure_reason: error instanceof Error ? error.message : String(error),
    });
    recordIteration(sessionDir, manager.read(statePath), {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    removeTicketWorktree(worktreeDir);
  }
}

async function main(argv) {
  const [sessionDir, ticketId] = argv;
  if (!sessionDir || !ticketId) {
    throw new Error('Usage: node bin/spawn-morty.js <session-dir> <ticket-id>');
  }
  const result = await runTicket(sessionDir, ticketId);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
