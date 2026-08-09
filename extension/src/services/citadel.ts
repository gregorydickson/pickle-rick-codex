import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCodexExecMonitored, assertCodexSucceeded, hasPromiseToken } from './codex.js';
import { getHeadSha, getWorkingTreeFingerprint, listChangedPathsSince, listWorkingTreeDirtyPaths } from './git-utils.js';
import { recoverableHardReset } from './recoverable-git.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
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
}

export type CitadelSystemBlockCode =
  | 'scope_contract_invalid'
  | 'acceptance_criteria_missing'
  | 'deterministic_check_failed'
  | 'deterministic_gate_unavailable';

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
  recovery_action: 'request_prd_revision' | 'retry_checks' | 'repair_verification_contract';
  recovery_ticket_ids: string[];
  failure_identity: string;
  attempt: number;
  recovery_epoch: number;
  bounded_attempt: number;
  next_action: 'retry_phase' | 'restart_executor';
  generated_at: string;
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

interface CitadelCheckRunOptions {
  timeoutMs: number;
  isCancelled: () => boolean;
  onSpawn: (child: ChildProcess, command: string) => void;
  onExit: () => void;
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
    || !['request_prd_revision', 'retry_checks', 'repair_verification_contract']
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
}

interface CitadelReviewState {
  schema_version: 1;
  review_identity: string;
  recovery_epoch: number;
  strategy_id: string;
  strategy_hash: string;
  status: 'running' | 'exhausted' | 'accepted';
  attempts: CitadelReviewAttemptState[];
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

function normalizeCitadelRetryFeedback(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const message = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim();
  return message ? message.slice(0, 1_000) : null;
}

function citadelReviewerAttemptHash(
  strategy: { id: string; instruction: string },
  retryFeedback: string | null,
): string {
  return reportHash({
    material_approach: { id: strategy.id, instruction: strategy.instruction },
    retry_feedback: retryFeedback,
  });
}

function readBoundedReviewerCandidateBytes(
  reportPath: string,
  expectedAttemptDir: string,
): Buffer {
  const expectedPath = path.join(path.resolve(expectedAttemptDir), 'citadel-review-candidate.json');
  if (path.resolve(reportPath) !== expectedPath) {
    throw new Error('Invalid Citadel reviewer artifact: candidate path escapes its assigned attempt directory.');
  }
  const directoryStat = fs.lstatSync(expectedAttemptDir);
  const stat = fs.lstatSync(reportPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Invalid Citadel reviewer artifact: candidate must be a regular non-symlink file.');
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

interface CitadelCheckDescriptor {
  command: string;
  executable: string;
  args: string[];
  cwd?: string;
  skipped?: boolean;
  verificationStep?: VerificationStep;
  allowedRoots?: string[];
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
): CitadelCheckDescriptor[] {
  const packageChecks = ['typecheck', 'lint', 'test']
    .map((script) => packageCheckDescriptor(workingDir, script));
  const repositoryCheck: CitadelCheckDescriptor = {
    command: 'git diff --check',
    executable: 'git',
    args: ['diff', '--check'],
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

async function runMonitoredCitadelCheck(
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
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: descriptor.cwd || workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onSpawn(child, descriptor.command);

    const terminate = (): void => {
      signalProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
      }, 1_000).unref?.();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const cancelPoll = setInterval(() => {
      if (!options.isCancelled()) return;
      cancelled = true;
      terminate();
    }, 100);
    const cleanup = (): void => {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      options.onExit();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (cancelled || options.isCancelled()) {
        // The state canceller may have signalled only the leader. Reap the owned
        // process group once more so a shell/test descendant cannot escape.
        signalProcessTree(child, 'SIGKILL');
        reject(new CitadelChecksCancelledError());
        return;
      }
      const output = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`
        .trim()
        .slice(-100_000);
      resolve({
        command: descriptor.command,
        status: !timedOut && code === 0 ? 'passed' : 'failed',
        exit_code: code,
        output: timedOut ? `${output}\nCitadel check timed out after ${options.timeoutMs}ms`.trim() : output,
      });
    }));
  });
}

async function runCitadelChecksMonitored(
  workingDir: string,
  sessionDir: string,
  ticketVerificationSteps: VerificationStep[],
  options: CitadelCheckRunOptions,
): Promise<CitadelCheckResult[]> {
  const results: CitadelCheckResult[] = [];
  for (const descriptor of citadelCheckDescriptors(workingDir, sessionDir, ticketVerificationSteps)) {
    results.push(await runMonitoredCitadelCheck(descriptor, workingDir, options));
  }
  return results;
}

function buildCitadelPrompt(
  sessionDir: string,
  reviewedRange: string,
  checksPath: string,
  expectedAcceptanceCriteria: string[],
  reportPath: string = citadelReportPath(sessionDir),
  retryFeedback: string | null = null,
  recoveryStrategy: string | null = null,
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
  ].join('\n\n');
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
  const failureIdentity = reportHash({
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
  const checksBinding = {
    checkpoint_head: checkpointHead,
    release_fingerprint: releaseCheckpointFingerprint,
    reviewed_range: reviewedRange,
    verification_hash: reportHash(verificationSteps),
    acceptance_criteria_hash: reportHash(expectedAcceptanceCriteria),
  };
  const cachedChecks = readJsonFile<Record<string, unknown>>(checksPath, null);
  const cachedResults = Array.isArray(cachedChecks?.checks)
    ? cachedChecks.checks as CitadelCheckResult[] : null;
  const cachedChecksHash = cachedResults ? reportHash(cachedResults) : null;
  const canReuseChecks = JSON.stringify(cachedChecks?.binding) === JSON.stringify(checksBinding)
    && cachedChecks?.checks_hash === cachedChecksHash
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
        timeoutMs: Number(state.worker_timeout_seconds || 900) * 1000,
        isCancelled: shouldCancel,
        onSpawn: (child, command) => {
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'citadel-check';
            current.active_child_command = command;
            current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        onExit: () => {
          if (ownershipDrainError) return;
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = null;
            current.active_child_kind = null;
            current.active_child_command = null;
            current.active_child_identity = null;
            current.active_child_controller_pid = null;
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
  atomicWriteJson(checksPath, {
    schema_version: 1,
    reviewed_range: reviewedRange,
    binding: checksBinding,
    checks_hash: reportHash(checks),
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
  }
  const reviewStrategy = strategyCatalogExhausted
    ? {
        id: reviewState.strategy_id,
        instruction: CITADEL_REVIEWER_STRATEGIES.find((entry) => entry.id === reviewState.strategy_id)?.instruction
          ?? CITADEL_REVIEWER_STRATEGIES[0].instruction,
        hash: reviewState.strategy_hash,
      }
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
  if (strategyCatalogExhausted) {
    finalValidationError = new Error(
      'Citadel reviewer artifact recovery exhausted: no unused material reviewer strategy remains for unchanged evidence.',
    );
  }
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
      result = await runCodexExecMonitored({
        cwd: citadelWorkingDir,
        prompt: buildCitadelPrompt(
          sessionDir, reviewedRange, attemptChecksPath, expectedAcceptanceCriteria, candidatePath, retryFeedback,
          `${reviewStrategy.id}: ${reviewStrategy.instruction}`,
        ),
        timeoutMs: Number(state.worker_timeout_seconds || 900) * 1000,
        outputLastMessagePath,
        progressArtifactPaths: [candidatePath],
        addDirs: [attemptDir],
        onSpawn: (child) => {
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'codex';
            current.active_child_command = `citadel-attempt-${attempt}`;
            current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        cancelCheck: shouldCancel,
      });
      assertOwnership();
    } catch (error) {
      finalizeAttempt(result ?? failedReviewerResult(error, Date.now() - attemptStartedAt), 'failed');
      finishJournalAttempt('interrupted', error);
      assertOwnership();
      reviewerError = error;
    } finally {
      if (!ownershipDrainError) {
        manager.update(path.join(sessionDir, 'state.json'), (current) => {
          current.active_child_pid = null;
          current.active_child_kind = null;
          current.active_child_command = null;
          current.active_child_identity = null;
          current.active_child_controller_pid = null;
          return current;
        });
      }
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
      const candidate = readReviewerCandidate(candidatePath, attemptDir);
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
      journalAttempt.candidate_hash = candidate.hash;
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
  return report.verdict === 'approve' ? 'success' : 'citadel-blocked';
  } finally {
    if (!preserveIsolatedEvidence) isolated.cleanup();
  }
}
