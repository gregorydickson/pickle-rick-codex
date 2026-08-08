import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCodexSucceeded, hasPromiseToken, runCodexExecMonitored } from './codex.js';
import { captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { hasPipelineContract } from './pipeline.js';
import { resetPipelineForAutonomousRemediation } from './pipeline-state.js';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonFile } from './pickle-utils.js';
import { normalizeTicketScopePath, resolveTicketScope } from './execution-gate.js';
import { StateManager } from './state-manager.js';
import { isDurableOwnershipDrainError } from './durable-runtime.js';
import { normalizeTicketId, readManifest, ticketDependencyIds, updateTicketStatus } from './tickets.js';
import type { Ticket } from '../types/index.js';

const PENDING_FILE = 'citadel-remediation-pending.json';
const CURRENT_FILE = 'citadel-remediation-current.json';
const ATTRIBUTION_BLOCKED_FILE = 'citadel-remediation-attribution-blocked.json';

export interface CitadelAttributionRepairIntent {
  schema_version: 3;
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
  attempt_count: number;
  strategy_history: Array<{
    attempt: number;
    strategy: string;
    strategy_hash: string;
    status: 'started' | 'failed';
    detail?: string;
    recorded_at: string;
  }>;
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
  attempt_count: number;
};

interface CitadelAttributionArtifact {
  schema_version: 1;
  report_sha256: string;
  attributions: Array<{ finding_index: number; ticket_id: string; rationale: string }>;
}

interface RepairCitadelAttributionOptions {
  timeoutMs?: number;
  assertDurableOwnership?: () => void;
  artifact?: unknown;
}

interface AuthoritativeSnapshotEntry {
  absolute_path: string;
  relative_path: string;
  content: string | null;
  fingerprint: string;
  mode: number | null;
}

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
  return record.schema_version === 3
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
    && Number.isInteger(record.attempt_count) && Number(record.attempt_count) >= 0
    && Array.isArray(record.strategy_history)
    && record.strategy_history.every((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
      && Number.isInteger((entry as Record<string, unknown>).attempt)
      && typeof (entry as Record<string, unknown>).strategy === 'string'
      && typeof (entry as Record<string, unknown>).strategy_hash === 'string'
      && ['started', 'failed'].includes(String((entry as Record<string, unknown>).status))
      && typeof (entry as Record<string, unknown>).recorded_at === 'string'
    ))
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
  if (raw.schema_version === 2 && raw.failure_kind === 'citadel_attribution_repair_required') {
    const archived = typeof raw.archive_path === 'string'
      ? readJsonFile<Record<string, unknown>>(raw.archive_path, null) : null;
    if (!archived) return null;
    const migrated: CitadelAttributionRepairIntent = {
      ...(raw as unknown as Omit<CitadelAttributionRepairIntent, 'schema_version' | 'attempt_count' | 'strategy_history'>),
      schema_version: 3,
      attempt_count: 0,
      strategy_history: [],
    };
    atomicWriteJson(repairPath, migrated);
    return migrated;
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
    schema_version: 3,
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
    attempt_count: 0,
    strategy_history: [],
    scheduled_at: typeof raw.recorded_at === 'string' ? raw.recorded_at : new Date().toISOString(),
  };
  atomicWriteJson(repairPath, migrated);
  return migrated;
}

function nextAttributionStrategy(intent: CitadelAttributionRepairIntent): string {
  const strategies = [
    'bind-findings-to-criterion-owners',
    'trace-finding-paths-to-ticket-scopes',
    'independently-reconstruct-finding-ownership',
  ];
  return strategies[intent.attempt_count]
    || `synthesize-attribution-from-${intent.attempt_count}-prior-strategies-${intent.report_sha256.slice(0, 12)}`;
}

function persistAttributionAttempt(
  sessionDir: string,
  intent: CitadelAttributionRepairIntent,
  strategy: string,
): CitadelAttributionRepairIntent {
  const strategyHash = crypto.createHash('sha256').update(JSON.stringify({
    report: intent.report_sha256,
    candidates: intent.finding_candidates,
    strategy,
    prior: intent.strategy_history.map((entry) => entry.strategy_hash),
  })).digest('hex');
  if (intent.strategy_history.some((entry) => entry.strategy_hash === strategyHash)) {
    throw new Error('citadel-attribution-strategy-not-novel');
  }
  const next: CitadelAttributionRepairIntent = {
    ...intent,
    attempt_count: intent.attempt_count + 1,
    strategy_history: [...intent.strategy_history, {
      attempt: intent.attempt_count + 1,
      strategy,
      strategy_hash: strategyHash,
      status: 'started',
      recorded_at: new Date().toISOString(),
    }],
  };
  atomicWriteJson(attributionRepairPath(sessionDir), next);
  return next;
}

function persistAttributionFailure(
  sessionDir: string,
  intent: CitadelAttributionRepairIntent,
  detail: string,
): CitadelAttributionRepairIntent {
  const next = structuredClone(intent);
  const latest = next.strategy_history.at(-1);
  if (latest) {
    latest.status = 'failed';
    latest.detail = detail;
    latest.recorded_at = new Date().toISOString();
  }
  next.reason = detail;
  atomicWriteJson(attributionRepairPath(sessionDir), next);
  return next;
}

function validateAttributionArtifact(
  intent: CitadelAttributionRepairIntent,
  value: unknown,
): CitadelAttributionArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('citadel-attribution-invalid-artifact: expected an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['schema_version', 'report_sha256', 'attributions'].includes(key))
    || record.schema_version !== 1 || record.report_sha256 !== intent.report_sha256
    || !Array.isArray(record.attributions)) {
    throw new Error('citadel-attribution-invalid-artifact: schema or report identity mismatch');
  }
  const attributions = record.attributions.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('citadel-attribution-invalid-artifact: attribution row must be an object');
    }
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['finding_index', 'ticket_id', 'rationale'].includes(key))
      || !Number.isInteger(row.finding_index)
      || typeof row.ticket_id !== 'string'
      || typeof row.rationale !== 'string' || !row.rationale.trim()) {
      throw new Error('citadel-attribution-invalid-artifact: row identity and rationale are required');
    }
    const candidate = intent.finding_candidates.find((entry) => entry.finding_index === row.finding_index);
    const selectedTicketId = normalizeTicketId(row.ticket_id, '');
    if (!candidate || !candidate.ticket_ids.includes(selectedTicketId)) {
      throw new Error(`citadel-attribution-invalid-artifact: finding ${row.finding_index} selected a non-candidate ticket`);
    }
    return { finding_index: Number(row.finding_index), ticket_id: selectedTicketId, rationale: row.rationale.trim() };
  });
  if (attributions.length !== intent.finding_candidates.length
    || new Set(attributions.map((entry) => entry.finding_index)).size !== attributions.length
    || intent.finding_candidates.some((candidate) => !attributions.some((entry) => entry.finding_index === candidate.finding_index))) {
    throw new Error('citadel-attribution-invalid-artifact: every actionable finding must be attributed exactly once');
  }
  return { schema_version: 1, report_sha256: intent.report_sha256, attributions };
}

function readAttributionArtifact(artifactPath: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
      throw new Error('citadel-attribution-invalid-artifact: artifact must be a regular file no larger than 1 MiB');
    }
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('citadel-attribution-invalid-artifact: malformed JSON', { cause: error });
    throw error;
  }
}

function reportWithResolvedAttribution(
  intent: CitadelAttributionRepairIntent,
  artifact: CitadelAttributionArtifact,
): Record<string, unknown> {
  const archived = readJsonFile<Record<string, unknown>>(intent.archive_path, null);
  if (!archived || reportSha256(archived) !== intent.report_sha256 || !Array.isArray(archived.findings)) {
    throw new Error('citadel-attribution-archive-identity-mismatch');
  }
  const findings = structuredClone(archived.findings);
  for (const resolved of artifact.attributions) {
    const finding = findings[resolved.finding_index];
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`citadel-attribution-invalid-artifact: finding ${resolved.finding_index} is missing`);
    }
    const record = finding as Record<string, unknown>;
    const candidates = intent.finding_candidates.find((entry) => entry.finding_index === resolved.finding_index)!;
    const selectedCriteria = candidates.criteria
      .filter((entry) => entry.ticket_ids.includes(resolved.ticket_id)).map((entry) => entry.value);
    const selectedPaths = candidates.paths
      .filter((entry) => entry.ticket_ids.includes(resolved.ticket_id)).map((entry) => entry.value);
    record.ticket_ids = [resolved.ticket_id];
    if (candidates.criteria.length > 0) {
      if (selectedCriteria.length > 0) record.acceptance_criteria = selectedCriteria;
      else delete record.acceptance_criteria;
    }
    if (candidates.paths.length > 0) {
      if (selectedPaths.length > 0) record.paths = selectedPaths;
      else delete record.paths;
      if (typeof record.file === 'string') {
        const normalizedFile = normalizeTicketScopePath(record.file);
        if (!normalizedFile || !selectedPaths.includes(normalizedFile)) record.file = null;
      }
    }
  }
  return { ...archived, findings };
}

function deterministicAttributionArtifact(intent: CitadelAttributionRepairIntent): CitadelAttributionArtifact | null {
  if (intent.finding_candidates.some((entry) => entry.ticket_ids.length !== 1)) return null;
  return {
    schema_version: 1,
    report_sha256: intent.report_sha256,
    attributions: intent.finding_candidates.map((entry) => ({
      finding_index: entry.finding_index,
      ticket_id: entry.ticket_ids[0],
      rationale: 'Only deterministic candidate remaining after criterion and path ownership narrowing.',
    })),
  };
}

const CONTROLLED_STATE_FIELDS = [
  'active_child_pid',
  'active_child_kind',
  'active_child_command',
  'active_child_identity',
  'active_child_controller_pid',
];

function normalizedAuthoritativeContent(relativePath: string, content: string | null): string {
  if (content === null) return '<missing>';
  if (!relativePath.endsWith('.json')) return content;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (relativePath === 'state.json') {
      for (const field of CONTROLLED_STATE_FIELDS) delete value[field];
    }
    if (relativePath === 'logical-pipeline.json' && value.lease && typeof value.lease === 'object') {
      const lease = value.lease as Record<string, unknown>;
      delete lease.renewed_at;
      delete lease.expires_at;
    }
    return JSON.stringify(value);
  } catch {
    return content;
  }
}

function authoritativePaths(sessionDir: string, intent: CitadelAttributionRepairIntent): string[] {
  const fixed = [
    'state.json',
    'refinement_manifest.json',
    'prd.md',
    'prd_refined.md',
    'prd.lock.json',
    'logical-pipeline.json',
    'pipeline.json',
    'pipeline-state.json',
    'refinement-acceptance.json',
    path.relative(sessionDir, intent.archive_path),
    path.relative(sessionDir, intent.report_path),
    ATTRIBUTION_BLOCKED_FILE,
  ];
  const ticketFiles = readManifest(sessionDir).tickets.map((ticket) => {
    const id = ticketId(ticket);
    return path.join(id, `linear_ticket_${id}.md`);
  });
  return [...new Set([...fixed, ...ticketFiles])]
    .filter((relative) => relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function captureAuthoritativeSnapshot(
  sessionDir: string,
  intent: CitadelAttributionRepairIntent,
): AuthoritativeSnapshotEntry[] {
  return authoritativePaths(sessionDir, intent).map((relativePath) => {
    const absolutePath = path.join(sessionDir, relativePath);
    const exists = fs.existsSync(absolutePath);
    const content = exists ? fs.readFileSync(absolutePath, 'utf8') : null;
    return {
      absolute_path: absolutePath,
      relative_path: relativePath,
      content,
      fingerprint: crypto.createHash('sha256')
        .update(normalizedAuthoritativeContent(relativePath, content)).digest('hex'),
      mode: exists ? fs.statSync(absolutePath).mode & 0o777 : null,
    };
  });
}

function restoreAuthoritativeEntry(entry: AuthoritativeSnapshotEntry): void {
  if (entry.content === null) {
    fs.rmSync(entry.absolute_path, { force: true });
    return;
  }
  ensureDir(path.dirname(entry.absolute_path));
  atomicWriteFile(entry.absolute_path, entry.content);
  if (entry.mode !== null) fs.chmodSync(entry.absolute_path, entry.mode);
}

function quarantineAndRestoreAuthoritativeDrift(
  sessionDir: string,
  intent: CitadelAttributionRepairIntent,
  snapshot: AuthoritativeSnapshotEntry[],
  candidateArtifactPath: string,
): string | null {
  const drift = snapshot.flatMap((entry) => {
    const exists = fs.existsSync(entry.absolute_path);
    const content = exists ? fs.readFileSync(entry.absolute_path, 'utf8') : null;
    const fingerprint = crypto.createHash('sha256')
      .update(normalizedAuthoritativeContent(entry.relative_path, content)).digest('hex');
    return fingerprint === entry.fingerprint ? [] : [{ entry, content, fingerprint }];
  });
  if (drift.length === 0) return null;
  const quarantineDir = ensureDir(path.join(
    sessionDir,
    'citadel-attribution-quarantine',
    `${intent.report_sha256}-${intent.attempt_count}-${crypto.randomUUID()}`,
  ));
  atomicWriteJson(path.join(quarantineDir, 'drift.json'), {
    schema_version: 1,
    report_sha256: intent.report_sha256,
    attempt: intent.attempt_count,
    changed_files: drift.map(({ entry, content, fingerprint }) => ({
      path: entry.relative_path,
      expected_sha256: entry.fingerprint,
      observed_sha256: fingerprint,
      observed_content_base64: content === null ? null : Buffer.from(content).toString('base64'),
    })),
    candidate_artifact_base64: fs.existsSync(candidateArtifactPath)
      ? fs.readFileSync(candidateArtifactPath).toString('base64') : null,
    quarantined_at: new Date().toISOString(),
  });
  for (const { entry } of drift) restoreAuthoritativeEntry(entry);
  const unresolved = drift.filter(({ entry }) => {
    const content = fs.existsSync(entry.absolute_path) ? fs.readFileSync(entry.absolute_path, 'utf8') : null;
    return crypto.createHash('sha256').update(normalizedAuthoritativeContent(entry.relative_path, content)).digest('hex')
      !== entry.fingerprint;
  });
  if (unresolved.length > 0) {
    throw new Error(`citadel-attribution-authoritative-restore-failed: ${unresolved.map(({ entry }) => entry.relative_path).join(', ')}`);
  }
  return `citadel-attribution-authoritative-drift: ${drift.map(({ entry }) => entry.relative_path).join(', ')}; quarantined at ${quarantineDir}`;
}

export async function repairCitadelAttribution(
  sessionDir: string,
  options: RepairCitadelAttributionOptions = {},
): Promise<CitadelRemediationEnqueueResult | null> {
  const repairStartedAtMs = Date.now();
  let intent = reconcileCitadelAttributionRepair(sessionDir);
  if (!intent) return null;
  const deterministic = deterministicAttributionArtifact(intent);
  let artifactValue: unknown = deterministic;
  let artifactPath: string | null = null;
  if (!artifactValue) {
    const strategy = nextAttributionStrategy(intent);
    intent = persistAttributionAttempt(sessionDir, intent, strategy);
    if (options.artifact !== undefined) {
      artifactValue = options.artifact;
    } else {
      const statePath = path.join(sessionDir, 'state.json');
      const manager = new StateManager();
      const state = manager.read(statePath);
      const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-citadel-attribution-'));
      const contextPath = path.join(candidateDir, 'attribution-context.json');
      const candidateArtifactPath = path.join(candidateDir, 'attribution-result.json');
      artifactPath = path.join(sessionDir, 'citadel-attribution-repairs', `${intent.report_sha256}-${intent.attempt_count}.json`);
      const lastMessagePath = path.join(candidateDir, 'last-message.txt');
      ensureDir(path.dirname(artifactPath));
      fs.rmSync(artifactPath, { force: true });
      atomicWriteJson(contextPath, {
        schema_version: 1,
        report_sha256: intent.report_sha256,
        archived_refusal: readJsonFile<Record<string, unknown>>(intent.archive_path, null),
        finding_candidates: intent.finding_candidates,
        candidate_ticket_contracts: readManifest(sessionDir).tickets.filter(completed).map((ticket) => ({
          id: ticketId(ticket),
          acceptance_criteria: ticket.acceptance_criteria || [],
          scope: resolveTicketScope(ticket).allowedPaths,
        })),
        strategy,
        strategy_hash: intent.strategy_history.at(-1)!.strategy_hash,
      });
      fs.chmodSync(contextPath, 0o400);
      const authoritativeSnapshot = captureAuthoritativeSnapshot(sessionDir, intent);
      const prompt = [
      'You are the autonomous Citadel finding attribution repair worker.',
      `Isolated read-only attribution context: ${contextPath}`,
      `Report SHA-256: ${intent.report_sha256}`,
      `Mandatory novel attribution strategy: ${strategy}; strategy hash ${intent.strategy_history.at(-1)!.strategy_hash}.`,
      `Write the attribution artifact to: ${candidateArtifactPath}`,
      'This isolated workspace contains the complete context. Do not access or modify any live session, repository, ticket, manifest, state, journal, refusal, or acceptance criterion.',
      'Write exactly one JSON object with schema_version: 1, report_sha256, and attributions. Each attribution must contain finding_index, exactly one ticket_id from that finding candidate list, and a non-empty rationale grounded in the preserved finding evidence.',
      'Every candidate finding must appear exactly once. Do not invent tickets, criteria, paths, or findings.',
      'Return <promise>CITADEL_ATTRIBUTION_REPAIR_COMPLETE</promise> after writing the artifact.',
      ].join('\n\n');
      options.assertDurableOwnership?.();
      let result: Awaited<ReturnType<typeof runCodexExecMonitored>> | null = null;
      let workerError: unknown = null;
      try {
        result = await runCodexExecMonitored({
        telemetry: { sessionDir, ticketId: 'citadel-attribution', phase: 'citadel_attribution_repair' },
        execArgs: ['--sandbox', 'workspace-write', '--skip-git-repo-check'], cwd: candidateDir, prompt,
        timeoutMs: options.timeoutMs || Number(state.worker_timeout_seconds || 900) * 1000,
        outputLastMessagePath: lastMessagePath, progressArtifactPaths: [candidateArtifactPath], addDirs: [], inheritConfiguredAddDirs: false,
        successCheck: ({ stdout, lastMessage }) => hasPromiseToken(stdout, 'CITADEL_ATTRIBUTION_REPAIR_COMPLETE')
          || hasPromiseToken(lastMessage, 'CITADEL_ATTRIBUTION_REPAIR_COMPLETE'),
        onSpawn: (child) => manager.update(statePath, (current) => {
          current.active_child_pid = child.pid;
          current.active_child_kind = 'codex';
          current.active_child_command = 'citadel-attribution-repair';
          current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
          current.active_child_controller_pid = process.pid;
          return current;
        }),
        cancelCheck: () => {
          const cancellationAtMs = Date.parse(String(manager.read(statePath).cancel_requested_at || ''));
          return Number.isFinite(cancellationAtMs) && cancellationAtMs >= repairStartedAtMs;
        },
        });
        options.assertDurableOwnership?.();
      } catch (error) {
        workerError = error;
      } finally {
        try {
          manager.update(statePath, (current) => {
            current.active_child_pid = null;
            current.active_child_kind = null;
            current.active_child_command = null;
            current.active_child_identity = null;
            current.active_child_controller_pid = null;
            return current;
          });
        } catch (error) {
          workerError ||= error;
        }
      }
      let driftDetail: string | null = null;
      try {
        driftDetail = quarantineAndRestoreAuthoritativeDrift(
          sessionDir, intent, authoritativeSnapshot, candidateArtifactPath,
        );
        if (driftDetail) throw new Error(driftDetail);
        if (workerError) throw workerError;
        if (!result) throw new Error('Citadel attribution repair did not return a worker result.');
        assertCodexSucceeded(result, 'Citadel attribution repair failed');
        artifactValue = readAttributionArtifact(candidateArtifactPath);
      } catch (error) {
        fs.rmSync(candidateDir, { recursive: true, force: true });
        if (isDurableOwnershipDrainError(error) && !driftDetail) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const persisted = persistAttributionFailure(sessionDir, intent, detail);
        return {
          kind: 'attribution_repair_scheduled', archive_path: persisted.archive_path,
          repair_intent_path: attributionRepairPath(sessionDir), candidate_ticket_ids: persisted.candidate_ticket_ids,
          reason: detail, attempt_count: persisted.attempt_count,
        };
      }
      fs.rmSync(candidateDir, { recursive: true, force: true });
    }
  }
  try {
    const artifact = validateAttributionArtifact(intent, artifactValue);
    if (artifactPath) atomicWriteJson(artifactPath, artifact);
    const repairedReport = reportWithResolvedAttribution(intent, artifact);
    atomicWriteJson(intent.report_path, repairedReport);
    const result = enqueueCitadelRemediationResult(sessionDir);
    if (result.kind !== 'remediation_enqueued') throw new Error('citadel-attribution-resolution-remained-ambiguous');
    atomicWriteJson(path.join(sessionDir, 'citadel-attribution-repair-current.json'), {
      schema_version: 1, report_sha256: intent.report_sha256, archive_path: intent.archive_path,
      artifact_path: artifactPath, attributions: artifact.attributions,
      strategy_history: intent.strategy_history, resolved_at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    if (isDurableOwnershipDrainError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const current = reconcileCitadelAttributionRepair(sessionDir) || intent;
    const persisted = current.strategy_history.length > 0
      ? persistAttributionFailure(sessionDir, current, detail)
      : { ...current, reason: detail };
    if (current.strategy_history.length === 0) atomicWriteJson(attributionRepairPath(sessionDir), persisted);
    return {
      kind: 'attribution_repair_scheduled', archive_path: persisted.archive_path,
      repair_intent_path: attributionRepairPath(sessionDir), candidate_ticket_ids: persisted.candidate_ticket_ids,
      reason: detail, attempt_count: persisted.attempt_count,
    };
  }
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
      attempt_count: existingRepair.attempt_count,
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
      schema_version: 3,
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
      attempt_count: 0,
      strategy_history: [],
      scheduled_at: new Date().toISOString(),
    };
    atomicWriteJson(attributionRepairPath(sessionDir), repairIntent);
    return {
      kind: 'attribution_repair_scheduled',
      archive_path: archivePath,
      repair_intent_path: attributionRepairPath(sessionDir),
      candidate_ticket_ids: repairIntent.candidate_ticket_ids,
      reason,
      attempt_count: repairIntent.attempt_count,
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
