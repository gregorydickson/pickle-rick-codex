import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertCodexSucceeded, hasPromiseToken, runCodexExecMonitored } from './codex.js';
import { captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { assertPrdSealMatchesPrd, readPrdSeal } from './prd-seal.js';
import { StateManager } from './state-manager.js';
import { getHeadSha, getSymbolicHead, getWorkingTreeFingerprint, isGitRepo } from './git-utils.js';
import {
  normalizeTicketId,
  readManifest,
  restructureTicketFiles,
  ticketDependencyIds,
} from './tickets.js';
import type { RefinementManifest, Ticket } from '../types/index.js';
import type { RecoveryStrategyEpoch } from './productive-autonomy.js';

interface DependencyRepairRow {
  ticket_id: string;
  depends_on: string[];
}

interface DependencyRepairArtifact {
  schema_version: 1;
  target_ticket_id: string;
  manifest_sha256: string;
  prd_seal_sha256: string;
  tickets: DependencyRepairRow[];
  rationale: string;
}

export interface DependencyGraphInspection {
  rows: DependencyRepairRow[];
  repair_ticket_ids: string[];
  findings: string[];
}

interface FileSnapshot {
  file_path: string;
  existed: boolean;
  mode: number | null;
  symlink: string | null;
  content: Buffer | null;
}

interface WorkerFence {
  repo_is_git: boolean;
  repo_head: string;
  repo_symbolic_head: string | null;
  repo_fingerprint: string;
  repo_files: FileSnapshot[];
  repo_index: FileSnapshot;
  session_files: FileSnapshot[];
  state: Record<string, unknown>;
}

function canonicalId(ticket: Ticket): string {
  return normalizeTicketId(ticket.id, ticket.id);
}

function graphRows(tickets: Ticket[]): DependencyRepairRow[] {
  return tickets.map((ticket) => ({
    ticket_id: canonicalId(ticket),
    depends_on: ticketDependencyIds(ticket),
  }));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function manifestIdentity(sessionDir: string): string {
  return sha256(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json')));
}

function sealIdentity(sessionDir: string): string {
  const sealPath = path.join(sessionDir, 'prd.lock.json');
  return fs.existsSync(sealPath) ? sha256(fs.readFileSync(sealPath)) : sha256('unsealed');
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function strictDependencyIds(ticket: Record<string, unknown>, ticketId: string, findings: string[]): string[] {
  const fields = ['depends_on', 'dependsOn', 'dependencies'].filter((key) => own(ticket, key));
  if (fields.length > 1) findings.push(`${ticketId} declares multiple dependency fields`);
  if (fields.length === 0) return [];
  const value = ticket[fields[0]];
  if (typeof value === 'string') {
    const normalized = normalizeTicketId(value, '');
    if (!normalized || value.trim().toLowerCase() === 'none') return [];
    return [normalized];
  }
  if (!Array.isArray(value)) {
    findings.push(`${ticketId} depends_on must be a string or string array`);
    return [];
  }
  const result: string[] = [];
  for (const dependency of value) {
    if (typeof dependency !== 'string' || !dependency.trim()) {
      findings.push(`${ticketId} depends_on contains a non-string or empty entry`);
      continue;
    }
    const normalized = normalizeTicketId(dependency, '');
    if (normalized && dependency.trim().toLowerCase() !== 'none') result.push(normalized);
  }
  return result;
}

export function inspectTicketDependencyGraph(sessionDir: string): DependencyGraphInspection {
  const raw = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!raw || !Array.isArray(raw.tickets)) {
    throw new Error('dependency-repair-manifest-missing');
  }
  const findings: string[] = [];
  const repairIds = new Set<string>();
  const rows: DependencyRepairRow[] = [];
  const ids = raw.tickets.map((ticket, index) => {
    const record = ticket && typeof ticket === 'object' && !Array.isArray(ticket) ? ticket as Record<string, unknown> : {};
    return normalizeTicketId(typeof record.id === 'string' ? record.id : '', `ticket-${index + 1}`);
  });
  const known = new Set(ids);
  raw.tickets.forEach((ticket, index) => {
    const ticketId = ids[index];
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
      findings.push(`${ticketId} ticket row must be an object`);
      repairIds.add(ticketId);
      rows.push({ ticket_id: ticketId, depends_on: [] });
      return;
    }
    const before = findings.length;
    const dependencies = strictDependencyIds(ticket as Record<string, unknown>, ticketId, findings);
    if (findings.length !== before) repairIds.add(ticketId);
    if (dependencies.some((dependency) => !known.has(dependency))) {
      findings.push(`${ticketId} references a missing dependency`);
      repairIds.add(ticketId);
    }
    if (dependencies.includes(ticketId)) {
      findings.push(`${ticketId} depends on itself`);
      repairIds.add(ticketId);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      findings.push(`${ticketId} declares duplicate dependencies`);
      repairIds.add(ticketId);
    }
    rows.push({ ticket_id: ticketId, depends_on: dependencies });
  });
  const byId = new Map(rows.map((row) => [row.ticket_id, row.depends_on]));
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (ticketId: string): void => {
    const cycleAt = visiting.indexOf(ticketId);
    if (cycleAt >= 0) {
      const cycle = visiting.slice(cycleAt);
      findings.push(`dependency cycle: ${[...cycle, ticketId].join(' -> ')}`);
      cycle.forEach((id) => repairIds.add(id));
      return;
    }
    if (visited.has(ticketId)) return;
    visiting.push(ticketId);
    for (const dependency of byId.get(ticketId) || []) {
      if (known.has(dependency)) visit(dependency);
    }
    visiting.pop();
    visited.add(ticketId);
  };
  ids.forEach(visit);
  return { rows, repair_ticket_ids: [...repairIds], findings: [...new Set(findings)] };
}

function validateGraphRows(value: unknown, expectedIds: string[]): DependencyRepairRow[] {
  if (!Array.isArray(value) || value.length !== expectedIds.length) {
    throw new Error('dependency-repair-invalid-artifact: graph must contain every ticket exactly once');
  }
  const known = new Set(expectedIds);
  const rows = value.map((raw): DependencyRepairRow => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('dependency-repair-invalid-artifact: graph row must be an object');
    }
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['ticket_id', 'depends_on'].includes(key))
      || typeof record.ticket_id !== 'string'
      || record.ticket_id !== normalizeTicketId(record.ticket_id, '')) {
      throw new Error('dependency-repair-invalid-artifact: graph row schema is not exact');
    }
    const ticketId = record.ticket_id;
    if (!ticketId || !known.has(ticketId) || !Array.isArray(record.depends_on)) {
      throw new Error('dependency-repair-invalid-artifact: graph row identity or dependencies are invalid');
    }
    if (record.depends_on.some((dependency) => (
      typeof dependency !== 'string' || dependency !== normalizeTicketId(dependency, '')
    ))) {
      throw new Error(`dependency-repair-invalid-artifact: ${ticketId} dependencies must be canonical strings`);
    }
    const dependencies = [...record.depends_on] as string[];
    if (dependencies.some((dependency) => !dependency || !known.has(dependency) || dependency === ticketId)
      || new Set(dependencies).size !== dependencies.length) {
      throw new Error(`dependency-repair-invalid-artifact: ${ticketId} has missing, self, or duplicate dependencies`);
    }
    return { ticket_id: ticketId, depends_on: dependencies };
  });
  if (new Set(rows.map((row) => row.ticket_id)).size !== expectedIds.length
    || expectedIds.some((ticketId) => !rows.some((row) => row.ticket_id === ticketId))) {
    throw new Error('dependency-repair-invalid-artifact: graph ticket identities are incomplete or duplicated');
  }
  const dependenciesById = new Map(rows.map((row) => [row.ticket_id, row.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ticketId: string): void => {
    if (visiting.has(ticketId)) throw new Error('dependency-repair-invalid-artifact: graph remains cyclic');
    if (visited.has(ticketId)) return;
    visiting.add(ticketId);
    for (const dependency of dependenciesById.get(ticketId) || []) visit(dependency);
    visiting.delete(ticketId);
    visited.add(ticketId);
  };
  for (const ticketId of expectedIds) visit(ticketId);
  return rows;
}

function acceptanceIdentity(tickets: Ticket[]): string {
  return JSON.stringify(tickets.map((ticket) => ({
    ticket_id: canonicalId(ticket),
    acceptance_criteria: ticket.acceptance_criteria || [],
  })));
}

function assertSealCurrent(sessionDir: string): void {
  if (!fs.existsSync(path.join(sessionDir, 'prd.lock.json'))) return;
  const prdPath = path.join(sessionDir, 'prd.md');
  if (!fs.existsSync(prdPath)) throw new Error('dependency-repair-prd-missing-under-seal');
  assertPrdSealMatchesPrd(readPrdSeal(sessionDir), fs.readFileSync(prdPath, 'utf8'));
}

function snapshotFile(filePath: string): FileSnapshot {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      file_path: filePath,
      existed: true,
      mode: stat.mode,
      symlink: stat.isSymbolicLink() ? fs.readlinkSync(filePath) : null,
      content: stat.isSymbolicLink() ? null : fs.readFileSync(filePath),
    };
  } catch {
    return { file_path: filePath, existed: false, mode: null, symlink: null, content: null };
  }
}

function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    fs.rmSync(snapshot.file_path, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(snapshot.file_path), { recursive: true });
  fs.rmSync(snapshot.file_path, { force: true });
  if (snapshot.symlink !== null) fs.symlinkSync(snapshot.symlink, snapshot.file_path);
  else fs.writeFileSync(snapshot.file_path, snapshot.content || Buffer.alloc(0), { mode: snapshot.mode || 0o600 });
}

function gitOutput(workingDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repositoryFilePaths(workingDir: string): string[] {
  if (!isGitRepo(workingDir)) {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(candidate);
        else files.push(candidate);
      }
    };
    walk(workingDir);
    return files;
  }
  return gitOutput(workingDir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean).map((relative) => path.join(workingDir, relative));
}

function repositoryIndexPath(workingDir: string): string {
  if (!isGitRepo(workingDir)) return path.join(workingDir, '.git', 'index');
  const value = gitOutput(workingDir, ['rev-parse', '--git-path', 'index']).trim();
  return path.isAbsolute(value) ? value : path.resolve(workingDir, value);
}

function protectedSessionPaths(sessionDir: string): string[] {
  const fixed = [
    'prd.md', 'prd.lock.json', 'refinement_manifest.json', 'state.json',
    'logical-pipeline.json', 'pipeline-state.json', 'ticket-transaction-ledger.json',
  ].map((file) => path.join(sessionDir, file));
  const ticketFiles: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (/^linear_ticket_.+\.md$/.test(entry.name)) ticketFiles.push(candidate);
    }
  };
  walk(sessionDir);
  return [...new Set([...fixed, ...ticketFiles])];
}

function logicalState(value: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(value);
  for (const key of [
    'active_child_pid', 'active_child_kind', 'active_child_command',
    'active_child_identity', 'active_child_controller_pid',
  ]) delete clone[key];
  return clone;
}

function captureWorkerFence(sessionDir: string, workingDir: string): WorkerFence {
  return {
    repo_is_git: isGitRepo(workingDir),
    repo_head: getHeadSha(workingDir),
    repo_symbolic_head: getSymbolicHead(workingDir),
    repo_fingerprint: getWorkingTreeFingerprint(workingDir),
    repo_files: repositoryFilePaths(workingDir).map(snapshotFile),
    repo_index: snapshotFile(repositoryIndexPath(workingDir)),
    session_files: protectedSessionPaths(sessionDir).filter((file) => path.basename(file) !== 'state.json').map(snapshotFile),
    state: logicalState(new StateManager().read(path.join(sessionDir, 'state.json'))),
  };
}

function fenceDrift(sessionDir: string, workingDir: string, fence: WorkerFence): string[] {
  const drift: string[] = [];
  if (fence.repo_is_git && getHeadSha(workingDir) !== fence.repo_head) drift.push('repository-head');
  if (fence.repo_is_git && getSymbolicHead(workingDir) !== fence.repo_symbolic_head) drift.push('repository-symbolic-head');
  if (getWorkingTreeFingerprint(workingDir) !== fence.repo_fingerprint) drift.push('repository-index-or-worktree');
  for (const snapshot of fence.session_files) {
    const current = snapshotFile(snapshot.file_path);
    const same = current.existed === snapshot.existed && current.symlink === snapshot.symlink
      && Buffer.compare(current.content || Buffer.alloc(0), snapshot.content || Buffer.alloc(0)) === 0;
    if (!same) drift.push(path.relative(sessionDir, snapshot.file_path));
  }
  const currentState = logicalState(new StateManager().read(path.join(sessionDir, 'state.json')));
  if (JSON.stringify(currentState) !== JSON.stringify(fence.state)) drift.push('state.json');
  return [...new Set(drift)];
}

function restoreWorkerFence(sessionDir: string, workingDir: string, fence: WorkerFence): void {
  const original = new Set(fence.repo_files.map((entry) => entry.file_path));
  for (const current of repositoryFilePaths(workingDir)) {
    if (!original.has(current)) fs.rmSync(current, { force: true });
  }
  fence.repo_files.forEach(restoreFile);
  if (fence.repo_is_git) restoreFile(fence.repo_index);
  if (fence.repo_is_git && fence.repo_symbolic_head) {
    execFileSync('git', ['symbolic-ref', 'HEAD', fence.repo_symbolic_head], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['update-ref', fence.repo_symbolic_head, fence.repo_head], { cwd: workingDir, stdio: 'ignore' });
  } else if (fence.repo_is_git) {
    execFileSync('git', ['update-ref', '--no-deref', 'HEAD', fence.repo_head], { cwd: workingDir, stdio: 'ignore' });
  }
  fence.session_files.forEach(restoreFile);
  const manager = new StateManager();
  manager.update(path.join(sessionDir, 'state.json'), (current) => {
    const cancellation = current.cancel_requested_at;
    const cancelled = current.last_exit_reason === 'cancelled';
    const restored = structuredClone(fence.state);
    if (cancelled) {
      restored.active = false;
      restored.last_exit_reason = 'cancelled';
      restored.cancel_requested_at = cancellation;
    }
    return restored;
  });
}

function readDependencyArtifact(filePath: string): Record<string, unknown> {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
    throw new Error('dependency-repair-invalid-artifact: artifact must be a regular file no larger than 1 MiB');
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('dependency-repair-invalid-artifact: malformed JSON', { cause: error });
    throw error;
  }
}

export function applyTicketDependencyRepairArtifact(
  sessionDir: string,
  targetTicketId: string,
  value: unknown,
): DependencyRepairRow[] {
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = readJsonFile<RefinementManifest>(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.tickets) || manifest.tickets.length === 0) {
    throw new Error('dependency-repair-manifest-missing');
  }
  const normalizedTarget = normalizeTicketId(targetTicketId, targetTicketId);
  const expectedIds = manifest.tickets.map(canonicalId);
  const inspection = inspectTicketDependencyGraph(sessionDir);
  if (!expectedIds.includes(normalizedTarget)) throw new Error(`dependency-repair-ticket-missing: ${targetTicketId}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dependency-repair-invalid-artifact: expected an object');
  }
  const artifact = value as Partial<DependencyRepairArtifact>;
  if (Object.keys(artifact).some((key) => ![
    'schema_version', 'target_ticket_id', 'manifest_sha256', 'prd_seal_sha256', 'tickets', 'rationale',
  ].includes(key))
    || artifact.schema_version !== 1
    || artifact.target_ticket_id !== normalizedTarget
    || artifact.manifest_sha256 !== manifestIdentity(sessionDir)
    || artifact.prd_seal_sha256 !== sealIdentity(sessionDir)
    || typeof artifact.rationale !== 'string' || !artifact.rationale.trim()) {
    throw new Error('dependency-repair-invalid-artifact: exact schema and authoritative identities are required');
  }
  const rows = validateGraphRows(artifact.tickets, expectedIds);
  const originalRows = inspection.rows;
  const repairIds = new Set(inspection.repair_ticket_ids);
  if (!repairIds.has(normalizedTarget)) {
    throw new Error('dependency-repair-invalid-artifact: target is not finding-owned');
  }
  if (rows.some((row) => !repairIds.has(row.ticket_id)
    && JSON.stringify(row.depends_on) !== JSON.stringify(originalRows.find((entry) => entry.ticket_id === row.ticket_id)?.depends_on || []))) {
    throw new Error('dependency-repair-invalid-artifact: unrelated dependency edge changed');
  }
  if (JSON.stringify(rows) === JSON.stringify(originalRows) && inspection.findings.length === 0) {
    throw new Error('dependency-repair-invalid-artifact: graph repair made no material change');
  }
  assertSealCurrent(sessionDir);
  const immutableAcceptance = acceptanceIdentity(manifest.tickets);
  const dependenciesById = new Map(rows.map((row) => [row.ticket_id, row.depends_on]));
  const repairedManifest: RefinementManifest = {
    ...manifest,
    tickets: manifest.tickets.map((ticket) => {
      const repaired = { ...ticket, depends_on: [...(dependenciesById.get(canonicalId(ticket)) || [])] };
      delete repaired.dependsOn;
      delete repaired.dependencies;
      return repaired;
    }),
  };
  if (acceptanceIdentity(repairedManifest.tickets) !== immutableAcceptance) {
    throw new Error('dependency-repair-acceptance-criteria-mutated');
  }
  restructureTicketFiles(sessionDir, repairedManifest);
  assertSealCurrent(sessionDir);
  const persisted = readManifest(sessionDir);
  if (acceptanceIdentity(persisted.tickets) !== immutableAcceptance) {
    throw new Error('dependency-repair-acceptance-criteria-mutated');
  }
  const persistedRows = validateGraphRows(graphRows(persisted.tickets), expectedIds);
  if (JSON.stringify(persistedRows) !== JSON.stringify(rows)) {
    throw new Error('dependency-repair-round-trip-drift');
  }
  const ledger = readJsonFile<{ active?: unknown; history?: Array<{ operation?: string; status?: string }> }>(
    path.join(sessionDir, 'ticket-transaction-ledger.json'), null,
  );
  const committed = ledger?.history?.at(-1);
  if (ledger?.active !== null || committed?.operation !== 'materialize-tickets' || committed.status !== 'committed') {
    throw new Error('dependency-repair-transaction-evidence-missing');
  }
  return persistedRows;
}

export async function repairTicketDependencyContract(
  sessionDir: string,
  ticketId: string,
  options: { strategy?: RecoveryStrategyEpoch | null; timeoutMs?: number; assertDurableOwnership?: () => void } = {},
): Promise<DependencyRepairRow[]> {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const workingDir = String(state.working_dir || '');
  const inspection = inspectTicketDependencyGraph(sessionDir);
  const manifest = readManifest(sessionDir);
  const normalizedTicketId = normalizeTicketId(ticketId, ticketId);
  if (!inspection.repair_ticket_ids.includes(normalizedTicketId)) {
    throw new Error(`dependency-repair-ticket-not-finding-owned: ${normalizedTicketId}`);
  }
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-dependency-repair-'));
  const artifactPath = path.join(candidateDir, 'dependency-repair.json');
  const lastMessagePath = path.join(candidateDir, 'last-message.txt');
  const durableArtifactPath = path.join(sessionDir, 'dependency-repairs', `${normalizedTicketId}.json`);
  assertSealCurrent(sessionDir);
  const expectedManifestIdentity = manifestIdentity(sessionDir);
  const expectedSealIdentity = sealIdentity(sessionDir);
  const prompt = [
    'You are the autonomous ticket dependency graph contract repair worker.',
    `Isolated candidate workspace: ${candidateDir}`,
    `Target ticket ID: ${normalizedTicketId}`,
    `Dependency repair artifact path: ${artifactPath}`,
    `Authoritative manifest SHA-256: ${expectedManifestIdentity}`,
    `Authoritative PRD seal SHA-256: ${expectedSealIdentity}`,
    `Current ticket graph JSON: ${JSON.stringify(inspection.rows)}`,
    `Finding-owned ticket IDs JSON: ${JSON.stringify(inspection.repair_ticket_ids)}`,
    `Dependency contract findings JSON: ${JSON.stringify(inspection.findings)}`,
    `Immutable ticket acceptance criteria JSON: ${acceptanceIdentity(manifest.tickets)}`,
    options.strategy
      ? `Mandatory material repair strategy: ${options.strategy.materialApproach}; strategy hash ${options.strategy.strategyHash}.`
      : 'Mandatory material repair strategy: repair-dependency-or-contract-blockage.',
    'Repair only the depends_on graph. Every ticket must appear exactly once. Use only existing ticket ids, remove cycles and missing/self dependencies, and preserve the smallest valid dependency ordering justified by the sealed PRD.',
    'Do not modify repository files, ticket acceptance criteria, scope, verification, status, or any other ticket field.',
    'Preserve depends_on exactly for every ticket outside the finding-owned ticket IDs.',
    'Write one exact JSON object with schema_version: 1, target_ticket_id, manifest_sha256, prd_seal_sha256, tickets: [{ticket_id, depends_on: string[]}], and a non-empty rationale. Do not add fields or coerce values.',
    'Return <promise>DEPENDENCY_REPAIR_COMPLETE</promise> after writing the artifact.',
  ].join('\n\n');
  options.assertDurableOwnership?.();
  let result;
  let workerError: unknown = null;
  let isolationError: Error | null = null;
  const fence = captureWorkerFence(sessionDir, workingDir);
  try {
    result = await runCodexExecMonitored({
      telemetry: { sessionDir, ticketId: normalizedTicketId, phase: 'dependency_repair' },
      execArgs: ['--sandbox', 'workspace-write', '--skip-git-repo-check'], cwd: candidateDir, prompt,
      timeoutMs: options.timeoutMs || Number(state.worker_timeout_seconds || 900) * 1000,
      outputLastMessagePath: lastMessagePath,
      progressArtifactPaths: [artifactPath], addDirs: [], inheritConfiguredAddDirs: false,
      successCheck: ({ stdout, lastMessage }) => hasPromiseToken(stdout, 'DEPENDENCY_REPAIR_COMPLETE')
        || hasPromiseToken(lastMessage, 'DEPENDENCY_REPAIR_COMPLETE'),
      onSpawn: (child) => manager.update(statePath, (current) => {
        current.active_child_pid = child.pid;
        current.active_child_kind = 'codex';
        current.active_child_command = 'dependency-repair';
        current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
        current.active_child_controller_pid = process.pid;
        return current;
      }),
      cancelCheck: () => manager.read(statePath).active === false,
    });
    options.assertDurableOwnership?.();
  } catch (error) {
    workerError = error;
  } finally {
    manager.update(statePath, (current) => {
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.active_child_identity = null;
      current.active_child_controller_pid = null;
      return current;
    });
    const drift = fenceDrift(sessionDir, workingDir, fence);
    if (drift.length > 0) {
      const candidateArtifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8').slice(0, 64 * 1024) : null;
      restoreWorkerFence(sessionDir, workingDir, fence);
      const quarantinePath = path.join(sessionDir, 'dependency-repair-quarantine.json');
      atomicWriteJson(quarantinePath, {
        schema_version: 1,
        ticket_id: normalizedTicketId,
        reason: 'dependency-repair-isolation-violation',
        drift,
        candidate_artifact: candidateArtifact,
        quarantined_at: new Date().toISOString(),
      });
      fs.rmSync(candidateDir, { recursive: true, force: true });
      isolationError = new Error(`dependency-repair-isolation-violation: ${drift.join(', ')}`);
    }
  }
  if (isolationError) throw isolationError;
  if (workerError) throw workerError;
  if (!result) throw new Error('dependency-repair-worker-result-missing');
  try {
    assertCodexSucceeded(result, `Dependency graph contract repair failed for ${normalizedTicketId}`);
    const artifact = readDependencyArtifact(artifactPath);
    const repaired = applyTicketDependencyRepairArtifact(sessionDir, normalizedTicketId, artifact);
    atomicWriteJson(durableArtifactPath, artifact);
    atomicWriteJson(path.join(sessionDir, 'dependency-repair-current.json'), {
      schema_version: 1,
      ticket_id: normalizedTicketId,
      strategy_hash: options.strategy?.strategyHash || null,
      artifact_path: durableArtifactPath,
      manifest_sha256: expectedManifestIdentity,
      prd_seal_sha256: expectedSealIdentity,
      graph: repaired,
      repaired_at: new Date().toISOString(),
    });
    return repaired;
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
}
