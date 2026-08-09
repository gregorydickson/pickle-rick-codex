import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalPipeline } from './durable-supervisor.js';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  reapRecordedLiveProcessGroup,
  type OrphanReapResult,
  type PersistedProcessIdentity,
} from './orphan-reaper.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import { readTmuxRunnerBinding, tmuxSessionExists, type TmuxRunnerBinding } from './tmux.js';

export const LEGACY_ADOPTION_EXECUTOR_FILE = 'legacy-session-adoption-executor.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_FILE = 'legacy-session-adoption-executor-restart.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE = 'legacy-session-adoption-executor-restart-rejected.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE = 'legacy-session-adoption-executor-restart-accepted.json';
export const LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX = `${LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE}.quarantine-`;

export interface LegacyAdoptionExecutorStatus {
  schema_version: 1;
  session_id: string;
  status: 'supervising' | 'launched' | 'cancelled' | 'terminal';
  manager_identity: PersistedProcessIdentity;
  manager_generation: number;
  manager_parent_pid: number;
  manager_argv_sha256: string;
  owner_nonce: string;
  executor_identity: PersistedProcessIdentity | null;
  executor_generation: number;
  executor_started_at: string | null;
  executor_lease_expires_at: string | null;
  executor_spec_sha256: string;
  replacement_count: number;
  last_loss_at: string | null;
  last_restart_request_id: string | null;
  updated_at: string;
}

export interface LegacyAdoptionExecutorRestartRequest {
  schema_version: 1;
  request_id: string;
  expected_generation: number;
  expected_executor_fingerprint: string;
  reason: string;
  requested_at: string;
}

export interface LegacyAdoptionExecutorRestartAccepted {
  schema_version: 1;
  session_id: string;
  stage: 'accepted' | 'predecessor_reaped' | 'launch_pending' | 'successor_captured' | 'committed';
  request: LegacyAdoptionExecutorRestartRequest;
  authenticated_status: LegacyAdoptionExecutorStatus;
  executor_spec_sha256: string;
  owner_nonce: string;
  predecessor_identity: PersistedProcessIdentity;
  predecessor_generation: number;
  baseline_replacement_count: number;
  accepted_at: string;
  predecessor_reaped_at: string | null;
  launch_manager_fingerprint: string | null;
  launch_started_at: string | null;
  successor_identity: PersistedProcessIdentity | null;
  successor_generation: number | null;
  successor_started_at: string | null;
  committed_at: string | null;
  integrity_chain: LegacyAdoptionExecutorRestartIntegrityTransition[];
}

interface LegacyAdoptionExecutorRestartIntegrityTransition {
  stage: LegacyAdoptionExecutorRestartAccepted['stage'];
  previous_sha256: string | null;
  record_sha256: string;
  transition_sha256: string;
  record: Record<string, unknown>;
}

export interface LegacyAdoptionExecutorSpec {
  sessionDir: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
  validationSessionDir?: string;
  ownerNonce?: string;
}

interface Dependencies {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  managerIdentity?: PersistedProcessIdentity;
  spawnExecutor?: (spec: LegacyAdoptionExecutorSpec) => number;
  capture?: (pid: number) => PersistedProcessIdentity | null;
  inspect?: (identity: PersistedProcessIdentity) => 'not-running' | 'matched' | 'reused';
  reap?: (identity: PersistedProcessIdentity) => OrphanReapResult;
  outcome?: (sessionDir: string) => 'running' | 'launched' | 'cancelled' | 'terminal';
  onIteration?: (status: LegacyAdoptionExecutorStatus) => void;
  checkpoint?: (point: string) => void;
  discoverExecutors?: (spec: LegacyAdoptionExecutorSpec) => PersistedProcessIdentity[];
  launchRecoveryMs?: number;
  leaseMs?: number;
  pollMs?: number;
}

function reapExecutor(
  identity: PersistedProcessIdentity,
  reap: NonNullable<Dependencies['reap']>,
): void {
  const result = reap(identity);
  if (result.status !== 'reaped' && result.status !== 'not-running') {
    throw new Error(`Adoption executor ${identity.pid} could not be safely reaped: ${result.status}: ${result.reason}`);
  }
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function legacyAdoptionExecutorArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [
    path.resolve(fileURLToPath(new URL('../bin/adopt-legacy-session.js', import.meta.url))),
    'watch', '--session-dir', spec.sessionDir,
    '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot,
  ];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  if (spec.ownerNonce) args.push('--owner-nonce', spec.ownerNonce);
  return args;
}

function spawnExecutor(spec: LegacyAdoptionExecutorSpec): number {
  const child = spawn(process.execPath, legacyAdoptionExecutorArgs(spec), { detached: true, stdio: 'ignore', env: process.env });
  if (!child.pid) throw new Error('Could not start the legacy adoption watchdog executor.');
  child.unref();
  return child.pid;
}

function defaultOutcome(sessionDir: string): 'running' | 'launched' | 'cancelled' | 'terminal' {
  const record = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'legacy-session-adoption.json'), null);
  if (record?.status === 'launched') return 'launched';
  const state = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
  if (state?.cancel_requested_at || state?.cancelled === true) return 'cancelled';
  try {
    if (readLogicalPipeline(sessionDir).terminal_state !== null) return 'terminal';
  } catch {
    // Adoption may still be fencing the legacy session.
  }
  return 'running';
}

export function legacyAdoptionExecutorSpecHash(spec: LegacyAdoptionExecutorSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    sessionDir: fs.realpathSync(spec.sessionDir),
    sourceRuntimeRoot: fs.realpathSync(spec.sourceRuntimeRoot),
    targetRuntimeRoot: fs.realpathSync(spec.targetRuntimeRoot),
    validationSessionDir: spec.validationSessionDir ? fs.realpathSync(spec.validationSessionDir) : '',
    ownerNonce: spec.ownerNonce || '',
  })).digest('hex');
}

function parentPid(pid: number): number {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    if (raw.length > 3) return Number(raw[3]);
  } catch { /* macOS uses ps below */ }
  const result = requirePs(pid);
  return result;
}

function requirePs(pid: number): number {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 5_000 });
  const value = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isInteger(value) || value <= 0) throw new Error('Could not capture adoption supervisor parent pid.');
  return value;
}

export function readLegacyAdoptionExecutorStatus(sessionDir: string): LegacyAdoptionExecutorStatus | null {
  const status = readJsonFile<LegacyAdoptionExecutorStatus>(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE), null);
  if (!status || status.schema_version !== 1 || status.session_id !== path.basename(sessionDir)
    || !status.manager_identity?.fingerprint || !Number.isInteger(status.manager_generation)
    || status.manager_generation < 1 || !Number.isInteger(status.manager_parent_pid) || status.manager_parent_pid <= 0
    || !status.manager_argv_sha256 || typeof status.owner_nonce !== 'string'
    || !Number.isInteger(status.executor_generation)
    || status.executor_generation < 0 || typeof status.executor_spec_sha256 !== 'string') return null;
  return status;
}

function processArgv(pid: number): string[] | null {
  try {
    const content = fs.readFileSync(`/proc/${pid}/cmdline`);
    return content.toString('utf8').split('\0').filter(Boolean);
  } catch {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    return result.stdout.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) || null;
  }
}

function exactArgv(actual: string[] | null, expected: string[]): boolean {
  return Boolean(actual && actual.length === expected.length
    && actual.every((token, index) => path.resolve(token) === path.resolve(expected[index] || '')));
}

function discoverExecutors(spec: LegacyAdoptionExecutorSpec): PersistedProcessIdentity[] {
  const listed = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5_000 });
  if (listed.status !== 0) return [];
  const expected = [process.execPath, ...legacyAdoptionExecutorArgs(spec)];
  const found: PersistedProcessIdentity[] = [];
  for (const line of listed.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    const pid = Number(match?.[1]);
    const argv = match?.[2].trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((token) => token.replace(/^["']|["']$/g, '')) || null;
    if (!Number.isInteger(pid) || pid <= 0 || !exactArgv(argv, expected)) continue;
    const identity = captureProcessLivenessIdentity(pid);
    if (identity && inspectProcessLivenessIdentity(identity) === 'matched') found.push(identity);
  }
  return found;
}

function validAcceptedRestart(
  value: LegacyAdoptionExecutorRestartAccepted | null,
  sessionDir: string,
  hash: string,
  ownerNonce: string,
): value is LegacyAdoptionExecutorRestartAccepted {
  if (!value || value.schema_version !== 1 || value.session_id !== path.basename(sessionDir)
    || !['accepted', 'predecessor_reaped', 'launch_pending', 'successor_captured', 'committed'].includes(value.stage)
    || value.executor_spec_sha256 !== hash || value.owner_nonce !== ownerNonce
    || !value.predecessor_identity?.fingerprint || !Number.isInteger(value.predecessor_generation)
    || value.predecessor_generation < 1 || !Number.isInteger(value.baseline_replacement_count)
    || value.baseline_replacement_count < 0 || value.request?.schema_version !== 1
    || !value.request.request_id || value.request.expected_generation !== value.predecessor_generation
    || value.request.expected_executor_fingerprint !== value.predecessor_identity.fingerprint
    || value.authenticated_status?.schema_version !== 1
    || value.authenticated_status.session_id !== value.session_id
    || value.authenticated_status.status !== 'supervising'
    || value.authenticated_status.owner_nonce !== value.owner_nonce
    || value.authenticated_status.executor_spec_sha256 !== value.executor_spec_sha256
    || value.authenticated_status.executor_generation !== value.predecessor_generation
    || value.authenticated_status.executor_identity?.fingerprint !== value.predecessor_identity.fingerprint
    || value.authenticated_status.replacement_count !== value.baseline_replacement_count
    || !validAcceptedRestartIntegrity(value)) return false;
  if ((value.stage === 'successor_captured' || value.stage === 'committed')
    && (!value.successor_identity?.fingerprint || !Number.isInteger(value.successor_generation)
      || Number(value.successor_generation) <= value.predecessor_generation)) return false;
  return true;
}

const ACCEPTED_RESTART_TRANSITIONS: Record<LegacyAdoptionExecutorRestartAccepted['stage'],
LegacyAdoptionExecutorRestartAccepted['stage'][]> = {
  accepted: ['predecessor_reaped'],
  predecessor_reaped: ['launch_pending'],
  launch_pending: ['successor_captured'],
  successor_captured: ['launch_pending', 'committed'],
  committed: [],
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function acceptedRestartRecordHash(
  value: LegacyAdoptionExecutorRestartAccepted,
): string {
  const record = { ...value } as Partial<LegacyAdoptionExecutorRestartAccepted>;
  delete record.integrity_chain;
  return crypto.createHash('sha256').update(canonicalJson(record)).digest('hex');
}

function acceptedRestartRecord(value: LegacyAdoptionExecutorRestartAccepted): Record<string, unknown> {
  const record = { ...value } as Partial<LegacyAdoptionExecutorRestartAccepted>;
  delete record.integrity_chain;
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function acceptedRestartTransitionHash(
  stage: LegacyAdoptionExecutorRestartAccepted['stage'],
  previousSha256: string | null,
  recordSha256: string,
): string {
  return crypto.createHash('sha256').update(canonicalJson({
    domain: 'pickle-rick-legacy-adoption-restart-v1',
    stage,
    previous_sha256: previousSha256,
    record_sha256: recordSha256,
  })).digest('hex');
}

function sealAcceptedRestart(
  value: LegacyAdoptionExecutorRestartAccepted,
): LegacyAdoptionExecutorRestartAccepted {
  const chain = Array.isArray(value.integrity_chain) ? value.integrity_chain : [];
  const previousSha256 = chain.at(-1)?.transition_sha256 || null;
  const recordSha256 = acceptedRestartRecordHash(value);
  const transition: LegacyAdoptionExecutorRestartIntegrityTransition = {
    stage: value.stage,
    previous_sha256: previousSha256,
    record_sha256: recordSha256,
    transition_sha256: acceptedRestartTransitionHash(value.stage, previousSha256, recordSha256),
    record: acceptedRestartRecord(value),
  };
  return { ...value, integrity_chain: [...chain, transition] };
}

function validAcceptedRestartIntegrity(value: LegacyAdoptionExecutorRestartAccepted): boolean {
  if (!Array.isArray(value.integrity_chain) || value.integrity_chain.length < 1
    || value.integrity_chain.length > 64) return false;
  let previousSha256: string | null = null;
  let genesis: Record<string, unknown> | null = null;
  const immutableFields = [
    'schema_version', 'session_id', 'request', 'authenticated_status', 'executor_spec_sha256',
    'owner_nonce', 'predecessor_identity', 'predecessor_generation', 'baseline_replacement_count', 'accepted_at',
  ];
  for (let index = 0; index < value.integrity_chain.length; index += 1) {
    const transition = value.integrity_chain[index];
    const priorStage = index > 0 ? value.integrity_chain[index - 1]?.stage : null;
    if (!transition || (index === 0 ? transition.stage !== 'accepted'
      : !priorStage || !ACCEPTED_RESTART_TRANSITIONS[priorStage].includes(transition.stage))
      || transition.previous_sha256 !== previousSha256
      || !transition.record || typeof transition.record !== 'object' || Array.isArray(transition.record)
      || transition.record.stage !== transition.stage
      || transition.record_sha256 !== crypto.createHash('sha256')
        .update(canonicalJson(transition.record)).digest('hex')
      || transition.transition_sha256 !== acceptedRestartTransitionHash(
        transition.stage, transition.previous_sha256, transition.record_sha256,
      ) || !validAcceptedRestartStageProjection(transition.record)) return false;
    if (index === 0) genesis = transition.record;
    else if (!genesis || immutableFields.some((field) => (
      canonicalJson(transition.record[field]) !== canonicalJson(genesis![field])
    ))) return false;
    previousSha256 = transition.transition_sha256;
  }
  const last = value.integrity_chain.at(-1)!;
  return last.stage === value.stage
    && last.record_sha256 === acceptedRestartRecordHash(value)
    && canonicalJson(last.record) === canonicalJson(acceptedRestartRecord(value));
}

function validAcceptedRestartStageProjection(record: Record<string, unknown>): boolean {
  const stage = record.stage;
  const predecessorGeneration = Number(record.predecessor_generation);
  const successorGeneration = Number(record.successor_generation);
  const hasPredecessorReap = typeof record.predecessor_reaped_at === 'string';
  const hasLaunch = typeof record.launch_manager_fingerprint === 'string'
    && typeof record.launch_started_at === 'string';
  const successor = record.successor_identity as PersistedProcessIdentity | null;
  const hasSuccessor = Boolean(successor?.fingerprint)
    && Number.isInteger(successorGeneration) && successorGeneration === predecessorGeneration + 1
    && typeof record.successor_started_at === 'string';
  if (stage === 'accepted') return record.predecessor_reaped_at === null
    && record.launch_manager_fingerprint === null && record.launch_started_at === null
    && record.successor_identity === null && record.successor_generation === null
    && record.successor_started_at === null && record.committed_at === null;
  if (stage === 'predecessor_reaped') return hasPredecessorReap
    && record.launch_manager_fingerprint === null && record.launch_started_at === null
    && record.successor_identity === null && record.successor_generation === null
    && record.successor_started_at === null && record.committed_at === null;
  if (stage === 'launch_pending') return hasPredecessorReap && hasLaunch
    && record.successor_identity === null && record.successor_generation === null
    && record.successor_started_at === null && record.committed_at === null;
  if (stage === 'successor_captured') return hasPredecessorReap && hasLaunch && hasSuccessor
    && record.committed_at === null;
  return stage === 'committed' && hasPredecessorReap && hasLaunch && hasSuccessor
    && typeof record.committed_at === 'string';
}

function quarantineInvalidAcceptedRestart(acceptedPath: string): string {
  const quarantinePath = `${acceptedPath}.quarantine-${Date.now()}-${crypto.randomUUID()}`;
  fs.renameSync(acceptedPath, quarantinePath);
  scavengeRestartTelemetry(path.dirname(acceptedPath), false);
  return quarantinePath;
}

const MAX_RESTART_QUARANTINES = 16;
const MAX_SCAVENGE_REMOVALS = 64;

function scavengeRestartTelemetry(sessionDir: string, includePublishOrphans = true): void {
  const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  const publishPrefix = `.${LEGACY_ADOPTION_EXECUTOR_RESTART_FILE}.`;
  const publishOrphans = includePublishOrphans
    ? entries.filter((entry) => entry.isFile()
      && entry.name.startsWith(publishPrefix) && entry.name.endsWith('.publish'))
    : [];
  for (const entry of publishOrphans.slice(0, MAX_SCAVENGE_REMOVALS)) {
    fs.rmSync(path.join(sessionDir, entry.name), { force: true });
  }
  const quarantines = entries.filter((entry) => entry.isFile()
    && entry.name.startsWith(LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_QUARANTINE_PREFIX))
    .map((entry) => ({ entry, modified: fs.statSync(path.join(sessionDir, entry.name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  for (const { entry } of quarantines.slice(MAX_RESTART_QUARANTINES, MAX_RESTART_QUARANTINES + MAX_SCAVENGE_REMOVALS)) {
    fs.rmSync(path.join(sessionDir, entry.name), { force: true });
  }
}

function acceptedSuccessorStatusMatches(
  status: LegacyAdoptionExecutorStatus | null,
  accepted: LegacyAdoptionExecutorRestartAccepted,
): boolean {
  return Boolean(status && accepted.successor_identity && status.status === 'supervising'
    && status.session_id === accepted.session_id
    && status.owner_nonce === accepted.owner_nonce
    && status.executor_spec_sha256 === accepted.executor_spec_sha256
    && status.executor_identity?.fingerprint === accepted.successor_identity.fingerprint
    && status.executor_generation === accepted.successor_generation
    && status.executor_started_at === accepted.successor_started_at
    && status.replacement_count === accepted.baseline_replacement_count + 1
    && status.last_restart_request_id === accepted.request.request_id);
}

function authenticatedManagerArgs(spec: LegacyAdoptionExecutorSpec): string[] {
  const args = [path.resolve(fileURLToPath(new URL('../bin/legacy-adoption-executor-supervisor.js', import.meta.url))),
    '--session-dir', spec.sessionDir, '--source-runtime-root', spec.sourceRuntimeRoot,
    '--target-runtime-root', spec.targetRuntimeRoot];
  if (spec.validationSessionDir) args.push('--validation-session', spec.validationSessionDir);
  if (spec.ownerNonce) args.push('--owner-nonce', spec.ownerNonce);
  return args;
}

interface PersistedSupervisorOwnerAuthority {
  schema_version: 1;
  session_id: string;
  status: 'booting' | 'ready' | 'terminal';
  binding: TmuxRunnerBinding;
  supervisor_identity_fingerprint: string | null;
  supervisor_generation: number;
  launch_nonce: string;
  executor_spec_sha256: string;
}

export function readAuthenticatedLegacyAdoptionExecutorStatus(
  spec: Omit<LegacyAdoptionExecutorSpec, 'ownerNonce'>,
): LegacyAdoptionExecutorStatus | null {
  const sessionDir = fs.realpathSync(spec.sessionDir);
  const status = readLegacyAdoptionExecutorStatus(sessionDir);
  const owner = readJsonFile<PersistedSupervisorOwnerAuthority>(
    path.join(sessionDir, 'legacy-session-adoption-supervisor-owner.json'), null,
  );
  if (!status || status.status !== 'supervising' || !status.executor_identity || !owner
    || owner.schema_version !== 1 || owner.session_id !== path.basename(sessionDir) || owner.status !== 'ready'
    || !owner.launch_nonce || owner.launch_nonce !== status.owner_nonce
    || !Number.isInteger(owner.supervisor_generation) || owner.supervisor_generation < 1
    || status.manager_generation < owner.supervisor_generation
    || (status.manager_generation === owner.supervisor_generation
      && owner.supervisor_identity_fingerprint !== status.manager_identity.fingerprint)
    || status.executor_spec_sha256 !== owner.executor_spec_sha256
    || status.executor_spec_sha256 !== legacyAdoptionExecutorSpecHash({ ...spec, sessionDir, ownerNonce: owner.launch_nonce })
    || status.manager_parent_pid !== owner.binding.pane_pid
    || inspectProcessLivenessIdentity(status.manager_identity) !== 'matched'
    || inspectProcessLivenessIdentity(status.executor_identity) !== 'matched'
    || !tmuxSessionExists(owner.binding.session_name)) return null;
  const liveBinding = readTmuxRunnerBinding(owner.binding.pane_id);
  if (!liveBinding || JSON.stringify(liveBinding) !== JSON.stringify(owner.binding)) return null;
  const managerArgs = [process.execPath, ...authenticatedManagerArgs({
    ...spec, sessionDir, ownerNonce: owner.launch_nonce,
  })];
  const executor = [process.execPath, ...legacyAdoptionExecutorArgs({
    ...spec, sessionDir, ownerNonce: owner.launch_nonce,
  })];
  if (status.manager_argv_sha256 !== crypto.createHash('sha256').update(JSON.stringify(managerArgs)).digest('hex')
    || !exactArgv(processArgv(status.manager_identity.pid), managerArgs)
    || !exactArgv(processArgv(status.executor_identity.pid), executor)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(sessionDir, `${LEGACY_ADOPTION_EXECUTOR_FILE}.lock`), 'utf8')) as Record<string, unknown>;
    if (lock.pid !== status.manager_identity.pid) return null;
  } catch {
    return null;
  }
  return status;
}

export function requestLegacyAdoptionExecutorRestart(
  sessionDir: string,
  reason: string,
  authenticatedStatus: LegacyAdoptionExecutorStatus,
): LegacyAdoptionExecutorRestartRequest {
  const status = readLegacyAdoptionExecutorStatus(sessionDir);
  if (!status?.executor_identity || status.status !== 'supervising'
    || authenticatedStatus.status !== 'supervising'
    || authenticatedStatus.executor_identity?.fingerprint !== status.executor_identity.fingerprint
    || authenticatedStatus.executor_generation !== status.executor_generation
    || authenticatedStatus.manager_identity.fingerprint !== status.manager_identity.fingerprint
    || authenticatedStatus.manager_generation !== status.manager_generation
    || authenticatedStatus.owner_nonce !== status.owner_nonce
    || authenticatedStatus.executor_spec_sha256 !== status.executor_spec_sha256) {
    throw new Error('Legacy adoption executor restart requires an authenticated supervising executor.');
  }
  const existing = readJsonFile<LegacyAdoptionExecutorRestartRequest>(
    path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), null,
  );
  if (existing) {
    if (existing.schema_version === 1 && typeof existing.request_id === 'string' && existing.request_id.length > 0
      && existing.expected_generation === status.executor_generation
      && existing.expected_executor_fingerprint === status.executor_identity.fingerprint
      && typeof existing.reason === 'string' && existing.reason.length > 0
      && typeof existing.requested_at === 'string' && Number.isFinite(Date.parse(existing.requested_at))) return existing;
    throw new Error('Conflicting legacy adoption executor restart request is already published.');
  }
  const request = prepareLegacyAdoptionExecutorRestart(status, reason);
  return publishLegacyAdoptionExecutorRestart(sessionDir, request, authenticatedStatus);
}

export function prepareLegacyAdoptionExecutorRestart(
  status: LegacyAdoptionExecutorStatus,
  reason: string,
  options: { requestId?: string; requestedAt?: string } = {},
): LegacyAdoptionExecutorRestartRequest {
  if (!status.executor_identity || status.status !== 'supervising') {
    throw new Error('Legacy adoption executor restart requires a supervising executor identity.');
  }
  return {
    schema_version: 1,
    request_id: options.requestId || crypto.randomUUID(),
    expected_generation: status.executor_generation,
    expected_executor_fingerprint: status.executor_identity.fingerprint,
    reason: String(reason || 'strategy-requested restart'),
    requested_at: options.requestedAt || new Date().toISOString(),
  };
}

function createJsonFileIfAbsent(filePath: string, value: unknown): boolean {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.publish`);
  let temporaryCreated = false;
  try {
    const descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    temporaryCreated = true;
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || '')) {
        let targetCreated = false;
        try {
          const targetDescriptor = fs.openSync(
            filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600,
          );
          targetCreated = true;
          try {
            fs.writeFileSync(targetDescriptor, `${JSON.stringify(value, null, 2)}\n`);
            fs.fsyncSync(targetDescriptor);
          } finally {
            fs.closeSync(targetDescriptor);
          }
          return true;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return false;
          if (targetCreated) fs.rmSync(filePath, { force: true });
          throw fallbackError;
        }
      }
      throw error;
    }
    try {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch {
      // Some filesystems do not permit directory fsync; the linked file itself is already durable.
    }
    return true;
  } finally {
    if (temporaryCreated) fs.rmSync(temporaryPath, { force: true });
  }
}

export function publishLegacyAdoptionExecutorRestart(
  sessionDir: string,
  request: LegacyAdoptionExecutorRestartRequest,
  authenticatedStatus: LegacyAdoptionExecutorStatus,
): LegacyAdoptionExecutorRestartRequest {
  const restartPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE);
  const publicationLockPath = `${restartPath}.publication`;
  const publicationLock = new StateManager({ acquireTimeoutMs: 30_000, staleLockThresholdMs: 30_000 });
  publicationLock.acquireLock(publicationLockPath);
  try {
    scavengeRestartTelemetry(sessionDir);
    const durableState = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'state.json'), null);
    if (durableState?.cancel_requested_at || durableState?.cancelled === true || durableState?.active === false) {
      throw new Error('Cancelled legacy adoption cannot publish an executor restart request.');
    }
    const existing = readJsonFile<LegacyAdoptionExecutorRestartRequest>(restartPath, null);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(request)) return existing;
      throw new Error('Conflicting legacy adoption executor restart request is already published.');
    }
    const status = readLegacyAdoptionExecutorStatus(sessionDir);
    if (!status?.executor_identity || status.status !== 'supervising'
      || status.executor_generation !== request.expected_generation
      || status.executor_identity.fingerprint !== request.expected_executor_fingerprint) {
      throw new Error('Legacy adoption executor restart request lost its exact supervisor fence.');
    }
    if (authenticatedStatus.status !== 'supervising'
      || authenticatedStatus.executor_generation !== status.executor_generation
      || authenticatedStatus.executor_identity?.fingerprint !== status.executor_identity.fingerprint
      || authenticatedStatus.manager_generation !== status.manager_generation
      || authenticatedStatus.manager_identity.fingerprint !== status.manager_identity.fingerprint
      || authenticatedStatus.owner_nonce !== status.owner_nonce
      || authenticatedStatus.executor_spec_sha256 !== status.executor_spec_sha256) {
      throw new Error('Legacy adoption executor restart request lost its authenticated supervisor CAS.');
    }
    if (!createJsonFileIfAbsent(restartPath, request)) {
      const raced = readJsonFile<LegacyAdoptionExecutorRestartRequest>(restartPath, null);
      if (raced && canonicalJson(raced) === canonicalJson(request)) return raced;
      throw new Error('Conflicting legacy adoption executor restart request won atomic publication.');
    }
    return request;
  } finally {
    publicationLock.releaseLock(publicationLockPath);
  }
}

export function runLegacyAdoptionExecutorSupervisor(
  spec: LegacyAdoptionExecutorSpec,
  deps: Dependencies = {},
): LegacyAdoptionExecutorStatus {
  const sessionDir = fs.realpathSync(spec.sessionDir);
  const statusPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_FILE);
  const manager = new StateManager({ acquireTimeoutMs: 1_000, staleLockThresholdMs: 0 });
  manager.acquireLock(statusPath);
  try {
    const now = deps.now || Date.now;
    const wait = deps.wait || ((milliseconds: number) => Atomics.wait(waitBuffer, 0, 0, milliseconds));
    const inspect = deps.inspect || inspectProcessLivenessIdentity;
    const capture = deps.capture || captureProcessLivenessIdentity;
    const reap = deps.reap || reapRecordedLiveProcessGroup;
    const leaseMs = Math.max(1_000, deps.leaseMs ?? 30_000);
    const pollMs = Math.max(10, Math.min(leaseMs / 3, deps.pollMs ?? 1_000));
    const managerIdentity = deps.managerIdentity || capture(process.pid);
    if (!managerIdentity) throw new Error('Could not capture immutable adoption supervisor identity.');
    const hash = legacyAdoptionExecutorSpecHash({ ...spec, sessionDir });
    scavengeRestartTelemetry(sessionDir, false);
    const managerArgvSha256 = crypto.createHash('sha256').update(JSON.stringify(process.argv)).digest('hex');
    const managerParentPid = parentPid(process.pid);
    let prior = readJsonFile<LegacyAdoptionExecutorStatus>(statusPath, null);
    let ownerGenerationRebind = false;
    if (prior && (prior.schema_version !== 1 || prior.session_id !== path.basename(sessionDir))) {
      throw new Error('Persisted adoption executor supervision contract is invalid.');
    }
    if (prior && prior.executor_spec_sha256 !== hash) {
      const priorOwnerHash = prior.owner_nonce && prior.owner_nonce !== (spec.ownerNonce || '')
        ? legacyAdoptionExecutorSpecHash({ ...spec, sessionDir, ownerNonce: prior.owner_nonce }) : '';
      const priorManagerState = prior.manager_identity ? inspect(prior.manager_identity) : 'not-running';
      if (!priorOwnerHash || prior.executor_spec_sha256 !== priorOwnerHash || priorManagerState === 'matched') {
        throw new Error('Persisted adoption executor supervision contract is invalid.');
      }
      ownerGenerationRebind = true;
    }
    let executor = prior?.executor_identity || null;
    const managerGeneration = (prior?.manager_generation || 0)
      + (prior?.manager_identity?.fingerprint === managerIdentity.fingerprint ? 0 : 1);
    let generation = prior?.executor_generation || 0;
    let replacements = prior?.replacement_count || 0;
    let lastLossAt = prior?.last_loss_at || null;
    let lastRestartRequestId = prior?.last_restart_request_id || null;
    const acceptedPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_ACCEPTED_FILE);
    let accepted = readJsonFile<LegacyAdoptionExecutorRestartAccepted>(acceptedPath, null);
    const assertAcceptedWal = (): void => {
      if (!accepted) return;
      const persisted = readJsonFile<LegacyAdoptionExecutorRestartAccepted>(acceptedPath, null);
      const externalRequest = readJsonFile<LegacyAdoptionExecutorRestartRequest>(
        path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), null,
      );
      if (!persisted || !validAcceptedRestart(persisted, sessionDir, hash, spec.ownerNonce || '')
        || canonicalJson(persisted) !== canonicalJson(accepted)
        || (accepted.stage !== 'committed'
          && (!externalRequest || canonicalJson(externalRequest) !== canonicalJson(accepted.request)))) {
        const quarantinePath = fs.existsSync(acceptedPath)
          ? quarantineInvalidAcceptedRestart(acceptedPath) : acceptedPath;
        throw new Error(`Accepted adoption restart WAL failed exact stage verification at ${quarantinePath}.`);
      }
    };
    if (accepted && !validAcceptedRestart(accepted, sessionDir, hash, spec.ownerNonce || '')) {
      const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
      throw new Error(`Persisted adoption executor accepted restart contract is invalid and was quarantined at ${quarantinePath}.`);
    }
    if (accepted && accepted.stage !== 'committed') {
      const externalRequest = readJsonFile<LegacyAdoptionExecutorRestartRequest>(
        path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), null,
      );
      const genesisStatusMatches = accepted.stage !== 'accepted'
        || Boolean(prior && canonicalJson(prior) === canonicalJson(accepted.authenticated_status));
      if (!externalRequest || canonicalJson(externalRequest) !== canonicalJson(accepted.request)
        || !genesisStatusMatches) {
        const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
        throw new Error(`Accepted adoption restart lost its authenticated status/request genesis and was quarantined at ${quarantinePath}.`);
      }
    }
    if (accepted) {
      const predecessorStatusMatches = Boolean(prior
        && canonicalJson(prior) === canonicalJson(accepted.authenticated_status));
      if (accepted.stage === 'accepted' || accepted.stage === 'predecessor_reaped'
        || accepted.stage === 'launch_pending') {
        if (!predecessorStatusMatches) {
          const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
          throw new Error(`Accepted adoption restart pre-successor stage lost its exact predecessor status at ${quarantinePath}.`);
        }
      } else if (accepted.stage === 'successor_captured') {
        const successorLive = Boolean(accepted.successor_identity
          && inspect(accepted.successor_identity) === 'matched');
        if (successorLive) {
          const finder = deps.discoverExecutors || discoverExecutors;
          const exactSuccessor = finder({ ...spec, sessionDir }).some((candidate) => (
            candidate.fingerprint === accepted!.successor_identity!.fingerprint
            && inspect(candidate) === 'matched'
          ));
          if (!exactSuccessor) {
            const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
            throw new Error(`Accepted adoption restart successor is not bound to the exact executor spec at ${quarantinePath}.`);
          }
          if (!acceptedSuccessorStatusMatches(prior, accepted)) {
            if (!predecessorStatusMatches) {
              const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
              throw new Error(`Accepted adoption restart successor lost both exact status projections at ${quarantinePath}.`);
            }
            const timestamp = new Date(now()).toISOString();
            const recoveredStatus: LegacyAdoptionExecutorStatus = {
              schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
              manager_identity: managerIdentity, manager_generation: managerGeneration,
              manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
              owner_nonce: spec.ownerNonce || '', executor_identity: accepted.successor_identity,
              executor_generation: accepted.successor_generation!,
              executor_started_at: accepted.successor_started_at,
              executor_lease_expires_at: new Date(now() + leaseMs).toISOString(), executor_spec_sha256: hash,
              replacement_count: accepted.baseline_replacement_count + 1,
              last_loss_at: accepted.predecessor_reaped_at,
              last_restart_request_id: accepted.request.request_id, updated_at: timestamp,
            };
            atomicWriteJson(statusPath, recoveredStatus);
            prior = recoveredStatus;
            executor = recoveredStatus.executor_identity;
            generation = recoveredStatus.executor_generation;
            replacements = recoveredStatus.replacement_count;
            lastLossAt = recoveredStatus.last_loss_at;
            lastRestartRequestId = recoveredStatus.last_restart_request_id;
          }
        } else if (!predecessorStatusMatches && !acceptedSuccessorStatusMatches(prior, accepted)) {
          const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
          throw new Error(`Dead adoption restart successor lost its exact durable status projection at ${quarantinePath}.`);
        }
      } else if (!acceptedSuccessorStatusMatches(prior, accepted)) {
        const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
        throw new Error(`Committed adoption restart lost its exact successor status at ${quarantinePath}.`);
      }
    }
    const priorLeaseLive = prior?.executor_lease_expires_at
      && Date.parse(prior.executor_lease_expires_at) > now();
    if (!accepted && executor && (ownerGenerationRebind || !priorLeaseLive || inspect(executor) !== 'matched')) {
      const executorState = inspect(executor);
      if (executorState === 'matched') reapExecutor(executor, reap);
      executor = null;
      replacements += 1;
      lastLossAt = new Date(now()).toISOString();
    }
    for (;;) {
      assertAcceptedWal();
      const outcome = (deps.outcome || defaultOutcome)(sessionDir);
      if (outcome !== 'running') {
        const terminalAccepted = accepted;
        const terminalRestartPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE);
        const terminalPending = readJsonFile<LegacyAdoptionExecutorRestartRequest>(terminalRestartPath, null);
        const terminalCandidates = [executor, terminalAccepted?.predecessor_identity, terminalAccepted?.successor_identity]
          .filter((identity): identity is PersistedProcessIdentity => Boolean(identity));
        const seen = new Set<string>();
        for (const candidate of terminalCandidates) {
          if (seen.has(candidate.fingerprint)) continue;
          seen.add(candidate.fingerprint);
          if (inspect(candidate) === 'matched') reapExecutor(candidate, reap);
        }
        if (terminalAccepted && terminalAccepted.stage !== 'committed') {
          atomicWriteJson(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), {
            ...terminalAccepted.request, rejected_at: new Date(now()).toISOString(),
            rejection_reason: `session became ${outcome} before the accepted restart committed`,
          });
          fs.rmSync(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), { force: true });
          fs.rmSync(acceptedPath, { force: true });
          accepted = null;
        } else if (terminalPending) {
          atomicWriteJson(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), {
            ...terminalPending, rejected_at: new Date(now()).toISOString(),
            rejection_reason: `session became ${outcome} before restart acceptance`,
          });
          fs.rmSync(terminalRestartPath, { force: true });
        }
        const timestamp = new Date(now()).toISOString();
        const predecessorWasReaped = terminalAccepted
          && terminalAccepted.stage !== 'accepted' && terminalAccepted.stage !== 'committed';
        const terminalReplacements = predecessorWasReaped
          ? terminalAccepted.baseline_replacement_count + 1 : replacements;
        const terminalLossAt = predecessorWasReaped ? terminalAccepted.predecessor_reaped_at : lastLossAt;
        const terminal: LegacyAdoptionExecutorStatus = {
          schema_version: 1, session_id: path.basename(sessionDir), status: outcome,
          manager_identity: managerIdentity, manager_generation: managerGeneration,
          manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
          owner_nonce: spec.ownerNonce || '',
          executor_identity: null, executor_generation: generation,
          executor_started_at: null, executor_lease_expires_at: null, executor_spec_sha256: hash,
          replacement_count: terminalReplacements, last_loss_at: terminalLossAt,
          last_restart_request_id: lastRestartRequestId, updated_at: timestamp,
        };
        atomicWriteJson(statusPath, terminal);
        return terminal;
      }
      if (accepted?.stage === 'committed') {
        if (!prior || prior.last_restart_request_id !== accepted.request.request_id
          || prior.executor_generation !== accepted.successor_generation
          || prior.executor_identity?.fingerprint !== accepted.successor_identity?.fingerprint) {
          const quarantinePath = quarantineInvalidAcceptedRestart(acceptedPath);
          throw new Error(`Committed adoption restart receipt conflicts with executor status and was quarantined at ${quarantinePath}.`);
        } else {
          executor = prior.executor_identity;
          generation = prior.executor_generation;
          replacements = prior.replacement_count;
          lastLossAt = prior.last_loss_at;
          lastRestartRequestId = prior.last_restart_request_id;
          fs.rmSync(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), { force: true });
        }
      }
      if (accepted?.stage === 'accepted') {
        if ((deps.outcome || defaultOutcome)(sessionDir) !== 'running') continue;
        const predecessorState = inspect(accepted.predecessor_identity);
        if (predecessorState === 'matched') reapExecutor(accepted.predecessor_identity, reap);
        else if (predecessorState === 'reused') {
          throw new Error('Accepted adoption executor restart predecessor identity was reused.');
        }
        deps.checkpoint?.('restart_predecessor_stopped');
        const timestamp = new Date(now()).toISOString();
        accepted = sealAcceptedRestart({ ...accepted, stage: 'predecessor_reaped', predecessor_reaped_at: timestamp });
        atomicWriteJson(acceptedPath, accepted);
        assertAcceptedWal();
        deps.checkpoint?.('restart_predecessor_reap_persisted');
      }
      if (accepted?.stage === 'predecessor_reaped') {
        executor = null;
        generation = accepted.predecessor_generation;
        replacements = accepted.baseline_replacement_count + 1;
        lastLossAt = accepted.predecessor_reaped_at;
        lastRestartRequestId = accepted.request.request_id;
        const timestamp = new Date(now()).toISOString();
        accepted = sealAcceptedRestart({
          ...accepted, stage: 'launch_pending', launch_manager_fingerprint: managerIdentity.fingerprint,
          launch_started_at: timestamp,
        });
        atomicWriteJson(acceptedPath, accepted);
        assertAcceptedWal();
        deps.checkpoint?.('restart_launch_persisted');
      }
      if (accepted?.stage === 'launch_pending') {
        if ((deps.outcome || defaultOutcome)(sessionDir) !== 'running') continue;
        const finder = deps.discoverExecutors || discoverExecutors;
        const candidates = finder({ ...spec, sessionDir })
          .filter((candidate) => candidate.fingerprint !== accepted!.predecessor_identity.fingerprint
            && inspect(candidate) === 'matched');
        if (candidates.length > 1) throw new Error('Multiple adoption executor restart successors matched the launch fence.');
        let successor: PersistedProcessIdentity | null = candidates[0] || null;
        if (!successor && accepted.launch_manager_fingerprint !== managerIdentity.fingerprint
          && Date.parse(accepted.launch_started_at || '') + (deps.launchRecoveryMs ?? 5_000) > now()) {
          wait(pollMs);
          continue;
        }
        if (!successor) {
          const pid = (deps.spawnExecutor || spawnExecutor)({ ...spec, sessionDir });
          const captured = capture(pid);
          if (!captured) throw new Error(`Could not capture immutable adoption executor identity for pid ${pid}.`);
          successor = captured;
        }
        deps.checkpoint?.('restart_successor_started');
        const timestamp = new Date(now()).toISOString();
        accepted = sealAcceptedRestart({
          ...accepted, stage: 'successor_captured', successor_identity: successor,
          successor_generation: accepted.predecessor_generation + 1, successor_started_at: timestamp,
        });
        atomicWriteJson(acceptedPath, accepted);
        assertAcceptedWal();
        deps.checkpoint?.('restart_successor_persisted');
      }
      if (accepted?.stage === 'successor_captured') {
        if (!accepted.successor_identity || inspect(accepted.successor_identity) !== 'matched') {
          const timestamp = new Date(now()).toISOString();
          accepted = sealAcceptedRestart({
            ...accepted,
            stage: 'launch_pending',
            launch_manager_fingerprint: managerIdentity.fingerprint,
            launch_started_at: timestamp,
            successor_identity: null,
            successor_generation: null,
            successor_started_at: null,
          });
          atomicWriteJson(acceptedPath, accepted);
          assertAcceptedWal();
          atomicWriteJson(statusPath, accepted.authenticated_status);
          prior = accepted.authenticated_status;
          executor = null;
          generation = accepted.predecessor_generation;
          deps.checkpoint?.('restart_dead_successor_requeued');
          continue;
        }
        executor = accepted.successor_identity;
        generation = accepted.successor_generation!;
        replacements = accepted.baseline_replacement_count + 1;
        lastLossAt = accepted.predecessor_reaped_at;
        lastRestartRequestId = accepted.request.request_id;
        const timestamp = new Date(now()).toISOString();
        const status: LegacyAdoptionExecutorStatus = {
          schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
          manager_identity: managerIdentity, manager_generation: managerGeneration,
          manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
          owner_nonce: spec.ownerNonce || '', executor_identity: executor, executor_generation: generation,
          executor_started_at: accepted.successor_started_at,
          executor_lease_expires_at: new Date(now() + leaseMs).toISOString(), executor_spec_sha256: hash,
          replacement_count: replacements, last_loss_at: lastLossAt,
          last_restart_request_id: lastRestartRequestId, updated_at: timestamp,
        };
        atomicWriteJson(statusPath, status);
        prior = status;
        deps.checkpoint?.('restart_status_committed');
        accepted = sealAcceptedRestart({ ...accepted, stage: 'committed', committed_at: timestamp });
        atomicWriteJson(acceptedPath, accepted);
        assertAcceptedWal();
        fs.rmSync(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE), { force: true });
        deps.checkpoint?.('restart_cleanup_committed');
        accepted = null;
      }
      if (!executor) {
        const pid = (deps.spawnExecutor || spawnExecutor)({ ...spec, sessionDir });
        executor = capture(pid);
        if (!executor) throw new Error(`Could not capture immutable adoption executor identity for pid ${pid}.`);
        generation += 1;
      }
      if (inspect(executor) !== 'matched') {
        executor = null;
        replacements += 1;
        lastLossAt = new Date(now()).toISOString();
        continue;
      }
      const restartPath = path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_FILE);
      const restart = readJsonFile<LegacyAdoptionExecutorRestartRequest>(restartPath, null);
      if (restart) {
        if (restart.schema_version !== 1 || !restart.request_id
          || restart.expected_generation !== generation
          || restart.expected_executor_fingerprint !== executor.fingerprint) {
          atomicWriteJson(path.join(sessionDir, LEGACY_ADOPTION_EXECUTOR_RESTART_REJECTED_FILE), {
            ...restart, rejected_at: new Date(now()).toISOString(),
            rejection_reason: 'request does not match the authenticated executor generation and fingerprint',
          });
          fs.rmSync(restartPath, { force: true });
        } else {
          const timestamp = new Date(now()).toISOString();
          if (accepted?.stage === 'committed') accepted = null;
          if (!prior || prior.status !== 'supervising' || !prior.executor_identity
            || prior.executor_generation !== generation
            || prior.executor_identity.fingerprint !== executor.fingerprint
            || prior.owner_nonce !== (spec.ownerNonce || '')
            || prior.executor_spec_sha256 !== hash) {
            throw new Error('Restart request cannot be accepted without an exact authenticated persisted executor status.');
          }
          accepted = sealAcceptedRestart({
            schema_version: 1, session_id: path.basename(sessionDir), stage: 'accepted', request: restart,
            authenticated_status: prior,
            executor_spec_sha256: hash, owner_nonce: spec.ownerNonce || '',
            predecessor_identity: executor, predecessor_generation: generation,
            baseline_replacement_count: replacements, accepted_at: timestamp, predecessor_reaped_at: null,
            launch_manager_fingerprint: null, launch_started_at: null, successor_identity: null,
            successor_generation: null, successor_started_at: null, committed_at: null,
            integrity_chain: [],
          });
          atomicWriteJson(acceptedPath, accepted);
          assertAcceptedWal();
          deps.checkpoint?.('restart_accepted');
          continue;
        }
      }
      const timestamp = new Date(now()).toISOString();
      const status: LegacyAdoptionExecutorStatus = {
        schema_version: 1, session_id: path.basename(sessionDir), status: 'supervising',
        manager_identity: managerIdentity, manager_generation: managerGeneration,
        manager_parent_pid: managerParentPid, manager_argv_sha256: managerArgvSha256,
        owner_nonce: spec.ownerNonce || '',
        executor_identity: executor, executor_generation: generation,
        executor_started_at: prior?.executor_identity?.fingerprint === executor.fingerprint
          ? prior.executor_started_at : timestamp,
        executor_lease_expires_at: new Date(now() + leaseMs).toISOString(), executor_spec_sha256: hash,
        replacement_count: replacements, last_loss_at: lastLossAt, updated_at: timestamp,
        last_restart_request_id: lastRestartRequestId,
      };
      atomicWriteJson(statusPath, status);
      prior = status;
      deps.onIteration?.(status);
      wait(pollMs);
    }
  } finally {
    manager.releaseLock(statusPath);
  }
}
