import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLaunchLock } from './detached-launch.js';
import { appendHistory, getStatePath, reconcileSessionLiveness } from './session.js';
import { StateManager } from './state-manager.js';
import { captureProcessLivenessIdentity, inspectProcessLivenessIdentity, type PersistedProcessIdentity } from './orphan-reaper.js';
import {
  abortExpiredRuntimeHandoff,
  readLogicalPipeline,
  type InstalledRuntimeDescriptor,
} from './durable-supervisor.js';
import { finalizeLiveSessionMigrationAfterHandoff } from './live-session-migration.js';
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
  spec_id: string;
  session_dir: string;
  working_dir: string;
  tmux_session_name: string;
  original_tmux_session_id: string;
  original_tmux_session_created: string;
  pane_start_command: string;
  runner_bin: string;
  runner_args: string[];
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
  error?: string | null;
}

function stableSpecId(spec: Omit<AutonomousOwnerSpec, 'spec_id'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

function ownerSpec(value: unknown): AutonomousOwnerSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const spec = value as AutonomousOwnerSpec;
  if (spec.schema_version !== 1 || typeof spec.spec_id !== 'string'
    || typeof spec.session_dir !== 'string' || typeof spec.working_dir !== 'string'
    || typeof spec.tmux_session_name !== 'string' || typeof spec.original_tmux_session_id !== 'string'
    || typeof spec.original_tmux_session_created !== 'string' || typeof spec.pane_start_command !== 'string'
    || typeof spec.runner_bin !== 'string' || !Array.isArray(spec.runner_args)) return null;
  const unsigned = { ...spec } as Omit<AutonomousOwnerSpec, 'spec_id'> & { spec_id?: string };
  delete unsigned.spec_id;
  return stableSpecId(unsigned) === spec.spec_id ? spec : null;
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
  if (state.tmux_mode !== true) return null;
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
      if (!current.cancel_requested_at && current.last_exit_reason !== 'cancelled') {
        current.autonomous_supervisor_pid = process.pid;
        current.autonomous_supervisor_identity = captureProcessLivenessIdentity(process.pid);
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
    if (existing && existing.spec_id !== spec.spec_id) {
      throw new Error('Refusing to replace a different immutable autonomous owner specification.');
    }
    current.autonomous_owner_spec = spec;
    if (!current.cancel_requested_at && current.last_exit_reason !== 'cancelled') {
      current.autonomous_supervisor_pid = process.pid;
      current.autonomous_supervisor_identity = captureProcessLivenessIdentity(process.pid);
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

export function restoreAutonomousBudgetOwner(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  nowMs: number = Date.now(),
): 'noop' | 'restored' {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const beforeReconcile = stateManager.read(statePath);
  if (beforeReconcile.recovery_required === true || beforeReconcile.cancel_requested_at
    || beforeReconcile.cancelled === true || beforeReconcile.last_exit_reason === 'cancelled') return 'noop';
  reconcileSessionLiveness(resolvedSessionDir, stateManager, nowMs);
  const release = acquireLaunchLock(resolvedSessionDir);
  let createdBinding: TmuxRunnerBinding | null = null;
  let newlyCreatedSessionId: string | null = null;
  let intentId = '';
  let expectedBinding: TmuxRunnerBinding | null = null;
  try {
    let claimedSpec: AutonomousOwnerSpec | null = null;
    stateManager.update(statePath, (current) => {
      if (current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled') return current;
      if (current.recovery_required === true) return current;
      const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
      const spec = ownerSpec(current.autonomous_owner_spec);
      if (!intent || !spec || intent.owner_spec_id !== spec.spec_id
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
        restorer_identity: captureProcessLivenessIdentity(process.pid),
        error: undefined,
      };
      appendHistory(current, 'autonomous_owner_restoration_claimed');
      return current;
    });
    if (!claimedSpec || !intentId) return 'noop';
    const spec = claimedSpec as AutonomousOwnerSpec;
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
    const finalState = stateManager.update(statePath, (current) => {
      const intent = current.autonomous_owner_restoration as AutonomousOwnerRestorationIntent | null;
      const cancelled = current.cancel_requested_at || current.cancelled === true || current.last_exit_reason === 'cancelled';
      if (cancelled || intent?.intent_id !== intentId || intent.restorer_pid !== process.pid) return current;
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
      return current;
    });
    if (finalState.cancel_requested_at || finalState.cancelled === true || finalState.last_exit_reason === 'cancelled') {
      if (createdBinding) killTmuxSessionById(createdBinding.session_id);
      return 'noop';
    }
    return 'restored';
  } catch (error) {
    if (newlyCreatedSessionId) {
      try { killTmuxSessionById(newlyCreatedSessionId); } catch {
        // Preserve the restoration failure; cleanup is constrained to the exact session id.
      }
    }
    if (intentId) failRestoration(stateManager, statePath, intentId, error);
    throw error;
  } finally {
    release();
  }
}

export function ensureAutonomousOwnerRecoveryDaemon(
  sessionDir: string,
  runtimeBin: string,
  stateManager: StateManager = new StateManager(),
): number | null {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const state = stateManager.read(statePath);
  if (!ownerSpec(state.autonomous_owner_spec)) return null;
  if (state.autonomous_owner_recovery_suspended === true) return null;
  if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled') return null;
  const daemonIdentity = state.autonomous_owner_recovery_daemon_identity as PersistedProcessIdentity | null;
  if (daemonIdentity && inspectProcessLivenessIdentity(daemonIdentity) === 'matched') {
    return Number(state.autonomous_owner_recovery_daemon_pid);
  }
  const child = spawn(process.execPath, [path.join(runtimeBin, 'autonomous-owner-recovery-daemon.js'), resolvedSessionDir], {
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
): AutonomousOwnerSpec | null {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  let transferred: AutonomousOwnerSpec | null = null;
  stateManager.update(statePath, (current) => {
    const source = ownerSpec(current.autonomous_owner_spec);
    const binding = current.tmux_runner_binding as TmuxRunnerBinding | null;
    if (!source || !binding) return current;
    const transaction = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
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
): 'noop' | 'completed' | 'rolled_back' {
  const resolvedSessionDir = fs.realpathSync(sessionDir);
  const statePath = getStatePath(resolvedSessionDir);
  const state = stateManager.read(statePath);
  const transaction = state.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
  if (!transaction || transaction.schema_version !== 1 || transaction.status !== 'fenced') return 'noop';
  if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled') return 'noop';

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
        current.recovery_required = true;
        current.recovery_reason = 'autonomous handoff target runtime does not match the durable accepted event';
        return current;
      });
      return 'noop';
    }
    try {
      finalizeLiveSessionMigrationAfterHandoff(
        resolvedSessionDir, transaction.request_id, transaction.target_runtime,
      );
    } catch (error) {
      stateManager.update(statePath, (current) => {
        const exact = current.autonomous_owner_handoff_transaction as AutonomousOwnerHandoffTransaction | null;
        if (exact?.request_id === transaction.request_id && exact.status === 'fenced') {
          const attempt = Number(exact.reconcile_attempt || 0) + 1;
          current.autonomous_owner_handoff_transaction = {
            ...exact,
            status: attempt >= 5 ? 'failed' : 'fenced',
            reconcile_attempt: attempt,
            error: error instanceof Error ? error.message : String(error),
          };
          if (attempt >= 5) {
            current.autonomous_owner_recovery_suspended = false;
            current.autonomous_owner_recovery_suspended_for_handoff = null;
            current.recovery_required = true;
            current.recovery_reason = 'accepted runtime handoff migration could not be finalized after bounded retries';
            appendHistory(current, 'autonomous_owner_handoff_reconciliation_failed');
          }
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
  options: { intervalMs?: number; stateManager?: StateManager } = {},
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
      try {
        reconcileAutonomousOwnerHandoffTransaction(resolvedSessionDir, manager);
      } catch {
        // The durable fence remains for the next bounded reconciliation pass.
      }
      const state = manager.read(statePath);
      if (state.cancel_requested_at || state.cancelled === true || state.last_exit_reason === 'cancelled'
        || state.step === 'complete' || state.last_exit_reason === 'success') return;
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
        return current;
      });
    } finally {
      manager.releaseLock(daemonLeasePath);
    }
  }
}
