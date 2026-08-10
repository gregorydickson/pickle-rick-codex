import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendHistory, getStatePath, reconcileSessionLiveness } from './session.js';
import { LockError, StateManager } from './state-manager.js';
import {
  captureProcessLivenessIdentity,
  captureSpawnedProcessIdentity,
  inspectProcessLivenessIdentity,
  isPersistedProcessIdentityValid,
  reapRecordedLiveProcessGroup,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import {
  abortExpiredRuntimeHandoff,
  readLogicalPipeline,
  type InstalledRuntimeDescriptor,
} from './durable-supervisor.js';
import {
  cancellationRecoveryIntent,
  hasPendingCancellationRecovery,
  reconcileCancellationRecovery,
} from './cancellation-recovery.js';
import {
  finalizeLiveSessionMigrationAfterHandoff,
  LiveSessionMigrationContentionError,
  type InstalledRuntimeMigration,
} from './live-session-migration.js';
import {
  assertOwnedTmuxSession,
  killTmuxSessionById,
  readTmuxRunnerBinding,
  respawnOwnedTmuxPane,
  runTmux,
  runnerPaneCommandMatches,
  shellQuote,
  tmuxSessionExists,
  type TmuxRunnerBinding,
} from './tmux.js';

const ALLOWED_RUNNERS = new Set(['mux-runner.js', 'pipeline-runner.js', 'loop-runner.js']);

export interface AutonomousOwnerSpec {
  schema_version: 1;
  owner_mode?: 'tmux' | 'process';
  spec_id: string;
  session_dir: string;
  working_dir: string;
  tmux_session_name: string;
  original_tmux_session_id: string;
  original_tmux_session_created: string;
  pane_start_command: string;
  runner_bin: string;
  runner_args: string[];
  supervisor_path?: string;
  supervisor_sha256?: string;
  runner_sha256?: string;
  node_path?: string;
  node_sha256?: string;
}

interface CancellationRecoveryRuntimeBinding {
  schema_version: 1;
  runtime_bin: string;
  daemon_path: string;
  daemon_sha256: string;
  watchdog_path: string;
  watchdog_sha256: string;
  node_path: string;
  node_sha256: string;
}

interface CancellationRecoveryWatchdogArm {
  schema_version: 1;
  arm_id: string;
  status: 'prepared' | 'activated';
  prepared_at: string;
  expires_at: string;
  activated_at: string | null;
}

function cancellationRecoveryWatchdogArm(value: unknown): CancellationRecoveryWatchdogArm | null {
  const arm = value as CancellationRecoveryWatchdogArm | null;
  return arm && arm.schema_version === 1 && typeof arm.arm_id === 'string' && arm.arm_id
    && ['prepared', 'activated'].includes(arm.status)
    && Number.isFinite(Date.parse(arm.prepared_at)) && Number.isFinite(Date.parse(arm.expires_at))
    && (arm.activated_at === null || Number.isFinite(Date.parse(arm.activated_at))) ? arm : null;
}

function cancellationRecoveryRuntimeBinding(runtimeBin: string): CancellationRecoveryRuntimeBinding {
  const exactRuntimeBin = fs.realpathSync(runtimeBin);
  const daemonPath = fs.realpathSync(path.join(exactRuntimeBin, 'autonomous-owner-recovery-daemon.js'));
  const watchdogPath = fs.realpathSync(path.join(exactRuntimeBin, 'cancellation-recovery-watchdog.js'));
  const nodePath = fs.realpathSync(process.execPath);
  if (path.dirname(daemonPath) !== exactRuntimeBin || path.dirname(watchdogPath) !== exactRuntimeBin) {
    throw new Error('Cancellation recovery runtime binaries escape the authenticated runtime directory.');
  }
  const digest = (filePath: string): string => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return {
    schema_version: 1,
    runtime_bin: exactRuntimeBin,
    daemon_path: daemonPath,
    daemon_sha256: digest(daemonPath),
    watchdog_path: watchdogPath,
    watchdog_sha256: digest(watchdogPath),
    node_path: nodePath,
    node_sha256: digest(nodePath),
  };
}

function bindCancellationRecoveryRuntime(
  stateManager: StateManager,
  statePath: string,
  runtimeBin: string,
): CancellationRecoveryRuntimeBinding {
  const binding = cancellationRecoveryRuntimeBinding(runtimeBin);
  stateManager.update(statePath, (current) => {
    const existing = current.cancellation_recovery_runtime_binding;
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
      throw new Error('Cancellation recovery runtime identity changed after durable publication.');
    }
    current.cancellation_recovery_runtime_binding = binding;
    return current;
  });
  return binding;
}

export interface AutonomousOwnerRestorationIntent {
  schema_version: 1;
  intent_id: string;
  rollover_intent_id: string;
  rollover_epoch: number;
  owner_spec_id: string;
  status: 'pending' | 'restoring' | 'restored' | 'failed';
  attempt: number;
  not_before: string;
  restorer_pid: number | null;
  restorer_identity?: PersistedProcessIdentity | null;
  restored_tmux_binding?: TmuxRunnerBinding;
  error?: string;
}

interface AutonomousOwnerHandoffTransaction {
  schema_version: 1;
  request_id: string;
  status: 'fenced' | 'completed' | 'rolled_back' | 'failed';
  deadline_at: string;
  source_owner_spec: AutonomousOwnerSpec;
  source_supervisor_pid: number | null;
  source_supervisor_identity: PersistedProcessIdentity | null;
  target_owner_spec: AutonomousOwnerSpec;
  target_supervisor_pid: number;
  target_supervisor_identity: PersistedProcessIdentity;
  target_runtime: InstalledRuntimeDescriptor;
  reconcile_attempt: number;
  reconcile_epoch?: number;
  reconcile_strategy?: string;
  reconcile_not_before?: string | null;
  error?: string | null;
}

interface AutonomousOwnerHandoffReconcileOptions {
  finalizeMigration?: (
    sessionDir: string,
    requestId: string,
    targetRuntime: InstalledRuntimeDescriptor,
  ) => InstalledRuntimeMigration;
}

interface AcceptedHandoffTransferOptions {
  beforePublish?: (state: Parameters<typeof appendHistory>[0]) => void;
}

interface AutonomousOwnerRestorationOptions {
  afterProcessSpawn?: (identity: PersistedProcessIdentity) => void;
  captureSpawnedIdentity?: (pid: number) => PersistedProcessIdentity | null;
}

const HANDOFF_RECONCILE_ATTEMPTS_PER_EPOCH = 5;
const RECOVERABLE_OPERATIONAL_ERROR_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'EDQUOT',
  'EINTR',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOLCK',
  'ENOMEM',
  'ENOSPC',
  'ESTALE',
  'ETIMEDOUT',
]);

function handoffReconcileStrategy(epoch: number): string {
  if (epoch <= 1) return 'immediate_snapshot_retry';
  if (epoch === 2) return 'quiescence_backoff';
  return 'extended_quiescence_backoff';
}

function handoffReconcileEpochDelayMs(epoch: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(Math.max(0, epoch - 2), 7)));
}

function recoverableHandoffFinalizationError(error: unknown): boolean {
  if (error instanceof LiveSessionMigrationContentionError) return true;
  if (!error || typeof error !== 'object') return false;
  return RECOVERABLE_OPERATIONAL_ERROR_CODES.has(
    String((error as NodeJS.ErrnoException).code || ''),
  );
}

function stableSpecId(spec: Omit<AutonomousOwnerSpec, 'spec_id'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

function ownerSpec(value: unknown): AutonomousOwnerSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const spec = value as AutonomousOwnerSpec;
  if (spec.schema_version !== 1 || typeof spec.spec_id !== 'string' || !spec.spec_id
    || typeof spec.session_dir !== 'string' || !spec.session_dir
    || typeof spec.working_dir !== 'string' || !spec.working_dir
    || typeof spec.runner_bin !== 'string' || !ALLOWED_RUNNERS.has(spec.runner_bin)
    || path.basename(spec.runner_bin) !== spec.runner_bin
    || !Array.isArray(spec.runner_args) || !spec.runner_args.every((arg) => typeof arg === 'string')) return null;
  const mode = spec.owner_mode || 'tmux';
  if (mode === 'process') {
    if (typeof spec.supervisor_path !== 'string' || !spec.supervisor_path
      || !/^[a-f0-9]{64}$/.test(String(spec.supervisor_sha256 || ''))
      || !/^[a-f0-9]{64}$/.test(String(spec.runner_sha256 || ''))
      || typeof spec.node_path !== 'string' || !spec.node_path
      || !/^[a-f0-9]{64}$/.test(String(spec.node_sha256 || ''))) return null;
  } else if (mode !== 'tmux'
    || typeof spec.tmux_session_name !== 'string' || !spec.tmux_session_name
    || typeof spec.original_tmux_session_id !== 'string' || !spec.original_tmux_session_id
    || typeof spec.original_tmux_session_created !== 'string' || !spec.original_tmux_session_created
    || typeof spec.pane_start_command !== 'string' || !spec.pane_start_command) return null;
  const unsigned = { ...spec } as Omit<AutonomousOwnerSpec, 'spec_id'> & { spec_id?: string };
  delete unsigned.spec_id;
  return stableSpecId(unsigned) === spec.spec_id ? spec : null;
}

export function validateAutonomousOwnerSpec(value: unknown): AutonomousOwnerSpec | null {
  return ownerSpec(value);
}

export function deriveAutonomousProcessOwnerSpec(
  sessionDir: string,
  workingDir: string,
  runnerBin: string,
  runnerArgs: string[],
  runtimeBin: string,
): AutonomousOwnerSpec {
  if (!ALLOWED_RUNNERS.has(runnerBin) || path.basename(runnerBin) !== runnerBin) {
    throw new Error(`Unsupported autonomous owner runner: ${runnerBin}.`);
  }
  const exactSessionDir = fs.realpathSync(sessionDir);
  const exactWorkingDir = fs.realpathSync(workingDir);
  const exactRuntimeBin = fs.realpathSync(runtimeBin);
  const supervisorPath = fs.realpathSync(path.join(exactRuntimeBin, 'supervised-runner.js'));
  const runnerPath = fs.realpathSync(path.join(exactRuntimeBin, runnerBin));
  const nodePath = fs.realpathSync(process.execPath);
  const unsigned: Omit<AutonomousOwnerSpec, 'spec_id'> = {
    schema_version: 1,
    owner_mode: 'process',
    session_dir: exactSessionDir,
    working_dir: exactWorkingDir,
    tmux_session_name: '', original_tmux_session_id: '', original_tmux_session_created: '', pane_start_command: '',
    runner_bin: runnerBin,
    runner_args: [...runnerArgs],
    supervisor_path: supervisorPath,
    supervisor_sha256: crypto.createHash('sha256').update(fs.readFileSync(supervisorPath)).digest('hex'),
    runner_sha256: crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex'),
    node_path: nodePath,
    node_sha256: crypto.createHash('sha256').update(fs.readFileSync(nodePath)).digest('hex'),
  };
  return { ...unsigned, spec_id: stableSpecId(unsigned) };
}

function persistedIdentity(value: unknown, expectedPid: number | null): PersistedProcessIdentity | null {
  if (!isPersistedProcessIdentityValid(value)) return null;
  const identity = value as PersistedProcessIdentity;
  if (expectedPid !== null && identity.pid !== expectedPid) return null;
  return identity;
}

function handoffTransactionValidationError(
  transaction: AutonomousOwnerHandoffTransaction,
  resolvedSessionDir: string,
): string | null {
  if (transaction.schema_version !== 1) return 'unsupported schema version';
  if (typeof transaction.request_id !== 'string' || !transaction.request_id) return 'missing request id';
  if (!['fenced', 'completed', 'rolled_back', 'failed'].includes(transaction.status)) return 'invalid status';
  if (typeof transaction.deadline_at !== 'string' || !Number.isFinite(Date.parse(transaction.deadline_at))) {
    return 'invalid deadline';
  }
  const source = ownerSpec(transaction.source_owner_spec);
  const target = ownerSpec(transaction.target_owner_spec);
  if (!source || source.session_dir !== resolvedSessionDir) return 'invalid source owner specification';
  if (!target || target.session_dir !== resolvedSessionDir) return 'invalid target owner specification';
  const sourcePid = transaction.source_supervisor_pid;
  if (sourcePid !== null && (!Number.isInteger(sourcePid) || sourcePid <= 0)) return 'invalid source supervisor pid';
  if (sourcePid === null && transaction.source_supervisor_identity !== null) {
    return 'source supervisor identity has no pid';
  }
  if (transaction.source_supervisor_identity !== null
    && !persistedIdentity(transaction.source_supervisor_identity, sourcePid)) {
    return 'invalid source supervisor identity';
  }
  if (!Number.isInteger(transaction.target_supervisor_pid) || transaction.target_supervisor_pid <= 0) {
    return 'invalid target supervisor pid';
  }
  if (!persistedIdentity(transaction.target_supervisor_identity, transaction.target_supervisor_pid)) {
    return 'invalid target supervisor identity';
  }
  if (!Number.isSafeInteger(transaction.reconcile_attempt) || transaction.reconcile_attempt < 0
    || (transaction.status === 'fenced' && transaction.reconcile_attempt >= HANDOFF_RECONCILE_ATTEMPTS_PER_EPOCH)) {
    return 'invalid reconcile attempt';
  }
  const epoch = transaction.reconcile_epoch === undefined ? 1 : transaction.reconcile_epoch;
  if (!Number.isSafeInteger(epoch) || epoch < 1) return 'invalid reconcile epoch';
  if (transaction.reconcile_strategy !== undefined
    && transaction.reconcile_strategy !== handoffReconcileStrategy(epoch)) return 'invalid reconcile strategy';
  if (transaction.reconcile_not_before !== undefined && transaction.reconcile_not_before !== null
    && (typeof transaction.reconcile_not_before !== 'string'
      || !Number.isFinite(Date.parse(transaction.reconcile_not_before)))) return 'invalid reconcile not-before';
  return null;
}

function failClosedInvalidHandoffTransaction(
  stateManager: StateManager,
  statePath: string,
  requestId: string | null,
  reason: string,
): void {
  stateManager.update(statePath, (current) => {
    if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') {
      return current;
    }
    const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
    if (exact && (!requestId || exact.request_id === requestId)) rejectInvalidHandoffTransactionState(current, exact, reason);
    return current;
  });
}

function rejectInvalidHandoffTransactionState(
  current: Parameters<typeof appendHistory>[0],
  transaction: AutonomousOwnerHandoffTransaction,
  reason: string,
): void {
  current.autonomous_owner_handoff_transaction = {
    ...transaction,
    status: 'failed',
    error: `invalid handoff transaction: ${reason}`,
  };
  current.autonomous_owner_recovery_suspended = false;
  current.autonomous_owner_recovery_suspended_for_handoff = null;
  current.recovery_required = true;
  current.recovery_kind = 'autonomous_owner_handoff_transaction_invalid';
  current.recovery_reason = `autonomous owner handoff transaction is invalid: ${reason}`;
  appendHistory(current, 'autonomous_owner_handoff_transaction_rejected');
}

function replayablePaneCommand(command: string): string {
  if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) {
    return command.slice(1, -1);
  }
  return command;
}

function buildTransferredOwnerSpec(
  sessionDir: string,
  state: Record<string, unknown>,
  source: AutonomousOwnerSpec,
  binding: TmuxRunnerBinding,
  runnerBin: 'mux-runner.js' | 'pipeline-runner.js',
  runnerArgs: string[],
  runtimeBin: string,
): AutonomousOwnerSpec {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const rawCommand = [
    'node',
    shellQuote(path.join(fs.realpathSync(runtimeBin), 'recovered-supervisor-owner.js')),
    shellQuote(resolvedSessionDir),
    `--runner-bin=${runnerBin}`,
    ...runnerArgs,
  ].join(' ');
  const unsigned: Omit<AutonomousOwnerSpec, 'spec_id'> = {
    schema_version: 1,
    session_dir: resolvedSessionDir,
    working_dir: fs.realpathSync(String(state.working_dir || process.cwd())),
    tmux_session_name: source.tmux_session_name,
    original_tmux_session_id: binding.session_id,
    original_tmux_session_created: binding.session_created,
    pane_start_command: `"${rawCommand}"`,
    runner_bin: runnerBin,
    runner_args: [...runnerArgs],
  };
  return { ...unsigned, spec_id: stableSpecId(unsigned) };
}

export function registerAutonomousOwnerSpec(
  sessionDir: string,
  runnerBin: string,
  runnerArgs: string[],
  stateManager: StateManager = new StateManager(),
  supervisorPath?: string,
): AutonomousOwnerSpec | null {
  if (!ALLOWED_RUNNERS.has(runnerBin) || path.basename(runnerBin) !== runnerBin) {
    throw new Error(`Unsupported autonomous owner runner: ${runnerBin}.`);
  }
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const state = stateManager.read(statePath);
  if (state.autonomous_owner_spec != null && !ownerSpec(state.autonomous_owner_spec)) {
    throw new Error('Refusing to overwrite a corrupt autonomous owner specification.');
  }
  const currentSupervisorIdentity = captureProcessLivenessIdentity(process.pid);
  if (!currentSupervisorIdentity) {
    throw new Error('Refusing autonomous owner registration without an exact supervisor identity.');
  }
  if (state.tmux_mode !== true) {
    if (!supervisorPath) throw new Error('Cannot register process owner recovery without the exact supervisor path.');
    const exactSupervisorPath = fs.realpathSync(supervisorPath);
    const runnerPath = fs.realpathSync(path.join(path.dirname(exactSupervisorPath), runnerBin));
    const exactNodePath = fs.realpathSync(process.execPath);
    const unsigned: Omit<AutonomousOwnerSpec, 'spec_id'> = {
      schema_version: 1,
      owner_mode: 'process',
      session_dir: resolvedSessionDir,
      working_dir: fs.realpathSync(String(state.working_dir || process.cwd())),
      tmux_session_name: '', original_tmux_session_id: '', original_tmux_session_created: '', pane_start_command: '',
      runner_bin: runnerBin,
      runner_args: [...runnerArgs],
      supervisor_path: exactSupervisorPath,
      supervisor_sha256: crypto.createHash('sha256').update(fs.readFileSync(exactSupervisorPath)).digest('hex'),
      runner_sha256: crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex'),
      node_path: exactNodePath,
      node_sha256: crypto.createHash('sha256').update(fs.readFileSync(exactNodePath)).digest('hex'),
    };
    const processSpec: AutonomousOwnerSpec = { ...unsigned, spec_id: stableSpecId(unsigned) };
    stateManager.update(statePath, (current) => {
      const existing = ownerSpec(current.autonomous_owner_spec);
      if (current.autonomous_owner_spec != null && !existing) {
        throw new Error('Refusing to overwrite a corrupt autonomous owner specification.');
      }
      if (existing && existing.spec_id !== processSpec.spec_id) {
        throw new Error('Refusing to replace a different immutable autonomous process owner specification.');
      }
      current.autonomous_owner_spec = processSpec;
      if (!current.cancel_requested_at && current.last_exit_reason !== 'cancelled') {
        current.autonomous_supervisor_pid = process.pid;
        current.autonomous_supervisor_identity = currentSupervisorIdentity;
        const restoration = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
        if (restoration?.status === 'restoring'
          && restoration.owner_spec_id === processSpec.spec_id
          && restoration.rollover_intent_id === current.autonomous_budget_rollover_intent_id
          && restoration.rollover_epoch === Number(current.autonomous_budget_epoch || 0)) {
          current.autonomous_owner_restoration = {
            ...restoration,
            status: 'restored',
            restorer_pid: null,
            restorer_identity: null,
          };
          const legacyMigration = current.legacy_max_time_migration as Record<string, unknown> | null;
          if (legacyMigration?.rollover_intent_id === restoration.rollover_intent_id
            && legacyMigration?.target_owner_spec_id === processSpec.spec_id) {
            current.legacy_max_time_migration = {
              ...legacyMigration,
              status: legacyMigration.status === 'rollover_consumed' ? 'rollover_consumed' : 'owner_restored',
              updated_at: new Date().toISOString(),
            };
          }
          current.recovery_required = false;
          current.recovery_reason = null;
          appendHistory(current, 'autonomous_owner_restored');
        }
      }
      return current;
    });
    return processSpec;
  }
  const binding = state.tmux_runner_binding as TmuxRunnerBinding | null;
  const sessionName = String(state.tmux_session_name || '');
  if (!binding || binding.schema_version !== 1 || binding.session_name !== sessionName
    || !binding.session_id || !binding.session_created || !binding.pane_start_command) {
    throw new Error('Cannot register autonomous owner recovery without an exact tmux runner binding.');
  }
  assertOwnedTmuxSession(sessionName, resolvedSessionDir);
  if (!runnerPaneCommandMatches(binding.pane_start_command, sessionDir)
    || !binding.pane_start_command.includes(`--runner-bin=${runnerBin}`)) {
    throw new Error(`Refusing autonomous recovery registration for a mismatched supervisor command: ${binding.pane_start_command}`);
  }
  const registered = ownerSpec(state.autonomous_owner_spec);
  if (registered) {
    if (registered.session_dir !== resolvedSessionDir || registered.tmux_session_name !== sessionName
      || registered.runner_bin !== runnerBin || JSON.stringify(registered.runner_args) !== JSON.stringify(runnerArgs)
      || registered.pane_start_command !== binding.pane_start_command) {
      throw new Error('Refusing to replace a different immutable autonomous owner specification.');
    }
    stateManager.update(statePath, (current) => {
      const exact = ownerSpec(current.autonomous_owner_spec);
      if (!exact) {
        throw new Error('Refusing to publish supervisor ownership over a corrupt or changed autonomous owner specification.');
      }
      if (exact.spec_id !== registered.spec_id) {
        throw new Error('Refusing to publish supervisor ownership over a different immutable autonomous owner specification.');
      }
      if (!current.cancel_requested_at && current.last_exit_reason !== 'cancelled') {
        current.autonomous_supervisor_pid = process.pid;
        current.autonomous_supervisor_identity = currentSupervisorIdentity;
      }
      return current;
    });
    return registered;
  }
  const canonicalOwnerCommand = supervisorPath ? [
    'node',
    shellQuote(path.join(path.dirname(fs.realpathSync(supervisorPath)), 'recovered-supervisor-owner.js')),
    shellQuote(resolvedSessionDir),
    `--runner-bin=${runnerBin}`,
    ...runnerArgs,
  ].join(' ') : replayablePaneCommand(binding.pane_start_command);
  const unsigned: Omit<AutonomousOwnerSpec, 'spec_id'> = {
    schema_version: 1,
    session_dir: resolvedSessionDir,
    working_dir: fs.realpathSync(String(state.working_dir || process.cwd())),
    tmux_session_name: sessionName,
    original_tmux_session_id: binding.session_id,
    original_tmux_session_created: binding.session_created,
    pane_start_command: `"${canonicalOwnerCommand}"`,
    runner_bin: runnerBin,
    runner_args: [...runnerArgs],
  };
  const spec: AutonomousOwnerSpec = { ...unsigned, spec_id: stableSpecId(unsigned) };
  stateManager.update(statePath, (current) => {
    const existing = ownerSpec(current.autonomous_owner_spec);
    if (current.autonomous_owner_spec != null && !existing) {
      throw new Error('Refusing to overwrite a corrupt autonomous owner specification.');
    }
    if (existing && existing.spec_id !== spec.spec_id) {
      throw new Error('Refusing to replace a different immutable autonomous owner specification.');
    }
    current.autonomous_owner_spec = spec;
    if (!current.cancel_requested_at && current.last_exit_reason !== 'cancelled') {
      current.autonomous_supervisor_pid = process.pid;
      current.autonomous_supervisor_identity = currentSupervisorIdentity;
    }
    return current;
  });
  return spec;
}

function failRestoration(manager: StateManager, statePath: string, intentId: string, error: unknown): void {
  manager.update(statePath, (current) => {
    const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
    if (intent?.intent_id !== intentId) return current;
    if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') return current;
    const message = error instanceof Error ? error.message : String(error);
    const unsafe = message.startsWith('Refusing') || message.includes('did not preserve the exact');
    current.autonomous_owner_restoration = {
      ...intent, status: 'failed', restorer_pid: null, restorer_identity: null, error: message,
    };
    current.recovery_required = unsafe;
    current.recovery_reason = unsafe ? `autonomous owner restoration failed closed: ${message}` : null;
    appendHistory(current, 'autonomous_owner_restoration_failed');
    return current;
  });
}

export function authenticateProcessOwnerRuntime(spec: AutonomousOwnerSpec): {
  supervisorPath: string;
  nodePath: string;
  workingDir: string;
} {
  try {
    const supervisorPath = fs.realpathSync(String(spec.supervisor_path));
    const runnerPath = fs.realpathSync(path.join(path.dirname(supervisorPath), spec.runner_bin));
    const nodePath = fs.realpathSync(String(spec.node_path));
    const workingDir = fs.realpathSync(spec.working_dir);
    if (supervisorPath !== spec.supervisor_path
      || path.basename(supervisorPath) !== 'supervised-runner.js'
      || nodePath !== spec.node_path
      || workingDir !== spec.working_dir
      || crypto.createHash('sha256').update(fs.readFileSync(supervisorPath)).digest('hex') !== spec.supervisor_sha256
      || crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex') !== spec.runner_sha256
      || crypto.createHash('sha256').update(fs.readFileSync(nodePath)).digest('hex') !== spec.node_sha256) {
      throw new Error('immutable runtime identity changed');
    }
    return { supervisorPath, nodePath, workingDir };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Refusing to restore an autonomous process owner whose immutable runtime identity is unavailable or changed: ${detail}`,
      { cause: error },
    );
  }
}

export function restoreAutonomousBudgetOwner(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
  options: AutonomousOwnerRestorationOptions = {},
): 'noop' | 'restored' {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const beforeReconcile = stateManager.read(statePath);
  if (beforeReconcile.recovery_required === true || beforeReconcile.cancel_requested_at
    || beforeReconcile.cancelled === true || beforeReconcile.last_exit_reason === 'cancelled') return 'noop';
  reconcileSessionLiveness(resolvedSessionDir, stateManager, nowMs);
  let createdBinding: TmuxRunnerBinding | null = null;
  let newlyCreatedSessionId: string | null = null;
  let launchedProcessIdentity: PersistedProcessIdentity | null = null;
  let intentId = '';
  let expectedBinding: TmuxRunnerBinding | null = null;
  try {
    let claimedSpec: AutonomousOwnerSpec | null = null;
    const restorerIdentity = captureProcessLivenessIdentity(process.pid);
    if (!restorerIdentity) {
      throw new Error('Refusing autonomous owner restoration without an exact restorer identity.');
    }
    try {
      stateManager.update(statePath, (current) => {
        if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') return current;
        if (current.recovery_required === true) return current;
        const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
        const spec = ownerSpec(current.autonomous_owner_spec);
        if (!intent || !spec || spec.session_dir !== resolvedSessionDir || intent.owner_spec_id !== spec.spec_id
          || intent.rollover_intent_id !== current.autonomous_budget_rollover_intent_id
          || intent.rollover_epoch !== Number(current.autonomous_budget_epoch || 0)
          || (intent.status !== 'pending' && intent.status !== 'failed')
          || Date.parse(intent.not_before) > nowMs) return current;
        intentId = intent.intent_id;
        claimedSpec = spec;
        expectedBinding = current.tmux_runner_binding as TmuxRunnerBinding | null;
        current.autonomous_owner_restoration = {
          ...intent,
          status: 'restoring',
          attempt: intent.attempt + 1,
          restorer_pid: process.pid,
          restorer_identity: restorerIdentity,
          error: undefined,
        };
        appendHistory(current, 'autonomous_owner_restoration_claimed');
        return current;
      });
    } catch (error) {
      if (error instanceof LockError) {
        const current = stateManager.read(statePath);
        const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
        const spec = ownerSpec(current.autonomous_owner_spec);
        if (intent && spec?.session_dir === resolvedSessionDir
          && intent.owner_spec_id === spec.spec_id
          && intent.rollover_intent_id === current.autonomous_budget_rollover_intent_id
          && intent.rollover_epoch === Number(current.autonomous_budget_epoch || 0)
          && (intent.status === 'restoring' || intent.status === 'restored')) return 'noop';
      }
      throw error;
    }
    if (!claimedSpec || !intentId) return 'noop';
    const spec = claimedSpec as AutonomousOwnerSpec;
    if (spec.owner_mode === 'process') {
      const authenticated = authenticateProcessOwnerRuntime(spec);
      const child = spawn(authenticated.nodePath, [
        authenticated.supervisorPath,
        resolvedSessionDir,
        `--runner-bin=${spec.runner_bin}`,
        ...spec.runner_args,
      ], {
        cwd: authenticated.workingDir,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('Autonomous process owner restoration did not return a child pid.');
      launchedProcessIdentity = (options.captureSpawnedIdentity ?? captureSpawnedProcessIdentity)(child.pid);
      if (!launchedProcessIdentity) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {
          try { child.kill('SIGKILL'); } catch {
            // The launch never acquired an immutable identity; retain the primary integrity failure.
          }
        }
        throw new Error('Refusing autonomous process owner restoration without an exact spawned process identity.');
      }
      child.unref();
      options.afterProcessSpawn?.(launchedProcessIdentity);
      let accepted = false;
      let ownerContractChanged = false;
      const finalState = stateManager.update(statePath, (current) => {
        const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
        const cancelled = current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled';
        const exactOwnerSpec = ownerSpec(current.autonomous_owner_spec);
        if (!exactOwnerSpec || exactOwnerSpec.spec_id !== spec.spec_id
          || exactOwnerSpec.session_dir !== resolvedSessionDir) {
          ownerContractChanged = true;
          return current;
        }
        const alreadyPublishedByChild = intent?.intent_id === intentId
          && intent.status === 'restored'
          && Number(current.autonomous_supervisor_pid) === launchedProcessIdentity?.pid
          && JSON.stringify(current.autonomous_supervisor_identity) === JSON.stringify(launchedProcessIdentity);
        if (!cancelled && alreadyPublishedByChild) {
          accepted = true;
          return current;
        }
        if (cancelled || intent?.intent_id !== intentId || intent.restorer_pid !== process.pid) return current;
        current.autonomous_supervisor_pid = launchedProcessIdentity?.pid ?? null;
        current.autonomous_supervisor_identity = launchedProcessIdentity;
        current.autonomous_owner_restoration = {
          ...intent,
          status: 'restored',
          restorer_pid: null,
          restorer_identity: null,
        };
        const legacyMigration = current.legacy_max_time_migration as Record<string, unknown> | null;
        if (legacyMigration?.rollover_intent_id === intent.rollover_intent_id
          && legacyMigration?.target_owner_spec_id === spec.spec_id) {
          current.legacy_max_time_migration = {
            ...legacyMigration,
            status: legacyMigration.status === 'rollover_consumed' ? 'rollover_consumed' : 'owner_restored',
            updated_at: new Date().toISOString(),
          };
        }
        current.recovery_required = false;
        current.recovery_reason = null;
        appendHistory(current, 'autonomous_owner_restored');
        accepted = true;
        return current;
      });
      if (!accepted || finalState.cancel_requested_at || finalState.cancelled === true
        || finalState.last_exit_reason === 'cancelled') {
        const cleanup = reapRecordedLiveProcessGroup(launchedProcessIdentity);
        if (!['reaped', 'not-running'].includes(cleanup.status)) {
          stateManager.update(statePath, (current) => {
            current.active_child_pid = launchedProcessIdentity?.pid ?? null;
            current.active_child_kind = 'autonomous_owner_replacement';
            current.active_child_identity = launchedProcessIdentity;
            current.orphan_child_pid = launchedProcessIdentity?.pid ?? null;
            current.orphan_recovery = cleanup;
            current.recovery_required = true;
            current.recovery_reason = `restored autonomous owner could not be fenced after ownership changed: ${cleanup.reason}`;
            appendHistory(current, 'autonomous_owner_replacement_orphaned');
            return current;
          });
          throw new Error(`Refusing to leave an unowned restored process after ownership changed: ${cleanup.reason}`);
        }
        launchedProcessIdentity = null;
        if (ownerContractChanged) {
          throw new Error('Refusing to publish restored process ownership after the immutable owner contract changed.');
        }
        return 'noop';
      }
      launchedProcessIdentity = null;
      return 'restored';
    }
    assertOwnedTmuxSession(spec.tmux_session_name, resolvedSessionDir);
    if (tmuxSessionExists(spec.tmux_session_name)) {
      const existing = readTmuxRunnerBinding(`${spec.tmux_session_name}:0`);
      const expected = expectedBinding as TmuxRunnerBinding | null;
      const matchesOriginal = existing?.session_id === spec.original_tmux_session_id
        && existing?.session_created === spec.original_tmux_session_created;
      const matchesLastRestored = existing && expected
        && existing.session_id === expected.session_id
        && existing.session_created === expected.session_created
        && expected.pane_start_command === spec.pane_start_command;
      if (!existing || (!matchesOriginal && !matchesLastRestored)) {
        throw new Error('Refusing to restore through a tmux name owned by a different immutable session.');
      }
    } else {
      runTmux(['new-session', '-d', '-s', spec.tmux_session_name, '-c', spec.working_dir]);
      const provisional = readTmuxRunnerBinding(`${spec.tmux_session_name}:0`);
      if (!provisional || provisional.session_name !== spec.tmux_session_name) {
        throw new Error('New tmux owner session did not expose an immutable binding.');
      }
      newlyCreatedSessionId = provisional.session_id;
      runTmux(['rename-window', '-t', `${spec.tmux_session_name}:0`, 'runner']);
    }
    runTmux(['set-option', '-w', '-t', `${spec.tmux_session_name}:0`, 'remain-on-exit', 'on']);
    respawnOwnedTmuxPane(
      spec.tmux_session_name,
      resolvedSessionDir,
      `${spec.tmux_session_name}:0`,
      replayablePaneCommand(spec.pane_start_command),
    );
    createdBinding = readTmuxRunnerBinding(`${spec.tmux_session_name}:0`);
    if (!createdBinding || createdBinding.session_name !== spec.tmux_session_name
      || createdBinding.pane_start_command !== spec.pane_start_command) {
      throw new Error('Restored tmux pane did not preserve the exact supervised owner command.');
    }
    let acceptedTmuxOwner = false;
    const finalState = stateManager.update(statePath, (current) => {
      const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
      const cancelled = current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled';
      const exactOwnerSpec = ownerSpec(current.autonomous_owner_spec);
      if (cancelled || intent?.intent_id !== intentId || intent.restorer_pid !== process.pid) return current;
      if (!exactOwnerSpec || exactOwnerSpec.spec_id !== spec.spec_id
        || exactOwnerSpec.session_dir !== resolvedSessionDir) return current;
      current.tmux_runner_binding = createdBinding;
      current.autonomous_owner_restoration = {
        ...intent,
        status: 'restored',
        restorer_pid: null,
        restorer_identity: null,
        restored_tmux_binding: createdBinding,
      };
      current.recovery_required = false;
      current.recovery_reason = null;
      appendHistory(current, 'autonomous_owner_restored');
      acceptedTmuxOwner = true;
      return current;
    });
    if (finalState.cancel_requested_at || finalState.cancelled === true || finalState.last_exit_reason === 'cancelled') {
      if (createdBinding) killTmuxSessionById(createdBinding.session_id);
      return 'noop';
    }
    if (!acceptedTmuxOwner) {
      if (createdBinding) killTmuxSessionById(createdBinding.session_id);
      createdBinding = null;
      newlyCreatedSessionId = null;
      throw new Error('Refusing to publish restored tmux ownership after the immutable owner contract changed.');
    }
    return 'restored';
  } catch (error) {
    if (launchedProcessIdentity) {
      try { reapRecordedLiveProcessGroup(launchedProcessIdentity); } catch {
        // Preserve the restoration failure; cleanup is constrained to the exact process identity.
      }
    }
    if (newlyCreatedSessionId) {
      try { killTmuxSessionById(newlyCreatedSessionId); } catch {
        // Preserve the restoration failure; cleanup is constrained to the exact session id.
      }
    }
    if (intentId) failRestoration(stateManager, statePath, intentId, error);
    throw error;
  }
}

export async function prepareCancellationRecoveryWatchdog(
  sessionDir: string,
  runtimeBin: string,
  stateManager: StateManager = new StateManager(),
  options: { readinessTimeoutMs?: number; armTimeoutMs?: number } = {},
): Promise<string | null> {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const initial = stateManager.read(statePath);
  if (ownerSpec(initial.autonomous_owner_spec)) return null;
  const existingIntent = cancellationRecoveryIntent(initial.cancellation_recovery);
  const armId = existingIntent?.intent_id || crypto.randomUUID();
  const now = Date.now();
  const arm: CancellationRecoveryWatchdogArm = {
    schema_version: 1,
    arm_id: armId,
    status: 'prepared',
    prepared_at: new Date(now).toISOString(),
    expires_at: new Date(now + (options.armTimeoutMs ?? 30_000)).toISOString(),
    activated_at: null,
  };
  const runtimeBinding = cancellationRecoveryRuntimeBinding(runtimeBin);
  stateManager.update(statePath, (current) => {
    if (ownerSpec(current.autonomous_owner_spec)) return current;
    const existingBinding = current.cancellation_recovery_runtime_binding;
    if (existingBinding && JSON.stringify(existingBinding) !== JSON.stringify(runtimeBinding)) {
      throw new Error('Cancellation recovery runtime identity changed before watchdog preparation.');
    }
    current.cancellation_recovery_runtime_binding = runtimeBinding;
    current.cancellation_recovery_watchdog_arm = arm;
    return current;
  });
  ensureCancellationRecoveryWatchdog(resolvedSessionDir, runtimeBin, stateManager);
  ensureAutonomousOwnerRecoveryDaemon(resolvedSessionDir, runtimeBin, stateManager);
  const deadline = Date.now() + (options.readinessTimeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const state = stateManager.read(statePath);
    const watchdogIdentity = state.cancellation_recovery_watchdog_identity as PersistedProcessIdentity | null;
    const daemonIdentity = state.autonomous_owner_recovery_daemon_identity as PersistedProcessIdentity | null;
    if (state.cancellation_recovery_watchdog_arm_id === armId
      && watchdogIdentity && inspectProcessLivenessIdentity(watchdogIdentity) === 'matched'
      && daemonIdentity && inspectProcessLivenessIdentity(daemonIdentity) === 'matched') return armId;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  stateManager.update(statePath, (current) => {
    const exact = cancellationRecoveryWatchdogArm(current.cancellation_recovery_watchdog_arm);
    if (exact?.arm_id === armId && exact.status === 'prepared') {
      current.cancellation_recovery_watchdog_arm = null;
    }
    return current;
  });
  throw new Error('Cancellation recovery watchdog did not publish exact readiness before cancellation.');
}

export function ensureAutonomousOwnerRecoveryDaemon(
  sessionDir: string,
  runtimeBin: string,
  stateManager: StateManager = new StateManager(),
  options: { skipCancellationWatchdog?: boolean } = {},
): number | null {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const state = stateManager.read(statePath);
  const cancellationRecovery = hasPendingCancellationRecovery(state);
  const watchdogArm = cancellationRecoveryWatchdogArm(state.cancellation_recovery_watchdog_arm);
  const preparedDirectRecovery = !ownerSpec(state.autonomous_owner_spec)
    && watchdogArm?.status === 'prepared';
  if (!ownerSpec(state.autonomous_owner_spec) && !cancellationRecovery && !preparedDirectRecovery) return null;
  const directCancellationRecovery = (cancellationRecovery || preparedDirectRecovery)
    && !ownerSpec(state.autonomous_owner_spec);
  const cancellationRuntime = directCancellationRecovery
    ? bindCancellationRecoveryRuntime(stateManager, statePath, runtimeBin) : null;
  if (directCancellationRecovery
    && !options.skipCancellationWatchdog) {
    ensureCancellationRecoveryWatchdog(resolvedSessionDir, runtimeBin, stateManager);
  }
  if (state.autonomous_owner_recovery_suspended === true) return null;
  if ((state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled')
    && !cancellationRecovery) return null;
  const daemonIdentity = state.autonomous_owner_recovery_daemon_identity as PersistedProcessIdentity | null;
  if (daemonIdentity && inspectProcessLivenessIdentity(daemonIdentity) === 'matched') {
    return Number(state.autonomous_owner_recovery_daemon_pid);
  }
  const child = spawn(
    cancellationRuntime?.node_path || process.execPath,
    [cancellationRuntime?.daemon_path || path.join(runtimeBin, 'autonomous-owner-recovery-daemon.js'), resolvedSessionDir], {
    cwd: String(state.working_dir || process.cwd()),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    },
  );
  child.unref();
  return child.pid ?? null;
}

/** Direct sessions have no supervised runner to replace a killed recovery
 * daemon. A mutually supervised watchdog gives those sessions the same durable
 * replacement path: the watchdog re-ensures the daemon, and the daemon
 * re-ensures the watchdog until the cancellation intent is complete. */
export function ensureCancellationRecoveryWatchdog(
  sessionDir: string,
  runtimeBin: string,
  stateManager: StateManager = new StateManager(),
): number | null {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const state = stateManager.read(getStatePath(resolvedSessionDir));
  const arm = cancellationRecoveryWatchdogArm(state.cancellation_recovery_watchdog_arm);
  if (ownerSpec(state.autonomous_owner_spec)
    || (!hasPendingCancellationRecovery(state) && arm?.status !== 'prepared')) return null;
  const runtime = bindCancellationRecoveryRuntime(stateManager, getStatePath(resolvedSessionDir), runtimeBin);
  const identity = state.cancellation_recovery_watchdog_identity as PersistedProcessIdentity | null;
  if (identity && inspectProcessLivenessIdentity(identity) === 'matched') {
    return Number(state.cancellation_recovery_watchdog_pid);
  }
  const child = spawn(runtime.node_path, [
    runtime.watchdog_path,
    resolvedSessionDir,
  ], {
    cwd: String(state.working_dir || process.cwd()),
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
}

export function transferAutonomousOwnerRecoveryForAcceptedHandoff(
  sessionDir: string,
  runnerBin: 'mux-runner.js' | 'pipeline-runner.js',
  runnerArgs: string[],
  runtimeBin: string,
  stateManager: StateManager = new StateManager(),
  options: AcceptedHandoffTransferOptions = {},
): AutonomousOwnerSpec | null {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  let transferred: AutonomousOwnerSpec | null = null;
  stateManager.update(statePath, (current) => {
    if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled'
      || current.recovery_required === true) return current;
    const source = ownerSpec(current.autonomous_owner_spec);
    const binding = current.tmux_runner_binding as TmuxRunnerBinding | null;
    if (!source || !binding) return current;
    options.beforePublish?.(current);
    const transaction = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
    if (transaction) {
      const transactionError = handoffTransactionValidationError(transaction, resolvedSessionDir);
      if (transactionError) {
        rejectInvalidHandoffTransactionState(current, transaction, transactionError);
        return current;
      }
      if (transaction.status !== 'fenced') return current;
    }
    const supervisorIdentity = transaction?.status === 'fenced'
      ? transaction.target_supervisor_identity
      : captureProcessLivenessIdentity(process.ppid);
    if (!supervisorIdentity) throw new Error('Accepted handoff supervisor has no immutable process identity.');
    transferred = transaction?.status === 'fenced'
      ? transaction.target_owner_spec
      : buildTransferredOwnerSpec(resolvedSessionDir, current, source, binding, runnerBin, runnerArgs, runtimeBin);
    current.autonomous_owner_spec = transferred;
    current.autonomous_owner_restoration = null;
    current.autonomous_supervisor_pid = supervisorIdentity.pid;
    current.autonomous_supervisor_identity = supervisorIdentity;
    current.autonomous_owner_recovery_suspended = false;
    current.autonomous_owner_recovery_suspended_for_handoff = null;
    if (transaction?.status === 'fenced') {
      current.autonomous_owner_handoff_transaction = {
        ...transaction, status: 'completed', error: null,
      };
    }
    appendHistory(current, 'autonomous_owner_recovery_transferred_for_runtime_handoff');
    return current;
  });
  if (!transferred) return null;
  ensureAutonomousOwnerRecoveryDaemon(resolvedSessionDir, runtimeBin, stateManager);
  return transferred;
}

export function fenceAutonomousOwnerRecoveryForHandoff(
  sessionDir: string,
  handoffRequestId: string,
  runnerBin: 'mux-runner.js' | 'pipeline-runner.js',
  runnerArgs: string[],
  runtimeBin: string,
  targetRuntime: InstalledRuntimeDescriptor,
  stateManager: StateManager = new StateManager(),
): void {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  stateManager.update(getStatePath(resolvedSessionDir), (current) => {
    const source = ownerSpec(current.autonomous_owner_spec);
    const binding = current.tmux_runner_binding as TmuxRunnerBinding | null;
    if (!source || !binding) return current;
    const targetIdentity = captureProcessLivenessIdentity(process.ppid);
    if (!targetIdentity) throw new Error('Handoff target supervisor has no immutable process identity.');
    const existing = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
    if (existing?.request_id === handoffRequestId && existing.status === 'fenced') return current;
    if (existing?.status === 'fenced') throw new Error('A different autonomous owner handoff is already fenced.');
    const targetSpec = buildTransferredOwnerSpec(
      resolvedSessionDir, current, source, binding, runnerBin, runnerArgs, runtimeBin,
    );
    current.autonomous_owner_handoff_transaction = {
      schema_version: 1,
      request_id: handoffRequestId,
      status: 'fenced',
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      source_owner_spec: source,
      source_supervisor_pid: Number(current.autonomous_supervisor_pid) || null,
      source_supervisor_identity: current.autonomous_supervisor_identity as PersistedProcessIdentity | null,
      target_owner_spec: targetSpec,
      target_supervisor_pid: targetIdentity.pid,
      target_supervisor_identity: targetIdentity,
      target_runtime: structuredClone(targetRuntime),
      reconcile_attempt: 0,
      reconcile_epoch: 1,
      reconcile_strategy: handoffReconcileStrategy(1),
      reconcile_not_before: null,
      error: null,
    } satisfies AutonomousOwnerHandoffTransaction;
    current.autonomous_owner_recovery_suspended = true;
    current.autonomous_owner_recovery_suspended_for_handoff = handoffRequestId;
    appendHistory(current, 'autonomous_owner_recovery_fenced_for_runtime_handoff');
    return current;
  });
}

export function releaseAutonomousOwnerRecoveryHandoffFence(
  sessionDir: string,
  handoffRequestId: string,
  stateManager: StateManager = new StateManager(),
): void {
  stateManager.update(getStatePath(fs.realpathSync(sessionDir)), (current) => {
    if (current.autonomous_owner_recovery_suspended_for_handoff !== handoffRequestId) return current;
    const transaction = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
    current.autonomous_owner_recovery_suspended = false;
    current.autonomous_owner_recovery_suspended_for_handoff = null;
    if (transaction?.request_id === handoffRequestId && transaction.status === 'fenced') {
      current.autonomous_owner_handoff_transaction = { ...transaction, status: 'rolled_back' };
    }
    appendHistory(current, 'autonomous_owner_recovery_handoff_fence_released');
    return current;
  });
}

export function reconcileAutonomousOwnerHandoffTransaction(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
  options: AutonomousOwnerHandoffReconcileOptions = {},
): 'noop' | 'completed' | 'rolled_back' {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  let state = stateManager.read(statePath);
  let transaction = state.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
  if (!transaction) return 'noop';
  if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled') return 'noop';
  if (transaction.status === 'completed' || transaction.status === 'rolled_back') return 'noop';
  const legacyExhaustion = transaction.schema_version === 1 && transaction.status === 'failed'
    && state.recovery_required === true
    && state.recovery_reason === 'accepted runtime handoff migration could not be finalized after bounded retries';
  if (transaction.status === 'failed' && !legacyExhaustion) return 'noop';
  const transactionError = handoffTransactionValidationError(transaction, resolvedSessionDir);
  if (transactionError) {
    failClosedInvalidHandoffTransaction(
      stateManager,
      statePath,
      typeof transaction.request_id === 'string' ? transaction.request_id : null,
      transactionError,
    );
    return 'noop';
  }
  if (legacyExhaustion) {
    const legacyRequestId = transaction.request_id;
    state = stateManager.update(statePath, (current) => {
      const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
      if (!exact || current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled'
        || exact.request_id !== legacyRequestId || exact.status !== 'failed'
        || current.recovery_reason !== 'accepted runtime handoff migration could not be finalized after bounded retries') {
        return current;
      }
      const nextEpoch = Math.max(2, Number(exact.reconcile_epoch || 1) + 1);
      current.autonomous_owner_handoff_transaction = {
        ...exact,
        status: 'fenced',
        reconcile_attempt: 0,
        reconcile_epoch: nextEpoch,
        reconcile_strategy: handoffReconcileStrategy(nextEpoch),
        reconcile_not_before: new Date(nowMs).toISOString(),
        error: null,
      };
      current.autonomous_owner_recovery_suspended = true;
      current.autonomous_owner_recovery_suspended_for_handoff = exact.request_id;
      current.recovery_required = false;
      current.recovery_reason = null;
      appendHistory(current, 'autonomous_owner_handoff_legacy_exhaustion_resumed');
      return current;
    });
    transaction = state.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
  }
  if (!transaction || transaction.schema_version !== 1 || transaction.status !== 'fenced') return 'noop';
  if (state.recovery_required === true) return 'noop';
  const reconcileNotBeforeMs = Date.parse(String(transaction.reconcile_not_before || ''));
  if (Number.isFinite(reconcileNotBeforeMs) && reconcileNotBeforeMs > nowMs) return 'noop';

  let logical = readLogicalPipeline(resolvedSessionDir);
  let completed = logical.events.find((event) => event.kind === 'runtime_handoff_completed'
    && event.details.request_id === transaction.request_id);
  let aborted = logical.events.find((event) => event.kind === 'runtime_handoff_aborted'
    && event.details.request_id === transaction.request_id);
  if (!completed && !aborted && nowMs >= Date.parse(transaction.deadline_at)) {
    abortExpiredRuntimeHandoff(resolvedSessionDir, 60_000, { nowMs });
    logical = readLogicalPipeline(resolvedSessionDir);
    completed = logical.events.find((event) => event.kind === 'runtime_handoff_completed'
      && event.details.request_id === transaction.request_id);
    aborted = logical.events.find((event) => event.kind === 'runtime_handoff_aborted'
      && event.details.request_id === transaction.request_id);
  }

  if (completed) {
    if (JSON.stringify(completed.details.target_runtime) !== JSON.stringify(transaction.target_runtime)) {
      stateManager.update(statePath, (current) => {
        if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') {
          return current;
        }
        const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
        if (exact?.request_id === transaction.request_id && exact.status === 'fenced') {
          const exactError = handoffTransactionValidationError(exact, resolvedSessionDir);
          if (exactError) {
            rejectInvalidHandoffTransactionState(current, exact, exactError);
            return current;
          }
          current.autonomous_owner_handoff_transaction = {
            ...exact,
            status: 'failed',
            error: 'target runtime does not match the durable accepted event',
          };
        }
        current.autonomous_owner_recovery_suspended = false;
        current.autonomous_owner_recovery_suspended_for_handoff = null;
        current.recovery_required = true;
        current.recovery_reason = 'autonomous handoff target runtime does not match the durable accepted event';
        appendHistory(current, 'autonomous_owner_handoff_reconciliation_failed_closed');
        return current;
      });
      return 'noop';
    }
    try {
      (options.finalizeMigration ?? finalizeLiveSessionMigrationAfterHandoff)(
        resolvedSessionDir, transaction.request_id, transaction.target_runtime,
      );
    } catch (error) {
      stateManager.update(statePath, (current) => {
        const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
        if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') {
          return current;
        }
        if (exact?.request_id === transaction.request_id && exact.status === 'fenced') {
          const exactError = handoffTransactionValidationError(exact, resolvedSessionDir);
          if (exactError) {
            rejectInvalidHandoffTransactionState(current, exact, exactError);
            return current;
          }
          const message = error instanceof Error ? error.message : String(error);
          if (!recoverableHandoffFinalizationError(error)) {
            current.autonomous_owner_handoff_transaction = {
              ...exact,
              status: 'failed',
              error: message,
            };
            current.autonomous_owner_recovery_suspended = false;
            current.autonomous_owner_recovery_suspended_for_handoff = null;
            current.recovery_required = true;
            current.recovery_reason = `accepted runtime handoff migration failed integrity validation: ${message}`;
            appendHistory(current, 'autonomous_owner_handoff_reconciliation_failed_closed');
            return current;
          }
          const attempt = Number(exact.reconcile_attempt || 0) + 1;
          const epoch = Math.max(1, Number(exact.reconcile_epoch || 1));
          if (attempt >= HANDOFF_RECONCILE_ATTEMPTS_PER_EPOCH) {
            const nextEpoch = epoch + 1;
            current.autonomous_owner_handoff_transaction = {
              ...exact,
              status: 'fenced',
              reconcile_attempt: 0,
              reconcile_epoch: nextEpoch,
              reconcile_strategy: handoffReconcileStrategy(nextEpoch),
              reconcile_not_before: new Date(nowMs + handoffReconcileEpochDelayMs(nextEpoch)).toISOString(),
              error: message,
            };
            appendHistory(current, 'autonomous_owner_handoff_reconciliation_epoch_advanced');
          } else {
            current.autonomous_owner_handoff_transaction = {
              ...exact,
              status: 'fenced',
              reconcile_attempt: attempt,
              reconcile_epoch: epoch,
              reconcile_strategy: exact.reconcile_strategy || handoffReconcileStrategy(epoch),
              reconcile_not_before: null,
              error: message,
            };
          }
          current.autonomous_owner_recovery_suspended = true;
          current.autonomous_owner_recovery_suspended_for_handoff = exact.request_id;
        }
        return current;
      });
      return 'noop';
    }
    let applied = false;
    stateManager.update(statePath, (current) => {
      const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
      if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled'
        || exact?.request_id !== transaction.request_id || exact.status !== 'fenced') return current;
      const exactError = handoffTransactionValidationError(exact, resolvedSessionDir);
      if (exactError) {
        rejectInvalidHandoffTransactionState(current, exact, exactError);
        return current;
      }
      current.autonomous_owner_spec = exact.target_owner_spec;
      current.autonomous_supervisor_pid = exact.target_supervisor_pid;
      current.autonomous_supervisor_identity = exact.target_supervisor_identity;
      current.autonomous_owner_restoration = null;
      current.autonomous_owner_recovery_suspended = false;
      current.autonomous_owner_recovery_suspended_for_handoff = null;
      current.autonomous_owner_handoff_transaction = { ...exact, status: 'completed', error: null };
      appendHistory(current, 'autonomous_owner_handoff_reconciled_to_target');
      applied = true;
      return current;
    });
    return applied ? 'completed' : 'noop';
  }

  if (aborted) {
    let applied = false;
    stateManager.update(statePath, (current) => {
      const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
      if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled'
        || exact?.request_id !== transaction.request_id || exact.status !== 'fenced') return current;
      const exactError = handoffTransactionValidationError(exact, resolvedSessionDir);
      if (exactError) {
        rejectInvalidHandoffTransactionState(current, exact, exactError);
        return current;
      }
      current.autonomous_owner_spec = exact.source_owner_spec;
      current.autonomous_supervisor_pid = exact.source_supervisor_pid;
      current.autonomous_supervisor_identity = exact.source_supervisor_identity;
      current.autonomous_owner_restoration = null;
      current.autonomous_owner_recovery_suspended = false;
      current.autonomous_owner_recovery_suspended_for_handoff = null;
      current.autonomous_owner_handoff_transaction = { ...exact, status: 'rolled_back', error: null };
      appendHistory(current, 'autonomous_owner_handoff_reconciled_to_source');
      applied = true;
      return current;
    });
    return applied ? 'rolled_back' : 'noop';
  }
  return 'noop';
}

export async function runAutonomousOwnerRecoveryDaemon(
  sessionDir: string,
  options: { intervalMs?: number; stateManager?: StateManager; runtimeBin?: string } = {},
): Promise<void> {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const manager = options.stateManager || new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  const statePath = getStatePath(resolvedSessionDir);
  const daemonLeasePath = path.join(resolvedSessionDir, '.autonomous-owner-recovery-daemon');
  try {
    manager.acquireLock(daemonLeasePath);
  } catch {
    return;
  }
  try {
    manager.update(statePath, (current) => {
      current.autonomous_owner_recovery_daemon_pid = process.pid;
      current.autonomous_owner_recovery_daemon_identity = captureProcessLivenessIdentity(process.pid);
      appendHistory(current, 'autonomous_owner_recovery_daemon_started');
      return current;
    });
    while (true) {
      const beforeRecovery = manager.read(statePath);
      const pendingCancellation = hasPendingCancellationRecovery(beforeRecovery);
      const watchdogArm = cancellationRecoveryWatchdogArm(
        beforeRecovery.cancellation_recovery_watchdog_arm,
      );
      if (!ownerSpec(beforeRecovery.autonomous_owner_spec)
        && (pendingCancellation || watchdogArm)) {
        ensureCancellationRecoveryWatchdog(
          resolvedSessionDir,
          options.runtimeBin || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin'),
          manager,
        );
      }
      if (!ownerSpec(beforeRecovery.autonomous_owner_spec)
        && !pendingCancellation && !watchdogArm) return;
      if (watchdogArm?.status === 'prepared') {
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
        continue;
      }
      try {
        reconcileCancellationRecovery(resolvedSessionDir, manager);
      } catch {
        // The exact durable cancellation intent remains for the next pass.
      }
      try {
        reconcileAutonomousOwnerHandoffTransaction(resolvedSessionDir, manager);
      } catch {
        // The durable fence remains for the next bounded reconciliation pass.
      }
      const state = manager.read(statePath);
      if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled'
        || state.step === 'complete' || state.last_exit_reason === 'success') {
        if (!hasPendingCancellationRecovery(state)) return;
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
        continue;
      }
      if (state.autonomous_owner_recovery_suspended === true) {
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
        continue;
      }
      try {
        restoreAutonomousBudgetOwner(resolvedSessionDir, manager);
      } catch {
        // The restoration intent records the exact failure and bounded retry state.
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
    }
  } finally {
    try {
      manager.update(statePath, (current) => {
        if (Number(current.autonomous_owner_recovery_daemon_pid) === process.pid) {
          current.autonomous_owner_recovery_daemon_pid = null;
          current.autonomous_owner_recovery_daemon_identity = null;
        }
        if (!hasPendingCancellationRecovery(current)
          && !cancellationRecoveryWatchdogArm(current.cancellation_recovery_watchdog_arm)) {
          current.cancellation_recovery_runtime_binding = null;
        }
        return current;
      });
    } finally {
      manager.releaseLock(daemonLeasePath);
    }
  }
}

export async function runCancellationRecoveryWatchdog(
  sessionDir: string,
  runtimeBin: string,
  options: { intervalMs?: number; stateManager?: StateManager } = {},
): Promise<void> {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const manager = options.stateManager || new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  const statePath = getStatePath(resolvedSessionDir);
  const leasePath = path.join(resolvedSessionDir, '.cancellation-recovery-watchdog');
  try {
    manager.acquireLock(leasePath);
  } catch {
    return;
  }
  let armedIntentId: string | null = null;
  try {
    manager.update(statePath, (current) => {
      const arm = cancellationRecoveryWatchdogArm(current.cancellation_recovery_watchdog_arm);
      armedIntentId = arm?.arm_id || null;
      current.cancellation_recovery_watchdog_pid = process.pid;
      current.cancellation_recovery_watchdog_identity = captureProcessLivenessIdentity(process.pid);
      current.cancellation_recovery_watchdog_arm_id = armedIntentId;
      appendHistory(current, 'cancellation_recovery_watchdog_started');
      return current;
    });
    while (true) {
      const state = manager.read(statePath);
      const arm = cancellationRecoveryWatchdogArm(state.cancellation_recovery_watchdog_arm);
      if (armedIntentId) {
        if (!arm || arm.arm_id !== armedIntentId) return;
        if (arm.status === 'prepared') {
          if (Date.now() >= Date.parse(arm.expires_at)) {
            manager.update(statePath, (current) => {
              const exact = cancellationRecoveryWatchdogArm(current.cancellation_recovery_watchdog_arm);
              if (exact?.arm_id === armedIntentId && exact.status === 'prepared') {
                current.cancellation_recovery_watchdog_arm = null;
              }
              return current;
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
          continue;
        }
        const intent = cancellationRecoveryIntent(state.cancellation_recovery);
        if (!intent || intent.intent_id !== armedIntentId) return;
      }
      if (!hasPendingCancellationRecovery(state)) return;
      ensureAutonomousOwnerRecoveryDaemon(resolvedSessionDir, runtimeBin, manager, {
        skipCancellationWatchdog: true,
      });
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
    }
  } finally {
    try {
      manager.update(statePath, (current) => {
        if (Number(current.cancellation_recovery_watchdog_pid) === process.pid) {
          current.cancellation_recovery_watchdog_pid = null;
          current.cancellation_recovery_watchdog_identity = null;
          current.cancellation_recovery_watchdog_arm_id = null;
          const arm = cancellationRecoveryWatchdogArm(current.cancellation_recovery_watchdog_arm);
          if (arm?.arm_id === armedIntentId) current.cancellation_recovery_watchdog_arm = null;
          if (!hasPendingCancellationRecovery(current)) {
            current.cancellation_recovery_runtime_binding = null;
          }
        }
        return current;
      });
    } finally {
      manager.releaseLock(leasePath);
    }
  }
}
