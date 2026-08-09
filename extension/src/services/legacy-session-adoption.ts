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
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { ensureFencedLegacyAdoptionPrdSeal } from './session-prd-seal.js';
import { StateManager, type PersistedState } from './state-manager.js';
import { assertOwnedTmuxSession, killTmuxSessionById, runTmux, tmuxSessionExists } from './tmux.js';
import {
  prepareLiveSessionMigration,
  verifyLiveSessionMigration,
  type InstalledRuntimeMigration,
} from './live-session-migration.js';
import {
  readLogicalPipeline,
  recordLegacySessionAdoption,
  type InstalledRuntimeDescriptor,
} from './durable-supervisor.js';
import { describeInstalledRuntime } from './runtime-descriptor.js';
import { acquireSessionOperation } from './session-operation.js';
import { getHeadSha, getWorkingTreeStatus, listWorkingTreeDirtyPaths } from './git-utils.js';
import { pathIsInPipelineScope } from './pipeline-scope.js';
import { stashUnattributableRemainder } from './dirty-tree-salvage.js';
import { persistRejectedCandidateCheckpoint } from './candidate-recovery.js';
import { reconcileArchivedCandidateRefinementBoundary, refinementRepositoryAdvancePath } from './refinement-artifacts.js';
import { assertCitadelReleaseApproval, citadelReportPath } from './citadel.js';

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
  active_child: PersistedProcessIdentity | null;
  candidate_archive: { paths: string[]; staged_paths: string[]; ref: string | null };
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
    validation_approval: Record<string, unknown>;
    validation_report: Record<string, unknown>;
    prepared_at: string;
    replacement_migration_content_hash?: string;
  };
  boundary_reconciliation?: {
    status: 'prepared' | 'completed';
    ticket_id: string;
    base_head: string;
    recovery_ref: string;
  };
  launched_runtime_root?: string;
  created_at: string;
  updated_at: string;
}

interface LegacyAdoptionDependencies {
  observeProcess?: (pid: number) => ObservedLegacyProcess | null;
  inspectProcess?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused';
  inspectChild?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'ambiguous';
  reapChild?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  tmuxExists?: (name: string) => boolean;
  tmuxPanePid?: (name: string) => number | null;
  tmuxBinding?: (name: string) => LegacyTmuxBinding | null;
  killTmux?: (sessionId: string) => void;
  waitForRunnerExit?: (identity: PersistedProcessIdentity) => boolean;
  stopController?: (identity: PersistedProcessIdentity) => void;
  resumeController?: (identity: PersistedProcessIdentity) => void;
  startWatchdog?: (sessionDir: string, sourceRuntimeRoot: string, targetRuntimeRoot: string) => void;
  checkpoint?: (stage: LegacyAdoptionTransaction['stage'] | 'candidate_archived' | 'boundary_prepared' | 'boundary_completed' | 'target_runtime_superseded' | 'journaled' | 'launching') => void;
  afterChildQuiesced?: () => void;
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

function operationLockPid(sessionDir: string): number {
  const lock = readJsonFile<Record<string, unknown>>(path.join(sessionDir, '.session-operation.lock'), null);
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Legacy adoption requires an owned session-operation lock.');
  return pid;
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
    validation_approval: validationApproval,
    validation_report: validationReport,
  };
}

function assertPersistedTargetRuntimeValidation(
  repin: NonNullable<LegacyAdoptionTransaction['target_runtime_repin']>,
  targetRuntimeRoot: string,
): void {
  const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (digest(repin.validation_approval) !== repin.validation_approval_sha256
    || digest(repin.validation_report) !== repin.validation_report_sha256
    || repin.validation_approval.head !== getHeadSha(targetRuntimeRoot)
    || getWorkingTreeStatus(targetRuntimeRoot) !== '') {
    throw new Error('Persisted target runtime validation evidence no longer binds the clean replacement checkout.');
  }
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

function clearQuiescedOwnership(sessionDir: string): void {
  new StateManager().update(path.join(sessionDir, 'state.json'), (state) => {
    state.tmux_runner_pid = null;
    state.tmux_session_name = null;
    state.tmux_runner_binding = null;
    state.worker_pid = null;
    state.active_child_pid = null;
    state.active_child_kind = null;
    state.active_child_command = null;
    state.active_child_identity = null;
    state.active_child_controller_pid = null;
    state.step = 'verification_contract_repair';
    state.failure_kind = 'verification_contract_failed';
    state.failure_reason = 'legacy session adoption requires structured verification contract repair';
    state.active = true;
    return state;
  });
}

export function adoptActiveLegacyMuxSession(
  sessionDirInput: string,
  sourceRuntimeRoot: string,
  targetRuntimeRoot: string,
  deps: LegacyAdoptionDependencies = {},
): LegacyAdoptionRecord {
  const sessionDir = fs.realpathSync(sessionDirInput);
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  const completed = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
  if (completed?.schema_version === 1 && (completed.status === 'adopted' || completed.status === 'launched')) return completed;
  const transactionPath = path.join(sessionDir, LEGACY_ADOPTION_TRANSACTION_FILE);
  const adoptionLock = new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  adoptionLock.acquireLock(path.join(sessionDir, '.legacy-session-adoption'));
  try {
  const statePath = path.join(sessionDir, 'state.json');
  const state = new StateManager().read(statePath);
  if (state.active !== true) throw new Error('Legacy adoption requires a session that is currently active.');
  const schemaVersion = Number(state.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Legacy session state schema is invalid.');
  if (!fs.existsSync(transactionPath)) for (const forbidden of ['logical-pipeline.json', 'pipeline.json', 'pipeline-state.json', 'prd.lock.json']) {
    if (fs.existsSync(path.join(sessionDir, forbidden))) throw new Error(`Legacy adoption refuses existing ${forbidden}.`);
  }
  const workingDir = fs.realpathSync(String(state.working_dir || ''));
  assertSessionMapOwnership(sessionDir, workingDir);
  const observe = deps.observeProcess || observeProcess;
  const inspect = deps.inspectProcess || inspectProcessLivenessIdentity;
  const exists = deps.tmuxExists || tmuxSessionExists;
  const bindingFor = deps.tmuxBinding || defaultTmuxBinding;
  let transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
  if (!transaction) {
    const sourceRuntime = describeInstalledRuntime(sourceRuntimeRoot);
    const targetRuntime = describeInstalledRuntime(targetRuntimeRoot);
    assertRuntimeCompatible(sourceRuntime, schemaVersion);
    assertRuntimeCompatible(targetRuntime, schemaVersion);
    const runnerPid = Number(state.tmux_runner_pid);
    const tmuxName = String(state.tmux_session_name || '');
    if (!Number.isInteger(runnerPid) || runnerPid <= 0 || !tmuxName) throw new Error('Legacy session lacks live mux ownership metadata.');
    assertOwnedTmuxSession(tmuxName, sessionDir);
    const lockPid = operationLockPid(sessionDir);
    if (lockPid !== runnerPid) throw new Error('Legacy runner and operation lock owners do not match.');
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
      tmux, operation_lock_pid: lockPid, active_child: child, candidate_archive: candidateArchive,
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
      transaction.candidate_archive = archiveAttributableCandidate(sessionDir, workingDir,
        typeof fencedState.current_ticket === 'string' ? fencedState.current_ticket : null);
      atomicWriteJson(transactionPath, transaction);
      deps.checkpoint?.('candidate_archived');
      if (JSON.stringify(bindingFor(transaction.tmux.session_name)) !== JSON.stringify(transaction.tmux)) {
        throw new Error('Legacy identities changed immediately before tmux shutdown.');
      }
      verifiedLegacyControllerTopology(transaction.runner.pid, transaction.tmux, sessionDir, sourceRuntimeRoot, observe, inspect,
        { runner: transaction.runner, supervisor: transaction.supervisor, pane: transaction.pane });
      (deps.killTmux || killTmuxSessionById)(transaction.tmux.session_id);
      try { (deps.resumeController || ((identity) => process.kill(identity.pid, 'SIGCONT')))(transaction.runner); } catch { /* tmux already reaped it */ }
      if (!(deps.waitForRunnerExit || defaultWaitForExit)(transaction.runner) || exists(transaction.tmux.session_name)) {
        throw new Error('Legacy mux owner did not stop after exact tmux shutdown.');
      }
    } else if (runnerStatus === 'matched') {
      throw new Error('Legacy tmux disappeared while its recorded controller remained live.');
    }
    clearQuiescedOwnership(sessionDir);
    transaction = { ...transaction, stage: 'quiesced', updated_at: (deps.now?.() ?? new Date()).toISOString() };
    atomicWriteJson(transactionPath, transaction);
    deps.checkpoint?.('quiesced');
  }

  if (!transaction) throw new Error('Legacy adoption transaction disappeared after quiescence.');
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
      const pendingRepin = transaction.target_runtime_repin?.status === 'prepared'
        ? transaction.target_runtime_repin : null;
      if (pendingRepin) {
        assertPersistedTargetRuntimeValidation(pendingRepin, targetRuntimeRoot);
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

export function launchAdoptedLegacySession(
  sessionDirInput: string,
  runtimeRoot: string,
  deps: LegacyAdoptionDependencies = {},
): LegacyAdoptionRecord {
  const sessionDir = fs.realpathSync(sessionDirInput);
  const launchLock = new StateManager({
    acquireTimeoutMs: Number(process.env.PICKLE_ADOPTION_LAUNCH_LOCK_TIMEOUT_MS || 60_000),
    staleLockThresholdMs: 0,
  });
  launchLock.acquireLock(path.join(sessionDir, '.legacy-session-adoption'));
  try {
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
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
    const transactionPath = path.join(sessionDir, LEGACY_ADOPTION_TRANSACTION_FILE);
    const transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
    if (transaction) atomicWriteJson(transactionPath, { ...transaction, stage: 'launched',
      launched_runtime_root: resolvedRuntimeRoot, updated_at: canonical.launched_at });
    return canonical;
  }
  const migration = readJsonFile<InstalledRuntimeMigration>(path.join(sessionDir, 'installed-runtime-migration.json'), null);
  if (!migration || migration.content_hash !== record.migration_content_hash) throw new Error('Legacy migration hash does not match its adoption record.');
  verifyLiveSessionMigration(sessionDir, migration);
  const logical = readLogicalPipeline(sessionDir);
  const adopted = logical.events.find((event) => event.kind === 'legacy_session_adopted');
  if (!adopted || adopted.details.migration_content_hash !== record.migration_content_hash || logical.lease !== null) {
    throw new Error('Legacy adoption journal checkpoint or lease fence is invalid.');
  }
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  const transactionPath = path.join(sessionDir, LEGACY_ADOPTION_TRANSACTION_FILE);
  const transaction = readJsonFile<LegacyAdoptionTransaction>(transactionPath, null);
  if (!transaction) throw new Error('Legacy adoption transaction is missing before launch.');
  if (Number(state.tmux_runner_pid) > 0 || state.active_child_pid) {
    const runner = Number(state.tmux_runner_pid) > 0 ? (deps.observeProcess || observeProcess)(Number(state.tmux_runner_pid)) : null;
    const expectedBin = path.join(fs.realpathSync(runtimeRoot), 'extension', 'bin', 'mux-runner.js');
    const exactTarget = runner && exactMuxCommand(runner.command, sessionDir)
      && runner.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.some((token) => path.resolve(token.replace(/^["']|["']$/g, '')) === expectedBin);
    if (transaction.stage !== 'launching' || !exactTarget) throw new Error('Legacy adopted session regained an unverified owner before launch.');
    const recovered = { ...record, status: 'launched' as const, launched_at: (deps.now?.() ?? new Date()).toISOString(),
      launched_runtime_root: resolvedRuntimeRoot };
    atomicWriteJson(recordPath, recovered);
    atomicWriteJson(transactionPath, { ...transaction, stage: 'launched', launched_runtime_root: resolvedRuntimeRoot,
      updated_at: recovered.launched_at });
    return recovered;
  }

  const launch = deps.launch || ((dir: string, root: string) => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'extension', 'bin', 'pickle-tmux.js'), '--resume', dir, '--resume-ready-only', '--on-failure=retry',
    ], { cwd: String(state.working_dir || process.cwd()), env: process.env, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Legacy supervised mux launch failed.');
  });
  atomicWriteJson(transactionPath, { ...transaction, stage: 'launching', updated_at: (deps.now?.() ?? new Date()).toISOString() });
  deps.checkpoint?.('launching');
  launch(sessionDir, resolvedRuntimeRoot);
  const launched = { ...record, status: 'launched' as const, launched_at: (deps.now?.() ?? new Date()).toISOString(),
    launched_runtime_root: resolvedRuntimeRoot };
  atomicWriteJson(recordPath, launched);
  atomicWriteJson(transactionPath, { ...transaction, stage: 'launched', launched_runtime_root: resolvedRuntimeRoot,
    updated_at: launched.launched_at });
  return launched;
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
