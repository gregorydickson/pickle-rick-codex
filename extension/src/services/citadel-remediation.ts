import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasPipelineContract } from './pipeline.js';
import { resetPipelineForAutonomousRemediation } from './pipeline-state.js';
import { atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { readManifest, updateTicketStatus } from './tickets.js';

const PENDING_FILE = 'citadel-remediation-pending.json';
const CURRENT_FILE = 'citadel-remediation-current.json';

interface AffectedTicket {
  id: string;
  acceptance_criteria: string[];
}

export interface CitadelRemediationIntent {
  schema_version: 2;
  failure_kind: 'citadel_refused';
  archive_path: string;
  report_path: string;
  ticket_ids: string[];
  affected_tickets: AffectedTicket[];
  findings: unknown[];
  acceptance_criteria_checked: unknown[];
  summary: string;
  enqueued_at: string;
}

function findingSummary(findings: unknown[]): string {
  const rendered = findings.map((finding) => {
    if (typeof finding === 'string') return finding.trim();
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return String(finding || '').trim();
    const record = finding as Record<string, unknown>;
    return [record.title, record.evidence, record.recommendation]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' — ');
  }).filter(Boolean);
  return rendered.join('; ') || 'Citadel release gate refused the candidate.';
}

function isIntent(value: unknown): value is CitadelRemediationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === 2
    && record.failure_kind === 'citadel_refused'
    && typeof record.archive_path === 'string'
    && typeof record.report_path === 'string'
    && Array.isArray(record.ticket_ids)
    && record.ticket_ids.every((ticketId) => typeof ticketId === 'string' && ticketId.trim())
    && Array.isArray(record.affected_tickets)
    && record.affected_tickets.every((ticket) => (
      ticket && typeof ticket === 'object' && !Array.isArray(ticket)
      && typeof (ticket as Record<string, unknown>).id === 'string'
      && Array.isArray((ticket as Record<string, unknown>).acceptance_criteria)
    ))
    && Array.isArray(record.findings)
    && Array.isArray(record.acceptance_criteria_checked)
    && typeof record.summary === 'string'
    && typeof record.enqueued_at === 'string';
}

function normalizePendingIntent(
  sessionDir: string,
  pending: Record<string, unknown>,
): CitadelRemediationIntent | null {
  if (isIntent(pending)) return pending;
  if (pending.schema_version !== 1 || typeof pending.archive_path !== 'string'
    || !Array.isArray(pending.ticket_ids)
    || !pending.ticket_ids.every((ticketId) => typeof ticketId === 'string' && ticketId.trim())) {
    return null;
  }
  const archivedReport = readJsonFile<Record<string, unknown>>(pending.archive_path, null);
  if (!archivedReport) return null;
  const findings = Array.isArray(archivedReport.findings)
    ? structuredClone(archivedReport.findings)
    : Array.isArray(pending.findings) ? structuredClone(pending.findings) : [];
  const acceptanceCriteria = Array.isArray(archivedReport.acceptance_criteria_checked)
    ? structuredClone(archivedReport.acceptance_criteria_checked)
    : Array.isArray(pending.acceptance_criteria_checked)
      ? structuredClone(pending.acceptance_criteria_checked)
      : [];
  const tickets = readManifest(sessionDir).tickets;
  return {
    schema_version: 2,
    failure_kind: 'citadel_refused',
    archive_path: pending.archive_path,
    report_path: path.join(sessionDir, 'citadel-report.json'),
    ticket_ids: [...pending.ticket_ids],
    affected_tickets: pending.ticket_ids.map((ticketId) => {
      const ticket = tickets.find((candidate) => candidate.id === ticketId);
      return {
        id: ticketId,
        acceptance_criteria: Array.isArray(ticket?.acceptance_criteria) ? [...ticket.acceptance_criteria] : [],
      };
    }),
    findings,
    acceptance_criteria_checked: acceptanceCriteria,
    summary: typeof pending.summary === 'string' && pending.summary.trim()
      ? pending.summary
      : findingSummary(findings),
    enqueued_at: typeof pending.enqueued_at === 'string'
      ? pending.enqueued_at
      : new Date().toISOString(),
  };
}

function ticketRecoveryTask(intent: CitadelRemediationIntent, ticketId: string): string {
  const affected = intent.affected_tickets.find((ticket) => ticket.id === ticketId);
  return [
    'Remediate the preserved Citadel release refusal before seeking approval again.',
    `Archived Citadel report: ${intent.archive_path}`,
    `Original Citadel report: ${intent.report_path}`,
    `Exact actionable findings: ${JSON.stringify(intent.findings)}`,
    `Citadel acceptance criteria checked: ${JSON.stringify(intent.acceptance_criteria_checked)}`,
    `Affected ticket acceptance criteria: ${JSON.stringify(affected?.acceptance_criteria || [])}`,
  ].join('\n');
}

export function enqueueCitadelRemediation(sessionDir: string): string {
  const reportPath = path.join(sessionDir, 'citadel-report.json');
  const report = readJsonFile<Record<string, unknown>>(reportPath, null);
  if (!report) throw new Error('Citadel refusal did not persist a remediation report.');
  const affected = readManifest(sessionDir).tickets
    .filter((ticket) => String(ticket.status || '').trim().toLowerCase() === 'done')
    .map((ticket) => ({
      id: ticket.id,
      acceptance_criteria: Array.isArray(ticket.acceptance_criteria) ? [...ticket.acceptance_criteria] : [],
    }));
  if (affected.length === 0) throw new Error('Citadel refusal has no completed ticket to remediate.');

  const findings = Array.isArray(report.findings) ? structuredClone(report.findings) : [];
  const acceptanceCriteria = Array.isArray(report.acceptance_criteria_checked)
    ? structuredClone(report.acceptance_criteria_checked)
    : [];
  const archiveDir = ensureDir(path.join(sessionDir, 'citadel-remediation'));
  const archivePath = path.join(archiveDir, `citadel-report-${Date.now()}-${crypto.randomUUID()}.json`);
  atomicWriteJson(archivePath, report);
  const intent: CitadelRemediationIntent = {
    schema_version: 2,
    failure_kind: 'citadel_refused',
    archive_path: archivePath,
    report_path: reportPath,
    ticket_ids: affected.map((ticket) => ticket.id),
    affected_tickets: affected,
    findings,
    acceptance_criteria_checked: acceptanceCriteria,
    summary: findingSummary(findings),
    enqueued_at: new Date().toISOString(),
  };
  atomicWriteJson(path.join(sessionDir, PENDING_FILE), intent);
  reconcileCitadelRemediation(sessionDir);
  return archivePath;
}

export function reconcileCitadelRemediation(sessionDir: string): boolean {
  const pendingPath = path.join(sessionDir, PENDING_FILE);
  const rawPending = readJsonFile<Record<string, unknown>>(pendingPath, null);
  if (!rawPending) return false;
  const pending = normalizePendingIntent(sessionDir, rawPending);
  if (!pending) throw new Error('Citadel remediation intent is invalid.');
  if (!isIntent(rawPending)) atomicWriteJson(pendingPath, pending);

  for (const ticketId of pending.ticket_ids) {
    const recoveryTask = ticketRecoveryTask(pending, ticketId);
    updateTicketStatus(sessionDir, ticketId, {
      status: 'Todo',
      failure_kind: pending.failure_kind,
      failure_reason: pending.summary,
      recovery_task: recoveryTask,
      citadel_report: pending.archive_path,
      citadel_remediation: pending,
      citadel_remediation_enqueued_at: pending.enqueued_at,
    });
  }
  if (hasPipelineContract(sessionDir)) {
    resetPipelineForAutonomousRemediation(sessionDir, pending.summary);
  }
  // The applied record is durable handoff context. The pending file is only
  // cleared after ticket state and (when present) pipeline phase invalidation.
  atomicWriteJson(path.join(sessionDir, CURRENT_FILE), pending);
  fs.rmSync(pendingPath, { force: true });
  return true;
}

/** @deprecated Use enqueueCitadelRemediation. */
export const archiveCitadelRefusalAndResetTickets = enqueueCitadelRemediation;
