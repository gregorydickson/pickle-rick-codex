import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pickle-utils.js';
import { readLogicalPipeline, type InstalledRuntimeDescriptor } from './durable-supervisor.js';
import { assertPrdSealMatchesPrd, readPrdSeal } from './prd-seal.js';
import { StateManager } from './state-manager.js';

export const LIVE_SESSION_MIGRATION_SCHEMA_VERSION = 1;
export const LIVE_SESSION_MIGRATION_FILE = 'installed-runtime-migration.json';

export class LiveSessionMigrationContentionError extends Error {
  readonly code = 'live_session_migration_contention';
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'LiveSessionMigrationContentionError';
    this.retryable = retryable;
  }
}

export interface PreservedArtifact {
  path: string;
  sha256: string;
  size: number;
}

export interface SessionResumeCheckpoint {
  ticket_id: string | null;
  phase: string;
  reuse_phases: string[];
  reason: string;
  history_length: number;
}

export interface InstalledRuntimeMigration {
  schema_version: 1;
  migration_id: string;
  source_runtime: InstalledRuntimeDescriptor;
  target_runtime: InstalledRuntimeDescriptor;
  session_schema: number;
  session_was_active: true;
  resume_checkpoint: SessionResumeCheckpoint;
  preserved_artifacts: PreservedArtifact[];
  salvage_refs: string[];
  created_at: string;
  content_hash: string;
}

export interface PrepareLiveSessionMigrationOptions {
  forceVerificationContractRepair?: boolean;
  maxSnapshotAttempts?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => void;
  checkpoint?: (stage: 'migration_written', attempt: number, migration: InstalledRuntimeMigration) => void;
}

const migrationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

// Bounded operational telemetry may be updated by readiness diagnostics after
// a migration is sealed. It remains in place, but is not continuity authority.
const MUTABLE_SESSION_TELEMETRY = new Set(['readiness-history.json']);

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function sessionFiles(root: string, current = root): string[] {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isSymbolicLink()) throw new Error(`Session migration refuses symbolic link: ${relative}.`);
    if (entry.isDirectory() && ['watch-materials', 'watch-terminal-recovery'].includes(relative)) return [];
    if (entry.isDirectory()) return sessionFiles(root, absolute);
    if (!entry.isFile() || relative === LIVE_SESSION_MIGRATION_FILE
      || MUTABLE_SESSION_TELEMETRY.has(relative)
      || relative === 'legacy-session-adoption-transaction.json'
      || relative === 'legacy-session-adoption.json'
      || relative === 'legacy-session-adoption-watch.json'
      || relative === 'watch-material-ledger.json'
      || relative === 'watch-strategy-authority.json'
      || relative === 'legacy-session-adoption-executor.json'
      || relative === 'legacy-session-adoption-executor-launch.json'
      || relative.startsWith('legacy-session-adoption-executor-launch.json.tmp.')
      || relative.startsWith('legacy-session-adoption-executor-restart')
      || relative.startsWith('.legacy-session-adoption-executor-restart')
      || relative === 'legacy-session-adoption-supervisor-owner.json'
      || relative.endsWith('.lock')) return [];
    return [relative];
  });
}

function durablePreservedArtifacts(artifacts: PreservedArtifact[]): PreservedArtifact[] {
  return artifacts.filter((artifact) => !MUTABLE_SESSION_TELEMETRY.has(artifact.path));
}

function inventory(sessionDir: string): PreservedArtifact[] {
  return sessionFiles(sessionDir).sort().map((relative) => {
    const content = fs.readFileSync(path.join(sessionDir, relative));
    return { path: relative, sha256: sha256(content), size: content.length };
  });
}

function stableInventory(sessionDir: string): PreservedArtifact[] {
  const first = inventory(sessionDir);
  const second = inventory(sessionDir);
  if (canonicalize(first) !== canonicalize(second)) {
    throw new LiveSessionMigrationContentionError('Live session changed while its migration snapshot was being captured.');
  }
  const logical = path.join(sessionDir, 'logical-pipeline.json');
  if (fs.existsSync(logical)) readLogicalPipeline(sessionDir);
  return second;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function approvedLifecyclePhases(sessionDir: string, ticketId: string): string[] {
  const root = path.join(sessionDir, 'worker-lifecycle', ticketId.toLowerCase());
  const reusable: string[] = [];
  for (const phase of ['research', 'research_review', 'plan', 'plan_review']) {
    const artifact = readJson(path.join(root, `${phase}.json`));
    if (!artifact || artifact.phase !== phase || String(artifact.ticket_id).toLowerCase() !== ticketId.toLowerCase()) break;
    if (phase.endsWith('review') && artifact.verdict !== 'approved') break;
    reusable.push(phase);
  }
  return reusable;
}

function malformedVerificationForTicket(sessionDir: string, ticketId: string): boolean {
  const manifest = readJson(path.join(sessionDir, 'refinement_manifest.json'));
  const tickets = Array.isArray(manifest?.tickets) ? manifest.tickets : [];
  const ticket = tickets.find((entry) => entry && typeof entry === 'object'
    && String((entry as Record<string, unknown>).id).toLowerCase() === ticketId.toLowerCase()) as Record<string, unknown> | undefined;
  if (!ticket) return false;
  const serialized = JSON.stringify(ticket.verification ?? ticket.verify ?? '');
  return serialized.includes('`') || /--(?:testPathPattern|testNamePattern)=[^\s"']*[|]/.test(serialized);
}

function deriveResumeCheckpoint(
  sessionDir: string,
  state: Record<string, unknown>,
  options: PrepareLiveSessionMigrationOptions = {},
): SessionResumeCheckpoint {
  const ticketId = typeof state.current_ticket === 'string' && state.current_ticket ? state.current_ticket : null;
  const reusePhases = ticketId ? approvedLifecyclePhases(sessionDir, ticketId) : [];
  const malformed = Boolean(ticketId && malformedVerificationForTicket(sessionDir, ticketId));
  const verificationFailure = state.failure_kind === 'verification-contract-failed'
    || state.failure_kind === 'verification_contract_failed';
  const history = Array.isArray(state.history) ? state.history : [];
  if (options.forceVerificationContractRepair || malformed || verificationFailure) {
    return {
      ticket_id: ticketId,
      phase: 'verification_contract_repair',
      reuse_phases: reusePhases,
      reason: options.forceVerificationContractRepair
        ? 'legacy session adoption requires structured verification contract repair'
        : malformed ? 'legacy verification requires structured contract repair' : 'persisted verification contract failure',
      history_length: history.length,
    };
  }
  return {
    ticket_id: ticketId,
    phase: typeof state.step === 'string' && state.step ? state.step : 'readiness',
    reuse_phases: reusePhases,
    reason: 'resume persisted active session step',
    history_length: history.length,
  };
}

export function listSessionSalvageRefs(workingDir: string, sessionId: string): string[] {
  try {
    return execFileSync('git', ['for-each-ref', '--format=%(refname):%(objectname)', `refs/pickle/salvage/${sessionId}`, `refs/pickle/salvage-history/${sessionId}`], {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}

function validateRuntime(runtime: InstalledRuntimeDescriptor, sessionSchema: number): void {
  if (!runtime.runtime_id || !runtime.version || !runtime.build_hash) throw new Error('Installed runtime identity is incomplete.');
  if (!Number.isInteger(runtime.min_state_schema) || !Number.isInteger(runtime.max_state_schema)
    || sessionSchema < runtime.min_state_schema || sessionSchema > runtime.max_state_schema) {
    throw new Error(`Installed runtime ${runtime.runtime_id} cannot read session schema ${sessionSchema}.`);
  }
}

export function prepareLiveSessionHandoffCheckpoint(
  sessionDir: string,
  sourceRuntime: InstalledRuntimeDescriptor,
  targetRuntime: InstalledRuntimeDescriptor,
): SessionResumeCheckpoint {
  const state = readJson(path.join(sessionDir, 'state.json'));
  if (!state || state.active !== true) throw new Error('Live session handoff requires an active session.');
  const sessionSchema = Number(state.schema_version ?? 1);
  if (!Number.isInteger(sessionSchema) || sessionSchema < 1) throw new Error('Live session has an invalid schema version.');
  validateRuntime(sourceRuntime, sessionSchema);
  validateRuntime(targetRuntime, sessionSchema);
  return deriveResumeCheckpoint(sessionDir, state);
}

export function prepareLiveSessionMigration(
  sessionDir: string,
  sourceRuntime: InstalledRuntimeDescriptor,
  targetRuntime: InstalledRuntimeDescriptor,
  now = new Date(),
  options: PrepareLiveSessionMigrationOptions = {},
): InstalledRuntimeMigration {
  const migrationPath = path.join(sessionDir, LIVE_SESSION_MIGRATION_FILE);
  const maxAttempts = Math.max(1, Math.min(10, options.maxSnapshotAttempts ?? 3));
  const retryDelayMs = Math.max(0, Math.min(250, options.retryDelayMs ?? 25));
  const wait = options.wait || ((milliseconds: number) => (
    Atomics.wait(migrationWaitBuffer, 0, 0, milliseconds)
  ));
  const lock = new StateManager({ acquireTimeoutMs: 30_000, staleLockThresholdMs: 30_000 });
  lock.acquireLock(migrationPath);
  try {
    let lastContention: LiveSessionMigrationContentionError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const preservedArtifacts = stableInventory(sessionDir);
        // Read state after the stable inventory. The confirmation below then
        // rejects a state transition on either side of this semantic capture.
        const state = readJson(path.join(sessionDir, 'state.json'));
        if (!state) throw new Error('Live session migration requires a valid state.json.');
        if (state.active !== true) throw new Error('Live session migration requires an active session.');
        const sessionSchema = Number(state.schema_version ?? 1);
        if (!Number.isInteger(sessionSchema) || sessionSchema < 1) throw new Error('Live session has an invalid schema version.');
        validateRuntime(sourceRuntime, sessionSchema);
        validateRuntime(targetRuntime, sessionSchema);
        const payload = {
          schema_version: LIVE_SESSION_MIGRATION_SCHEMA_VERSION as 1,
          migration_id: crypto.randomUUID(),
          source_runtime: sourceRuntime,
          target_runtime: targetRuntime,
          session_schema: sessionSchema,
          session_was_active: true as const,
          resume_checkpoint: deriveResumeCheckpoint(sessionDir, state, options),
          preserved_artifacts: preservedArtifacts,
          salvage_refs: listSessionSalvageRefs(String(state.working_dir || ''), path.basename(sessionDir)),
          created_at: now.toISOString(),
        };
        const migration = { ...payload, content_hash: sha256(canonicalize(payload)) };
        atomicWriteJson(migrationPath, migration);
        options.checkpoint?.('migration_written', attempt, migration);
        const confirmed = inventory(sessionDir);
        const persisted = readJson(migrationPath);
        const receiptMatches = persisted?.migration_id === migration.migration_id
          && persisted.content_hash === migration.content_hash;
        if (canonicalize(confirmed) === canonicalize(payload.preserved_artifacts)
          && receiptMatches) return migration;

        if (!receiptMatches) {
          throw new LiveSessionMigrationContentionError(
            'Another migration receipt won while the live session snapshot was being sealed.', false,
          );
        }

        // Delete only this attempt's exact receipt. A concurrent or recovered
        // writer's migration must never be removed by our contention cleanup.
        if (persisted?.migration_id === migration.migration_id
          && persisted.content_hash === migration.content_hash) {
          fs.rmSync(migrationPath, { force: true });
        }
        lastContention = new LiveSessionMigrationContentionError(
          'Live session changed before its migration snapshot could be sealed.',
        );
      } catch (error) {
        if (!(error instanceof LiveSessionMigrationContentionError)) throw error;
        if (!error.retryable) throw error;
        lastContention = error;
      }
      if (attempt < maxAttempts && retryDelayMs > 0) wait(retryDelayMs);
    }
    throw lastContention || new LiveSessionMigrationContentionError(
      'Live session migration exhausted its bounded snapshot attempts.',
    );
  } finally {
    lock.releaseLock(migrationPath);
  }
}

/** Rebind an already sealed migration to a compatible replacement runtime
 * without recapturing session artifacts, salvage refs, or resume state. */
export function deriveRepinnedLiveSessionMigration(
  prior: InstalledRuntimeMigration,
  targetRuntime: InstalledRuntimeDescriptor,
  now = new Date(),
): InstalledRuntimeMigration {
  const { content_hash: priorContentHash, ...priorPayload } = prior;
  if (priorContentHash !== sha256(canonicalize(priorPayload)) || prior.session_was_active !== true) {
    throw new Error('Cannot repin an invalid or inactive sealed migration manifest.');
  }
  validateRuntime(prior.source_runtime, prior.session_schema);
  validateRuntime(targetRuntime, prior.session_schema);
  const payload = {
    schema_version: LIVE_SESSION_MIGRATION_SCHEMA_VERSION as 1,
    migration_id: crypto.randomUUID(),
    source_runtime: prior.source_runtime,
    target_runtime: targetRuntime,
    session_schema: prior.session_schema,
    session_was_active: true as const,
    resume_checkpoint: prior.resume_checkpoint,
    preserved_artifacts: durablePreservedArtifacts(prior.preserved_artifacts),
    salvage_refs: prior.salvage_refs,
    created_at: now.toISOString(),
  };
  return { ...payload, content_hash: sha256(canonicalize(payload)) };
}

export function verifyLiveSessionMigration(sessionDir: string, migration: InstalledRuntimeMigration): void {
  const { content_hash: contentHash, ...payload } = migration;
  if (contentHash !== sha256(canonicalize(payload))) throw new Error('Live session migration manifest hash mismatch.');
  const current = new Map(stableInventory(sessionDir).map((entry) => [entry.path, entry]));
  for (const preserved of durablePreservedArtifacts(migration.preserved_artifacts)) {
    const actual = current.get(preserved.path);
    if (!actual || actual.sha256 !== preserved.sha256 || actual.size !== preserved.size) {
      throw new Error(`Live session migration continuity failed for ${preserved.path}.`);
    }
  }
  const state = readJson(path.join(sessionDir, 'state.json'));
  const refs = listSessionSalvageRefs(String(state?.working_dir || ''), path.basename(sessionDir));
  if (migration.salvage_refs.some((ref) => !refs.includes(ref))) throw new Error('Live session migration lost salvage refs.');
}

export function verifyLiveSessionMigrationDomainBoundary(
  sessionDir: string,
  migration: InstalledRuntimeMigration,
  sourceRuntime: InstalledRuntimeDescriptor,
  targetRuntime: InstalledRuntimeDescriptor,
  options: PrepareLiveSessionMigrationOptions = {},
): void {
  verifyLiveSessionMigration(sessionDir, migration);
  const state = readJson(path.join(sessionDir, 'state.json'));
  if (!state || state.active !== true) throw new Error('Live session migration no longer describes an active session.');
  const sessionSchema = Number(state.schema_version ?? 1);
  if (!Number.isInteger(sessionSchema) || sessionSchema < 1 || migration.session_schema !== sessionSchema) {
    throw new Error('Live session migration schema does not match the durable session state.');
  }
  validateRuntime(sourceRuntime, sessionSchema);
  validateRuntime(targetRuntime, sessionSchema);
  if (canonicalize(migration.source_runtime) !== canonicalize(sourceRuntime)
    || canonicalize(migration.target_runtime) !== canonicalize(targetRuntime)) {
    throw new Error('Live session migration runtime identity does not match the installed runtime.');
  }
  const currentInventory = stableInventory(sessionDir);
  const durableMigrationArtifacts = durablePreservedArtifacts(migration.preserved_artifacts);
  const preservedPaths = new Set(durableMigrationArtifacts.map((artifact) => artifact.path));
  const postSealArtifacts = currentInventory.filter((artifact) => !preservedPaths.has(artifact.path));
  if (postSealArtifacts.some((artifact) => !['logical-pipeline.json', 'prd.lock.json'].includes(artifact.path))) {
    throw new Error('Live session migration has unauthenticated post-seal artifacts.');
  }
  const currentPreserved = currentInventory.filter((artifact) => preservedPaths.has(artifact.path));
  if (canonicalize(durableMigrationArtifacts) !== canonicalize(currentPreserved)) {
    throw new Error('Live session migration inventory does not exactly match the durable session.');
  }
  const postSealPrd = postSealArtifacts.some((artifact) => artifact.path === 'prd.lock.json')
    ? readPrdSeal(sessionDir) : null;
  const postSealJournal = postSealArtifacts.some((artifact) => artifact.path === 'logical-pipeline.json');
  if (postSealPrd && !postSealJournal) {
    throw new Error('Live session migration post-seal PRD has no adoption journal.');
  }
  if (postSealPrd) {
    const seal = postSealPrd;
    assertPrdSealMatchesPrd(seal, fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf8'));
  }
  if (postSealJournal) {
    const logical = readLogicalPipeline(sessionDir);
    const adoption = [...logical.events].reverse().find((event) => event.kind === 'legacy_session_adopted');
    if (!adoption
      || adoption.details.migration_content_hash !== migration.content_hash
      || canonicalize(adoption.details.source_runtime) !== canonicalize(sourceRuntime)
      || canonicalize(adoption.details.target_runtime) !== canonicalize(targetRuntime)
      || canonicalize(adoption.details.resume_checkpoint) !== canonicalize(migration.resume_checkpoint)) {
      throw new Error('Live session migration post-seal journal is not bound to the adoption.');
    }
    const seal = postSealPrd || (fs.existsSync(path.join(sessionDir, 'prd.lock.json')) ? readPrdSeal(sessionDir) : null);
    if (!seal || logical.control_state !== 'autonomous_execution'
      || logical.prd_seal_hash !== seal.semantic_hash) {
      throw new Error('Live session migration post-seal PRD is not bound to the adoption journal.');
    }
  }
  const salvageRefs = listSessionSalvageRefs(String(state.working_dir || ''), path.basename(sessionDir));
  if (canonicalize(migration.salvage_refs) !== canonicalize(salvageRefs)) {
    throw new Error('Live session migration salvage refs do not exactly match the durable session.');
  }
  const checkpoint = deriveResumeCheckpoint(sessionDir, state, options);
  if (canonicalize(migration.resume_checkpoint) !== canonicalize(checkpoint)) {
    throw new Error('Live session migration resume checkpoint does not match the durable session.');
  }
}


export function finalizeLiveSessionMigrationAfterHandoff(
  sessionDir: string,
  requestId: string,
  targetRuntime: InstalledRuntimeDescriptor,
): InstalledRuntimeMigration {
  const logical = readLogicalPipeline(sessionDir);
  const request = logical.events.find((event) => event.kind === 'runtime_handoff_requested'
    && event.details.request_id === requestId);
  if (!request) throw new Error(`Unknown runtime handoff request: ${requestId}.`);
  const sourceRuntime = request.details.source_runtime as InstalledRuntimeDescriptor;
  const migration = prepareLiveSessionMigration(sessionDir, sourceRuntime, targetRuntime);
  verifyLiveSessionMigration(sessionDir, migration);
  return migration;
}
