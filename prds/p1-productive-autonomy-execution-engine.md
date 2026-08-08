# PRD: Productive Autonomous Development Engine

Status: Approved  
Priority: P0  
Target package: `pickle-rick-codex`

## Summary

Redesign Pickle Rick around a durable logical development pipeline that continues autonomously from an approved PRD through decomposition, implementation, verification, review, remediation, integration, and release.

The human participates only in PRD development and approval. PRD approval seals a machine-checkable contract. After sealing, no implementation, recovery, quality, or release path may wait for human input.

The engine optimizes three concerns in strict priority order:

1. Autonomy
2. Reliability
3. Quality

An unexpected non-completion pipeline termination sets all three scores to zero. Quality failures must reject candidates without terminating recoverable execution. Retry or time budgets are strategy-transition thresholds, not terminal limits.

## Motivation

The current worker lifecycle amplifies recoverable failures into complete ticket restarts. A field run reached 494 lifecycle iterations on its first ticket while repeatedly rebuilding research, plans, and implementations around a malformed deterministic verification command. The pipeline remained alive but did not produce useful throughput.

The observed failure has four architectural causes:

- generated verification strings cross JSON, Markdown/frontmatter, and shell boundaries without proving the final executable representation;
- deterministic verification runs after eight expensive lifecycle phases;
- review and conformance refusals discard reusable phase work and restart at research;
- recovery epochs preserve liveness without requiring a materially different strategy.

The redesign must preserve fail-closed promotion, unrelated-work safety, and independent review while eliminating ritual repetition and post-PRD human intervention.

## Governing Doctrine

### Priority Order

Autonomy is the primary objective. Reliability is the mechanism that sustains autonomy through failure. Quality controls what may be promoted, but a quality refusal must create remediation work rather than halt the logical pipeline.

Lower priority does not permit sacrificing quality. It means quality enforcement blocks promotion while autonomous reliable remediation continues.

### Zero Rule

If a pipeline unexpectedly terminates before completion, its autonomy, reliability, and quality scores are all zero.

`completed` is a successful terminal transition, not a stoppage. Explicit operator cancellation is excluded from scoring. A worker process may exit or crash without stopping the logical pipeline.

### Human Boundary

The lifecycle has two control-plane states:

1. `prd_development`: the human and Codex collaborate on intent, scope, constraints, decision rules, and acceptance criteria.
2. `autonomous_execution`: the sealed PRD is the authority and the engine proceeds without human questions or approval gates.

If execution proves that the product contract is genuinely contradictory or incomplete, the engine must preserve safe progress, generate evidence and a proposed PRD patch, and transition formally to `prd_revision_required`. This is a return to PRD development, not an implementation question. No other runtime path may request human input.

## Goals

1. Make the logical pipeline durable across worker, runner, terminal, and host-process failures.
2. Eliminate post-PRD human approval and recovery decisions.
3. Reject invalid verification contracts before implementation work begins.
4. Execute cheap deterministic gates before expensive probabilistic review.
5. Reuse trustworthy research, plans, candidate patches, and evidence across remediation.
6. Require material strategy change when a recovery boundary is crossed.
7. Continue independent useful work while another ticket is being repaired.
8. Preserve fail-closed promotion and unrelated repository work.
9. Measure productive throughput, discarded work, tokens, latency, and recovery behavior truthfully.
10. Migrate existing sessions without erasing their history or salvage evidence.

## Non-Goals

- Weakening acceptance criteria, deterministic checks, review, Citadel, or completion evidence.
- Requiring undocumented native Codex multi-agent behavior.
- Marketplace publication or remote hosted orchestration.
- Supporting arbitrary generated shell scripts as the default verification representation.
- Asking the human to choose retry, skip, rollback, remediation, or release actions after PRD approval.
- Treating a continuously repeated identical attempt as successful autonomy.

## Users and Critical Journeys

### CUJ-1: Human Seals Intent

1. The human and Codex develop a PRD.
2. Readiness validates scope, acceptance criteria, external prerequisites, decision precedence, completion, and release rules.
3. Approval writes `prd.lock.json` containing the PRD hash and immutable execution contract.
4. The control plane transitions to autonomous execution.

Success means no downstream state waits for human input.

### CUJ-2: Autonomous Delivery

1. The engine refines the sealed PRD into dependency-aware tickets.
2. Ticket contracts compile into executable structured verification plans.
3. The engine implements, verifies, reviews, remediates, and promotes each ticket.
4. Citadel evaluates the completed scope.
5. Citadel findings automatically create remediation work until approval.
6. The engine installs, dogfoods, and releases the approved result.

### CUJ-3: Recoverable Failure

1. A worker crashes, times out, writes malformed evidence, fails verification, or receives review changes.
2. The durable supervisor classifies the failure.
3. The engine resumes the smallest invalidated phase from the latest trustworthy checkpoint.
4. Crossing a recovery boundary selects a materially different strategy.
5. Independent runnable work continues when possible.

Success means the logical pipeline never enters an unexpected terminal state.

### CUJ-4: Unsafe Workspace

1. The engine detects repository state that cannot be safely attributed or restored.
2. It quarantines the candidate workspace and evidence.
3. It reconstructs a clean workspace from the last verified checkpoint.
4. It resumes the logical pipeline without modifying unrelated work.

### CUJ-5: Product Contract Defect

1. Execution proves the sealed PRD is contradictory or missing an unavoidable product decision.
2. The engine produces a typed finding, evidence, affected tickets, preserved checkpoints, and a proposed PRD patch.
3. The control plane transitions to `prd_revision_required`.
4. After human PRD approval, a new seal invalidates only affected checkpoints and autonomous execution resumes.

## Architecture

### Durable Logical Pipeline

The pipeline is a persisted job, not a runner process. Its event journal is the authority for ownership, phase transitions, checkpoints, recovery strategies, and terminal state.

Normal terminal states are limited to:

- `completed`
- `cancelled`

All other states must have an autonomous outgoing transition or formally return to `prd_revision_required`.

A supervisor owns a renewable lease for each logical pipeline. Worker and runner processes are replaceable executors. A watchdog detects expired leases or dead executors and resumes from the event journal. Restart counts are telemetry, not terminal budgets.

### PRD Seal

`prd.lock.json` must bind at least:

- schema version;
- PRD SHA-256;
- repository identity and execution base policy;
- acceptance-criteria identifiers and exact text;
- scope and ownership boundaries;
- dependency and external-prerequisite contracts;
- risk classification;
- decision-precedence rules;
- preservation and rollback rules;
- completion definition;
- release gates;
- seal timestamp.

Any semantic PRD change creates a new seal. Checkpoints whose declared inputs are unchanged remain reusable.

### Structured Verification Contract

Generated verification must prefer structured steps:

```ts
type VerificationStep =
  | {
      kind: 'process';
      executable: string;
      args: string[];
      cwd?: string;
    }
  | {
      kind: 'package_script';
      manager: 'npm' | 'pnpm' | 'yarn';
      script: string;
      args?: string[];
      cwd?: string;
    }
  | {
      kind: 'shell';
      script: string;
      justification: string;
    };
```

`process` and `package_script` steps execute without a shell. `shell` is an explicit compatibility escape hatch that must pass static parsing, command-policy validation, environment inference, and round-trip materialization checks.

The compiler validates the exact representation that the runtime will execute. It must prove that refinement manifest serialization, ticket materialization, migration, and reload preserve identical command semantics.

Legacy string commands are migrated into structured contracts when safely representable. Unsafe legacy commands enter autonomous contract repair before any implementation-model call.

### Checkpointed Phase Graph

The default medium-risk graph is:

1. `prepare`: compile contract, validate scope/env, capture baseline.
2. `context`: produce approved research and plan checkpoint.
3. `implement`: create a candidate patch checkpoint.
4. `verify`: run ticket-specific deterministic verification.
5. `review`: independently inspect the verified candidate.
6. `conformance`: prove exact acceptance-criteria coverage.
7. `quality`: run repository-level quality gates.
8. `promote`: commit and persist completion evidence.

Every checkpoint includes input hashes, output hashes, repository base, contract seal, producing strategy, and validation evidence.

Deterministic ticket verification must occur after implementation and before review, simplification, conformance, or repository-wide quality work.

Review or conformance refusal invalidates the candidate and downstream checkpoints only. It must not invalidate approved context unless the refusal explicitly proves that a context input was wrong.

Simplification is conditional. It runs only when risk policy, diff characteristics, or a verified finding requires it.

### Adaptive Assurance Profiles

- Low risk: prepare, implement, verify, combined review/conformance, quality, promote.
- Medium risk: context, implement, verify, independent review/conformance, quality, promote.
- High/P0: independently reviewed research and plan, implement, verify, review, conditional simplify, conformance, quality, promote.

Remediation always resumes from the smallest invalidated checkpoint regardless of assurance profile.

### Candidate Preservation

Each implementation produces a content-addressed patch or hidden-ref checkpoint before review. A refusal must preserve the rejected candidate and its findings. Remediation begins from that candidate instead of reconstructing the work from a clean baseline.

Unrelated user work remains outside candidate ownership. Quarantine, salvage, and reconstruction must never reset, stage, stash, commit, or delete unrelated paths.

### Typed Failure Routing

The engine must distinguish at least:

- `contract_invalid`
- `infrastructure_transient`
- `worker_transport`
- `artifact_invalid`
- `implementation_invalid`
- `verification_failed`
- `review_refused`
- `conformance_refused`
- `quality_failed`
- `completion_evidence_refused`
- `workspace_unsafe`
- `prd_contract_defect`

Each failure type maps to a specific recovery handler and checkpoint invalidation set. Verification execution defects and product test failures must not share a generic worker-failure path.

### Material Strategy Epochs

A recovery strategy has a stable hash derived from its handler, checkpoint, inputs, constraints, and material approach. A new epoch must change at least one material dimension.

The engine must reject consecutive epochs with identical strategy hashes. Retry budgets, time budgets, and circuit thresholds trigger selection of a new strategy; they do not terminate the logical pipeline.

If no material strategy is available for the current ticket, the engine must attempt contract repair, re-refinement, workspace reconstruction, or another dependency-ready ticket.

### Scheduler Continuity

A blocked or repairing ticket does not monopolize the scheduler. Dependency-ready tickets continue. If all tickets are blocked, the scheduler runs diagnostic, contract-repair, re-refinement, or reconstruction work until a ticket becomes runnable.

`Blocked` is a work state, not a pipeline terminal state.

### Quality and Release

Quality remains fail-closed for promotion:

- failed verification cannot promote;
- review or conformance refusal cannot promote;
- red or unavailable required quality gates cannot promote;
- Citadel refusal cannot release.

Every refusal creates autonomous remediation and preserves evidence. Quality standards must never be weakened merely to keep the pipeline active.

### Telemetry

The system must separately report:

- logical pipeline state;
- ticket attempt;
- phase attempt;
- recovery epoch and strategy hash;
- executor restarts;
- checkpoint reuse and invalidation;
- per-call input, cached input, and output tokens;
- per-phase and per-ticket duration;
- productive versus discarded work;
- verification, review, and quality outcomes;
- completed tickets and commits;
- post-seal human interventions;
- unexpected terminal transitions.

Failed and cancelled model calls must be included. `iteration` may remain for compatibility but cannot be the primary progress measure.

## Migration and Rollout

### Compatibility

- Read existing state, manifest, ticket, recovery-history, circuit-breaker, lifecycle-artifact, and salvage formats.
- Add schema migrations rather than silently rewriting unknown fields.
- Compile legacy verification strings during readiness.
- Treat existing lifecycle artifacts as reusable only when their inputs can be proven.
- Preserve session history and salvage refs across migration.

### Blue-Green Runtime Handoff

1. Build and validate the new runtime without mutating the active worker's owned paths.
2. Start the new supervisor in shadow mode against the durable session journal.
3. Persist a handoff request and safe checkpoint.
4. Transfer the logical pipeline lease atomically after the old executor releases it or its lease expires.
5. Resume at the smallest trustworthy checkpoint under the new runtime.
6. Verify that no interval exists in which the logical pipeline lacks a durable owner or restart path.

The current field session must migrate into verification-contract repair rather than restarting its ticket research.

## Machine-Checkable Acceptance Criteria

### AC-01: PRD Seal and Human Boundary

- Sealing writes a read-back-validated `prd.lock.json` containing every required contract field.
- Any semantic PRD mutation changes the seal hash.
- After sealing, no runtime state or command path may request approval, retry choice, skip choice, or implementation guidance.
- A source invariant and integration test prove `human_interventions_after_prd_seal === 0` for every injected recoverable failure.

### AC-02: Terminal-State Contract

- Normal terminal states are exactly `completed` and `cancelled`.
- Every recoverable persisted state has at least one tested autonomous outgoing transition.
- Any unexpected terminal transition records autonomy, reliability, and quality as zero.

### AC-03: Durable Supervisor

- Killing the active runner or worker causes a bounded supervisor restart from the last valid checkpoint.
- Executor restart thresholds change strategy or reconstruct state; they never terminally exhaust the logical pipeline.
- Lease tests prove that at most one executor owns a pipeline and that expired ownership is recoverable.

### AC-04: Structured Verification

- `process` and `package_script` steps execute through argument arrays without a shell.
- Structured commands round-trip through manifest materialization and reload without semantic changes.
- Shell commands require an explicit justification and pass static and policy validation.
- The malformed regex/backtick field command from session `2026-08-07-c2565014` is rejected or safely compiled before implementation.

### AC-05: Early Contract Validation

- Invalid verification, scope, environment, and dependency contracts are detected before the first implementation-model call.
- Contract defects route to autonomous repair or `prd_revision_required`, never generic worker retry.

### AC-06: Gate Ordering

- A trace assertion proves `implement < verify < review < conformance < quality < promote`.
- A failed verification command produces zero review, simplify, conformance, quality, or promotion calls for that candidate.

### AC-07: Checkpoint Reuse

- Review refusal invalidates candidate and downstream checkpoints only.
- A remediation attempt with unchanged context performs no research or planning model calls.
- Candidate patches and refusal evidence survive runner restart and runtime handoff.

### AC-08: Typed Recovery

- Every declared failure type has a unit-tested handler and checkpoint invalidation policy.
- Invalid command execution is never recorded as generic `worker_failure`.
- Review and Citadel refusals automatically enqueue remediation.

### AC-09: Strategy Novelty

- Consecutive recovery epochs with identical strategy hashes are rejected.
- Crossing retry, time, or circuit thresholds persists and executes a materially different strategy.
- A no-progress fixture demonstrates at least three distinct strategies without requesting human input or terminating.

### AC-10: Scheduler Continuity

- When one ticket enters repair, an independent dependency-ready ticket runs.
- When all implementation tickets are blocked, a diagnostic, repair, re-refinement, or reconstruction task runs.
- No recoverable scheduler state remains idle without a scheduled wakeup or active executor.

### AC-11: Quality Preservation

- Failed deterministic checks, review, conformance, quality gates, or Citadel cannot promote or release work.
- Each refusal persists evidence and creates autonomous remediation.
- No recovery path weakens or deletes an acceptance criterion to obtain a pass.

### AC-12: Repository Safety

- Unrelated tracked and untracked work survives every injected failure, cancellation, quarantine, reconstruction, and handoff.
- Unsafe candidates are archived before reconstruction.
- Destructive broad reset, checkout, cleanup, stash, or staging commands remain forbidden.

### AC-13: Honest Telemetry

- Successful, failed, timed-out, and cancelled model calls record tokens and duration.
- Status distinguishes ticket attempts, phase attempts, recovery epochs, executor restarts, and checkpoint reuse.
- Metrics expose productive and discarded work and do not report an active hot loop as completed progress.

### AC-14: Efficiency Budget

- An integration fixture equivalent to the observed field run, containing one malformed command and two review refusals, completes in at most 15 model calls.
- The fixture performs at most one research and one planning pass when their inputs do not change.
- The malformed command causes no implementation-model call until its contract is repaired.

### AC-15: Live Migration

- A legacy active session migrates without losing state history, refusal evidence, recovery history, ticket status, completion evidence, or salvage refs.
- Blue-green handoff proves exclusive lease ownership and automatic takeover after old-executor loss.
- The migrated session resumes at the smallest trustworthy checkpoint rather than restarting research.

### AC-16: Regression and Release

The following commands pass:

```bash
npm --prefix extension run build
npm --prefix extension run typecheck
npm --prefix extension run lint
node --test extension/tests/productive-autonomy-contract.test.js
node --test extension/tests/structured-verification.test.js
node --test extension/tests/checkpoint-recovery.test.js
node --test extension/tests/durable-supervisor.test.js
node --test extension/tests/live-session-migration.test.js
npm --prefix extension test
git diff --check
```

Citadel must approve the sealed acceptance criteria before release. A Citadel refusal routes back to autonomous remediation rather than ending the pipeline.

## Delivery Sequence

1. Seal schema and post-PRD human-boundary invariants.
2. Durable event journal, supervisor lease, and watchdog recovery.
3. Structured verification compiler and legacy migration.
4. Checkpoint graph and corrected deterministic gate ordering.
5. Typed recovery and material-strategy enforcement.
6. Candidate preservation and minimal-phase remediation.
7. Scheduler continuity and all-blocked repair behavior.
8. Complete telemetry and efficiency budgets.
9. Blue-green legacy-session migration.
10. Full failure matrix, Citadel, installation, and live dogfood release.

## Approval

Approval of this PRD is the final human implementation decision. After approval, the sealed contract governs autonomous delivery. Any later human participation must occur only through a formally reopened PRD-development state.
