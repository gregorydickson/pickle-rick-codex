import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Ticket } from '../types/index.js';

export interface QualityCommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signature: string;
  output: string;
  /** Stable, order-independent identities for diagnostics observed in this failed run. */
  failure_set?: string[];
}

export interface QualityBaseline {
  head_sha: string;
  captured_at: string;
  commands: QualityCommandResult[];
  /** Exact package-script definition (or explicit test command) captured for each required command. */
  command_contract: Record<string, string>;
}

export type QualityBaselineErrorKind =
  | 'quality-baseline-missing'
  | 'quality-baseline-stale'
  | 'quality-baseline-write-failed';

export class QualityBaselineError extends Error {
  kind: QualityBaselineErrorKind;

  constructor(kind: QualityBaselineErrorKind, message: string, options: ErrorOptions = {}) {
    super(`${kind}: ${message}`, options);
    this.name = 'QualityBaselineError';
    this.kind = kind;
  }
}

export interface WorkerGateVerdict {
  verdict: 'green' | 'red' | 'absent';
  computedVia: string;
  failures: QualityCommandResult[];
}

export interface WorkspaceSnapshot {
  headSha: string;
  files: Record<string, string>;
}

export interface ScopeVerdict {
  ok: boolean;
  allowedPaths: string[];
  changedPaths: string[];
  violations: string[];
  reason?: string;
}

export interface QualityRunOptions {
  isCancelled?: () => boolean;
  onSpawn?: (pid: number | undefined, command: string) => void;
  onExit?: () => void;
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
  } catch {
    return '';
  }
}

function packageScripts(workingDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const scripts = (parsed as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? scripts as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function fileContains(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

function hasPythonTests(workingDir: string): boolean {
  if (fs.existsSync(path.join(workingDir, 'pytest.ini'))) return true;
  if (fileContains(path.join(workingDir, 'pyproject.toml'), /^\[tool\.pytest\./m)) return true;
  if (fileContains(path.join(workingDir, 'setup.cfg'), /^\[tool:pytest\]/m)) return true;
  const testsDir = path.join(workingDir, 'tests');
  try {
    return fs.readdirSync(testsDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /^(?:test_.*|.*_test)\.py$/.test(entry.name));
  } catch {
    return false;
  }
}

/** Portable whole-repository checks, selected only when the repository declares them. */
export function discoverQualityCommands(workingDir: string): string[] {
  // Integration harnesses invoke workers from this package while its own test
  // runner is active. An explicit test-only command list prevents recursive
  // self-test spawning without creating a production gate bypass.
  if (process.env.PICKLE_TEST_MODE === '1' && process.env.PICKLE_TEST_QUALITY_COMMANDS) {
    try {
      const commands = JSON.parse(process.env.PICKLE_TEST_QUALITY_COMMANDS) as unknown;
      if (Array.isArray(commands) && commands.every((entry) => typeof entry === 'string')) {
        return commands as string[];
      }
    } catch { /* malformed test override falls through to real discovery */ }
  }
  const scripts = packageScripts(workingDir);
  const manager = fs.existsSync(path.join(workingDir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : fs.existsSync(path.join(workingDir, 'yarn.lock'))
      ? 'yarn'
      : fs.existsSync(path.join(workingDir, 'bun.lockb')) || fs.existsSync(path.join(workingDir, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const invoke = (name: string): string => manager === 'yarn' ? `yarn ${name}` : `${manager} run ${name}`;
  const commands = ['typecheck', 'lint', 'test']
    .filter((name) => typeof scripts[name] === 'string' && String(scripts[name]).trim().length > 0)
    .map(invoke);
  if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) commands.push('cargo test');
  if (fs.existsSync(path.join(workingDir, 'go.mod'))) commands.push('go test ./...');
  if (hasPythonTests(workingDir)) {
    commands.push(fs.existsSync(path.join(workingDir, 'uv.lock')) ? 'uv run pytest' : 'python -m pytest');
  }
  return [...new Set(commands)];
}

function discoverQualityCommandContract(workingDir: string): Record<string, string> {
  const commands = discoverQualityCommands(workingDir);
  if (process.env.PICKLE_TEST_MODE === '1' && process.env.PICKLE_TEST_QUALITY_COMMANDS) {
    return Object.fromEntries(commands.map((command) => [command, command]));
  }
  const scripts = packageScripts(workingDir);
  return Object.fromEntries(commands.map((command) => {
    const scriptName = command.match(/(?:run\s+)?(typecheck|lint|test)$/)?.[1] || '';
    return [command, typeof scripts[scriptName] === 'string' ? String(scripts[scriptName]) : ''];
  }));
}

function stableContract(contract: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(contract).sort(([left], [right]) => left.localeCompare(right))));
}

export function assertQualityBaselineFresh(value: unknown, workingDir: string): QualityBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QualityBaselineError('quality-baseline-missing', 'no persisted repository quality baseline exists');
  }
  const baseline = value as Partial<QualityBaseline>;
  if (
    typeof baseline.head_sha !== 'string'
    || typeof baseline.captured_at !== 'string'
    || !Number.isFinite(Date.parse(baseline.captured_at))
    || !Array.isArray(baseline.commands)
    || !baseline.command_contract
    || typeof baseline.command_contract !== 'object'
    || Array.isArray(baseline.command_contract)
  ) {
    throw new QualityBaselineError('quality-baseline-missing', 'persisted repository quality baseline is incomplete');
  }
  const currentHead = runGit(workingDir, ['rev-parse', 'HEAD']);
  if (baseline.head_sha !== currentHead) {
    throw new QualityBaselineError(
      'quality-baseline-stale',
      `baseline HEAD ${baseline.head_sha || '<none>'} does not match current HEAD ${currentHead || '<none>'}`,
    );
  }
  const currentContract = discoverQualityCommandContract(workingDir);
  if (stableContract(baseline.command_contract) !== stableContract(currentContract)) {
    throw new QualityBaselineError('quality-baseline-stale', 'repository quality command contract changed after baseline capture');
  }
  return baseline as QualityBaseline;
}

export function persistFreshQualityBaseline(
  baseline: QualityBaseline,
  workingDir: string,
  persist: (value: QualityBaseline) => void,
  reread: () => unknown,
): QualityBaseline {
  try {
    persist(baseline);
    return assertQualityBaselineFresh(reread(), workingDir);
  } catch (error) {
    if (error instanceof QualityBaselineError && error.kind === 'quality-baseline-write-failed') throw error;
    throw new QualityBaselineError(
      'quality-baseline-write-failed',
      'could not durably persist and re-read the fresh repository quality baseline',
      { cause: error },
    );
  }
}

function normalizeOutput(output: string, workingDir: string): string {
  return output
    // eslint-disable-next-line no-control-regex -- ANSI CSI escape prefix is a control character by definition.
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll(workingDir, '<repo>')
    .replace(/\r\n/g, '\n')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/g, '<timestamp>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>')
    .replace(/\b(?:duration|elapsed|time)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s)?\b/gi, 'duration:<elapsed>')
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)/gi, '(<elapsed>)')
    .replace(/^\s*duration_ms:\s*[\d.]+\s*$/gm, 'duration_ms:<elapsed>')
    .trim();
}

function failureSet(output: string, workingDir: string): string[] {
  return [...new Set(normalizeOutput(output, workingDir)
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean))]
    .sort();
}

function outputSignature(output: string, workingDir: string): string {
  return crypto.createHash('sha256').update(JSON.stringify(failureSet(output, workingDir))).digest('hex');
}

function resultFailureSet(result: QualityCommandResult, workingDir: string): string[] {
  return Array.isArray(result.failure_set) ? [...new Set(result.failure_set)].sort() : failureSet(result.output, workingDir);
}

function sameFailureSet(left: QualityCommandResult, right: QualityCommandResult, workingDir: string): boolean {
  return JSON.stringify(resultFailureSet(left, workingDir)) === JSON.stringify(resultFailureSet(right, workingDir));
}

export async function runQualityCommand(
  command: string,
  workingDir: string,
  timeoutMs: number,
  options: QualityRunOptions = {},
): Promise<QualityCommandResult> {
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd: workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onSpawn?.(child.pid, command);
    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcessGroup('SIGTERM');
      killTimer = setTimeout(() => signalProcessGroup('SIGKILL'), 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const cancellationTimer = options.isCancelled
      ? setInterval(() => {
        if (options.isCancelled?.()) terminate();
      }, 100)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      options.onExit?.();
      const output = error.message;
      resolve({ command, ok: false, exitCode: null, signature: outputSignature(output, workingDir), output, failure_set: failureSet(output, workingDir) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      options.onExit?.();
      const output = timedOut
        ? `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}\nquality gate timed out`
        : `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
      const normalized = normalizeOutput(output, workingDir);
      resolve({
        command,
        ok: !timedOut && code === 0,
        exitCode: code,
        signature: outputSignature(output, workingDir),
        output: normalized,
        failure_set: timedOut || code !== 0 ? failureSet(output, workingDir) : [],
      });
    });
  });
}

/** A single failed attempt is treated as flaky; only diagnostics repeated by the bounded retry persist. */
async function runQualityCommandStabilized(
  command: string,
  workingDir: string,
  timeoutMs: number,
  options: QualityRunOptions,
): Promise<QualityCommandResult> {
  const first = await runQualityCommand(command, workingDir, timeoutMs, options);
  if (first.ok) return first;
  const retry = await runQualityCommand(command, workingDir, timeoutMs, options);
  if (retry.ok) return retry;
  const retryIdentities = new Set(resultFailureSet(retry, workingDir));
  const persistent = resultFailureSet(first, workingDir).filter((identity) => retryIdentities.has(identity));
  if (persistent.length === 0) {
    return { ...retry, ok: true, failure_set: [], signature: outputSignature('', workingDir) };
  }
  return {
    ...retry,
    failure_set: persistent,
    signature: crypto.createHash('sha256').update(JSON.stringify(persistent)).digest('hex'),
  };
}

export async function captureQualityBaseline(
  workingDir: string,
  timeoutMs: number,
  options: QualityRunOptions = {},
): Promise<QualityBaseline> {
  const commands = discoverQualityCommands(workingDir);
  const results: QualityCommandResult[] = [];
  for (const command of commands) results.push(await runQualityCommandStabilized(command, workingDir, timeoutMs, options));
  return {
    head_sha: runGit(workingDir, ['rev-parse', 'HEAD']),
    captured_at: new Date().toISOString(),
    commands: results,
    command_contract: discoverQualityCommandContract(workingDir),
  };
}

/** A post-worker failure is tolerated only when the same command has the same persistent failure set. */
export async function evaluateWorkerQualityGate(
  workingDir: string,
  baseline: QualityBaseline,
  timeoutMs: number,
  options: QualityRunOptions = {},
): Promise<WorkerGateVerdict> {
  const failures: QualityCommandResult[] = [];
  const currentContract = discoverQualityCommandContract(workingDir);
  const baselineCommands = new Set(baseline.commands.map((result) => result.command));
  for (const baselineResult of baseline.commands) {
    const command = baselineResult.command;
    const expectedDefinition = baseline.command_contract?.[command];
    if (expectedDefinition !== undefined && currentContract[command] !== expectedDefinition) {
      const output = currentContract[command] === undefined
        ? 'required quality command was removed after baseline capture'
        : 'required quality command definition changed after baseline capture';
      failures.push({
        command,
        ok: false,
        exitCode: null,
        signature: outputSignature(output, workingDir),
        output,
      });
      continue;
    }
    const result = await runQualityCommandStabilized(command, workingDir, timeoutMs, options);
    if (result.ok) continue;
    if (baselineResult.ok || !sameFailureSet(baselineResult, result, workingDir)) failures.push(result);
  }
  for (const command of Object.keys(currentContract)) {
    if (baselineCommands.has(command)) continue;
    const result = await runQualityCommandStabilized(command, workingDir, timeoutMs, options);
    if (!result.ok) failures.push(result);
  }
  const commandCount = Object.keys(currentContract).length;
  return {
    verdict: failures.length > 0 ? 'red' : commandCount === 0 ? 'absent' : 'green',
    computedVia: 'portable-repo-quality-gate',
    failures,
  };
}

function snapshotPaths(workingDir: string): string[] {
  const tracked = runGit(workingDir, ['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = runGit(workingDir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function fileIdentity(absolutePath: string): string {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(absolutePath)}`;
    if (!stat.isFile()) return `other:${stat.mode}`;
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
  } catch {
    return '<absent>';
  }
}

export function captureWorkspaceSnapshot(workingDir: string): WorkspaceSnapshot {
  const files: Record<string, string> = {};
  for (const relativePath of snapshotPaths(workingDir)) {
    files[relativePath] = fileIdentity(path.join(workingDir, relativePath));
  }
  return { headSha: runGit(workingDir, ['rev-parse', 'HEAD']), files };
}

export function changedPathsSinceSnapshot(workingDir: string, baseline: WorkspaceSnapshot): string[] {
  const current = captureWorkspaceSnapshot(workingDir);
  const changed = new Set<string>();
  for (const relativePath of new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])) {
    if (baseline.files[relativePath] !== current.files[relativePath]) changed.add(relativePath);
  }
  if (baseline.headSha && current.headSha && baseline.headSha !== current.headSha) {
    const committed = runGit(workingDir, ['diff', '--name-only', '-z', baseline.headSha, current.headSha]);
    for (const relativePath of committed.split('\0').filter(Boolean)) changed.add(relativePath);
  }
  return [...changed].sort();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

export function resolveTicketScope(ticket: Ticket): { allowedPaths: string[]; error?: string } {
  const raw = [
    ...stringList(ticket.allowed_paths),
    ...stringList(ticket.allowedPaths),
    ...stringList(ticket.files),
    ...stringList(ticket.output_artifacts),
    ...stringList(ticket.proof_corpus),
    ...(ticket.freeze_contract?.artifact_path ? [ticket.freeze_contract.artifact_path] : []),
  ];
  const allowedPaths: string[] = [];
  for (const candidate of raw) {
    const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || /[*?[\]{}]/.test(normalized)) {
      return { allowedPaths: [], error: `invalid ticket scope path: ${candidate}` };
    }
    if (!allowedPaths.includes(normalized)) allowedPaths.push(normalized);
  }
  if (allowedPaths.length === 0) return { allowedPaths, error: 'ticket declares no allowed_paths or owned artifacts' };
  return { allowedPaths: allowedPaths.sort() };
}

function isWithinScope(relativePath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}/`));
}

export function evaluateTicketScope(ticket: Ticket, changedPaths: string[]): ScopeVerdict {
  const scope = resolveTicketScope(ticket);
  // A verified audit/no-op has no mutation to fence. Once a path changed, an
  // absent or malformed declaration is a fail-closed scope violation.
  if (scope.error) return changedPaths.length === 0
    ? { ok: true, allowedPaths: scope.allowedPaths, changedPaths, violations: [] }
    : { ok: false, allowedPaths: scope.allowedPaths, changedPaths, violations: changedPaths, reason: scope.error };
  const violations = changedPaths.filter((relativePath) => !isWithinScope(relativePath, scope.allowedPaths));
  return {
    ok: violations.length === 0,
    allowedPaths: scope.allowedPaths,
    changedPaths,
    violations,
    reason: violations.length > 0 ? `ticket changed paths outside its declared scope: ${violations.join(', ')}` : undefined,
  };
}
