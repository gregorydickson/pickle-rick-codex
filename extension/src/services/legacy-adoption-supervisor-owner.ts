import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { inspectProcessLivenessIdentity } from './orphan-reaper.js';
import { legacyAdoptionExecutorSpecHash, readLegacyAdoptionExecutorStatus, type LegacyAdoptionExecutorSpec } from './legacy-adoption-executor-supervisor.js';
import { StateManager } from './state-manager.js';
import { killTmuxSessionById, readTmuxRunnerBinding, runTmux, shellQuote, tmuxSessionExists, type TmuxRunnerBinding } from './tmux.js';

export const LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE = 'legacy-session-adoption-supervisor-owner.json';

export interface LegacyAdoptionSupervisorOwnerStatus {
  schema_version: 1;
  session_id: string;
  status: 'booting' | 'ready' | 'terminal';
  binding: TmuxRunnerBinding;
  supervisor_identity_fingerprint: string | null;
  supervisor_generation: number;
  launch_nonce: string;
  executor_spec_sha256: string;
  started_at: string;
  ready_at: string | null;
  updated_at: string;
}

interface Dependencies {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  createOwner?: (sessionName: string, command: string, cwd: string) => TmuxRunnerBinding;
  readBinding?: (target: string) => TmuxRunnerBinding | null;
  tmuxExists?: (sessionName: string) => boolean;
  killTmux?: (sessionId: string) => void;
  inspectManager?: typeof inspectProcessLivenessIdentity;
  timeoutMs?: number;
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sameBinding(left: TmuxRunnerBinding, right: TmuxRunnerBinding | null): boolean {
  return Boolean(right && left.session_name === right.session_name && left.session_id === right.session_id
    && left.session_created === right.session_created && left.pane_id === right.pane_id
    && left.pane_pid === right.pane_pid && left.pane_start_command === right.pane_start_command);
}

function ownerName(sessionDir: string): string {
  return `pickle-adoption-supervisor-${crypto.createHash('sha256').update(fs.realpathSync(sessionDir)).digest('hex').slice(0, 12)}`;
}

function supervisorCommand(spec: LegacyAdoptionExecutorSpec): string {
  const args = legacyAdoptionSupervisorManagerArgs(spec);
  const invocation = [shellQuote(process.execPath), ...args.map(shellQuote)].join(' ');
  return `while true; do ${invocation}; status=$?; if [ "$status" -eq 0 ]; then exit 0; fi; sleep 1; done`;
}

export function legacyAdoptionSupervisorManagerArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [path.resolve(fileURLToPath(new URL('../bin/legacy-adoption-executor-supervisor.js', import.meta.url))),
    '--session-dir', spec.sessionDir, '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  if (spec.ownerNonce) args.push('--owner-nonce', spec.ownerNonce);
  return args;
}

function createOwner(sessionName: string, command: string, cwd: string): TmuxRunnerBinding {
  runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, `bash -lc ${shellQuote(command)}`]);
  const binding = readTmuxRunnerBinding(`${sessionName}:0`);
  if (!binding || binding.session_name !== sessionName) throw new Error('Could not capture immutable adoption supervisor tmux binding.');
  return binding;
}

export function ensureLegacyAdoptionSupervisorOwner(
  spec: LegacyAdoptionExecutorSpec,
  deps: Dependencies = {},
): LegacyAdoptionSupervisorOwnerStatus {
  const sessionDir = fs.realpathSync(spec.sessionDir);
  const ownerPath = path.join(sessionDir, LEGACY_ADOPTION_SUPERVISOR_OWNER_FILE);
  const lock = new StateManager({ acquireTimeoutMs: 30_000, staleLockThresholdMs: 0 });
  lock.acquireLock(ownerPath);
  try {
    const now = deps.now || Date.now;
    const wait = deps.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
    const exists = deps.tmuxExists || tmuxSessionExists;
    const readBinding = deps.readBinding || readTmuxRunnerBinding;
    const inspectManager = deps.inspectManager || inspectProcessLivenessIdentity;
    const sessionName = ownerName(sessionDir);
    let owner = readJsonFile<LegacyAdoptionSupervisorOwnerStatus>(ownerPath, null);
    if (owner && (owner.schema_version !== 1 || owner.session_id !== path.basename(sessionDir)
      || owner.binding.session_name !== sessionName || !owner.launch_nonce
      || !owner.executor_spec_sha256)) throw new Error('Persisted adoption supervisor owner is invalid.');
    if (owner && exists(sessionName)) {
      if (!sameBinding(owner.binding, readBinding(owner.binding.pane_id))) {
        throw new Error('Live adoption supervisor tmux binding does not match its immutable owner record.');
      }
    } else if (owner) {
      owner = null;
    } else if (exists(sessionName)) {
      throw new Error('Unrecorded adoption supervisor tmux owner already exists.');
    }
    if (!owner) {
      const timestamp = new Date(now()).toISOString();
      const launchNonce = crypto.randomUUID();
      const boundSpec = { ...spec, sessionDir, ownerNonce: launchNonce };
      const binding = (deps.createOwner || createOwner)(sessionName, supervisorCommand(boundSpec), spec.sourceRuntimeRoot);
      owner = {
        schema_version: 1, session_id: path.basename(sessionDir), status: 'booting', binding,
        supervisor_identity_fingerprint: null, supervisor_generation: 0,
        launch_nonce: launchNonce, executor_spec_sha256: legacyAdoptionExecutorSpecHash(boundSpec),
        started_at: timestamp, ready_at: null, updated_at: timestamp,
      };
      atomicWriteJson(ownerPath, owner);
    }
    const deadline = now() + (deps.timeoutMs ?? 60_000);
    while (now() <= deadline) {
      const executor = readLegacyAdoptionExecutorStatus(sessionDir);
      if (executor && executor.manager_identity
        && inspectManager(executor.manager_identity) === 'matched'
        && executor.owner_nonce === owner.launch_nonce
        && executor.executor_spec_sha256 === owner.executor_spec_sha256
        && executor.manager_parent_pid === owner.binding.pane_pid
        && executor.manager_argv_sha256 === crypto.createHash('sha256').update(JSON.stringify([
          process.execPath, ...legacyAdoptionSupervisorManagerArgs({ ...spec, sessionDir, ownerNonce: owner.launch_nonce }),
        ])).digest('hex')
        && Date.parse(executor.updated_at) >= Date.parse(owner.started_at)) {
        const timestamp = new Date(now()).toISOString();
        const terminal = executor.status !== 'supervising';
        const ready: LegacyAdoptionSupervisorOwnerStatus = {
          ...owner, status: terminal ? 'terminal' : 'ready',
          supervisor_identity_fingerprint: executor.manager_identity.fingerprint,
          supervisor_generation: Math.max(owner.supervisor_generation, executor.manager_generation),
          ready_at: owner.ready_at || timestamp, updated_at: timestamp,
        };
        atomicWriteJson(ownerPath, ready);
        if (terminal && exists(sessionName)) (deps.killTmux || killTmuxSessionById)(owner.binding.session_id);
        return ready;
      }
      if (!exists(sessionName) || !sameBinding(owner.binding, readBinding(owner.binding.pane_id))) {
        throw new Error('Adoption supervisor durable owner exited before readiness acknowledgement.');
      }
      wait(50);
    }
    throw new Error('Timed out waiting for adoption supervisor readiness acknowledgement.');
  } finally {
    lock.releaseLock(ownerPath);
  }
}
