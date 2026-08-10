import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  inspectProcessLivenessIdentity,
  inspectRecordedLiveProcessIdentity,
  reapRecordedLiveProcessGroup,
  type OrphanReapResult,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { atomicWriteFile, atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { ensureFencedLegacyAdoptionPrdSeal } from './session-prd-seal.js';
import { StateManager, type PersistedState } from './state-manager.js';
import { assertOwnedTmuxSession, killTmuxSessionById, runTmux, runnerPaneCommandMatches, tmuxSessionExists } from './tmux.js';
import {
  deriveRepinnedLiveSessionMigration,
  prepareLiveSessionMigration,
  verifyLiveSessionMigration,
  verifyLiveSessionMigrationDomainBoundary,
  type InstalledRuntimeMigration,
} from './live-session-migration.js';
import {
  readLogicalPipeline,
  recordLegacySessionAdoption,
  recordLegacySessionAdoptionSupersession,
  type InstalledRuntimeDescriptor,
} from './durable-supervisor.js';
import { describeInstalledRuntime } from './runtime-descriptor.js';
import { acquireSessionOperation } from './session-operation.js';
import { getHeadSha, getWorkingTreeStatus, listWorkingTreeDirtyPaths } from './git-utils.js';
import { pathIsInPipelineScope } from './pipeline-scope.js';
import { stashUnattributableRemainder } from './dirty-tree-salvage.js';
import {
  persistRejectedCandidateCheckpoint,
  readRejectedCandidateCheckpoint,
  restoreRejectedCandidateCheckpoint,
} from './candidate-recovery.js';
import { reconcileArchivedCandidateRefinementBoundary, refinementRepositoryAdvancePath } from './refinement-artifacts.js';
import { assertCitadelReleaseApproval, citadelReportPath } from './citadel.js';
import { reclaimLaunchReservations, withLaunchReservations } from './detached-launch.js';
import { assertNoModernOwnershipEvidence, modernOwnershipEvidence } from './modern-ownership-evidence.js';
import {
  authenticatedReadyProcessOwner,
  deriveAutonomousProcessOwnerSpec,
  ensureAutonomousOwnerRecoveryDaemon,
  validateAutonomousOwnerSpec,
  type AutonomousOwnerSpec,
  type AutonomousSupervisorReadyReceipt,
} from './autonomous-owner-recovery.js';
import { validCommittedLegacyAdoptionTransfer } from './legacy-adoption-transfer-proof.js';

export const LEGACY_ADOPTION_FILE = 'legacy-session-adoption.json';
export const LEGACY_ADOPTION_SCHEMA_VERSION = 1;
export const LEGACY_ADOPTION_TRANSACTION_FILE = 'legacy-session-adoption-transaction.json';

export interface LegacyTmuxBinding {
  session_name: string;
  session_id: string;
  session_created: string;
  pane_id: string;
  pane_pid: number;
  pane_start_command: string;
}

export interface ObservedLegacyProcess {
  identity: PersistedProcessIdentity;
  command: string;
  parent_pid: number;
}

export interface LegacyAdoptionRecord {
  schema_version: 1;
  status: 'adopted' | 'launched';
  session_id: string;
  source_runtime: InstalledRuntimeDescriptor;
  target_runtime: InstalledRuntimeDescriptor;
  migration_content_hash: string;
  resume_checkpoint: InstalledRuntimeMigration['resume_checkpoint'];
  legacy_owner: {
    runner: PersistedProcessIdentity;
    supervisor: PersistedProcessIdentity | null;
    pane: PersistedProcessIdentity;
    tmux_session_name: string;
    operation_lock_pid: number;
    active_child: PersistedProcessIdentity | null;
  };
  adopted_at: string;
  launched_at?: string;
  launched_runtime_root?: string;
  candidate_archive: { paths: string[]; staged_paths: string[]; ref: string | null };
  target_runtime_supersessions?: LegacyAdoptionTransaction['target_runtime_supersessions'];
}

interface LegacyAdoptionTransaction {
  schema_version: 1;
  stage: 'fenced' | 'quiesced' | 'migrated' | 'sealed' | 'adopted' | 'launching' | 'launched';
  session_id: string;
  source_runtime_root: string;
  target_runtime_root: string;
  source_runtime: InstalledRuntimeDescriptor;
  target_runtime: InstalledRuntimeDescriptor;
  runner: PersistedProcessIdentity;
  supervisor: PersistedProcessIdentity | null;
  pane: PersistedProcessIdentity;
  tmux: LegacyTmuxBinding;
  operation_lock_pid: number;
  operation_lock_sha256: string;
  active_child: PersistedProcessIdentity | null;
  candidate_archive: { paths: string[]; staged_paths: string[]; ref: string | null };
  controller_fenced?: boolean;
  controller_fence?: {
    status: 'preparing' | 'fenced' | 'released';
    prepared_at: string;
    fenced_at: string | null;
    released_at: string | null;
  };
  candidate_archive_restored?: boolean;
  controller_shutdown?: {
    status: 'prepared' | 'committed';
    prepared_at: string;
    committed_at: string | null;
  };
  post_handoff_recovery?: {
    status: 'pending' | 'ownership_transferred';
    evidence: string[];
    owner_identity: PersistedProcessIdentity | null;
    recovery_daemon_identity: PersistedProcessIdentity | null;
    challenge: string;
    owner_spec_id?: string | null;
    ready_receipt_id?: string | null;
    owner_spec?: AutonomousOwnerSpec | null;
    ready_receipt?: AutonomousSupervisorReadyReceipt | null;
    updated_at: string;
  };
  migration_content_hash?: string;
  superseded_migration_content_hash?: string;
  target_runtime_supersessions?: Array<{
    prior_target_runtime_root: string;
    prior_target_runtime: InstalledRuntimeDescriptor;
    prior_migration_content_hash: string | null;
    replacement_target_runtime_root: string;
    replacement_target_runtime: InstalledRuntimeDescriptor;
    superseded_at: string;
    validation_session_dir: string;
    validation_approval_sha256: string;
    validation_report_sha256: string;
    validation_approval_file_sha256?: string;
    validation_report_file_sha256?: string;
    validation_approval: Record<string, unknown>;
    validation_report: Record<string, unknown>;
  }>;
  target_runtime_repin?: {
    status: 'prepared' | 'completed';
    prior_target_runtime_root: string;
    prior_target_runtime: InstalledRuntimeDescriptor;
    prior_migration_content_hash: string | null;
    replacement_target_runtime_root: string;
    replacement_target_runtime: InstalledRuntimeDescriptor;
    validation_session_dir: string;
    validation_approval_sha256: string;
    validation_report_sha256: string;
    validation_approval_file_sha256?: string;
    validation_report_file_sha256?: string;
    validation_approval: Record<string, unknown>;
    validation_report: Record<string, unknown>;
    prepared_at: string;
    replacement_migration_content_hash?: string;
  };
  post_adoption_repin?: {
    status: 'prepared' | 'journaled' | 'migration_written' | 'record_written' | 'completed';
    prior_adoption_record_sha256: string;
    prior_migration_content_hash: string;
    replacement_migration: InstalledRuntimeMigration;
    replacement_record: LegacyAdoptionRecord;
    supersession: NonNullable<LegacyAdoptionTransaction['target_runtime_supersessions']>[number];
    validation_session_dir: string;
    validation_approval_sha256: string;
    validation_report_sha256: string;
    validation_approval_file_sha256: string;
    validation_report_file_sha256: string;
    validation_approval: Record<string, unknown>;
    validation_report: Record<string, unknown>;
    prepared_at: string;
  };
  boundary_reconciliation?: {
    status: 'prepared' | 'completed';
    ticket_id: string;
    base_head: string;
    recovery_ref: string;
  };
  launched_runtime_root?: string;
  launch_attempt?: {
    runtime_root: string;
    owner_pid: number;
    started_at: string;
    state_path: 'state.json';
    state_size: number;
    state_sha256: string;
    state_base64: string;
    logical_pipeline_size?: number;
    logical_pipeline_sha256?: string;
    logical_pipeline_base64?: string;
    reservation_paths: string[];
  };
  created_at: string;
  updated_at: string;
}

const LEGACY_LAUNCH_MIN_TIMEOUT_MS = 300_000;
const LEGACY_LAUNCH_MAX_TIMEOUT_MS = 7_200_000;
const LEGACY_LAUNCH_STEP_BUDGET_MULTIPLIER = 8;

export function legacyAdoptionLaunchTimeoutMs(
  sessionDir: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const manifest = readJsonFile<{ tickets?: unknown[] }>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const ticketCount = Array.isArray(manifest?.tickets) ? manifest.tickets.length : 0;
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  const workerTimeoutMs = Math.max(60_000, Number(state?.worker_timeout_seconds || 60) * 1_000);
  const readinessAndStartupBudget = Math.max(
    LEGACY_LAUNCH_MIN_TIMEOUT_MS,
    (ticketCount * LEGACY_LAUNCH_STEP_BUDGET_MULTIPLIER + 2) * workerTimeoutMs,
  );
  const configured = Number(env.PICKLE_ADOPTION_LAUNCH_TIMEOUT_MS);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : readinessAndStartupBudget;
  return Math.min(LEGACY_LAUNCH_MAX_TIMEOUT_MS, Math.max(readinessAndStartupBudget, requested));
}

interface LegacyAdoptionDependencies {
  observeProcess?: (pid: number) => ObservedLegacyProcess | null;
  inspectProcess?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused';
  inspectChild?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'ambiguous';
  reapChild?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  reapRunner?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  tmuxExists?: (name: string) => boolean;
  tmuxPanePid?: (name: string) => number | null;
  tmuxBinding?: (name: string) => LegacyTmuxBinding | null;
  killTmux?: (sessionId: string) => void;
  waitForRunnerExit?: (identity: PersistedProcessIdentity) => boolean;
  stopController?: (identity: PersistedProcessIdentity) => void;
  resumeController?: (identity: PersistedProcessIdentity) => void;
  startWatchdog?: (sessionDir: string, sourceRuntimeRoot: string, targetRuntimeRoot: string) => void;
  checkpoint?: (stage: LegacyAdoptionTransaction['stage'] | 'candidate_archived' | 'boundary_prepared' | 'boundary_completed' | 'target_runtime_superseded' | 'journaled' | 'launching'
    | 'post_adoption_repin_prepared' | 'post_adoption_repin_journaled' | 'post_adoption_repin_migration_written'
    | 'post_adoption_repin_record_written' | 'post_adoption_repin_completed'
    | 'post_adoption_repin_journal_applied' | 'post_adoption_repin_migration_applied'
    | 'post_adoption_repin_record_applied') => void;
  afterChildQuiesced?: () => void;
  afterFinalEvidenceCheck?: () => void;
  ensurePostHandoffOwner?: (sessionDir: string) => number | null;
  afterOwnershipTransferRecorded?: () => void;
  candidateRestoreCheckpoint?: (checkpoint: 'prepared' | 'patch_applied' | 'applied' | 'archive_invalidated') => void;
  afterCandidateArchiveCleanup?: () => void;
  simulateProcessDeath?: (error: unknown) => boolean;
  afterLaunchReservationsAcquired?: () => void;
  sealSession?: (sessionDir: string) => unknown;
  launch?: (sessionDir: string, runtimeRoot: string) => void;
  handoff?: (sessionDir: string, sourceRuntimeRoot: string, targetRuntimeRoot: string) => void;
  now?: () => Date;
  validationSessionDir?: string;
}

export function runtimeRootMatchesDescriptor(runtimeRoot: string, descriptor: InstalledRuntimeDescriptor): boolean {
  try {
    return JSON.stringify(describeInstalledRuntime(runtimeRoot)) === JSON.stringify(descriptor);
  } catch {
    return false;
  }
}

function handoffLaunchedRuntime(
  sessionDir: string,
  sourceRuntimeRoot: string,
  targetRuntimeRoot: string,
  state: Record<string, unknown>,
): void {
  const logical = readLogicalPipeline(sessionDir);
  if (!logical.lease) throw new Error('Fallback runtime has no active durable lease for canonical takeover.');
  const tempDir = fs.mkdtempSync(path.join(path.dirname(sessionDir), '.legacy-runtime-handoff-'));
  const specPath = path.join(tempDir, 'handoff.json');
  try {
    atomicWriteJson(specPath, {
      session_dir: sessionDir,
      source_owner_id: logical.lease.owner_id,
      source_token: logical.lease.token,
      source_runtime: describeInstalledRuntime(sourceRuntimeRoot),
      target_runtime: describeInstalledRuntime(targetRuntimeRoot),
      runner_bin: state.pipeline_mode === true ? 'pipeline-runner.js' : 'mux-runner.js',
    });
    const result = spawnSync(process.execPath, [
      path.join(targetRuntimeRoot, 'extension', 'bin', 'runtime-handoff.js'), specPath,
    ], { cwd: String(state.working_dir || process.cwd()), env: process.env, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Canonical runtime handoff failed.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function processCommand(pid: number): string | null {
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function observeProcess(pid: number): ObservedLegacyProcess | null {
  const command = processCommand(pid);
  if (!command) return null;
  const metadata = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'pgid=', '-o', 'state=', '-o', 'lstart='], {
    encoding: 'utf8', timeout: 5_000,
  });
  const match = metadata.status === 0 ? metadata.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/) : null;
  if (!match || match[3].startsWith('Z')) return null;
  const parentPid = Number(match[1]);
  const pgid = Number(match[2]);
  const startTime = match[4].trim();
  return {
    identity: {
      pid,
      pgid,
      start_time: startTime,
      fingerprint: crypto.createHash('sha256').update(`${pid}\0${pgid}\0${startTime}`).digest('hex'),
    },
    command,
    parent_pid: parentPid,
  };
}

function validPersistedIdentity(value: unknown): value is PersistedProcessIdentity {
  const identity = value as PersistedProcessIdentity | null;
  return Boolean(identity && Number.isInteger(identity.pid) && identity.pid > 0
    && Number.isInteger(identity.pgid) && identity.pgid > 0
    && typeof identity.start_time === 'string' && identity.start_time
    && typeof identity.fingerprint === 'string' && identity.fingerprint);
}

interface LegacyOperationLockSnapshot {
  pid: number;
  sha256: string;
}

function legacyOperationLockSnapshot(sessionDir: string): LegacyOperationLockSnapshot {
  const lockPath = path.join(sessionDir, '.session-operation.lock');
  let raw: Buffer;
  try {
    raw = fs.readFileSync(lockPath);
  } catch (error) {
    throw new Error('Legacy adoption requires an owned session-operation lock.', { cause: error });
  }
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error('Legacy adoption requires an owned session-operation lock.', { cause: error });
  }
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Legacy adoption requires an owned session-operation lock.');
  return { pid, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

function retireLegacyOperationLock(
  sessionDir: string,
  expected: LegacyOperationLockSnapshot,
): boolean {
  let current: LegacyOperationLockSnapshot;
  try {
    current = legacyOperationLockSnapshot(sessionDir);
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ENOENT') return false;
    throw error;
  }
  if (current.pid !== expected.pid || current.sha256 !== expected.sha256) {
    return false;
  }
  fs.unlinkSync(path.join(sessionDir, '.session-operation.lock'));
  return true;
}

function exactMuxCommand(command: string, sessionDir: string, runtimeRoot?: string): boolean {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) || [];
  const expectedBin = runtimeRoot ? path.join(fs.realpathSync(runtimeRoot), 'extension', 'bin', 'mux-runner.js') : null;
  return tokens.some((token) => expectedBin ? path.resolve(token) === expectedBin : path.basename(token) === 'mux-runner.js')
    && tokens.some((token) => path.resolve(token) === fs.realpathSync(sessionDir));
}

function exactSupervisorCommand(command: string, sessionDir: string, runtimeRoot: string): boolean {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) || [];
  const expectedBin = path.join(fs.realpathSync(runtimeRoot), 'extension', 'bin', 'supervised-runner.js');
  return tokens.some((token) => path.resolve(token) === expectedBin)
    && tokens.some((token) => path.resolve(token) === fs.realpathSync(sessionDir))
    && tokens.some((token) => token === '--runner-bin=mux-runner.js');
}

function verifiedLegacyControllerTopology(
  runnerPid: number,
  tmux: LegacyTmuxBinding,
  sessionDir: string,
  runtimeRoot: string,
  observe: (pid: number) => ObservedLegacyProcess | null,
  inspect: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused',
  expected?: { runner: PersistedProcessIdentity; supervisor: PersistedProcessIdentity | null; pane: PersistedProcessIdentity },
): { runner: ObservedLegacyProcess; supervisor: ObservedLegacyProcess | null; pane: ObservedLegacyProcess } {
  const runner = observe(runnerPid);
  if (!runner || runner.identity.pid !== runnerPid
      || inspect(runner.identity) !== 'matched' || !exactMuxCommand(runner.command, sessionDir, runtimeRoot)) {
    throw new Error('Legacy mux runner identity or exact argv does not match the active session.');
  }
  const pane = observe(tmux.pane_pid);
  if (!pane || pane.identity.pid !== tmux.pane_pid || inspect(pane.identity) !== 'matched') {
    throw new Error('Legacy tmux pane process identity does not match its immutable binding.');
  }
  let supervisor: ObservedLegacyProcess | null = null;
  if (runner.parent_pid !== tmux.pane_pid) {
    supervisor = observe(runner.parent_pid);
    if (!supervisor || supervisor.identity.pid !== runner.parent_pid
        || inspect(supervisor.identity) !== 'matched'
        || !exactSupervisorCommand(supervisor.command, sessionDir, runtimeRoot)
        || supervisor.parent_pid !== tmux.pane_pid) {
      throw new Error('Legacy mux runner is not owned directly by the exact tmux pane or its exact supervisor.');
    }
  }
  if (expected && (JSON.stringify(runner.identity) !== JSON.stringify(expected.runner)
      || JSON.stringify(supervisor?.identity ?? null) !== JSON.stringify(expected.supervisor)
      || JSON.stringify(pane.identity) !== JSON.stringify(expected.pane))) {
    throw new Error('Legacy tmux controller ancestry changed after it was recorded.');
  }
  return { runner, supervisor, pane };
}

function defaultTmuxBinding(sessionName: string): LegacyTmuxBinding | null {
  const raw = runTmux(['display-message', '-p', '-t', `${sessionName}:0`,
    '#{session_name}\t#{session_id}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_start_command}']);
  const [name, sessionId, created, paneId, rawPid, ...command] = raw.split('\t');
  const panePid = Number(rawPid);
  if (name !== sessionName || !sessionId || !created || !paneId || !Number.isInteger(panePid) || panePid <= 0) return null;
  return { session_name: name, session_id: sessionId, session_created: created, pane_id: paneId,
    pane_pid: panePid, pane_start_command: command.join('\t') };
}

function defaultWaitForExit(identity: PersistedProcessIdentity): boolean {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (inspectProcessLivenessIdentity(identity) === 'not-running') return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return inspectProcessLivenessIdentity(identity) === 'not-running';
}

function assertRuntimeCompatible(runtime: InstalledRuntimeDescriptor, schemaVersion: number): void {
  if (schemaVersion < runtime.min_state_schema || schemaVersion > runtime.max_state_schema) {
    throw new Error(`Runtime ${runtime.runtime_id} cannot read legacy state schema ${schemaVersion}.`);
  }
}

function assertTargetRuntimeSupersessionAuthorized(
  sessionDir: string,
  state: PersistedState,
  transaction: LegacyAdoptionTransaction,
  replacement: InstalledRuntimeDescriptor,
): void {
  if (!['quiesced', 'migrated'].includes(transaction.stage)
    || state.active !== true
    || state.step !== 'verification_contract_repair'
    || state.failure_kind !== 'verification_contract_failed'
    || state.failure_reason !== 'legacy session adoption requires structured verification contract repair'
    || state.tmux_runner_pid !== null
    || state.tmux_session_name !== null
    || state.worker_pid !== null
    || state.active_child_pid !== null
    || state.active_child_identity !== null
    || fs.existsSync(path.join(sessionDir, LEGACY_ADOPTION_FILE))
    || fs.existsSync(path.join(sessionDir, 'prd.lock.json'))) {
    throw new Error('Target runtime supersession requires an exact quiesced pre-adoption repair boundary.');
  }
  const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
  if (fs.existsSync(logicalPath)) {
    const logical = readLogicalPipeline(sessionDir);
    if (logical.lease !== null || logical.events.some((event) => event.kind === 'legacy_session_adopted')) {
      throw new Error('Target runtime supersession refuses an adopted or leased logical pipeline.');
    }
  }
  assertRuntimeCompatible(replacement, Number(state.schema_version ?? 1));
}

function targetRuntimeValidationEvidence(
  targetRuntimeRoot: string,
  validationSessionDir: string | undefined,
): {
  validation_session_dir: string; validation_approval_sha256: string; validation_report_sha256: string;
  validation_approval_file_sha256: string; validation_report_file_sha256: string;
  validation_approval: Record<string, unknown>; validation_report: Record<string, unknown>;
} {
  if (!validationSessionDir) throw new Error('Target runtime supersession requires --validation-session with fresh Citadel approval.');
  const resolvedValidationSession = fs.realpathSync(validationSessionDir);
  assertCitadelReleaseApproval(resolvedValidationSession);
  const validationState = new StateManager().read(path.join(resolvedValidationSession, 'state.json'));
  if (fs.realpathSync(String(validationState.working_dir || '')) !== fs.realpathSync(targetRuntimeRoot)
    || getWorkingTreeStatus(targetRuntimeRoot) !== '') {
    throw new Error('Target runtime validation approval does not bind the exact clean replacement root.');
  }
  const validationApproval = readJsonFile<Record<string, unknown>>(path.join(resolvedValidationSession, 'citadel-release-approval.json'), null);
  const validationReport = readJsonFile<Record<string, unknown>>(citadelReportPath(resolvedValidationSession), null);
  if (!validationApproval || !validationReport) throw new Error('Target runtime validation evidence is incomplete.');
  const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    validation_session_dir: resolvedValidationSession,
    validation_approval_sha256: digest(validationApproval),
    validation_report_sha256: digest(validationReport),
    validation_approval_file_sha256: crypto.createHash('sha256').update(fs.readFileSync(
      path.join(resolvedValidationSession, 'citadel-release-approval.json'),
    )).digest('hex'),
    validation_report_file_sha256: crypto.createHash('sha256').update(fs.readFileSync(
      citadelReportPath(resolvedValidationSession),
    )).digest('hex'),
    validation_approval: validationApproval,
    validation_report: validationReport,
  };
}

function assertPersistedTargetRuntimeValidation(
  repin: {
    validation_session_dir: string;
    validation_approval: Record<string, unknown>;
    validation_report: Record<string, unknown>;
    validation_approval_sha256: string;
    validation_report_sha256: string;
    validation_approval_file_sha256?: string;
    validation_report_file_sha256?: string;
  },
  targetRuntimeRoot: string,
): void {
  const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assertCitadelReleaseApproval(repin.validation_session_dir);
  const currentApproval = readJsonFile<Record<string, unknown>>(
    path.join(repin.validation_session_dir, 'citadel-release-approval.json'), null,
  );
  const currentReport = readJsonFile<Record<string, unknown>>(citadelReportPath(repin.validation_session_dir), null);
  const validationState = new StateManager().read(path.join(repin.validation_session_dir, 'state.json'));
  if (!currentApproval || !currentReport
    || fs.realpathSync(String(validationState.working_dir || '')) !== fs.realpathSync(targetRuntimeRoot)
    || digest(currentApproval) !== repin.validation_approval_sha256
    || digest(currentReport) !== repin.validation_report_sha256
    || (repin.validation_approval_file_sha256 !== undefined
      && crypto.createHash('sha256').update(fs.readFileSync(
        path.join(repin.validation_session_dir, 'citadel-release-approval.json'),
      )).digest('hex') !== repin.validation_approval_file_sha256)
    || (repin.validation_report_file_sha256 !== undefined
      && crypto.createHash('sha256').update(fs.readFileSync(
        citadelReportPath(repin.validation_session_dir),
      )).digest('hex') !== repin.validation_report_file_sha256)
    || JSON.stringify(currentApproval) !== JSON.stringify(repin.validation_approval)
    || JSON.stringify(currentReport) !== JSON.stringify(repin.validation_report)
    || digest(repin.validation_approval) !== repin.validation_approval_sha256
    || digest(repin.validation_report) !== repin.validation_report_sha256
    || repin.validation_approval.head !== getHeadSha(targetRuntimeRoot)
    || getWorkingTreeStatus(targetRuntimeRoot) !== '') {
    throw new Error('Persisted target runtime validation evidence no longer binds the clean replacement checkout.');
  }
}

function validationFileHashes(validationSessionDir: string): {
  validation_approval_file_sha256: string;
  validation_report_file_sha256: string;
} {
  return {
    validation_approval_file_sha256: crypto.createHash('sha256').update(fs.readFileSync(
      path.join(validationSessionDir, 'citadel-release-approval.json'),
    )).digest('hex'),
    validation_report_file_sha256: crypto.createHash('sha256').update(fs.readFileSync(
      citadelReportPath(validationSessionDir),
    )).digest('hex'),
  };
}

function assertPostAdoptionTargetRuntimeValidation(
  repin: NonNullable<LegacyAdoptionTransaction['post_adoption_repin']>,
  targetRuntimeRoot: string,
): void {
  const supersession = repin.supersession;
  if (!/^[a-f0-9]{64}$/.test(repin.validation_approval_file_sha256)
    || !/^[a-f0-9]{64}$/.test(repin.validation_report_file_sha256)
    || supersession.validation_approval_file_sha256 !== repin.validation_approval_file_sha256
    || supersession.validation_report_file_sha256 !== repin.validation_report_file_sha256
    || supersession.validation_session_dir !== repin.validation_session_dir
    || supersession.validation_approval_sha256 !== repin.validation_approval_sha256
    || supersession.validation_report_sha256 !== repin.validation_report_sha256
    || JSON.stringify(supersession.validation_approval) !== JSON.stringify(repin.validation_approval)
    || JSON.stringify(supersession.validation_report) !== JSON.stringify(repin.validation_report)) {
    throw new Error('Post-adoption supersession validation evidence is incomplete or internally inconsistent.');
  }
  assertPersistedTargetRuntimeValidation(repin, targetRuntimeRoot);
}

function attributableCandidatePaths(sessionDir: string, workingDir: string, ticketId: string | null): string[] {
  const paths = listWorkingTreeDirtyPaths(workingDir);
  if (paths.length === 0) return [];
  if (!ticketId) throw new Error('Legacy adoption refuses dirty work without an active ticket.');
  const manifest = readJsonFile<{ tickets?: Array<Record<string, unknown>> }>(path.join(sessionDir, 'refinement_manifest.json'), null);
  const ticket = manifest?.tickets?.find((candidate) => String(candidate.id).toLowerCase() === ticketId.toLowerCase());
  const allowed = Array.isArray(ticket?.allowed_paths) ? ticket.allowed_paths.map(String) : [];
  const foreign = paths.filter((candidate) => !pathIsInPipelineScope(candidate, allowed));
  if (foreign.length > 0) throw new Error(`Legacy adoption refuses unrelated dirty paths: ${foreign.join(', ')}.`);
  return paths;
}

function archiveAttributableCandidate(sessionDir: string, workingDir: string, ticketId: string | null): { paths: string[]; staged_paths: string[]; ref: string | null } {
  const archivePath = path.join(sessionDir, 'legacy-candidate-archive.json');
  type CandidateTxn = {
    schema_version: 1; ticket_id: string; base_head: string; paths: string[]; staged_paths: string[]; ref: string;
    staged_patch_base64?: string; staged_patch_sha256?: string; cleanup_complete: boolean;
  };
  let archived = readJsonFile<CandidateTxn>(archivePath, null);
  const paths = archived?.paths || attributableCandidatePaths(sessionDir, workingDir, ticketId);
  if (paths.length === 0) return { paths: [], staged_paths: [], ref: null };
  if (!ticketId) throw new Error('Legacy candidate archive lost its active ticket identity.');
  if (!archived) {
    const baseHead = getHeadSha(workingDir);
    const stagedPaths = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--', ...paths], {
      cwd: workingDir, encoding: 'utf8', timeout: 30_000,
    }).split('\0').filter(Boolean).sort();
    const stagedPatch = execFileSync('git', ['diff', '--cached', '--binary', baseHead, '--', ...paths], {
      cwd: workingDir, encoding: 'buffer', timeout: 30_000,
    });
    const ref = stashUnattributableRemainder(workingDir, sessionDir, () => undefined);
    if (!ref) throw new Error('Legacy adoption could not archive the attributable active candidate.');
    archived = {
      schema_version: 1, ticket_id: ticketId, base_head: baseHead, paths, staged_paths: stagedPaths, ref,
      ...(stagedPatch.length > 0 ? {
        staged_patch_base64: stagedPatch.toString('base64'),
        staged_patch_sha256: crypto.createHash('sha256').update(stagedPatch).digest('hex'),
      } : {}),
      cleanup_complete: false,
    };
    atomicWriteJson(archivePath, archived);
  }
  if (archived.ticket_id.toLowerCase() !== ticketId.toLowerCase() || archived.base_head !== getHeadSha(workingDir)) {
    throw new Error('Legacy candidate archive identity changed during adoption.');
  }
  let stagedPatch: Buffer | undefined;
  if (archived.staged_patch_base64 !== undefined || archived.staged_patch_sha256 !== undefined) {
    if (typeof archived.staged_patch_base64 !== 'string' || typeof archived.staged_patch_sha256 !== 'string') {
      throw new Error('Legacy candidate archive staged evidence is incomplete.');
    }
    stagedPatch = Buffer.from(archived.staged_patch_base64, 'base64');
    if (stagedPatch.toString('base64') !== archived.staged_patch_base64
      || crypto.createHash('sha256').update(stagedPatch).digest('hex') !== archived.staged_patch_sha256) {
      throw new Error('Legacy candidate archive staged evidence hash does not match.');
    }
  }
  persistRejectedCandidateCheckpoint({
    sessionDir, workingDir, ticketId, baseHead: archived.base_head, recoveryRef: archived.ref,
    evidencePath: archivePath, stagedPaths: archived.staged_paths, stagedPatch,
  });
  const compositePatch = execFileSync('git', ['diff', '--binary', archived.base_head, archived.ref, '--', ...archived.paths], { cwd: workingDir, encoding: 'buffer' });
  const worktreeDirty = spawnSync('git', ['diff', '--quiet', '--', ...archived.paths], { cwd: workingDir }).status !== 0
    || execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...archived.paths], { cwd: workingDir, encoding: 'utf8' }).length > 0;
  if (worktreeDirty) {
    const reverseWorktree = spawnSync('git', ['apply', '--reverse', '--whitespace=nowarn', '-'], {
      cwd: workingDir, input: compositePatch, encoding: 'buffer', timeout: 30_000,
    });
    if (reverseWorktree.status !== 0) throw new Error('Legacy adoption could not reversibly clean the archived candidate worktree.');
  }
  if (spawnSync('git', ['diff', '--cached', '--quiet', '--', ...archived.paths], { cwd: workingDir }).status !== 0) {
    const stagedPatch = execFileSync('git', ['diff', '--cached', '--binary', archived.base_head, '--', ...archived.paths], { cwd: workingDir, encoding: 'buffer' });
    const reverseIndex = spawnSync('git', ['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'], {
      cwd: workingDir, input: stagedPatch, encoding: 'buffer', timeout: 30_000,
    });
    if (reverseIndex.status !== 0) throw new Error('Legacy adoption could not reversibly clean the archived candidate index.');
  }
  if (listWorkingTreeDirtyPaths(workingDir).length > 0) throw new Error('Legacy adoption candidate archive did not leave a clean execution worktree.');
  if (!archived.cleanup_complete) atomicWriteJson(archivePath, { ...archived, cleanup_complete: true });
  return { paths: archived.paths, staged_paths: archived.staged_paths, ref: archived.ref };
}

function assertSessionMapOwnership(sessionDir: string, workingDir: string): void {
  const mapPath = path.join(path.dirname(path.dirname(sessionDir)), 'current_sessions.json');
  const sessionMap = readJsonFile<Record<string, unknown>>(mapPath, null);
  const mapped = sessionMap?.[fs.realpathSync(workingDir)];
  if (typeof mapped !== 'string' || path.resolve(mapped) !== sessionDir) {
    throw new Error('Legacy session map does not bind the working directory to this session.');
  }
}

function applyQuiescedOwnershipClear(state: PersistedState): PersistedState {
  assertNoModernOwnershipEvidence(state,
    'Legacy adoption refuses modern evidence at the atomic ownership-clear boundary.');
  state.tmux_runner_pid = null;
    state.tmux_session_name = null;
    state.tmux_runner_binding = null;
    state.worker_pid = null;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    state.active_child_identity = null;
    if (Object.hasOwn(state, 'active_child_controller_pid')) state.active_child_controller_pid = null;
    if (Object.hasOwn(state, 'active_child_controller_identity')) state.active_child_controller_identity = null;
    state.step = 'verification_contract_repair';
    state.failure_kind = 'verification_contract_failed';
    state.failure_reason = 'legacy session adoption requires structured verification contract repair';
  state.active = true;
  return state;
}

function clearQuiescedOwnership(sessionDir: string): void {
  new StateManager().update(path.join(sessionDir, 'state.json'), applyQuiescedOwnershipClear);
}

function workingTreeEntryMatchesRef(workingDir: string, ref: string, relative: string): boolean {
  const listed = spawnSync('git', ['ls-tree', '-z', ref, '--', relative], {
    cwd: workingDir, encoding: 'buffer', timeout: 30_000,
  });
  if (listed.status !== 0) return false;
  const terminator = listed.stdout.indexOf(0);
  const raw = listed.stdout.subarray(0, terminator >= 0 ? terminator : listed.stdout.length).toString('utf8');
  const expected = raw.match(/^(\d+) (\S+) ([a-f0-9]+)\t/);
  const absolute = path.join(workingDir, relative);
  let stats: fs.Stats;
  try { stats = fs.lstatSync(absolute); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !expected;
  }
  if (!expected || expected[2] !== 'blob') return false;
  const mode = stats.isSymbolicLink() ? '120000'
    : stats.isFile() ? ((stats.mode & 0o111) !== 0 ? '100755' : '100644') : '';
  if (!mode || mode !== expected[1]) return false;
  const content = stats.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
  const hashed = spawnSync('git', ['hash-object', '--stdin'], {
    cwd: workingDir, input: content, encoding: 'utf8', timeout: 30_000,
  });
  return hashed.status === 0 && hashed.stdout.trim() === expected[3];
}

function resumeFencedLegacyController(
  sessionDir: string,
  transactionPath: string,
  transaction: LegacyAdoptionTransaction,
  workingDir: string,
  state: PersistedState,
  deps: LegacyAdoptionDependencies,
  signalController = true,
): LegacyAdoptionTransaction {
  if (!transaction.candidate_archive.ref) {
    const discovered = readJsonFile<{
      cleanup_complete?: boolean; ticket_id?: string; paths?: string[]; staged_paths?: string[]; ref?: string;
    }>(path.join(sessionDir, 'legacy-candidate-archive.json'), null);
    const ticketId = typeof state.current_ticket === 'string' ? state.current_ticket : '';
    const checkpoint = ticketId ? readRejectedCandidateCheckpoint(sessionDir, ticketId) : null;
    if (discovered?.cleanup_complete === true && discovered.ticket_id === ticketId
      && typeof discovered.ref === 'string' && checkpoint?.recovery_ref === discovered.ref
      && Array.isArray(discovered.paths) && Array.isArray(discovered.staged_paths)) {
      transaction = {
        ...transaction,
        candidate_archive: {
          paths: discovered.paths.map(String), staged_paths: discovered.staged_paths.map(String), ref: discovered.ref,
        },
      };
      atomicWriteJson(transactionPath, transaction);
    }
  }
  if (transaction.candidate_archive.ref && !transaction.candidate_archive_restored) {
    const ticketId = typeof state.current_ticket === 'string' ? state.current_ticket : '';
    const restorePath = path.join(sessionDir, 'legacy-candidate-restore.json');
    type RestoreWal = {
      schema_version: 1; status: 'prepared' | 'applied' | 'invalidated'; ticket_id: string;
      archive: LegacyAdoptionTransaction['candidate_archive']; updated_at: string;
    };
    let wal = readJsonFile<RestoreWal>(restorePath, null);
    if (!wal || wal.ticket_id !== ticketId || JSON.stringify(wal.archive) !== JSON.stringify(transaction.candidate_archive)) {
      wal = {
        schema_version: 1, status: 'prepared', ticket_id: ticketId, archive: transaction.candidate_archive,
        updated_at: (deps.now?.() ?? new Date()).toISOString(),
      };
      atomicWriteJson(restorePath, wal);
      deps.candidateRestoreCheckpoint?.('prepared');
    }
    const checkpoint = ticketId ? readRejectedCandidateCheckpoint(sessionDir, ticketId) : null;
    const restoredContentMatches = Boolean(checkpoint && checkpoint.base_head === getHeadSha(workingDir)
      && checkpoint.changed_paths.every((relative) => (
        workingTreeEntryMatchesRef(workingDir, checkpoint.recovery_ref, relative)
      ))
      && (() => {
        const actual = execFileSync('git', ['diff', '--cached', '--binary', checkpoint.base_head, '--',
          ...checkpoint.changed_paths], { cwd: workingDir, encoding: 'buffer' });
        const expected = checkpoint.staged_patch_base64
          ? Buffer.from(checkpoint.staged_patch_base64, 'base64') : Buffer.alloc(0);
        return actual.equals(expected);
      })());
    if (wal.status === 'prepared' && !restoredContentMatches) {
      const restored = ticketId ? restoreRejectedCandidateCheckpoint({
        sessionDir,
        workingDir,
        ticketId,
        expectedBaseHead: getHeadSha(workingDir),
        validateScope: (changedPaths) => {
          if (JSON.stringify([...changedPaths].sort()) !== JSON.stringify([...transaction.candidate_archive.paths].sort())) {
            throw new Error('Legacy candidate restore changed scope before controller resume.');
          }
        },
      }) : null;
      if (!restored) throw new Error('Legacy adoption cannot resume a cleaned candidate without its exact recovery checkpoint.');
      deps.candidateRestoreCheckpoint?.('patch_applied');
    }
    wal = { ...wal, status: 'applied', updated_at: (deps.now?.() ?? new Date()).toISOString() };
    atomicWriteJson(restorePath, wal);
    deps.candidateRestoreCheckpoint?.('applied');
    transaction = {
      ...transaction,
      candidate_archive: { paths: [], staged_paths: [], ref: null },
      candidate_archive_restored: true,
    };
    fs.rmSync(path.join(sessionDir, 'legacy-candidate-archive.json'), { force: true });
    deps.candidateRestoreCheckpoint?.('archive_invalidated');
    atomicWriteJson(transactionPath, transaction);
    atomicWriteJson(restorePath, {
      ...wal, status: 'invalidated', updated_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  if (signalController) {
    try {
      (deps.resumeController || ((identity) => process.kill(identity.pid, 'SIGCONT')))(transaction.runner);
    } catch (error) {
      throw new Error(`Legacy controller remains durably fenced for watchdog retry after resume failure: ${String(error)}`,
        { cause: error });
    }
  }
  transaction = { ...transaction, controller_fenced: false };
  transaction.controller_fence = {
    ...(transaction.controller_fence || {
      prepared_at: (deps.now?.() ?? new Date()).toISOString(), fenced_at: null,
    }),
    status: 'released', released_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  atomicWriteJson(transactionPath, transaction);
  return transaction;
}

function jsonSha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reconcileInterruptedAdoptionLaunch(
  sessionDir: string,
  transactionPath: string,
  transaction: LegacyAdoptionTransaction,
  migration: InstalledRuntimeMigration,
  deps: LegacyAdoptionDependencies,
): LegacyAdoptionTransaction {
  if (transaction.stage !== 'launching') return transaction;
  const attemptedRuntimeRoot = transaction.launch_attempt?.runtime_root || transaction.target_runtime_root;
  const interruptedState = new StateManager().read(path.join(sessionDir, 'state.json'));
  if (exactTargetLaunchOwner(sessionDir, attemptedRuntimeRoot, interruptedState, deps)) {
    throw new Error('Post-adoption supersession refuses a session with an established launch owner.');
  }
  assertNoAmbiguousLaunchOwner(sessionDir, attemptedRuntimeRoot, interruptedState, deps);
  for (const identity of [transaction.runner, transaction.supervisor, transaction.pane, transaction.active_child]) {
    if (identity && (deps.inspectProcess || inspectProcessLivenessIdentity)(identity) === 'matched') {
      throw new Error('Interrupted adoption launch recovery refuses a persisted live legacy owner.');
    }
  }
  if ((deps.tmuxExists || tmuxSessionExists)(transaction.tmux.session_name)
    || (deps.tmuxBinding || defaultTmuxBinding)(transaction.tmux.session_name)) {
    throw new Error('Interrupted adoption launch recovery refuses a live legacy tmux binding.');
  }
  if (transaction.launch_attempt?.owner_pid && transaction.launch_attempt.owner_pid > 0
    && (deps.observeProcess || observeProcess)(transaction.launch_attempt.owner_pid)) {
    throw new Error('Interrupted adoption launch recovery refuses a live launch-attempt owner.');
  }
  if (!transaction.launch_attempt) {
    if (interruptedState.active !== false) {
      throw new Error('Legacy launch recovery cannot reconstruct a non-inactive prelaunch state.');
    }
    const reconstructed = Buffer.from(`${JSON.stringify({ ...interruptedState, active: true }, null, 2)}\n`);
    const preservedState = migration.preserved_artifacts.find((artifact) => artifact.path === 'state.json');
    if (!preservedState || reconstructed.length !== preservedState.size
      || crypto.createHash('sha256').update(reconstructed).digest('hex') !== preservedState.sha256) {
      throw new Error('Legacy launch recovery cannot prove the exact historical state.json bytes.');
    }
    const currentLogical = fs.readFileSync(path.join(sessionDir, 'logical-pipeline.json'));
    const preservedLogical = migration.preserved_artifacts.find((artifact) => artifact.path === 'logical-pipeline.json');
    const logicalSha256 = crypto.createHash('sha256').update(currentLogical).digest('hex');
    if ((preservedLogical && (currentLogical.length !== preservedLogical.size || logicalSha256 !== preservedLogical.sha256))
      || (!preservedLogical && readLogicalPipeline(sessionDir).lease)) {
      throw new Error('Legacy launch recovery cannot prove the historical logical pipeline boundary.');
    }
    transaction = {
      ...transaction,
      launch_attempt: {
        runtime_root: attemptedRuntimeRoot, owner_pid: 0, started_at: transaction.updated_at,
        state_path: 'state.json', state_size: reconstructed.length, state_sha256: preservedState.sha256,
        state_base64: reconstructed.toString('base64'), logical_pipeline_size: currentLogical.length,
        logical_pipeline_sha256: logicalSha256, logical_pipeline_base64: currentLogical.toString('base64'),
        reservation_paths: launchReservationPaths(sessionDir, reconstructed),
      },
    };
    atomicWriteJson(transactionPath, transaction);
  }
  return restoreLaunchAttempt(sessionDir, transactionPath, transaction, migration, deps);
}

function assertPostAdoptionRepinBoundary(
  sessionDir: string,
  transaction: LegacyAdoptionTransaction,
  deps: LegacyAdoptionDependencies,
): void {
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  const legacyOwnershipFields = [
    'tmux_runner_pid', 'tmux_session_name', 'tmux_runner_binding', 'worker_pid',
    'active_child_pid', 'active_child_identity', 'active_child_controller_pid',
    'active_child_controller_identity',
  ];
  const hasPersistedOwnershipEvidence = legacyOwnershipFields.some((field) => state[field] !== null
    && state[field] !== undefined);
  if (transaction.stage !== 'adopted' || transaction.launch_attempt !== undefined || state.active !== true
    || state.step !== 'verification_contract_repair'
    || state.failure_kind !== 'verification_contract_failed'
    || state.failure_reason !== 'legacy session adoption requires structured verification contract repair'
    || hasPersistedOwnershipEvidence
    || modernOwnershipEvidence(state).length > 0) {
    throw new Error('Post-adoption target supersession requires the exact ownerless verification-repair boundary.');
  }
  const logical = readLogicalPipeline(sessionDir);
  if (logical.lease !== null) throw new Error('Post-adoption target supersession refuses a leased logical pipeline.');
  for (const identity of [transaction.runner, transaction.supervisor, transaction.pane, transaction.active_child]) {
    if (identity && (deps.inspectProcess || inspectProcessLivenessIdentity)(identity) === 'matched') {
      throw new Error('Post-adoption target supersession refuses a persisted live legacy owner.');
    }
  }
  if ((deps.tmuxExists || tmuxSessionExists)(transaction.tmux.session_name)
    || (deps.tmuxBinding || defaultTmuxBinding)(transaction.tmux.session_name)) {
    throw new Error('Post-adoption target supersession refuses a live tmux binding.');
  }
}

function repinCompletedAdoption(
  sessionDir: string,
  recordPath: string,
  transactionPath: string,
  record: LegacyAdoptionRecord,
  transaction: LegacyAdoptionTransaction,
  targetRuntimeRoot: string,
  deps: LegacyAdoptionDependencies,
): LegacyAdoptionRecord {
  const migrationPath = path.join(sessionDir, 'installed-runtime-migration.json');
  let migration = readJsonFile<InstalledRuntimeMigration>(migrationPath, null);
  const pendingAtEntry = transaction.post_adoption_repin;
  if (!migration || (!pendingAtEntry && migration.content_hash !== record.migration_content_hash)) {
    throw new Error('Post-adoption supersession lacks the exact sealed migration.');
  }
  if (!pendingAtEntry) transaction = reconcileInterruptedAdoptionLaunch(sessionDir, transactionPath, transaction, migration, deps);
  const replacementRoot = fs.realpathSync(targetRuntimeRoot);
  const replacementRuntime = describeInstalledRuntime(replacementRoot);
  const authoritativeAdoption = [...readLogicalPipeline(sessionDir).events].reverse()
    .find((event) => event.kind === 'legacy_session_adopted');
  if (authoritativeAdoption?.details.prior_adoption_record_sha256 && !transaction.post_adoption_repin) {
    throw new Error('Superseded adoption epoch lacks its mandatory completed repin transaction.');
  }
  if (!transaction.post_adoption_repin
    && replacementRoot === transaction.target_runtime_root
    && JSON.stringify(replacementRuntime) === JSON.stringify(record.target_runtime)) return record;
  if (!pendingAtEntry) {
    assertPostAdoptionRepinBoundary(sessionDir, transaction, deps);
    verifyLiveSessionMigrationDomainBoundary(sessionDir, migration, record.source_runtime, record.target_runtime,
      { forceVerificationContractRepair: true });
  }
  let repin = transaction.post_adoption_repin;
  if (!repin) {
    const validation = targetRuntimeValidationEvidence(replacementRoot, deps.validationSessionDir);
    const preparedAt = (deps.now?.() ?? new Date()).toISOString();
    const replacementMigration = deriveRepinnedLiveSessionMigration(migration, replacementRuntime, deps.now?.() ?? new Date());
    const supersession = {
      prior_target_runtime_root: transaction.target_runtime_root,
      prior_target_runtime: record.target_runtime,
      prior_migration_content_hash: migration.content_hash,
      replacement_target_runtime_root: replacementRoot,
      replacement_target_runtime: replacementRuntime,
      superseded_at: preparedAt,
      ...validation,
    };
    const replacementRecord: LegacyAdoptionRecord = {
      ...record, target_runtime: replacementRuntime, migration_content_hash: replacementMigration.content_hash,
      target_runtime_supersessions: [...(record.target_runtime_supersessions || []), supersession],
    };
    repin = {
      status: 'prepared', prior_adoption_record_sha256: jsonSha256(record),
      prior_migration_content_hash: migration.content_hash, replacement_migration: replacementMigration,
      replacement_record: replacementRecord, supersession, ...validation, prepared_at: preparedAt,
    };
    transaction = { ...transaction, post_adoption_repin: repin, updated_at: preparedAt };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('post_adoption_repin_prepared');
  }
  if (!/^[a-f0-9]{64}$/.test(repin.prior_adoption_record_sha256)
    || !/^[a-f0-9]{64}$/.test(repin.prior_migration_content_hash)) {
    throw new Error('Prepared post-adoption supersession has malformed predecessor evidence.');
  }
  assertPostAdoptionTargetRuntimeValidation(repin, replacementRoot);
  const replacementDescriptor = JSON.stringify(replacementRuntime);
  const completedRepin = repin.status === 'completed';
  if (repin.replacement_record.status !== 'adopted'
    || JSON.stringify(repin.replacement_record.target_runtime) !== replacementDescriptor
    || JSON.stringify(repin.replacement_migration.target_runtime) !== replacementDescriptor
    || JSON.stringify(repin.supersession.replacement_target_runtime) !== replacementDescriptor
    || JSON.stringify(transaction.source_runtime) !== JSON.stringify(repin.replacement_record.source_runtime)
    || JSON.stringify(transaction.target_runtime) !== JSON.stringify(completedRepin
      ? repin.replacement_record.target_runtime : repin.supersession.prior_target_runtime)
    || transaction.migration_content_hash !== (completedRepin
      ? repin.replacement_migration.content_hash : repin.prior_migration_content_hash)
    || repin.supersession.replacement_target_runtime_root !== replacementRoot) {
    throw new Error('Prepared post-adoption supersession does not bind the current replacement runtime.');
  }
  const persistedRecord = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
  const persistedMigration = readJsonFile<InstalledRuntimeMigration>(migrationPath, null);
  const legacyOwner = { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane,
    tmux: transaction.tmux, operation_lock_pid: transaction.operation_lock_pid, active_child: transaction.active_child };
  const priorSupersessions = (repin.replacement_record.target_runtime_supersessions || []).slice(0, -1);
  const expectedPriorDetails = {
    migration_content_hash: repin.prior_migration_content_hash,
    source_runtime: repin.replacement_record.source_runtime,
    target_runtime: repin.supersession.prior_target_runtime,
    target_runtime_supersessions: priorSupersessions,
    resume_checkpoint: { ...repin.replacement_migration.resume_checkpoint },
    legacy_owner: legacyOwner,
  };
  const expectedReplacementDetails = {
    prior_adoption_record_sha256: repin.prior_adoption_record_sha256,
    prior_migration_content_hash: repin.prior_migration_content_hash,
    migration_content_hash: repin.replacement_migration.content_hash,
    source_runtime: repin.replacement_record.source_runtime,
    target_runtime: repin.replacement_record.target_runtime,
    target_runtime_supersessions: repin.replacement_record.target_runtime_supersessions || [],
    resume_checkpoint: { ...repin.replacement_migration.resume_checkpoint },
    legacy_owner: legacyOwner,
    validation_session_dir: repin.validation_session_dir,
    validation_approval_sha256: repin.validation_approval_sha256,
    validation_report_sha256: repin.validation_report_sha256,
  };
  const priorRecordPresent = persistedRecord !== null && jsonSha256(persistedRecord) === repin.prior_adoption_record_sha256;
  const replacementRecordPresent = persistedRecord !== null
    && jsonSha256(persistedRecord) === jsonSha256(repin.replacement_record);
  const priorMigrationPresent = persistedMigration?.content_hash === repin.prior_migration_content_hash;
  const replacementMigrationPresent = persistedMigration?.content_hash === repin.replacement_migration.content_hash;
  const prefixEvent = [...readLogicalPipeline(sessionDir).events].reverse()
    .find((event) => event.kind === 'legacy_session_adopted');
  const priorJournalPresent = JSON.stringify(prefixEvent?.details) === JSON.stringify(expectedPriorDetails);
  const replacementJournalPresent = JSON.stringify(prefixEvent?.details) === JSON.stringify(expectedReplacementDetails);
  if ((!priorRecordPresent && !replacementRecordPresent) || (!priorMigrationPresent && !replacementMigrationPresent)
    || (!priorJournalPresent && !replacementJournalPresent) || (replacementRecordPresent && !replacementMigrationPresent)) {
    throw new Error('Post-adoption supersession artifacts do not match an exact recoverable write prefix.');
  }
  const phaseValid = repin.status === 'prepared'
    ? priorRecordPresent && priorMigrationPresent
    : repin.status === 'journaled'
      ? replacementJournalPresent && priorRecordPresent
      : repin.status === 'migration_written'
        ? replacementJournalPresent && replacementMigrationPresent
        : replacementJournalPresent && replacementMigrationPresent && replacementRecordPresent;
  if (!phaseValid) throw new Error(`Post-adoption supersession ${repin.status} phase has an impossible artifact prefix.`);
  assertPostAdoptionRepinBoundary(sessionDir, transaction, deps);
  const boundaryEvent = [...readLogicalPipeline(sessionDir).events].reverse()
    .find((event) => event.kind === 'legacy_session_adopted');
  if (boundaryEvent?.details.migration_content_hash === repin.replacement_migration.content_hash) {
    verifyLiveSessionMigrationDomainBoundary(sessionDir, repin.replacement_migration,
      repin.replacement_record.source_runtime, repin.replacement_record.target_runtime,
      { forceVerificationContractRepair: true });
  } else if (boundaryEvent?.details.migration_content_hash === repin.prior_migration_content_hash
    && priorMigrationPresent && persistedMigration) {
    verifyLiveSessionMigrationDomainBoundary(sessionDir, persistedMigration, repin.replacement_record.source_runtime,
      repin.supersession.prior_target_runtime, { forceVerificationContractRepair: true });
  } else {
    throw new Error('Post-adoption supersession journal is not an exact prepared write prefix.');
  }
  if (repin.status === 'prepared') {
    const latest = [...readLogicalPipeline(sessionDir).events].reverse().find((event) => event.kind === 'legacy_session_adopted');
    if (latest?.details.migration_content_hash === repin.prior_migration_content_hash) {
      recordLegacySessionAdoptionSupersession(sessionDir, {
        prior_adoption_record_sha256: repin.prior_adoption_record_sha256,
        prior_migration_content_hash: repin.prior_migration_content_hash,
        migration_content_hash: repin.replacement_migration.content_hash,
        source_runtime: record.source_runtime, target_runtime: repin.replacement_record.target_runtime,
        target_runtime_supersessions: repin.replacement_record.target_runtime_supersessions || [],
        resume_checkpoint: { ...repin.replacement_migration.resume_checkpoint }, legacy_owner: legacyOwner,
        validation_session_dir: repin.validation_session_dir,
        validation_approval_sha256: repin.validation_approval_sha256,
        validation_report_sha256: repin.validation_report_sha256,
      }, { nowMs: Date.parse(repin.prepared_at) });
      deps.checkpoint?.('post_adoption_repin_journal_applied');
    } else if (JSON.stringify(latest?.details) !== JSON.stringify(expectedReplacementDetails)) {
      throw new Error('Post-adoption supersession journal diverged from its prepared epoch.');
    }
    repin = { ...repin, status: 'journaled' };
    transaction = { ...transaction, post_adoption_repin: repin };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('post_adoption_repin_journaled');
  }
  if (repin.status === 'journaled') {
    migration = readJsonFile<InstalledRuntimeMigration>(migrationPath, null);
    if (migration?.content_hash === repin.prior_migration_content_hash) {
      atomicWriteJson(migrationPath, repin.replacement_migration);
      deps.checkpoint?.('post_adoption_repin_migration_applied');
    }
    else if (migration?.content_hash !== repin.replacement_migration.content_hash) throw new Error('Post-adoption migration write boundary diverged.');
    repin = { ...repin, status: 'migration_written' };
    transaction = { ...transaction, post_adoption_repin: repin };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('post_adoption_repin_migration_written');
  }
  if (repin.status === 'migration_written') {
    const currentRecord = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
    if (currentRecord && jsonSha256(currentRecord) === repin.prior_adoption_record_sha256) {
      atomicWriteJson(recordPath, repin.replacement_record);
      deps.checkpoint?.('post_adoption_repin_record_applied');
    }
    else if (!currentRecord || jsonSha256(currentRecord) !== jsonSha256(repin.replacement_record)) throw new Error('Post-adoption record write boundary diverged.');
    repin = { ...repin, status: 'record_written' };
    transaction = { ...transaction, post_adoption_repin: repin };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('post_adoption_repin_record_written');
  }
  if (repin.status === 'record_written') {
    repin = { ...repin, status: 'completed' };
    transaction = {
      ...transaction, target_runtime_root: replacementRoot, target_runtime: repin.replacement_record.target_runtime,
      migration_content_hash: repin.replacement_migration.content_hash,
      superseded_migration_content_hash: repin.prior_migration_content_hash,
      target_runtime_supersessions: repin.replacement_record.target_runtime_supersessions,
      post_adoption_repin: repin, updated_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('post_adoption_repin_completed');
  }
  verifyLiveSessionMigrationDomainBoundary(sessionDir, repin.replacement_migration, record.source_runtime,
    repin.replacement_record.target_runtime, { forceVerificationContractRepair: true });
  return repin.replacement_record;
}

export function adoptActiveLegacyMuxSession(
  sessionDirInput: string,
  sourceRuntimeRoot: string,
  targetRuntimeRoot: string,
  deps: LegacyAdoptionDependencies = {},
): LegacyAdoptionRecord {
  const sessionDir = fs.realpathSync(sessionDirInput);
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  const transactionPath = path.join(sessionDir, LEGACY_ADOPTION_TRANSACTION_FILE);
  const adoptionLock = new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  adoptionLock.acquireLock(path.join(sessionDir, '.legacy-session-adoption'));
  try {
  const completed = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
  if (completed?.schema_version === 1 && completed.status === 'launched') {
    if (JSON.stringify(describeInstalledRuntime(targetRuntimeRoot)) !== JSON.stringify(completed.target_runtime)) {
      throw new Error('Launched legacy adoption target drift must be resolved by an authenticated live runtime handoff before deployment.');
    }
    return completed;
  }
  if (completed?.schema_version === 1 && completed.status === 'adopted') {
    const completedTransaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
    if (!completedTransaction) throw new Error('Completed legacy adoption lacks its durable transaction.');
    const releaseCompletedOperation = acquireSessionOperation(sessionDir,
      'Could not fence the adopted legacy session for runtime supersession.');
    try {
      return repinCompletedAdoption(sessionDir, recordPath, transactionPath, completed, completedTransaction,
        targetRuntimeRoot, deps);
    } finally {
      releaseCompletedOperation();
    }
  }
  const statePath = path.join(sessionDir, 'state.json');
  const state = new StateManager().read(statePath);
  if (state.active !== true) throw new Error('Legacy adoption requires a session that is currently active.');
  const schemaVersion = Number(state.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Legacy session state schema is invalid.');
  const workingDir = fs.realpathSync(String(state.working_dir || ''));
  assertSessionMapOwnership(sessionDir, workingDir);
  const exists = deps.tmuxExists || tmuxSessionExists;
  const observe = deps.observeProcess || observeProcess;
  const inspect = deps.inspectProcess || inspectProcessLivenessIdentity;
  const bindingFor = deps.tmuxBinding || defaultTmuxBinding;
  let transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
  if (transaction?.stage === 'fenced' && transaction.controller_fenced) {
    const controllerStillLive = inspect(transaction.runner) === 'matched';
    transaction = resumeFencedLegacyController(sessionDir, transactionPath, transaction, workingDir, state, deps,
      exists(transaction.tmux.session_name) || controllerStillLive);
  }
  if (transaction?.stage !== 'quiesced') {
    assertNoModernOwnershipEvidence(state,
      'Legacy adoption refuses modern authority, recovery, or cancellation evidence.');
  }
  if (!fs.existsSync(transactionPath)) for (const forbidden of ['logical-pipeline.json', 'pipeline.json', 'pipeline-state.json', 'prd.lock.json']) {
    if (fs.existsSync(path.join(sessionDir, forbidden))) throw new Error(`Legacy adoption refuses existing ${forbidden}.`);
  }
  if (!transaction) {
    const sourceRuntime = describeInstalledRuntime(sourceRuntimeRoot);
    const targetRuntime = describeInstalledRuntime(targetRuntimeRoot);
    assertRuntimeCompatible(sourceRuntime, schemaVersion);
    assertRuntimeCompatible(targetRuntime, schemaVersion);
    const runnerPid = Number(state.tmux_runner_pid);
    const tmuxName = String(state.tmux_session_name || '');
    if (!Number.isInteger(runnerPid) || runnerPid <= 0 || !tmuxName) throw new Error('Legacy session lacks live mux ownership metadata.');
    assertOwnedTmuxSession(tmuxName, sessionDir);
    const operationLock = legacyOperationLockSnapshot(sessionDir);
    if (operationLock.pid !== runnerPid) throw new Error('Legacy runner and operation lock owners do not match.');
    const tmux = bindingFor(tmuxName);
    if (!tmux || !exists(tmuxName)) {
      throw new Error('Legacy tmux session lacks an immutable live binding.');
    }
    const topology = verifiedLegacyControllerTopology(runnerPid, tmux, sessionDir, sourceRuntimeRoot, observe, inspect);
    const candidatePaths = attributableCandidatePaths(sessionDir, workingDir,
      typeof state.current_ticket === 'string' ? state.current_ticket : null);
    const candidateArchive = { paths: candidatePaths, staged_paths: [] as string[], ref: null };
    const child = validPersistedIdentity(state.active_child_identity) ? state.active_child_identity : null;
    if (state.active_child_pid && !child) throw new Error('Legacy active child has no immutable process identity.');
    const now = deps.now?.() ?? new Date();
    transaction = {
      schema_version: 1, stage: 'fenced', session_id: path.basename(sessionDir),
      source_runtime_root: fs.realpathSync(sourceRuntimeRoot), target_runtime_root: fs.realpathSync(targetRuntimeRoot),
      source_runtime: sourceRuntime, target_runtime: targetRuntime, runner: topology.runner.identity,
      supervisor: topology.supervisor?.identity ?? null, pane: topology.pane.identity,
      tmux, operation_lock_pid: operationLock.pid, operation_lock_sha256: operationLock.sha256,
      active_child: child, candidate_archive: candidateArchive,
      created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    atomicWriteJson(transactionPath, transaction);
    deps.startWatchdog?.(sessionDir, sourceRuntimeRoot, targetRuntimeRoot);
    deps.checkpoint?.('fenced');
  } else if (transaction.source_runtime_root !== fs.realpathSync(sourceRuntimeRoot)
    || transaction.target_runtime_root !== fs.realpathSync(targetRuntimeRoot)) {
    throw new Error('Legacy adoption transaction runtime roots do not match this resume attempt.');
  }

  if (transaction.stage === 'fenced') {
    const live = exists(transaction.tmux.session_name);
    const runnerStatus = inspect(transaction.runner);
    if (live) {
      const bindingNow = bindingFor(transaction.tmux.session_name);
      if (JSON.stringify(bindingNow) !== JSON.stringify(transaction.tmux)) {
        throw new Error('Legacy runner or immutable tmux binding changed before controller fencing.');
      }
      verifiedLegacyControllerTopology(transaction.runner.pid, transaction.tmux, sessionDir, sourceRuntimeRoot, observe, inspect,
        { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane });
      transaction = {
        ...transaction,
        controller_fenced: true,
        controller_fence: {
          status: 'preparing', prepared_at: (deps.now?.() ?? new Date()).toISOString(),
          fenced_at: null, released_at: null,
        },
      };
      atomicWriteJson(transactionPath, transaction);
      try {
      (deps.stopController || ((identity) => process.kill(identity.pid, 'SIGSTOP')))(transaction.runner);
      const stoppedBinding = bindingFor(transaction.tmux.session_name);
      if (JSON.stringify(stoppedBinding) !== JSON.stringify(transaction.tmux)) {
        throw new Error('Legacy runner or immutable tmux binding changed after controller fencing.');
      }
      verifiedLegacyControllerTopology(transaction.runner.pid, transaction.tmux, sessionDir, sourceRuntimeRoot, observe, inspect,
        { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane });
      const fencedState = new StateManager().read(statePath);
      const child = validPersistedIdentity(fencedState.active_child_identity) ? fencedState.active_child_identity : null;
      if (fencedState.active_child_pid && !child) throw new Error('Legacy controller respawned a child without immutable identity.');
      transaction.active_child = child;
      transaction.controller_fenced = true;
      transaction.controller_fence = {
        ...transaction.controller_fence!, status: 'fenced',
        fenced_at: (deps.now?.() ?? new Date()).toISOString(), released_at: null,
      };
      atomicWriteJson(transactionPath, transaction);
      if (child) {
        const childStatus = (deps.inspectChild || inspectRecordedLiveProcessIdentity)(child);
        if (childStatus === 'ambiguous') throw new Error('Legacy active child identity is ambiguous.');
        if (childStatus === 'matched') {
          const result = (deps.reapChild || reapRecordedLiveProcessGroup)(child);
          if (result.status !== 'reaped' && result.status !== 'not-running') throw new Error(`Could not safely quiesce legacy active child: ${result.reason}`);
        }
      }
      deps.afterChildQuiesced?.();
      assertNoModernOwnershipEvidence(new StateManager().read(statePath),
        'Legacy adoption refuses modern evidence published after child quiescence.');
      const archivedCandidate = archiveAttributableCandidate(sessionDir, workingDir,
        typeof fencedState.current_ticket === 'string' ? fencedState.current_ticket : null);
      deps.afterCandidateArchiveCleanup?.();
      transaction.candidate_archive = archivedCandidate;
      transaction.candidate_archive_restored = false;
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('candidate_archived');
      if (JSON.stringify(bindingFor(transaction.tmux.session_name)) !== JSON.stringify(transaction.tmux)) {
        throw new Error('Legacy identities changed immediately before tmux shutdown.');
      }
      verifiedLegacyControllerTopology(transaction.runner.pid, transaction.tmux, sessionDir, sourceRuntimeRoot, observe, inspect,
        { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane });
      assertNoModernOwnershipEvidence(new StateManager().read(statePath),
        'Legacy adoption refuses modern evidence published before tmux shutdown.');
      transaction = {
        ...transaction,
        controller_shutdown: {
          status: 'prepared', prepared_at: (deps.now?.() ?? new Date()).toISOString(), committed_at: null,
        },
      };
      atomicWriteJson(transactionPath, transaction);
      const shutdownFence = new StateManager();
      let shutdownError: unknown = null;
      let ownershipCleared = false;
      let shutdownRunnerExited = false;
      let shutdownTmuxStillExists = true;
      shutdownFence.acquireLock(statePath);
      try {
        assertNoModernOwnershipEvidence(shutdownFence.read(statePath),
          'Legacy adoption refuses modern evidence at the atomic tmux shutdown fence.');
        deps.afterFinalEvidenceCheck?.();
        (deps.killTmux || killTmuxSessionById)(transaction!.tmux.session_id);
        shutdownRunnerExited = (deps.waitForRunnerExit || defaultWaitForExit)(transaction!.runner);
        shutdownTmuxStillExists = exists(transaction!.tmux.session_name);
        if (!shutdownRunnerExited || shutdownTmuxStillExists) {
          throw new Error('Legacy mux owner did not stop after exact tmux shutdown.');
        }
        transaction = {
          ...transaction!,
          controller_shutdown: {
            prepared_at: transaction!.controller_shutdown!.prepared_at,
            status: 'committed', committed_at: (deps.now?.() ?? new Date()).toISOString(),
          },
        };
        const clearedState = applyQuiescedOwnershipClear(shutdownFence.read(statePath));
        atomicWriteJson(statePath, clearedState);
        transaction = {
          ...transaction,
          stage: 'quiesced',
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        };
        atomicWriteJson(transactionPath, transaction);
        ownershipCleared = true;
      } catch (error) {
        shutdownError = error;
      } finally {
        shutdownFence.releaseLock(statePath);
      }
      if (shutdownError) {
        if (!shutdownRunnerExited && !shutdownTmuxStillExists) {
          transaction = resumeFencedLegacyController(sessionDir, transactionPath, transaction!, workingDir,
            new StateManager().read(statePath), deps);
        } else if (shutdownRunnerExited && shutdownTmuxStillExists) {
          (deps.killTmux || killTmuxSessionById)(transaction!.tmux.session_id);
          transaction = {
            ...transaction!, controller_fenced: false,
            controller_fence: {
              ...transaction!.controller_fence!, status: 'released',
              released_at: (deps.now?.() ?? new Date()).toISOString(),
            },
          };
          atomicWriteJson(transactionPath, transaction);
        } else if (exists(transaction!.tmux.session_name) && inspect(transaction!.runner) === 'matched') {
          transaction = resumeFencedLegacyController(sessionDir, transactionPath, transaction!, workingDir,
            new StateManager().read(statePath), deps);
        }
        throw shutdownError;
      }
      if (!ownershipCleared) throw new Error('Legacy ownership handoff did not commit under its state fence.');
      } catch (error) {
        if (deps.simulateProcessDeath?.(error) === true) throw error;
        if (transaction!.controller_fenced && transaction!.controller_shutdown?.status !== 'committed'
          && exists(transaction!.tmux.session_name) && inspect(transaction!.runner) === 'matched') {
          transaction = resumeFencedLegacyController(sessionDir, transactionPath, transaction!, workingDir,
            new StateManager().read(statePath), deps);
        }
        throw error;
      }
    } else if (runnerStatus === 'matched') {
      if (transaction.controller_shutdown?.status !== 'prepared') {
        throw new Error('Legacy tmux disappeared while its recorded controller remained live.');
      }
      const result = (deps.reapRunner || reapRecordedLiveProcessGroup)(transaction.runner);
      if (result.status !== 'reaped' && result.status !== 'not-running') {
        throw new Error(`Could not safely reconcile the exact legacy controller after tmux loss: ${result.reason}`);
      }
      if (inspect(transaction.runner) === 'matched') {
        throw new Error('Exact legacy controller remained live after bounded tmux-loss reconciliation.');
      }
    }
    if (typeof transaction!.operation_lock_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(transaction!.operation_lock_sha256)) {
      throw new Error('Legacy adoption transaction lacks authenticated session-operation lock evidence.');
    }
    if (transaction!.stage === 'fenced') {
      assertNoModernOwnershipEvidence(new StateManager().read(statePath),
        'Legacy adoption refuses modern authority, recovery, or cancellation evidence at quiescence.');
      if (!transaction!.candidate_archive.ref && listWorkingTreeDirtyPaths(workingDir).length > 0) {
        transaction!.candidate_archive = archiveAttributableCandidate(sessionDir, workingDir,
          typeof state.current_ticket === 'string' ? state.current_ticket : null);
        transaction!.candidate_archive_restored = false;
        atomicWriteJson(transactionPath, transaction);
      }
      clearQuiescedOwnership(sessionDir);
      transaction = { ...transaction!, stage: 'quiesced', updated_at: (deps.now?.() ?? new Date()).toISOString() };
      atomicWriteJson(transactionPath, transaction);
    }
    deps.checkpoint?.('quiesced');
  }

  if (!transaction) throw new Error('Legacy adoption transaction disappeared after quiescence.');
  if (transaction.stage === 'quiesced') {
    if (typeof transaction.operation_lock_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(transaction.operation_lock_sha256)) {
      throw new Error('Legacy adoption transaction lacks authenticated session-operation lock evidence.');
    }
    const legacyLockPath = path.join(sessionDir, '.session-operation.lock');
    const legacyLockRetired = retireLegacyOperationLock(sessionDir, {
      pid: transaction.operation_lock_pid,
      sha256: transaction.operation_lock_sha256,
    });
    if (!legacyLockRetired && fs.existsSync(legacyLockPath)) {
      throw new Error('Legacy adoption refuses ownership transfer across a replaced session-operation lock.');
    }
    const postHandoffState = new StateManager().read(statePath);
    if (validCommittedLegacyAdoptionTransfer(sessionDir, transaction, postHandoffState as Record<string, unknown>)) {
      throw new Error('Legacy adoption ownership transferred to the authenticated modern recovery owner.');
    }
    const postHandoffEvidence = modernOwnershipEvidence(postHandoffState);
    if (postHandoffEvidence.length > 0) {
      const recoveryChallenge = transaction.post_handoff_recovery?.challenge || crypto.randomUUID();
      transaction = {
        ...transaction,
        post_handoff_recovery: {
          status: 'pending', evidence: postHandoffEvidence, owner_identity: null,
          recovery_daemon_identity: transaction.post_handoff_recovery?.recovery_daemon_identity || null,
          challenge: recoveryChallenge,
          owner_spec_id: transaction.post_handoff_recovery?.owner_spec_id || null,
          ready_receipt_id: transaction.post_handoff_recovery?.ready_receipt_id || null,
          owner_spec: transaction.post_handoff_recovery?.owner_spec || null,
          ready_receipt: transaction.post_handoff_recovery?.ready_receipt || null,
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        },
      };
      atomicWriteJson(transactionPath, transaction);
      if (!runtimeRootMatchesDescriptor(targetRuntimeRoot, transaction.target_runtime)) {
        throw new Error('Legacy post-handoff recovery refuses drifted target runtime ownership.');
      }
      if (postHandoffState.autonomous_owner_spec == null) {
        const runtimeBin = path.join(targetRuntimeRoot, 'extension', 'bin');
        const genericOwner = deriveAutonomousProcessOwnerSpec(sessionDir, workingDir,
          postHandoffState.pipeline_mode === true ? 'pipeline-runner.js' : 'mux-runner.js',
          ['--on-failure=retry'], runtimeBin);
        new StateManager().update(statePath, (current) => {
          if (current.autonomous_owner_spec == null) current.autonomous_owner_spec = genericOwner;
          return current;
        });
      }
      new StateManager().update(statePath, (current) => {
        if (current.legacy_adoption_supervisor_challenge != null
          && current.legacy_adoption_supervisor_challenge !== recoveryChallenge) {
          throw new Error('Legacy adoption supervisor challenge changed before target readiness.');
        }
        current.legacy_adoption_supervisor_challenge = recoveryChallenge;
        return current;
      });
      const ensuredDaemonPid = deps.ensurePostHandoffOwner
        ? deps.ensurePostHandoffOwner(sessionDir)
        : ensureAutonomousOwnerRecoveryDaemon(sessionDir, path.join(targetRuntimeRoot, 'extension', 'bin'));
      const ownedState = new StateManager().read(statePath);
      const recoveryDaemon = validPersistedIdentity(ownedState.autonomous_owner_recovery_daemon_identity)
        && Number(ensuredDaemonPid) === ownedState.autonomous_owner_recovery_daemon_identity.pid
        && inspectProcessLivenessIdentity(ownedState.autonomous_owner_recovery_daemon_identity) === 'matched'
        ? ownedState.autonomous_owner_recovery_daemon_identity : null;
      if (recoveryDaemon) {
        transaction = {
          ...transaction,
          post_handoff_recovery: {
            ...transaction.post_handoff_recovery!, recovery_daemon_identity: recoveryDaemon,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          },
        };
        atomicWriteJson(transactionPath, transaction);
      }
      const ownerSpec = validateAutonomousOwnerSpec(ownedState.autonomous_owner_spec);
      const ownerIdentity = validPersistedIdentity(ownedState.autonomous_supervisor_identity)
        ? ownedState.autonomous_supervisor_identity : null;
      const restoration = ownedState.autonomous_owner_restoration as {
        status?: string; owner_spec_id?: string; rollover_intent_id?: string; rollover_epoch?: number;
      } | null;
      const readyOwner = authenticatedReadyProcessOwner(
        sessionDir, ownedState as Record<string, unknown>, recoveryDaemon, recoveryChallenge,
      );
      const acceptedRestoration = Boolean(recoveryDaemon && ownerSpec && ownerIdentity && readyOwner
        && JSON.stringify(readyOwner) === JSON.stringify(ownerIdentity)
        && Number(ownedState.autonomous_supervisor_pid) === ownerIdentity.pid
        && restoration?.status === 'restored'
        && restoration.owner_spec_id === ownerSpec.spec_id
        && restoration.rollover_intent_id === ownedState.autonomous_budget_rollover_intent_id
        && Number(restoration.rollover_epoch) === Math.max(1, Number(ownedState.autonomous_budget_epoch || 1)));
      if (acceptedRestoration) {
        const readyReceipt = ownedState.autonomous_supervisor_ready_receipt as { receipt_id?: unknown } | null;
        transaction = {
          ...transaction,
          post_handoff_recovery: {
            status: 'ownership_transferred', evidence: postHandoffEvidence, owner_identity: ownerIdentity,
            recovery_daemon_identity: recoveryDaemon, challenge: recoveryChallenge,
            owner_spec_id: ownerSpec!.spec_id, ready_receipt_id: String(readyReceipt?.receipt_id || ''),
            owner_spec: ownerSpec, ready_receipt: readyReceipt as AutonomousSupervisorReadyReceipt,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          },
        };
        atomicWriteJson(transactionPath, transaction);
        deps.afterOwnershipTransferRecorded?.();
        new StateManager().update(statePath, (current) => {
          if (current.legacy_adoption_supervisor_challenge === recoveryChallenge
            && JSON.stringify(current.autonomous_supervisor_identity) === JSON.stringify(ownerIdentity)) {
            current.legacy_adoption_supervisor_challenge = null;
          }
          return current;
        });
        throw new Error('Legacy adoption ownership transferred to the authenticated modern recovery owner.');
      }
      throw new Error('Legacy adoption recovery evidence is pending an authenticated target supervisor.');
    }
  }
  const releaseOperation = acquireSessionOperation(sessionDir, 'Could not fence the quiesced legacy session for adoption.');
  try {
    let migration = readJsonFile<InstalledRuntimeMigration>(path.join(sessionDir, 'installed-runtime-migration.json'), null);
    const installedSourceRuntime = describeInstalledRuntime(sourceRuntimeRoot);
    if (fs.realpathSync(sourceRuntimeRoot) !== transaction.source_runtime_root
      || JSON.stringify(installedSourceRuntime) !== JSON.stringify(transaction.source_runtime)) {
      throw new Error('Source runtime hash changed while the legacy owner was being quiesced.');
    }
    const installedTargetRuntime = describeInstalledRuntime(targetRuntimeRoot);
    const resolvedTargetRuntimeRoot = fs.realpathSync(targetRuntimeRoot);
    const targetRuntimeChanged = resolvedTargetRuntimeRoot !== transaction.target_runtime_root
      || JSON.stringify(installedTargetRuntime) !== JSON.stringify(transaction.target_runtime);
    if (targetRuntimeChanged) {
      assertTargetRuntimeSupersessionAuthorized(sessionDir, new StateManager().read(statePath), transaction, installedTargetRuntime);
      let pendingRepin = transaction.target_runtime_repin?.status === 'prepared'
        ? transaction.target_runtime_repin : null;
      if (pendingRepin) {
        assertPersistedTargetRuntimeValidation(pendingRepin, targetRuntimeRoot);
        if (!pendingRepin.validation_approval_file_sha256 || !pendingRepin.validation_report_file_sha256) {
          pendingRepin = { ...pendingRepin, ...validationFileHashes(pendingRepin.validation_session_dir) };
          transaction = {
            ...transaction,
            target_runtime_repin: pendingRepin,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          };
          atomicWriteJson(transactionPath, transaction);
        }
        if (pendingRepin.replacement_target_runtime_root !== resolvedTargetRuntimeRoot
          || JSON.stringify(pendingRepin.replacement_target_runtime) !== JSON.stringify(installedTargetRuntime)
        ) {
          throw new Error('Prepared target runtime supersession does not match the approved replacement evidence.');
        }
      } else {
        if (transaction.stage === 'migrated') {
          if (!migration || migration.content_hash !== transaction.migration_content_hash) {
            throw new Error('Cannot repin target runtime without the exact migrated session evidence.');
          }
          verifyLiveSessionMigration(sessionDir, migration);
        } else if (transaction.migration_content_hash) {
          throw new Error('Quiesced target runtime supersession found an unexplained migration hash.');
        }
        const validation = targetRuntimeValidationEvidence(targetRuntimeRoot, deps.validationSessionDir);
        const preparedAt = (deps.now?.() ?? new Date()).toISOString();
        const priorMigrationContentHash = transaction.migration_content_hash || null;
        transaction = {
          ...transaction,
          stage: 'quiesced',
          migration_content_hash: undefined,
          ...(priorMigrationContentHash ? { superseded_migration_content_hash: priorMigrationContentHash } : {}),
          target_runtime_repin: {
            status: 'prepared',
            prior_target_runtime_root: transaction.target_runtime_root,
            prior_target_runtime: transaction.target_runtime,
            prior_migration_content_hash: priorMigrationContentHash,
            replacement_target_runtime_root: resolvedTargetRuntimeRoot,
            replacement_target_runtime: installedTargetRuntime,
            ...validation,
            prepared_at: preparedAt,
          },
          updated_at: preparedAt,
        };
        atomicWriteJson(transactionPath, transaction);
        deps.checkpoint?.('target_runtime_superseded');
        fs.rmSync(path.join(sessionDir, 'installed-runtime-migration.json'), { force: true });
        migration = null;
      }
    }
    const advancePath = refinementRepositoryAdvancePath(sessionDir);
    if (transaction.stage === 'migrated' && transaction.candidate_archive.ref && fs.existsSync(advancePath)) {
      if (!migration || migration.content_hash !== transaction.migration_content_hash) {
        throw new Error('Cannot supersede an incomplete migrated legacy adoption boundary.');
      }
      verifyLiveSessionMigration(sessionDir, migration);
      const ticketId = String(state.current_ticket || '');
      if (!ticketId) throw new Error('Migrated legacy adoption boundary lost its active ticket identity.');
      transaction = {
        ...transaction,
        stage: 'quiesced',
        migration_content_hash: undefined,
        superseded_migration_content_hash: migration.content_hash,
        boundary_reconciliation: {
          status: 'prepared', ticket_id: ticketId, base_head: getHeadSha(workingDir),
          recovery_ref: transaction.candidate_archive.ref,
        },
        updated_at: (deps.now?.() ?? new Date()).toISOString(),
      };
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('boundary_prepared');
      fs.rmSync(path.join(sessionDir, 'installed-runtime-migration.json'), { force: true });
      migration = null;
    }
    if (transaction.stage === 'quiesced' && transaction.candidate_archive.ref
      && (fs.existsSync(advancePath) || transaction.boundary_reconciliation?.status === 'prepared')) {
      const ticketId = transaction.boundary_reconciliation?.ticket_id || String(state.current_ticket || '');
      if (!ticketId) throw new Error('Legacy adoption boundary reconciliation lost its active ticket identity.');
      if (!transaction.boundary_reconciliation) {
        transaction = {
          ...transaction,
          boundary_reconciliation: {
            status: 'prepared', ticket_id: ticketId, base_head: getHeadSha(workingDir),
            recovery_ref: transaction.candidate_archive.ref,
          },
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        };
        atomicWriteJson(transactionPath, transaction);
        deps.checkpoint?.('boundary_prepared');
      }
      const boundary = transaction.boundary_reconciliation;
      if (!boundary) throw new Error('Legacy adoption boundary preparation was not persisted.');
      reconcileArchivedCandidateRefinementBoundary({
        sessionDir,
        workingDir,
        ticketId,
        baseHead: boundary.base_head,
        recoveryRef: boundary.recovery_ref,
        archivedPaths: transaction.candidate_archive.paths,
      });
      transaction = {
        ...transaction,
        boundary_reconciliation: { ...boundary, status: 'completed' },
        updated_at: (deps.now?.() ?? new Date()).toISOString(),
      };
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('boundary_completed');
    }
    if (transaction.stage === 'quiesced' && transaction.target_runtime_repin?.status === 'prepared') {
      const repin = transaction.target_runtime_repin;
      migration = prepareLiveSessionMigration(sessionDir, transaction.source_runtime, repin.replacement_target_runtime,
        deps.now?.() ?? new Date(), { forceVerificationContractRepair: true });
      verifyLiveSessionMigration(sessionDir, migration);
      const completedAt = (deps.now?.() ?? new Date()).toISOString();
      transaction = {
        ...transaction,
        stage: 'migrated',
        target_runtime_root: repin.replacement_target_runtime_root,
        target_runtime: repin.replacement_target_runtime,
        migration_content_hash: migration.content_hash,
        target_runtime_repin: { ...repin, status: 'completed', replacement_migration_content_hash: migration.content_hash },
        target_runtime_supersessions: [
          ...(transaction.target_runtime_supersessions || []),
          {
            prior_target_runtime_root: repin.prior_target_runtime_root,
            prior_target_runtime: repin.prior_target_runtime,
            prior_migration_content_hash: repin.prior_migration_content_hash,
            replacement_target_runtime_root: repin.replacement_target_runtime_root,
            replacement_target_runtime: repin.replacement_target_runtime,
            superseded_at: completedAt,
            validation_session_dir: repin.validation_session_dir,
            validation_approval_sha256: repin.validation_approval_sha256,
            validation_report_sha256: repin.validation_report_sha256,
            validation_approval_file_sha256: repin.validation_approval_file_sha256,
            validation_report_file_sha256: repin.validation_report_file_sha256,
            validation_approval: repin.validation_approval,
            validation_report: repin.validation_report,
          },
        ],
        updated_at: completedAt,
      };
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('migrated');
    }
    if (transaction.stage === 'quiesced') {
      migration = prepareLiveSessionMigration(sessionDir, transaction.source_runtime, transaction.target_runtime,
        deps.now?.() ?? new Date(), { forceVerificationContractRepair: true });
      transaction = { ...transaction, stage: 'migrated', migration_content_hash: migration.content_hash,
        updated_at: (deps.now?.() ?? new Date()).toISOString() };
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('migrated');
    }
    if (!migration || migration.content_hash !== transaction.migration_content_hash) throw new Error('Legacy migration transaction is incomplete.');
    verifyLiveSessionMigration(sessionDir, migration);
    if (transaction.stage === 'migrated') {
      if (fs.realpathSync(targetRuntimeRoot) !== transaction.target_runtime_root
        || JSON.stringify(describeInstalledRuntime(targetRuntimeRoot)) !== JSON.stringify(transaction.target_runtime)) {
        throw new Error('Target runtime drifted before sealing; migrated adoption remains resumable for an approved repin.');
      }
      if (deps.sealSession) deps.sealSession(sessionDir);
      else ensureFencedLegacyAdoptionPrdSeal(sessionDir, migration.content_hash);
      transaction = { ...transaction, stage: 'sealed', updated_at: (deps.now?.() ?? new Date()).toISOString() };
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('sealed');
    }
    const logical = readLogicalPipeline(sessionDir);
    if (!logical.events.some((event) => event.kind === 'legacy_session_adopted')) recordLegacySessionAdoption(sessionDir, {
      migration_content_hash: migration.content_hash,
      source_runtime: transaction.source_runtime,
      target_runtime: transaction.target_runtime,
      target_runtime_supersessions: transaction.target_runtime_supersessions || [],
      resume_checkpoint: { ...migration.resume_checkpoint },
      legacy_owner: { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane, tmux: transaction.tmux,
        operation_lock_pid: transaction.operation_lock_pid, active_child: transaction.active_child },
    }, { nowMs: (deps.now?.() ?? new Date()).getTime() });
    deps.checkpoint?.('journaled');
    verifyLiveSessionMigration(sessionDir, migration);

    const record: LegacyAdoptionRecord = {
      schema_version: LEGACY_ADOPTION_SCHEMA_VERSION,
      status: 'adopted',
      session_id: path.basename(sessionDir),
      source_runtime: transaction.source_runtime,
      target_runtime: transaction.target_runtime,
      migration_content_hash: migration.content_hash,
      resume_checkpoint: migration.resume_checkpoint,
      legacy_owner: { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane, tmux_session_name: transaction.tmux.session_name,
        operation_lock_pid: transaction.operation_lock_pid, active_child: transaction.active_child },
      adopted_at: (deps.now?.() ?? new Date()).toISOString(),
      candidate_archive: transaction.candidate_archive,
      target_runtime_supersessions: transaction.target_runtime_supersessions || [],
    };
    atomicWriteJson(recordPath, record);
    atomicWriteJson(transactionPath, { ...transaction, stage: 'adopted', updated_at: record.adopted_at });
    deps.checkpoint?.('adopted');
    return record;
  } finally {
    releaseOperation();
  }
  } finally {
    adoptionLock.releaseLock(path.join(sessionDir, '.legacy-session-adoption'));
  }
}

function exactTargetLaunchOwner(
  sessionDir: string,
  runtimeRoot: string,
  state: Record<string, unknown>,
  deps: LegacyAdoptionDependencies,
): ObservedLegacyProcess | null {
  const runnerPid = Number(state.tmux_runner_pid);
  if (!Number.isInteger(runnerPid) || runnerPid <= 0) return null;
  const runner = (deps.observeProcess || observeProcess)(runnerPid);
  const sessionName = typeof state.tmux_session_name === 'string' ? state.tmux_session_name : '';
  if (!runner || !exactMuxCommand(runner.command, sessionDir, runtimeRoot) || !sessionName
    || !(deps.tmuxExists || tmuxSessionExists)(sessionName)) return null;
  const binding = (deps.tmuxBinding || defaultTmuxBinding)(sessionName);
  if (!binding) return null;
  try {
    verifiedLegacyControllerTopology(runnerPid, binding, sessionDir, runtimeRoot,
      deps.observeProcess || observeProcess, deps.inspectProcess || inspectProcessLivenessIdentity);
  } catch {
    return null;
  }
  const lease = readLogicalPipeline(sessionDir).lease;
  return lease && Date.parse(lease.expires_at) > Date.now() && lease.owner_identity
    && JSON.stringify(lease.owner_identity) === JSON.stringify(runner.identity) ? runner : null;
}

function launchReservationPaths(sessionDir: string, stateBytes: Buffer): string[] {
  const state = JSON.parse(stateBytes.toString('utf8')) as Record<string, unknown>;
  const cwds = launchReservationCwds(state);
  return [
    path.join(sessionDir, '.tmux-launch.lock'),
    ...cwds.map((cwd) => path.join(
      path.dirname(sessionDir),
      `.tmux-cwd-${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.lock`,
    )),
  ];
}

function launchReservationCwds(state: Record<string, unknown>): string[] {
  return [...new Set([
    ...(Array.isArray(state.session_map_cwds) ? state.session_map_cwds : []),
    state.working_dir,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value)))];
}

function restoreLaunchAttempt(
  sessionDir: string,
  transactionPath: string,
  transaction: LegacyAdoptionTransaction,
  migration: InstalledRuntimeMigration,
  deps: LegacyAdoptionDependencies,
): LegacyAdoptionTransaction {
  const attempt = transaction.launch_attempt;
  if (!attempt || attempt.state_path !== 'state.json') {
    throw new Error('Launching legacy adoption lacks its exact prelaunch rollback checkpoint.');
  }
  const stateBytes = Buffer.from(attempt.state_base64, 'base64');
  if (stateBytes.length !== attempt.state_size
    || crypto.createHash('sha256').update(stateBytes).digest('hex') !== attempt.state_sha256) {
    throw new Error('Legacy adoption prelaunch rollback checkpoint is corrupt.');
  }
  const preservedState = migration.preserved_artifacts.find((artifact) => artifact.path === attempt.state_path);
  if (!preservedState || stateBytes.length !== preservedState.size || attempt.state_sha256 !== preservedState.sha256) {
    throw new Error('Legacy adoption prelaunch rollback checkpoint does not match the sealed migration state.');
  }
  let logicalBytes: Buffer | null = null;
  if (attempt.logical_pipeline_base64 !== undefined) {
    logicalBytes = Buffer.from(attempt.logical_pipeline_base64, 'base64');
    const logicalSha = crypto.createHash('sha256').update(logicalBytes).digest('hex');
    const preservedLogical = migration.preserved_artifacts.find((artifact) => artifact.path === 'logical-pipeline.json');
    if (logicalBytes.length !== attempt.logical_pipeline_size || logicalSha !== attempt.logical_pipeline_sha256
      || (preservedLogical && (logicalBytes.length !== preservedLogical.size || logicalSha !== preservedLogical.sha256))) {
      throw new Error('Legacy adoption logical pipeline rollback checkpoint is corrupt or violates the sealed migration.');
    }
  }
  if (!Number.isFinite(Date.parse(attempt.started_at))) throw new Error('Legacy adoption launch attempt time is invalid.');
  const reservationPaths = launchReservationPaths(sessionDir, stateBytes);
  if (JSON.stringify(attempt.reservation_paths) !== JSON.stringify(reservationPaths)) {
    throw new Error('Legacy adoption launch reservation checkpoint does not match the exact session scope.');
  }
  const state = JSON.parse(stateBytes.toString('utf8')) as Record<string, unknown>;
  return withLaunchReservations(sessionDir, launchReservationCwds(state), path.dirname(sessionDir), () => {
    deps.afterLaunchReservationsAcquired?.();
    const statePath = path.join(sessionDir, attempt.state_path);
    const logicalPath = path.join(sessionDir, 'logical-pipeline.json');
    const stateManager = new StateManager();
    const lockedPaths = [logicalPath, statePath].sort();
    for (const lockedPath of lockedPaths) stateManager.acquireLock(lockedPath);
    try {
      const currentState = stateManager.read(statePath);
      assertNoAmbiguousLaunchOwner(sessionDir, attempt.runtime_root, currentState, deps);
      if (!logicalBytes) {
        const currentLogical = fs.readFileSync(logicalPath);
        const currentLogicalSha = crypto.createHash('sha256').update(currentLogical).digest('hex');
        const preservedLogical = migration.preserved_artifacts.find((artifact) => artifact.path === 'logical-pipeline.json');
        if (!preservedLogical || currentLogical.length !== preservedLogical.size
          || currentLogicalSha !== preservedLogical.sha256) {
          throw new Error('Snapshot-less legacy launch recovery cannot prove the sealed logical pipeline bytes.');
        }
      }
      if (logicalBytes) atomicWriteFile(logicalPath, logicalBytes.toString('utf8'));
      atomicWriteFile(statePath, stateBytes.toString('utf8'));
      const withoutAttempt = { ...transaction };
      delete withoutAttempt.launch_attempt;
      const restored: LegacyAdoptionTransaction = {
        ...withoutAttempt,
        stage: 'adopted',
        launched_runtime_root: undefined,
        updated_at: (deps.now?.() ?? new Date()).toISOString(),
      };
      atomicWriteJson(transactionPath, restored);
      return restored;
    } finally {
      for (const lockedPath of [...lockedPaths].reverse()) stateManager.releaseLock(lockedPath);
    }
  });
}

function assertNoAmbiguousLaunchOwner(
  sessionDir: string,
  runtimeRoot: string,
  state: Record<string, unknown>,
  deps: LegacyAdoptionDependencies,
): void {
  if (exactTargetLaunchOwner(sessionDir, runtimeRoot, state, deps)) return;
  const lease = readLogicalPipeline(sessionDir).lease;
  if (lease) {
    const expired = Date.parse(lease.expires_at) <= Date.now();
    const dead = lease.owner_identity
      ? (deps.inspectProcess || inspectProcessLivenessIdentity)(lease.owner_identity) !== 'matched'
      : false;
    if (!expired && !dead) {
      throw new Error('Legacy adopted session has an unmatched live logical lease; launch rollback refused.');
    }
  }
  for (const candidate of [Number(state.tmux_runner_pid), Number(state.active_child_pid)]) {
    if (Number.isInteger(candidate) && candidate > 0 && (deps.observeProcess || observeProcess)(candidate)) {
      throw new Error(`Legacy adopted session has an ambiguous live owner ${candidate}; launch rollback refused.`);
    }
  }
  const persistedBinding = state.tmux_runner_binding as Record<string, unknown> | null;
  const sessionName = typeof state.tmux_session_name === 'string' && state.tmux_session_name
    ? state.tmux_session_name : typeof persistedBinding?.session_name === 'string' ? persistedBinding.session_name : '';
  if (sessionName && ((deps.tmuxExists || tmuxSessionExists)(sessionName)
    || (deps.tmuxBinding || defaultTmuxBinding)(sessionName))) {
    const current = (deps.tmuxBinding || defaultTmuxBinding)(sessionName);
    const exactBinding = persistedBinding?.schema_version === 1
      && persistedBinding.session_name === sessionName
      && typeof persistedBinding.session_id === 'string' && /^\$\d+$/.test(persistedBinding.session_id)
      && typeof persistedBinding.pane_id === 'string' && /^%\d+$/.test(persistedBinding.pane_id)
      && Number.isInteger(persistedBinding.pane_pid) && Number(persistedBinding.pane_pid) > 0
      && typeof persistedBinding.pane_start_command === 'string'
      && runnerPaneCommandMatches(persistedBinding.pane_start_command, sessionDir)
      && current?.session_id === persistedBinding.session_id
      && current.session_created === persistedBinding.session_created
      && current.pane_id === persistedBinding.pane_id
      && current.pane_pid === persistedBinding.pane_pid
      && current.pane_start_command === persistedBinding.pane_start_command;
    const paneDead = exactBinding
      && !(deps.observeProcess || observeProcess)(Number(persistedBinding.pane_pid));
    if (!paneDead) {
      throw new Error('Legacy adopted session has an unmatched live tmux owner; launch rollback refused.');
    }
    assertOwnedTmuxSession(sessionName, sessionDir);
    (deps.killTmux || killTmuxSessionById)(String(persistedBinding.session_id));
  }
}

export function launchAdoptedLegacySession(
  sessionDirInput: string,
  runtimeRoot: string,
  deps: LegacyAdoptionDependencies = {},
): LegacyAdoptionRecord {
  const sessionDir = fs.realpathSync(sessionDirInput);
  const requestedLockTimeout = Number(process.env.PICKLE_ADOPTION_LAUNCH_LOCK_TIMEOUT_MS);
  const launchLock = new StateManager({
    acquireTimeoutMs: Math.max(
      legacyAdoptionLaunchTimeoutMs(sessionDir) + 60_000,
      Number.isFinite(requestedLockTimeout) && requestedLockTimeout > 0 ? requestedLockTimeout : 0,
    ),
    staleLockThresholdMs: 0,
  });
  launchLock.acquireLock(path.join(sessionDir, '.legacy-session-adoption'));
  try {
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  const transactionPath = path.join(sessionDir, LEGACY_ADOPTION_TRANSACTION_FILE);
  const record = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
  if (!record || record.schema_version !== 1) throw new Error('Legacy adoption record is missing or invalid.');
  const target = describeInstalledRuntime(runtimeRoot);
  if (JSON.stringify(target) !== JSON.stringify(record.target_runtime)) throw new Error('Installed target runtime hash does not match the adopted runtime.');
  const resolvedRuntimeRoot = fs.realpathSync(runtimeRoot);
  if (record.status === 'launched') {
    if (!record.launched_runtime_root) throw new Error('Launched legacy adoption lacks its immutable runtime root.');
    const launchedRoot = fs.realpathSync(record.launched_runtime_root);
    if (launchedRoot === resolvedRuntimeRoot) return record;
    if (!runtimeRootMatchesDescriptor(launchedRoot, record.target_runtime)) {
      throw new Error('Fallback launched runtime hash no longer matches the adopted runtime.');
    }
    const state = new StateManager().read(path.join(sessionDir, 'state.json'));
    (deps.handoff || ((dir, sourceRoot, targetRoot) => (
      handoffLaunchedRuntime(dir, sourceRoot, targetRoot, state)
    )))(sessionDir, launchedRoot, resolvedRuntimeRoot);
    const canonical = { ...record, launched_runtime_root: resolvedRuntimeRoot,
      launched_at: (deps.now?.() ?? new Date()).toISOString() };
    atomicWriteJson(recordPath, canonical);
    const transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
    if (transaction) atomicWriteJson(transactionPath, { ...transaction, stage: 'launched',
      launch_attempt: undefined, launched_runtime_root: resolvedRuntimeRoot, updated_at: canonical.launched_at });
    return canonical;
  }
  let transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
  if (!transaction) throw new Error('Legacy adoption transaction is missing before launch.');
  if (JSON.stringify(transaction.target_runtime) !== JSON.stringify(record.target_runtime)
    || transaction.migration_content_hash !== record.migration_content_hash
    || (transaction.post_adoption_repin && transaction.post_adoption_repin.status !== 'completed')) {
    throw new Error('Legacy adoption transaction does not bind the exact completed launch epoch.');
  }
  if (transaction.post_adoption_repin) {
    assertPostAdoptionTargetRuntimeValidation(transaction.post_adoption_repin, transaction.target_runtime_root);
  }
  const markLaunched = (current: LegacyAdoptionTransaction, ownerRoot = resolvedRuntimeRoot): LegacyAdoptionRecord => {
    const launched = { ...record, status: 'launched' as const,
      launched_at: (deps.now?.() ?? new Date()).toISOString(), launched_runtime_root: ownerRoot };
    const withoutAttempt = { ...current };
    delete withoutAttempt.launch_attempt;
    atomicWriteJson(recordPath, launched);
    atomicWriteJson(transactionPath, { ...withoutAttempt, stage: 'launched', launched_runtime_root: ownerRoot,
      updated_at: launched.launched_at });
    return launched;
  };
  const migration = readJsonFile<InstalledRuntimeMigration>(path.join(sessionDir, 'installed-runtime-migration.json'), null);
  if (!migration || migration.content_hash !== record.migration_content_hash) throw new Error('Legacy migration hash does not match its adoption record.');
  if (transaction.stage === 'launching') {
    const attemptedRuntimeRoot = transaction.launch_attempt?.runtime_root || transaction.target_runtime_root;
    const interruptedState = new StateManager().read(path.join(sessionDir, 'state.json'));
    if (exactTargetLaunchOwner(sessionDir, attemptedRuntimeRoot, interruptedState, deps)) {
      const recovered = markLaunched(transaction, attemptedRuntimeRoot);
      if (attemptedRuntimeRoot === resolvedRuntimeRoot) return recovered;
      (deps.handoff || ((dir, sourceRoot, targetRoot) => (
        handoffLaunchedRuntime(dir, sourceRoot, targetRoot, interruptedState)
      )))(sessionDir, attemptedRuntimeRoot, resolvedRuntimeRoot);
      const canonical = { ...recovered, launched_runtime_root: resolvedRuntimeRoot,
        launched_at: (deps.now?.() ?? new Date()).toISOString() };
      atomicWriteJson(recordPath, canonical);
      atomicWriteJson(transactionPath, { ...transaction, launch_attempt: undefined, stage: 'launched',
        launched_runtime_root: resolvedRuntimeRoot, updated_at: canonical.launched_at });
      return canonical;
    }
    assertNoAmbiguousLaunchOwner(sessionDir, attemptedRuntimeRoot, interruptedState, deps);
    if (!transaction.launch_attempt) {
      if (interruptedState.active !== false) {
        throw new Error('Legacy launch recovery cannot reconstruct a non-inactive prelaunch state.');
      }
      const reconstructed = Buffer.from(`${JSON.stringify({ ...interruptedState, active: true }, null, 2)}\n`);
      const preservedState = migration.preserved_artifacts.find((artifact) => artifact.path === 'state.json');
      if (!preservedState || reconstructed.length !== preservedState.size
        || crypto.createHash('sha256').update(reconstructed).digest('hex') !== preservedState.sha256) {
        throw new Error('Legacy launch recovery cannot prove the exact historical state.json bytes.');
      }
      const currentLogical = fs.readFileSync(path.join(sessionDir, 'logical-pipeline.json'));
      const preservedLogical = migration.preserved_artifacts.find((artifact) => artifact.path === 'logical-pipeline.json');
      const logicalMatchesMigration = preservedLogical
        && currentLogical.length === preservedLogical.size
        && crypto.createHash('sha256').update(currentLogical).digest('hex') === preservedLogical.sha256;
      if ((preservedLogical && !logicalMatchesMigration) || (!preservedLogical && readLogicalPipeline(sessionDir).lease)) {
        throw new Error('Legacy launch recovery cannot prove the historical logical pipeline boundary.');
      }
      const reservationPaths = launchReservationPaths(sessionDir, reconstructed);
      const logicalSha256 = crypto.createHash('sha256').update(currentLogical).digest('hex');
      transaction = {
        ...transaction,
        launch_attempt: {
          runtime_root: attemptedRuntimeRoot,
          owner_pid: 0,
          started_at: transaction.updated_at,
          state_path: 'state.json',
          state_size: reconstructed.length,
          state_sha256: preservedState.sha256,
          state_base64: reconstructed.toString('base64'),
          logical_pipeline_size: currentLogical.length,
          logical_pipeline_sha256: logicalSha256,
          logical_pipeline_base64: currentLogical.toString('base64'),
          reservation_paths: reservationPaths,
        },
      };
      atomicWriteJson(transactionPath, transaction);
    }
    transaction = restoreLaunchAttempt(sessionDir, transactionPath, transaction, migration, deps);
  }
  verifyLiveSessionMigration(sessionDir, migration);
  const logical = readLogicalPipeline(sessionDir);
  const adopted = [...logical.events].reverse().find((event) => event.kind === 'legacy_session_adopted');
  if (!adopted || adopted.details.migration_content_hash !== record.migration_content_hash
    || JSON.stringify(adopted.details.target_runtime) !== JSON.stringify(record.target_runtime)
    || (adopted.details.prior_adoption_record_sha256
      && (!transaction.post_adoption_repin || transaction.post_adoption_repin.status !== 'completed'))
    || logical.lease !== null) {
    throw new Error('Legacy adoption journal checkpoint or lease fence is invalid.');
  }
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  if (Number(state.tmux_runner_pid) > 0 || state.active_child_pid) {
    throw new Error('Legacy adopted session regained an unverified owner before launch.');
  }

  const launch = deps.launch || ((dir: string, root: string) => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'extension', 'bin', 'pickle-tmux.js'), '--resume', dir, '--resume-ready-only', '--on-failure=retry',
    ], { cwd: String(state.working_dir || process.cwd()), env: process.env, encoding: 'utf8',
      timeout: legacyAdoptionLaunchTimeoutMs(sessionDir) });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Legacy supervised mux launch failed.');
  });
  const stateBytes = fs.readFileSync(path.join(sessionDir, 'state.json'));
  const logicalBytes = fs.readFileSync(path.join(sessionDir, 'logical-pipeline.json'));
  const preservedState = migration.preserved_artifacts.find((artifact) => artifact.path === 'state.json');
  if (!preservedState || stateBytes.length !== preservedState.size
    || crypto.createHash('sha256').update(stateBytes).digest('hex') !== preservedState.sha256) {
    throw new Error('Legacy adoption state changed at the prelaunch transaction boundary.');
  }
  const preservedLogical = migration.preserved_artifacts.find((artifact) => artifact.path === 'logical-pipeline.json');
  const logicalSha256 = crypto.createHash('sha256').update(logicalBytes).digest('hex');
  if (preservedLogical && (logicalBytes.length !== preservedLogical.size || logicalSha256 !== preservedLogical.sha256)) {
    throw new Error('Legacy adoption journal changed at the prelaunch transaction boundary.');
  }
  const reservationPaths = launchReservationPaths(sessionDir, stateBytes);
  reclaimLaunchReservations(sessionDir, launchReservationCwds(state), path.dirname(sessionDir));
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  transaction = {
    ...transaction,
    stage: 'launching',
    launch_attempt: {
      runtime_root: resolvedRuntimeRoot,
      owner_pid: process.pid,
      started_at: startedAt,
      state_path: 'state.json',
      state_size: stateBytes.length,
      state_sha256: crypto.createHash('sha256').update(stateBytes).digest('hex'),
      state_base64: stateBytes.toString('base64'),
      logical_pipeline_size: logicalBytes.length,
      logical_pipeline_sha256: logicalSha256,
      logical_pipeline_base64: logicalBytes.toString('base64'),
      reservation_paths: reservationPaths,
    },
    updated_at: startedAt,
  };
  atomicWriteJson(transactionPath, transaction);
  deps.checkpoint?.('launching');
  try {
    launch(sessionDir, resolvedRuntimeRoot);
  } catch (error) {
    const failedState = new StateManager().read(path.join(sessionDir, 'state.json'));
    if (exactTargetLaunchOwner(sessionDir, resolvedRuntimeRoot, failedState, deps)) {
      return markLaunched(transaction);
    }
    assertNoAmbiguousLaunchOwner(sessionDir, resolvedRuntimeRoot, failedState, deps);
    transaction = restoreLaunchAttempt(sessionDir, transactionPath, transaction, migration, deps);
    verifyLiveSessionMigration(sessionDir, migration);
    throw error;
  }
  const launchedState = new StateManager().read(path.join(sessionDir, 'state.json'));
  if (exactTargetLaunchOwner(sessionDir, resolvedRuntimeRoot, launchedState, deps)) {
    return markLaunched(transaction);
  }
  assertNoAmbiguousLaunchOwner(sessionDir, resolvedRuntimeRoot, launchedState, deps);
  transaction = restoreLaunchAttempt(sessionDir, transactionPath, transaction, migration, deps);
  verifyLiveSessionMigration(sessionDir, migration);
  throw new Error('Legacy launch command exited without establishing an exact target owner.');
  } finally {
    launchLock.releaseLock(path.join(sessionDir, '.legacy-session-adoption'));
  }
}

export function legacyContractRepairPending(sessionDir: string, ticketId: string): boolean {
  const record = readJsonFile<(LegacyAdoptionRecord & { contract_repair_completed_at?: string })>(path.join(sessionDir, LEGACY_ADOPTION_FILE), null);
  return Boolean(record && record.resume_checkpoint.phase === 'verification_contract_repair'
    && record.resume_checkpoint.ticket_id?.toLowerCase() === ticketId.toLowerCase()
    && !record.contract_repair_completed_at);
}

export function markLegacyContractRepairComplete(sessionDir: string): void {
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  const record = readJsonFile<(LegacyAdoptionRecord & { contract_repair_completed_at?: string })>(recordPath, null);
  if (!record || record.contract_repair_completed_at) return;
  atomicWriteJson(recordPath, { ...record, contract_repair_completed_at: new Date().toISOString() });
}
