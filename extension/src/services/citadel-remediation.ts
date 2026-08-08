import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { readManifest, updateTicketStatus } from './tickets.js';

export function archiveCitadelRefusalAndResetTickets(sessionDir: string): string {
  const report = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'citadel-report.json'), null);
  if (!report) throw new Error('Citadel refusal did not persist a remediation report.');
  const affected = readManifest(sessionDir).tickets
    .filter((ticket) => String(ticket.status || '').trim().toLowerCase() === 'done');
  if (affected.length === 0) throw new Error('Citadel refusal has no completed ticket to remediate.');
  const archiveDir = ensureDir(path.join(sessionDir, 'citadel-remediation'));
  const archivePath = path.join(archiveDir, `citadel-report-${Date.now()}-${crypto.randomUUID()}.json`);
  atomicWriteJson(archivePath, report);
  const intentPath = path.join(sessionDir, 'citadel-remediation-pending.json');
  atomicWriteJson(intentPath, {
    schema_version: 1,
    archive_path: archivePath,
    ticket_ids: affected.map((ticket) => ticket.id),
    findings: report.findings,
    acceptance_criteria_checked: report.acceptance_criteria_checked,
  });
  for (const ticket of affected) {
    updateTicketStatus(sessionDir, ticket.id, {
      status: 'Todo',
      failure_kind: 'citadel_refusal',
      failure_reason: 'Mandatory Citadel release gate refused the candidate.',
    });
  }
  fs.rmSync(intentPath, { force: true });
  return archivePath;
}
