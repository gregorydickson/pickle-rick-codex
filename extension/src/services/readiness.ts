import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { canExecute, loadCircuitState } from './circuit-breaker.js';
import { deriveCitadelAcceptanceCriteria, validateCitadelReport } from './citadel.js';
import { assertQualityBaselineFresh, resolveTicketScope } from './execution-gate.js';
import { atomicWriteJson, listTicketFiles, parseTicketFile, readJsonFile } from './pickle-utils.js';
import { auditPersistedScopeForCitadel } from './scope-contract.js';
import { assertSchemaVersionDeployParity, RUNTIME_STATE_SCHEMA_VERSION } from './state-manager.js';
import { normalizeTicketId, validateRefinementManifest } from './tickets.js';
import { assertTicketVerificationReady } from './verification-env.js';
import {
  readAndValidateWorkerLifecycleArtifact,
  workerLifecycleArtifactPath,
  WORKER_LIFECYCLE_PHASES,
} from './worker-lifecycle.js';
import type { PersistedState } from './state-manager.js';
import type { ConfigVerificationInput, RefinementManifest, Ticket } from '../types/index.js';

export type ReadinessSeverity = 'info' | 'warning' | 'error';

export interface ReadinessFinding {
  severity: ReadinessSeverity;
  code: string;
  evidence: string;
}

export interface ReadinessReport {
  schema_version: 1;
  checked_at: string;
  session_dir: string;
  ready: boolean;
  findings: ReadinessFinding[];
}

interface ReadinessHistory {
  schema_version: 1;
  cycles: ReadinessReport[];
}

export interface CheckReadinessOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  historyLimit?: number;
}

function finding(severity: ReadinessSeverity, code: string, evidence: string): ReadinessFinding {
  return { severity, code, evidence };
}

function readJsonStrict<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return !result.error && result.status === 0;
}

function checkRuntimeLayout(runtimeRoot: string): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const required = ['install.sh', 'package.json', '.codex-plugin/plugin.json', 'extension/state-schema.json', 'skills'];
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(runtimeRoot, relativePath))) {
      findings.push(finding('error', 'layout-missing', `Runtime is missing ${relativePath}.`));
    }
  }
  try {
    const plugin = readJsonStrict<Record<string, unknown>>(path.join(runtimeRoot, '.codex-plugin', 'plugin.json'));
    const skills = typeof plugin.skills === 'string' ? plugin.skills : '';
    if (plugin.name !== 'pickle-rick-codex' || !skills || !fs.existsSync(path.resolve(runtimeRoot, skills))) {
      findings.push(finding('error', 'plugin-layout-invalid', 'Plugin manifest name or skills path does not resolve to the installed skill tree.'));
    }
  } catch (error) {
    findings.push(finding('error', 'plugin-manifest-invalid', error instanceof Error ? error.message : String(error)));
  }
  return findings;
}

function checkGitTree(workingDir: string): ReadinessFinding[] {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workingDir, stdio: 'ignore', timeout: 10_000 });
    const dirty = execFileSync('git', ['status', '--porcelain=v1'], { cwd: workingDir, encoding: 'utf8', timeout: 30_000 }).trim();
    return dirty
      ? [finding('error', 'git-tree-dirty', `Working tree has uncommitted paths: ${dirty.split('\n').slice(0, 10).join(' | ')}`)]
      : [finding('info', 'git-tree-clean', 'Git working tree and index are clean.')];
  } catch (error) {
    return [finding('error', 'git-unavailable', `Working directory is not a readable git worktree: ${error instanceof Error ? error.message : String(error)}`)];
  }
}

function checkLifecycle(sessionDir: string, tickets: Ticket[]): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  for (const ticket of tickets) {
    const ticketId = normalizeTicketId(ticket.id || ticket.title, 'ticket');
    const acceptance = Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [];
    const done = String(ticket.status || '').toLowerCase() === 'done';
    for (const phase of WORKER_LIFECYCLE_PHASES) {
      const artifactPath = workerLifecycleArtifactPath(sessionDir, ticketId, phase);
      if (!fs.existsSync(artifactPath)) {
        if (done) findings.push(finding('error', 'lifecycle-evidence-missing', `${ticketId}/${phase} is missing for a Done ticket.`));
        continue;
      }
      try {
        readAndValidateWorkerLifecycleArtifact(artifactPath, phase, ticketId, acceptance);
      } catch (error) {
        findings.push(finding('error', 'lifecycle-evidence-invalid', error instanceof Error ? error.message : String(error)));
      }
    }
  }
  if (!findings.some((entry) => entry.code.startsWith('lifecycle-'))) {
    findings.push(finding('info', 'lifecycle-evidence-valid', 'Present worker lifecycle evidence is valid.'));
  }
  return findings;
}

function appendReadinessHistory(sessionDir: string, report: ReadinessReport, limit: number): void {
  const historyPath = path.join(sessionDir, 'readiness-history.json');
  const existing = readJsonFile<ReadinessHistory>(historyPath, { schema_version: 1, cycles: [] });
  const cycles = Array.isArray(existing?.cycles) ? existing.cycles : [];
  atomicWriteJson(historyPath, {
    schema_version: 1,
    cycles: [...cycles, report].slice(-Math.max(1, limit)),
  });
}

export function checkReadiness(sessionDir: string, options: CheckReadinessOptions = {}): ReadinessReport {
  const resolvedSessionDir = path.resolve(sessionDir);
  const runtimeRoot = options.runtimeRoot || path.resolve(new URL('../..', import.meta.url).pathname);
  const checkedAt = (options.now || (() => new Date().toISOString()))();
  const findings: ReadinessFinding[] = [...checkRuntimeLayout(runtimeRoot)];
  let state: PersistedState | null = null;
  try {
    assertSchemaVersionDeployParity();
    state = readJsonStrict<PersistedState>(path.join(resolvedSessionDir, 'state.json'));
    if (Number(state.schema_version) !== RUNTIME_STATE_SCHEMA_VERSION) {
      findings.push(finding('error', 'state-schema-invalid', `state.json schema ${state.schema_version} does not equal ${RUNTIME_STATE_SCHEMA_VERSION}.`));
    } else {
      findings.push(finding('info', 'state-schema-valid', `State schema ${state.schema_version} matches the deployed manifest.`));
    }
  } catch (error) {
    findings.push(finding('error', 'state-schema-invalid', error instanceof Error ? error.message : String(error)));
  }

  const workingDir = typeof state?.working_dir === 'string' ? state.working_dir : '';
  if (workingDir) findings.push(...checkGitTree(workingDir));
  else findings.push(finding('error', 'working-dir-missing', 'Session state has no working_dir.'));

  const manifestPath = path.join(resolvedSessionDir, 'refinement_manifest.json');
  let manifest: RefinementManifest = { tickets: [] };
  try {
    manifest = readJsonStrict<RefinementManifest>(manifestPath);
    const issues = validateRefinementManifest(structuredClone(manifest));
    if (issues.length) {
      for (const issue of issues) findings.push(finding('error', 'refinement-manifest-invalid', issue));
    } else {
      findings.push(finding('info', 'refinement-manifest-valid', `${manifest.tickets.length} refined ticket(s) passed validation.`));
    }
  } catch (error) {
    findings.push(finding('error', 'refinement-manifest-invalid', error instanceof Error ? error.message : String(error)));
  }

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  const materializedIds = new Set(listTicketFiles(resolvedSessionDir)
    .map((filePath) => parseTicketFile(filePath)?.id)
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeTicketId(value)));
  for (const ticket of tickets) {
    const ticketId = normalizeTicketId(ticket.id || ticket.title, 'ticket');
    if (!materializedIds.has(ticketId)) findings.push(finding('error', 'ticket-file-missing', `No materialized ticket file exists for ${ticketId}.`));
    const scope = resolveTicketScope(ticket);
    if (scope.error) findings.push(finding('error', 'scope-contract-invalid', `${ticketId}: ${scope.error}`));
    if (workingDir) {
      try {
        assertTicketVerificationReady({
          ticket,
          config: loadConfig() as unknown as ConfigVerificationInput,
          ambientEnv: options.env || process.env,
          cwd: workingDir,
        });
      } catch (error) {
        findings.push(finding('error', 'verification-preflight-failed', `${ticketId}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }
  if (workingDir) {
    const scopeAudit = auditPersistedScopeForCitadel(resolvedSessionDir, workingDir);
    if (scopeAudit) findings.push(finding('error', 'scope-contract-stale', scopeAudit));
  }

  try {
    assertQualityBaselineFresh(state?.quality_baseline, workingDir);
    findings.push(finding('info', 'quality-baseline-fresh', 'Persisted quality baseline matches HEAD and the current command contract.'));
  } catch (error) {
    findings.push(finding('error', 'quality-baseline-not-ready', error instanceof Error ? error.message : String(error)));
  }

  for (const command of ['git', 'node', loadConfig().runtime.command, ...(state?.tmux_mode === true ? ['tmux'] : [])]) {
    if (!commandAvailable(command)) findings.push(finding('error', 'required-tool-missing', `${command} is unavailable or failed --version.`));
  }

  const circuit = loadCircuitState(resolvedSessionDir);
  if (!canExecute(circuit)) findings.push(finding('error', 'circuit-open', circuit.reason || 'Circuit breaker is OPEN.'));
  else findings.push(finding('info', 'circuit-closed', `Circuit breaker is ${circuit.state}.`));
  if (state?.recovery_required === true || state?.orphan_child_pid) {
    findings.push(finding('error', 'recovery-required', String(state.recovery_reason || `orphan child ${state.orphan_child_pid} requires recovery`)));
  }
  if (state?.active === true) findings.push(finding('error', 'session-active', 'Session is already active; readiness must be checked before a new launch.'));

  findings.push(...checkLifecycle(resolvedSessionDir, tickets));
  const citadelPath = path.join(resolvedSessionDir, 'citadel-report.json');
  const citadelRequired = state?.step === 'complete' || state?.pipeline_phase === 'citadel';
  if (fs.existsSync(citadelPath)) {
    try {
      const report = readJsonStrict<Record<string, unknown>>(citadelPath);
      validateCitadelReport(report, String(report.reviewed_range || ''), deriveCitadelAcceptanceCriteria(resolvedSessionDir));
      findings.push(finding('info', 'citadel-evidence-valid', 'Current Citadel report has complete acceptance-criteria evidence.'));
    } catch (error) {
      findings.push(finding('error', 'citadel-evidence-invalid', error instanceof Error ? error.message : String(error)));
    }
  } else if (citadelRequired) {
    findings.push(finding('error', 'citadel-evidence-missing', 'Terminal/Citadel state has no citadel-report.json.'));
  } else {
    findings.push(finding('info', 'citadel-evidence-pending', 'Citadel evidence is not required at the current pre-run phase.'));
  }

  const report: ReadinessReport = {
    schema_version: 1,
    checked_at: checkedAt,
    session_dir: resolvedSessionDir,
    ready: !findings.some((entry) => entry.severity === 'error'),
    findings,
  };
  appendReadinessHistory(resolvedSessionDir, report, options.historyLimit ?? 20);
  return report;
}
