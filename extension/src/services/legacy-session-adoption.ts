import { spawnSync } from 'node:child_process';
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
import { ensureSessionPrdSeal } from './session-prd-seal.js';
import { StateManager } from './state-manager.js';
import { assertOwnedTmuxSession, killTmuxSession, runTmux, tmuxSessionExists } from './tmux.js';
import {
  prepareLiveSessionMigration,
  listSessionSalvageRefs,
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

export const LEGACY_ADOPTION_FILE = 'legacy-session-adoption.json';
export const LEGACY_ADOPTION_SCHEMA_VERSION = 1;

export interface ObservedLegacyProcess {
  identity: PersistedProcessIdentity;
  command: string;
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
    pane: PersistedProcessIdentity;
    tmux_session_name: string;
    operation_lock_pid: number;
    active_child: PersistedProcessIdentity | null;
  };
  adopted_at: string;
  launched_at?: string;
}

interface LegacyAdoptionDependencies {
  observeProcess?: (pid: number) => ObservedLegacyProcess | null;
  inspectProcess?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused';
  inspectChild?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'ambiguous';
  reapChild?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  tmuxExists?: (name: string) => boolean;
  tmuxPanePid?: (name: string) => number | null;
  killTmux?: (name: string, sessionDir: string) => void;
  waitForRunnerExit?: (identity: PersistedProcessIdentity) => boolean;
  sealSession?: (sessionDir: string) => unknown;
  launch?: (sessionDir: string, runtimeRoot: string) => void;
  now?: () => Date;
}

function processCommand(pid: number): string | null {
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function observeProcess(pid: number): ObservedLegacyProcess | null {
  const command = processCommand(pid);
  if (!command) return null;
  const metadata = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart='], {
    encoding: 'utf8', timeout: 5_000,
  });
  const match = metadata.status === 0 ? metadata.stdout.trim().match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/) : null;
  if (!match || match[2].startsWith('Z')) return null;
  const pgid = Number(match[1]);
  const startTime = match[3].trim();
  return {
    identity: {
      pid,
      pgid,
      start_time: startTime,
      fingerprint: crypto.createHash('sha256').update(`${pid}\0${pgid}\0${startTime}`).digest('hex'),
    },
    command,
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

function exactMuxCommand(command: string, sessionDir: string): boolean {
  return command.includes('mux-runner.js') && command.includes(fs.realpathSync(sessionDir));
}

function defaultPanePid(sessionName: string): number | null {
  const value = Number(runTmux(['display-message', '-p', '-t', `${sessionName}:0`, '#{pane_pid}']));
  return Number.isInteger(value) && value > 0 ? value : null;
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

function assertCleanRepository(workingDir: string): void {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: workingDir, encoding: 'utf8', timeout: 10_000,
  });
  if (result.status !== 0) throw new Error('Legacy adoption requires a valid Git working directory.');
  if (result.stdout.trim()) throw new Error('Legacy adoption requires a completely clean working tree.');
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
  const statePath = path.join(sessionDir, 'state.json');
  const state = new StateManager().read(statePath);
  if (state.active !== true) throw new Error('Legacy adoption requires a session that is currently active.');
  const schemaVersion = Number(state.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Legacy session state schema is invalid.');
  for (const forbidden of ['logical-pipeline.json', 'pipeline.json', 'pipeline-state.json', 'prd.lock.json']) {
    if (fs.existsSync(path.join(sessionDir, forbidden))) throw new Error(`Legacy adoption refuses existing ${forbidden}.`);
  }
  const existing = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  if (fs.existsSync(existing)) throw new Error('Legacy session adoption is already prepared.');

  const sourceRuntime = describeInstalledRuntime(sourceRuntimeRoot);
  const targetRuntime = describeInstalledRuntime(targetRuntimeRoot);
  assertRuntimeCompatible(sourceRuntime, schemaVersion);
  assertRuntimeCompatible(targetRuntime, schemaVersion);
  const workingDir = fs.realpathSync(String(state.working_dir || ''));
  assertCleanRepository(workingDir);
  assertSessionMapOwnership(sessionDir, workingDir);
  const salvageBefore = listSessionSalvageRefs(workingDir, path.basename(sessionDir));

  const runnerPid = Number(state.tmux_runner_pid);
  const tmuxName = String(state.tmux_session_name || '');
  if (!Number.isInteger(runnerPid) || runnerPid <= 0 || !tmuxName) throw new Error('Legacy session lacks live mux ownership metadata.');
  assertOwnedTmuxSession(tmuxName, sessionDir);
  const lockPid = operationLockPid(sessionDir);
  if (lockPid !== runnerPid) throw new Error('Legacy runner and operation lock owners do not match.');

  const observe = deps.observeProcess || observeProcess;
  const inspect = deps.inspectProcess || inspectProcessLivenessIdentity;
  const runner = observe(runnerPid);
  if (!runner || !exactMuxCommand(runner.command, sessionDir) || inspect(runner.identity) !== 'matched') {
    throw new Error('Legacy mux runner identity or command does not match the active session.');
  }
  const exists = deps.tmuxExists || tmuxSessionExists;
  if (!exists(tmuxName)) throw new Error('Legacy tmux session is not live.');
  const panePid = (deps.tmuxPanePid || defaultPanePid)(tmuxName);
  const pane = panePid ? observe(panePid) : null;
  if (!pane || !exactMuxCommand(pane.command, sessionDir) || inspect(pane.identity) !== 'matched') {
    throw new Error('Legacy tmux pane identity or command does not match the active session.');
  }

  const child = validPersistedIdentity(state.active_child_identity) ? state.active_child_identity : null;
  if (state.active_child_pid && !child) throw new Error('Legacy active child has no immutable process identity.');
  if (child) {
    const childStatus = (deps.inspectChild || inspectRecordedLiveProcessIdentity)(child);
    if (childStatus === 'ambiguous') throw new Error('Legacy active child identity is ambiguous.');
    if (childStatus === 'matched') {
      const result = (deps.reapChild || reapRecordedLiveProcessGroup)(child);
      if (result.status !== 'reaped' && result.status !== 'not-running') {
        throw new Error(`Could not safely quiesce legacy active child: ${result.reason}`);
      }
    }
  }
  if (inspect(runner.identity) !== 'matched' || inspect(pane.identity) !== 'matched') {
    throw new Error('Legacy ownership changed before tmux shutdown.');
  }
  (deps.killTmux || killTmuxSession)(tmuxName, sessionDir);
  if (!(deps.waitForRunnerExit || defaultWaitForExit)(runner.identity) || exists(tmuxName)) {
    throw new Error('Legacy mux owner did not stop after exact tmux shutdown.');
  }
  if (operationLockPid(sessionDir) !== runnerPid) throw new Error('Legacy operation lock owner changed after shutdown.');
  const releaseOperation = acquireSessionOperation(sessionDir, 'Could not fence the quiesced legacy session for adoption.');
  try {
    if (JSON.stringify(describeInstalledRuntime(sourceRuntimeRoot)) !== JSON.stringify(sourceRuntime)
      || JSON.stringify(describeInstalledRuntime(targetRuntimeRoot)) !== JSON.stringify(targetRuntime)) {
      throw new Error('Runtime hash changed while the legacy owner was being quiesced.');
    }
    clearQuiescedOwnership(sessionDir);

    const migration = prepareLiveSessionMigration(
      sessionDir,
      sourceRuntime,
      targetRuntime,
      deps.now?.() ?? new Date(),
      { forceVerificationContractRepair: true },
    );
    if (JSON.stringify(migration.salvage_refs) !== JSON.stringify(salvageBefore)) {
      throw new Error('Legacy salvage refs changed while the owner was being quiesced.');
    }
    (deps.sealSession || ensureSessionPrdSeal)(sessionDir);
    recordLegacySessionAdoption(sessionDir, {
      migration_content_hash: migration.content_hash,
      source_runtime: sourceRuntime,
      target_runtime: targetRuntime,
      resume_checkpoint: { ...migration.resume_checkpoint },
      legacy_owner: { runner: runner.identity, pane: pane.identity, tmux_session_name: tmuxName, operation_lock_pid: lockPid, active_child: child },
    }, { nowMs: (deps.now?.() ?? new Date()).getTime() });
    verifyLiveSessionMigration(sessionDir, migration);

    const record: LegacyAdoptionRecord = {
      schema_version: LEGACY_ADOPTION_SCHEMA_VERSION,
      status: 'adopted',
      session_id: path.basename(sessionDir),
      source_runtime: sourceRuntime,
      target_runtime: targetRuntime,
      migration_content_hash: migration.content_hash,
      resume_checkpoint: migration.resume_checkpoint,
      legacy_owner: { runner: runner.identity, pane: pane.identity, tmux_session_name: tmuxName, operation_lock_pid: lockPid, active_child: child },
      adopted_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    atomicWriteJson(existing, record);
    return record;
  } finally {
    releaseOperation();
  }
}

export function launchAdoptedLegacySession(
  sessionDirInput: string,
  runtimeRoot: string,
  deps: LegacyAdoptionDependencies = {},
): LegacyAdoptionRecord {
  const sessionDir = fs.realpathSync(sessionDirInput);
  const recordPath = path.join(sessionDir, LEGACY_ADOPTION_FILE);
  const record = readJsonFile<LegacyAdoptionRecord>(recordPath, null);
  if (!record || record.schema_version !== 1) throw new Error('Legacy adoption record is missing or invalid.');
  if (record.status === 'launched') throw new Error('Legacy adopted session has already been launched.');
  const target = describeInstalledRuntime(runtimeRoot);
  if (JSON.stringify(target) !== JSON.stringify(record.target_runtime)) throw new Error('Installed target runtime hash does not match the adopted runtime.');
  const migration = readJsonFile<InstalledRuntimeMigration>(path.join(sessionDir, 'installed-runtime-migration.json'), null);
  if (!migration || migration.content_hash !== record.migration_content_hash) throw new Error('Legacy migration hash does not match its adoption record.');
  verifyLiveSessionMigration(sessionDir, migration);
  const logical = readLogicalPipeline(sessionDir);
  const adopted = logical.events.find((event) => event.kind === 'legacy_session_adopted');
  if (!adopted || adopted.details.migration_content_hash !== record.migration_content_hash || logical.lease !== null) {
    throw new Error('Legacy adoption journal checkpoint or lease fence is invalid.');
  }
  const state = new StateManager().read(path.join(sessionDir, 'state.json'));
  if (Number(state.tmux_runner_pid) > 0 || state.active_child_pid) throw new Error('Legacy adopted session regained an owner before launch.');

  const launch = deps.launch || ((dir: string, root: string) => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'extension', 'bin', 'pickle-tmux.js'), '--resume', dir, '--resume-ready-only', '--on-failure=retry',
    ], { cwd: String(state.working_dir || process.cwd()), env: process.env, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Legacy supervised mux launch failed.');
  });
  launch(sessionDir, fs.realpathSync(runtimeRoot));
  const launched = { ...record, status: 'launched' as const, launched_at: (deps.now?.() ?? new Date()).toISOString() };
  atomicWriteJson(recordPath, launched);
  return launched;
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
