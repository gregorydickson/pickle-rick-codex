import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasPipelineContract } from './pipeline.js';
import { resetPipelineForAutonomousRemediation } from './pipeline-state.js';
import { atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { normalizeTicketScopePath, resolveTicketScope } from './execution-gate.js';
import { normalizeTicketId, readManifest, ticketDependencyIds, updateTicketStatus } from './tickets.js';
import type { Ticket } from '../types/index.js';

const PENDING_FILE = 'citadel-remediation-pending.json';
const CURRENT_FILE = 'citadel-remediation-current.json';
const ATTRIBUTION_BLOCKED_FILE = 'citadel-remediation-attribution-blocked.json';

export interface CitadelAttributionRepairIntent {
  schema_version: 2;
  failure_kind: 'citadel_attribution_repair_required';
  status: 'pending';
  archive_path: string;
  report_path: string;
  report_sha256: string;
  candidate_ticket_ids: string[];
  finding_candidates: FindingAttribution[];
  findings: unknown[];
  acceptance_criteria_checked: unknown[];
  reason: string;
  repair_task: string;
  scheduled_at: string;
}

export type CitadelRemediationEnqueueResult = {
  kind: 'remediation_enqueued';
  archive_path: string;
  ticket_ids: string[];
} | {
  kind: 'attribution_repair_scheduled';
  archive_path: string;
  repair_intent_path: string;
  candidate_ticket_ids: string[];
  reason: string;
};

interface TicketAttribution {
  ticket_ids: string[];
  value: string;
}

interface FindingAttribution {
  finding_index: number;
  ticket_ids: string[];
  criteria: TicketAttribution[];
  paths: TicketAttribution[];
  method: 'explicit_ticket' | 'criterion_and_path' | 'criterion' | 'path' | 'single_completed_ticket' | 'legacy';
}

interface AffectedTicket {
  id: string;
  acceptance_criteria: string[];
  role: 'direct' | 'dependent';
  depends_on: string[];
  finding_indexes: number[];
}

export interface CitadelRemediationIntent {
  schema_version: 3;
  failure_kind: 'citadel_refused';
  archive_path: string;
  report_path: string;
  direct_ticket_ids: string[];
  ticket_ids: string[];
  affected_tickets: AffectedTicket[];
  finding_attribution: FindingAttribution[];
  findings: unknown[];
  acceptance_criteria_checked: unknown[];
  summary: string;
  enqueued_at: string;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function normalizedTicketIds(values: unknown): string[] {
  return stringList(values).map((value) => normalizeTicketId(value, '')).filter(Boolean);
}

function ticketId(ticket: Ticket): string {
  return normalizeTicketId(ticket.id, ticket.id);
}

function completed(ticket: Ticket): boolean {
  return String(ticket.status || '').trim().toLowerCase() === 'done';
}

function pathTicketAttribution(value: string, tickets: Ticket[]): TicketAttribution | null {
  const normalized = normalizeTicketScopePath(value);
  if (!normalized) return null;
  const ticketIds = tickets.filter((ticket) => {
    const scope = resolveTicketScope(ticket);
    return !scope.error && scope.allowedPaths.some((allowed) => (
      normalized === allowed || normalized.startsWith(`${allowed}/`)
    ));
  }).map(ticketId);
  return { value: normalized, ticket_ids: [...new Set(ticketIds)] };
}

function criterionTicketAttribution(value: string, tickets: Ticket[]): TicketAttribution {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const withoutId = normalized.replace(/^[A-Za-z]+-[A-Za-z0-9-]+:\s*/, '');
  const criterionId = normalized.match(/^([A-Za-z]+-[A-Za-z0-9-]+)(?::|$)/)?.[1]?.toLowerCase() || '';
  const ticketIds = tickets.filter((ticket) => (ticket.acceptance_criteria || []).some((criterion) => {
    const candidate = criterion.replace(/\s+/g, ' ').trim();
    const candidateId = candidate.match(/^([A-Za-z]+-[A-Za-z0-9-]+)(?::|$)/)?.[1]?.toLowerCase() || '';
    return candidate === normalized || candidate === withoutId || Boolean(criterionId && candidateId === criterionId);
  })).map(ticketId);
  return { value: normalized, ticket_ids: [...new Set(ticketIds)] };
}

function intersection(left: string[], right: string[]): string[] {
  const rightIds = new Set(right);
  return left.filter((ticketIdValue) => rightIds.has(ticketIdValue));
}

function union(attributions: TicketAttribution[]): string[] {
  return [...new Set(attributions.flatMap((attribution) => attribution.ticket_ids))];
}

function actionableFindings(findings: unknown[]): Array<{ finding: Record<string, unknown>; index: number }> {
  return findings.flatMap((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return [];
    const record = finding as Record<string, unknown>;
    const severity = String(record.severity || '').trim().toLowerCase();
    return !severity || severity === 'critical' || severity === 'high' ? [{ finding: record, index }] : [];
  });
}

function directFindingAttribution(findings: unknown[], tickets: Ticket[]): FindingAttribution[] {
  const completedTickets = tickets.filter(completed);
  const knownIds = new Set(tickets.map(ticketId));
  const result: FindingAttribution[] = [];
  for (const { finding, index } of actionableFindings(findings)) {
    const explicitTicketIds = normalizedTicketIds(finding.ticket_ids);
    if (explicitTicketIds.some((id) => !knownIds.has(id))) {
      throw new Error(`finding ${index + 1} names an unknown ticket`);
    }
    const explicitCriteria = stringList(finding.acceptance_criteria);
    const findingText = [finding.title, finding.evidence, finding.recommendation]
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    const inferredCriteria = explicitCriteria.length > 0 ? [] : completedTickets.flatMap((ticket) => (
      (ticket.acceptance_criteria || []).filter((criterion) => findingText.includes(criterion))
    ));
    const criteria = [...new Set([...explicitCriteria, ...inferredCriteria])]
      .map((criterion) => criterionTicketAttribution(criterion, completedTickets));
    const findingPaths = [...new Set([
      ...stringList(finding.paths),
      ...(typeof finding.file === 'string' && finding.file.trim() ? [finding.file.trim()] : []),
    ])];
    const paths = findingPaths.map((findingPath) => pathTicketAttribution(findingPath, completedTickets));
    if (paths.some((attribution) => attribution === null)) {
      throw new Error(`finding ${index + 1} contains an invalid repository path`);
    }
    const normalizedPaths = paths as TicketAttribution[];
    if (criteria.some((attribution) => attribution.ticket_ids.length === 0)
      || normalizedPaths.some((attribution) => attribution.ticket_ids.length === 0)) {
      throw new Error(`finding ${index + 1} contains criterion/path evidence with no ticket owner`);
    }

    const criterionIds = union(criteria);
    const pathIds = union(normalizedPaths);
    let candidates: string[];
    let method: FindingAttribution['method'];
    if (explicitTicketIds.length > 0) {
      candidates = explicitTicketIds;
      method = 'explicit_ticket';
      const evidenceIds = [...criterionIds, ...pathIds];
      if (evidenceIds.some((id) => !explicitTicketIds.includes(id))) {
        throw new Error(`finding ${index + 1} attribution conflicts with its criterion/path owner`);
      }
    } else if (criterionIds.length > 0 && pathIds.length > 0) {
      candidates = intersection(criterionIds, pathIds);
      method = 'criterion_and_path';
    } else if (criterionIds.length > 0) {
      candidates = criterionIds;
      method = 'criterion';
    } else if (pathIds.length > 0) {
      candidates = pathIds;
      method = 'path';
    } else if (completedTickets.length === 1) {
      candidates = [ticketId(completedTickets[0])];
      method = 'single_completed_ticket';
    } else {
      candidates = [];
      method = 'path';
    }
    candidates = [...new Set(candidates)].filter((id) => completedTickets.some((ticket) => ticketId(ticket) === id));
    if (candidates.length === 0 || (candidates.length > 1 && explicitTicketIds.length === 0)) {
      throw new Error(`finding ${index + 1} cannot be attributed to exactly one completed ticket`);
    }
    result.push({ finding_index: index, ticket_ids: candidates, criteria, paths: normalizedPaths, method });
  }
  if (result.length === 0) throw new Error('Citadel refusal contains no actionable finding to attribute');
  return result;
}

function candidateFindingAttribution(findings: unknown[], tickets: Ticket[]): FindingAttribution[] {
  const completedTickets = tickets.filter(completed);
  const completedIds = completedTickets.map(ticketId);
  const knownIds = new Set(completedIds);
  const actionable = actionableFindings(findings);
  if (actionable.length === 0) {
    return [{ finding_index: 0, ticket_ids: completedIds, criteria: [], paths: [], method: 'legacy' }];
  }
  return actionable.map(({ finding, index }) => {
    const explicitIds = normalizedTicketIds(finding.ticket_ids).filter((id) => knownIds.has(id));
    const criteria = stringList(finding.acceptance_criteria)
      .map((criterion) => criterionTicketAttribution(criterion, completedTickets));
    const rawPaths = [...new Set([
      ...stringList(finding.paths),
      ...(typeof finding.file === 'string' && finding.file.trim() ? [finding.file.trim()] : []),
    ])];
    const paths = rawPaths
      .map((findingPath) => pathTicketAttribution(findingPath, completedTickets))
      .filter((entry): entry is TicketAttribution => entry !== null);
    const criterionIds = union(criteria);
    const pathIds = union(paths);
    let candidates = explicitIds;
    let method: FindingAttribution['method'] = explicitIds.length > 0 ? 'explicit_ticket' : 'legacy';
    if (candidates.length === 0 && criterionIds.length > 0 && pathIds.length > 0) {
      candidates = intersection(criterionIds, pathIds);
      if (candidates.length === 0) candidates = [...new Set([...criterionIds, ...pathIds])];
      method = 'criterion_and_path';
    } else if (candidates.length === 0 && criterionIds.length > 0) {
      candidates = criterionIds;
      method = 'criterion';
    } else if (candidates.length === 0 && pathIds.length > 0) {
      candidates = pathIds;
      method = 'path';
    }
    if (candidates.length === 0) candidates = completedIds;
    return { finding_index: index, ticket_ids: [...new Set(candidates)], criteria, paths, method };
  });
}

function reportSha256(report: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function validFindingAttribution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validEvidence = (items: unknown): boolean => Array.isArray(items) && items.every((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).value === 'string'
    && Array.isArray((item as Record<string, unknown>).ticket_ids)
    && ((item as Record<string, unknown>).ticket_ids as unknown[]).every((id) => typeof id === 'string' && id.trim())
  ));
  return Number.isInteger(record.finding_index)
    && Array.isArray(record.ticket_ids)
    && record.ticket_ids.every((id) => typeof id === 'string' && id.trim())
    && validEvidence(record.criteria)
    && validEvidence(record.paths)
    && ['explicit_ticket', 'criterion_and_path', 'criterion', 'path', 'single_completed_ticket', 'legacy'].includes(String(record.method));
}

function isAttributionRepairIntent(value: unknown): value is CitadelAttributionRepairIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === 2
    && record.failure_kind === 'citadel_attribution_repair_required'
    && record.status === 'pending'
    && typeof record.archive_path === 'string'
    && typeof record.report_path === 'string'
    && typeof record.report_sha256 === 'string'
    && Array.isArray(record.candidate_ticket_ids)
    && record.candidate_ticket_ids.every((id) => typeof id === 'string' && id.trim())
    && Array.isArray(record.finding_candidates)
    && record.finding_candidates.every(validFindingAttribution)
    && Array.isArray(record.findings)
    && Array.isArray(record.acceptance_criteria_checked)
    && typeof record.reason === 'string'
    && typeof record.repair_task === 'string'
    && typeof record.scheduled_at === 'string';
}

function attributionRepairPath(sessionDir: string): string {
  return path.join(sessionDir, ATTRIBUTION_BLOCKED_FILE);
}

export function reconcileCitadelAttributionRepair(sessionDir: string): CitadelAttributionRepairIntent | null {
  const repairPath = attributionRepairPath(sessionDir);
  const raw = readJsonFile<Record<string, unknown>>(repairPath, null);
  if (!raw) return null;
  if (isAttributionRepairIntent(raw)) {
    const archived = readJsonFile<Record<string, unknown>>(raw.archive_path, null);
    return archived && reportSha256(archived) === raw.report_sha256 ? raw : null;
  }
  if (raw.schema_version !== 1 || raw.failure_kind !== 'citadel_attribution_ambiguous'
    || typeof raw.archive_path !== 'string') return null;
  const report = readJsonFile<Record<string, unknown>>(raw.archive_path, null);
  if (!report) return null;
  const findings = Array.isArray(report.findings) ? structuredClone(report.findings) : [];
  const acceptanceCriteria = Array.isArray(report.acceptance_criteria_checked)
    ? structuredClone(report.acceptance_criteria_checked) : [];
  const findingCandidates = candidateFindingAttribution(findings, readManifest(sessionDir).tickets);
  const migrated: CitadelAttributionRepairIntent = {
    schema_version: 2,
    failure_kind: 'citadel_attribution_repair_required',
    status: 'pending',
    archive_path: raw.archive_path,
    report_path: typeof raw.report_path === 'string' ? raw.report_path : path.join(sessionDir, 'citadel-report.json'),
    report_sha256: reportSha256(report),
    candidate_ticket_ids: [...new Set(findingCandidates.flatMap((entry) => entry.ticket_ids))],
    finding_candidates: findingCandidates,
    findings,
    acceptance_criteria_checked: acceptanceCriteria,
    reason: typeof raw.reason === 'string' ? raw.reason : 'legacy Citadel attribution was ambiguous',
    repair_task: 'Attribute each preserved blocking finding to exactly one completed ticket using ticket IDs, acceptance criteria, and owned repository paths.',
    scheduled_at: typeof raw.recorded_at === 'string' ? raw.recorded_at : new Date().toISOString(),
  };
  atomicWriteJson(repairPath, migrated);
  return migrated;
}

function dependentTicketIds(tickets: Ticket[], directTicketIds: string[]): string[] {
  const affected = new Set(directTicketIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const ticket of tickets) {
      const id = ticketId(ticket);
      if (affected.has(id) || !completed(ticket)) continue;
      if (ticketDependencyIds(ticket).some((dependency) => affected.has(dependency))) {
        affected.add(id);
        changed = true;
      }
    }
  }
  return [...affected];
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
  return record.schema_version === 3
    && record.failure_kind === 'citadel_refused'
    && typeof record.archive_path === 'string'
    && typeof record.report_path === 'string'
    && Array.isArray(record.direct_ticket_ids)
    && record.direct_ticket_ids.every((ticketIdValue) => typeof ticketIdValue === 'string' && ticketIdValue.trim())
    && Array.isArray(record.ticket_ids)
    && record.ticket_ids.every((ticketId) => typeof ticketId === 'string' && ticketId.trim())
    && Array.isArray(record.affected_tickets)
    && record.affected_tickets.every((ticket) => (
      ticket && typeof ticket === 'object' && !Array.isArray(ticket)
      && typeof (ticket as Record<string, unknown>).id === 'string'
      && Array.isArray((ticket as Record<string, unknown>).acceptance_criteria)
      && ['direct', 'dependent'].includes(String((ticket as Record<string, unknown>).role))
      && Array.isArray((ticket as Record<string, unknown>).depends_on)
      && ((ticket as Record<string, unknown>).depends_on as unknown[]).every((entry) => typeof entry === 'string' && entry.trim())
      && Array.isArray((ticket as Record<string, unknown>).finding_indexes)
      && ((ticket as Record<string, unknown>).finding_indexes as unknown[]).every((entry) => Number.isInteger(entry) && Number(entry) >= 0)
    ))
    && Array.isArray(record.finding_attribution)
    && record.finding_attribution.every((attribution) => {
      if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) return false;
      const entry = attribution as Record<string, unknown>;
      const validTicketAttributions = (items: unknown): boolean => Array.isArray(items) && items.every((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const detail = item as Record<string, unknown>;
        return typeof detail.value === 'string' && detail.value.trim()
          && Array.isArray(detail.ticket_ids)
          && detail.ticket_ids.every((id) => typeof id === 'string' && id.trim());
      });
      return Number.isInteger(entry.finding_index) && Number(entry.finding_index) >= 0
        && Array.isArray(entry.ticket_ids)
        && entry.ticket_ids.every((id) => typeof id === 'string' && id.trim())
        && validTicketAttributions(entry.criteria)
        && validTicketAttributions(entry.paths)
        && ['explicit_ticket', 'criterion_and_path', 'criterion', 'path', 'single_completed_ticket', 'legacy'].includes(String(entry.method));
    })
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
  if (![1, 2].includes(Number(pending.schema_version)) || typeof pending.archive_path !== 'string'
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
  const legacyTicketIds = normalizedTicketIds(pending.ticket_ids);
  return {
    schema_version: 3,
    failure_kind: 'citadel_refused',
    archive_path: pending.archive_path,
    report_path: path.join(sessionDir, 'citadel-report.json'),
    direct_ticket_ids: legacyTicketIds,
    ticket_ids: legacyTicketIds,
    affected_tickets: legacyTicketIds.map((legacyTicketId) => {
      const ticket = tickets.find((candidate) => ticketId(candidate) === legacyTicketId);
      return {
        id: legacyTicketId,
        acceptance_criteria: Array.isArray(ticket?.acceptance_criteria) ? [...ticket.acceptance_criteria] : [],
        role: 'direct',
        depends_on: ticketDependencyIds(ticket),
        finding_indexes: findings.map((_finding, index) => index),
      };
    }),
    finding_attribution: findings.map((_finding, index) => ({
      finding_index: index,
      ticket_ids: legacyTicketIds,
      criteria: [],
      paths: [],
      method: 'legacy',
    })),
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
    `Exact finding/criterion/path attribution: ${JSON.stringify(intent.finding_attribution.filter((entry) => entry.ticket_ids.includes(ticketId)))}`,
    `Remediation role: ${affected?.role || 'direct'}; dependencies: ${JSON.stringify(affected?.depends_on || [])}`,
  ].join('\n');
}

export function enqueueCitadelRemediationResult(sessionDir: string): CitadelRemediationEnqueueResult {
  const reportPath = path.join(sessionDir, 'citadel-report.json');
  const report = readJsonFile<Record<string, unknown>>(reportPath, null);
  if (!report) throw new Error('Citadel refusal did not persist a remediation report.');
  const tickets = readManifest(sessionDir).tickets;
  const findings = Array.isArray(report.findings) ? structuredClone(report.findings) : [];
  const acceptanceCriteria = Array.isArray(report.acceptance_criteria_checked)
    ? structuredClone(report.acceptance_criteria_checked)
    : [];
  const reportIdentity = reportSha256(report);
  const existingRepair = reconcileCitadelAttributionRepair(sessionDir);
  if (existingRepair?.report_sha256 === reportIdentity) {
    return {
      kind: 'attribution_repair_scheduled',
      archive_path: existingRepair.archive_path,
      repair_intent_path: attributionRepairPath(sessionDir),
      candidate_ticket_ids: existingRepair.candidate_ticket_ids,
      reason: existingRepair.reason,
    };
  }
  const archiveDir = ensureDir(path.join(sessionDir, 'citadel-remediation'));
  const archivePath = path.join(archiveDir, `citadel-report-${Date.now()}-${crypto.randomUUID()}.json`);
  atomicWriteJson(archivePath, report);
  let findingAttribution: FindingAttribution[];
  try {
    findingAttribution = directFindingAttribution(findings, tickets);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const findingCandidates = candidateFindingAttribution(findings, tickets);
    const repairIntent: CitadelAttributionRepairIntent = {
      schema_version: 2,
      failure_kind: 'citadel_attribution_repair_required',
      status: 'pending',
      archive_path: archivePath,
      report_path: reportPath,
      report_sha256: reportIdentity,
      candidate_ticket_ids: [...new Set(findingCandidates.flatMap((entry) => entry.ticket_ids))],
      finding_candidates: findingCandidates,
      findings,
      acceptance_criteria_checked: acceptanceCriteria,
      reason,
      repair_task: 'Attribute each preserved blocking finding to exactly one completed ticket using ticket IDs, acceptance criteria, and owned repository paths.',
      scheduled_at: new Date().toISOString(),
    };
    atomicWriteJson(attributionRepairPath(sessionDir), repairIntent);
    return {
      kind: 'attribution_repair_scheduled',
      archive_path: archivePath,
      repair_intent_path: attributionRepairPath(sessionDir),
      candidate_ticket_ids: repairIntent.candidate_ticket_ids,
      reason,
    };
  }
  const directTicketIds = [...new Set(findingAttribution.flatMap((entry) => entry.ticket_ids))];
  const affectedTicketIds = dependentTicketIds(tickets, directTicketIds);
  const affected = affectedTicketIds.map((affectedTicketId) => {
    const ticket = tickets.find((candidate) => ticketId(candidate) === affectedTicketId)!;
    return {
      id: affectedTicketId,
      acceptance_criteria: Array.isArray(ticket.acceptance_criteria) ? [...ticket.acceptance_criteria] : [],
      role: directTicketIds.includes(affectedTicketId) ? 'direct' as const : 'dependent' as const,
      depends_on: ticketDependencyIds(ticket),
      finding_indexes: findingAttribution
        .filter((entry) => entry.ticket_ids.includes(affectedTicketId))
        .map((entry) => entry.finding_index),
    };
  });
  const intent: CitadelRemediationIntent = {
    schema_version: 3,
    failure_kind: 'citadel_refused',
    archive_path: archivePath,
    report_path: reportPath,
    direct_ticket_ids: directTicketIds,
    ticket_ids: affectedTicketIds,
    affected_tickets: affected,
    finding_attribution: findingAttribution,
    findings,
    acceptance_criteria_checked: acceptanceCriteria,
    summary: findingSummary(findings),
    enqueued_at: new Date().toISOString(),
  };
  fs.rmSync(path.join(sessionDir, ATTRIBUTION_BLOCKED_FILE), { force: true });
  atomicWriteJson(path.join(sessionDir, PENDING_FILE), intent);
  reconcileCitadelRemediation(sessionDir);
  return { kind: 'remediation_enqueued', archive_path: archivePath, ticket_ids: affectedTicketIds };
}

export function enqueueCitadelRemediation(sessionDir: string): string {
  return enqueueCitadelRemediationResult(sessionDir).archive_path;
}

export function reconcileCitadelRemediation(sessionDir: string): boolean {
  const pendingPath = path.join(sessionDir, PENDING_FILE);
  const rawPending = readJsonFile<Record<string, unknown>>(pendingPath, null);
  if (!rawPending) {
    reconcileCitadelAttributionRepair(sessionDir);
    return false;
  }
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
