import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexExecMonitored, assertCodexSucceeded, hasPromiseToken } from './codex.js';
import { getHeadSha, getWorkingTreeFingerprint, listWorkingTreeDirtyPaths } from './git-utils.js';
import { recoverableHardReset } from './recoverable-git.js';
import { atomicWriteJson, readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import { captureSpawnedProcessIdentity } from './orphan-reaper.js';
import { auditPersistedScopeForCitadel } from './scope-contract.js';

export type CitadelSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface CitadelFinding {
  severity: CitadelSeverity;
  title: string;
  evidence: string;
  file?: string | null;
  line?: number | null;
  recommendation?: string | null;
}

export interface CitadelReport {
  schema_version: 1;
  verdict: 'approve' | 'block';
  reviewed_range: string;
  acceptance_criteria_checked: string[];
  findings: CitadelFinding[];
  generated_at: string;
}

export interface CitadelCheckResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exit_code: number | null;
  output: string;
}

interface CitadelCheckRunOptions {
  timeoutMs: number;
  isCancelled: () => boolean;
  onSpawn: (child: ChildProcess, command: string) => void;
  onExit: () => void;
}

class CitadelChecksCancelledError extends Error {
  constructor() {
    super('Citadel deterministic checks cancelled.');
    this.name = 'CitadelChecksCancelledError';
  }
}

const SEVERITIES = new Set<CitadelSeverity>(['critical', 'high', 'medium', 'low', 'info']);

function normalizeCriterion(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map(normalizeCriterion).filter(Boolean)
    : [];
}

function uniqueCriteria(criteria: string[]): string[] {
  return [...new Set(criteria.map(normalizeCriterion).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function criteriaFromManifest(sessionDir: string): string[] {
  const manifest = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!Array.isArray(manifest?.tickets)) return [];
  return uniqueCriteria(manifest.tickets.flatMap((ticket) => {
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return [];
    return stringArray((ticket as Record<string, unknown>).acceptance_criteria);
  }));
}

function verificationCommandsFromManifest(sessionDir: string): string[] {
  const manifest = readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'refinement_manifest.json'), null);
  if (!Array.isArray(manifest?.tickets)) return [];
  return uniqueStrings(manifest.tickets.flatMap((ticket) => {
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return [];
    const verification = (ticket as Record<string, unknown>).verification;
    if (typeof verification === 'string') return [verification];
    if (!Array.isArray(verification)) return [];
    return verification.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).command === 'string') {
        return [String((entry as Record<string, unknown>).command)];
      }
      return [];
    });
  }));
}

function criteriaFromPrd(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const criteria: string[] = [];
  let inAcceptanceSection = false;
  let acceptanceDepth = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const depth = heading[1].length;
      if (/acceptance criteria|success criteria/i.test(heading[2])) {
        inAcceptanceSection = true;
        acceptanceDepth = depth;
      } else if (inAcceptanceSection && depth <= acceptanceDepth) {
        inAcceptanceSection = false;
      }
      continue;
    }
    if (!inAcceptanceSection) continue;
    const bullet = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/);
    if (bullet) criteria.push(bullet[1]);
  }
  return uniqueCriteria(criteria);
}

/** Ticket criteria are authoritative after refinement; a PRD section is the standalone fallback. */
export function deriveCitadelAcceptanceCriteria(sessionDir: string): string[] {
  const manifestCriteria = criteriaFromManifest(sessionDir);
  if (manifestCriteria.length > 0) return manifestCriteria;
  for (const name of ['prd_refined.md', 'prd.md']) {
    const filePath = path.join(sessionDir, name);
    if (!fs.existsSync(filePath)) continue;
    const criteria = criteriaFromPrd(fs.readFileSync(filePath, 'utf8'));
    if (criteria.length > 0) return criteria;
  }
  return [];
}

export function citadelReportPath(sessionDir: string): string {
  return path.join(sessionDir, 'citadel-report.json');
}

export function getCitadelRepositoryFingerprint(workingDir: string): string {
  const index = spawnSync('git', ['diff', '--cached', '--binary', '--no-ext-diff'], {
    cwd: workingDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (index.error || index.status !== 0) {
    throw new Error(`Citadel could not fingerprint the git index: ${index.error?.message || index.stderr || `exit ${index.status}`}`);
  }
  return JSON.stringify({
    head: getHeadSha(workingDir),
    index: index.stdout,
    files: getWorkingTreeFingerprint(workingDir),
  });
}

function normalizeFinding(value: unknown, index: number): CitadelFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Citadel finding ${index}: expected an object.`);
  }
  const raw = value as Record<string, unknown>;
  const severity = String(raw.severity || '').toLowerCase() as CitadelSeverity;
  if (!SEVERITIES.has(severity)) {
    throw new Error(`Invalid Citadel finding ${index}: unsupported severity ${JSON.stringify(raw.severity)}.`);
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
  if (!title || !evidence) {
    throw new Error(`Invalid Citadel finding ${index}: title and evidence are required.`);
  }
  return {
    severity,
    title,
    evidence,
    file: typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : null,
    line: Number.isInteger(raw.line) && Number(raw.line) > 0 ? Number(raw.line) : null,
    recommendation: typeof raw.recommendation === 'string' && raw.recommendation.trim()
      ? raw.recommendation.trim()
      : null,
  };
}

export function validateCitadelReport(
  value: unknown,
  reviewedRange: string,
  expectedAcceptanceCriteria: string[],
): CitadelReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Citadel report: expected an object.');
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.findings)) {
    throw new Error('Invalid Citadel report: findings must be an array.');
  }
  const findings = raw.findings.map(normalizeFinding);
  const acceptanceCriteria = Array.isArray(raw.acceptance_criteria_checked)
    ? raw.acceptance_criteria_checked
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
  const expected = uniqueCriteria(expectedAcceptanceCriteria);
  if (expected.length === 0) {
    throw new Error('Invalid Citadel evidence: the session declares no acceptance criteria.');
  }
  const checked = new Set(acceptanceCriteria.map(normalizeCriterion));
  const missing = expected.filter((criterion) => !checked.has(criterion));
  if (missing.length > 0) {
    throw new Error(`Invalid Citadel report: acceptance criteria coverage is incomplete; missing: ${missing.join(' | ')}`);
  }
  const blocking = findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high');
  return {
    schema_version: 1,
    verdict: blocking ? 'block' : 'approve',
    reviewed_range: reviewedRange,
    acceptance_criteria_checked: acceptanceCriteria,
    findings,
    generated_at: typeof raw.generated_at === 'string' && raw.generated_at.trim()
      ? raw.generated_at
      : new Date().toISOString(),
  };
}

function packageScripts(workingDir: string): Record<string, string> {
  const packagePath = path.join(workingDir, 'package.json');
  const parsed = readJsonFile<Record<string, unknown>>(packagePath, null);
  if (!parsed?.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
  return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function runCitadelChecks(
  workingDir: string,
  timeoutMs = 900_000,
  ticketVerificationCommands: string[] = [],
): CitadelCheckResult[] {
  const scripts = packageScripts(workingDir);
  const packageChecks: CitadelCheckResult[] = ['typecheck', 'lint', 'test'].map((script) => {
    if (!scripts[script]) {
      return { command: `npm run ${script}`, status: 'skipped', exit_code: null, output: 'script not defined' };
    }
    const result = spawnSync('npm', ['run', script], {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-100_000);
    const status = !result.error && result.status === 0 ? 'passed' : 'failed';
    return {
      command: `npm run ${script}`,
      status,
      exit_code: result.status,
      output: result.error ? `${result.error.message}\n${output}`.trim() : output,
    };
  });
  const ticketChecks = uniqueStrings(ticketVerificationCommands).map((command) => {
    const result = spawnSync(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-100_000);
    return {
      command,
      status: !result.error && result.status === 0 ? 'passed' as const : 'failed' as const,
      exit_code: result.status,
      output: result.error ? `${result.error.message}\n${output}`.trim() : output,
    };
  });
  return [...packageChecks, ...ticketChecks];
}

interface CitadelCheckDescriptor {
  command: string;
  executable: string;
  args: string[];
  skipped?: boolean;
}

function citadelCheckDescriptors(workingDir: string, ticketVerificationCommands: string[]): CitadelCheckDescriptor[] {
  const scripts = packageScripts(workingDir);
  const packageChecks = ['typecheck', 'lint', 'test'].map((script): CitadelCheckDescriptor => ({
    command: `npm run ${script}`,
    executable: 'npm',
    args: ['run', script],
    skipped: !scripts[script],
  }));
  const ticketChecks = uniqueStrings(ticketVerificationCommands).map((command): CitadelCheckDescriptor => ({
    command,
    executable: process.env.SHELL || 'zsh',
    args: ['-lc', command],
  }));
  return [...packageChecks, ...ticketChecks];
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = Number(child.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* fall through to direct leader */ }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

async function runMonitoredCitadelCheck(
  descriptor: CitadelCheckDescriptor,
  workingDir: string,
  options: CitadelCheckRunOptions,
): Promise<CitadelCheckResult> {
  if (descriptor.skipped) {
    return { command: descriptor.command, status: 'skipped', exit_code: null, output: 'script not defined' };
  }
  if (options.isCancelled()) throw new CitadelChecksCancelledError();
  return await new Promise<CitadelCheckResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onSpawn(child, descriptor.command);

    const terminate = (): void => {
      signalProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
      }, 1_000).unref?.();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const cancelPoll = setInterval(() => {
      if (!options.isCancelled()) return;
      cancelled = true;
      terminate();
    }, 100);
    const cleanup = (): void => {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      options.onExit();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (cancelled || options.isCancelled()) {
        // The state canceller may have signalled only the leader. Reap the owned
        // process group once more so a shell/test descendant cannot escape.
        signalProcessTree(child, 'SIGKILL');
        reject(new CitadelChecksCancelledError());
        return;
      }
      const output = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`
        .trim()
        .slice(-100_000);
      resolve({
        command: descriptor.command,
        status: !timedOut && code === 0 ? 'passed' : 'failed',
        exit_code: code,
        output: timedOut ? `${output}\nCitadel check timed out after ${options.timeoutMs}ms`.trim() : output,
      });
    }));
  });
}

async function runCitadelChecksMonitored(
  workingDir: string,
  ticketVerificationCommands: string[],
  options: CitadelCheckRunOptions,
): Promise<CitadelCheckResult[]> {
  const results: CitadelCheckResult[] = [];
  for (const descriptor of citadelCheckDescriptors(workingDir, ticketVerificationCommands)) {
    results.push(await runMonitoredCitadelCheck(descriptor, workingDir, options));
  }
  return results;
}

function buildCitadelPrompt(
  sessionDir: string,
  reviewedRange: string,
  checksPath: string,
  expectedAcceptanceCriteria: string[],
): string {
  const reportPath = citadelReportPath(sessionDir);
  return [
    'You are the Citadel release reviewer for a Pickle Rick pipeline.',
    'This is a read-only adversarial review. Do not modify, stage, commit, or revert repository files.',
    `Review git range: ${reviewedRange}`,
    `Read deterministic check results: ${checksPath}`,
    'Read the PRD, refined PRD, ticket manifests, completion evidence, and changed code available in the repository/session.',
    `Required acceptance criteria (copy each exact string into acceptance_criteria_checked): ${JSON.stringify(expectedAcceptanceCriteria)}`,
    'Check acceptance-criteria coverage, correctness, cross-file contract drift, missing tests, unsafe mutations, and release blockers.',
    'Only report findings supported by concrete file/line or command evidence. Do not report style preferences as release blockers.',
    `Citadel report path: ${reportPath}`,
    'Write exactly one JSON object there with keys: schema_version, verdict, reviewed_range, acceptance_criteria_checked, findings, generated_at.',
    'Each finding must have severity (critical|high|medium|low|info), title, evidence, file, line, recommendation.',
    'Use verdict block when any critical/high finding exists; otherwise approve.',
    'After writing the report, return <promise>THE_CITADEL_APPROVES</promise>.',
  ].join('\n\n');
}

/** Preserve evidence, then restore the clean release checkpoint before returning control. */
function restoreMutatedCitadelCheckpoint(
  workingDir: string,
  sessionDir: string,
  checkpointHead: string,
  checkpointFingerprint: string,
  source: string,
): boolean {
  if (getCitadelRepositoryFingerprint(workingDir) === checkpointFingerprint) return false;
  const suffix = source.replace(/[^a-zA-Z0-9_-]/g, '-');
  recoverableHardReset({
    workingDir,
    sessionDir,
    targetHead: checkpointHead,
    operation: `citadel-${suffix}`,
    headRecoveryRef: `refs/pickle/salvage/${path.basename(sessionDir)}-citadel-${suffix}`,
  });
  if (getCitadelRepositoryFingerprint(workingDir) !== checkpointFingerprint) {
    throw new Error(`Citadel could not restore its clean checkpoint after ${source} mutation.`);
  }
  return true;
}

function blockedEvidenceReport(
  reviewedRange: string,
  expectedAcceptanceCriteria: string[],
  title: string,
  evidence: string,
): CitadelReport {
  return {
    schema_version: 1,
    verdict: 'block',
    reviewed_range: reviewedRange,
    acceptance_criteria_checked: expectedAcceptanceCriteria,
    findings: [{ severity: 'high', title, evidence, file: null, line: null, recommendation: 'Supply complete, executable Citadel evidence before release.' }],
    generated_at: new Date().toISOString(),
  };
}

function reachableCitadelBase(workingDir: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const resolved = spawnSync('git', ['rev-parse', '--verify', `${candidate.trim()}^{commit}`], {
    cwd: workingDir,
    encoding: 'utf8',
  });
  if (resolved.status !== 0) return null;
  const sha = resolved.stdout.trim();
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: workingDir });
  return ancestor.status === 0 ? sha : null;
}

export function recoverCitadelStartCommit(
  manager: StateManager,
  statePath: string,
  state: Record<string, unknown>,
  workingDir: string,
): string | null {
  const scope = readJsonFile<Record<string, unknown>>(path.join(path.dirname(statePath), 'scope.json'), null);
  let startCommit = reachableCitadelBase(workingDir, state.start_commit)
    || reachableCitadelBase(workingDir, state.pinned_sha)
    || reachableCitadelBase(workingDir, scope?.review_base);
  if (!startCommit) {
    const roots = spawnSync('git', ['rev-list', '--max-parents=0', '--reverse', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf8',
    });
    if (roots.status === 0) {
      startCommit = roots.stdout.split(/\s+/).map((entry) => entry.trim()).find(Boolean) || null;
    }
  }
  if (!startCommit) return null;
  manager.update(statePath, (current) => {
    current.start_commit = startCommit;
    return current;
  });
  return startCommit;
}

export async function runCitadel(sessionDir: string): Promise<'success' | 'citadel-blocked' | 'cancelled'> {
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const state = manager.read(statePath);
  const workingDir = String(state.working_dir || '');
  if (!workingDir) {
    throw new Error('Citadel requires a git-backed session with a persisted working_dir.');
  }
  const startCommit = recoverCitadelStartCommit(manager, statePath, state, workingDir);
  if (!startCommit) {
    throw new Error('Citadel could not recover a reachable start_commit for this git-backed session.');
  }
  const preexistingDirtyPaths = listWorkingTreeDirtyPaths(workingDir);
  if (preexistingDirtyPaths.length > 0) {
    throw new Error(`Citadel requires a clean release tree; dirty paths: ${preexistingDirtyPaths.join(', ')}`);
  }
  fs.rmSync(citadelReportPath(sessionDir), { force: true });
  const expectedAcceptanceCriteria = deriveCitadelAcceptanceCriteria(sessionDir);
  const reviewedRange = `${startCommit}..HEAD`;
  const scopeFailure = auditPersistedScopeForCitadel(sessionDir, workingDir);
  if (scopeFailure) {
    atomicWriteJson(citadelReportPath(sessionDir), blockedEvidenceReport(
      reviewedRange,
      expectedAcceptanceCriteria,
      'Citadel scope contract is invalid',
      scopeFailure,
    ));
    return 'citadel-blocked';
  }
  if (expectedAcceptanceCriteria.length === 0) {
    atomicWriteJson(citadelReportPath(sessionDir), blockedEvidenceReport(
      reviewedRange,
      [],
      'Citadel has no acceptance criteria to verify',
      'Neither the refinement manifest nor the session PRD declares acceptance criteria.',
    ));
    return 'citadel-blocked';
  }
  const checkpointHead = getHeadSha(workingDir);
  const checkpointFingerprint = getCitadelRepositoryFingerprint(workingDir);
  let checks: CitadelCheckResult[];
  try {
    checks = await runCitadelChecksMonitored(
      workingDir,
      verificationCommandsFromManifest(sessionDir),
      {
        timeoutMs: Number(state.worker_timeout_seconds || 900) * 1000,
        isCancelled: () => {
          const current = manager.read(path.join(sessionDir, 'state.json'));
          return current.last_exit_reason === 'cancelled' || Boolean(current.cancel_requested_at);
        },
        onSpawn: (child, command) => {
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = child.pid;
            current.active_child_kind = 'citadel-check';
            current.active_child_command = command;
            current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
            current.active_child_controller_pid = process.pid;
            return current;
          });
        },
        onExit: () => {
          manager.update(path.join(sessionDir, 'state.json'), (current) => {
            current.active_child_pid = null;
            current.active_child_kind = null;
            current.active_child_command = null;
            current.active_child_identity = null;
            current.active_child_controller_pid = null;
            return current;
          });
        },
      },
    );
  } catch (error) {
    const restored = restoreMutatedCitadelCheckpoint(workingDir, sessionDir, checkpointHead, checkpointFingerprint, 'deterministic-check');
    if (error instanceof CitadelChecksCancelledError) return 'cancelled';
    if (restored) {
      throw new Error('A deterministic Citadel check modified the target repository; the clean checkpoint was restored.', { cause: error });
    }
    throw error;
  }
  const checksPath = path.join(sessionDir, 'citadel-checks.json');
  atomicWriteJson(checksPath, { schema_version: 1, reviewed_range: reviewedRange, checks });
  if (restoreMutatedCitadelCheckpoint(workingDir, sessionDir, checkpointHead, checkpointFingerprint, 'deterministic-check')) {
    throw new Error('A deterministic Citadel check modified the target repository; the clean checkpoint was restored.');
  }
  if (checks.some((check) => check.status === 'failed')) {
    const report: CitadelReport = {
      schema_version: 1,
      verdict: 'block',
      reviewed_range: reviewedRange,
      acceptance_criteria_checked: [],
      findings: checks
        .filter((check) => check.status === 'failed')
        .map((check) => ({
          severity: 'high',
          title: `Deterministic check failed: ${check.command}`,
          evidence: check.output || `exit code ${check.exit_code}`,
          file: null,
          line: null,
          recommendation: `Fix ${check.command} before continuing the pipeline.`,
        })),
      generated_at: new Date().toISOString(),
    };
    atomicWriteJson(citadelReportPath(sessionDir), report);
    return 'citadel-blocked';
  }
  if (!checks.some((check) => check.status === 'passed')) {
    atomicWriteJson(citadelReportPath(sessionDir), blockedEvidenceReport(
      reviewedRange,
      expectedAcceptanceCriteria,
      'Citadel deterministic gate unavailable',
      'No declared deterministic typecheck, lint, or test command executed.',
    ));
    return 'citadel-blocked';
  }

  const outputLastMessagePath = path.join(sessionDir, 'citadel.last-message.txt');
  fs.rmSync(outputLastMessagePath, { force: true });
  let result;
  let reviewerError: unknown = null;
  try {
    result = await runCodexExecMonitored({
      cwd: workingDir,
      prompt: buildCitadelPrompt(sessionDir, reviewedRange, checksPath, expectedAcceptanceCriteria),
      timeoutMs: Number(state.worker_timeout_seconds || 900) * 1000,
      outputLastMessagePath,
      progressArtifactPaths: [citadelReportPath(sessionDir)],
      addDirs: [sessionDir],
      successCheck: () => fs.existsSync(citadelReportPath(sessionDir)),
      onSpawn: (child) => {
        manager.update(path.join(sessionDir, 'state.json'), (current) => {
          current.active_child_pid = child.pid;
          current.active_child_kind = 'codex';
          current.active_child_command = 'citadel';
          current.active_child_identity = captureSpawnedProcessIdentity(Number(child.pid));
          current.active_child_controller_pid = process.pid;
          return current;
        });
      },
      cancelCheck: () => {
        const current = manager.read(path.join(sessionDir, 'state.json'));
        return current.last_exit_reason === 'cancelled' || Boolean(current.cancel_requested_at);
      },
    });
  } catch (error) {
    reviewerError = error;
  } finally {
    manager.update(path.join(sessionDir, 'state.json'), (current) => {
      current.active_child_pid = null;
      current.active_child_kind = null;
      current.active_child_command = null;
      current.active_child_identity = null;
      current.active_child_controller_pid = null;
      return current;
    });
  }
  if (restoreMutatedCitadelCheckpoint(workingDir, sessionDir, checkpointHead, checkpointFingerprint, 'reviewer')) {
    throw new Error('Citadel reviewer modified the target repository during a read-only review; the clean checkpoint was restored.', reviewerError ? { cause: reviewerError } : undefined);
  }
  if (reviewerError) throw reviewerError;
  if (!result) throw new Error('Citadel reviewer returned no execution result.');
  if (result.cancelled) return 'cancelled';
  assertCodexSucceeded(result, 'Citadel review failed');
  let report: CitadelReport;
  try {
    report = validateCitadelReport(
      readJsonFile(citadelReportPath(sessionDir), null),
      reviewedRange,
      expectedAcceptanceCriteria,
    );
  } catch (error) {
    report = blockedEvidenceReport(
      reviewedRange,
      expectedAcceptanceCriteria,
      'Citadel report evidence is invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (report.verdict === 'approve' && !(
    hasPromiseToken(result.lastMessage, 'THE_CITADEL_APPROVES')
    || hasPromiseToken(result.stdout, 'THE_CITADEL_APPROVES')
  )) {
    report = blockedEvidenceReport(
      reviewedRange,
      expectedAcceptanceCriteria,
      'Citadel approval signal missing',
      'The reviewer did not emit the required <promise>THE_CITADEL_APPROVES</promise> token.',
    );
  }
  atomicWriteJson(citadelReportPath(sessionDir), report);
  return report.verdict === 'approve' ? 'success' : 'citadel-blocked';
}
