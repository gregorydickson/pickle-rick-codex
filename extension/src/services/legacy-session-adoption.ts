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
import { StateManager } from './state-manager.js';
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
import { getHeadSha, listWorkingTreeDirtyPaths } from './git-utils.js';
import { pathIsInPipelineScope } from './pipeline-scope.js';
import { stashUnattributableRemainder } from './dirty-tree-salvage.js';
import { persistRejectedCandidateCheckpoint } from './candidate-recovery.js';

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
  checkpoint?: (stage: LegacyAdoptionTransaction['stage'] | 'candidate_archived' | 'journaled' | 'launching') => void;
  afterChildQuiesced?: () => void;
  sealSession?: (sessionDir: string) => unknown;
  launch?: (sessionDir: string, runtimeRoot: string) => void;
  handoff?: (sessionDir: string, sourceRuntimeRoot: string, targetRuntimeRoot: string) => void;
  now?: () => Date;
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
  type CandidateTxn = { schema_version: 1; ticket_id: string; base_head: string; paths: string[]; staged_paths: string[]; ref: string; cleanup_complete: boolean };
  let archived = readJsonFile<CandidateTxn>(archivePath, null);
  const paths = archived?.paths || attributableCandidatePaths(sessionDir, workingDir, ticketId);
  if (paths.length === 0) return { paths: [], staged_paths: [], ref: null };
  if (!ticketId) throw new Error('Legacy candidate archive lost its active ticket identity.');
  if (!archived) {
    const stagedPaths = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--', ...paths], {
      cwd: workingDir, encoding: 'utf8', timeout: 30_000,
    }).split('\0').filter(Boolean).sort();
    const ref = stashUnattributableRemainder(workingDir, sessionDir, () => undefined);
    if (!ref) throw new Error('Legacy adoption could not archive the attributable active candidate.');
    archived = { schema_version: 1, ticket_id: ticketId, base_head: getHeadSha(workingDir), paths,
      staged_paths: stagedPaths, ref, cleanup_complete: false };
    atomicWriteJson(archivePath, archived);
  }
  if (archived.ticket_id.toLowerCase() !== ticketId.toLowerCase() || archived.base_head !== getHeadSha(workingDir)) {
    throw new Error('Legacy candidate archive identity changed during adoption.');
  }
  persistRejectedCandidateCheckpoint({ sessionDir, workingDir, ticketId, baseHead: archived.base_head, recoveryRef: archived.ref,
    evidencePath: archivePath, stagedPaths: archived.staged_paths });
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

  const releaseOperation = acquireSessionOperation(sessionDir, 'Could not fence the quiesced legacy session for adoption.');
  try {
    if (JSON.stringify(describeInstalledRuntime(sourceRuntimeRoot)) !== JSON.stringify(transaction.source_runtime)
      || JSON.stringify(describeInstalledRuntime(targetRuntimeRoot)) !== JSON.stringify(transaction.target_runtime)) {
      throw new Error('Runtime hash changed while the legacy owner was being quiesced.');
    }
    let migration = readJsonFile<InstalledRuntimeMigration>(path.join(sessionDir, 'installed-runtime-migration.json'), null);
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
