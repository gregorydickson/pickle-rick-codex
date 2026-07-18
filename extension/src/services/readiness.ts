import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { canExecute, loadCircuitState } from './circuit-breaker.js';
import { deriveCitadelAcceptanceCriteria, validateCitadelReport } from './citadel.js';
import { assertQualityBaselineFresh, resolveTicketScope } from './execution-gate.js';
import { normalizeMetricTargetContract, normalizeMetricTolerance } from './metric-convergence.js';
import { captureProtectedPathManifest } from './microverse-protection.js';
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

function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  const versionArgs = command === 'tmux' ? ['-V'] : ['--version'];
  const result = spawnSync(command, versionArgs, { encoding: 'utf8', timeout: 10_000, env });
  return !result.error && result.status === 0;
}

const ADVANCED_LOOP_MODES = new Set(['microverse', 'anatomy-park', 'szechuan-sauce']);

function validatePositiveInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
}

function validateAdvancedLoopConfig(
  sessionDir: string,
  workingDir: string,
): { advanced: boolean; findings: ReadinessFinding[] } {
  const loopConfigPath = path.join(sessionDir, 'loop_config.json');
  if (!fs.existsSync(loopConfigPath)) return { advanced: false, findings: [] };

  const findings: ReadinessFinding[] = [];
  try {
    const config = readJsonStrict<Record<string, unknown>>(loopConfigPath);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('loop_config.json must contain an object.');
    }
    const mode = typeof config.mode === 'string' ? config.mode.trim() : '';
    if (!ADVANCED_LOOP_MODES.has(mode)) {
      throw new Error(`loop_config.json mode must be one of ${[...ADVANCED_LOOP_MODES].join(', ')}.`);
    }

    if (config.stall_limit !== undefined && config.stall_limit !== null) {
      validatePositiveInteger(config.stall_limit, 'stall_limit');
    }

    if (mode === 'microverse') {
      const metric = typeof config.metric === 'string' ? config.metric.trim() : '';
      const goal = typeof config.goal === 'string' ? config.goal.trim() : '';
      if (Boolean(metric) === Boolean(goal)) {
        throw new Error('Microverse loop_config.json must declare exactly one non-empty metric or goal.');
      }
      const direction = config.direction ?? 'higher';
      normalizeMetricTolerance(config.tolerance);
      if (config.worker_failure_limit !== undefined && config.worker_failure_limit !== null) {
        validatePositiveInteger(config.worker_failure_limit, 'worker_failure_limit');
      }
      if (config.metric_timeout_seconds !== undefined && config.metric_timeout_seconds !== null) {
        const timeout = Number(config.metric_timeout_seconds);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error('metric_timeout_seconds must be a positive finite number.');
        }
      }
      const target = normalizeMetricTargetContract(direction, config.target, config.target_relation);
      if (!metric && target.target !== null) {
        throw new Error('Free-form Microverse goal sessions cannot declare a numeric metric target.');
      }
      if (config.protected_paths !== undefined && config.protected_paths !== null
          && (!Array.isArray(config.protected_paths)
            || config.protected_paths.some((entry) => typeof entry !== 'string'))) {
        throw new Error('protected_paths must be an array of repository-relative path or glob strings.');
      }
      const protectedManifest = captureProtectedPathManifest(workingDir, config.protected_paths);
      findings.push(finding(
        'info',
        'advanced-loop-protection-valid',
        `Microverse protected-path contract has ${protectedManifest.patterns.length} pattern(s) covering ${Object.keys(protectedManifest.files).length} current path(s).`,
      ));
      findings.push(finding(
        'info',
        'advanced-loop-target-valid',
        target.target === null
          ? 'Measured Microverse has no numeric stop target.'
          : `Measured Microverse target is ${target.target_relation} ${target.target}.`,
      ));
    } else {
      const target = typeof config.target === 'string' ? config.target.trim() : '';
      if (!target) throw new Error(`${mode} loop_config.json requires a non-empty target path.`);
      if (!fs.existsSync(path.resolve(target))) {
        throw new Error(`${mode} target does not exist: ${target}`);
      }
    }

    findings.push(finding('info', 'advanced-loop-config-valid', `${mode} loop_config.json passed readiness validation.`));
  } catch (error) {
    findings.push(finding('error', 'advanced-loop-config-invalid', error instanceof Error ? error.message : String(error)));
  }
  return { advanced: true, findings };
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

  let manifest: RefinementManifest = { tickets: [] };
  const advancedProfile = validateAdvancedLoopConfig(resolvedSessionDir, workingDir);
  findings.push(...advancedProfile.findings);
  if (advancedProfile.advanced) {
    if (state?.tmux_mode !== true) {
      findings.push(finding('error', 'advanced-loop-state-invalid', 'Advanced-loop readiness requires state.tmux_mode=true.'));
    } else {
      findings.push(finding('info', 'advanced-loop-state-valid', 'Session state is prepared for detached advanced-loop execution.'));
    }
    findings.push(
      finding('info', 'refinement-manifest-not-applicable', 'Advanced-loop sessions do not use refinement manifests.'),
      finding('info', 'ticket-files-not-applicable', 'Advanced-loop sessions do not materialize ticket files.'),
      finding('info', 'scope-contract-not-applicable', 'Advanced-loop mutation scope is enforced by its loop configuration and runtime.'),
      finding('info', 'quality-baseline-not-applicable', 'Advanced-loop sessions use loop-specific metric or review evidence instead of a ticket quality baseline.'),
    );
  } else {
    const manifestPath = path.join(resolvedSessionDir, 'refinement_manifest.json');
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
  }

  const toolEnv = options.env || process.env;
  for (const command of ['git', 'node', loadConfig().runtime.command, ...(state?.tmux_mode === true ? ['tmux'] : [])]) {
    const versionFlag = command === 'tmux' ? '-V' : '--version';
    if (!commandAvailable(command, toolEnv)) findings.push(finding('error', 'required-tool-missing', `${command} is unavailable or failed ${versionFlag}.`));
  }

  const circuit = loadCircuitState(resolvedSessionDir);
  if (!canExecute(circuit)) findings.push(finding('error', 'circuit-open', circuit.reason || 'Circuit breaker is OPEN.'));
  else findings.push(finding('info', 'circuit-closed', `Circuit breaker is ${circuit.state}.`));
  if (state?.recovery_required === true || state?.orphan_child_pid) {
    findings.push(finding('error', 'recovery-required', String(state.recovery_reason || `orphan child ${state.orphan_child_pid} requires recovery`)));
  }
  if (state?.active === true) findings.push(finding('error', 'session-active', 'Session is already active; readiness must be checked before a new launch.'));

  if (advancedProfile.advanced) {
    findings.push(finding('info', 'lifecycle-evidence-not-applicable', 'Advanced-loop iterations use loop-specific evidence rather than ticket worker lifecycle artifacts.'));
  } else {
    findings.push(...checkLifecycle(resolvedSessionDir, Array.isArray(manifest.tickets) ? manifest.tickets : []));
  }
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
