import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCodexExecMonitored, assertCodexSucceeded, hasPromiseToken } from './codex.js';
import {
  commitIsAncestorWithPathsUnchanged,
  getHeadSha,
  getWorkingTreeFingerprint,
  listChangedPathsSince,
  listWorkingTreeDirtyPaths,
} from './git-utils.js';
import { recoverableHardReset } from './recoverable-git.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import {
  monitoredProcessStateCallbacks,
  recoverMonitoredProcessOwnership,
} from './monitored-process-ownership.js';
import { assertPrdSealMatchesPrd, readPrdSeal } from './prd-seal.js';
import { captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { auditPersistedScopeForCitadel } from './scope-contract.js';
import {
  finalizeModelCallTelemetry,
  reserveModelCallTelemetry,
  type ModelCallTelemetryReservation,
} from './productive-autonomy.js';
import {
  assertVerificationStepSafe,
  normalizeVerificationSteps,
  verificationStepCommand,
  verificationStepIdentity,
} from './verification-env.js';
import {
  assertAllTicketVerificationBoundToSeal,
  resolveSealedVerificationAuthorization,
} from './verification-seal-contract.js';
import type { CodexSpawnResult, VerificationStep } from '../types/index.js';

export type CitadelSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface CitadelFinding {
  severity: CitadelSeverity;
  title: string;
  evidence: string;
  file: string | null;
  line: number | null;
  recommendation: string | null;
  ticket_ids: string[];
  acceptance_criteria: string[];
  paths: string[];
}

export interface CitadelReport {
  schema_version: 1;
  verdict: 'approve' | 'block';
  reviewed_range: string;
  acceptance_criteria_checked: string[];
  findings: CitadelFinding[];
  generated_at: string;
}

export interface CitadelCheckResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exit_code: number | null;
  output: string;
  timed_out?: boolean;
  timeout_kind?: 'inactivity' | 'absolute';
  inactivity_timeout_ms?: number;
  absolute_timeout_ms?: number;
  output_bytes?: number;
  output_dropped_bytes?: number;
  output_truncated?: boolean;
  last_progress_at?: string;
  semantic_progress_count?: number;
  last_progress_identity?: string | null;
  elapsed_ms?: number;
  lifecycle_error?: string;
  process_tree_quiescent?: false;
}

export interface CitadelRecoveryAuthority {
  schema_version: 1;
  repository_head: string;
  release_fingerprint: string;
  reviewed_range: string;
  manifest_sha256: string;
  checks_sha256: string;
  journal_sha256: string;
  review_state_sha256: string;
  report_sha256: string;
  report_verdict: 'approve' | 'block';
  checks_binding_hash: string;
  verification_hash: string;
  acceptance_criteria_hash: string;
  review_identity: string;
}

export type CitadelSystemBlockCode =
  | 'scope_contract_invalid'
  | 'acceptance_criteria_missing'
  | 'deterministic_check_failed'
  | 'deterministic_gate_unavailable'
  | 'reviewer_artifact_strategy_exhausted';

export interface CitadelSystemBlockArtifact {
  schema_version: 1;
  artifact_kind: 'citadel_system_block';
  category: 'contract' | 'infrastructure';
  code: CitadelSystemBlockCode;
  reviewed_range: string;
  title: string;
  evidence: string;
  recommendation: string;
  checks: CitadelCheckResult[];
  recovery_action: 'request_prd_revision' | 'retry_checks' | 'repair_verification_contract'
    | 'repair_reviewer_artifact_contract';
  recovery_ticket_ids: string[];
  failure_identity: string;
  attempt: number;
  recovery_epoch: number;
  bounded_attempt: number;
  next_action: 'retry_phase' | 'restart_executor';
  generated_at: string;
}

export function citadelSystemBlockFailureIdentity(
  input: Pick<CitadelSystemBlockArtifact,
    'category' | 'code' | 'reviewed_range' | 'title' | 'evidence' | 'recommendation' | 'checks'
    | 'recovery_action' | 'recovery_ticket_ids'>,
): string {
  return reportHash({
    category: input.category,
    code: input.code,
    reviewed_range: input.reviewed_range,
    title: input.title,
    evidence: input.evidence.replace(/\s+/g, ' ').trim(),
    recommendation: input.recommendation,
    recovery_action: input.recovery_action,
    recovery_ticket_ids: input.recovery_ticket_ids,
    checks: input.checks.map(({ command, status, exit_code, output }) => ({ command, status, exit_code, output })),
  });
}

export class CitadelReviewerArtifactError extends Error {
  readonly code = 'CITADEL_REVIEWER_ARTIFACT_INVALID';
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CitadelReviewerArtifactError';
    this.attempts = attempts;
  }
}

export interface CitadelCheckExitOutcome {
  quiescent: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

export interface CitadelCheckRunOptions {
  timeoutMs: number;
  repositoryHygieneRange?: string;
  absoluteTimeoutMs?: number;
  wholeGateTimeoutMs?: number;
  journalBindingHash?: string;
  environment?: NodeJS.ProcessEnv;
  isCancelled: () => boolean;
  onSpawn: (child: ChildProcess, command: string) => void | Promise<void>;
  onExit: (outcome: CitadelCheckExitOutcome) => void | Promise<void>;
  cancelPollMs?: number;
  drainProcessTree?: (child: ChildProcess) => Promise<boolean>;
}

export interface CitadelDeterministicTimeoutPolicy {
  schema_version: 1;
  policy_id: 'trusted-work-inventory-v1';
  inactivity_timeout_ms: number;
  workload_units: number;
  extension_per_unit_ms: number;
  max_extension_ms: number;
  absolute_timeout_ms: number;
}

const CITADEL_PROGRESS_EXTENSION_PER_TEST_FILE_MS = 5_000;

function countCitadelTestWorkloadUnits(workingDir: string, limit = 10_000): number {
  const pending = [workingDir];
  let count = 0;
  while (pending.length && count < limit) {
    const current = pending.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', 'vendor', 'target', 'dist', 'build'].includes(entry.name)) {
          pending.push(path.join(current, entry.name));
        }
      } else if (entry.isFile() && /(?:^|\.)test\.[cm]?[jt]sx?$/.test(entry.name)) {
        count += 1;
        if (count >= limit) break;
      }
    }
  }
  return Math.max(1, count);
}

export function deriveCitadelDeterministicTimeoutPolicy(
  workingDir: string,
  inactivityTimeoutMs: number,
): CitadelDeterministicTimeoutPolicy {
  const workloadUnits = countCitadelTestWorkloadUnits(workingDir);
  const maxExtensionMs = inactivityTimeoutMs;
  const extensionMs = Math.min(
    maxExtensionMs,
    workloadUnits * CITADEL_PROGRESS_EXTENSION_PER_TEST_FILE_MS,
  );
  return {
    schema_version: 1,
    policy_id: 'trusted-work-inventory-v1',
    inactivity_timeout_ms: inactivityTimeoutMs,
    workload_units: workloadUnits,
    extension_per_unit_ms: CITADEL_PROGRESS_EXTENSION_PER_TEST_FILE_MS,
    max_extension_ms: maxExtensionMs,
    absolute_timeout_ms: inactivityTimeoutMs + extensionMs,
  };
}

export interface CitadelTrustedWorkItem {
  id: string;
  ordinal: number;
  command: string;
  executable: string;
  args: string[];
  cwd: string;
  execution_identity: string;
  inactivity_timeout_ms: number;
  absolute_timeout_ms: number;
}

export interface CitadelTrustedWorkInventory {
  schema_version: 1;
  adapter_id: 'pickle-npm-test-topology-v1';
  inventory_id: string;
  environment_hash: string;
  script_hashes: Record<string, string>;
  timeout_policy: CitadelDeterministicTimeoutPolicy;
  whole_gate_timeout_ms: number;
  items: CitadelTrustedWorkItem[];
}

class CitadelChecksCancelledError extends Error {
  constructor() {
    super('Citadel deterministic checks cancelled.');
    this.name = 'CitadelChecksCancelledError';
  }
}

class CitadelFaultInjectionError extends Error {}

const SEVERITIES = new Set<CitadelSeverity>(['critical', 'high', 'medium', 'low', 'info']);

function normalizeCriterion(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map(normalizeCriterion).filter(Boolean)
    : [];
}

function uniqueCriteria(criteria: string[]): string[] {
  return [...new Set(criteria.map(normalizeCriterion).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function criteriaFromManifest(sessionDir: string): string[] {
  const manifest = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!Array.isArray(manifest?.tickets)) return [];
  return uniqueCriteria(manifest.tickets.flatMap((ticket) => {
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return [];
    return stringArray((ticket as Record<string, unknown>).acceptance_criteria);
  }));
}

function criteriaFromSeal(sessionDir: string): string[] | null {
  const sealPath = path.join(sessionDir, 'prd.lock.json');
  if (!fs.existsSync(sealPath)) return null;
  const seal = readPrdSeal(sessionDir);
  const prdPath = path.join(sessionDir, 'prd.md');
  if (!fs.existsSync(prdPath)) {
    throw new Error('Citadel cannot validate prd.lock.json because the sealed prd.md is missing.');
  }
  assertPrdSealMatchesPrd(seal, fs.readFileSync(prdPath, 'utf8'));
  return seal.acceptance_criteria.map((criterion) => `${criterion.id}: ${criterion.text}`);
}

function verificationGateFromManifest(
  sessionDir: string,
  workingDir: string,
): { steps: VerificationStep[]; repairTicketIds: string[]; repairBeforeChecks: boolean } {
  const manifest = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!Array.isArray(manifest?.tickets)) {
    return { steps: [], repairTicketIds: [], repairBeforeChecks: false };
  }
  const sealed = fs.existsSync(path.join(sessionDir, 'prd.lock.json'));
  const repairTicketIds: string[] = [];
  const steps = manifest.tickets.flatMap((ticket) => {
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return [];
    const record = ticket as Record<string, unknown>;
    const ticketId = typeof record.id === 'string' ? record.id.trim() : '';
    const authorization = sealed && ticketId
      ? resolveSealedVerificationAuthorization(sessionDir, ticketId)
      : null;
    try {
      const normalized = normalizeVerificationSteps(record.verification, {
        verify: typeof record.verify === 'string' ? record.verify : undefined,
        cwd: workingDir,
      });
      if (normalized.length === 0 && ticketId && (authorization || !sealed)) {
        repairTicketIds.push(ticketId);
        return [];
      }
      return normalized;
    } catch (error) {
      if (ticketId && authorization) {
        repairTicketIds.push(ticketId);
        return [];
      }
      throw error;
    }
  });
  if (sealed && repairTicketIds.length > 0) {
    return { steps: [], repairTicketIds: uniqueStrings(repairTicketIds), repairBeforeChecks: true };
  }
  assertAllTicketVerificationBoundToSeal(sessionDir, workingDir);
  const seen = new Set<string>();
  return { steps: steps.filter((step) => {
    const identity = verificationStepIdentity([step]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }), repairTicketIds: uniqueStrings(repairTicketIds), repairBeforeChecks: false };
}

function criteriaFromPrd(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const criteria: string[] = [];
  let inAcceptanceSection = false;
  let acceptanceDepth = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const depth = heading[1].length;
      if (/acceptance criteria|success criteria/i.test(heading[2])) {
        inAcceptanceSection = true;
        acceptanceDepth = depth;
      } else if (inAcceptanceSection && depth <= acceptanceDepth) {
        inAcceptanceSection = false;
      }
      continue;
    }
    if (!inAcceptanceSection) continue;
    const bullet = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/);
    if (bullet) criteria.push(bullet[1]);
  }
  return uniqueCriteria(criteria);
}

/** A validated PRD seal is authoritative. Legacy unsealed sessions retain the
 * historical manifest-first, PRD-second fallback. */
export function deriveCitadelAcceptanceCriteria(sessionDir: string): string[] {
  const sealedCriteria = criteriaFromSeal(sessionDir);
  if (sealedCriteria !== null) return sealedCriteria;
  const manifestCriteria = criteriaFromManifest(sessionDir);
  if (manifestCriteria.length > 0) return manifestCriteria;
  for (const name of ['prd_refined.md', 'prd.md']) {
    const filePath = path.join(sessionDir, name);
    if (!fs.existsSync(filePath)) continue;
    const criteria = criteriaFromPrd(fs.readFileSync(filePath, 'utf8'));
    if (criteria.length > 0) return criteria;
  }
  return [];
}

export function citadelReportPath(sessionDir: string): string {
  return path.join(sessionDir, 'citadel-report.json');
}

export function citadelSystemBlockPath(sessionDir: string): string {
  return path.join(sessionDir, 'citadel-system-block.json');
}

export function readCitadelSystemBlock(sessionDir: string): CitadelSystemBlockArtifact | null {
  const raw = readJsonFile<Record<string, unknown>>(citadelSystemBlockPath(sessionDir), null);
  if (!raw) return null;
  const requiredKeys = [
    'schema_version', 'artifact_kind', 'category', 'code', 'reviewed_range', 'title', 'evidence',
    'recommendation', 'checks', 'recovery_action', 'recovery_ticket_ids', 'failure_identity', 'attempt',
    'recovery_epoch', 'bounded_attempt', 'next_action', 'generated_at',
  ];
  if (Object.keys(raw).sort().join('\0') !== [...requiredKeys].sort().join('\0')) {
    throw new Error('Invalid Citadel system block artifact: schema keys do not match the canonical contract.');
  }
  const codes = new Set<CitadelSystemBlockCode>([
    'scope_contract_invalid', 'acceptance_criteria_missing',
    'deterministic_check_failed', 'deterministic_gate_unavailable',
    'reviewer_artifact_strategy_exhausted',
  ]);
  const checks = raw.checks;
  const validChecks = Array.isArray(checks) && checks.every((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return false;
    const value = check as Record<string, unknown>;
    return typeof value.command === 'string' && value.command.trim().length > 0
      && ['passed', 'failed', 'skipped'].includes(String(value.status))
      && (value.exit_code === null || Number.isInteger(value.exit_code))
      && typeof value.output === 'string';
  });
  const positiveInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) > 0;
  if (raw.schema_version !== 1 || raw.artifact_kind !== 'citadel_system_block'
    || !['contract', 'infrastructure'].includes(String(raw.category))
    || !codes.has(raw.code as CitadelSystemBlockCode)
    || !['reviewed_range', 'title', 'evidence', 'recommendation', 'failure_identity', 'generated_at']
      .every((field) => typeof raw[field] === 'string' && String(raw[field]).trim().length > 0)
    || !validChecks
    || ![
      'request_prd_revision', 'retry_checks', 'repair_verification_contract',
      'repair_reviewer_artifact_contract',
    ]
      .includes(String(raw.recovery_action))
    || !Array.isArray(raw.recovery_ticket_ids)
    || !raw.recovery_ticket_ids.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
    || !positiveInteger(raw.attempt) || !positiveInteger(raw.recovery_epoch)
    || ![1, 2].includes(Number(raw.bounded_attempt))
    || !['retry_phase', 'restart_executor'].includes(String(raw.next_action))) {
    throw new Error('Invalid Citadel system block artifact: field values do not match the canonical contract.');
  }
  return raw as unknown as CitadelSystemBlockArtifact;
}

export function getCitadelRepositoryFingerprint(workingDir: string): string {
  const index = spawnSync('git', ['diff', '--cached', '--binary', '--no-ext-diff'], {
    cwd: workingDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (index.error || index.status !== 0) {
    throw new Error(`Citadel could not fingerprint the git index: ${index.error?.message || index.stderr || `exit ${index.status}`}`);
  }
  return JSON.stringify({
    head: getHeadSha(workingDir),
    index: index.stdout,
    files: getWorkingTreeFingerprint(workingDir),
  });
}

function assertDependencyTreeContained(nodeModulesDir: string, isolatedRoot: string): void {
  if (!fs.existsSync(nodeModulesDir)) return;
  if (fs.lstatSync(nodeModulesDir).isSymbolicLink()) {
    throw new Error(`dependency root is an external symlink: ${nodeModulesDir}`);
  }
  const canonicalIsolatedRoot = fs.realpathSync(isolatedRoot);
  const pending = [nodeModulesDir];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(entryPath);
        const relative = path.relative(canonicalIsolatedRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`dependency symlink escapes the isolated tree: ${entryPath}`);
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

function createCitadelWorktree(workingDir: string, checkpointHead: string): { workingDir: string; cleanup: () => void } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-citadel-worktree-'));
  const isolated = path.join(parent, 'repository');
  execFileSync('git', ['worktree', 'add', '--detach', isolated, checkpointHead], {
    cwd: workingDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
  });
  const cleanup = (): void => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', isolated], {
        cwd: workingDir,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 30_000,
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  };
  try {
    for (const relative of ['', 'extension']) {
      const packageRoot = path.join(isolated, relative);
      if (!fs.existsSync(path.join(packageRoot, 'package.json'))
        || !fs.existsSync(path.join(packageRoot, 'package-lock.json'))) continue;
      execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], {
        cwd: packageRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 300_000,
      });
      assertDependencyTreeContained(path.join(packageRoot, 'node_modules'), isolated);
    }
    const dirtyPaths = listWorkingTreeDirtyPaths(isolated);
    if (dirtyPaths.length > 0) {
      throw new Error(`dependency provisioning dirtied the isolated tree: ${dirtyPaths.join(', ')}`);
    }
    return { workingDir: isolated, cleanup };
  } catch (error) {
    cleanup();
    throw new Error('Citadel could not provision a clean isolated dependency tree from committed lockfiles.', { cause: error });
  }
}

function normalizeFinding(value: unknown, index: number): CitadelFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Citadel finding ${index}: expected an object.`);
  }
  const raw = value as Record<string, unknown>;
  const requiredFields = [
    'severity', 'title', 'evidence', 'file', 'line', 'recommendation',
    'ticket_ids', 'acceptance_criteria', 'paths',
  ] as const;
  const missingFields = requiredFields.filter((field) => !Object.hasOwn(raw, field));
  if (missingFields.length > 0) {
    throw new Error(`Invalid Citadel finding ${index}: missing required fields: ${missingFields.join(', ')}.`);
  }
  const severity = String(raw.severity || '').toLowerCase() as CitadelSeverity;
  if (!SEVERITIES.has(severity)) {
    throw new Error(`Invalid Citadel finding ${index}: unsupported severity ${JSON.stringify(raw.severity)}.`);
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
  if (!title || !evidence) {
    throw new Error(`Invalid Citadel finding ${index}: title and evidence are required.`);
  }
  if (raw.file !== null && typeof raw.file !== 'string') {
    throw new Error(`Invalid Citadel finding ${index}: file must be a string or null.`);
  }
  if (raw.line !== null && (!Number.isInteger(raw.line) || Number(raw.line) <= 0)) {
    throw new Error(`Invalid Citadel finding ${index}: line must be a positive integer or null.`);
  }
  if (raw.recommendation !== null && typeof raw.recommendation !== 'string') {
    throw new Error(`Invalid Citadel finding ${index}: recommendation must be a string or null.`);
  }
  for (const field of ['ticket_ids', 'acceptance_criteria', 'paths'] as const) {
    const value = raw[field];
    if (!Array.isArray(value)
      || !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
      throw new Error(`Invalid Citadel finding ${index}: ${field} must contain non-empty strings.`);
    }
  }
  const ticketIds = stringArray(raw.ticket_ids);
  const acceptanceCriteria = stringArray(raw.acceptance_criteria);
  const paths = stringArray(raw.paths);
  if ((severity === 'critical' || severity === 'high')
    && (ticketIds.length === 0 || acceptanceCriteria.length === 0 || paths.length === 0)) {
    throw new Error(
      `Invalid Citadel finding ${index}: critical/high findings require non-empty ticket_ids, acceptance_criteria, and paths.`,
    );
  }
  return {
    severity,
    title,
    evidence,
    file: typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : null,
    line: raw.line === null ? null : Number(raw.line),
    recommendation: typeof raw.recommendation === 'string' && raw.recommendation.trim()
      ? raw.recommendation.trim()
      : null,
    ticket_ids: ticketIds,
    acceptance_criteria: acceptanceCriteria,
    paths,
  };
}

export function validateCitadelReport(
  value: unknown,
  reviewedRange: string,
  expectedAcceptanceCriteria: string[],
): CitadelReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Citadel report: expected an object.');
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.findings)) {
    throw new Error('Invalid Citadel report: findings must be an array.');
  }
  if (raw.reviewed_range !== reviewedRange) {
    throw new Error('Invalid Citadel report: reviewed range does not match the current release range.');
  }
  const findings = raw.findings.map(normalizeFinding);
  const acceptanceCriteria = Array.isArray(raw.acceptance_criteria_checked)
    ? raw.acceptance_criteria_checked
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
  const expected = uniqueStrings(expectedAcceptanceCriteria);
  if (expected.length === 0) {
    throw new Error('Invalid Citadel evidence: the session declares no acceptance criteria.');
  }
  const checked = new Set(acceptanceCriteria);
  const missing = expected.filter((criterion) => !checked.has(criterion));
  if (missing.length > 0) {
    throw new Error(`Invalid Citadel report: acceptance criteria coverage is incomplete; missing: ${missing.join(' | ')}`);
  }
  const expectedSet = new Set(expected);
  const unexpected = acceptanceCriteria.filter((criterion) => !expectedSet.has(criterion));
  if (unexpected.length > 0 || acceptanceCriteria.length !== expected.length) {
    throw new Error(`Invalid Citadel report: acceptance criteria must exactly match the release contract; unexpected: ${unexpected.join(' | ') || 'duplicate criteria'}`);
  }
  const blocking = findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high');
  return {
    schema_version: 1,
    verdict: blocking ? 'block' : 'approve',
    reviewed_range: reviewedRange,
    acceptance_criteria_checked: acceptanceCriteria,
    findings,
    generated_at: typeof raw.generated_at === 'string' && raw.generated_at.trim()
      ? raw.generated_at
      : new Date().toISOString(),
  };
}

const CITADEL_RELEASE_APPROVAL_FILE = 'citadel-release-approval.json';
export const CITADEL_ISOLATION_QUARANTINE_FILE = 'citadel-isolation-quarantine.json';
const CITADEL_REVIEWER_MAX_ATTEMPTS = 2;
const CITADEL_REVIEWER_MAX_ARTIFACT_BYTES = 1024 * 1024;
const CITADEL_REVIEWER_EVIDENCE_TEXT_LIMIT = 100_000;
type CitadelReviewerRecoveryMechanism =
  | 'schema_scaffold_replay'
  | 'evidence_bundle_reconstruction'
  | 'criterion_sharded_reconstruction';

interface CitadelReviewAttemptState {
  ordinal: number;
  epoch: number;
  attempt: number;
  candidate_path: string;
  status: 'started' | 'interrupted' | 'rejected' | 'validated' | 'accepted';
  started_at: string;
  completed_at?: string;
  validation_error?: string;
  candidate_hash?: string;
  approval_signal?: boolean;
  strategy_id: string;
  material_strategy_hash: string;
  strategy_hash: string;
  retry_feedback: string | null;
  model_attempt_id?: number;
  telemetry_status?: 'started' | 'finalized';
  telemetry_result?: CodexSpawnResult;
  recovery_mechanism?: CitadelReviewerRecoveryMechanism;
  runtime_manifest_hash?: string;
  validator_evidence_path?: string;
}

interface CitadelArtifactContractRuntime {
  schema_version: 1;
  mechanism: CitadelReviewerRecoveryMechanism;
  scaffold_path: string | null;
  evidence_bundle_path: string | null;
  criterion_shard_bundle_path: string | null;
  manifest_path: string;
  validator_path: string;
  validator_command: string;
}

interface CitadelReviewState {
  schema_version: 1;
  review_identity: string;
  recovery_epoch: number;
  strategy_id: string;
  strategy_hash: string;
  status: 'running' | 'exhausted' | 'diagnostic_scheduled' | 'accepted';
  attempts: CitadelReviewAttemptState[];
  artifact_contract_recovery?: {
    schema_version: 1;
    status: 'started' | 'rejected' | 'resolved';
    diagnostic_identity: string;
    artifact_path: string;
    instruction?: string;
    resolved_at?: string;
    mechanism: CitadelReviewerRecoveryMechanism;
    failed_candidate_hashes: string[];
    validator_invariants: string[];
    mechanism_history?: CitadelReviewerRecoveryMechanism[];
    runtime_artifacts: CitadelArtifactContractRuntime;
    runtime_manifest_sha256?: string;
  };
  updated_at: string;
}

function writeCitadelReviewState(filePath: string, state: CitadelReviewState): void {
  state.updated_at = new Date().toISOString();
  atomicWriteJson(filePath, state);
}

const CITADEL_REVIEWER_STRATEGIES = [
  { id: 'standard-schema-review', instruction: 'Perform an evidence-grounded review, then serialize the complete report schema.' },
  { id: 'strict-minimal-json', instruction: 'Construct only the required JSON keys and arrays, validating every value type before writing.' },
  { id: 'independent-fresh-review', instruction: 'Discard prior candidate reasoning and independently re-read the deterministic evidence before producing a fresh report.' },
  { id: 'typed-intermediate-model', instruction: 'Build a typed in-memory checklist for range, criteria, and findings, then serialize that checked model exactly once.' },
  { id: 'adversarial-two-pass', instruction: 'Use separate author and validator passes: draft the report, audit it against every schema invariant, then write only the audited result.' },
] as const;

function citadelReviewerStrategy(
  strategyId: string,
): { id: string; instruction: string; hash: string } {
  const selected = CITADEL_REVIEWER_STRATEGIES.find((entry) => entry.id === strategyId)
    ?? CITADEL_REVIEWER_STRATEGIES[0];
  return {
    ...selected,
    hash: reportHash({ id: selected.id, instruction: selected.instruction }),
  };
}

interface ArtifactContractExecution {
  mechanism: CitadelArtifactContractRuntime['mechanism'];
  scaffoldPath: string | null;
  evidenceBundlePath: string | null;
  criterionShardBundlePath: string | null;
  manifestPath: string;
  validatorPath: string;
  validatorCommand: string;
  manifestHash: string;
  materialHash: string;
}

function assertRuntimeArtifactFile(sessionDir: string, filePath: string): string {
  const resolved = path.resolve(filePath);
  const runtimeRoot = path.resolve(sessionDir, 'citadel-reviewer-contract-runtime');
  if (resolved !== runtimeRoot && !resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
    throw new Error('Citadel artifact-contract runtime path escapes its durable runtime root.');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Citadel artifact-contract runtime input must be a regular non-symlink file.');
  }
  return resolved;
}

const CITADEL_SHARD_STRATEGIES = [
  {
    id: 'direct_repository_evidence',
    route: 'direct_review',
    instruction: 'Read the eligible changed files directly, hash their bytes, and construct the shard result from repository evidence.',
  },
  {
    id: 'runtime_citation_scaffold',
    route: 'preseeded_citation',
    instruction: 'Complete the runtime-provided citation scaffold only after independently checking every preseeded repository identity.',
  },
  {
    id: 'authenticated_diff_inventory_two_pass',
    route: 'diff_inventory',
    instruction: 'First audit the authenticated diff inventory against the repository; then perform an independent criterion decision pass and serialize only the audited result.',
  },
] as const;
const CITADEL_SHARD_REPLAN_STRATEGY = {
  id: 'failure_bound_evidence_replan',
  route: 'replanned_evidence_inventory',
  instruction: 'Use the authenticated rejection ledger to avoid every prior material approach, re-derive evidence from exact repository bytes, and produce a new independently checked result.',
} as const;

function expectedCitadelShardStrategy(ordinal: number) {
  const bounded = CITADEL_SHARD_STRATEGIES[ordinal - 1];
  return bounded
    ? { ...bounded, epoch: 1 }
    : { ...CITADEL_SHARD_REPLAN_STRATEGY, epoch: ordinal - CITADEL_SHARD_STRATEGIES.length };
}

function validateCitadelShardStrategyExecution(
  sessionDir: string,
  workingDir: string,
  checkpointHead: string,
  reviewedRange: string,
  repositoryPaths: string[],
  checkCommands: string[],
  criterion: string,
  execution: Record<string, unknown>,
): boolean {
  const attempts = Array.isArray(execution.attempts)
    ? execution.attempts as Array<Record<string, unknown>> : [];
  if (Object.keys(execution).sort().join('\0') !== ['attempts', 'shard_id'].sort().join('\0')
    || typeof execution.shard_id !== 'string' || !execution.shard_id || attempts.length === 0) return false;
  const fileInventory = repositoryPaths.map((repositoryPath) => ({
    path: repositoryPath,
    sha256: fileHash(path.join(workingDir, repositoryPath)),
  }));
  const materialHashes: string[] = [];
  const validated: Array<{
    ordinal: number;
    strategy_id: string;
    material_hash: string;
    candidate_sha256: string | null;
    status: string;
    error: string | null;
  }> = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const ordinal = index + 1;
    const expected = expectedCitadelShardStrategy(ordinal);
    if (Object.keys(attempt).sort().join('\0') !== [
      'ordinal', 'strategy_id', 'evidence_route', 'strategy_epoch', 'strategy_instruction',
      'strategy_material_hash', 'strategy_artifact', 'candidate', 'status', 'error',
    ].sort().join('\0')
      || attempt.ordinal !== ordinal || attempt.strategy_id !== expected.id
      || attempt.evidence_route !== expected.route || attempt.strategy_epoch !== expected.epoch
      || attempt.strategy_instruction !== expected.instruction
      || typeof attempt.strategy_material_hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(attempt.strategy_material_hash)
      || !['interrupted', 'rejected', 'resolved'].includes(String(attempt.status))
      || (attempt.error !== null && typeof attempt.error !== 'string')) return false;
    let candidateSha256: string | null = null;
    if (attempt.candidate !== null) {
      if (!attempt.candidate || typeof attempt.candidate !== 'object' || Array.isArray(attempt.candidate)) return false;
      const candidate = attempt.candidate as Record<string, unknown>;
      if (Object.keys(candidate).sort().join('\0') !== ['path', 'sha256'].sort().join('\0')
        || typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(candidate.sha256)) return false;
      const candidatePath = assertRuntimeArtifactFile(sessionDir, candidate.path);
      if (fileHash(candidatePath) !== candidate.sha256) return false;
      candidateSha256 = candidate.sha256;
    }
    let artifactSha256: string | null = null;
    let artifactValue: Record<string, unknown> | null = null;
    if (attempt.strategy_artifact !== null) {
      if (!attempt.strategy_artifact || typeof attempt.strategy_artifact !== 'object'
        || Array.isArray(attempt.strategy_artifact)) return false;
      const strategyArtifact = attempt.strategy_artifact as Record<string, unknown>;
      if (Object.keys(strategyArtifact).sort().join('\0') !== ['path', 'sha256'].sort().join('\0')
        || typeof strategyArtifact.path !== 'string' || typeof strategyArtifact.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(strategyArtifact.sha256)) return false;
      const artifactPath = assertRuntimeArtifactFile(sessionDir, strategyArtifact.path);
      if (fileHash(artifactPath) !== strategyArtifact.sha256) return false;
      artifactSha256 = strategyArtifact.sha256;
      artifactValue = readJsonFile<Record<string, unknown>>(artifactPath, null);
    }
    let expectedArtifact: Record<string, unknown> | null = null;
    if (expected.id === 'runtime_citation_scaffold') {
      expectedArtifact = {
        schema_version: 1,
        artifact_kind: 'criterion_citation_scaffold',
        shard_id: execution.shard_id,
        criterion,
        checkpoint_head: checkpointHead,
        reviewed_range: reviewedRange,
        eligible_repository_evidence: fileInventory,
        eligible_checks: checkCommands,
        required_observation: '<concrete observation from exact file bytes>',
      };
    } else if (expected.id === 'authenticated_diff_inventory_two_pass') {
      const diff = execFileSync('git', ['diff', '--binary', reviewedRange], {
        cwd: workingDir, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      });
      expectedArtifact = {
        schema_version: 1,
        artifact_kind: 'authenticated_diff_inventory',
        shard_id: execution.shard_id,
        checkpoint_head: checkpointHead,
        reviewed_range: reviewedRange,
        diff_sha256: crypto.createHash('sha256').update(diff).digest('hex'),
        files: fileInventory,
        deterministic_checks: checkCommands,
      };
    } else if (expected.id === 'failure_bound_evidence_replan') {
      expectedArtifact = {
        schema_version: 1,
        artifact_kind: 'criterion_evidence_replan',
        shard_id: execution.shard_id,
        checkpoint_head: checkpointHead,
        reviewed_range: reviewedRange,
        evidence_inventory: fileInventory,
        deterministic_checks: checkCommands,
        rejected_candidates: validated.filter((prior) => prior.status === 'rejected').map((prior) => ({
          ordinal: prior.ordinal,
          strategy_id: prior.strategy_id,
          material_hash: prior.material_hash,
          candidate_sha256: prior.candidate_sha256,
          error: prior.error,
        })),
        replan_epoch: expected.epoch,
      };
    }
    if (JSON.stringify(artifactValue) !== JSON.stringify(expectedArtifact)) return false;
    const materialHash = crypto.createHash('sha256').update(JSON.stringify({
      id: expected.id,
      route: expected.route,
      epoch: expected.epoch,
      instruction: expected.instruction,
      artifact_sha256: artifactSha256,
      checkpoint_head: checkpointHead,
      reviewed_range: reviewedRange,
      shard_id: execution.shard_id,
      criterion,
    })).digest('hex');
    if (attempt.strategy_material_hash !== materialHash) return false;
    materialHashes.push(materialHash);
    validated.push({
      ordinal,
      strategy_id: expected.id,
      material_hash: materialHash,
      candidate_sha256: candidateSha256,
      status: String(attempt.status),
      error: attempt.error as string | null,
    });
  }
  return attempts.at(-1)?.status === 'resolved'
    && new Set(materialHashes).size === materialHashes.length;
}

function artifactContractExecution(
  sessionDir: string,
  workingDir: string,
  checkpointHead: string,
  recovery: NonNullable<CitadelReviewState['artifact_contract_recovery']>,
  reviewIdentity: string,
  reviewedRange: string,
  expectedAcceptanceCriteria: string[],
  checks: CitadelCheckResult[],
): ArtifactContractExecution {
  const runtime = recovery.runtime_artifacts;
  if (!runtime || runtime.schema_version !== 1 || runtime.mechanism !== recovery.mechanism) {
    throw new Error('Citadel artifact-contract runtime manifest is missing or uses the wrong mechanism.');
  }
  const manifestPath = assertRuntimeArtifactFile(sessionDir, runtime.manifest_path);
  const validatorPath = assertRuntimeArtifactFile(sessionDir, runtime.validator_path);
  const scaffoldPath = runtime.scaffold_path === null ? null
    : assertRuntimeArtifactFile(sessionDir, runtime.scaffold_path);
  const evidenceBundlePath = runtime.evidence_bundle_path === null ? null
    : assertRuntimeArtifactFile(sessionDir, runtime.evidence_bundle_path);
  const criterionShardBundlePath = runtime.criterion_shard_bundle_path == null ? null
    : assertRuntimeArtifactFile(sessionDir, runtime.criterion_shard_bundle_path);
  if ((recovery.mechanism === 'schema_scaffold_replay') !== Boolean(scaffoldPath)
    || (recovery.mechanism === 'evidence_bundle_reconstruction') !== Boolean(evidenceBundlePath)
    || (recovery.mechanism === 'criterion_sharded_reconstruction') !== Boolean(criterionShardBundlePath)
    || runtime.validator_command !== `node ${JSON.stringify(validatorPath)} <candidate-path>`) {
    throw new Error('Citadel artifact-contract runtime files do not match the selected closed mechanism.');
  }
  const manifest = readJsonFile<Record<string, unknown>>(manifestPath, null);
  const selected = recovery.mechanism === 'schema_scaffold_replay'
    ? manifest?.scaffold as Record<string, unknown> | null
    : recovery.mechanism === 'evidence_bundle_reconstruction'
      ? manifest?.evidence_bundle as Record<string, unknown> | null
      : manifest?.criterion_shards as Record<string, unknown> | null;
  const validator = manifest?.validator as Record<string, unknown> | null;
  const selectedPath = scaffoldPath ?? evidenceBundlePath ?? criterionShardBundlePath;
  if (!manifest || (recovery.runtime_manifest_sha256 !== undefined
      && recovery.runtime_manifest_sha256 !== fileHash(manifestPath))
    || manifest.schema_version !== 1 || manifest.mechanism !== recovery.mechanism
    || selected?.path !== selectedPath || selected?.sha256 !== (selectedPath ? fileHash(selectedPath) : null)
    || validator?.path !== validatorPath || validator?.sha256 !== fileHash(validatorPath)) {
    throw new Error('Citadel artifact-contract runtime manifest does not authenticate its inputs.');
  }
  if (scaffoldPath) {
    const scaffold = readJsonFile<Record<string, unknown>>(scaffoldPath, null);
    if (!scaffold || scaffold.reviewed_range !== reviewedRange
      || JSON.stringify(scaffold.acceptance_criteria_checked) !== JSON.stringify(expectedAcceptanceCriteria)
      || !Array.isArray(scaffold.findings)) {
      throw new Error('Citadel schema scaffold is not bound to the exact review range and criteria.');
    }
  }
  if (evidenceBundlePath) {
    const bundle = readJsonFile<Record<string, unknown>>(evidenceBundlePath, null);
    if (!bundle || bundle.reviewed_range !== reviewedRange
      || JSON.stringify(bundle.acceptance_criteria) !== JSON.stringify(expectedAcceptanceCriteria)
      || JSON.stringify(bundle.deterministic_checks) !== JSON.stringify(checks)
      || JSON.stringify(bundle.failed_candidate_hashes) !== JSON.stringify(recovery.failed_candidate_hashes)
      || JSON.stringify(bundle.validator_invariants) !== JSON.stringify(recovery.validator_invariants)) {
      throw new Error('Citadel evidence bundle is not bound to the immutable review evidence.');
    }
  }
  if (criterionShardBundlePath) {
    const bundle = readJsonFile<Record<string, unknown>>(criterionShardBundlePath, null);
    const shardResults = Array.isArray(bundle?.results) ? bundle.results as Array<Record<string, unknown>> : [];
    const resultFiles = Array.isArray(bundle?.result_files)
      ? bundle.result_files as Array<Record<string, unknown>> : [];
    const strategyExecutions = Array.isArray(bundle?.strategy_executions)
      ? bundle.strategy_executions as Array<Record<string, unknown>> : [];
    const repositoryPaths = Array.isArray(bundle?.repository_paths)
      ? bundle.repository_paths.filter((entry): entry is string => typeof entry === 'string') : [];
    let expectedRepositoryPaths = execFileSync('git', ['diff', '--name-only', reviewedRange], {
      cwd: workingDir, encoding: 'utf8', timeout: 30_000,
    }).split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (expectedRepositoryPaths.length === 0) {
      expectedRepositoryPaths = execFileSync('git', ['ls-files'], {
        cwd: workingDir, encoding: 'utf8', timeout: 30_000,
      }).split('\n').map((entry) => entry.trim()).filter(Boolean);
    }
    const checkCommands = checks.map((check) => check.command);
    const shardPlanIdentity = typeof bundle?.shard_plan_identity === 'string'
      ? bundle.shard_plan_identity : '';
    const strategyExecutionsValid = strategyExecutions.length === shardResults.length
      && strategyExecutions.every((execution, index) => (
        execution.shard_id === shardResults[index].shard_id
        && validateCitadelShardStrategyExecution(
          sessionDir,
          workingDir,
          checkpointHead,
          reviewedRange,
          repositoryPaths,
          checkCommands,
          String(shardResults[index].criterion || ''),
          execution,
        )
      ));
    let resultFilesValid = resultFiles.length === shardResults.length;
    for (let index = 0; resultFilesValid && index < resultFiles.length; index += 1) {
      const entry = resultFiles[index];
      const result = shardResults[index];
      if (Object.keys(entry).sort().join('\0') !== ['path', 'sha256', 'shard_id'].sort().join('\0')
        || entry.shard_id !== result.shard_id || typeof entry.path !== 'string'
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        resultFilesValid = false;
        break;
      }
      const resultPath = assertRuntimeArtifactFile(sessionDir, entry.path);
      const persistedResult = readJsonFile<Record<string, unknown>>(resultPath, null);
      resultFilesValid = entry.sha256 === fileHash(resultPath)
        && JSON.stringify(persistedResult) === JSON.stringify(result);
    }
    const repositoryEvidenceValid = shardResults.every((result) => {
      const resultRepositoryPaths = Array.isArray(result.repository_paths)
        ? result.repository_paths.filter((entry): entry is string => typeof entry === 'string') : [];
      const repositoryEvidence = Array.isArray(result.repository_evidence)
        ? result.repository_evidence as Array<Record<string, unknown>> : [];
      const citedChecks = Array.isArray(result.checks_cited)
        ? result.checks_cited.filter((entry): entry is string => typeof entry === 'string') : [];
      if (result.checkpoint_head !== checkpointHead || result.reviewed_range !== reviewedRange
        || resultRepositoryPaths.length === 0
        || !Array.isArray(result.repository_paths)
        || result.repository_paths.length !== resultRepositoryPaths.length
        || !resultRepositoryPaths.every((entry) => repositoryPaths.includes(entry))
        || citedChecks.length === 0 || !Array.isArray(result.checks_cited)
        || result.checks_cited.length !== citedChecks.length
        || !citedChecks.every((entry) => checkCommands.includes(entry))
        || repositoryEvidence.length === 0) return false;
      return repositoryEvidence.every((entry) => {
        if (Object.keys(entry).sort().join('\0') !== ['observation', 'path', 'sha256'].sort().join('\0')
          || typeof entry.path !== 'string' || !resultRepositoryPaths.includes(entry.path)
          || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
          || typeof entry.observation !== 'string' || entry.observation.trim().length < 20) return false;
        const resolved = path.resolve(workingDir, entry.path);
        if (!resolved.startsWith(`${path.resolve(workingDir)}${path.sep}`)) return false;
        try {
          const stat = fs.lstatSync(resolved);
          return stat.isFile() && !stat.isSymbolicLink() && entry.sha256 === fileHash(resolved);
        } catch {
          return false;
        }
      });
    });
    if (!bundle || bundle.review_identity !== reviewIdentity
      || bundle.diagnostic_identity !== recovery.diagnostic_identity
      || !/^[a-f0-9]{64}$/.test(shardPlanIdentity)
      || selected?.shard_plan_identity !== shardPlanIdentity
      || bundle.bounded_strategy_limit !== 3 || bundle.replan_after_attempt !== 3
      || bundle.checkpoint_head !== checkpointHead
      || bundle.reviewed_range !== reviewedRange
      || repositoryPaths.length === 0
      || JSON.stringify(bundle.repository_paths) !== JSON.stringify(expectedRepositoryPaths)
      || JSON.stringify(bundle.acceptance_criteria) !== JSON.stringify(expectedAcceptanceCriteria)
      || JSON.stringify(bundle.deterministic_checks) !== JSON.stringify(checks)
      || JSON.stringify(bundle.failed_candidate_hashes) !== JSON.stringify(recovery.failed_candidate_hashes)
      || JSON.stringify(bundle.validator_invariants) !== JSON.stringify(recovery.validator_invariants)
      || shardResults.length !== expectedAcceptanceCriteria.length
      || !resultFilesValid || !strategyExecutionsValid || !repositoryEvidenceValid
      || JSON.stringify(shardResults.map((result) => result.criterion)) !== JSON.stringify(expectedAcceptanceCriteria)
      || shardResults.some((result) => (
        Object.keys(result).sort().join('\0') !== [
          'schema_version', 'shard_id', 'criterion', 'checkpoint_head', 'reviewed_range',
          'status', 'evidence', 'repository_paths', 'repository_evidence', 'checks_cited', 'findings',
        ].sort().join('\0')
        || result.schema_version !== 1
        || typeof result.shard_id !== 'string' || !result.shard_id
        || !['pass', 'fail'].includes(String(result.status))
        || !Array.isArray(result.evidence) || result.evidence.length === 0
        || !result.evidence.every((entry) => typeof entry === 'string' && entry.trim())
        || !Array.isArray(result.findings)
      ))) {
      throw new Error('Citadel criterion shard bundle is not a complete typed partition of the immutable review contract.');
    }
  }
  const manifestHash = fileHash(manifestPath);
  return {
    mechanism: recovery.mechanism,
    scaffoldPath,
    evidenceBundlePath,
    criterionShardBundlePath,
    manifestPath,
    validatorPath,
    validatorCommand: runtime.validator_command,
    manifestHash,
    materialHash: reportHash({
      id: 'artifact-contract-reconstruction',
      mechanism: recovery.mechanism,
      failed_candidate_hashes: recovery.failed_candidate_hashes,
      validator_invariants: recovery.validator_invariants,
      runtime_manifest_hash: manifestHash,
      validator_hash: fileHash(validatorPath),
      mechanism_input_hash: fileHash(selectedPath!),
      ...(criterionShardBundlePath ? {
        shard_plan_identity: (selected as Record<string, unknown>).shard_plan_identity,
      } : {}),
    }),
  };
}

function artifactContractReviewerStrategy(
  recovery: NonNullable<CitadelReviewState['artifact_contract_recovery']>,
  execution: ArtifactContractExecution,
): { id: string; instruction: string; hash: string } {
  const instruction = typeof recovery.instruction === 'string' ? recovery.instruction.trim() : '';
  const hashes = Array.isArray(recovery.failed_candidate_hashes) ? recovery.failed_candidate_hashes : [];
  const invariants = Array.isArray(recovery.validator_invariants) ? recovery.validator_invariants : [];
  if (recovery.status !== 'resolved' || !instruction || !/^[a-f0-9]{64}$/.test(recovery.diagnostic_identity)
    || ![
      'schema_scaffold_replay', 'evidence_bundle_reconstruction', 'criterion_sharded_reconstruction',
    ].includes(recovery.mechanism)
    || hashes.length === 0 || hashes.some((value) => !/^[a-f0-9]{64}$/.test(value))
    || invariants.length === 0 || invariants.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Citadel artifact-contract recovery is not durably resolved.');
  }
  const id = 'artifact-contract-reconstruction';
  return {
    id,
    instruction: recovery.mechanism === 'schema_scaffold_replay'
      ? 'Populate the preseeded canonical scaffold and run its deterministic validator before returning.'
      : recovery.mechanism === 'evidence_bundle_reconstruction'
        ? 'Reconstruct the report exclusively from the immutable evidence bundle and run its deterministic validator before returning.'
        : 'Reconcile independently reviewed typed criterion shards into one canonical report and run its deterministic validator before returning.',
    hash: execution.materialHash,
  };
}

function normalizeCitadelRetryFeedback(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const message = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim();
  return message ? message.slice(0, 1_000) : null;
}

function citadelReviewerAttemptHash(
  strategy: { id: string; instruction: string; hash?: string },
  retryFeedback: string | null,
): string {
  return reportHash({
    material_strategy_hash: strategy.hash ?? reportHash({ id: strategy.id, instruction: strategy.instruction }),
    retry_feedback: retryFeedback,
  });
}

function readBoundedReviewerCandidateBytes(
  reportPath: string,
  expectedAttemptDir: string,
): Buffer {
  const directoryStat = fs.lstatSync(expectedAttemptDir);
  const stat = fs.lstatSync(reportPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Invalid Citadel reviewer artifact: candidate must be a regular non-symlink file.');
  }
  const expectedPath = path.join(fs.realpathSync(expectedAttemptDir), 'citadel-review-candidate.json');
  if (fs.realpathSync(reportPath) !== expectedPath) {
    throw new Error('Invalid Citadel reviewer artifact: candidate path escapes its assigned attempt directory.');
  }
  if (stat.size > CITADEL_REVIEWER_MAX_ARTIFACT_BYTES) {
    throw new Error(`Invalid Citadel reviewer artifact: candidate exceeds ${CITADEL_REVIEWER_MAX_ARTIFACT_BYTES} bytes.`);
  }
  const fd = fs.openSync(reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.size > CITADEL_REVIEWER_MAX_ARTIFACT_BYTES) {
      throw new Error(`Invalid Citadel reviewer artifact: candidate exceeds ${CITADEL_REVIEWER_MAX_ARTIFACT_BYTES} bytes or is not regular.`);
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length > CITADEL_REVIEWER_MAX_ARTIFACT_BYTES) {
      throw new Error(`Invalid Citadel reviewer artifact: candidate exceeds ${CITADEL_REVIEWER_MAX_ARTIFACT_BYTES} bytes.`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readReviewerCandidate(
  reportPath: string,
  expectedAttemptDir: string,
): { value: unknown; hash: string } {
  const bytes = readBoundedReviewerCandidateBytes(reportPath, expectedAttemptDir);
  return {
    value: JSON.parse(bytes.toString('utf8')) as unknown,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function fileHash(reportPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
}

export function reconcileValidatedCitadelTelemetry(sessionDir: string): number {
  const statePath = path.join(sessionDir, 'citadel-review-state.json');
  const reviewState = readJsonFile<CitadelReviewState>(statePath, null);
  if (!reviewState || reviewState.schema_version !== 1 || !Array.isArray(reviewState.attempts)) return 0;
  let reconciled = 0;
  for (const attempt of reviewState.attempts) {
    if (!['validated', 'accepted'].includes(attempt.status)
      || attempt.telemetry_status === 'finalized'
      || !attempt.model_attempt_id || !attempt.telemetry_result || !attempt.candidate_hash) continue;
    const expectedAttemptDir = path.join(
      sessionDir, 'citadel-review-attempts', `${reviewState.review_identity.slice(0, 12)}-${attempt.ordinal}`,
    );
    const candidate = readReviewerCandidate(attempt.candidate_path, expectedAttemptDir);
    if (candidate.hash !== attempt.candidate_hash || attempt.approval_signal !== true) {
      throw new Error('Validated Citadel telemetry evidence no longer matches its durable candidate.');
    }
    const telemetry = readJsonFile<Record<string, unknown>>(
      path.join(sessionDir, 'execution-telemetry.json'), null,
    );
    const reservations = Array.isArray(telemetry?.model_attempts) ? telemetry.model_attempts : [];
    const events = Array.isArray(telemetry?.events) ? telemetry.events : [];
    const reservation = reservations.find((entry) => (
      entry && typeof entry === 'object'
      && (entry as Record<string, unknown>).model_attempt_id === attempt.model_attempt_id
    )) as ModelCallTelemetryReservation | undefined;
    const event = events.find((entry) => (
      entry && typeof entry === 'object'
      && (entry as Record<string, unknown>).model_attempt_id === attempt.model_attempt_id
    )) as Record<string, unknown> | undefined;
    if (reservation?.status === 'started') {
      finalizeModelCallTelemetry(sessionDir, reservation, {
        result: attempt.telemetry_result,
        outcome: 'success',
        productiveWork: 1,
        discardedWork: 0,
      });
    } else if (reservation?.status !== 'finalized'
      || event?.outcome !== 'success' || event?.productive_work !== 1) {
      throw new Error('Validated Citadel telemetry reservation cannot be reconciled safely.');
    }
    attempt.telemetry_status = 'finalized';
    reconciled += 1;
  }
  if (reconciled > 0) writeCitadelReviewState(statePath, reviewState);
  return reconciled;
}

function failedReviewerResult(error: unknown, durationMs: number): CodexSpawnResult {
  return {
    command: 'codex', args: [], exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error),
    timedOut: false, durationMs, lastMessage: '',
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    usageReported: false, terminatedAfterSuccess: false, cancelled: false,
    outputFormat: 'plain-text', assistantContent: '', toolCalls: [],
    drainAttested: false,
    processIdentities: { broker: null, target: null, descendants: [] },
  };
}

function compactTelemetryResult(result: CodexSpawnResult): CodexSpawnResult {
  return { ...result, stdout: '', stderr: '', lastMessage: '', assistantContent: '', toolCalls: [] };
}

function preserveInvalidReviewerAttempt(
  sessionDir: string,
  attempt: number,
  attemptKey: string,
  reviewedRange: string,
  checkpointHead: string,
  result: CodexSpawnResult,
  reportPath: string,
  error: unknown,
): void {
  let rawReport: string | null = null;
  try {
    rawReport = readBoundedReviewerCandidateBytes(reportPath, path.dirname(reportPath)).toString('utf8');
  } catch {
    // A missing report is itself evidence and is represented by null.
  }
  atomicWriteJson(path.join(sessionDir, `citadel-review-attempt-${attemptKey}.json`), {
    schema_version: 1,
    attempt,
    reviewed_range: reviewedRange,
    checkpoint_head: checkpointHead,
    checkpoint_restored: true,
    validation_error: error instanceof Error ? error.message : String(error),
    raw_report: rawReport?.slice(-CITADEL_REVIEWER_EVIDENCE_TEXT_LIMIT) ?? null,
    reviewer: {
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      last_message: result.lastMessage.slice(-CITADEL_REVIEWER_EVIDENCE_TEXT_LIMIT),
      stdout: result.stdout.slice(-CITADEL_REVIEWER_EVIDENCE_TEXT_LIMIT),
      stderr: result.stderr.slice(-CITADEL_REVIEWER_EVIDENCE_TEXT_LIMIT),
    },
    preserved_at: new Date().toISOString(),
  });
}

function reportHash(report: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

interface CitadelChecksAuthorityContext {
  binding: Record<string, unknown>;
  bindingHash: string;
  verificationHash: string;
  acceptanceCriteriaHash: string;
  descriptors: CitadelCheckDescriptor[];
  wholeGateTimeoutMs: number;
}

function deriveCitadelChecksAuthorityContext(
  sessionDir: string,
  checksWorkingDir: string,
  state: Record<string, unknown>,
  startCommit: string,
  checkpointHead: string,
  releaseFingerprint: string,
  reviewedRange: string,
  expectedAcceptanceCriteria: string[],
): CitadelChecksAuthorityContext {
  const verificationGate = verificationGateFromManifest(sessionDir, checksWorkingDir);
  if (verificationGate.repairBeforeChecks) {
    throw new Error(
      `Citadel recovery evidence has an unavailable verification contract for: ${verificationGate.repairTicketIds.join(', ')}.`,
    );
  }
  const verificationSteps = verificationGate.steps;
  const deterministicCheckTimeoutMs = Number(state.worker_timeout_seconds || 900) * 1000;
  const trustedTestInventory = resolvePickleTrustedTestInventory(
    checksWorkingDir,
    deterministicCheckTimeoutMs,
  );
  const descriptors = deduplicateCitadelCheckExecutions(
    citadelCheckDescriptors(
      checksWorkingDir,
      sessionDir,
      verificationSteps,
      `${startCommit}..${checkpointHead}`,
    ),
    checksWorkingDir,
  );
  const deterministicTimeoutBinding = {
    schema_version: 1,
    generic_command_policy: 'fixed-monotonic-deadline-v1',
    inactivity_timeout_ms: deterministicCheckTimeoutMs,
    absolute_timeout_ms: deterministicCheckTimeoutMs,
    whole_gate_timeout_ms: trustedTestInventory?.whole_gate_timeout_ms
      ?? deterministicCheckTimeoutMs * Math.max(
        1,
        descriptors.filter((descriptor) => !descriptor.skipped).length,
      ),
    executions: descriptors.map((descriptor) => ({
      command: descriptor.command,
      execution_identity: citadelLogicalCheckExecutionIdentity(descriptor, checksWorkingDir),
      verification_identity: descriptor.verificationStep
        ? verificationStepIdentity([descriptor.verificationStep]) : null,
    })),
    progress_protocol: trustedTestInventory ? {
      transport: 'controller-owned-child-exit',
      adapter_id: trustedTestInventory.adapter_id,
      schema_version: trustedTestInventory.schema_version,
      inventory: citadelTrustedInventoryBinding(trustedTestInventory, checksWorkingDir),
    } : null,
  };
  const verificationHash = reportHash(verificationSteps);
  const acceptanceCriteriaHash = reportHash(expectedAcceptanceCriteria);
  const binding = {
    checkpoint_head: checkpointHead,
    release_fingerprint: releaseFingerprint,
    reviewed_range: reviewedRange,
    verification_hash: verificationHash,
    acceptance_criteria_hash: acceptanceCriteriaHash,
    deterministic_timeout_policy: deterministicTimeoutBinding,
  };
  return {
    binding,
    bindingHash: reportHash(binding),
    verificationHash,
    acceptanceCriteriaHash,
    descriptors,
    wholeGateTimeoutMs: deterministicTimeoutBinding.whole_gate_timeout_ms,
  };
}

function recoveryArtifactPath(sessionDir: string, name: string): string {
  const artifactPath = path.join(sessionDir, name);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Citadel recovery evidence must be a regular non-symlink file: ${name}.`);
  }
  return artifactPath;
}

function assertRecoverableChecks(
  checks: unknown,
  descriptors: CitadelCheckDescriptor[],
): asserts checks is CitadelCheckResult[] {
  if (!Array.isArray(checks) || checks.length !== descriptors.length) {
    throw new Error('Citadel recovery checks do not match the current deterministic execution inventory.');
  }
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const descriptor = descriptors[index];
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new Error(`Citadel recovery check ${index + 1} is malformed.`);
    }
    const value = check as Record<string, unknown>;
    const expectedStatus = descriptor.skipped ? 'skipped' : 'passed';
    if (value.command !== descriptor.command || value.status !== expectedStatus
      || (expectedStatus === 'passed' && value.exit_code !== 0)
      || (expectedStatus === 'skipped' && value.exit_code !== null)
      || typeof value.output !== 'string' || value.process_tree_quiescent === false) {
      throw new Error(`Citadel recovery check ${index + 1} is not a successful result for the bound execution.`);
    }
  }
  if (!checks.some((check) => check.status === 'passed' && check.command !== 'git diff --check')) {
    throw new Error('Citadel recovery evidence has no substantive deterministic release gate.');
  }
}

function normalizedRecoveryTimeoutPolicy(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Citadel recovery deterministic timeout policy is malformed.');
  }
  const policy = value as Record<string, unknown>;
  const executions = Array.isArray(policy.executions)
    ? policy.executions as Array<Record<string, unknown>> : [];
  if (executions.some((entry) => !entry || typeof entry !== 'object'
    || typeof entry.command !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(entry.execution_identity || ''))
    || (entry.verification_identity !== null
      && (typeof entry.verification_identity !== 'string' || !entry.verification_identity)))) {
    throw new Error('Citadel recovery deterministic execution identity is malformed.');
  }
  const progress = policy.progress_protocol as Record<string, unknown> | null;
  let normalizedProgress: Record<string, unknown> | null = null;
  if (progress !== null) {
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      throw new Error('Citadel recovery trusted progress protocol is malformed.');
    }
    const inventory = progress.inventory as Record<string, unknown> | null;
    const items = Array.isArray(inventory?.items)
      ? inventory.items as Array<Record<string, unknown>> : [];
    if (!inventory || !/^[a-f0-9]{64}$/.test(String(inventory.environment_hash || ''))
      || !/^[a-f0-9]{64}$/.test(String(inventory.inventory_id || ''))
      || items.some((item) => !/^[a-f0-9]{64}$/.test(String(item.execution_identity || '')))) {
      throw new Error('Citadel recovery trusted work inventory identity is malformed.');
    }
    const { inventory_id: inventoryId, ...unsignedInventory } = inventory;
    if (inventoryId !== reportHash(unsignedInventory)) {
      throw new Error('Citadel recovery trusted work inventory digest does not match its exact contents.');
    }
    normalizedProgress = {
      transport: progress.transport,
      adapter_id: progress.adapter_id,
      schema_version: progress.schema_version,
      inventory: {
        schema_version: inventory.schema_version,
        adapter_id: inventory.adapter_id,
        script_hashes: inventory.script_hashes,
        timeout_policy: inventory.timeout_policy,
        whole_gate_timeout_ms: inventory.whole_gate_timeout_ms,
        items: items.map((item) => ({
          id: item.id,
          ordinal: item.ordinal,
          command: item.command,
          executable: item.executable,
          args: item.args,
          inactivity_timeout_ms: item.inactivity_timeout_ms,
          absolute_timeout_ms: item.absolute_timeout_ms,
        })),
      },
    };
  }
  return {
    schema_version: policy.schema_version,
    generic_command_policy: policy.generic_command_policy,
    inactivity_timeout_ms: policy.inactivity_timeout_ms,
    absolute_timeout_ms: policy.absolute_timeout_ms,
    whole_gate_timeout_ms: policy.whole_gate_timeout_ms,
    executions: executions.map((entry) => ({
      command: entry.command,
      verification_identity: entry.verification_identity,
    })),
    progress_protocol: normalizedProgress,
  };
}

/**
 * Authenticate a completed Citadel evidence bundle for crash recovery. This is
 * intentionally read-only: callers may persist the returned authority, but the
 * validator never repairs or rewrites evidence at the trust boundary.
 */
export function validateCitadelRecoveryEvidence(
  sessionDir: string,
  workingDir: string,
  state: Record<string, unknown>,
  options: { allowRepositoryDescendantOf?: string } = {},
): CitadelRecoveryAuthority {
  if (!workingDir || path.resolve(String(state.working_dir || '')) !== path.resolve(workingDir)) {
    throw new Error('Citadel recovery evidence working_dir does not match the persisted session authority.');
  }
  const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  if (dirtyPaths.length > 0) {
    throw new Error(`Citadel recovery evidence requires a clean release tree; dirty paths: ${dirtyPaths.join(', ')}`);
  }
  const startCommit = reachableCitadelBase(workingDir, state.start_commit);
  if (!startCommit) {
    throw new Error('Citadel recovery evidence requires a reachable persisted start_commit.');
  }
  const repositoryHead = getHeadSha(workingDir);
  const releaseFingerprint = getCitadelRepositoryFingerprint(workingDir);
  const reviewedRange = `${startCommit}..HEAD`;
  const expectedAcceptanceCriteria = deriveCitadelAcceptanceCriteria(sessionDir);
  if (expectedAcceptanceCriteria.length === 0) {
    throw new Error('Citadel recovery evidence declares no acceptance criteria.');
  }

  const manifestPath = recoveryArtifactPath(sessionDir, 'refinement_manifest.json');
  const checksPath = recoveryArtifactPath(sessionDir, 'citadel-checks.json');
  const journalPath = recoveryArtifactPath(sessionDir, 'citadel-deterministic-check-journal.json');
  const reviewStatePath = recoveryArtifactPath(sessionDir, 'citadel-review-state.json');
  const reportPath = recoveryArtifactPath(sessionDir, 'citadel-report.json');
  const checksArtifact = readJsonFile<Record<string, unknown>>(checksPath, null);
  const journal = readJsonFile<Record<string, unknown>>(journalPath, null);
  const reviewState = readJsonFile<CitadelReviewState>(reviewStatePath, null);
  const rawReport = readJsonFile<Record<string, unknown>>(reportPath, null);
  if (!checksArtifact || !journal || !reviewState || !rawReport) {
    throw new Error('Citadel recovery evidence contains an unreadable JSON artifact.');
  }

  const persistedBinding = checksArtifact.binding as Record<string, unknown> | null;
  const boundHead = String(persistedBinding?.checkpoint_head || '');
  const boundFingerprint = String(persistedBinding?.release_fingerprint || '');
  const staleRepositoryAuthority = Boolean(options.allowRepositoryDescendantOf
    && boundHead === options.allowRepositoryDescendantOf
    && repositoryHead !== boundHead
    && commitIsAncestorWithPathsUnchanged(workingDir, boundHead, []));
  const checksHead = staleRepositoryAuthority ? boundHead : repositoryHead;
  const checksFingerprint = staleRepositoryAuthority ? boundFingerprint : releaseFingerprint;

  const context = deriveCitadelChecksAuthorityContext(
    sessionDir,
    workingDir,
    state,
    startCommit,
    checksHead,
    checksFingerprint,
    reviewedRange,
    expectedAcceptanceCriteria,
  );
  const checks = checksArtifact.checks;
  assertRecoverableChecks(checks, context.descriptors);
  const checksHash = reportHash(checks);
  const journalHash = reportHash(journal);
  if (checksArtifact.schema_version !== 1 || checksArtifact.reviewed_range !== reviewedRange) {
    throw new Error('Citadel recovery checks do not declare the current release range.');
  }
  const observedBinding = checksArtifact.binding && typeof checksArtifact.binding === 'object'
    && !Array.isArray(checksArtifact.binding)
    ? checksArtifact.binding as Record<string, unknown> : {};
  const staticBindingFields = [
    'checkpoint_head', 'release_fingerprint', 'reviewed_range',
    'verification_hash', 'acceptance_criteria_hash',
  ];
  const mismatchedFields = staticBindingFields.filter((field) => (
    JSON.stringify(observedBinding[field]) !== JSON.stringify(context.binding[field])
  ));
  if (mismatchedFields.length > 0) {
    throw new Error(`Citadel recovery checks binding does not match the current release authority: ${mismatchedFields.join(', ') || 'schema'}.`);
  }
  if (JSON.stringify(normalizedRecoveryTimeoutPolicy(observedBinding.deterministic_timeout_policy))
    !== JSON.stringify(normalizedRecoveryTimeoutPolicy(context.binding.deterministic_timeout_policy))) {
    throw new Error('Citadel recovery deterministic policy does not match the current release execution topology.');
  }
  const observedBindingHash = reportHash(observedBinding);
  if (checksArtifact.checks_hash !== checksHash
    || checksArtifact.journal_hash !== journalHash
    || journal.schema_version !== 1 || journal.status !== 'completed'
    || journal.binding_hash !== observedBindingHash || journal.checks_hash !== checksHash) {
    throw new Error('Citadel recovery completed journal does not match the bound deterministic checks.');
  }

  const reviewIdentity = reportHash({
    reviewed_range: reviewedRange,
    checkpoint_head: checksHead,
    checks_hash: checksHash,
    checks_binding_hash: observedBindingHash,
    acceptance_criteria_hash: context.acceptanceCriteriaHash,
  });
  if (reviewState.schema_version !== 1 || reviewState.review_identity !== reviewIdentity
    || reviewState.status !== 'accepted' || !Array.isArray(reviewState.attempts)) {
    throw new Error('Citadel recovery review state is not the accepted review for the current evidence.');
  }
  const acceptedAttempt = [...reviewState.attempts].reverse().find((attempt) => (
    attempt.epoch === reviewState.recovery_epoch && attempt.status === 'accepted'
  ));
  if (!acceptedAttempt?.candidate_hash || acceptedAttempt.approval_signal !== true) {
    throw new Error('Citadel recovery review state lacks an accepted candidate and durable approval signal.');
  }
  const catalogStrategy = CITADEL_REVIEWER_STRATEGIES.find(
    (entry) => entry.id === acceptedAttempt.strategy_id,
  );
  const expectedStrategy = catalogStrategy
    ? citadelReviewerStrategy(catalogStrategy.id)
    : acceptedAttempt.strategy_id === 'artifact-contract-reconstruction'
      && reviewState.artifact_contract_recovery
      ? artifactContractReviewerStrategy(
        reviewState.artifact_contract_recovery,
        artifactContractExecution(
          sessionDir,
          workingDir,
          repositoryHead,
          reviewState.artifact_contract_recovery,
          reviewIdentity,
          reviewedRange,
          expectedAcceptanceCriteria,
          checks,
        ),
      )
      : null;
  if (!expectedStrategy) {
    throw new Error('Citadel recovery review strategy is not a supported authenticated strategy.');
  }
  if (acceptedAttempt.material_strategy_hash !== expectedStrategy.hash
    || reviewState.strategy_id !== acceptedAttempt.strategy_id
    || reviewState.strategy_hash !== expectedStrategy.hash) {
    throw new Error('Citadel recovery review strategy identity does not match the accepted candidate.');
  }
  const expectedAttemptDir = path.join(
    sessionDir,
    'citadel-review-attempts',
    `${reviewIdentity.slice(0, 12)}-${acceptedAttempt.ordinal}`,
  );
  const candidate = readReviewerCandidate(acceptedAttempt.candidate_path, expectedAttemptDir);
  if (candidate.hash !== acceptedAttempt.candidate_hash) {
    throw new Error('Citadel recovery accepted candidate digest changed after review.');
  }
  const validatedCandidate = validateCitadelReport(
    candidate.value,
    reviewedRange,
    expectedAcceptanceCriteria,
  );
  const validatedReport = validateCitadelReport(
    rawReport,
    reviewedRange,
    expectedAcceptanceCriteria,
  );
  if (reportHash(validatedCandidate) !== reportHash(validatedReport)) {
    throw new Error('Citadel recovery report does not match its accepted reviewer candidate.');
  }

  return {
    schema_version: 1,
    repository_head: repositoryHead,
    release_fingerprint: releaseFingerprint,
    reviewed_range: reviewedRange,
    manifest_sha256: fileHash(manifestPath),
    checks_sha256: fileHash(checksPath),
    journal_sha256: fileHash(journalPath),
    review_state_sha256: fileHash(reviewStatePath),
    report_sha256: fileHash(reportPath),
    report_verdict: validatedReport.verdict,
    checks_binding_hash: observedBindingHash,
    verification_hash: context.verificationHash,
    acceptance_criteria_hash: context.acceptanceCriteriaHash,
    review_identity: reviewIdentity,
  };
}

export function assertCitadelReleaseApproval(sessionDir: string): void {
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  const workingDir = String(state.working_dir || '');
  const approval = readJsonFile<Record<string, unknown>>(path.join(sessionDir, CITADEL_RELEASE_APPROVAL_FILE), null);
  const report = readJsonFile<Record<string, unknown>>(citadelReportPath(sessionDir), null);
  if (!approval || !report || approval.report_hash !== reportHash(report)
    || approval.head !== getHeadSha(workingDir)
    || approval.repository_fingerprint !== getCitadelRepositoryFingerprint(workingDir)) {
    throw new Error('Logical completion requires fresh Citadel approval for the current repository identity.');
  }
  const expectedRange = `${String(state.start_commit || '')}..HEAD`;
  if (approval.reviewed_range !== expectedRange) throw new Error('Citadel approval range is stale.');
  const validated = validateCitadelReport(report, expectedRange, deriveCitadelAcceptanceCriteria(sessionDir));
  if (validated.verdict !== 'approve') throw new Error('Citadel did not approve the release.');
}

export function persistCitadelReleaseApproval(sessionDir: string, report: CitadelReport): void {
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  const workingDir = String(state.working_dir || '');
  const expectedRange = `${String(state.start_commit || '')}..HEAD`;
  const validated = validateCitadelReport(report, expectedRange, deriveCitadelAcceptanceCriteria(sessionDir));
  if (validated.verdict !== 'approve') throw new Error('Cannot persist a blocked Citadel release approval.');
  atomicWriteJson(citadelReportPath(sessionDir), validated);
  atomicWriteJson(path.join(sessionDir, CITADEL_RELEASE_APPROVAL_FILE), {
    schema_version: 1,
    reviewed_range: expectedRange,
    head: getHeadSha(workingDir),
    repository_fingerprint: getCitadelRepositoryFingerprint(workingDir),
    report_hash: reportHash(validated),
    approved_at: new Date().toISOString(),
  });
}

function packageScripts(workingDir: string): Record<string, string> {
  const packagePath = path.join(workingDir, 'package.json');
  const parsed = readJsonFile<Record<string, unknown>>(packagePath, null);
  if (!parsed?.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
  return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function resolvePickleTrustedTestInventory(
  workingDir: string,
  inactivityTimeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): CitadelTrustedWorkInventory | null {
  const rootPackage = readJsonFile<Record<string, unknown>>(path.join(workingDir, 'package.json'), null);
  if (rootPackage?.name !== 'pickle-rick-codex') return null;
  const rootScripts = packageScripts(workingDir);
  const extensionDir = fs.realpathSync(path.join(workingDir, 'extension'));
  const extensionScripts = packageScripts(extensionDir);
  const expected = {
    root_test: 'npm --prefix extension test',
    pretest: 'if [ -d src ] && [ -d node_modules ]; then npm run build && npm run audit:test-tiers; fi',
    test: 'npm run test:fast && npm run test:integration',
    prebuild: 'bash scripts/copy-shell-assets.sh',
    build: 'tsc',
    audit: 'bash scripts/audit-test-tiers.sh',
    fast: 'node bin/test-runner.js --tier fast --test-concurrency=8',
    integration: 'node bin/test-runner.js --tier integration --test-concurrency=4',
  };
  const observed = {
    root_test: rootScripts.test,
    pretest: extensionScripts.pretest,
    test: extensionScripts.test,
    prebuild: extensionScripts.prebuild,
    build: extensionScripts.build,
    audit: extensionScripts['audit:test-tiers'],
    fast: extensionScripts['test:fast'],
    integration: extensionScripts['test:integration'],
  };
  for (const [name, body] of Object.entries(expected)) {
    if (observed[name as keyof typeof observed] !== body) {
      throw new Error(`Citadel trusted npm test topology drifted at ${name}; refusing unproven progress expansion.`);
    }
  }
  const timeoutPolicy = deriveCitadelDeterministicTimeoutPolicy(workingDir, inactivityTimeoutMs);
  const environmentHash = reportHash(canonicalCitadelCheckEnv(environment));
  const definitions = [
    { id: 'extension-build', script: 'build' },
    { id: 'extension-audit-test-tiers', script: 'audit:test-tiers' },
    { id: 'extension-test-fast', script: 'test:fast' },
    { id: 'extension-test-integration', script: 'test:integration' },
  ];
  const items = definitions.map(({ id, script }, index): CitadelTrustedWorkItem => {
    const executable = 'npm';
    const args = ['--prefix', 'extension', 'run', script];
    const command = `${executable} ${args.join(' ')}`;
    return {
      id,
      ordinal: index + 1,
      command,
      executable,
      args,
      cwd: fs.realpathSync(workingDir),
      execution_identity: reportHash({
        cwd: fs.realpathSync(workingDir), executable, args, environment_hash: environmentHash,
      }),
      inactivity_timeout_ms: inactivityTimeoutMs,
      absolute_timeout_ms: inactivityTimeoutMs,
    };
  });
  const scriptHashes = Object.fromEntries(Object.entries(observed).map(([name, body]) => [name, reportHash(body)]));
  const unsigned = {
    schema_version: 1 as const,
    adapter_id: 'pickle-npm-test-topology-v1' as const,
    environment_hash: environmentHash,
    script_hashes: scriptHashes,
    timeout_policy: timeoutPolicy,
    whole_gate_timeout_ms: timeoutPolicy.absolute_timeout_ms,
    items,
  };
  return { ...unsigned, inventory_id: reportHash(unsigned) };
}

function packageCheckDescriptor(workingDir: string, script: string): CitadelCheckDescriptor {
  const rootScripts = packageScripts(workingDir);
  if (rootScripts[script]) {
    return { command: `npm run ${script}`, executable: 'npm', args: ['run', script] };
  }
  const extensionDir = path.join(workingDir, 'extension');
  const extensionScripts = packageScripts(extensionDir);
  if (extensionScripts[script]) {
    return {
      command: `npm --prefix extension run ${script}`,
      executable: 'npm',
      args: ['--prefix', 'extension', 'run', script],
    };
  }
  return { command: `npm run ${script}`, executable: 'npm', args: ['run', script], skipped: true };
}

function runSynchronousCitadelCheck(
  descriptor: CitadelCheckDescriptor,
  workingDir: string,
  timeoutMs: number,
): CitadelCheckResult {
  if (descriptor.skipped) {
    return { command: descriptor.command, status: 'skipped', exit_code: null, output: 'script not defined' };
  }
  const result = spawnSync(descriptor.executable, descriptor.args, {
    cwd: descriptor.cwd || workingDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-100_000);
  return {
    command: descriptor.command,
    status: !result.error && result.status === 0 ? 'passed' : 'failed',
    exit_code: result.status,
    output: result.error ? `${result.error.message}\n${output}`.trim() : output,
  };
}

export function runCitadelChecks(
  workingDir: string,
  timeoutMs = 900_000,
  ticketVerificationCommands: string[] = [],
): CitadelCheckResult[] {
  const packageChecks = ['typecheck', 'lint', 'test']
    .map((script) => runSynchronousCitadelCheck(packageCheckDescriptor(workingDir, script), workingDir, timeoutMs));
  const ticketChecks = uniqueStrings(ticketVerificationCommands).map((command) => {
    const result = spawnSync(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-100_000);
    return {
      command,
      status: !result.error && result.status === 0 ? 'passed' as const : 'failed' as const,
      exit_code: result.status,
      output: result.error ? `${result.error.message}\n${output}`.trim() : output,
    };
  });
  return [...packageChecks, ...ticketChecks];
}

export interface CitadelCheckDescriptor {
  command: string;
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  skipped?: boolean;
  verificationStep?: VerificationStep;
  allowedRoots?: string[];
  trustedWorkInventory?: CitadelTrustedWorkInventory;
}

function canonicalCitadelCheckCwd(workingDir: string, requestedCwd?: string): string {
  const candidate = path.resolve(workingDir, requestedCwd || '.');
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function canonicalCitadelCheckEnv(env: NodeJS.ProcessEnv): Array<[string, string | null]> {
  // These shell bookkeeping variables are not command inputs: cwd is bound
  // independently and shells rewrite the others while preserving the effective
  // execution environment. Excluding them keeps recovery identity stable across
  // the supervisor boundary without dropping PATH, credentials, or tool config.
  const shellBookkeeping = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'NODE_TEST_CONTEXT']);
  return Object.keys(env).filter((name) => !shellBookkeeping.has(name)).sort()
    .map((name) => [name, env[name] ?? null]);
}

export function citadelCheckExecutionIdentity(
  descriptor: Pick<CitadelCheckDescriptor, 'executable' | 'args' | 'cwd' | 'env' | 'skipped'>,
  workingDir: string,
): string {
  return JSON.stringify({
    cwd: canonicalCitadelCheckCwd(workingDir, descriptor.cwd),
    executable: descriptor.executable,
    args: descriptor.args,
    env: canonicalCitadelCheckEnv(descriptor.env || process.env),
    skipped: descriptor.skipped === true,
  });
}

function citadelLogicalCheckExecutionIdentity(
  descriptor: Pick<CitadelCheckDescriptor, 'executable' | 'args' | 'cwd' | 'env' | 'skipped'>,
  workingDir: string,
): string {
  const root = canonicalCitadelCheckCwd(workingDir);
  const actualCwd = canonicalCitadelCheckCwd(workingDir, descriptor.cwd);
  const relative = path.relative(root, actualCwd);
  const logicalCwd = relative === '' ? '$CITADEL_WORKTREE'
    : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? `$CITADEL_WORKTREE/${relative.split(path.sep).join('/')}`
      : actualCwd;
  return reportHash({
    cwd: logicalCwd,
    executable: descriptor.executable,
    args: descriptor.args,
    environment_hash: reportHash(canonicalCitadelCheckEnv(descriptor.env || process.env)),
    skipped: descriptor.skipped === true,
  });
}

function citadelTrustedInventoryBinding(
  inventory: CitadelTrustedWorkInventory,
  workingDir: string,
): Record<string, unknown> {
  const binding = {
    schema_version: inventory.schema_version,
    adapter_id: inventory.adapter_id,
    environment_hash: inventory.environment_hash,
    script_hashes: inventory.script_hashes,
    timeout_policy: inventory.timeout_policy,
    whole_gate_timeout_ms: inventory.whole_gate_timeout_ms,
    items: inventory.items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      command: item.command,
      executable: item.executable,
      args: item.args,
      execution_identity: citadelLogicalCheckExecutionIdentity({
        executable: item.executable,
        args: item.args,
        cwd: item.cwd,
      }, workingDir),
      inactivity_timeout_ms: item.inactivity_timeout_ms,
      absolute_timeout_ms: item.absolute_timeout_ms,
    })),
  };
  return { ...binding, inventory_id: reportHash(binding) };
}

export function deduplicateCitadelCheckExecutions<T extends CitadelCheckDescriptor>(
  descriptors: T[],
  workingDir: string,
): T[] {
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    const identity = citadelCheckExecutionIdentity(descriptor, workingDir);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function resolveCitadelCheckCwd(workingDir: string, requestedCwd: string): string {
  const root = fs.realpathSync(workingDir);
  const candidate = path.resolve(root, requestedCwd);
  let resolved = candidate;
  try { resolved = fs.realpathSync(candidate); } catch { /* spawn reports a missing cwd after containment is established */ }
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Citadel verification cwd escapes the isolated release worktree: ${requestedCwd}`);
  }
  return candidate;
}

function citadelCheckDescriptors(
  workingDir: string,
  sessionDir: string,
  ticketVerificationSteps: VerificationStep[],
  repositoryHygieneRange?: string,
): CitadelCheckDescriptor[] {
  const packageChecks = ['typecheck', 'lint', 'test']
    .map((script) => packageCheckDescriptor(workingDir, script));
  const repositoryCheck: CitadelCheckDescriptor = {
    command: 'git diff --check',
    executable: 'git',
    args: ['diff', '--check', ...(repositoryHygieneRange ? [repositoryHygieneRange] : [])],
  };
  const ticketChecks = ticketVerificationSteps.map((step): CitadelCheckDescriptor => {
    const command = verificationStepCommand(step);
    let stepCwd: string;
    try {
      stepCwd = assertVerificationStepSafe(step, { cwd: workingDir, allowedRoots: [sessionDir] });
    } catch (error) {
      if (error instanceof Error && /verification cwd|package verification cwd/.test(error.message)) {
        throw new Error(
          `Citadel verification cwd escapes the isolated release worktree or session root: ${step.cwd || workingDir}`,
          { cause: error },
        );
      }
      throw error;
    }
    return {
      command: command.display,
      executable: command.executable,
      args: command.args,
      cwd: stepCwd,
      verificationStep: step,
      allowedRoots: [sessionDir],
    };
  });
  return [...packageChecks, repositoryCheck, ...ticketChecks];
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = Number(child.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* fall through to direct leader */ }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

function processGroupAlive(child: ChildProcess): boolean {
  const pid = Number(child.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

async function drainProcessTree(child: ChildProcess, timeoutMs = 2_000): Promise<boolean> {
  signalProcessTree(child, 'SIGKILL');
  const deadline = performance.now() + timeoutMs;
  while (processGroupAlive(child) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupAlive(child);
}

const CITADEL_CHECK_CALLBACK_TIMEOUT_MS = 2_000;
const CITADEL_CHECK_TERM_GRACE_MS = 1_000;
const CITADEL_CHECK_DRAIN_TIMEOUT_MS = 2_500;

async function boundedCitadelLifecycleCall<T>(
  label: string,
  callback: () => T | Promise<T>,
  timeoutMs = CITADEL_CHECK_CALLBACK_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runMonitoredCitadelCheck(
  descriptor: CitadelCheckDescriptor,
  workingDir: string,
  options: CitadelCheckRunOptions,
): Promise<CitadelCheckResult> {
  if (descriptor.skipped) {
    return { command: descriptor.command, status: 'skipped', exit_code: null, output: 'script not defined' };
  }
  if (options.isCancelled()) throw new CitadelChecksCancelledError();
  if (descriptor.verificationStep) {
    descriptor.cwd = assertVerificationStepSafe(descriptor.verificationStep, {
      cwd: workingDir,
      allowedRoots: descriptor.allowedRoots,
    });
  }
  return await new Promise<CitadelCheckResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBufferedBytes = 0;
    let stderrBufferedBytes = 0;
    let settling = false;
    let settled = false;
    let timedOut = false;
    let timeoutKind: 'inactivity' | 'absolute' | null = null;
    let cancelled = false;
    const startedAt = performance.now();
    let outputBytes = 0;
    let observedExitCode: number | null = null;
    let spawnCallbackComplete = false;
    let pendingCloseCode: number | null | undefined;
    let pendingProcessError: unknown;
    let spawnCallbackError: unknown;
    let markSpawnCallbackFinished: (() => void) | null = null;
    const spawnCallbackFinished = new Promise<void>((done) => { markSpawnCallbackFinished = done; });
    let markChildClosed: (() => void) | null = null;
    const childClosed = new Promise<void>((done) => { markChildClosed = done; });
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: descriptor.cwd || workingDir,
      env: descriptor.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const absoluteTimeoutMs = Math.max(1, options.absoluteTimeoutMs ?? options.timeoutMs);
    let inactivityTimeout: NodeJS.Timeout | null = null;
    let absoluteTimeout: NodeJS.Timeout | null = null;
    let cancelPoll: NodeJS.Timeout | null = null;
    let inactivityDeadline = Number.POSITIVE_INFINITY;
    let absoluteDeadline = Number.POSITIVE_INFINITY;
    const cleanupTimers = (): void => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      if (cancelPoll) clearInterval(cancelPoll);
    };
    const recordProgress = (chunks: Buffer[], chunk: Buffer, bufferedBytes: number): number => {
      const copy = Buffer.from(chunk);
      const retained = copy.byteLength > 100_000 ? copy.subarray(copy.byteLength - 100_000) : copy;
      chunks.push(retained);
      bufferedBytes += retained.byteLength;
      while (bufferedBytes > 100_000 && chunks.length > 1) {
        bufferedBytes -= chunks.shift()?.byteLength || 0;
      }
      if (bufferedBytes > 100_000 && chunks[0]) {
        chunks[0] = chunks[0].subarray(bufferedBytes - 100_000);
      }
      outputBytes += copy.byteLength;
      return Math.min(bufferedBytes, 100_000);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBufferedBytes = recordProgress(stdout, chunk, stdoutBufferedBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBufferedBytes = recordProgress(stderr, chunk, stderrBufferedBytes);
    });
    const capturedOutput = (): { output: string; retainedBytes: number } => {
      const combined = Buffer.concat([Buffer.concat(stdout), Buffer.from('\n'), Buffer.concat(stderr)]);
      const retained = combined.byteLength > 100_000
        ? combined.subarray(combined.byteLength - 100_000) : combined;
      return { output: retained.toString('utf8').trim(), retainedBytes: Math.min(outputBytes, retained.byteLength) };
    };
    const settle = async (input: {
      code: number | null;
      error?: unknown;
      forceTerminate?: boolean;
    }): Promise<void> => {
      if (settling || settled) return;
      settling = true;
      cleanupTimers();
      const lifecycleErrors: string[] = [];
      const settlementNow = performance.now();
      if (!timedOut && !input.error && !input.forceTerminate) {
        if (settlementNow >= absoluteDeadline && absoluteDeadline <= inactivityDeadline) {
          timedOut = true;
          timeoutKind = 'absolute';
        } else if (settlementNow >= inactivityDeadline) {
          timedOut = true;
          timeoutKind = 'inactivity';
        } else if (settlementNow >= absoluteDeadline) {
          timedOut = true;
          timeoutKind = 'absolute';
        }
      }
      let cancelledAtSettlement = cancelled;
      try {
        cancelledAtSettlement = cancelledAtSettlement || options.isCancelled();
      } catch (error) {
        cancelledAtSettlement = true;
        lifecycleErrors.push(`cancellation check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (cancelledAtSettlement) cancelled = true;
      if (input.forceTerminate || timedOut || cancelledAtSettlement) {
        signalProcessTree(child, 'SIGTERM');
        await Promise.race([
          childClosed,
          new Promise<void>((done) => { setTimeout(done, CITADEL_CHECK_TERM_GRACE_MS); }),
        ]);
        signalProcessTree(child, 'SIGKILL');
      }
      let drained = !(input.forceTerminate || timedOut || cancelledAtSettlement || processGroupAlive(child));
      if (!drained) {
        try {
          drained = await boundedCitadelLifecycleCall(
            'Citadel process-tree drain',
            () => (options.drainProcessTree || drainProcessTree)(child),
            CITADEL_CHECK_DRAIN_TIMEOUT_MS,
          );
        } catch (error) {
          drained = false;
          lifecycleErrors.push(`process-tree drain failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // onExit must never race ahead of the fence-persistence callback. The
      // callback is independently bounded, while TERM/KILL/drain above remain
      // free to enforce the process deadline immediately.
      await spawnCallbackFinished;
      const effectiveError = input.error ?? spawnCallbackError;
      try {
        await boundedCitadelLifecycleCall(
          'Citadel onExit callback',
          () => options.onExit({ quiescent: drained, cancelled: cancelledAtSettlement, timedOut }),
        );
      } catch (error) {
        drained = false;
        lifecycleErrors.push(`onExit callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      settled = true;
      settling = false;
      if (cancelledAtSettlement) {
        reject(new CitadelChecksCancelledError());
        return;
      }
      const captured = capturedOutput();
      const baseError = effectiveError instanceof Error ? effectiveError.message
        : effectiveError === undefined ? null : String(effectiveError);
      const output = [captured.output,
        ...(baseError ? [`Citadel check process failed: ${baseError}`] : []),
        ...(timedOut ? [timeoutKind === 'absolute'
          ? `Citadel check reached its immutable absolute timeout after ${absoluteTimeoutMs}ms.`
          : `Citadel check timed out after ${options.timeoutMs}ms without trusted semantic progress.`] : []),
        ...lifecycleErrors,
        ...(drained ? [] : ['Citadel process tree did not quiesce; subsequent checks were suppressed.'])]
        .filter(Boolean).join('\n');
      resolve({
        command: descriptor.command,
        status: !timedOut && drained && input.code === 0 && !baseError && lifecycleErrors.length === 0
          ? 'passed' : 'failed',
        exit_code: input.code ?? observedExitCode,
        output,
        output_bytes: outputBytes,
        output_dropped_bytes: Math.max(0, outputBytes - captured.retainedBytes),
        output_truncated: outputBytes > captured.retainedBytes,
        elapsed_ms: Math.round(performance.now() - startedAt),
        ...(timedOut ? {
          timed_out: true,
          timeout_kind: timeoutKind || 'inactivity',
          inactivity_timeout_ms: options.timeoutMs,
          absolute_timeout_ms: absoluteTimeoutMs,
        } : {}),
        ...(lifecycleErrors.length ? { lifecycle_error: lifecycleErrors.join('; ') } : {}),
        ...(drained ? {} : { process_tree_quiescent: false as const }),
      });
    };
    const triggerTimeout = (kind: 'inactivity' | 'absolute'): void => {
      if (timedOut || cancelled || settling || settled) return;
      timedOut = true;
      timeoutKind = kind;
      void settle({ code: child.exitCode, forceTerminate: true });
    };
    child.once('error', (error) => {
      pendingProcessError = error;
      if (spawnCallbackComplete) void settle({ code: child.exitCode, error, forceTerminate: true });
    });
    child.once('close', (code) => {
      observedExitCode = code;
      pendingCloseCode = code;
      markChildClosed?.();
      if (spawnCallbackComplete) void settle({ code, error: pendingProcessError });
    });
    const deadlineBase = performance.now();
    inactivityDeadline = deadlineBase + options.timeoutMs;
    absoluteDeadline = deadlineBase + absoluteTimeoutMs;
    inactivityTimeout = setTimeout(() => triggerTimeout('inactivity'), options.timeoutMs);
    inactivityTimeout.unref?.();
    absoluteTimeout = setTimeout(() => triggerTimeout('absolute'), absoluteTimeoutMs);
    absoluteTimeout.unref?.();
    cancelPoll = setInterval(() => {
      if (settling || settled) return;
      let requested: boolean;
      try { requested = options.isCancelled(); } catch { requested = true; }
      if (!requested) return;
      cancelled = true;
      void settle({ code: child.exitCode, forceTerminate: true });
    }, options.cancelPollMs ?? 100);
    cancelPoll.unref?.();
    void boundedCitadelLifecycleCall(
      'Citadel onSpawn callback',
      () => options.onSpawn(child, descriptor.command),
    ).then(() => {
      spawnCallbackComplete = true;
      markSpawnCallbackFinished?.();
      if (settling || settled) return;
      if (pendingProcessError !== undefined || pendingCloseCode !== undefined) {
        void settle({
          code: pendingCloseCode ?? child.exitCode,
          error: pendingProcessError,
          forceTerminate: pendingProcessError !== undefined,
        });
        return;
      }
    }, (error) => {
      spawnCallbackComplete = true;
      spawnCallbackError = error;
      markSpawnCallbackFinished?.();
      void settle({ code: child.exitCode, error, forceTerminate: true });
    });
  });
}

export async function runCitadelChecksMonitored(
  workingDir: string,
  sessionDir: string,
  ticketVerificationSteps: VerificationStep[],
  options: CitadelCheckRunOptions,
): Promise<CitadelCheckResult[]> {
  const results: CitadelCheckResult[] = [];
  const discoveredDescriptors = citadelCheckDescriptors(
    workingDir,
    sessionDir,
    ticketVerificationSteps,
    options.repositoryHygieneRange,
  );
  if (options.environment) {
    for (const descriptor of discoveredDescriptors) descriptor.env = options.environment;
  }
  const descriptors = deduplicateCitadelCheckExecutions(discoveredDescriptors, workingDir);
  for (const descriptor of descriptors) {
    if (descriptor.executable === 'npm' && JSON.stringify(descriptor.args) === JSON.stringify(['run', 'test'])) {
      descriptor.trustedWorkInventory = resolvePickleTrustedTestInventory(
        workingDir, options.timeoutMs, descriptor.env || process.env,
      ) || undefined;
    }
  }
  const trustedInventories = descriptors.flatMap((descriptor) => descriptor.trustedWorkInventory || []);
  const derivedWholeGateTimeoutMs = trustedInventories.length > 0
    ? Math.max(...trustedInventories.map((inventory) => inventory.whole_gate_timeout_ms))
    : options.timeoutMs * Math.max(1, descriptors.filter((descriptor) => !descriptor.skipped).length);
  const wholeGateTimeoutMs = options.wholeGateTimeoutMs ?? derivedWholeGateTimeoutMs;
  const gateStartedAt = performance.now();
  const journalPath = path.join(sessionDir, 'citadel-deterministic-check-journal.json');
  const journal: Record<string, unknown> = {
    schema_version: 1,
    status: 'running',
    whole_gate_timeout_ms: wholeGateTimeoutMs,
    inventories: trustedInventories,
    binding_hash: options.journalBindingHash ?? null,
    checks: [],
    started_at: new Date().toISOString(),
  };
  const persistJournal = (): void => atomicWriteJson(journalPath, journal);
  const assertNotCancelled = (): void => {
    let cancellationRequested: boolean;
    try { cancellationRequested = options.isCancelled(); } catch { cancellationRequested = true; }
    if (cancellationRequested) throw new CitadelChecksCancelledError();
  };
  const enforceWholeGateBoundary = (result: CitadelCheckResult): CitadelCheckResult => {
    const elapsedMs = performance.now() - gateStartedAt;
    if (result.status !== 'passed' || elapsedMs < wholeGateTimeoutMs) return result;
    return {
      ...result,
      status: 'failed',
      output: [
        result.output,
        `Citadel deterministic gate reached its immutable whole-gate cap after ${wholeGateTimeoutMs}ms.`,
      ].filter(Boolean).join('\n'),
      timed_out: true,
      timeout_kind: 'absolute',
      inactivity_timeout_ms: result.inactivity_timeout_ms ?? options.timeoutMs,
      absolute_timeout_ms: wholeGateTimeoutMs,
      elapsed_ms: Math.round(elapsedMs),
    };
  };
  persistJournal();
  try {
    for (const descriptor of descriptors) {
      assertNotCancelled();
      const elapsedMs = performance.now() - gateStartedAt;
      const remainingGateMs = Math.floor(wholeGateTimeoutMs - elapsedMs);
      if (remainingGateMs <= 0) {
        const gateCapResult: CitadelCheckResult = {
          command: descriptor.command,
          status: 'failed',
          exit_code: null,
          output: `Citadel deterministic gate reached its immutable whole-gate cap after ${wholeGateTimeoutMs}ms.`,
          timed_out: true,
          timeout_kind: 'absolute',
          inactivity_timeout_ms: options.timeoutMs,
          absolute_timeout_ms: wholeGateTimeoutMs,
          elapsed_ms: Math.round(elapsedMs),
        };
        results.push(gateCapResult);
        journal.checks = results.map((check) => ({
          command: check.command,
          status: check.status,
          exit_code: check.exit_code,
          timed_out: check.timed_out || false,
          process_tree_quiescent: check.process_tree_quiescent !== false,
        }));
        persistJournal();
        break;
      }
      let result: CitadelCheckResult;
      const inventory = descriptor.trustedWorkInventory;
      if (!inventory) {
        result = await runMonitoredCitadelCheck(descriptor, workingDir, {
          ...options,
          timeoutMs: options.timeoutMs,
          absoluteTimeoutMs: Math.min(options.timeoutMs, remainingGateMs),
        });
        assertNotCancelled();
        result = enforceWholeGateBoundary(result);
      } else {
        const itemResults: Array<{ item_id: string; ordinal: number; result: CitadelCheckResult }> = [];
        let lastProgressAt: string | null = null;
        let gateCapFailure: CitadelCheckResult | null = null;
        for (const item of inventory.items) {
          const itemRemainingGateMs = Math.floor(wholeGateTimeoutMs - (performance.now() - gateStartedAt));
          if (itemRemainingGateMs <= 0) {
            gateCapFailure = {
              command: item.command,
              status: 'failed',
              exit_code: null,
              output: `Citadel deterministic gate reached its immutable whole-gate cap after ${wholeGateTimeoutMs}ms before trusted item ${item.id}.`,
              timed_out: true,
              timeout_kind: 'absolute',
              inactivity_timeout_ms: item.inactivity_timeout_ms,
              absolute_timeout_ms: wholeGateTimeoutMs,
              elapsed_ms: Math.round(performance.now() - gateStartedAt),
            };
            break;
          }
          journal.active_check = descriptor.command;
          journal.active_inventory_id = inventory.inventory_id;
          journal.active_item = {
            id: item.id,
            ordinal: item.ordinal,
            execution_identity: item.execution_identity,
            started_at: new Date().toISOString(),
          };
          persistJournal();
          const itemAbsoluteTimeoutMs = Math.min(item.absolute_timeout_ms, itemRemainingGateMs);
          let itemResult = await runMonitoredCitadelCheck({
            command: item.command,
            executable: item.executable,
            args: item.args,
            cwd: item.cwd,
            env: descriptor.env,
          }, workingDir, {
            ...options,
            timeoutMs: item.inactivity_timeout_ms,
            absoluteTimeoutMs: itemAbsoluteTimeoutMs,
          });
          assertNotCancelled();
          itemResult = enforceWholeGateBoundary(itemResult);
          itemResults.push({ item_id: item.id, ordinal: item.ordinal, result: itemResult });
          if (itemResult.status === 'passed') lastProgressAt = new Date().toISOString();
          journal.active_item = null;
          journal.completed_items = itemResults.map(({ item_id, ordinal, result: completed }) => ({
            item_id,
            ordinal,
            status: completed.status,
            exit_code: completed.exit_code,
            timed_out: completed.timed_out || false,
            timeout_kind: completed.timeout_kind || null,
            elapsed_ms: completed.elapsed_ms ?? null,
            process_tree_quiescent: completed.process_tree_quiescent !== false,
            output_bytes: completed.output_bytes || 0,
            output_dropped_bytes: completed.output_dropped_bytes || 0,
            output_truncated: completed.output_truncated || false,
            lifecycle_error: completed.lifecycle_error || null,
            output_tail: completed.output.slice(-10_000),
          }));
          persistJournal();
          if (itemResult.status !== 'passed' || itemResult.process_tree_quiescent === false) break;
        }
        const failedItem = itemResults.find(({ result: itemResult }) => itemResult.status !== 'passed')?.result
          || gateCapFailure;
        const completedAll = itemResults.length === inventory.items.length
          && itemResults.every(({ result: itemResult }) => itemResult.status === 'passed');
        const aggregateOutputBytes = itemResults.reduce(
          (sum, entry) => sum + (entry.result.output_bytes || 0), 0,
        );
        const assembledOutput = Buffer.from([
          ...itemResults.map(({ item_id, result: itemResult }) => (
            `[trusted-item ${item_id}]\n${itemResult.output}`
          )),
          ...(gateCapFailure ? [gateCapFailure.output] : []),
        ].join('\n'));
        const retainedAggregateOutput = assembledOutput.byteLength > 100_000
          ? assembledOutput.subarray(assembledOutput.byteLength - 100_000) : assembledOutput;
        result = {
          command: descriptor.command,
          status: completedAll ? 'passed' : 'failed',
          exit_code: completedAll ? 0 : (failedItem?.exit_code ?? null),
          output: retainedAggregateOutput.toString('utf8'),
          semantic_progress_count: itemResults.filter(({ result: itemResult }) => itemResult.status === 'passed').length,
          last_progress_identity: [...itemResults].reverse()
            .find(({ result: itemResult }) => itemResult.status === 'passed')?.item_id || null,
          ...(lastProgressAt ? { last_progress_at: lastProgressAt } : {}),
          output_bytes: aggregateOutputBytes,
          output_dropped_bytes: Math.max(0, aggregateOutputBytes - retainedAggregateOutput.byteLength),
          output_truncated: aggregateOutputBytes > retainedAggregateOutput.byteLength,
          ...(failedItem?.timed_out ? {
            timed_out: true,
            timeout_kind: failedItem.timeout_kind,
            inactivity_timeout_ms: failedItem.inactivity_timeout_ms,
            absolute_timeout_ms: failedItem.absolute_timeout_ms,
            elapsed_ms: failedItem.elapsed_ms,
          } : {}),
          ...(failedItem?.process_tree_quiescent === false ? { process_tree_quiescent: false as const } : {}),
        };
      }
      assertNotCancelled();
      results.push(result);
      journal.checks = results.map((check) => ({
        command: check.command,
        status: check.status,
        exit_code: check.exit_code,
        timed_out: check.timed_out || false,
        timeout_kind: check.timeout_kind || null,
        elapsed_ms: check.elapsed_ms ?? null,
        output_bytes: check.output_bytes || 0,
        output_dropped_bytes: check.output_dropped_bytes || 0,
        output_truncated: check.output_truncated || false,
        lifecycle_error: check.lifecycle_error || null,
        process_tree_quiescent: check.process_tree_quiescent !== false,
      }));
      persistJournal();
      if (result.timed_out || result.process_tree_quiescent === false) break;
    }
    assertNotCancelled();
    journal.status = 'completed';
    journal.active_check = null;
    journal.active_inventory_id = null;
    journal.active_item = null;
    journal.checks_hash = reportHash(results);
    journal.completed_at = new Date().toISOString();
    persistJournal();
    return results;
  } catch (error) {
    journal.status = 'interrupted';
    journal.error = error instanceof Error ? error.message : String(error);
    journal.interrupted_at = new Date().toISOString();
    persistJournal();
    throw error;
  }
}

function buildCitadelPrompt(
  sessionDir: string,
  reviewedRange: string,
  checksPath: string,
  expectedAcceptanceCriteria: string[],
  reportPath: string = citadelReportPath(sessionDir),
  retryFeedback: string | null = null,
  recoveryStrategy: string | null = null,
  recoveryExecution: string[] = [],
): string {
  return [
    'You are the Citadel release reviewer for a Pickle Rick pipeline.',
    'This is a read-only adversarial review. Do not modify, stage, commit, or revert repository files.',
    `Review git range: ${reviewedRange}`,
    `Read deterministic check results: ${checksPath}`,
    'Read the PRD, refined PRD, ticket manifests, completion evidence, and changed code available in the repository/session.',
    `Required acceptance criteria (copy each exact string into acceptance_criteria_checked): ${JSON.stringify(expectedAcceptanceCriteria)}`,
    'Check acceptance-criteria coverage, correctness, cross-file contract drift, missing tests, unsafe mutations, and release blockers.',
    'Only report findings supported by concrete file/line or command evidence. Do not report style preferences as release blockers.',
    `Citadel report path: ${reportPath}`,
    'Write exactly one JSON object there with keys: schema_version, verdict, reviewed_range, acceptance_criteria_checked, findings, generated_at.',
    'Each finding must have severity (critical|high|medium|low|info), title, evidence, file, line, recommendation, ticket_ids, acceptance_criteria, and paths.',
    'For every critical/high finding, ticket_ids, acceptance_criteria, and paths must each be non-empty and identify the exact affected tickets, criteria, and repository-relative paths.',
    'Use verdict block when any critical/high finding exists; otherwise approve.',
    'After writing the report, return <promise>THE_CITADEL_APPROVES</promise>.',
    ...(retryFeedback ? [`The previous candidate was rejected: ${retryFeedback}. Write a complete fresh candidate.`] : []),
    ...(recoveryStrategy ? [`Recovery strategy: ${recoveryStrategy}`] : []),
    ...recoveryExecution,
  ].join('\n\n');
}

interface ArtifactContractAttemptRuntime {
  prompt: string[];
  validatorEvidencePath: string;
  assertInputsUnchanged: () => void;
  validateCandidate: () => void;
}

function prepareArtifactContractAttempt(
  attemptDir: string,
  candidatePath: string,
  execution: ArtifactContractExecution,
): ArtifactContractAttemptRuntime {
  const runtimeDir = path.join(attemptDir, 'artifact-contract-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(runtimeDir, 'runtime-manifest.json');
  const validatorPath = path.join(runtimeDir, 'validate-citadel-candidate.mjs');
  const mechanismInputPath = path.join(
    runtimeDir,
    execution.mechanism === 'schema_scaffold_replay'
      ? 'citadel-report-scaffold.json'
      : execution.mechanism === 'evidence_bundle_reconstruction'
        ? 'evidence-bundle.json' : 'criterion-shard-bundle.json',
  );
  fs.copyFileSync(execution.manifestPath, manifestPath);
  fs.copyFileSync(execution.validatorPath, validatorPath);
  fs.copyFileSync(
    (execution.scaffoldPath ?? execution.evidenceBundlePath ?? execution.criterionShardBundlePath)!,
    mechanismInputPath,
  );
  fs.chmodSync(manifestPath, 0o400);
  fs.chmodSync(mechanismInputPath, 0o400);
  fs.chmodSync(validatorPath, 0o500);
  if (execution.mechanism === 'schema_scaffold_replay') {
    fs.copyFileSync(mechanismInputPath, candidatePath);
    fs.chmodSync(candidatePath, 0o600);
  }
  const inputHashes = {
    manifest: fileHash(manifestPath),
    validator: fileHash(validatorPath),
    mechanism_input: fileHash(mechanismInputPath),
  };
  const validatorEvidencePath = path.join(attemptDir, 'citadel-validator-evidence.json');
  const validatorCommand = `node ${JSON.stringify(validatorPath)} ${JSON.stringify(candidatePath)}`;
  const assertInputsUnchanged = (): void => {
    if (fileHash(manifestPath) !== inputHashes.manifest
      || fileHash(validatorPath) !== inputHashes.validator
      || fileHash(mechanismInputPath) !== inputHashes.mechanism_input) {
      throw new Error('Invalid Citadel reviewer artifact: closed recovery mechanism inputs were modified.');
    }
  };
  const validateCandidate = (): void => {
    assertInputsUnchanged();
    const validation = spawnSync(process.execPath, [validatorPath, candidatePath], {
      cwd: attemptDir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const evidence = {
      schema_version: 1,
      mechanism: execution.mechanism,
      validator_command: validatorCommand,
      exit_code: validation.status,
      stdout: validation.stdout || '',
      stderr: validation.stderr || '',
      candidate_hash: fs.existsSync(candidatePath) ? fileHash(candidatePath) : null,
      runtime_input_hashes: inputHashes,
      validated_at: new Date().toISOString(),
    };
    atomicWriteJson(validatorEvidencePath, evidence);
    if (validation.error || validation.status !== 0) {
      throw new Error(`Invalid Citadel reviewer artifact: deterministic runtime validator rejected the candidate: ${validation.error?.message || validation.stderr || `exit ${validation.status}`}`);
    }
  };
  const mechanismPrompt = execution.mechanism === 'schema_scaffold_replay'
    ? [
        'Closed reviewer execution mechanism: schema_scaffold_replay.',
        `The candidate path is preseeded from this canonical exact-range/exact-criteria scaffold: ${mechanismInputPath}`,
        'Preserve its canonical keys, exact reviewed_range, and exact acceptance_criteria_checked while replacing placeholders after the adversarial review.',
      ]
    : execution.mechanism === 'evidence_bundle_reconstruction' ? [
        'Closed reviewer execution mechanism: evidence_bundle_reconstruction.',
        `Reconstruct the candidate by reading this immutable deterministic evidence bundle: ${mechanismInputPath}`,
        'Ground the report in its exact checks, failed-candidate hashes, validation failures, range, criteria, and validator invariants.',
      ] : [
        'Closed reviewer execution mechanism: criterion_sharded_reconstruction.',
        `Reconcile the independently reviewed typed criterion shards in this immutable bundle: ${mechanismInputPath}`,
        'Cover every exact acceptance criterion once, preserve cross-criterion blocking findings, and independently decide the canonical aggregate verdict.',
      ];
  return {
    prompt: [
      ...mechanismPrompt,
      `Authenticated runtime manifest copy: ${manifestPath}`,
      `Deterministic validator invocation: ${validatorCommand}`,
      `The controller persists deterministic validator evidence at: ${validatorEvidencePath}`,
      'Run the validator and repair the candidate until it exits zero before returning the approval token.',
    ],
    validatorEvidencePath,
    assertInputsUnchanged,
    validateCandidate,
  };
}

/** Preserve evidence, then restore the clean release checkpoint before returning control. */
function restoreMutatedCitadelCheckpoint(
  workingDir: string,
  sessionDir: string,
  checkpointHead: string,
  checkpointFingerprint: string,
  source: string,
): boolean {
  if (getCitadelRepositoryFingerprint(workingDir) === checkpointFingerprint) return false;
  const suffix = source.replace(/[^a-zA-Z0-9_-]/g, '-');
  recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: checkpointHead,
    operation: `citadel-${suffix}`,
    ownedPaths: listChangedPathsSince(workingDir, checkpointHead),
    headRecoveryRef: `refs/pickle/salvage/${path.basename(sessionDir)}-citadel-${suffix}`,
  });
  if (getCitadelRepositoryFingerprint(workingDir) !== checkpointFingerprint) {
    throw new Error(`Citadel could not restore its clean checkpoint after ${source} mutation.`);
  }
  return true;
}

function persistCitadelSystemBlock(
  sessionDir: string,
  input: Pick<CitadelSystemBlockArtifact,
    'category' | 'code' | 'reviewed_range' | 'title' | 'evidence' | 'recommendation' | 'checks'
    | 'recovery_action' | 'recovery_ticket_ids'>,
): CitadelSystemBlockArtifact {
  const failureIdentity = citadelSystemBlockFailureIdentity(input);
  const prior = readCitadelSystemBlock(sessionDir);
  const attempt = prior?.failure_identity === failureIdentity ? prior.attempt + 1 : 1;
  const boundedAttempt = ((attempt - 1) % 2) + 1;
  const artifact: CitadelSystemBlockArtifact = {
    schema_version: 1,
    artifact_kind: 'citadel_system_block',
    category: input.category,
    code: input.code,
    reviewed_range: input.reviewed_range,
    title: input.title,
    evidence: input.evidence,
    recommendation: input.recommendation,
    checks: input.checks,
    recovery_action: input.recovery_action,
    recovery_ticket_ids: input.recovery_ticket_ids,
    failure_identity: failureIdentity,
    attempt,
    recovery_epoch: Math.ceil(attempt / 2),
    bounded_attempt: boundedAttempt,
    next_action: boundedAttempt === 1 ? 'retry_phase' : 'restart_executor',
    generated_at: new Date().toISOString(),
  };
  fs.rmSync(citadelReportPath(sessionDir), { force: true });
  atomicWriteJson(citadelSystemBlockPath(sessionDir), artifact);
  return readCitadelSystemBlock(sessionDir)!;
}

function reachableCitadelBase(workingDir: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const resolved = spawnSync('git', ['rev-parse', '--verify', `${candidate.trim()}^{commit}`], {
    cwd: workingDir,
    encoding: 'utf8',
  });
  if (resolved.status !== 0) return null;
  const sha = resolved.stdout.trim();
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: workingDir });
  return ancestor.status === 0 ? sha : null;
}

export function recoverCitadelStartCommit(
  manager: StateManager,
  statePath: string,
  state: Record<string, unknown>,
  workingDir: string,
): string | null {
  const scope = readJsonFile<Record<string, unknown>>(path.join(path.dirname(statePath), 'scope.json'), null);
  let startCommit = reachableCitadelBase(workingDir, state.start_commit)
    || reachableCitadelBase(workingDir, state.pinned_sha)
    || reachableCitadelBase(workingDir, scope?.review_base);
  if (!startCommit) {
    const roots = spawnSync('git', ['rev-list', '--max-parents=0', '--reverse', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf8',
    });
    if (roots.status === 0) {
      startCommit = roots.stdout.split(/\s+/).map((entry) => entry.trim()).find(Boolean) || null;
    }
  }
  if (!startCommit) return null;
  manager.update(statePath, (current) => {
    current.start_commit = startCommit;
    return current;
  });
  return startCommit;
}

export async function runCitadel(
  sessionDir: string,
  options: {
    assertDurableOwnership?: () => void;
    faultInjection?: (point: 'validated-before-telemetry') => void;
  } = {},
): Promise<'success' | 'citadel-blocked' | 'citadel-system-blocked' | 'cancelled'> {
  let ownershipDrainError: unknown = null;
  const assertOwnership = (): void => {
    if (ownershipDrainError) throw ownershipDrainError;
    options.assertDurableOwnership?.();
  };
  assertOwnership();
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const shouldCancel = (): boolean => {
    const current = manager.read(statePath);
    if (current.last_exit_reason === 'cancelled' || Boolean(current.cancel_requested_at)) return true;
    try { assertOwnership(); return false; } catch (error) { ownershipDrainError = error; return true; }
  };
  const workingDir = String(state.working_dir || '');
  if (!workingDir) {
    throw new Error('Citadel requires a git-backed session with a persisted working_dir.');
  }
  const startCommit = recoverCitadelStartCommit(manager, statePath, state, workingDir);
  assertOwnership();
  if (!startCommit) {
    throw new Error('Citadel could not recover a reachable start_commit for this git-backed session.');
  }
  const preexistingDirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  if (preexistingDirtyPaths.length > 0) {
    throw new Error(`Citadel requires a clean release tree; dirty paths: ${preexistingDirtyPaths.join(', ')}`);
  }
  fs.rmSync(citadelReportPath(sessionDir), { force: true });
  fs.rmSync(path.join(sessionDir, CITADEL_RELEASE_APPROVAL_FILE), { force: true });
  const expectedAcceptanceCriteria = deriveCitadelAcceptanceCriteria(sessionDir);
  const reviewedRange = `${startCommit}..HEAD`;
  const scopeFailure = auditPersistedScopeForCitadel(sessionDir, workingDir);
  if (scopeFailure) {
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'contract',
      code: 'scope_contract_invalid',
      reviewed_range: reviewedRange,
      title: 'Citadel scope contract is invalid',
      evidence: scopeFailure,
      recommendation: 'Repair and revalidate the persisted scope contract before release review.',
      checks: [],
      recovery_action: 'request_prd_revision',
      recovery_ticket_ids: [],
    });
    return 'citadel-system-blocked';
  }
  if (expectedAcceptanceCriteria.length === 0) {
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'contract',
      code: 'acceptance_criteria_missing',
      reviewed_range: reviewedRange,
      title: 'Citadel has no acceptance criteria to verify',
      evidence: 'Neither the refinement manifest nor the session PRD declares acceptance criteria.',
      recommendation: 'Restore the accepted PRD or refinement acceptance-criteria contract before release review.',
      checks: [],
      recovery_action: 'request_prd_revision',
      recovery_ticket_ids: [],
    });
    return 'citadel-system-blocked';
  }
  const checkpointHead = getHeadSha(workingDir);
  const releaseCheckpointFingerprint = getCitadelRepositoryFingerprint(workingDir);
  const assertReleaseWorkspaceUnchanged = (): void => {
    if (getCitadelRepositoryFingerprint(workingDir) !== releaseCheckpointFingerprint) {
      throw new Error('Citadel detected a concurrent mutation in the release workspace; the unattributed user paths were preserved.');
    }
  };
  const isolated = createCitadelWorktree(workingDir, checkpointHead);
  const citadelWorkingDir = isolated.workingDir;
  const checkpointFingerprint = getCitadelRepositoryFingerprint(citadelWorkingDir);
  let preserveIsolatedEvidence = false;
  const restoreIsolatedCheckpoint = (source: string): boolean => {
    try {
      return restoreMutatedCitadelCheckpoint(
        citadelWorkingDir, sessionDir, checkpointHead, checkpointFingerprint, source,
      );
    } catch (error) {
      preserveIsolatedEvidence = true;
      atomicWriteJson(path.join(sessionDir, CITADEL_ISOLATION_QUARANTINE_FILE), {
        schema_version: 1,
        working_dir: citadelWorkingDir,
        source,
        reason: error instanceof Error ? error.message : String(error),
        quarantined_at: new Date().toISOString(),
      });
      throw error;
    }
  };
  try {
  const checksPath = path.join(sessionDir, 'citadel-checks.json');
  const verificationGate = verificationGateFromManifest(sessionDir, citadelWorkingDir);
  if (verificationGate.repairBeforeChecks) {
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'infrastructure',
      code: 'deterministic_gate_unavailable',
      reviewed_range: reviewedRange,
      title: 'Citadel ticket verification contract is missing or malformed',
      evidence: `Seal-bound deterministic verification cannot execute for: ${verificationGate.repairTicketIds.join(', ')}.`,
      recommendation: 'Reconstruct each identified manifest verifier from its exact sealed authorization before release review.',
      checks: [],
      recovery_action: 'repair_verification_contract',
      recovery_ticket_ids: verificationGate.repairTicketIds,
    });
    assertReleaseWorkspaceUnchanged();
    return 'citadel-system-blocked';
  }
  const verificationSteps = verificationGate.steps;
  const deterministicCheckTimeoutMs = Number(state.worker_timeout_seconds || 900) * 1000;
  const checksAuthorityContext = deriveCitadelChecksAuthorityContext(
    sessionDir,
    citadelWorkingDir,
    state,
    startCommit,
    checkpointHead,
    releaseCheckpointFingerprint,
    reviewedRange,
    expectedAcceptanceCriteria,
  );
  const checksBinding = checksAuthorityContext.binding;
  const checksBindingHash = checksAuthorityContext.bindingHash;
  const cachedChecks = readJsonFile<Record<string, unknown>>(checksPath, null);
  const cachedJournal = readJsonFile<Record<string, unknown>>(
    path.join(sessionDir, 'citadel-deterministic-check-journal.json'), null,
  );
  const cachedJournalHash = cachedJournal ? reportHash(cachedJournal) : null;
  const cachedResults = Array.isArray(cachedChecks?.checks)
    ? cachedChecks.checks as CitadelCheckResult[] : null;
  const cachedChecksHash = cachedResults ? reportHash(cachedResults) : null;
  const canReuseChecks = JSON.stringify(cachedChecks?.binding) === JSON.stringify(checksBinding)
    && cachedChecks?.checks_hash === cachedChecksHash
    && cachedJournal?.status === 'completed'
    && cachedJournal?.binding_hash === checksBindingHash
    && cachedJournal?.checks_hash === cachedChecksHash
    && cachedChecks?.journal_hash === cachedJournalHash
    && cachedResults?.some((check) => check.status === 'passed')
    && !cachedResults.some((check) => check.status === 'failed');
  let checks: CitadelCheckResult[];
  if (canReuseChecks && cachedResults) {
    checks = cachedResults;
  } else {
  try {
    assertOwnership();
    checks = await runCitadelChecksMonitored(
      citadelWorkingDir,
      sessionDir,
      verificationSteps,
      {
        timeoutMs: deterministicCheckTimeoutMs,
        repositoryHygieneRange: `${startCommit}..${checkpointHead}`,
        wholeGateTimeoutMs: checksAuthorityContext.wholeGateTimeoutMs,
        journalBindingHash: checksBindingHash,
        isCancelled: shouldCancel,
        onSpawn: (child, command) => {
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'citadel-check';
            current.active_child_command = command;
            // npm and shell launchers may exec in place after spawn. Their PID,
            // process group, session, and start time remain immutable, but the
            // command text legitimately changes. Persist structural ownership
            // so cancellation does not mistake that exec transition for PID reuse.
            current.active_child_identity = captureSpawnedProcessIdentity(
              Number(child.pid), 5, process.pid, { strictCommand: false },
            );
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        onExit: ({ quiescent }) => {
          // A live or unproven process tree remains owned by this immutable
          // identity/fence so the succeeding recovery owner can validate and reap it.
          if (!quiescent || ownershipDrainError) return;
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = null;
            current.active_child_kind = null;
            current.active_child_command = null;
            current.active_child_identity = null;
            current.active_child_controller_pid = null;
            current.active_child_controller_identity = null;
            return current;
          });
        },
      },
    );
    assertOwnership();
  } catch (error) {
    assertReleaseWorkspaceUnchanged();
    if (error instanceof CitadelChecksCancelledError) {
      assertOwnership();
      restoreIsolatedCheckpoint('deterministic-check');
      return 'cancelled';
    }
    const restored = restoreIsolatedCheckpoint('deterministic-check');
    if (restored) {
      throw new Error('A deterministic Citadel check modified the target repository; the clean checkpoint was restored.', { cause: error });
    }
    throw error;
  }
  }
  assertOwnership();
  const completedChecksJournal = readJsonFile<Record<string, unknown>>(
    path.join(sessionDir, 'citadel-deterministic-check-journal.json'), null,
  );
  if (!completedChecksJournal || completedChecksJournal.status !== 'completed'
    || completedChecksJournal.binding_hash !== checksBindingHash
    || completedChecksJournal.checks_hash !== reportHash(checks)) {
    throw new Error('Citadel deterministic-check journal is incomplete or does not match the final check summary.');
  }
  atomicWriteJson(checksPath, {
    schema_version: 1,
    reviewed_range: reviewedRange,
    binding: checksBinding,
    checks_hash: reportHash(checks),
    journal_hash: reportHash(completedChecksJournal),
    checks,
  });
  if (restoreIsolatedCheckpoint('deterministic-check')) {
    assertReleaseWorkspaceUnchanged();
    throw new Error('A deterministic Citadel check modified the target repository; the clean checkpoint was restored.');
  }
  if (checks.some((check) => check.status === 'failed')) {
    const failedChecks = checks.filter((check) => check.status === 'failed');
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'infrastructure',
      code: 'deterministic_check_failed',
      reviewed_range: reviewedRange,
      title: 'Citadel deterministic checks failed before reviewer attribution',
      evidence: failedChecks
        .map((check) => `${check.command}: ${check.output || `exit code ${check.exit_code}`}`)
        .join('\n\n'),
      recommendation: 'Retry the deterministic gate, then escalate through an isolated executor restart if it remains red.',
      checks: failedChecks,
      recovery_action: 'retry_checks',
      recovery_ticket_ids: [],
    });
    assertReleaseWorkspaceUnchanged();
    return 'citadel-system-blocked';
  }
  const hasSubstantiveDeterministicGate = checks.some((check) => (
    check.status === 'passed' && check.command !== 'git diff --check'
  ));
  if (!hasSubstantiveDeterministicGate) {
    const repairTicketIds = verificationGate.repairTicketIds;
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'infrastructure',
      code: 'deterministic_gate_unavailable',
      reviewed_range: reviewedRange,
      title: 'Citadel deterministic gate unavailable',
      evidence: 'No declared substantive typecheck, lint, test, or ticket verification command executed; repository hygiene alone is not a release gate.',
      recommendation: repairTicketIds.length > 0
        ? 'Reconstruct each identified manifest verifier before release review.'
        : 'Approve a revised PRD contract that assigns deterministic verification to an exact ticket.',
      checks,
      recovery_action: repairTicketIds.length > 0 ? 'repair_verification_contract' : 'request_prd_revision',
      recovery_ticket_ids: repairTicketIds,
    });
    assertReleaseWorkspaceUnchanged();
    return 'citadel-system-blocked';
  }

  const reportPath = citadelReportPath(sessionDir);
  const reviewIdentity = crypto.createHash('sha256').update(JSON.stringify({
    reviewed_range: reviewedRange,
    checkpoint_head: checkpointHead,
    checks_hash: reportHash(checks),
    checks_binding_hash: checksBindingHash,
    acceptance_criteria_hash: reportHash(expectedAcceptanceCriteria),
  })).digest('hex');
  const reviewStatePath = path.join(sessionDir, 'citadel-review-state.json');
  const priorReviewState = readJsonFile<CitadelReviewState>(reviewStatePath, null);
  const sameReview = priorReviewState?.schema_version === 1
    && priorReviewState.review_identity === reviewIdentity;
  const reviewState: CitadelReviewState = sameReview ? priorReviewState : {
    schema_version: 1,
    review_identity: reviewIdentity,
    recovery_epoch: 1,
    strategy_id: 'standard-schema-review',
    strategy_hash: '',
    status: 'running',
    attempts: [],
    updated_at: new Date().toISOString(),
  };
  const usedStrategyIds = new Set(reviewState.attempts.map((attempt) => attempt.strategy_id));
  let strategyCatalogExhausted = false;
  if (sameReview && reviewState.status === 'exhausted') {
    const nextStrategy = CITADEL_REVIEWER_STRATEGIES.find((entry) => !usedStrategyIds.has(entry.id));
    if (nextStrategy) {
      reviewState.recovery_epoch += 1;
      reviewState.strategy_id = nextStrategy.id;
      reviewState.status = 'running';
    } else {
      strategyCatalogExhausted = true;
    }
  } else if (sameReview && reviewState.status === 'diagnostic_scheduled') {
    strategyCatalogExhausted = true;
  }
  if (strategyCatalogExhausted) {
    const lastValidationError = [...reviewState.attempts].reverse()
      .find((attempt) => attempt.validation_error)?.validation_error
      || 'Reviewer artifact validation failed without a persisted diagnostic.';
    reviewState.status = 'diagnostic_scheduled';
    writeCitadelReviewState(reviewStatePath, reviewState);
    assertOwnership();
    persistCitadelSystemBlock(sessionDir, {
      category: 'infrastructure',
      code: 'reviewer_artifact_strategy_exhausted',
      reviewed_range: reviewedRange,
      title: 'Citadel reviewer artifact strategies require contract reconstruction',
      evidence: [
        `All bounded reviewer artifact strategies are exhausted for review ${reviewIdentity}.`,
        `Last validation failure: ${lastValidationError}`,
      ].join('\n'),
      recommendation: 'Run a strict artifact-contract diagnostic that derives and persists a new evidence-bound reviewer instruction before retrying Citadel.',
      checks,
      recovery_action: 'repair_reviewer_artifact_contract',
      recovery_ticket_ids: [],
    });
    assertReleaseWorkspaceUnchanged();
    return 'citadel-system-blocked';
  }
  const artifactExecution = reviewState.strategy_id === 'artifact-contract-reconstruction'
    ? artifactContractExecution(
      sessionDir,
        citadelWorkingDir,
        checkpointHead,
        reviewState.artifact_contract_recovery!,
        reviewState.review_identity,
        reviewedRange,
        expectedAcceptanceCriteria,
        checks,
      )
    : null;
  const reviewStrategy = artifactExecution
    ? artifactContractReviewerStrategy(reviewState.artifact_contract_recovery!, artifactExecution)
    : citadelReviewerStrategy(reviewState.strategy_id);
  reviewState.strategy_id = reviewStrategy.id;
  reviewState.strategy_hash = reviewStrategy.hash;
  for (const priorAttempt of reviewState.attempts) {
    if (priorAttempt.epoch === reviewState.recovery_epoch && priorAttempt.status === 'started') {
      priorAttempt.status = 'interrupted';
      priorAttempt.completed_at = new Date().toISOString();
      priorAttempt.validation_error = 'Reviewer attempt was interrupted before durable validation completed.';
    }
  }
  if (reviewState.status !== 'exhausted' && reviewState.status !== 'accepted') reviewState.status = 'running';
  writeCitadelReviewState(reviewStatePath, reviewState);
  const usedAttempts = reviewState.attempts.filter((entry) => entry.epoch === reviewState.recovery_epoch).length;
  let nextAttemptOrdinal = Math.max(0, ...reviewState.attempts.map((entry) => entry.ordinal)) + 1;
  const recoverableAttempt = [...reviewState.attempts].reverse().find((entry) => (
    entry.epoch === reviewState.recovery_epoch
    && (entry.status === 'validated' || entry.status === 'accepted')
  ));
  let recoveredReport: CitadelReport | null = null;
  if (recoverableAttempt?.candidate_hash && fs.existsSync(recoverableAttempt.candidate_path)) {
    try {
      const expectedAttemptDir = path.join(
        sessionDir, 'citadel-review-attempts', `${reviewIdentity.slice(0, 12)}-${recoverableAttempt.ordinal}`,
      );
      const recoveredCandidate = readReviewerCandidate(recoverableAttempt.candidate_path, expectedAttemptDir);
      if (recoveredCandidate.hash !== recoverableAttempt.candidate_hash) {
        throw new Error('Persisted Citadel candidate digest changed before promotion.');
      }
      recoveredReport = validateCitadelReport(
        recoveredCandidate.value, reviewedRange, expectedAcceptanceCriteria,
      );
      if (recoveredReport.verdict === 'approve' && recoverableAttempt.approval_signal !== true) {
        throw new Error('Persisted Citadel candidate lacks durable approval-token evidence.');
      }
      if (recoverableAttempt.model_attempt_id && recoverableAttempt.telemetry_result
        && recoverableAttempt.telemetry_status !== 'finalized') {
        reconcileValidatedCitadelTelemetry(sessionDir);
        recoverableAttempt.telemetry_status = 'finalized';
        writeCitadelReviewState(reviewStatePath, reviewState);
      }
    } catch (error) {
      recoverableAttempt.status = 'rejected';
      recoverableAttempt.validation_error = error instanceof Error ? error.message : String(error);
      recoverableAttempt.completed_at = new Date().toISOString();
      recoveredReport = null;
      writeCitadelReviewState(reviewStatePath, reviewState);
    }
  }
  let result: CodexSpawnResult | null = null;
  let report: CitadelReport | null = recoveredReport;
  let finalValidationError: unknown = [...reviewState.attempts].reverse()
    .find((entry) => entry.validation_error)?.validation_error ?? null;
  let retryFeedback = normalizeCitadelRetryFeedback(finalValidationError);
  for (let attempt = usedAttempts + 1; !report && attempt <= CITADEL_REVIEWER_MAX_ATTEMPTS; attempt += 1) {
    result = null;
    const ordinal = nextAttemptOrdinal;
    nextAttemptOrdinal += 1;
    const attemptKey = `${reviewIdentity.slice(0, 12)}-${ordinal}`;
    const attemptDir = path.join(sessionDir, 'citadel-review-attempts', attemptKey);
    fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const candidatePath = path.join(attemptDir, 'citadel-review-candidate.json');
    const attemptChecksPath = path.join(attemptDir, 'citadel-checks.json');
    fs.copyFileSync(checksPath, attemptChecksPath);
    const attemptChecksHash = fileHash(attemptChecksPath);
    const attemptStrategyHash = citadelReviewerAttemptHash(reviewStrategy, retryFeedback);
    const outputLastMessagePath = path.join(sessionDir, `citadel-review-attempt-${attemptKey}.last-message.txt`);
    fs.rmSync(outputLastMessagePath, { force: true });
    fs.rmSync(candidatePath, { force: true });
    const artifactAttemptRuntime = artifactExecution
      ? prepareArtifactContractAttempt(attemptDir, candidatePath, artifactExecution)
      : null;
    const journalAttempt: CitadelReviewAttemptState = {
      ordinal,
      epoch: reviewState.recovery_epoch,
      attempt,
      candidate_path: candidatePath,
      status: 'started',
      strategy_id: reviewStrategy.id,
      material_strategy_hash: reviewStrategy.hash,
      strategy_hash: attemptStrategyHash,
      retry_feedback: retryFeedback,
      started_at: new Date().toISOString(),
      ...(artifactAttemptRuntime ? {
        recovery_mechanism: artifactExecution!.mechanism,
        runtime_manifest_hash: artifactExecution!.manifestHash,
        validator_evidence_path: artifactAttemptRuntime.validatorEvidencePath,
      } : {}),
    };
    reviewState.attempts.push(journalAttempt);
    writeCitadelReviewState(reviewStatePath, reviewState);
    const finishJournalAttempt = (
      status: CitadelReviewAttemptState['status'],
      validationError?: unknown,
    ): void => {
      journalAttempt.status = status;
      journalAttempt.completed_at = new Date().toISOString();
      if (validationError !== undefined) {
        journalAttempt.validation_error = validationError instanceof Error
          ? validationError.message : String(validationError);
      }
      writeCitadelReviewState(reviewStatePath, reviewState);
    };
    let reviewerError: unknown = null;
    const attemptStartedAt = Date.now();
    const telemetryReservation = reserveModelCallTelemetry(sessionDir, {
      ticketId: 'pipeline', phase: 'citadel', recoveryEpoch: reviewState.recovery_epoch,
      strategyHash: attemptStrategyHash,
    });
    journalAttempt.model_attempt_id = telemetryReservation.model_attempt_id;
    journalAttempt.telemetry_status = 'started';
    writeCitadelReviewState(reviewStatePath, reviewState);
    let telemetryFinalized = false;
    const finalizeAttempt = (
      attemptResult: CodexSpawnResult,
      outcome: 'success' | 'failed' | 'cancelled' | 'timed_out',
    ): void => {
      if (telemetryFinalized) return;
      finalizeModelCallTelemetry(sessionDir, telemetryReservation, {
        result: attemptResult,
        outcome,
        productiveWork: outcome === 'success' ? 1 : 0,
        discardedWork: outcome === 'success' ? 0 : 1,
      });
      telemetryFinalized = true;
    };
    try {
      assertOwnership();
      recoverMonitoredProcessOwnership(manager, path.join(sessionDir, 'state.json'));
      result = await runCodexExecMonitored({
        cwd: citadelWorkingDir,
        prompt: buildCitadelPrompt(
          sessionDir, reviewedRange, attemptChecksPath, expectedAcceptanceCriteria, candidatePath, retryFeedback,
          `${reviewStrategy.id}: ${reviewStrategy.instruction}`,
          artifactAttemptRuntime?.prompt,
        ),
        timeoutMs: Number(state.worker_timeout_seconds || 900) * 1000,
        outputLastMessagePath,
        progressArtifactPaths: [candidatePath],
        addDirs: [attemptDir],
        ...monitoredProcessStateCallbacks(
          manager,
          path.join(sessionDir, 'state.json'),
          'codex',
          `citadel-attempt-${attempt}`,
        ),
        cancelCheck: shouldCancel,
      });
      assertOwnership();
    } catch (error) {
      finalizeAttempt(result ?? failedReviewerResult(error, Date.now() - attemptStartedAt), 'failed');
      finishJournalAttempt('interrupted', error);
      assertOwnership();
      reviewerError = error;
    }
    if (restoreIsolatedCheckpoint(`reviewer-attempt-${attempt}`)) {
      finalizeAttempt(
        result ?? failedReviewerResult(reviewerError, Date.now() - attemptStartedAt), 'failed',
      );
      finishJournalAttempt('interrupted', reviewerError ?? 'Reviewer mutated the isolated checkpoint.');
      assertReleaseWorkspaceUnchanged();
      throw new Error('Citadel reviewer modified the target repository during a read-only review; the clean checkpoint was restored.', reviewerError ? { cause: reviewerError } : undefined);
    }
    assertOwnership();
    assertReleaseWorkspaceUnchanged();
    if (reviewerError) throw reviewerError;
    if (!result) throw new Error('Citadel reviewer returned no execution result.');
    if (result.cancelled) {
      finalizeAttempt(result, 'cancelled');
      finishJournalAttempt('interrupted', 'Reviewer attempt was cancelled.');
      return 'cancelled';
    }
    try {
      assertCodexSucceeded(result, 'Citadel review failed');
    } catch (error) {
      finalizeAttempt(result, result.timedOut ? 'timed_out' : 'failed');
      finishJournalAttempt('interrupted', error);
      throw error;
    }
    try {
      if (fileHash(attemptChecksPath) !== attemptChecksHash) {
        throw new Error('Invalid Citadel reviewer artifact: immutable deterministic evidence was modified.');
      }
      artifactAttemptRuntime?.validateCandidate();
      const candidate = readReviewerCandidate(candidatePath, attemptDir);
      // Bind even schema-invalid regular candidates to the durable attempt so
      // artifact-contract recovery diagnoses exact bytes rather than prose.
      journalAttempt.candidate_hash = candidate.hash;
      report = validateCitadelReport(
        candidate.value,
        reviewedRange,
        expectedAcceptanceCriteria,
      );
      if (report.verdict === 'approve' && !(
        hasPromiseToken(result.lastMessage, 'THE_CITADEL_APPROVES')
        || hasPromiseToken(result.stdout, 'THE_CITADEL_APPROVES')
      )) {
        throw new Error('Invalid Citadel reviewer artifact: required approval signal is missing.');
      }
      journalAttempt.approval_signal = report.verdict === 'block' || (
        hasPromiseToken(result.lastMessage, 'THE_CITADEL_APPROVES')
        || hasPromiseToken(result.stdout, 'THE_CITADEL_APPROVES')
      );
      journalAttempt.telemetry_result = compactTelemetryResult(result);
      finishJournalAttempt('validated');
      try {
        options.faultInjection?.('validated-before-telemetry');
      } catch (error) {
        throw new CitadelFaultInjectionError('Injected fault after durable candidate validation.', { cause: error });
      }
      finalizeAttempt(result, 'success');
      journalAttempt.telemetry_status = 'finalized';
      writeCitadelReviewState(reviewStatePath, reviewState);
      break;
    } catch (error) {
      if (error instanceof CitadelFaultInjectionError) throw error;
      finalizeAttempt(result, 'failed');
      finishJournalAttempt('rejected', error);
      finalValidationError = error;
      retryFeedback = normalizeCitadelRetryFeedback(error);
      report = null;
      preserveInvalidReviewerAttempt(
        sessionDir, attempt, attemptKey, reviewedRange, checkpointHead, result, candidatePath, error,
      );
    }
  }
  if (!report) {
    const message = finalValidationError instanceof Error ? finalValidationError.message : String(finalValidationError);
    reviewState.status = 'exhausted';
    writeCitadelReviewState(reviewStatePath, reviewState);
    atomicWriteJson(path.join(sessionDir, 'citadel-reviewer-artifact-failure.json'), {
      schema_version: 1,
      code: 'CITADEL_REVIEWER_ARTIFACT_INVALID',
      attempts: CITADEL_REVIEWER_MAX_ATTEMPTS,
      review_identity: reviewIdentity,
      recovery_epoch: reviewState.recovery_epoch,
      reviewed_range: reviewedRange,
      checkpoint_head: checkpointHead,
      error: message,
      failed_at: new Date().toISOString(),
    });
    throw new CitadelReviewerArtifactError(
      `Citadel reviewer did not produce a valid artifact after ${CITADEL_REVIEWER_MAX_ATTEMPTS} attempts: ${message}`,
      CITADEL_REVIEWER_MAX_ATTEMPTS,
      finalValidationError ? { cause: finalValidationError } : undefined,
    );
  }
  assertOwnership();
  fs.rmSync(citadelSystemBlockPath(sessionDir), { force: true });
  atomicWriteJson(reportPath, report);
  const acceptedAttempt = [...reviewState.attempts].reverse().find((entry) => (
    entry.epoch === reviewState.recovery_epoch && entry.status === 'validated'
  ));
  if (acceptedAttempt) acceptedAttempt.status = 'accepted';
  reviewState.status = 'accepted';
  writeCitadelReviewState(reviewStatePath, reviewState);
  const priorFailure = readJsonFile<Record<string, unknown>>(
    path.join(sessionDir, 'citadel-reviewer-artifact-failure.json'), null,
  );
  if (priorFailure?.review_identity === reviewIdentity && !priorFailure.resolved_at) {
    atomicWriteJson(path.join(sessionDir, 'citadel-reviewer-artifact-failure.json'), {
      ...priorFailure,
      resolved_at: new Date().toISOString(),
      resolved_by_epoch: reviewState.recovery_epoch,
    });
  }
  if (report.verdict === 'approve') {
    assertOwnership();
    persistCitadelReleaseApproval(sessionDir, report);
  }
  assertReleaseWorkspaceUnchanged();
  validateCitadelRecoveryEvidence(sessionDir, workingDir, manager.read(statePath));
  return report.verdict === 'approve' ? 'success' : 'citadel-blocked';
  } finally {
    if (!preserveIsolatedEvidence) isolated.cleanup();
  }
}
