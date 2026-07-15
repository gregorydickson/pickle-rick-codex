// Shared type definitions for the pickle-rick-codex TypeScript extension.
// These interfaces describe the JSON state artifacts persisted under the
// codex data root (~/.codex/pickle-rick/ or PICKLE_DATA_ROOT) and the
// in-memory contracts exchanged between services.

/**
 * Schema version stamped on every persisted state artifact. Bumped when the
 * shape of SessionState / PipelineState / PipelineContract changes in a
 * backwards-incompatible way. StateManager rejects on-disk versions newer
 * than this value (SCHEMA_MISMATCH).
 */
export const STATE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  enabled: boolean;
  no_progress_threshold: number;
  half_open_after: number;
  same_error_threshold: number;
}

export interface RuntimeConfig {
  command: string;
  model: string | null;
  exec_args: string[];
  add_dirs: string[];
  json_output: boolean;
}

export interface ConfigDefaults {
  max_iterations: number;
  max_time_minutes: number;
  worker_timeout_seconds: number;
  refinement_timeout_seconds: number;
  max_retry_attempts: number;
  activity_logging: boolean;
  hook_timeout_seconds: number;
  verification_env: Record<string, unknown> | null;
  circuit_breaker: CircuitBreakerConfig;
}

export interface ConfigHooks {
  enabled: boolean;
  validated_events: string[];
}

export interface Config {
  runtime: RuntimeConfig;
  defaults: ConfigDefaults;
  hooks: ConfigHooks;
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  step: string;
  ticket?: string;
  timestamp: string;
}

export interface SessionState {
  active: boolean;
  working_dir: string;
  step: string;
  iteration: number;
  max_iterations: number;
  max_time_minutes?: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  run_start_time_epoch?: number | null;
  run_started_at?: string | null;
  completion_promise: string | null;
  original_prompt: string;
  current_ticket: string | null;
  current_ticket_tier?: string;
  current_ticket_budget?: number;
  history: HistoryEntry[];
  started_at: string;
  session_dir: string;
  tmux_mode?: boolean;
  command_template?: string | null;
  schema_version?: number;
  session_map_cwds?: string[];
  last_exit_reason?: string | null;
  cancel_requested_at?: string | null;
  pipeline_mode?: boolean;
  pipeline_phase?: string | null;
  pipeline_total_phases?: number | null;
  pipeline_phase_index?: number | null;
  pipeline_working_dir?: string | null;
  pipeline_target?: string | null;
  pipeline_bootstrap_source?: string | null;
  pipeline_bootstrap_prd?: string | null;
  pipeline_task?: string | null;
  pipeline_phases?: string[] | null;
  pipeline_skip_flags?: { anatomy: boolean; szechuan: boolean } | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tickets & Refinement Manifest
// ---------------------------------------------------------------------------

/**
 * A ticket entry inside a refinement manifest (`refinement_manifest.json`).
 * The shape is intentionally permissive (index signature) because manifest
 * tickets carry variable verification/dependency fields across versions.
 */
export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status?: string;
  order?: number;
  complexity_tier?: string;
  verify?: string;
  verification?: unknown;
  verification_env?: unknown;
  verificationEnv?: unknown;
  required_env?: unknown;
  requiredEnv?: unknown;
  depends_on?: string | string[];
  dependsOn?: string | string[];
  dependencies?: string | string[];
  acceptance_criteria?: string[];
  priority?: string;
  phase?: string;
  // Ticket contract fields (normalized by services/tickets.ts). Kept optional
  // + typed so the validation/enrichment helpers can iterate them directly;
  // the index signature below still admits any other ad-hoc field.
  output_artifacts?: string[];
  proof_corpus?: string[];
  freeze_contract?: FreezeContract | null;
  frontmatter?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A ticket parsed from an on-disk `linear_ticket_*.md` file by
 * `parseTicketFile()`. The `frontmatter` field is the raw key-value map
 * extracted from the YAML-style front matter block.
 */
export interface ParsedTicket {
  id: string;
  title: string;
  status: string;
  order: number;
  complexity_tier: string;
  verify: string;
  filePath: string;
  content: string;
  frontmatter: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Normalized freeze/pin contract attached to a ticket that produces or
 * consumes a sibling-repo artifact pinned to a fixed SHA. Emitted by
 * `normalizeFreezeContract()` in `services/tickets.ts`.
 */
export interface FreezeContract {
  artifact_path: string;
  sibling: string;
  root_env: string;
  sha_source: string;
}

export interface RefinementManifest {
  tickets: Ticket[];
  source?: string;
  generated_at?: string;
  prd_path?: string;
  refined_at?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pipeline Contract & State
// ---------------------------------------------------------------------------

export type PipelineBootstrapSource = 'task' | 'prd';

export type PipelinePhase = 'pickle' | 'anatomy-park' | 'szechuan-sauce';

export interface PipelineSkipFlags {
  anatomy: boolean;
  szechuan: boolean;
}

export interface PipelineContract {
  schema_version: number;
  working_dir: string;
  target: string;
  phases: PipelinePhase[];
  skip_flags: PipelineSkipFlags;
  bootstrap_source: PipelineBootstrapSource;
  task: string | null;
  bootstrap_prd: string | null;
  pickle: Record<string, unknown>;
  anatomy: Record<string, unknown>;
  szechuan: Record<string, unknown>;
}

export type PipelinePhaseStatus = 'todo' | 'running' | 'done' | 'cancelled' | 'failed';

// ---------------------------------------------------------------------------
// Verification command scope & failure set (services/pipeline-state)
// ---------------------------------------------------------------------------

export type VerificationScopeKind = 'command' | 'node-test' | 'package-test';

export interface VerificationCommandScope {
  key: string;
  kind: VerificationScopeKind;
  command: string;
  targets: string[];
}

export interface VerificationFailure {
  identity: string;
  file: string | null;
  testName: string | null;
  in_scope: boolean;
  source: string;
}

export interface VerificationBaselineEntry {
  command: string;
  scope: VerificationCommandScope;
  failures: VerificationFailure[];
}

export type VerificationBaselineCommandMap = Record<string, VerificationBaselineEntry>;

export interface VerificationBaselines {
  schema_version: number;
  captured_at: string | null;
  by_ticket: Record<string, VerificationBaselineCommandMap>;
}

export interface PipelineState {
  schema_version: number;
  current_phase: PipelinePhase | null;
  current_phase_index: number | null;
  phase_statuses: Record<string, PipelinePhaseStatus>;
  started_at: string;
  phase_started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  last_exit_reason: string | null;
  verification_baselines: VerificationBaselines;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Circuit Breaker State
// ---------------------------------------------------------------------------

export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitHistoryEntry {
  from: CircuitStateName;
  to: CircuitStateName;
  timestamp: string;
  reason: string;
}

export interface CircuitState {
  state: CircuitStateName;
  last_change: string;
  consecutive_no_progress: number;
  consecutive_same_error: number;
  last_error_signature: string | null;
  last_snapshot: unknown;
  total_opens: number;
  reason: string;
  opened_at: string | null;
  history: CircuitHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Verification Contract (verification-env)
// ---------------------------------------------------------------------------

export type VerificationEnvMode = 'inherit' | 'merge' | 'replace';

export interface VerificationRequirement {
  name: string;
  format: 'string' | 'url';
}

export type VerificationEnvVarSpec =
  | { type: 'literal'; value: string }
  | { type: 'env'; fromEnv: string };

export interface VerificationContract {
  mode: VerificationEnvMode;
  required: VerificationRequirement[];
  vars: Record<string, VerificationEnvVarSpec>;
}

export interface PreflightDiagnostic {
  kind: 'preflight-missing-env' | 'preflight-invalid-env';
  name: string;
  message: string;
}

export interface VerificationEnvResult {
  contract: VerificationContract | null;
  env: Record<string, string | undefined>;
  diagnostics: PreflightDiagnostic[];
}

export interface TicketVerificationInput {
  id?: string | null;
  title?: string;
  verify?: string;
  verification?: unknown;
  verification_env?: unknown;
  verificationEnv?: unknown;
  required_env?: unknown;
  requiredEnv?: unknown;
  [key: string]: unknown;
}

export interface ConfigVerificationInput {
  defaults?: {
    verification_env?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Codex spawn / exec (services/codex)
// ---------------------------------------------------------------------------

export interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface CodexSpawnResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  lastMessage: string;
  usage: CodexUsage;
  terminatedAfterSuccess: boolean;
  cancelled: boolean;
}

export interface SuccessCheckContext {
  stdout: string;
  stderr: string;
  lastMessage: string;
}

export type SuccessCheck = (ctx: SuccessCheckContext) => boolean;
export type CancelCheck = () => boolean;

export interface RunSpawnedCommandOptions {
  command: string;
  args?: string[];
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  outputLastMessagePath?: string;
  successCheck?: SuccessCheck;
  successSignalGraceMs?: number;
  successPollMs?: number;
  cleanupPaths?: string[];
  onSpawn?: (child: import('node:child_process').ChildProcess) => void;
  cancelCheck?: CancelCheck;
}

export interface CodexExecOptions {
  command?: string;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  outputLastMessagePath?: string;
  cleanupPaths?: string[];
  onSpawn?: (child: import('node:child_process').ChildProcess) => void;
  cancelCheck?: CancelCheck;
  successCheck?: SuccessCheck;
  successSignalGraceMs?: number;
  successPollMs?: number;
  model?: string;
  skipGitRepoCheck?: boolean;
  addDirs?: string[];
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Metrics (services/metrics)
// ---------------------------------------------------------------------------

export interface MetricsOptions {
  days: number;
  since: string | null;
  weekly: boolean;
  json: boolean;
}

export interface MetricsRange {
  since: Date;
  until: Date;
}

export interface MetricsTotals {
  events: number;
  sessions_started: number;
  tickets_completed: number;
  commits: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface MetricsRow {
  date?: string;
  week?: string;
  start_date?: string;
  end_date?: string;
  events: number;
  sessions_started: number;
  tickets_completed: number;
  commits: number;
  input_tokens: number;
  output_tokens: number;
}

export interface MetricsReport {
  granularity: 'day' | 'week';
  since: string;
  until: string;
  totals: MetricsTotals;
  rows: MetricsRow[];
}

// ---------------------------------------------------------------------------
// Progress Snapshot (services/progress-snapshot)
// ---------------------------------------------------------------------------

export type ProgressMode = 'anatomy-park' | 'microverse' | 'szechuan-sauce' | string | null;

export interface ProgressSnapshot {
  head_sha: string;
  worktree_fingerprint: string;
  step: string | null;
  current_ticket: string | null;
  progress_artifacts: Record<string, string | null>;
}

export interface CaptureProgressSnapshotArgs {
  sessionDir: string;
  workingDir: string;
  mode: ProgressMode;
  step?: string | null;
  currentTicket?: string | null;
}

// ---------------------------------------------------------------------------
// Circuit Breaker (services/circuit-breaker)
// ---------------------------------------------------------------------------

/**
 * Minimal view of a session-state object needed by `recordIteration`. Kept
 * structural so callers can pass either a full {@link SessionState} or a
 * partial lookalike without importing the full interface.
 */
export interface CircuitIterationState {
  working_dir: string;
  step: string;
  current_ticket: string | null;
  loop_mode?: string | null;
  [key: string]: unknown;
}

export interface RecordIterationOptions {
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Pipeline State options (services/pipeline-state)
// ---------------------------------------------------------------------------

export interface PipelineStateOptions {
  stateManager?: import('../services/state-manager.js').StateManager;
  pipeline?: PipelineContract;
}

export interface BeginPipelinePhaseOptions extends PipelineStateOptions {
  startedAt?: string;
}

export interface FinishPipelinePhaseOptions extends PipelineStateOptions {
  exitReason?: string;
  lastError?: string | null;
  completedAt?: string;
  failedTicketId?: string;
}

export interface CancelPipelineSessionOptions extends PipelineStateOptions {
  phase?: string | null;
  cancelledAt?: string;
  exitReason?: string;
  lastError?: string | null;
}

export interface WritePipelineStateOptions extends PipelineStateOptions {
  /** Marker field kept to preserve the named export; no additional fields. */
  _write?: never;
}

export interface WriteVerificationBaselinesOptions extends PipelineStateOptions {
  /** Marker field kept to preserve the named export; no additional fields. */
  _write?: never;
}

export interface ReadTicketVerificationBaselineOptions {
  stateManager?: import('../services/state-manager.js').StateManager;
  pipeline?: PipelineContract;
  cwd?: string;
}

export interface BuildVerificationFailureSetArgs {
  command: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export type PipelineStateMutator = (
  pipelineState: PipelineState,
  sessionState: import('../services/state-manager.js').PersistedState,
  pipeline: PipelineContract,
) => void;

export interface TransitionPipelineStateResult {
  state: import('../services/state-manager.js').PersistedState;
  pipelineState: PipelineState;
  pipeline: PipelineContract;
}
