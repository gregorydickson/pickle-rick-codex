import { describeVerificationContract, normalizeVerificationCommands } from './verification-env.js';
import { serializeApprovedWorkerContext, type WorkerLifecycleArtifact, type WorkerLifecyclePhase } from './worker-lifecycle.js';
import type { Ticket, VerificationContract } from '../types/index.js';

export interface DraftPrdPromptInput {
  task: string;
  sessionDir: string;
}

export function buildDraftPrdPrompt({ task, sessionDir }: DraftPrdPromptInput): string {
  return [
    'You are drafting a PRD for the Pickle Rick Codex runtime.',
    `Write the PRD to ${sessionDir}/prd.md.`,
    'Cover: summary, goals, non-goals, critical user journeys, architecture, implementation plan, risks, success criteria, and machine-checkable verification.',
    'Stay grounded in the current repository and prefer a truthful runnable baseline over aspirational text.',
    `Task: ${task}`,
    'Return <promise>PRD_COMPLETE</promise> when the file is written.',
    'Stop immediately after writing the file and the promise token. Do not continue with extra analysis, follow-up suggestions, or additional turns.',
  ].join('\n\n');
}

export interface RefinePrdPromptInput {
  sessionDir: string;
  prdPath: string;
}

export function buildRefinePrdPrompt({ sessionDir, prdPath }: RefinePrdPromptInput): string {
  return [
    'Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.',
    `Read ${prdPath}.`,
    `Write ${sessionDir}/prd_refined.md with clarified acceptance criteria.`,
    `Write ${sessionDir}/refinement_manifest.json with a top-level {"tickets":[...]} array.`,
    'Each ticket should be self-contained, sequentially executable, and include id, title, description, acceptance_criteria, verification, priority, and a non-empty allowed_paths array of specific repo-relative files or directories the ticket may modify. Repository-root scopes such as "." are forbidden.',
    'Emit explicit machine-readable contracts instead of hiding them in wrapper commands.',
    'When verification depends on sibling repos or repo-owned wrappers, include verification_env with required vars such as ATTRACTOR_ROOT and DIPPIN_ROOT.',
    'When a ticket creates or updates proof artifacts, include output_artifacts with repo-relative paths.',
    'When a ticket validates parity or mirrored behavior, include proof_corpus with the mirrored fixtures, transcripts, or corpus paths it must cover.',
    'Only include freeze_contract.sha_source when the source PRD explicitly requires commit pinning, exact SHA capture, or reproducibility against a fixed sibling revision.',
    'If the PRD describes a currently evolving external or sibling system that should be validated against the current compatible mounted state, do not silently hard-code fixed-SHA enforcement.',
    'If the source contract is ambiguous between pinned-SHA validation and current-compatible mounted-system validation, create an explicit contract-decision ticket first. Mark it with contract_decision: true and make the dependent implementation tickets wait on it.',
    'Return <promise>REFINEMENT_COMPLETE</promise> when both files are written.',
    'Stop immediately after writing the files and the promise token. Do not continue with extra analysis or follow-up turns.',
  ].join('\n\n');
}

export interface RefinementAnalystPromptInput {
  role: string;
  focus: string;
  prdPath: string;
  analysisPath: string;
}

export function buildRefinementAnalystPrompt({
  role,
  focus,
  prdPath,
  analysisPath,
}: RefinementAnalystPromptInput): string {
  return [
    'You are one of three parallel PRD refinement analysts for the Pickle Rick Codex runtime.',
    `Refinement analyst role: ${role}`,
    `Focus: ${focus}`,
    `Read ${prdPath}`,
    `Write your analyst report to ${analysisPath}`,
    'Ground the report in the current repository and the guaranteed Codex v1 execution path.',
    'Call out gaps, contradictions, risky assumptions, missing verification, and ticketization concerns.',
    'Output sections: Findings, Recommended Changes, Verification Gaps, and Ticketing Notes.',
    'Do not write the final manifest or the final refined PRD in this step.',
    'Return <promise>ANALYST_COMPLETE</promise> when the analyst report is written.',
    'Stop immediately after writing the file and the promise token.',
  ].join('\n\n');
}

export interface RefinementSynthesisPromptInput {
  sessionDir: string;
  prdPath: string;
  analystReports: string[];
}

export function buildRefinementSynthesisPrompt({
  sessionDir,
  prdPath,
  analystReports,
}: RefinementSynthesisPromptInput): string {
  return [
    'You are synthesizing parallel PRD refinement analyst reports into final executable artifacts for the Pickle Rick Codex runtime.',
    `Read ${prdPath}`,
    'Read these analyst reports:',
    ...analystReports.map((report) => `- ${report}`),
    `Write ${sessionDir}/prd_refined.md with clarified acceptance criteria, architecture details, sequencing, and concrete execution notes`,
    `Write ${sessionDir}/refinement_manifest.json with a top-level {"tickets":[...]} array`,
    'Each ticket must be self-contained, sequentially executable, and include id, title, description, acceptance_criteria, verification, priority, and a non-empty allowed_paths array of specific repo-relative files or directories the ticket may modify. Repository-root scopes such as "." are forbidden.',
    'Prefer atomic tickets with explicit dependencies and realistic verification commands.',
    'Do not let wrapper commands hide contracts. Emit verification_env, output_artifacts, proof_corpus, and freeze_contract whenever they are needed for truthful execution.',
    'Do not invent fixed-SHA sibling validation just because the PRD mentions sibling repos, freezes, or SHAs. Emit freeze_contract.sha_source only when the PRD explicitly requires commit pinning or exact revision capture.',
    'If the PRD mixes sibling SHA/freeze language with an evolving external system or current-compatible mounted-system contract, treat that as ambiguous until resolved. Create an explicit contract-decision ticket first, mark it with contract_decision: true, and make downstream tickets depend on it.',
    'Parity-style port work must preserve full mirrored proof obligations, not only a benchmark slice.',
    'Resolve analyst disagreements explicitly in favor of the most truthful runnable plan.',
    'Return <promise>REFINEMENT_COMPLETE</promise> when both files are written.',
    'Stop immediately after writing the files and the promise token. Do not continue with extra analysis, follow-up turns.',
  ].join('\n\n');
}

export interface TicketPhasePromptInput {
  phase: WorkerLifecyclePhase;
  ticket: Ticket;
  sessionDir: string;
  workingDir: string;
  artifactPath?: string;
  priorArtifacts?: WorkerLifecycleArtifact[];
  tmuxMode?: boolean;
}

function lifecycleArtifactContract(phase: WorkerLifecyclePhase, ticketId: string): string {
  const fields: Record<WorkerLifecyclePhase, string> = {
    research: 'evidence: non-empty string[]',
    research_review: 'verdict: "approved"; evidence: non-empty string[]',
    plan: 'steps: non-empty string[]',
    plan_review: 'verdict: "approved"; evidence: non-empty string[]',
    implement: 'files_changed: string[]; verification: non-empty string[]',
    review: 'verdict: "approved"; implementation_reviewed: true; evidence: non-empty string[]',
    simplify: 'verification: non-empty string[]',
    conformance: 'verdict: "all_pass"; implementation_reviewed: true; acceptance_criteria: [{criterion: exact ticket criterion, status: "pass", evidence: non-empty string}]',
  };
  return `Required JSON fields: schema_version: 1; phase: "${phase}"; ticket_id: "${ticketId}"; summary: non-empty string; ${fields[phase]}.`;
}

export function buildTicketPhasePrompt({
  phase,
  ticket,
  sessionDir,
  workingDir,
  artifactPath = `${sessionDir}/worker-lifecycle/${ticket.id}/${phase}.json`,
  priorArtifacts = [],
  tmuxMode = false,
}: TicketPhasePromptInput): string {
  const verificationCommands = normalizeVerificationCommands(ticket?.verification, {
    verify: ticket?.verify,
    cwd: workingDir,
  });
  const verificationContract = (ticket?.verificationContract ?? null) as VerificationContract | null | undefined;
  const artifactTicketId = artifactPath.split(/[\\/]/).at(-2) || String(ticket.id);
  const isReadOnly = ['research', 'research_review', 'plan', 'plan_review', 'review', 'conformance'].includes(phase);
  const validatesImplementation = phase === 'review' || phase === 'conformance';
  return [
    `You are executing the "${phase}" phase for ticket ${ticket.id}: ${ticket.title}.`,
    `Session dir: ${sessionDir}`,
    `Working directory: ${workingDir}`,
    isReadOnly
      ? 'This is a read-only repository phase. Inspect the working tree, but do not modify repository files, the index, commits, or HEAD.'
      : 'Work directly in the repository working tree for this ticket. Do not create isolated worktrees or sandbox copies.',
    `You may modify only these ticket-owned paths: ${JSON.stringify(ticket.allowed_paths ?? ticket.allowedPaths ?? ticket.files ?? ticket.output_artifacts ?? [])}`,
    'Follow the guaranteed sequential path. Do not assume undocumented native agent controls.',
    `Lifecycle artifact path: ${artifactPath}`,
    lifecycleArtifactContract(phase, artifactTicketId),
    'Write exactly one valid JSON lifecycle artifact to that path before emitting the completion promise. A prose answer or promise without this persisted artifact fails closed.',
    validatesImplementation
      ? 'Inspect the actual implementation diff and verification evidence. Approval is forbidden unless the implementation satisfies the ticket and the persisted prior artifacts.'
      : null,
    'Use the repository tests and the listed verification commands for this phase; do not widen them back to package-wide wrappers.',
    tmuxMode
      ? 'Detached tmux ticket boundary: if this ticket changes files in a git repository, finish with committed changes and do not leave the working tree dirty for the next ticket.'
      : null,
    `Ticket description:\n${ticket.description || 'No description provided.'}`,
    `Acceptance criteria:\n${(ticket.acceptance_criteria || []).map((item) => `- ${item}`).join('\n')}`,
    `Required acceptance criteria JSON: ${JSON.stringify(ticket.acceptance_criteria || [])}`,
    `Verification commands:\n${(verificationCommands.length > 0 ? verificationCommands : ['npm test']).map((item) => `- ${item}`).join('\n')}`,
    verificationContract
      ? `Verification env contract:\n${describeVerificationContract(verificationContract)}`
      : null,
    `Approved causal context from earlier phases (read this forward; do not replace it with fresh assumptions):\n${serializeApprovedWorkerContext(priorArtifacts)}`,
    `Return <promise>${phase.toUpperCase()}_COMPLETE</promise> when this phase is finished.`,
    'Stop immediately after writing any phase-result artifacts and the promise token.',
    'Do not continue with extra analysis, follow-up, or additional work after the promise token has been emitted.',
  ].filter(Boolean).join('\n\n');
}

export interface LoopPromptState {
  iteration?: number;
  max_iterations?: number;
  original_prompt: string;
}

export interface LoopPromptConfig {
  task?: string;
  metric?: string;
  goal?: string;
  direction?: string;
  stall_limit?: number;
  target?: string;
  allowed_paths?: string[];
  focus?: string;
  domain?: string;
  dry_run?: boolean;
}

export interface LoopPromptInput {
  mode: string;
  sessionDir: string;
  workingDir: string;
  state: LoopPromptState;
  loopConfig: LoopPromptConfig;
}

export function buildLoopPrompt({
  mode,
  sessionDir,
  workingDir,
  state,
  loopConfig,
}: LoopPromptInput): string {
  const iteration = Number.isInteger(state.iteration) ? state.iteration : 0;
  const maxIterations = Number.isInteger(state.max_iterations) && (state.max_iterations ?? 0) > 0
    ? state.max_iterations
    : 'unlimited';
  const common = [
    `Loop mode: ${mode}`,
    `Session dir: ${sessionDir}`,
    `Working directory: ${workingDir}`,
    `Original task: ${state.original_prompt}`,
    `Iteration: ${iteration} / ${maxIterations}`,
    'You are running in a detached Pickle Rick tmux loop with fresh Codex context for this iteration.',
    'Make one coherent iteration of progress, grounded in the current repository state.',
    'Write short notes or artifacts to the session directory if useful, but keep the main work in the repository.',
    'If the loop should continue after this iteration, return <promise>CONTINUE</promise>.',
    'If the objective is complete or converged, return <promise>LOOP_COMPLETE</promise>.',
    'Stop immediately after writing any summary artifacts and the promise token.',
    'Do not continue with extra analysis, follow-up, or additional work after the promise token has been emitted.',
  ];

  if (mode === 'microverse') {
    return [
      ...common,
      `Objective: ${loopConfig.task}`,
      loopConfig.metric ? `Metric command: ${loopConfig.metric}` : `Goal: ${loopConfig.goal}`,
      `Direction: ${loopConfig.direction || 'higher'}`,
      `Stall limit: ${loopConfig.stall_limit || 5}`,
      loopConfig.metric ? `The runtime—not the worker—measures this command before and after the iteration. It will retain only a real improvement and revert held/regressed work. Read ${sessionDir}/microverse-metrics.json before choosing an approach, and do not repeat entries in failed_approaches.` : '',
      `Write/update ${sessionDir}/microverse-summary.json with keys: objective, baseline, latest_result, best_result, change_applied, verification, next_action.`,
      `Write/update ${sessionDir}/microverse-summary.md as the human-readable version of the same summary.`,
      'Process: make one targeted change, measure or reason about impact, avoid repeating failed approaches, and converge deliberately.',
    ].join('\n\n');
  }

  if (mode === 'szechuan-sauce') {
    const allowedPaths = Array.isArray(loopConfig.allowed_paths) ? loopConfig.allowed_paths : [];
    return [
      ...common,
      `Target: ${loopConfig.target}`,
      loopConfig.focus ? `Focus: ${loopConfig.focus}` : 'Focus: none',
      loopConfig.domain ? `Domain principles: ${loopConfig.domain}` : 'Domain principles: none',
      allowedPaths.length > 0 ? `Immutable mutation scope: ${JSON.stringify(allowedPaths)}` : '',
      `Write/update ${sessionDir}/szechuan-sauce-summary.json with keys: issue_family, files_touched, cleanup_applied, verification, next_action.`,
      `Write/update ${sessionDir}/szechuan-sauce-summary.md as the human-readable version of the same summary.`,
      loopConfig.dry_run ? 'Dry run: catalog violations only, do not edit files.' : 'Fix exactly one highest-value code quality issue this iteration.',
      'Phase 0 contract discovery: identify repository contracts, tests, public interfaces, and local conventions that constrain the cleanup before selecting a finding.',
      'Severity rubric: P0 data loss/security/correctness catastrophe; P1 production correctness or scope/diff-hygiene breach; P2 material maintainability defect with concrete evidence; P3 localized low-risk simplification; P4 optional polish.',
      'Confidence is scored 0/25/50/75/100. Drop findings below 80 confidence. Severity and confidence are independent; never fix a speculative P0.',
      'False positives to discard: pre-existing issues outside current scope, compiler/linter noise better handled mechanically, author-silenced findings, uncodified style preferences, generic coverage complaints, speculative future risks, and already-resolved finding families.',
      'Use principle-driven cleanup: KISS, DRY, consistency, dead-code removal, boundary error handling, and simpler structure.',
      'Diff hygiene: do not add scratch notes, generated debris, unrelated formatting, broad dependency churn, or changes outside immutable scope.',
      'Trap-door-as-test: when cleanup removes a recurring structural hazard, add or strengthen the smallest regression test that makes the invariant executable.',
      allowedPaths.length > 0 ? 'Before committing, inspect every staged and unstaged path. If any path is outside immutable scope, do not commit; the runtime will archive, roll back, and block the phase.' : '',
    ].join('\n\n');
  }

  if (mode === 'anatomy-park') {
    const allowedPaths = Array.isArray(loopConfig.allowed_paths) ? loopConfig.allowed_paths : [];
    return [
      ...common,
      `Target: ${loopConfig.target}`,
      allowedPaths.length > 0 ? `Immutable mutation scope: ${JSON.stringify(allowedPaths)}` : '',
      `Write/update ${sessionDir}/anatomy-park-summary.json with keys: finding_family, highest_severity_finding, data_flow_path, fix_applied, verification, trap_doors, next_action.`,
      `Write/update ${sessionDir}/anatomy-park-summary.md as the human-readable version of the same summary.`,
      loopConfig.dry_run ? 'Dry run: review and catalog findings only, do not edit or commit files.' : 'Fix at most one high-severity correctness issue this iteration.',
      'Trace data flow through the subsystem, identify where meaning changes incorrectly, and prefer correctness bugs over style complaints.',
      'Do not re-discover the same finding family across adjacent iterations unless you are adding concrete new evidence, a fix, or a stronger regression test.',
      'If you only review, verify, or catalog findings this iteration, leave the repository working tree unchanged. Clean passes must produce zero commits.',
      'If you fix a finding in a git repository, end the iteration with one atomic commit. Use git add -u for tracked edits, stage any new regression test file explicitly by path, and do not use git add -A or git add .',
      'Use commit subject format: anatomy-park: <target> - <finding>[, trap door]. Keep trap-door documentation in the same commit as the fix when you add it.',
      'Record trap doors when you discover structural invariants likely to break in future edits.',
      allowedPaths.length > 0 ? 'Before committing, inspect every staged and unstaged path. Never mutate outside immutable scope; the runtime will archive, roll back, and block any violating iteration.' : '',
    ].join('\n\n');
  }

  return common.join('\n\n');
}
