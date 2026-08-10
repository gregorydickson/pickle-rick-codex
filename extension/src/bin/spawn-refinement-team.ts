#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../services/activity-logger.js';
import { assertCodexSucceeded, runCodexExecMonitored } from '../services/codex.js';
import { loadConfig } from '../services/config.js';
import {
  captureProcessLivenessIdentity,
  inspectProcessLivenessIdentity,
  reapRecordedLiveProcessGroup,
  reapRecordedProcessGroupFromMember,
  type PersistedProcessIdentity,
} from '../services/orphan-reaper.js';
import { atomicWriteFile, atomicWriteJson, readJsonFile, readTextFile } from '../services/pickle-utils.js';
import {
  buildRefinementAnalystPrompt,
  buildRefinementSynthesisPrompt,
  buildRefinePrdPrompt,
} from '../services/prompts.js';
import {
  assertRefinementInputIdentity,
  captureRefinementInputIdentity,
  createRefinementWorkerDir,
  hasReusableAnalystCheckpoint,
  isNonBlankArtifact,
  pruneRefinementWorkerHistory,
  promoteAnalystCheckpoint,
  reconcileVerifiedRefinementRepositoryAdvance,
  refinementAcceptancePath,
  refinementRepositoryAdvancePath,
  clearRefinementRepositoryAdvance,
  writeRefinementAcceptance,
} from '../services/refinement-artifacts.js';
import { appendHistory } from '../services/session.js';
import { acquireSessionOperation, assertNoForeignTmuxLaunch } from '../services/session-operation.js';
import { StateManager } from '../services/state-manager.js';
import type { PersistedState } from '../services/state-manager.js';
import {
  enrichRefinementManifest,
  refinementTicketMaterializationPaths,
  validateRefinementManifest,
  restructureTicketFilesInTransaction,
} from '../services/tickets.js';
import { recoverInterruptedTicketTransaction, runTicketTransaction } from '../services/ticket-transaction.js';
import type {
  CodexExecOptions,
  CodexSpawnResult,
  CodexUsage,
  ConfigVerificationInput,
  RefinementManifest,
} from '../types/index.js';

interface AnalystSpec {
  role: string;
  focus: string;
  analysisPath: string;
  messagePath: string;
}

export interface RefinePrdOptions {
  timeoutMs?: number;
  runStartedAtMs?: number;
  beforePromotionCommit?: () => void;
}

const REFINEMENT_LEAF_ENV = 'PICKLE_REFINEMENT_LEAF';
const REFINEMENT_WORKER_ENV: NodeJS.ProcessEnv = { [REFINEMENT_LEAF_ENV]: '1' };
const REFINEMENT_EXEC_ARGS = ['--sandbox', 'workspace-write'];
const ANALYST_ATTEMPTS = 2;
const FINAL_ARTIFACT_ATTEMPTS = 2;
const MAX_REFINEMENT_ARTIFACT_BYTES = 2_000_000;
const MAX_ANALYST_REPORT_BYTES = 256_000;
const MAX_REFINEMENT_TICKETS = 200;
const MAX_REPAIR_DIAGNOSTICS = 50;
const MAX_REPAIR_DIAGNOSTIC_CHARS = 500;
const MAX_REPAIR_PROMPT_CHARS = 32_768;

class RefinementCancelledError extends Error {
  constructor() {
    super('PRD refinement cancelled.');
    this.name = 'RefinementCancelledError';
  }
}

class RefinementAnalystError extends Error {
  readonly results: CodexSpawnResult[];

  constructor(message: string, results: CodexSpawnResult[], options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'RefinementAnalystError';
    this.results = results;
  }
}

function hasPromiseToken(text: string, token: string): boolean {
  return new RegExp(`<promise>\\s*${token}\\s*</promise>`).test(text || '');
}

function remainingAttemptTimeout(deadlineMs: number, perAttemptTimeoutMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('PRD refinement exceeded its overall retry deadline.');
  return Math.max(1, Math.min(perAttemptTimeoutMs, remaining));
}

function artifactSizeIssue(
  filePath: string,
  label: string,
  maxBytes: number = MAX_REFINEMENT_ARTIFACT_BYTES,
): string | null {
  try {
    const bytes = fs.statSync(filePath).size;
    return bytes > maxBytes
      ? `${label} exceeds the ${maxBytes}-byte refinement artifact limit`
      : null;
  } catch {
    return `${label} is missing`;
  }
}

function isBoundedNonBlankArtifact(filePath: string, maxBytes: number): boolean {
  return artifactSizeIssue(filePath, path.basename(filePath), maxBytes) === null
    && isNonBlankArtifact(filePath);
}

function isBoundedArtifact(filePath: string, maxBytes: number): boolean {
  return artifactSizeIssue(filePath, path.basename(filePath), maxBytes) === null;
}

function boundedDiagnostics(issues: string[]): string[] {
  return issues
    .slice(0, MAX_REPAIR_DIAGNOSTICS)
    .map((issue) => issue.slice(0, MAX_REPAIR_DIAGNOSTIC_CHARS));
}

function hasCompleteRefinementOutput(
  result: CodexSpawnResult,
  refinedPath: string,
  manifestPath: string,
): boolean {
  return result.exitCode === 0 &&
    isBoundedNonBlankArtifact(refinedPath, MAX_REFINEMENT_ARTIFACT_BYTES) &&
    isBoundedArtifact(manifestPath, MAX_REFINEMENT_ARTIFACT_BYTES) &&
    hasPromiseToken(result.lastMessage, 'REFINEMENT_COMPLETE');
}

function hasCompleteAnalystOutput(result: CodexSpawnResult, spec: AnalystSpec): boolean {
  return result.exitCode === 0 &&
    isBoundedNonBlankArtifact(spec.analysisPath, MAX_ANALYST_REPORT_BYTES) &&
    hasPromiseToken(result.lastMessage, 'ANALYST_COMPLETE');
}

function analystSpecs(sessionDir: string): AnalystSpec[] {
  return [
    {
      role: 'requirements-gaps',
      focus: 'requirements completeness, missing acceptance criteria, and contradictory scope',
      analysisPath: path.join(sessionDir, 'analyst-requirements.md'),
      messagePath: path.join(sessionDir, 'analyst-requirements.last-message.txt'),
    },
    {
      role: 'codebase-integration',
      focus: 'integration points, likely file touch points, interfaces, and verification realism',
      analysisPath: path.join(sessionDir, 'analyst-codebase.md'),
      messagePath: path.join(sessionDir, 'analyst-codebase.last-message.txt'),
    },
    {
      role: 'risk-and-sequencing',
      focus: 'execution order, risk reduction, dependency handling, and ticket boundaries',
      analysisPath: path.join(sessionDir, 'analyst-risk.md'),
      messagePath: path.join(sessionDir, 'analyst-risk.last-message.txt'),
    },
  ];
}

function refinementChildIdentities(state: PersistedState): PersistedProcessIdentity[] {
  if (!Array.isArray(state.refinement_child_identities)) return [];
  return state.refinement_child_identities.filter((entry): entry is PersistedProcessIdentity => Boolean(
    entry
      && typeof entry === 'object'
      && Number.isInteger(Number((entry as PersistedProcessIdentity).pid))
      && Number((entry as PersistedProcessIdentity).pid) > 0
      && Number.isInteger(Number((entry as PersistedProcessIdentity).pgid))
      && typeof (entry as PersistedProcessIdentity).start_time === 'string'
      && typeof (entry as PersistedProcessIdentity).fingerprint === 'string',
  ));
}

function isRefinementCancelled(manager: StateManager, statePath: string): boolean {
  const current = manager.read(statePath);
  return current.last_exit_reason === 'cancelled' || Boolean(current.cancel_requested_at);
}

function terminateSpawnedProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch {
    // The child may have exited before ownership persistence failed.
  }
  const killTimer = setTimeout(() => {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      // The child exited after TERM.
    }
  }, 1_000);
  killTimer.unref?.();
}

function processGroupIsAbsent(pgid: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function reconcileQuiescentRefinementChildren(manager: StateManager, statePath: string): void {
  manager.update(statePath, (current) => {
    const recorded = refinementChildIdentities(current);
    const quiescentGroups = new Set<number>();
    for (const pgid of new Set(recorded.map((identity) => identity.pgid))) {
      const group = recorded.filter((identity) => identity.pgid === pgid);
      if (group.every((identity) => inspectProcessLivenessIdentity(identity) === 'not-running')
        && processGroupIsAbsent(pgid)) quiescentGroups.add(pgid);
    }
    const identities = recorded.filter((identity) => !quiescentGroups.has(identity.pgid));
    current.refinement_child_identities = identities;
    const next = identities.findLast((identity) => identity.pid === identity.pgid) || null;
    current.active_child_pid = next?.pid || null;
    current.active_child_kind = next ? 'refinement' : null;
    current.active_child_command = next ? 'refinement-worker' : null;
    current.active_child_identity = next;
    return current;
  });
}

function recoverRefinementChildren(manager: StateManager, statePath: string): void {
  const state = manager.read(statePath);
  const identities = refinementChildIdentities(state);
  const groups = new Map<number, PersistedProcessIdentity[]>();
  for (const identity of identities) {
    const group = groups.get(identity.pgid) || [];
    group.push(identity);
    groups.set(identity.pgid, group);
  }
  for (const group of groups.values()) {
    const leader = group.find((identity) => identity.pid === identity.pgid);
    if (leader) {
      const result = reapRecordedLiveProcessGroup(leader);
      if (result.status !== 'reaped' && result.status !== 'not-running') {
        throw new Error(`Cannot recover refinement broker ${leader.pid}: ${result.reason}`);
      }
    }
    for (const identity of group) {
      const liveness = inspectProcessLivenessIdentity(identity);
      if (liveness === 'not-running') continue;
      if (liveness === 'reused') {
        throw new Error(`Cannot recover refinement worker ${identity.pid}: immutable identity was reused`);
      }
      const result = identity.pid === identity.pgid
        ? reapRecordedLiveProcessGroup(identity)
        : reapRecordedProcessGroupFromMember(identity);
      if (result.status !== 'reaped' && result.status !== 'not-running') {
        throw new Error(`Cannot recover refinement worker ${identity.pid}: ${result.reason}`);
      }
    }
    if (!processGroupIsAbsent(group[0].pgid)) {
      throw new Error(`Cannot recover refinement process group ${group[0].pgid}: group remains live without an exact signal authority`);
    }
  }
  if (identities.length === 0 && !state.refinement_child_identities) return;
  const controllerIdentity = captureProcessLivenessIdentity(process.pid);
  if (!controllerIdentity) throw new Error('Cannot attest refinement controller identity during recovery.');
  manager.update(statePath, (current) => {
    current.refinement_child_identities = [];
    current.active_child_pid = null;
    current.active_child_kind = null;
    current.active_child_command = null;
    current.active_child_identity = null;
    current.active_child_controller_pid = process.pid;
    current.active_child_controller_identity = controllerIdentity;
    return current;
  });
}

async function runRefinementCodex(
  options: CodexExecOptions,
  manager: StateManager,
  statePath: string,
  label: string,
  localCancelCheck: () => boolean = () => false,
): Promise<CodexSpawnResult> {
  let brokerPid = 0;
  const controllerIdentity = captureProcessLivenessIdentity(process.pid);
  if (!controllerIdentity) throw new Error('Cannot attest refinement controller identity.');
  return await runCodexExecMonitored({
      ...options,
      telemetry: {
        sessionDir: path.dirname(statePath),
        ticketId: 'refinement',
        phase: label,
      },
      execArgs: REFINEMENT_EXEC_ARGS,
      skipGitRepoCheck: true,
      inheritConfiguredAddDirs: false,
      addDirs: [],
      env: { ...REFINEMENT_WORKER_ENV, ...(options.env || {}) },
      cancelCheck: () => localCancelCheck() || isRefinementCancelled(manager, statePath),
      onSpawn: (child, identity) => {
        brokerPid = Number(child.pid || 0);
        try {
          manager.update(statePath, (current) => {
            const identities = refinementChildIdentities(current)
              .filter((entry) => entry.pid !== brokerPid);
            identities.push(identity);
            current.refinement_child_identities = identities;
            current.active_child_pid = brokerPid || null;
            current.active_child_kind = 'refinement';
            current.active_child_command = label;
            current.active_child_identity = identity;
            current.active_child_controller_pid = process.pid;
            current.active_child_controller_identity = controllerIdentity;
            return current;
          });
        } catch (error) {
          terminateSpawnedProcess(brokerPid);
          throw error;
        }
        options.onSpawn?.(child, identity);
      },
      onTargetSpawn: (brokerIdentity, targetIdentity) => {
        manager.update(statePath, (current) => {
          const identities = refinementChildIdentities(current)
            .filter((entry) => entry.pid !== targetIdentity.pid);
          if (!identities.some((entry) => entry.pid === brokerIdentity.pid
            && entry.fingerprint === brokerIdentity.fingerprint)) {
            throw new Error('Refinement target cannot be published without its exact broker identity.');
          }
          identities.push(targetIdentity);
          current.refinement_child_identities = identities;
          return current;
        });
        options.onTargetSpawn?.(brokerIdentity, targetIdentity);
      },
      onDescendants: (brokerIdentity, targetIdentity, descendants) => {
        manager.update(statePath, (current) => {
          const identities = refinementChildIdentities(current);
          if (!identities.some((entry) => entry.fingerprint === brokerIdentity.fingerprint)
            || !identities.some((entry) => entry.fingerprint === targetIdentity.fingerprint)) {
            throw new Error('Refinement descendants cannot be published without broker and target identities.');
          }
          for (const descendant of descendants) {
            if (!identities.some((entry) => entry.fingerprint === descendant.fingerprint)) identities.push(descendant);
          }
          current.refinement_child_identities = identities;
          return current;
        });
        options.onDescendants?.(brokerIdentity, targetIdentity, descendants);
      },
      onDrain: (brokerIdentity, targetIdentity, descendants) => {
        manager.update(statePath, (current) => {
          const drainedFingerprints = new Set([brokerIdentity, targetIdentity, ...descendants]
            .map((identity) => identity.fingerprint));
          const identities = refinementChildIdentities(current)
            .filter((entry) => !drainedFingerprints.has(entry.fingerprint));
          current.refinement_child_identities = identities;
          const next = identities.findLast((entry) => entry.pid === entry.pgid) || null;
          current.active_child_pid = next?.pid || null;
          current.active_child_kind = next ? 'refinement' : null;
          current.active_child_command = next ? 'refinement-worker' : null;
          current.active_child_identity = next;
          current.active_child_controller_pid = process.pid;
          current.active_child_controller_identity = controllerIdentity;
          return current;
        });
        options.onDrain?.(brokerIdentity, targetIdentity, descendants);
      },
    });
}

async function runAnalyst(
  state: PersistedState,
  sessionDir: string,
  statePath: string,
  manager: StateManager,
  prdPath: string,
  spec: AnalystSpec,
  timeoutMs: number,
  deadlineMs: number,
  inputIdentity: ReturnType<typeof captureRefinementInputIdentity>,
): Promise<CodexSpawnResult[]> {
  if (hasReusableAnalystCheckpoint({
    prdPath,
    reportPath: spec.analysisPath,
    role: spec.role,
    workingDir: state.working_dir as string,
    maxBytes: MAX_ANALYST_REPORT_BYTES,
  })) {
    appendRefineLog(sessionDir, `Reusing ${spec.role} analyst checkpoint.`);
    return [];
  }

  const results: CodexSpawnResult[] = [];
  for (let attempt = 1; attempt <= ANALYST_ATTEMPTS; attempt += 1) {
    if (isRefinementCancelled(manager, statePath)) throw new RefinementCancelledError();
    const workerDir = createRefinementWorkerDir(sessionDir, `analyst-${spec.role}-${attempt}`);
    const candidateSpec: AnalystSpec = {
      ...spec,
      analysisPath: path.join(workerDir, 'analyst-report.md'),
      messagePath: path.join(workerDir, 'last-message.txt'),
    };
    const result = await runRefinementCodex({
      cwd: workerDir,
      prompt: buildRefinementAnalystPrompt({
        role: spec.role,
        focus: spec.focus,
        prdPath,
        analysisPath: candidateSpec.analysisPath,
        workingDir: state.working_dir as string,
      }),
      timeoutMs: remainingAttemptTimeout(deadlineMs, timeoutMs),
      outputLastMessagePath: candidateSpec.messagePath,
      progressArtifactPaths: [candidateSpec.analysisPath],
      cleanupPaths: [candidateSpec.analysisPath],
      successCheck: ({ lastMessage }) =>
        isBoundedNonBlankArtifact(candidateSpec.analysisPath, MAX_ANALYST_REPORT_BYTES)
        && hasPromiseToken(lastMessage, 'ANALYST_COMPLETE'),
    }, manager, statePath, `refinement-analyst:${spec.role}`);
    results.push(result);
    if (result.cancelled || isRefinementCancelled(manager, statePath)) throw new RefinementCancelledError();
    if (hasCompleteAnalystOutput(result, candidateSpec)) {
      const sizeIssue = artifactSizeIssue(
        candidateSpec.analysisPath,
        `${spec.role} analyst report`,
        MAX_ANALYST_REPORT_BYTES,
      );
      if (sizeIssue) throw new RefinementAnalystError(sizeIssue, results);
      assertRefinementInputIdentity(inputIdentity, {
        prdPath,
        workingDir: state.working_dir as string,
      });
      promoteAnalystCheckpoint({
        prdPath,
        candidateReportPath: candidateSpec.analysisPath,
        reportPath: spec.analysisPath,
        role: spec.role,
        workingDir: state.working_dir as string,
        inputIdentity,
      });
      atomicWriteFile(spec.messagePath, result.lastMessage);
      return results;
    }
    if (attempt < ANALYST_ATTEMPTS) {
      appendRefineLog(sessionDir, `${spec.role} analyst attempt ${attempt} failed; retrying once.`);
      continue;
    }
    try {
      assertCodexSucceeded(result, `Refinement analyst failed: ${spec.role}`);
    } catch (error) {
      throw new RefinementAnalystError(
        error instanceof Error ? error.message : String(error),
        results,
        { cause: error },
      );
    }
    throw new RefinementAnalystError(
      `Refinement analyst failed: ${spec.role} did not complete its artifact contract`,
      results,
    );
  }
  throw new Error(`Refinement analyst failed: ${spec.role} attempts exhausted`);
}

interface AcceptedFinalArtifacts {
  manifest: RefinementManifest;
  refinedPath: string;
  manifestPath: string;
  results: CodexSpawnResult[];
}

interface AnalystOutcome {
  spec: AnalystSpec;
  results: CodexSpawnResult[];
  error: Error | null;
}

function evaluateFinalArtifacts(
  refinedPath: string,
  manifestPath: string,
  config: ConfigVerificationInput,
): { manifest: RefinementManifest | null; issues: string[] } {
  const issues: string[] = [];
  const refinedSizeIssue = artifactSizeIssue(refinedPath, 'prd_refined.md');
  const manifestSizeIssue = artifactSizeIssue(manifestPath, 'refinement_manifest.json');
  if (refinedSizeIssue) issues.push(refinedSizeIssue);
  if (manifestSizeIssue) issues.push(manifestSizeIssue);
  if (issues.length > 0) return { manifest: null, issues };
  if (!isNonBlankArtifact(refinedPath)) {
    issues.push('prd_refined.md must contain non-empty Markdown');
  }
  const rawManifest = readJsonFile<RefinementManifest>(manifestPath, null);
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest) || !Array.isArray(rawManifest.tickets)) {
    issues.push('refinement_manifest.json must be a valid object with a tickets array');
    return { manifest: null, issues };
  }
  if (rawManifest.tickets.length > MAX_REFINEMENT_TICKETS) {
    issues.push(`refinement_manifest.json exceeds the ${MAX_REFINEMENT_TICKETS}-ticket limit`);
    return { manifest: null, issues };
  }
  issues.push(...validateRefinementManifest(rawManifest, { fresh: true }));
  const manifest = enrichRefinementManifest(rawManifest, config).manifest;
  return { manifest, issues: [...new Set(issues)] };
}

async function runFinalArtifactAttempts(input: {
  label: 'synthesis' | 'fallback';
  state: PersistedState;
  statePath: string;
  manager: StateManager;
  sessionDir: string;
  prdPath: string;
  timeoutMs: number;
  deadlineMs: number;
  config: ConfigVerificationInput;
  buildPrompt: (refinedPath: string, manifestPath: string) => string;
}): Promise<AcceptedFinalArtifacts> {
  const results: CodexSpawnResult[] = [];
  let priorIssues: string[] = [];
  let priorRefinedPath = '';
  let priorManifestPath = '';

  for (let attempt = 1; attempt <= FINAL_ARTIFACT_ATTEMPTS; attempt += 1) {
    if (isRefinementCancelled(input.manager, input.statePath)) throw new RefinementCancelledError();
    const workerDir = createRefinementWorkerDir(input.sessionDir, `${input.label}-${attempt}`);
    const refinedPath = path.join(workerDir, 'prd_refined.md');
    const manifestPath = path.join(workerDir, 'refinement_manifest.json');
    const outputLastMessagePath = path.join(workerDir, 'last-message.txt');
    const basePrompt = input.buildPrompt(refinedPath, manifestPath);
    const prompt = attempt === 1
      ? basePrompt
      : [
        basePrompt,
        `Bounded repair attempt ${attempt} of ${FINAL_ARTIFACT_ATTEMPTS}.`,
        `The prior candidate was rejected by the production validator: ${JSON.stringify(priorIssues)}.`,
        priorRefinedPath ? `Prior rejected refined PRD (read-only evidence): ${priorRefinedPath}` : null,
        priorManifestPath ? `Prior rejected manifest (read-only evidence): ${priorManifestPath}` : null,
        'Recreate both candidate artifacts and correct every listed issue. Do not merely restate the diagnostics.',
      ].filter(Boolean).join('\n\n');
    if (prompt.length > MAX_REPAIR_PROMPT_CHARS) {
      throw new Error(`Refinement repair prompt exceeded ${MAX_REPAIR_PROMPT_CHARS} characters.`);
    }
    const result = await runRefinementCodex({
      cwd: workerDir,
      prompt,
      timeoutMs: remainingAttemptTimeout(input.deadlineMs, input.timeoutMs),
      outputLastMessagePath,
      progressArtifactPaths: [refinedPath, manifestPath],
      cleanupPaths: [refinedPath, manifestPath],
      successCheck: ({ lastMessage }) =>
        isBoundedNonBlankArtifact(refinedPath, MAX_REFINEMENT_ARTIFACT_BYTES)
        && isBoundedArtifact(manifestPath, MAX_REFINEMENT_ARTIFACT_BYTES)
        && hasPromiseToken(lastMessage, 'REFINEMENT_COMPLETE'),
    }, input.manager, input.statePath, `refinement-${input.label}`);
    results.push(result);
    if (result.cancelled || isRefinementCancelled(input.manager, input.statePath)) {
      throw new RefinementCancelledError();
    }

    if (hasCompleteRefinementOutput(result, refinedPath, manifestPath)) {
      const evaluated = evaluateFinalArtifacts(refinedPath, manifestPath, input.config);
      if (evaluated.manifest && evaluated.issues.length === 0) {
        return { manifest: evaluated.manifest, refinedPath, manifestPath, results };
      }
      priorIssues = boundedDiagnostics(evaluated.issues);
    } else {
      priorIssues = boundedDiagnostics([
        result.timedOut
          ? `${input.label} worker timed out before completing its artifact contract`
          : `${input.label} worker exited ${result.exitCode} before completing its artifact contract`,
      ]);
    }
    priorRefinedPath = refinedPath;
    priorManifestPath = manifestPath;
    atomicWriteJson(path.join(workerDir, 'rejection.json'), {
      schema_version: 1,
      attempt,
      label: input.label,
      issues: priorIssues,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
    });

    if (attempt < FINAL_ARTIFACT_ATTEMPTS) {
      appendRefineLog(
        input.sessionDir,
        `${input.label} attempt ${attempt} rejected; retrying once from preserved checkpoints: ${priorIssues.join('; ')}`,
      );
      continue;
    }
    assertCodexSucceeded(result, `PRD refinement ${input.label} failed`);
    throw new Error(`Refinement manifest rejected after bounded ${input.label} repair: ${priorIssues.join('; ')}`);
  }
  throw new Error(`PRD refinement ${input.label} attempts exhausted`);
}

async function runSynthesis(
  state: PersistedState,
  statePath: string,
  manager: StateManager,
  sessionDir: string,
  prdPath: string,
  timeoutMs: number,
  deadlineMs: number,
  config: ConfigVerificationInput,
): Promise<AcceptedFinalArtifacts> {
  const analystReports = analystSpecs(sessionDir).map((spec) => spec.analysisPath);
  return await runFinalArtifactAttempts({
    label: 'synthesis',
    state,
    statePath,
    manager,
    sessionDir,
    prdPath,
    timeoutMs,
    deadlineMs,
    config,
    buildPrompt: (refinedPath, manifestPath) => buildRefinementSynthesisPrompt({
      sessionDir,
      prdPath,
      analystReports,
      workingDir: state.working_dir as string,
      refinedPath,
      manifestPath,
    }),
  });
}

function sumUsage(results: CodexSpawnResult[]): CodexUsage {
  return results.reduce((acc, result) => {
    acc.input_tokens += Number(result?.usage?.input_tokens || 0);
    acc.output_tokens += Number(result?.usage?.output_tokens || 0);
    acc.cache_creation_input_tokens += Number(result?.usage?.cache_creation_input_tokens || 0);
    acc.cache_read_input_tokens += Number(result?.usage?.cache_read_input_tokens || 0);
    return acc;
  }, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
}

function appendRefineLog(sessionDir: string, message: string): void {
  fs.appendFileSync(path.join(sessionDir, 'refine.log'), `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function markRefinePhase(manager: StateManager, statePath: string, sessionDir: string, step: string, message: string): void {
  manager.update(statePath, (current) => {
    current.step = step;
    return current;
  });
  appendRefineLog(sessionDir, message);
  console.error(`[refine] ${message}`);
}

export function promoteRefinementArtifacts(input: {
  sessionDir: string;
  statePath: string;
  manager: StateManager;
  refinedPrd: string;
  manifest: RefinementManifest;
  inputIdentity?: ReturnType<typeof captureRefinementInputIdentity>;
  workingDir?: string;
  beforeCommit?: () => void;
}): void {
  const canonicalRefinedPath = path.join(input.sessionDir, 'prd_refined.md');
  try {
    runTicketTransaction(input.sessionDir, 'promote-refinement', () => [
      canonicalRefinedPath,
      refinementAcceptancePath(input.sessionDir),
      refinementRepositoryAdvancePath(input.sessionDir),
      input.statePath,
      ...refinementTicketMaterializationPaths(input.sessionDir, input.manifest),
    ], () => {
      if (isRefinementCancelled(input.manager, input.statePath)) throw new RefinementCancelledError();
      if (input.inputIdentity && input.workingDir) {
        assertRefinementInputIdentity(input.inputIdentity, {
          prdPath: path.join(input.sessionDir, 'prd.md'),
          workingDir: input.workingDir,
        });
      }
      atomicWriteFile(canonicalRefinedPath, input.refinedPrd);
      restructureTicketFilesInTransaction(input.sessionDir, input.manifest);
      clearRefinementRepositoryAdvance(input.sessionDir);
      writeRefinementAcceptance(input.sessionDir, {
        workingDir: input.workingDir,
        expectedInputIdentity: input.inputIdentity,
      });
      input.beforeCommit?.();
      input.manager.update(input.statePath, (current) => {
        if (current.last_exit_reason === 'cancelled' || current.cancel_requested_at) {
          throw new RefinementCancelledError();
        }
        current.step = 'research';
        current.refinement_child_identities = [];
        current.active_child_controller_pid = null;
        current.active_child_controller_identity = null;
        appendHistory(current, 'refine');
        return current;
      });
    });
  } catch (error) {
    if (error instanceof RefinementCancelledError) {
      input.manager.update(input.statePath, (current) => {
        current.last_exit_reason = 'cancelled';
        current.cancel_requested_at ||= new Date().toISOString();
        return current;
      });
    }
    throw error;
  }
}

async function refinePrdWithLease(sessionDir: string, options: RefinePrdOptions = {}): Promise<RefinementManifest> {
  const prdPath = path.join(sessionDir, 'prd.md');
  if (!fs.existsSync(prdPath)) {
    throw new Error(`PRD not found: ${prdPath}`);
  }

  const statePath = path.join(sessionDir, 'state.json');
  const manager = new StateManager();
  recoverRefinementChildren(manager, statePath);
  pruneRefinementWorkerHistory(sessionDir);
  const state = manager.read(statePath);
  const config = loadConfig();
  const workingDir = state.working_dir as string;
  const prdSizeIssue = artifactSizeIssue(prdPath, 'prd.md');
  if (prdSizeIssue) throw new Error(prdSizeIssue);
  const inputIdentity = captureRefinementInputIdentity({ prdPath, workingDir });
  const inputDir = createRefinementWorkerDir(sessionDir, 'run-input');
  const prdSnapshotPath = path.join(inputDir, 'prd.md');
  atomicWriteFile(prdSnapshotPath, readTextFile(prdPath, '') || '');
  const timeoutMs = options.timeoutMs ?? Math.max(
    config.defaults.refinement_timeout_seconds,
    Number(state.worker_timeout_seconds || 0),
    900,
  ) * 1000;
  const overallDeadlineMs = Date.now() + (timeoutMs * 4);
  const refinementResults: CodexSpawnResult[] = [];

  markRefinePhase(manager, statePath, sessionDir, 'refine:analysts', 'Starting analyst fanout.');
  const analystOutcomes: AnalystOutcome[] = await Promise.all(analystSpecs(sessionDir).map(async (spec) => {
    try {
      return {
        spec,
        results: await runAnalyst(
          state,
          sessionDir,
          statePath,
          manager,
          prdSnapshotPath,
          spec,
          timeoutMs,
          overallDeadlineMs,
          inputIdentity,
        ),
        error: null,
      };
    } catch (error) {
      return {
        spec,
        results: error instanceof RefinementAnalystError ? error.results : [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }));
  if (analystOutcomes.some((outcome) => outcome.error instanceof RefinementCancelledError)
      || isRefinementCancelled(manager, statePath)) {
    throw new RefinementCancelledError();
  }
  refinementResults.push(...analystOutcomes.flatMap((outcome) => outcome.results));
  assertRefinementInputIdentity(inputIdentity, { prdPath, workingDir });

  let accepted: AcceptedFinalArtifacts;
  const failedAnalysts = analystOutcomes.filter((outcome) => outcome.error);
  if (failedAnalysts.length === 0) {
    appendRefineLog(sessionDir, 'Analyst fanout complete.');
    markRefinePhase(manager, statePath, sessionDir, 'refine:synthesis', 'Starting refinement synthesis.');
    try {
      accepted = await runSynthesis(
        state,
        statePath,
        manager,
        sessionDir,
        prdSnapshotPath,
        timeoutMs,
        overallDeadlineMs,
        config as unknown as ConfigVerificationInput,
      );
    } catch (error) {
      if (error instanceof RefinementCancelledError || isRefinementCancelled(manager, statePath)) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      markRefinePhase(
        manager,
        statePath,
        sessionDir,
        'refine:fallback',
        `Synthesis retries exhausted; using independent fallback refinement. ${reason}`,
      );
      accepted = await runFinalArtifactAttempts({
        label: 'fallback',
        state,
        statePath,
        manager,
        sessionDir,
        prdPath,
        timeoutMs,
        deadlineMs: overallDeadlineMs,
        config: config as unknown as ConfigVerificationInput,
        buildPrompt: (refinedPath, manifestPath) => buildRefinePrdPrompt({
          sessionDir,
          prdPath: prdSnapshotPath,
          workingDir: state.working_dir as string,
          refinedPath,
          manifestPath,
        }),
      });
    }
  } else {
    const failures = failedAnalysts
      .map((outcome) => `${outcome.spec.role}: ${outcome.error?.message || 'unknown failure'}`)
      .join('; ');
    markRefinePhase(
      manager,
      statePath,
      sessionDir,
      'refine:fallback',
      `Analyst retries exhausted; using explicit single-pass fallback. ${failures}`,
    );
    accepted = await runFinalArtifactAttempts({
      label: 'fallback',
      state,
      statePath,
      manager,
      sessionDir,
      prdPath,
      timeoutMs,
      deadlineMs: overallDeadlineMs,
      config: config as unknown as ConfigVerificationInput,
      buildPrompt: (refinedPath, manifestPath) => buildRefinePrdPrompt({
        sessionDir,
        prdPath: prdSnapshotPath,
        workingDir: state.working_dir as string,
        refinedPath,
        manifestPath,
      }),
    });
  }
  refinementResults.push(...accepted.results);

  assertRefinementInputIdentity(inputIdentity, { prdPath, workingDir });
  if (isRefinementCancelled(manager, statePath)) throw new RefinementCancelledError();
  const refinedPrd = readTextFile(accepted.refinedPath, '') || '';
  if (!refinedPrd.trim()) throw new Error('Accepted refinement PRD became empty before promotion.');
  markRefinePhase(manager, statePath, sessionDir, 'refine:materialize', 'Materializing ticket files.');
  if (!accepted.manifest.tickets.length) {
    throw new Error('Refinement produced zero tickets.');
  }
  promoteRefinementArtifacts({
    sessionDir,
    statePath,
    manager,
    refinedPrd,
    manifest: accepted.manifest,
    inputIdentity,
    workingDir,
    beforeCommit: options.beforePromotionCommit,
  });
  appendRefineLog(sessionDir, 'Refinement complete.');

  const usage = sumUsage(refinementResults);
  logActivity({
    event: 'feature',
    source: 'pickle',
    session: path.basename(sessionDir),
    step: 'refine',
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  }, { enabled: config.defaults.activity_logging });

  pruneRefinementWorkerHistory(sessionDir);
  return accepted.manifest;
}

export async function refinePrd(sessionDir: string, options: RefinePrdOptions = {}): Promise<RefinementManifest> {
  if (process.env[REFINEMENT_LEAF_ENV] === '1') {
    throw new Error('Refinement leaf workers cannot launch refinement orchestration.');
  }

  const leaseManager = new StateManager({ acquireTimeoutMs: 250, staleLockThresholdMs: 0 });
  const leasePath = path.join(sessionDir, '.refinement-run');
  const configuredRunStartedAtMs = Number(options.runStartedAtMs);
  const runStartedAtMs = Number.isFinite(configuredRunStartedAtMs) && configuredRunStartedAtMs > 0
    ? configuredRunStartedAtMs
    : Date.now();
  assertNoForeignTmuxLaunch(sessionDir);
  const releaseOperation = acquireSessionOperation(sessionDir);
  try {
    leaseManager.acquireLock(leasePath);
  } catch {
    releaseOperation();
    throw new Error(`Refinement is already running for session: ${sessionDir}`);
  }
  try {
    recoverInterruptedTicketTransaction(sessionDir);
    const pendingAdvancePath = refinementRepositoryAdvancePath(sessionDir);
    if (fs.existsSync(pendingAdvancePath)) {
      const pendingState = new StateManager().read(path.join(sessionDir, 'state.json'));
      const workingDir = String(pendingState.working_dir || '');
      if (!workingDir) {
        throw new Error('Cannot refine while a ticket repository advance is pending without a working directory.');
      }
      reconcileVerifiedRefinementRepositoryAdvance(sessionDir, workingDir);
      if (fs.existsSync(pendingAdvancePath)) {
        throw new Error('Cannot refine until the pending ticket repository advance is safely reconciled.');
      }
    }
  } catch (error) {
    leaseManager.releaseLock(leasePath);
    releaseOperation();
    throw error;
  }

  const ownershipManager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const controllerIdentity = captureProcessLivenessIdentity(process.pid);
  if (!controllerIdentity) {
    leaseManager.releaseLock(leasePath);
    releaseOperation();
    throw new Error('Cannot attest refinement controller identity.');
  }
  ownershipManager.update(statePath, (current) => {
    const cancellationAtMs = Date.parse(String(current.cancel_requested_at || ''));
    const cancelledThisRun = Number.isFinite(cancellationAtMs) && cancellationAtMs >= runStartedAtMs;
    if (!cancelledThisRun) {
      current.cancel_requested_at = null;
      if (current.last_exit_reason === 'cancelled') current.last_exit_reason = null;
    }
    current.active_child_controller_pid = process.pid;
    current.active_child_controller_identity = controllerIdentity;
    return current;
  });
  const requestCancellation = (): void => {
    try {
      ownershipManager.update(statePath, (current) => {
        if (current.active_child_controller_pid === process.pid) {
          current.last_exit_reason = 'cancelled';
          current.cancel_requested_at = new Date().toISOString();
        }
        return current;
      });
    } catch {
      // The main flow will surface state corruption or ownership loss.
    }
  };
  process.once('SIGINT', requestCancellation);
  process.once('SIGTERM', requestCancellation);
  try {
    return await refinePrdWithLease(sessionDir, options);
  } finally {
    process.removeListener('SIGINT', requestCancellation);
    process.removeListener('SIGTERM', requestCancellation);
    try {
      ownershipManager.update(statePath, (current) => {
        if (current.active_child_controller_pid === process.pid) {
          current.active_child_controller_pid = null;
          current.active_child_controller_identity = null;
        }
        return current;
      });
    } catch {
      // Preserve the original refinement failure.
    }
    try {
      reconcileQuiescentRefinementChildren(ownershipManager, statePath);
    } catch {
      // Preserve the original refinement failure and any recovery evidence.
    }
    leaseManager.releaseLock(leasePath);
    releaseOperation();
  }
}

async function main(argv: string[]): Promise<void> {
  const sessionDir = argv[0];
  if (!sessionDir) {
    throw new Error('Usage: node bin/spawn-refinement-team.js <session-dir>');
  }
  const manifest = await refinePrd(sessionDir);
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
