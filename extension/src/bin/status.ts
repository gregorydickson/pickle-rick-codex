#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatDuration } from '../services/pickle-utils.js';
import { readPipelineContract } from '../services/pipeline.js';
import { readPipelineState } from '../services/pipeline-state.js';
import { getRunStartEpoch, resolveSessionForCwd } from '../services/session.js';
import { loadCircuitState } from '../services/circuit-breaker.js';
import { StateManager } from '../services/state-manager.js';
import type { PersistedState } from '../services/state-manager.js';
import { getTicketById, summarizeTickets } from '../services/tickets.js';
import { normalizeVerificationCommands } from '../services/verification-env.js';
import type { PipelineContract, PipelineState, ParsedTicket, Ticket } from '../types/index.js';

interface PipelineMetadata {
  bootstrapPrd: string | null;
  bootstrapSource: string | null;
  currentPhaseLabel: string;
  completedPhases: number;
  phaseStatuses: Record<string, string>;
  phases: string[];
  target: string | null;
  task: string | null;
  totalPhases: number;
}

interface RenderStatusOptions {
  sessionDir?: string;
  last?: boolean;
}

function formatIterationLimit(maxIterations: unknown): string {
  return Number.isInteger(maxIterations) && (maxIterations as number) > 0 ? String(maxIterations) : 'unlimited';
}

function latestFailureReason(tickets: Ticket[]): string | null {
  const failed = tickets
    .filter((ticket) => Boolean(ticket.frontmatter?.failure_reason || ticket.failure_reason))
    .sort((left, right) =>
      String(right.frontmatter?.failed_at || right.failed_at || '').localeCompare(
        String(left.frontmatter?.failed_at || left.failed_at || ''),
      ),
    );
  return failed[0]?.frontmatter?.failure_reason || (failed[0]?.failure_reason as string | undefined) || null;
}

function ticketVerification(ticket: Ticket | ParsedTicket | null): string | null {
  if (!ticket) return null;
  const commands = normalizeVerificationCommands(ticket?.verification, { verify: ticket?.verify });
  if (commands.length > 0) return commands.join(' && ');
  return 'npm test';
}

function phaseProgressLabel(pipeline: PipelineMetadata): string {
  const currentStatus = pipeline.currentPhaseLabel === 'complete'
    ? null
    : pipeline.phaseStatuses[pipeline.currentPhaseLabel] || null;
  const countedPhases = pipeline.currentPhaseLabel !== 'complete' && currentStatus === 'running'
    ? pipeline.completedPhases + 1
    : pipeline.completedPhases;
  return `${pipeline.currentPhaseLabel} (${countedPhases} / ${pipeline.totalPhases})`;
}

function loadPipelineMetadata(
  sessionDir: string,
  state: PersistedState,
  manager: StateManager,
): PipelineMetadata | null {
  const hasPipelineFiles = fs.existsSync(path.join(sessionDir, 'pipeline.json'))
    || fs.existsSync(path.join(sessionDir, 'pipeline-state.json'));
  const shouldInspectPipeline = hasPipelineFiles || state.pipeline_mode === true || Array.isArray(state.pipeline_phases);
  if (!shouldInspectPipeline) {
    return null;
  }

  let contract: PipelineContract | null;
  let pipelineState: PipelineState | null = null;
  try {
    contract = readPipelineContract(sessionDir);
  } catch {
    contract = null;
  }

  if (contract) {
    try {
      pipelineState = readPipelineState(sessionDir, manager, contract);
    } catch {
      pipelineState = null;
    }
  }

  const phases: string[] = contract?.phases
    || (Array.isArray(state.pipeline_phases) ? (state.pipeline_phases as string[]) : []);
  if (phases.length === 0) {
    return null;
  }

  const phaseStatuses: Record<string, string> = pipelineState?.phase_statuses
    || Object.fromEntries(phases.map((phase) => [phase, phase === state.pipeline_phase ? 'running' : 'todo']));
  const completedPhases = phases.filter((phase) => phaseStatuses[phase] === 'done').length;
  const currentPhase = pipelineState?.current_phase ?? (state.pipeline_phase as string | null | undefined) ?? null;

  return {
    bootstrapPrd: contract?.bootstrap_prd ?? (state.pipeline_bootstrap_prd as string | null) ?? null,
    bootstrapSource: contract?.bootstrap_source ?? (state.pipeline_bootstrap_source as string | null) ?? null,
    currentPhaseLabel: currentPhase ?? 'complete',
    completedPhases: currentPhase == null ? phases.length : completedPhases,
    phaseStatuses,
    phases,
    target: contract?.target ?? (state.pipeline_target as string | null) ?? null,
    task: contract?.task ?? (state.pipeline_task as string | null) ?? null,
    totalPhases: contract?.phases?.length ?? (state.pipeline_total_phases as number) ?? phases.length,
  };
}

export async function renderStatus(cwd: string, options: RenderStatusOptions = {}): Promise<string> {
  const sessionDir = options.sessionDir || await resolveSessionForCwd(cwd, { last: options.last });
  if (!sessionDir) {
    return 'No active session for this directory.';
  }

  const manager = new StateManager();
  const state = manager.read(path.join(sessionDir, 'state.json'));
  const pipeline = loadPipelineMetadata(sessionDir, state, manager);
  const runNotStarted = state.active === false && state.last_exit_reason == null
    && state.run_started_at == null && state.run_start_time_epoch == null;
  const elapsed = runNotStarted
    ? 0
    : Math.max(0, Math.floor(Date.now() / 1000) - getRunStartEpoch(state));
  const circuit = loadCircuitState(sessionDir);
  const summary = summarizeTickets(sessionDir);
  const currentTicket = state.current_ticket ? getTicketById(sessionDir, state.current_ticket as string) : null;
  const nextTicket = currentTicket || summary.runnable[0] || null;
  const currentLabel = currentTicket
    ? `${currentTicket.id} - ${currentTicket.title}`
    : ((state.current_ticket as string | undefined) || 'none');

  return [
    `Active: ${state.active ? 'Yes' : 'No'}`,
    `Tmux Mode: ${state.tmux_mode ? 'Yes' : 'No'}`,
    `Step: ${(state.step as string | undefined) || 'unknown'}`,
    pipeline ? `Pipeline Phase: ${phaseProgressLabel(pipeline)}` : null,
    pipeline ? `Pipeline Phases: ${pipeline.phases.map((phase) => `${phase}=${pipeline.phaseStatuses[phase] || 'todo'}`).join(' | ')}` : null,
    pipeline?.bootstrapSource ? `Pipeline Bootstrap: ${pipeline.bootstrapSource}` : null,
    pipeline?.task ? `Pipeline Task: ${pipeline.task}` : null,
    pipeline?.bootstrapPrd ? `Pipeline PRD: ${pipeline.bootstrapPrd}` : null,
    pipeline?.target ? `Pipeline Target: ${pipeline.target}` : null,
    `Iteration: ${state.iteration} / ${formatIterationLimit(state.max_iterations)}`,
    `Ticket: ${currentLabel}`,
    `Tickets: queued ${summary.queued} | done ${summary.done} | blocked ${summary.blocked} | skipped ${summary.skipped}`,
    nextTicket ? `Next Verification: ${ticketVerification(nextTicket)}` : null,
    latestFailureReason(summary.tickets) ? `Last Failure: ${latestFailureReason(summary.tickets)}` : null,
    state.last_exit_reason ? `Last Exit: ${state.last_exit_reason as string}` : null,
    `Elapsed: ${formatDuration(elapsed)}`,
    `Session: ${path.basename(sessionDir)}`,
    `Circuit Breaker: ${circuit.state}`,
    circuit.state === 'CLOSED' ? null : `Circuit Reason: ${circuit.reason || 'n/a'}`,
  ].filter(Boolean).join('\n');
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log('Usage: node bin/status.js [--cwd DIR] [--last] [--session-dir DIR]');
    return;
  }

  let cwd = process.cwd();
  let sessionDir: string | undefined;
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
