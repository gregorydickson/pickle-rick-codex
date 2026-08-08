import fs from 'node:fs';
import path from 'node:path';
import { assertCodexSucceeded, hasPromiseToken, runCodexExecMonitored } from './codex.js';
import { captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { assertPrdSealMatchesPrd, readPrdSeal } from './prd-seal.js';
import { StateManager } from './state-manager.js';
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
  tickets: DependencyRepairRow[];
  rationale: string;
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
    const ticketId = normalizeTicketId(String(record.ticket_id || ''), '');
    if (!ticketId || !known.has(ticketId) || !Array.isArray(record.depends_on)) {
      throw new Error('dependency-repair-invalid-artifact: graph row identity or dependencies are invalid');
    }
    const dependencies = record.depends_on.map((dependency) => normalizeTicketId(String(dependency || ''), ''));
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
  if (!expectedIds.includes(normalizedTarget)) throw new Error(`dependency-repair-ticket-missing: ${targetTicketId}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dependency-repair-invalid-artifact: expected an object');
  }
  const artifact = value as Partial<DependencyRepairArtifact>;
  if (artifact.schema_version !== 1
    || normalizeTicketId(artifact.target_ticket_id, '') !== normalizedTarget
    || typeof artifact.rationale !== 'string' || !artifact.rationale.trim()) {
    throw new Error('dependency-repair-invalid-artifact: identity and rationale are required');
  }
  const rows = validateGraphRows(artifact.tickets, expectedIds);
  if (JSON.stringify(rows) === JSON.stringify(graphRows(manifest.tickets))) {
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
  const manifest = readManifest(sessionDir);
  const normalizedTicketId = normalizeTicketId(ticketId, ticketId);
  const artifactPath = path.join(sessionDir, 'dependency-repairs', `${normalizedTicketId}.json`);
  const lastMessagePath = path.join(sessionDir, `${normalizedTicketId}.dependency-repair.last-message.txt`);
  assertSealCurrent(sessionDir);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
  fs.rmSync(artifactPath, { force: true });
  const prompt = [
    'You are the autonomous ticket dependency graph contract repair worker.',
    `Session dir: ${sessionDir}`,
    `Working directory: ${workingDir}`,
    `Target ticket ID: ${normalizedTicketId}`,
    `Dependency repair artifact path: ${artifactPath}`,
    `Current ticket graph JSON: ${JSON.stringify(graphRows(manifest.tickets))}`,
    `Immutable ticket acceptance criteria JSON: ${acceptanceIdentity(manifest.tickets)}`,
    options.strategy
      ? `Mandatory material repair strategy: ${options.strategy.materialApproach}; strategy hash ${options.strategy.strategyHash}.`
      : 'Mandatory material repair strategy: repair-dependency-or-contract-blockage.',
    'Repair only the depends_on graph. Every ticket must appear exactly once. Use only existing ticket ids, remove cycles and missing/self dependencies, and preserve the smallest valid dependency ordering justified by the sealed PRD.',
    'Do not modify repository files, ticket acceptance criteria, scope, verification, status, or any other ticket field.',
    'Write one JSON object with schema_version: 1, target_ticket_id, tickets: [{ticket_id, depends_on: string[]}], and a non-empty rationale.',
    'Return <promise>DEPENDENCY_REPAIR_COMPLETE</promise> after writing the artifact.',
  ].join('\n\n');
  options.assertDurableOwnership?.();
  let result;
  try {
    result = await runCodexExecMonitored({
      telemetry: { sessionDir, ticketId: normalizedTicketId, phase: 'dependency_repair' },
      execArgs: ['--sandbox', 'workspace-write'], cwd: workingDir, prompt,
      timeoutMs: options.timeoutMs || Number(state.worker_timeout_seconds || 900) * 1000,
      outputLastMessagePath: lastMessagePath,
      progressArtifactPaths: [artifactPath], addDirs: [sessionDir], inheritConfiguredAddDirs: false,
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
  } finally {
    manager.update(statePath, (current) => {
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.active_child_identity = null;
      current.active_child_controller_pid = null;
      return current;
    });
  }
  assertCodexSucceeded(result, `Dependency graph contract repair failed for ${normalizedTicketId}`);
  const artifact = readJsonFile<Record<string, unknown>>(artifactPath, null);
  if (!artifact) throw new Error('dependency-repair-invalid-artifact: artifact missing');
  const repaired = applyTicketDependencyRepairArtifact(sessionDir, normalizedTicketId, artifact);
  atomicWriteJson(path.join(sessionDir, 'dependency-repair-current.json'), {
    schema_version: 1,
    ticket_id: normalizedTicketId,
    strategy_hash: options.strategy?.strategyHash || null,
    artifact_path: artifactPath,
    graph: repaired,
    repaired_at: new Date().toISOString(),
  });
  return repaired;
}
