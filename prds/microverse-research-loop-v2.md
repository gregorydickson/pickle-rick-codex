# PRD: Microverse Research Loop v2

## Summary

Repair Microverse's worker-completion seam and evolve the current flat retry loop into a durable, evidence-driven experiment loop inspired by autoresearch and Arbor.

The immediate correctness bug is that `loopSuccessCheck()` scans all raw `codex exec` stdout for promise tokens. Tool output is part of that stream. When a worker reads source containing `<promise>CONTINUE</promise>`, the monitor treats the quoted source as completion and terminates the worker before it edits the repository. The coverage dogfood session `2026-07-18-29a26bdf` demonstrated this repeatedly: one valid experiment improved line coverage from 71.24 to 73.72, while eight incomplete workers were recorded as scientific stalls.

This seam is shared by Microverse, Anatomy Park, and Szechuan Sauce. A read-only Anatomy Park review of `extension/src` reproduced the same defect in session `2026-07-18-ba0acc36`: the loop reported success without a final-message artifact or either required summary. Slice 1 therefore repairs and regression-tests the shared detached-loop contract even though the later research-loop slices are Microverse-specific.

The first release slice must fix that false completion and fail closed when a worker exits without authoritative completion evidence. Later slices add structured hypotheses, durable experiment evidence, protected evaluation inputs, runtime-owned target detection, and convergence interventions.

## Motivation

Microverse currently gets the metric safety mechanics mostly right: it establishes a clean checkpoint, measures before and after, accepts real improvements, and recoverably reverts held or regressed changes. It does not yet distinguish a valid negative experiment from an incomplete worker run, and its failed-approach memory records only iteration, classification, head, and score. Fresh workers therefore receive almost no scientific context.

Arbor's useful pattern is not parallelism by itself. It separates hypothesis selection from execution, persists both positive and negative evidence, feeds ancestor/prior insights into later experiments, protects the evaluation surface, and escalates a plateau before declaring convergence. Microverse should adopt those contracts while preserving its guaranteed sequential `codex exec` path.

## Goals

1. Eliminate completion-token false positives from tool output, source code, logs, and quoted prompts.
2. Treat missing completion evidence, worker crashes, and timeouts as execution failures rather than non-improving experiments.
3. Make the runtime, not the worker, decide whether a numeric target has been reached.
4. Persist a structured experiment ledger containing hypotheses, changes, results, and learned insights.
5. Prevent metric gaming by protecting declared evaluation inputs and detecting suspicious scope changes.
6. Escalate stalled research from warning to forced strategy change without stopping below the runtime-owned target.
7. Preserve the sequential `codex exec` path and recoverable rollback guarantees.

## Non-goals

- Native multi-agent execution as a required path.
- Concurrent experiment worktrees in the first repair release.
- Reimplementing Arbor wholesale or adding a Python runtime dependency.
- Automatically proving that an arbitrary user metric is statistically sound.
- Requiring separate development and held-out metrics for every Microverse run.

## Critical User Journeys

### CUJ-1: A worker inspects completion-token source

1. A Microverse worker reads `prompts.js`, a transcript, or a test fixture containing a promise token.
2. The monitor classifies the text as tool/source output, not authoritative assistant completion.
3. The worker continues until its actual final message is persisted.
4. Only the persisted final-message token completes the worker attempt.

### CUJ-2: A worker exits incomplete

1. `codex exec` exits zero, crashes, or times out without a valid final-message token.
2. The runtime archives bounded diagnostics and restores the iteration checkpoint.
3. The attempt is classified `worker_incomplete`, `worker_error`, or `worker_timeout`.
4. Scientific stall count and metric history do not advance.
5. The experiment may be retried up to a separate worker-failure limit.

### CUJ-3: A valid experiment fails to improve

1. The worker persists a hypothesis/experiment artifact and finishes with `CONTINUE`.
2. The runtime verifies the changed paths and evaluation integrity.
3. The metric holds or regresses.
4. The rejected diff and a structured insight are archived before recoverable rollback.
5. The next worker sees why the approach failed and must select a materially different hypothesis.

### CUJ-4: The target is reached

1. The runtime accepts an improved experiment.
2. The recorded best score satisfies the configured target relation.
3. The runtime ends successfully regardless of whether the worker guessed that the target was reached.
4. A premature worker `LOOP_COMPLETE` is treated as `CONTINUE` while the runtime target remains unsatisfied.

## Design

### Slice 1: Correct completion evidence

Make the persisted `--output-last-message` artifact the authoritative completion source for detached loops.

- Remove raw `stdout` from `loopSuccessCheck()` and `loopShouldExit()`.
- Do not treat `assistantContent` assembled from multiple streamed messages as authoritative; commentary may quote a token before final completion.
- Continue using the monitored process runner for timeout, cancellation, and draining, but arm early-success termination only after the final-message artifact contains a permitted token.
- After `codex exec` returns, require exactly one permitted final token for the current loop mode. Exit code zero without that evidence is not success.
- Persist bounded per-attempt diagnostics: exit code, signal/timeout state, whether early termination occurred, last-message presence, and scrubbed stderr tail. Do not persist raw secrets or unlimited stdout.

This is the beta-blocking repair and should ship independently of the research-loop redesign.

### Slice 2: Separate execution failures from experiment outcomes

Add two counters:

- `worker_failure_count`: consecutive attempts that did not produce valid completion evidence.
- `experiment_stall_count`: completed, valid experiments that held or regressed.

Only the second counter participates in convergence. A worker failure restores the checkpoint and retries without ending a below-target session. The legacy-named `worker_failure_limit` defaults to 3 but now defines a recovery-window threshold: timeouts expand the persisted worker budget, repeated transport failures retry the same plan, and repeated incomplete evidence rotates to a new experiment. Protected-path or control-plane tampering remains fail-closed because it is verified unsafe state, not an ordinary worker failure.

Metric measurement must not run after an invalid worker attempt. This avoids converting infrastructure failure or premature termination into fake scientific evidence.

### Slice 3: Runtime-owned target

Extend `pickle-microverse` with:

- `--target <finite-number>`
- `--target-relation gt|gte|lt|lte`

Validate relation against metric direction. Persist both fields in `loop_config.json` and metric state. After every accepted measurement, the runtime evaluates the target. Worker promise tokens express only whether the worker believes more research is useful; they do not override the numeric target.

When no numeric target is configured, current explicit `LOOP_COMPLETE` behavior remains supported.

### Slice 4: Structured experiment ledger

Replace the information-poor `failed_approaches` entries with schema-versioned experiment records:

```json
{
  "id": "exp-0007",
  "parent_id": "exp-0003",
  "hypothesis": "Add deterministic setup-session branch tests",
  "rationale": "setup-session.js has the largest reachable uncovered line set",
  "status": "planned|running|accepted|rejected|invalid",
  "baseline_score": 73.72,
  "result_score": 75.10,
  "classification": "improved|held|regressed|worker_incomplete|worker_error|worker_timeout",
  "changed_paths": ["extension/tests/setup-session.test.js"],
  "diff_artifact": "experiments/exp-0007.patch",
  "insight": "The CLI parsing branches are deterministic and add 1.38 points",
  "verification": ["npm run test:fast"],
  "attempt": 1
}
```

Before repository mutation, the worker must persist a planned experiment with a concrete hypothesis and target paths. After execution it updates the same record with changes and verification. The runtime supplies later workers a compact view containing:

- current best score and accepted lineage;
- rejected hypotheses and their insights;
- invalid attempts and failure kinds;
- uncovered or otherwise task-specific evidence artifacts;
- the required strategy-escalation level.

Use `parent_id` now so successful directions can be refined later without requiring a separate migration to a tree. Initial selection remains sequential.

### Slice 5: Evaluation integrity

Allow optional protected paths/globs in the Microverse contract. Hash them before an attempt and verify them before trusting the result. A changed protected input makes the experiment invalid and triggers rollback.

Always protect the persisted metric command/config itself. For coverage-oriented tasks, documentation should recommend protecting production-source inclusion rules and the test runner while allowing test additions. Runtime checks should also reject an apparent improvement with no repository change, as today.

Archive rejected diffs before rollback so negative evidence remains inspectable. Recovery refs remain the destructive-operation safety seam.

### Slice 6: Research-aware convergence

Replace a single hard stall threshold with deterministic escalation:

- after 3 valid non-improving experiments: `warn`, requiring a different target or hypothesis family;
- after 5: `paradigm_shift`, forbidding another sibling of the exhausted approach;
- after 8: `stalled`, requiring another non-exhausted hypothesis family while the loop continues;
- any accepted improvement resets valid-experiment stall state.

Execution failures never advance this ladder. The ledger records exhausted parents/families and the prompt explicitly includes them. This borrows Arbor's plateau intervention model without requiring concurrent executors.

## Structural Trap Doors

- Promise tokens are data as often as they are control signals. Never scan unclassified stdout, tool results, source text, or logs for completion.
- Exit code zero is transport success, not task completion.
- A no-change attempt is not automatically a held experiment; first prove the worker completed the experiment contract.
- Metric score and repository mutation must be attributed to the same checkpointed attempt.
- Rejected code may be rolled back, but its hypothesis, diff, and insight must survive.
- Worker-declared completion cannot override a runtime-owned numeric target.
- Protected evaluation files must be checked after worker execution and before metric acceptance.
- Worker-failure, scientific-stall, and no-progress circuit thresholds are recovery signals below a runtime-owned target; they must not set the session inactive.
- Worker diagnostics within one scientific iteration need an iteration-wide attempt ordinal because experiment rotation resets the experiment-local attempt counter.

## Machine-checkable Acceptance Criteria

### AC-1: Tool-output promise tokens cannot terminate a worker

- Add a fake `codex exec --json` fixture whose tool output contains `<promise>CONTINUE</promise>`, which then writes a sentinel and finally writes the real last-message artifact.
- Assert the sentinel is written and the process is not terminated until the last-message artifact contains an allowed token.
- Exercise Microverse, Anatomy Park, and Szechuan Sauce token sets through the shared predicate.
- Command: `cd extension && node --test tests/command-flows.test.js tests/session-flow.test.js`

### AC-2: Missing final evidence fails closed

- A fake worker that exits zero without `--output-last-message` evidence must be rolled back.
- Assert no post-worker metric history entry is created, `experiment_stall_count` is unchanged, and `worker_failure_count` increments.
- Assert bounded diagnostics identify `worker_incomplete`.
- Command: `cd extension && node --test tests/session-flow.test.js`

### AC-3: Completion decisions have one authoritative seam

- Add a source-audit test proving loop completion call sites use the final-message evidence helper and do not call `hasPromiseToken()` on raw `.stdout`.
- Command: `cd extension && node --test tests/completion-predicate-single-seam.test.js`

### AC-4: Numeric targets are runtime-owned

- CLI parsing accepts and persists target/relation.
- A premature `LOOP_COMPLETE` below target continues.
- An accepted score satisfying the relation terminates successfully without requiring worker `LOOP_COMPLETE`.
- Invalid target/direction/relation combinations fail before tmux launch.
- Command: `cd extension && node --test tests/session-flow.test.js tests/metric-convergence.test.js`

### AC-5: Invalid workers do not count as experiments

- Timeout, nonzero exit, zero exit without evidence, and protected-path tamper classifications increment only worker-failure state.
- Held and regressed measurements from contract-complete workers increment only experiment-stall state.
- Command: `cd extension && node --test tests/metric-convergence.test.js tests/session-flow.test.js`

### AC-6: Experiment memory survives rollback and resume

- Rejected experiments retain hypothesis, changed paths, archived diff, score, classification, and insight after the working tree returns to its checkpoint.
- Resume loads the same experiment IDs and does not repeat an already rejected normalized hypothesis without an explicit differentiator.
- Command: `cd extension && node --test tests/metric-convergence.test.js tests/session-flow.test.js`

### AC-7: Protected evaluation inputs fail closed

- Modifying a protected path invalidates and rolls back the attempt even when the metric improves.
- The improvement is never promoted to `best`.
- Command: `cd extension && node --test tests/metric-convergence.test.js tests/session-flow.test.js`

### AC-8: Recoverable thresholds never stop a below-target Microverse

- A worker that exceeds its initial timeout completes after the runtime persists a larger timeout and retries in the same runner.
- Crossing the worker recovery threshold resets the consecutive failure window without setting `last_exit_reason` to `worker_failure_limit`.
- A pre-existing scientific stall or OPEN no-progress circuit forces recovery and still permits a later accepted experiment to satisfy the target.
- Rotating experiments within one scientific iteration preserves every worker diagnostic under a unique iteration-wide attempt ordinal.
- Protected-path or control-plane tampering remains fail-closed.
- Command: `cd extension && node --test tests/session-flow.test.js`

### AC-9: Full release gates remain green

- `cd extension && npm run typecheck`
- `cd extension && npm run lint`
- `cd extension && npm run test:fast`
- `cd extension && npm run test:integration`
- `npm run release:gate`

## Delivery Plan

1. **Beta hotfix:** Slices 1-2 and AC-1 through AC-3 plus the worker-failure half of AC-5.
2. **Target contract:** Slice 3 and AC-4.
3. **Research memory:** Slice 4 and AC-6.
4. **Integrity and convergence:** Slices 5-6 and AC-7 plus remaining AC-5 cases.
5. **Dogfood gate:** Resume the coverage objective from the accepted 73.72 commit. The run must reach its configured target unless the user cancels or checkpoint/evaluator state is verified unsafe or corrupt; empty last messages may not appear as scientific stalls.

## Design Decision

Do not start by porting Arbor's parallel worktree coordinator. First fix the false completion seam and make sequential experiments scientifically legible. Once the sequential ledger, target, and integrity contracts are proven, isolated worktrees and optional parallel hypothesis dispatch can be added without changing the evidence schema.
