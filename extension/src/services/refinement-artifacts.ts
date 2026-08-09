import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonFile, readTextFile } from './pickle-utils.js';
import {
  amendCommitTrailer,
  countCommitsSince,
  commitTrackedChanges,
  getHeadSha,
  getWorkingTreeContentFingerprint,
  getWorkingTreeFingerprint,
  getWorkingTreeStatus,
  isGitRepo,
  isWorkingTreeDirty,
  listChangedPathsSince,
  listUntrackedFiles,
  readCommitTrailer,
  resetGitIndex,
  stagePaths,
} from './git-utils.js';
import { enrichRefinementManifest, normalizeTicketId, normalizeTicketStatus, readManifest, updateTicketStatus } from './tickets.js';
import { recoverableHardReset } from './recoverable-git.js';
import { readFreshTicketScope } from './scope-contract.js';
import { resolveTicketScope } from './execution-gate.js';
import { StateManager } from './state-manager.js';
import type { RefinementManifest } from '../types/index.js';
import { isVerificationContractError } from './verification-env.js';

export const REFINEMENT_PROMPT_CONTRACT_VERSION = 3;
export const REFINEMENT_ACCEPTANCE_SCHEMA_VERSION = 3;
const REFINEMENT_WORKER_HISTORY_LIMIT = 4;
const MAX_REFINEMENT_ARTIFACT_BYTES = 2_000_000;

interface AnalystCheckpoint {
  schema_version: 1;
  prompt_contract_version: number;
  role: string;
  prd_sha256: string;
  repository_identity: string;
  report_sha256: string;
  accepted_at: string;
}

export interface RefinementAcceptance {
  schema_version: 3;
  prompt_contract_version: number;
  prd_sha256: string;
  refined_prd_sha256: string;
  manifest_sha256: string;
  repository_identity: string;
  accepted_at: string;
}

export interface RefinementAcceptanceVerdict {
  ok: boolean;
  reason: string | null;
  receipt: RefinementAcceptance | null;
}

interface RefinementRepositoryAdvance {
  schema_version: 1;
  ticket_id: string;
  baseline_repository_identity: string;
  baseline_head_sha: string;
  baseline_files_fingerprint: string;
  baseline_untracked_files: string[];
  requires_clean_commit: boolean;
  phase: 'started' | 'verified';
  verified_repository_identity?: string;
  verified_head_sha?: string;
  verified_files_fingerprint?: string;
  verified_changed_paths?: string[];
  updated_at: string;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fileSha256(filePath: string): string {
  const content = readTextFile(filePath, null);
  return content === null ? '' : sha256(content);
}

const IMMUTABLE_TICKET_CONTRACT_FIELDS = [
  'id',
  'title',
  'description',
  'complexity_tier',
  'verification',
  'verification_env',
  'depends_on',
  'acceptance_criteria',
  'priority',
  'phase',
  'output_artifacts',
  'proof_corpus',
  'allowed_paths',
  'freeze_contract',
  'contract_decision',
  'formatter',
  'formatter_ticket',
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function manifestContractSha256(manifestPath: string, preserveMalformedVerification = false): string {
  const manifest = readJsonFile<{ source?: unknown; tickets?: unknown }>(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.tickets)) return '';
  let canonical: RefinementManifest;
  try {
    canonical = enrichRefinementManifest(structuredClone(manifest) as RefinementManifest).manifest;
  } catch (error) {
    if (!preserveMalformedVerification || !isVerificationContractError(error)) throw error;
    const raw = structuredClone(manifest) as RefinementManifest;
    const verificationRepresentations = raw.tickets.map((ticket) => ticket.verification ?? ticket.verify);
    const sanitized = {
      ...raw,
      tickets: raw.tickets.map((ticket) => {
        const next = { ...ticket, verification: [] };
        delete next.verify;
        return next;
      }),
    };
    canonical = enrichRefinementManifest(sanitized).manifest;
    canonical.tickets = canonical.tickets.map((ticket, index) => ({
      ...ticket,
      verification: verificationRepresentations[index],
    }));
  }
  const tickets = canonical.tickets.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const ticket = entry as Record<string, unknown>;
    return Object.fromEntries(IMMUTABLE_TICKET_CONTRACT_FIELDS
      .filter((field) => Object.hasOwn(ticket, field))
      .map((field) => [field, stableValue(ticket[field])]));
  });
  return sha256(JSON.stringify(stableValue({ source: canonical.source ?? null, tickets })));
}

function refinementSessionExclusion(workingDir: string, sessionDir?: string): {
  excludeAll: boolean;
  prefixes: string[];
} {
  if (!sessionDir) return { excludeAll: false, prefixes: [] };
  const resolvedWorkingDir = fs.realpathSync(workingDir);
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const relative = path.relative(resolvedWorkingDir, resolvedSessionDir);
  if (!relative) return { excludeAll: true, prefixes: [] };
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { excludeAll: false, prefixes: [] };
  return { excludeAll: true, prefixes: [] };
}

export function refinementRepositoryIdentity(workingDir: string, sessionDir?: string): string {
  try {
    const resolved = fs.realpathSync(workingDir);
    const exclusion = refinementSessionExclusion(resolved, sessionDir);
    if (exclusion.excludeAll) return '';
    const git = isGitRepo(resolved);
    return sha256(JSON.stringify({
      resolved,
      head: git ? getHeadSha(resolved) : null,
      status: git
        ? getWorkingTreeStatus(resolved, exclusion.prefixes)
        : null,
      files: getWorkingTreeFingerprint(resolved, exclusion.prefixes),
    }));
  } catch {
    return '';
  }
}

function refinementRepositoryFilesFingerprint(workingDir: string, sessionDir: string): string {
  const resolved = fs.realpathSync(workingDir);
  const exclusion = refinementSessionExclusion(resolved, sessionDir);
  if (exclusion.excludeAll) return '';
  return getWorkingTreeContentFingerprint(resolved, exclusion.prefixes);
}

export interface RefinementInputIdentity {
  prd_sha256: string;
  repository_identity: string;
}

export function captureRefinementInputIdentity(input: {
  prdPath: string;
  workingDir: string;
}): RefinementInputIdentity {
  const identity = {
    prd_sha256: fileSha256(input.prdPath),
    repository_identity: refinementRepositoryIdentity(input.workingDir, path.dirname(input.prdPath)),
  };
  if (!identity.prd_sha256 || !identity.repository_identity) {
    throw new Error('Could not capture a stable PRD and repository identity for refinement.');
  }
  return identity;
}

export function assertRefinementInputIdentity(
  expected: RefinementInputIdentity,
  input: { prdPath: string; workingDir: string },
): void {
  const current = captureRefinementInputIdentity(input);
  if (
    current.prd_sha256 !== expected.prd_sha256
    || current.repository_identity !== expected.repository_identity
  ) {
    throw new Error('Refinement inputs changed during execution; retry from a stable PRD and repository snapshot.');
  }
}

export function refinementAcceptancePath(sessionDir: string): string {
  return path.join(sessionDir, 'refinement-acceptance.json');
}

export function refinementWorkerRoot(sessionDir: string): string {
  return path.join(sessionDir, '.refinement-workers');
}

export function createRefinementWorkerDir(sessionDir: string, label: string): string {
  const root = refinementWorkerRoot(sessionDir);
  ensureDir(root);
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
  const workerDir = path.join(root, `${Date.now()}-${safeLabel}-${crypto.randomUUID().slice(0, 8)}`);
  ensureDir(workerDir);
  return workerDir;
}

export function pruneRefinementWorkerHistory(sessionDir: string): void {
  const root = refinementWorkerRoot(sessionDir);
  let entries: Array<{ path: string; mtimeMs: number }>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const entryPath = path.join(root, entry.name);
        return { path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return;
  }
  for (const entry of entries.slice(REFINEMENT_WORKER_HISTORY_LIMIT)) {
    fs.rmSync(entry.path, { recursive: true, force: true });
  }
}

export function isNonBlankArtifact(filePath: string): boolean {
  try {
    if (fs.statSync(filePath).size > MAX_REFINEMENT_ARTIFACT_BYTES) return false;
  } catch {
    return false;
  }
  return Boolean(readTextFile(filePath, '')?.trim());
}

function analystCheckpointPath(reportPath: string): string {
  return `${reportPath}.receipt.json`;
}

export function hasReusableAnalystCheckpoint(input: {
  prdPath: string;
  reportPath: string;
  role: string;
  workingDir: string;
  maxBytes?: number;
}): boolean {
  const receipt = readJsonFile<AnalystCheckpoint>(analystCheckpointPath(input.reportPath), null);
  if (!receipt || !isNonBlankArtifact(input.reportPath)) return false;
  try {
    if (input.maxBytes && fs.statSync(input.reportPath).size > input.maxBytes) return false;
  } catch {
    return false;
  }
  const currentRepositoryIdentity = refinementRepositoryIdentity(input.workingDir, path.dirname(input.prdPath));
  return receipt.schema_version === 1
    && receipt.prompt_contract_version === REFINEMENT_PROMPT_CONTRACT_VERSION
    && receipt.role === input.role
    && receipt.prd_sha256 === fileSha256(input.prdPath)
    && receipt.repository_identity === currentRepositoryIdentity
    && receipt.report_sha256 === fileSha256(input.reportPath);
}

export function promoteAnalystCheckpoint(input: {
  prdPath: string;
  candidateReportPath: string;
  reportPath: string;
  role: string;
  workingDir: string;
  inputIdentity: RefinementInputIdentity;
}): void {
  const report = readTextFile(input.candidateReportPath, '') || '';
  if (!report.trim()) throw new Error(`Refinement analyst ${input.role} produced an empty report.`);
  atomicWriteFile(input.reportPath, report);
  atomicWriteJson<AnalystCheckpoint>(analystCheckpointPath(input.reportPath), {
    schema_version: 1,
    prompt_contract_version: REFINEMENT_PROMPT_CONTRACT_VERSION,
    role: input.role,
    prd_sha256: input.inputIdentity.prd_sha256,
    repository_identity: input.inputIdentity.repository_identity,
    report_sha256: sha256(report),
    accepted_at: new Date().toISOString(),
  });
}

function acceptanceWorkingDir(sessionDir: string, workingDir?: string): string {
  if (workingDir) return workingDir;
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  return typeof state?.working_dir === 'string' && state.working_dir
    ? state.working_dir
    : sessionDir;
}

export function writeRefinementAcceptance(
  sessionDir: string,
  options: {
    workingDir?: string;
    expectedInputIdentity?: RefinementInputIdentity;
  } = {},
): RefinementAcceptance {
  const workingDir = acceptanceWorkingDir(sessionDir, options.workingDir);
  const currentPrdSha256 = fileSha256(path.join(sessionDir, 'prd.md'));
  const currentRepositoryIdentity = refinementRepositoryIdentity(workingDir, sessionDir);
  if (
    options.expectedInputIdentity
    && (
      options.expectedInputIdentity.prd_sha256 !== currentPrdSha256
      || options.expectedInputIdentity.repository_identity !== currentRepositoryIdentity
    )
  ) {
    throw new Error('Cannot accept refinement because its PRD or repository changed during execution.');
  }
  const receipt: RefinementAcceptance = {
    schema_version: REFINEMENT_ACCEPTANCE_SCHEMA_VERSION,
    prompt_contract_version: REFINEMENT_PROMPT_CONTRACT_VERSION,
    prd_sha256: currentPrdSha256,
    refined_prd_sha256: fileSha256(path.join(sessionDir, 'prd_refined.md')),
    manifest_sha256: manifestContractSha256(path.join(sessionDir, 'refinement_manifest.json')),
    repository_identity: options.expectedInputIdentity?.repository_identity || currentRepositoryIdentity,
    accepted_at: new Date().toISOString(),
  };
  if (
    !receipt.prd_sha256
    || !receipt.refined_prd_sha256
    || !receipt.manifest_sha256
    || !receipt.repository_identity
  ) {
    throw new Error('Cannot accept refinement before every canonical artifact exists.');
  }
  atomicWriteJson(refinementAcceptancePath(sessionDir), receipt);
  return receipt;
}

export function refreshAcceptedRefinementRepositoryIdentity(
  sessionDir: string,
  workingDir: string,
): RefinementAcceptance {
  const verdict = validateRefinementAcceptance(sessionDir);
  if (!verdict.ok || !verdict.receipt) {
    throw new Error(`Cannot refresh refinement repository identity: ${verdict.reason}.`);
  }
  const repository_identity = refinementRepositoryIdentity(workingDir, sessionDir);
  if (!repository_identity) {
    throw new Error('Cannot refresh refinement repository identity for the working repository.');
  }
  const receipt: RefinementAcceptance = {
    ...verdict.receipt,
    repository_identity,
    accepted_at: new Date().toISOString(),
  };
  atomicWriteJson(refinementAcceptancePath(sessionDir), receipt);
  return receipt;
}

export function validateRefinementAcceptance(
  sessionDir: string,
  options: { workingDir?: string; verifyRepository?: boolean; preserveMalformedVerification?: boolean } = {},
): RefinementAcceptanceVerdict {
  for (const [name, filePath] of [
    ['prd.md', path.join(sessionDir, 'prd.md')],
    ['prd_refined.md', path.join(sessionDir, 'prd_refined.md')],
    ['refinement_manifest.json', path.join(sessionDir, 'refinement_manifest.json')],
  ] as const) {
    if (!isNonBlankArtifact(filePath)) {
      return { ok: false, reason: `missing or empty ${name}`, receipt: null };
    }
  }
  const receipt = readJsonFile<RefinementAcceptance>(refinementAcceptancePath(sessionDir), null);
  if (!receipt) return { ok: false, reason: 'refinement acceptance receipt is missing or invalid', receipt: null };
  if (
    receipt.schema_version !== REFINEMENT_ACCEPTANCE_SCHEMA_VERSION
    || receipt.prompt_contract_version !== REFINEMENT_PROMPT_CONTRACT_VERSION
    || typeof receipt.repository_identity !== 'string'
    || !receipt.repository_identity
  ) {
    return { ok: false, reason: 'refinement acceptance receipt version is stale', receipt };
  }
  const expected = {
    prd_sha256: fileSha256(path.join(sessionDir, 'prd.md')),
    refined_prd_sha256: fileSha256(path.join(sessionDir, 'prd_refined.md')),
    manifest_sha256: manifestContractSha256(
      path.join(sessionDir, 'refinement_manifest.json'),
      options.preserveMalformedVerification === true,
    ),
  };
  for (const [field, actual] of Object.entries(expected)) {
    if (!actual || receipt[field as keyof typeof expected] !== actual) {
      return { ok: false, reason: `${field} does not match the accepted refinement`, receipt };
    }
  }
  if (options.verifyRepository) {
    const currentRepositoryIdentity = refinementRepositoryIdentity(
      acceptanceWorkingDir(sessionDir, options.workingDir),
      sessionDir,
    );
    if (!currentRepositoryIdentity || receipt.repository_identity !== currentRepositoryIdentity) {
      return { ok: false, reason: 'repository identity does not match the accepted refinement', receipt };
    }
  }
  return { ok: true, reason: null, receipt };
}

export function refinementRepositoryAdvancePath(sessionDir: string): string {
  return path.join(sessionDir, 'refinement-repository-advance.json');
}

export function beginRefinementRepositoryAdvance(input: {
  sessionDir: string;
  workingDir: string;
  ticketId: string;
  requiresCleanCommit: boolean;
}): RefinementRepositoryAdvance {
  const acceptance = validateRefinementAcceptance(input.sessionDir, {
    workingDir: input.workingDir,
    verifyRepository: true,
  });
  if (!acceptance.ok || !acceptance.receipt) {
    throw new Error(`Cannot begin ticket repository advance: ${acceptance.reason}.`);
  }
  const advance: RefinementRepositoryAdvance = {
    schema_version: 1,
    ticket_id: input.ticketId,
    baseline_repository_identity: acceptance.receipt.repository_identity,
    baseline_head_sha: isGitRepo(input.workingDir) ? getHeadSha(input.workingDir) : '',
    baseline_files_fingerprint: refinementRepositoryFilesFingerprint(input.workingDir, input.sessionDir),
    baseline_untracked_files: isGitRepo(input.workingDir) ? listUntrackedFiles(input.workingDir) : [],
    requires_clean_commit: input.requiresCleanCommit,
    phase: 'started',
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(refinementRepositoryAdvancePath(input.sessionDir), advance);
  return advance;
}

export function markRefinementRepositoryAdvanceVerified(input: {
  sessionDir: string;
  workingDir: string;
  ticketId: string;
  changedPaths: string[];
}): RefinementRepositoryAdvance {
  const advancePath = refinementRepositoryAdvancePath(input.sessionDir);
  const advance = readJsonFile<RefinementRepositoryAdvance>(advancePath, null);
  if (
    !advance
    || advance.schema_version !== 1
    || advance.ticket_id !== input.ticketId
    || advance.phase !== 'started'
  ) {
    throw new Error(`Cannot verify repository advance for ${input.ticketId}: its durable start boundary is missing.`);
  }
  const verified: RefinementRepositoryAdvance = {
    ...advance,
    phase: 'verified',
    verified_repository_identity: refinementRepositoryIdentity(input.workingDir, input.sessionDir),
    verified_head_sha: isGitRepo(input.workingDir) ? getHeadSha(input.workingDir) : '',
    verified_files_fingerprint: refinementRepositoryFilesFingerprint(input.workingDir, input.sessionDir),
    verified_changed_paths: [...new Set(input.changedPaths)].sort(),
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(advancePath, verified);
  return verified;
}

export function clearRefinementRepositoryAdvance(sessionDir: string): void {
  fs.rmSync(refinementRepositoryAdvancePath(sessionDir), { force: true });
}

export function inspectRefinementRepositoryAdvance(
  sessionDir: string,
  workingDir: string,
): { recoverable: boolean; reason: string } {
  const advance = readJsonFile<RefinementRepositoryAdvance>(
    refinementRepositoryAdvancePath(sessionDir),
    null,
  );
  if (
    !advance
    || advance.schema_version !== 1
    || typeof advance.ticket_id !== 'string'
    || typeof advance.baseline_repository_identity !== 'string'
    || typeof advance.baseline_head_sha !== 'string'
    || typeof advance.baseline_files_fingerprint !== 'string'
    || !Array.isArray(advance.baseline_untracked_files)
    || typeof advance.requires_clean_commit !== 'boolean'
    || !['started', 'verified'].includes(advance.phase)
  ) {
    return { recoverable: false, reason: 'no valid durable ticket repository boundary exists' };
  }
  const contract = validateRefinementAcceptance(sessionDir);
  if (!contract.ok || contract.receipt?.repository_identity !== advance.baseline_repository_identity) {
    return { recoverable: false, reason: 'the durable ticket boundary does not match accepted refinement' };
  }
  const rawManifest = readJsonFile<RefinementManifest>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const ticket = rawManifest
    ? enrichRefinementManifest(structuredClone(rawManifest)).manifest.tickets
      .find((entry) => normalizeTicketId(entry.id, entry.id) === normalizeTicketId(advance.ticket_id, advance.ticket_id))
    : null;
  if (!ticket || normalizeTicketStatus(ticket.status) !== 'in progress') {
    return { recoverable: false, reason: 'the durable boundary has no In Progress owner' };
  }
  const currentIdentity = refinementRepositoryIdentity(workingDir, sessionDir);
  if (advance.phase === 'started') {
    const recoverable = currentIdentity === advance.baseline_repository_identity
      || (isGitRepo(workingDir) && Boolean(advance.baseline_head_sha));
    return {
      recoverable,
      reason: recoverable
        ? 'the interrupted unverified ticket can be restored to its archived start boundary'
        : 'the unverified ticket boundary cannot be restored safely',
    };
  }
  if (
    !advance.verified_repository_identity
    || typeof advance.verified_head_sha !== 'string'
    || !advance.verified_files_fingerprint
    || !Array.isArray(advance.verified_changed_paths)
  ) {
    return { recoverable: false, reason: 'the verified ticket boundary is incomplete' };
  }
  const currentFiles = refinementRepositoryFilesFingerprint(workingDir, sessionDir);
  const currentHead = isGitRepo(workingDir) ? getHeadSha(workingDir) : '';
  const verifiedHasChanges = advance.verified_repository_identity !== advance.baseline_repository_identity;
  const exactVerified = currentIdentity === advance.verified_repository_identity;
  const verifiedDirty = isGitRepo(workingDir)
    && isWorkingTreeDirty(workingDir)
    && currentFiles === advance.verified_files_fingerprint
    && currentHead === advance.verified_head_sha;
  const baseline = currentFiles === advance.baseline_files_fingerprint
    && currentHead === advance.baseline_head_sha;
  const committed = isGitRepo(workingDir)
    && getWorkingTreeStatus(workingDir) === ''
    && currentFiles === advance.verified_files_fingerprint
    && currentHead !== advance.baseline_head_sha
    && countCommitsSince(workingDir, advance.verified_head_sha) === 1
    && readCommitTrailer(workingDir, currentHead, 'Pickle-Ticket') === advance.ticket_id;
  const recoverable = committed
    || (!verifiedHasChanges && baseline)
    || (exactVerified && (
      !verifiedHasChanges
      || (
        isGitRepo(workingDir)
        && getWorkingTreeStatus(workingDir) === ''
        && currentHead !== advance.baseline_head_sha
      )
    ))
    || verifiedDirty
    || (baseline && verifiedHasChanges);
  return {
    recoverable,
    reason: recoverable
      ? 'the interrupted ticket has an exact durable repository boundary'
      : 'repository state does not match the durable verified ticket boundary',
  };
}

export function reconcileVerifiedRefinementRepositoryAdvance(
  sessionDir: string,
  workingDir: string,
): { reconciled: boolean; ticketId?: string } {
  const advancePath = refinementRepositoryAdvancePath(sessionDir);
  if (!fs.existsSync(advancePath)) return { reconciled: false };
  const advance = readJsonFile<RefinementRepositoryAdvance>(advancePath, null);
  if (
    !advance
    || advance.schema_version !== 1
    || typeof advance.ticket_id !== 'string'
    || typeof advance.baseline_repository_identity !== 'string'
    || typeof advance.baseline_files_fingerprint !== 'string'
    || !Array.isArray(advance.baseline_untracked_files)
    || typeof advance.requires_clean_commit !== 'boolean'
    || !['started', 'verified'].includes(advance.phase)
  ) {
    throw new Error('Refinement repository advance record is invalid; refusing to infer ticket ownership.');
  }
  const contract = validateRefinementAcceptance(sessionDir);
  if (!contract.ok || !contract.receipt) {
    throw new Error(`Cannot reconcile repository advance: ${contract.reason}.`);
  }
  if (contract.receipt.repository_identity !== advance.baseline_repository_identity) {
    throw new Error('Refinement repository advance does not start at the accepted repository boundary.');
  }
  const manifest = readManifest(sessionDir);
  const ticket = manifest.tickets.find((entry) => (
    normalizeTicketId(entry.id, entry.id) === normalizeTicketId(advance.ticket_id, advance.ticket_id)
  ));
  if (!ticket || normalizeTicketStatus(ticket.status) !== 'in progress') {
    throw new Error(`Refinement repository advance is not owned by an In Progress ticket: ${advance.ticket_id}.`);
  }
  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  const clearOwnedRecovery = (): void => {
    manager.update(statePath, (current) => {
      if (current.recovery_kind === 'ticket_repository') {
        current.recovery_required = false;
        current.recovery_kind = null;
        current.recovery_reason = null;
        if (current.last_exit_reason === 'recovery_required') current.last_exit_reason = null;
      }
      return current;
    });
  };

  const resetAdvanceToTodo = (): { reconciled: boolean; ticketId: string } => {
    if (refinementRepositoryIdentity(workingDir, sessionDir) !== advance.baseline_repository_identity) {
      if (!isGitRepo(workingDir) || !advance.baseline_head_sha) {
        return { reconciled: false, ticketId: advance.ticket_id };
      }
      const changedPaths = listChangedPathsSince(workingDir, advance.baseline_head_sha);
      let allowedPaths = advance.phase === 'verified' && Array.isArray(advance.verified_changed_paths)
        ? [...advance.verified_changed_paths]
        : [];
      if (allowedPaths.length === 0) {
        try {
          const contract = readFreshTicketScope(
            sessionDir,
            ticket,
            advance.ticket_id,
            advance.baseline_head_sha,
          );
          allowedPaths = [...contract.declared_paths, ...contract.expanded_paths];
        } catch {
          // Legacy direct-mode sessions predate scope.json. Their immutable
          // ticket declaration is the only attributable recovery boundary.
          allowedPaths = resolveTicketScope(ticket).allowedPaths;
        }
      }
      recoverableHardReset({
        workingDir,
        sessionDir,
        targetHead: advance.baseline_head_sha,
        operation: `interrupted-${advance.ticket_id}`,
        ownedPaths: changedPaths.filter((candidate) => (
          allowedPaths.some((allowed) => (
            candidate === allowed || candidate.startsWith(`${allowed}/`)
          ))
        )),
        evidencePaths: changedPaths,
        headRecoveryRef: `refs/pickle/recovery/${path.basename(sessionDir)}/${advance.ticket_id}`,
      });
    }
    if (refinementRepositoryIdentity(workingDir, sessionDir) !== advance.baseline_repository_identity) {
      return { reconciled: false, ticketId: advance.ticket_id };
    }
    updateTicketStatus(sessionDir, advance.ticket_id, {
      status: 'Todo',
      failure_reason: 'Recovered interrupted ticket before durable completion.',
      failure_kind: 'interrupted_ticket_recovered',
    }, {
      transactionPaths: [advancePath, statePath],
      afterWrite: () => {
        clearOwnedRecovery();
        clearRefinementRepositoryAdvance(sessionDir);
      },
    });
    return { reconciled: true, ticketId: advance.ticket_id };
  };

  if (
    advance.phase !== 'verified'
    || !advance.verified_repository_identity
    || !advance.verified_files_fingerprint
    || typeof advance.verified_head_sha !== 'string'
    || !Array.isArray(advance.verified_changed_paths)
  ) {
    return resetAdvanceToTodo();
  }

  let currentIdentity = refinementRepositoryIdentity(workingDir, sessionDir);
  let currentFiles = refinementRepositoryFilesFingerprint(workingDir, sessionDir);
  let currentHead = isGitRepo(workingDir) ? getHeadSha(workingDir) : '';
  const verifiedHasChanges = advance.verified_repository_identity !== advance.baseline_repository_identity;
  const verifiedDirtyBoundary = isGitRepo(workingDir)
    && isWorkingTreeDirty(workingDir)
    && currentFiles === advance.verified_files_fingerprint
    && currentHead === advance.verified_head_sha;

  if (verifiedHasChanges && verifiedDirtyBoundary) {
    if (!advance.requires_clean_commit) return resetAdvanceToTodo();
    resetGitIndex(workingDir);
    stagePaths(workingDir, advance.verified_changed_paths);
    commitTrackedChanges(
      workingDir,
      `pickle: ${advance.ticket_id} - recovered verified ticket\n\nPickle-Ticket: ${advance.ticket_id}`,
    );
    currentIdentity = refinementRepositoryIdentity(workingDir, sessionDir);
    currentFiles = refinementRepositoryFilesFingerprint(workingDir, sessionDir);
    currentHead = getHeadSha(workingDir);
  }

  let verifiedCommittedBoundary = false;
  if (
    verifiedHasChanges
    && currentIdentity === advance.verified_repository_identity
    && isGitRepo(workingDir)
    && getWorkingTreeStatus(workingDir) === ''
    && currentHead !== advance.baseline_head_sha
  ) {
    if (readCommitTrailer(workingDir, currentHead, 'Pickle-Ticket') === advance.ticket_id) {
      verifiedCommittedBoundary = true;
    } else if (countCommitsSince(workingDir, advance.baseline_head_sha) === 1) {
      const amended = amendCommitTrailer(
        workingDir,
        currentHead,
        `Pickle-Ticket: ${advance.ticket_id}`,
      );
      if (amended && readCommitTrailer(workingDir, amended, 'Pickle-Ticket') === advance.ticket_id) {
        currentFiles = refinementRepositoryFilesFingerprint(workingDir, sessionDir);
        currentHead = amended;
        verifiedCommittedBoundary = true;
      }
    }
    if (!verifiedCommittedBoundary) return resetAdvanceToTodo();
  }
  const noOpBoundary = currentFiles === advance.baseline_files_fingerprint
    && currentHead === advance.baseline_head_sha
    && !verifiedHasChanges;
  const autoCommittedBoundary = isGitRepo(workingDir)
    && getWorkingTreeStatus(workingDir) === ''
    && currentFiles === advance.verified_files_fingerprint
    && currentHead !== advance.baseline_head_sha
    && countCommitsSince(workingDir, advance.verified_head_sha) === 1
    && readCommitTrailer(workingDir, currentHead, 'Pickle-Ticket') === advance.ticket_id;
  if (!verifiedCommittedBoundary && !noOpBoundary && !autoCommittedBoundary) {
    if (currentFiles === advance.baseline_files_fingerprint && currentHead === advance.baseline_head_sha) {
      return resetAdvanceToTodo();
    }
    return { reconciled: false, ticketId: advance.ticket_id };
  }

  const updates: Record<string, unknown> = {
    status: 'Done',
    completed_at: new Date().toISOString(),
    failure_reason: null,
    failure_kind: null,
    failed_at: null,
  };
  if (currentHead && currentHead !== advance.baseline_head_sha) updates.completion_commit = currentHead;
  updateTicketStatus(sessionDir, advance.ticket_id, updates, {
    transactionPaths: [refinementAcceptancePath(sessionDir), advancePath, statePath],
    afterWrite: () => {
      refreshAcceptedRefinementRepositoryIdentity(sessionDir, workingDir);
      clearOwnedRecovery();
      clearRefinementRepositoryAdvance(sessionDir);
    },
  });
  return { reconciled: true, ticketId: advance.ticket_id };
}
