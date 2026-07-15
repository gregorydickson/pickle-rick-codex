import fs from 'node:fs';
import path from 'node:path';
import { nowIso, atomicWriteJson, STATE_SCHEMA_VERSION } from './pickle-utils.js';
import { StateManager, type PersistedState } from './state-manager.js';
import {
  buildPipelineStateMirror,
  PIPELINE_SCHEMA_VERSION,
  hasPipelineContract,
  readPipelineContract,
  resolveNextPipelinePhase,
  validatePipelineContract,
} from './pipeline.js';
import type {
  BeginPipelinePhaseOptions,
  BuildVerificationFailureSetArgs,
  CancelPipelineSessionOptions,
  FinishPipelinePhaseOptions,
  PipelineContract,
  PipelinePhase,
  PipelinePhaseStatus,
  PipelineState,
  PipelineStateMutator,
  PipelineStateOptions,
  ReadTicketVerificationBaselineOptions,
  TransitionPipelineStateResult,
  VerificationBaselineCommandMap,
  VerificationBaselineEntry,
  VerificationBaselines,
  VerificationCommandScope,
  VerificationFailure,
  VerificationScopeKind,
  WritePipelineStateOptions,
  WriteVerificationBaselinesOptions,
} from '../types/index.js';

const PHASE_STATUS_TODO: PipelinePhaseStatus = 'todo';
const PHASE_STATUS_RUNNING: PipelinePhaseStatus = 'running';
const PHASE_STATUS_DONE: PipelinePhaseStatus = 'done';
const PHASE_STATUS_CANCELLED: PipelinePhaseStatus = 'cancelled';
const PHASE_STATUS_FAILED: PipelinePhaseStatus = 'failed';

const PIPELINE_PHASE_STATUSES = new Set<PipelinePhaseStatus>([
  PHASE_STATUS_TODO,
  PHASE_STATUS_RUNNING,
  PHASE_STATUS_DONE,
  PHASE_STATUS_CANCELLED,
  PHASE_STATUS_FAILED,
]);

const VERIFICATION_BASELINE_SCHEMA_VERSION = 1;

export class PipelineStateError extends Error {
  code: string;
  constructor(message: string, code: string = 'PIPELINE_STATE_INVALID') {
    super(message);
    this.name = 'PipelineStateError';
    this.code = code;
  }
}

export function getPipelineStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'pipeline-state.json');
}

function getSessionStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'state.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildPhaseStatuses(phases: PipelinePhase[]): Record<string, PipelinePhaseStatus> {
  return Object.fromEntries(phases.map((phase) => [phase, PHASE_STATUS_TODO]));
}

function phaseIndex(phases: readonly PipelinePhase[], phase: PipelinePhase): number {
  return phases.indexOf(phase);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function stripAnsi(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

interface RewrittenVitestCommand {
  commandCwd: string;
  runIndex: number;
}

function resolveRewrittenVitestCommand(tokens: string[], cwd: string): RewrittenVitestCommand | null {
  if (!Array.isArray(tokens) || tokens.length < 6 || tokens[0] !== 'cd' || tokens[2] !== '&&') {
    return null;
  }

  const commandCwd = path.resolve(cwd || process.cwd(), tokens[1]);
  const vitestIndex = tokens.findIndex((token, index) => index >= 3 && /(?:^|[\\/])vitest(?:\.mjs)?$/.test(token));
  if (vitestIndex === -1) {
    return null;
  }

  const runIndex = tokens.findIndex((token, index) => index > vitestIndex && ['run', 'watch', 'dev'].includes(token));
  if (runIndex === -1) {
    return null;
  }

  return { commandCwd, runIndex };
}

function packageManagerCommandCwd(tokens: string[], cwd: string): string {
  let commandCwd = cwd || process.cwd();
  let pnpmFilter = '';
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'test') break;
    if ((token === '--filter' || token === '-F') && tokens[index + 1]) {
      pnpmFilter = tokens[index + 1];
      index += 1;
      continue;
    }
    const inlineFilterMatch = token.match(/^(?:--filter|-F)=(.+)$/);
    if (inlineFilterMatch) {
      pnpmFilter = inlineFilterMatch[1];
      continue;
    }
    if ((token === '-C' || token === '--dir' || token === '--cwd' || token === '--prefix') && tokens[index + 1]) {
      commandCwd = path.resolve(commandCwd, tokens[index + 1]);
      index += 1;
      continue;
    }
    const inlineMatch = token.match(/^(?:--dir|--cwd|--prefix)=(.+)$/);
    if (inlineMatch) {
      commandCwd = path.resolve(commandCwd, inlineMatch[1]);
    }
  }
  if (tokens[0] === 'pnpm') {
    const filteredPackageDir = resolvePnpmFilterPackageDir(commandCwd, pnpmFilter);
    if (filteredPackageDir) {
      return filteredPackageDir;
    }
  }
  return commandCwd;
}

function normalizePnpmFilterSelector(value: unknown): string {
  let normalized = String(value || '').trim();
  if (!normalized) return '';
  normalized = normalized.replace(/^!+/, '');
  normalized = normalized.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').replace(/\^\.\.\.$/, '');
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function readPackageName(packageDir: string): string {
  try {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return '';
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const name = (parsed as Record<string, unknown> | null)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : '';
  } catch {
    return '';
  }
}

function findWorkspacePackageDirByName(rootDir: string, packageName: string): string | null {
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift() as string;
    if (readPackageName(currentDir) === packageName) {
      return currentDir;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      queue.push(path.join(currentDir, entry.name));
    }
  }

  return null;
}

function resolvePnpmFilterPackageDir(cwd: string, selector: string): string | null {
  const normalized = normalizePnpmFilterSelector(selector);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('.') || normalized.startsWith('/')) {
    return path.resolve(cwd, normalized);
  }

  return findWorkspacePackageDirByName(cwd, normalized);
}

function resolveVerificationCommandCwd(tokens: string[], cwd: string): string {
  const rewrittenVitest = resolveRewrittenVitestCommand(tokens, cwd);
  if (rewrittenVitest) {
    return rewrittenVitest.commandCwd;
  }
  return packageManagerCommandCwd(tokens, cwd);
}

function extractPackageManagerTestTargets(tokens: string[], cwd: string): string[] {
  const packageManager = tokens[0];
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(packageManager)) {
    return [];
  }

  const testIndex = tokens.indexOf('test');
  const separatorIndex = tokens.indexOf('--');
  if (testIndex === -1 || separatorIndex === -1 || separatorIndex <= testIndex) {
    return [];
  }

  const commandCwd = packageManagerCommandCwd(tokens, cwd);
  const targets: string[] = [];
  for (let index = separatorIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === '&&' || token.startsWith('-')) continue;
    const comparableTarget = path.isAbsolute(token)
      ? normalizeComparablePath(token, cwd)
      : normalizeComparablePath(path.resolve(commandCwd, token), cwd);
    if (comparableTarget) {
      targets.push(comparableTarget);
    }
  }
  return targets.filter(Boolean);
}

function extractRewrittenVitestTargets(tokens: string[], cwd: string): string[] {
  const rewrittenVitest = resolveRewrittenVitestCommand(tokens, cwd);
  if (!rewrittenVitest) {
    return [];
  }

  const flagsWithValues = new Set([
    '--api',
    '--browser',
    '--changed',
    '--config',
    '--coverage.provider',
    '--dir',
    '--dom',
    '--environment',
    '--outputFile',
    '--pool',
    '--project',
    '--reporter',
    '--root',
    '--sequence.shuffle.files',
    '--sequence.shuffle.tests',
    '--testNamePattern',
  ]);

  const targets: string[] = [];
  for (let index = rewrittenVitest.runIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === '&&') continue;
    if (flagsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('--') || token.startsWith('-')) {
      continue;
    }
    const normalized = normalizeComparablePath(path.resolve(rewrittenVitest.commandCwd, token), cwd);
    if (normalized) {
      targets.push(normalized);
    }
  }

  return targets.filter(Boolean);
}

function normalizeComparablePath(filePath: string, cwd: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const absolute = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  const relative = path.relative(cwd || process.cwd(), absolute).replaceAll(path.sep, '/');
  if (!relative || relative === '') return absolute.replaceAll(path.sep, '/');
  if (!relative.startsWith('../')) return relative;
  return absolute.replaceAll(path.sep, '/');
}

interface RawFailure {
  identity?: unknown;
  file?: unknown;
  testName?: unknown;
  in_scope?: unknown;
  source?: unknown;
}

function uniqueFailures(failures: RawFailure[]): VerificationFailure[] {
  const seen = new Set<string>();
  const unique: VerificationFailure[] = [];
  for (const failure of failures) {
    const identity = String(failure?.identity || '').trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    unique.push({
      identity,
      file: (failure?.file as string | null) ?? null,
      testName: (failure?.testName as string | null) ?? null,
      in_scope: failure?.in_scope === true,
      source: (failure?.source as string) || 'unknown',
    });
  }
  return unique;
}

function isPathWithinVerificationScope(filePath: string | null, scope: VerificationCommandScope): boolean {
  if (!filePath || !Array.isArray(scope?.targets) || scope.targets.length === 0) {
    return false;
  }
  return scope.targets.some((target) => filePath === target || filePath.startsWith(`${target}/`));
}

function normalizeFailurePath(filePath: string, cwd: string, commandCwd: string = cwd): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return '';
  }
  if (path.isAbsolute(filePath)) {
    return normalizeComparablePath(filePath, cwd);
  }
  return normalizeComparablePath(path.resolve(commandCwd || cwd || process.cwd(), filePath), cwd);
}

function parseNodeTestFailures(
  output: string,
  cwd: string,
  scope: VerificationCommandScope,
  commandCwd: string = cwd,
): VerificationFailure[] {
  const lines = String(output || '').split(/\r?\n/);
  const failures: VerificationFailure[] = [];
  let inFailuresSection = false;
  let pendingFile: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inFailuresSection) {
      if (trimmed === '✖ failing tests:' || trimmed === 'failing tests:') {
        inFailuresSection = true;
      }
      continue;
    }

    if (!trimmed) {
      pendingFile = null;
      continue;
    }

    const fileMatch = trimmed.match(/^test at (.+?):\d+:\d+$/);
    if (fileMatch) {
      pendingFile = normalizeFailurePath(fileMatch[1], cwd, commandCwd);
      continue;
    }

    const nameMatch = trimmed.match(/^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/);
    if (pendingFile && nameMatch) {
      const testName = nameMatch[1].trim();
      failures.push({
        identity: `${pendingFile}::${testName}`,
        file: pendingFile,
        testName,
        in_scope: isPathWithinVerificationScope(pendingFile, scope),
        source: 'node-test',
      });
      pendingFile = null;
    }
  }

  return uniqueFailures(failures);
}

function parseVitestFailures(
  output: string,
  cwd: string,
  scope: VerificationCommandScope,
  commandCwd: string = cwd,
): VerificationFailure[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures: VerificationFailure[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^FAIL\s+(.+?)\s+>\s+(.+)$/);
    if (!match) {
      continue;
    }
    const filePath = normalizeFailurePath(match[1], cwd, commandCwd);
    const testName = match[2].trim();
    if (!filePath || !testName) {
      continue;
    }
    failures.push({
      identity: `${filePath}::${testName}`,
      file: filePath,
      testName,
      in_scope: isPathWithinVerificationScope(filePath, scope),
      source: 'vitest',
    });
  }

  return uniqueFailures(failures);
}

export function buildVerificationCommandScope(command: unknown, cwd: string = process.cwd()): VerificationCommandScope {
  const normalizedCommand = String(command || '').trim();
  const tokens = tokenizeShellWords(normalizedCommand);
  const scope: VerificationCommandScope = {
    key: `command:${normalizedCommand}`,
    kind: 'command',
    command: normalizedCommand,
    targets: [],
  };

  if (tokens[0] !== 'node' || !tokens.includes('--test')) {
    const packageManagerTargets = extractPackageManagerTestTargets(tokens, cwd);
    if (packageManagerTargets.length > 0) {
      return {
        key: `package-test:${packageManagerTargets.join('|')}`,
        kind: 'package-test',
        command: normalizedCommand,
        targets: packageManagerTargets,
      };
    }
    const rewrittenVitestTargets = extractRewrittenVitestTargets(tokens, cwd);
    if (rewrittenVitestTargets.length === 0) {
      return scope;
    }
    return {
      key: `package-test:${rewrittenVitestTargets.join('|')}`,
      kind: 'package-test',
      command: normalizedCommand,
      targets: rewrittenVitestTargets,
    };
  }

  const testIndex = tokens.indexOf('--test');
  const targets: string[] = [];
  for (let index = testIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--test-name-pattern' || token === '--test-reporter' || token === '--test-reporter-destination') {
      index += 1;
      continue;
    }
    if (token.startsWith('--test-name-pattern=')
      || token.startsWith('--test-reporter=')
      || token.startsWith('--test-reporter-destination=')) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    targets.push(normalizeComparablePath(token, cwd));
  }

  if (targets.length === 0) {
    return scope;
  }

  return {
    key: `node-test:${targets.join('|')}`,
    kind: 'node-test',
    command: normalizedCommand,
    targets,
  };
}

export function buildVerificationFailureSet({
  command,
  cwd = process.cwd(),
  stdout = '',
  stderr = '',
  exitCode = 0,
}: BuildVerificationFailureSetArgs): VerificationFailure[] {
  if (exitCode === 0) {
    return [];
  }
  const scope = buildVerificationCommandScope(command, cwd);
  const tokens = tokenizeShellWords(String(command || '').trim());
  const commandCwd = scope.kind === 'package-test'
    ? resolveVerificationCommandCwd(tokens, cwd)
    : cwd;
  const combinedOutput = `${stdout || ''}\n${stderr || ''}`;
  const nodeFailures = parseNodeTestFailures(combinedOutput, cwd, scope, commandCwd);
  if (nodeFailures.length > 0) {
    return nodeFailures;
  }
  const vitestFailures = parseVitestFailures(combinedOutput, cwd, scope, commandCwd);
  if (vitestFailures.length > 0) {
    return vitestFailures;
  }
  return uniqueFailures([{
    identity: `command:${String(command || '').trim()}`,
    file: null,
    testName: null,
    in_scope: true,
    source: 'command-exit',
  }]);
}

function buildStoredVerificationScopeKey(
  kind: VerificationScopeKind | null,
  targets: string[],
  fallbackKey: string,
): string {
  if ((kind === 'node-test' || kind === 'package-test') && Array.isArray(targets) && targets.length > 0) {
    return `${kind}:${targets.join('|')}`;
  }
  return fallbackKey;
}

interface RawBaselineEntry {
  command?: unknown;
  scope?: unknown;
  failures?: unknown;
  [key: string]: unknown;
}

interface RawBaselineScope {
  command?: unknown;
  kind?: unknown;
  targets?: unknown;
  [key: string]: unknown;
}

function normalizeVerificationBaselineCommandMap(
  value: unknown,
  cwd: string = process.cwd(),
): VerificationBaselineCommandMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const entries: VerificationBaselineCommandMap = {};
  for (const [scopeKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as RawBaselineEntry;
    const rawScope = (entry.scope && typeof entry.scope === 'object' && !Array.isArray(entry.scope)
      ? entry.scope
      : {}) as RawBaselineScope;
    const command = typeof entry.command === 'string' && entry.command.trim()
      ? entry.command
      : typeof rawScope.command === 'string' && rawScope.command.trim()
        ? rawScope.command
        : String(scopeKey).replace(/^command:/, '');
    const normalizedScope = buildVerificationCommandScope(command, cwd);
    const failures = uniqueFailures(
      Array.isArray(entry.failures) ? (entry.failures as RawFailure[]) : [],
    );
    const storedTargets = Array.isArray(rawScope.targets)
      ? (rawScope.targets as unknown[]).filter(Boolean) as string[]
      : [];
    const storedKind = typeof rawScope.kind === 'string' ? (rawScope.kind as VerificationScopeKind) : null;
    const normalizedKind: VerificationScopeKind | null = storedKind === 'node-test' || storedKind === 'package-test'
      ? storedKind
      : normalizedScope.kind;
    const normalizedTargets = storedTargets.length > 0 ? storedTargets : normalizedScope.targets;
    const normalizedKey = buildStoredVerificationScopeKey(normalizedKind, normalizedTargets, normalizedScope.key);
    const normalizedEntry: VerificationBaselineEntry = {
      command: command || normalizedScope.command,
      scope: {
        key: normalizedKey,
        kind: normalizedKind ?? 'command',
        command: command || normalizedScope.command,
        targets: normalizedTargets,
      },
      failures,
    };
    if (!entries[normalizedKey] || scopeKey === normalizedKey) {
      entries[normalizedKey] = normalizedEntry;
    }
  }
  return entries;
}

interface RawVerificationBaselines {
  schema_version?: unknown;
  captured_at?: unknown;
  by_ticket?: unknown;
  [key: string]: unknown;
}

function normalizeVerificationBaselines(
  value: unknown,
  cwd: string = process.cwd(),
): VerificationBaselines {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      schema_version: VERIFICATION_BASELINE_SCHEMA_VERSION,
      captured_at: null,
      by_ticket: {},
    };
  }

  const raw = value as RawVerificationBaselines;
  const byTicket: Record<string, VerificationBaselineCommandMap> = {};
  const rawByTicket = (raw.by_ticket && typeof raw.by_ticket === 'object' && !Array.isArray(raw.by_ticket))
    ? raw.by_ticket as Record<string, unknown>
    : {};
  for (const [ticketId, ticketBaselines] of Object.entries(rawByTicket)) {
    byTicket[ticketId] = normalizeVerificationBaselineCommandMap(ticketBaselines, cwd);
  }

  return {
    schema_version: Number.isInteger(raw.schema_version)
      ? (raw.schema_version as number)
      : VERIFICATION_BASELINE_SCHEMA_VERSION,
    captured_at: (raw.captured_at as string | null) || null,
    by_ticket: byTicket,
  };
}

function syncPipelineMirror(
  sessionState: PersistedState,
  pipeline: PipelineContract,
  pipelineState: PipelineState,
): PersistedState {
  Object.assign(sessionState, buildPipelineStateMirror(pipeline));
  sessionState.pipeline_mode = true;
  sessionState.pipeline_phase = pipelineState.current_phase ?? null;
  sessionState.pipeline_total_phases = pipeline.phases.length;
  sessionState.pipeline_phase_index = pipelineState.current_phase_index ?? null;
  return sessionState;
}

function appendHistoryEntry(sessionState: PersistedState, step: string, ticket: string | undefined = undefined): void {
  sessionState.history ??= [];
  (sessionState.history as unknown[]).push({
    step,
    ticket,
    timestamp: nowIso(),
  });
}

function clearRuntimeState(sessionState: PersistedState): void {
  sessionState.active = false;
  sessionState.tmux_runner_pid = null;
  sessionState.worker_pid = null;
  sessionState.active_child_pid = null;
  sessionState.active_child_kind = null;
  sessionState.active_child_command = null;
}

function isBlockedExitReason(exitReason: string): boolean {
  return exitReason === 'verification-contract-failed' || String(exitReason).startsWith('preflight-');
}

export function createInitialPipelineState(pipeline: unknown, now: string = nowIso()): PipelineState {
  const contract = validatePipelineContract(pipeline);
  return {
    schema_version: PIPELINE_SCHEMA_VERSION,
    current_phase: resolveNextPipelinePhase(contract, { phase_statuses: buildPhaseStatuses(contract.phases) }),
    current_phase_index: 0,
    phase_statuses: buildPhaseStatuses(contract.phases),
    started_at: now,
    phase_started_at: null,
    completed_at: null,
    last_error: null,
    last_exit_reason: null,
    verification_baselines: normalizeVerificationBaselines(null, contract.working_dir),
  };
}

interface RawPipelineState {
  schema_version?: unknown;
  phase_statuses?: unknown;
  current_phase?: unknown;
  started_at?: unknown;
  phase_started_at?: unknown;
  completed_at?: unknown;
  last_error?: unknown;
  last_exit_reason?: unknown;
  verification_baselines?: unknown;
  [key: string]: unknown;
}

export function validatePipelineState(pipeline: unknown, pipelineState: unknown): PipelineState {
  const contract = validatePipelineContract(pipeline);
  if (!isPlainObject(pipelineState)) {
    throw new PipelineStateError('Pipeline state must be a JSON object.');
  }

  const raw = pipelineState as RawPipelineState;
  const phaseStatuses: Record<string, PipelinePhaseStatus> = {};
  const rawPhaseStatuses = (raw.phase_statuses && typeof raw.phase_statuses === 'object' && !Array.isArray(raw.phase_statuses))
    ? raw.phase_statuses as Record<string, unknown>
    : {};
  for (const phase of contract.phases) {
    const status = String(rawPhaseStatuses[phase] || PHASE_STATUS_TODO).trim().toLowerCase() as PipelinePhaseStatus;
    if (!PIPELINE_PHASE_STATUSES.has(status)) {
      throw new PipelineStateError(`Invalid pipeline phase status "${status}" for ${phase}.`);
    }
    phaseStatuses[phase] = status;
  }

  const currentPhase = resolveNextPipelinePhase(contract, { phase_statuses: phaseStatuses });
  if (currentPhase !== null && !contract.phases.includes(currentPhase)) {
    throw new PipelineStateError(`Unknown pipeline current phase "${currentPhase}".`);
  }

  const currentPhaseIndex = currentPhase == null ? null : phaseIndex(contract.phases, currentPhase);
  const schemaVersion = Number.isInteger(raw.schema_version)
    ? (raw.schema_version as number)
    : PIPELINE_SCHEMA_VERSION;
  if (schemaVersion > PIPELINE_SCHEMA_VERSION) {
    throw new PipelineStateError(
      `Pipeline state schema ${schemaVersion} is newer than supported ${PIPELINE_SCHEMA_VERSION}.`,
      'PIPELINE_STATE_SCHEMA_MISMATCH',
    );
  }

  return {
    schema_version: schemaVersion,
    current_phase: currentPhase,
    current_phase_index: currentPhaseIndex,
    phase_statuses: phaseStatuses,
    started_at: (raw.started_at as string) || nowIso(),
    phase_started_at: (raw.phase_started_at as string | null) || null,
    completed_at: (raw.completed_at as string | null) || null,
    last_error: (raw.last_error as string | null) || null,
    last_exit_reason: (raw.last_exit_reason as string | null) || null,
    verification_baselines: normalizeVerificationBaselines(raw.verification_baselines, contract.working_dir),
  };
}

export function readPipelineState(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  pipeline: PipelineContract = readPipelineContract(sessionDir),
): PipelineState {
  const filePath = getPipelineStatePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    throw new PipelineStateError(`Missing pipeline-state.json in ${sessionDir}.`, 'PIPELINE_STATE_MISSING');
  }
  return validatePipelineState(pipeline, stateManager.read(filePath));
}

export function ensurePipelineState(
  sessionDir: string,
  pipeline: PipelineContract = readPipelineContract(sessionDir),
  stateManager: StateManager = new StateManager(),
): PipelineState {
  const filePath = getPipelineStatePath(sessionDir);
  if (!fs.existsSync(filePath)) {
    const initial = createInitialPipelineState(pipeline);
    atomicWriteJson(filePath, initial);
  }
  const pipelineState = readPipelineState(sessionDir, stateManager, pipeline);
  const statePath = getSessionStatePath(sessionDir);
  if (fs.existsSync(statePath)) {
    stateManager.update(statePath, (sessionState) => syncPipelineMirror(sessionState, pipeline, pipelineState));
  }
  return pipelineState;
}

export function writePipelineState(
  sessionDir: string,
  pipelineState: unknown,
  options: WritePipelineStateOptions = {},
): PipelineState {
  const stateManager = options.stateManager || new StateManager();
  const pipeline = options.pipeline || readPipelineContract(sessionDir);
  const normalizedPipelineState = validatePipelineState(pipeline, pipelineState);
  const pipelineStatePath = getPipelineStatePath(sessionDir);
  const statePath = getSessionStatePath(sessionDir);

  if (!fs.existsSync(statePath)) {
    atomicWriteJson(pipelineStatePath, normalizedPipelineState);
    return normalizedPipelineState;
  }

  if (!fs.existsSync(pipelineStatePath)) {
    atomicWriteJson(pipelineStatePath, normalizedPipelineState);
  }

  const orderedPaths = [statePath, pipelineStatePath].sort();
  const sessionStateIndex = orderedPaths.indexOf(statePath);
  const pipelineStateIndex = orderedPaths.indexOf(pipelineStatePath);
  const nextStates = stateManager.transaction(orderedPaths, (states) => {
    const mutableSessionState = clone(states[sessionStateIndex]);
    syncPipelineMirror(mutableSessionState, pipeline, normalizedPipelineState);
    mutableSessionState.schema_version ??= STATE_SCHEMA_VERSION;
    const updated = [...states];
    updated[sessionStateIndex] = mutableSessionState;
    updated[pipelineStateIndex] = normalizedPipelineState as unknown as PersistedState;
    return updated;
  });

  return nextStates[pipelineStateIndex] as unknown as PipelineState;
}

export function isPipelineSession(sessionDir: string): boolean {
  return hasPipelineContract(sessionDir);
}

export function transitionPipelineState(
  sessionDir: string,
  mutator: PipelineStateMutator,
  options: PipelineStateOptions = {},
): TransitionPipelineStateResult {
  const stateManager = options.stateManager || new StateManager();
  const pipeline = options.pipeline || readPipelineContract(sessionDir);
  const statePath = getSessionStatePath(sessionDir);
  const pipelineStatePath = getPipelineStatePath(sessionDir);
  const orderedPaths = [statePath, pipelineStatePath].sort();
  const sessionStateIndex = orderedPaths.indexOf(statePath);
  const pipelineStateIndex = orderedPaths.indexOf(pipelineStatePath);
  ensurePipelineState(sessionDir, pipeline, stateManager);

  const nextStates = stateManager.transaction(
    orderedPaths,
    (states) => {
      const mutableSessionState = clone(states[sessionStateIndex]);
      const mutablePipelineState = validatePipelineState(pipeline, states[pipelineStateIndex]);
      mutator(mutablePipelineState, mutableSessionState, pipeline);
      const normalizedPipelineState = validatePipelineState(pipeline, mutablePipelineState);
      syncPipelineMirror(mutableSessionState, pipeline, normalizedPipelineState);
      mutableSessionState.schema_version ??= STATE_SCHEMA_VERSION;
      const updated = [...states];
      updated[sessionStateIndex] = mutableSessionState;
      updated[pipelineStateIndex] = normalizedPipelineState as unknown as PersistedState;
      return updated;
    },
  );

  return {
    state: nextStates[sessionStateIndex],
    pipelineState: nextStates[pipelineStateIndex] as unknown as PipelineState,
    pipeline,
  };
}

export function beginPipelinePhase(
  sessionDir: string,
  phase: PipelinePhase,
  options: BeginPipelinePhaseOptions = {},
): TransitionPipelineStateResult {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    if (!pipeline.phases.includes(phase)) {
      throw new PipelineStateError(`Unknown pipeline phase "${phase}".`, 'PIPELINE_PHASE_INVALID');
    }
    pipelineState.current_phase = phase;
    pipelineState.current_phase_index = phaseIndex(pipeline.phases, phase);
    pipelineState.phase_statuses[phase] = PHASE_STATUS_RUNNING;
    pipelineState.phase_started_at = options.startedAt || nowIso();
    pipelineState.last_error = null;
    pipelineState.last_exit_reason = null;
    sessionState.pipeline_mode = true;
    sessionState.step = phase;
    appendHistoryEntry(sessionState, phase, (sessionState.current_ticket as string | null) || undefined);
  }, options);
}

export function finishPipelinePhase(
  sessionDir: string,
  phase: PipelinePhase,
  options: FinishPipelinePhaseOptions = {},
): TransitionPipelineStateResult {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    if (!pipeline.phases.includes(phase)) {
      throw new PipelineStateError(`Unknown pipeline phase "${phase}".`, 'PIPELINE_PHASE_INVALID');
    }
    const exitReason = options.exitReason || 'success';
    pipelineState.phase_statuses[phase] = exitReason === 'success'
      ? PHASE_STATUS_DONE
      : PHASE_STATUS_FAILED;
    pipelineState.last_exit_reason = exitReason;
    pipelineState.last_error = options.lastError || null;
    const nextPhase = resolveNextPipelinePhase(pipeline, pipelineState);
    pipelineState.current_phase = nextPhase;
    pipelineState.current_phase_index = nextPhase == null ? null : phaseIndex(pipeline.phases, nextPhase);
    pipelineState.phase_started_at = null;
    if (nextPhase == null && exitReason === 'success') {
      pipelineState.completed_at = options.completedAt || nowIso();
    }
    clearRuntimeState(sessionState);
    sessionState.last_exit_reason = exitReason;
    sessionState.pipeline_mode = true;
    if (exitReason === 'success') {
      sessionState.current_ticket = null;
      sessionState.step = nextPhase ?? 'complete';
    } else if (isBlockedExitReason(exitReason)) {
      sessionState.current_ticket = options.failedTicketId || (sessionState.current_ticket as string | null) || null;
      sessionState.step = 'blocked';
    } else {
      sessionState.current_ticket = exitReason === 'error'
        ? options.failedTicketId || (sessionState.current_ticket as string | null) || null
        : null;
      sessionState.step = 'paused';
    }
    appendHistoryEntry(
      sessionState,
      exitReason === 'success' ? 'pipeline_phase_done' : 'pipeline_phase_failed',
      (sessionState.current_ticket as string | null) || undefined,
    );
    if (nextPhase == null && exitReason === 'success') {
      appendHistoryEntry(sessionState, 'complete');
    }
  }, options);
}

export function cancelPipelineSession(
  sessionDir: string,
  options: CancelPipelineSessionOptions = {},
): TransitionPipelineStateResult {
  return transitionPipelineState(sessionDir, (pipelineState, sessionState, pipeline) => {
    const interruptedPhase: PipelinePhase | null = (options.phase as PipelinePhase | null)
      || pipelineState.current_phase
      || resolveNextPipelinePhase(pipeline, pipelineState)
      || pipeline.phases[0]
      || null;
    const cancelledAt = options.cancelledAt || nowIso();

    if (interruptedPhase && pipeline.phases.includes(interruptedPhase)) {
      pipelineState.current_phase = interruptedPhase;
      pipelineState.current_phase_index = phaseIndex(pipeline.phases, interruptedPhase);
      if (pipelineState.phase_statuses[interruptedPhase] !== PHASE_STATUS_DONE) {
        pipelineState.phase_statuses[interruptedPhase] = PHASE_STATUS_CANCELLED;
      }
    }

    pipelineState.last_exit_reason = options.exitReason || 'cancelled';
    pipelineState.last_error = options.lastError || null;
    pipelineState.completed_at = null;
    clearRuntimeState(sessionState);
    sessionState.last_exit_reason = options.exitReason || 'cancelled';
    sessionState.cancel_requested_at = cancelledAt;
    sessionState.pipeline_mode = true;
    appendHistoryEntry(sessionState, 'inactive', (sessionState.current_ticket as string | null) || undefined);
  }, options);
}

export function readVerificationBaselines(
  sessionDir: string,
  stateManager: StateManager = new StateManager(),
  pipeline: PipelineContract = readPipelineContract(sessionDir),
): VerificationBaselines {
  const pipelineState = readPipelineState(sessionDir, stateManager, pipeline);
  return normalizeVerificationBaselines(pipelineState.verification_baselines, pipeline.working_dir);
}

export function writeVerificationBaselines(
  sessionDir: string,
  verificationBaselines: unknown,
  options: WriteVerificationBaselinesOptions = {},
): VerificationBaselines {
  const pipeline = options.pipeline || readPipelineContract(sessionDir);
  return transitionPipelineState(sessionDir, (pipelineState) => {
    pipelineState.verification_baselines = normalizeVerificationBaselines(
      verificationBaselines,
      pipeline.working_dir,
    );
  }, { ...options, pipeline }).pipelineState.verification_baselines;
}

export function readTicketVerificationBaseline(
  sessionDir: string,
  ticketId: string,
  command: string,
  options: ReadTicketVerificationBaselineOptions = {},
): VerificationBaselineEntry | null {
  const baselines = readVerificationBaselines(
    sessionDir,
    options.stateManager || new StateManager(),
    options.pipeline,
  );
  const scope = buildVerificationCommandScope(command, options.cwd || process.cwd());
  return baselines.by_ticket?.[ticketId]?.[scope.key] || null;
}
