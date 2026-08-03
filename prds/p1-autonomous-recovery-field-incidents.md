# PRD: P1 Autonomous Recovery Field Incidents

## Status

Ready for refinement.

## Summary

Fix the Pickle Rick failures observed while launching the LoanLight Rule Explorer
pipeline. Generated artifacts, a fresh dependency-less worktree, and a review
refusal each caused the runner to exhaust a ticket and stop rather than
recovering from the bounded, diagnosable condition.

## Field evidence

- Session `2026-08-02-429773fc`: synthesis emitted an unquoted Jest pattern,
  causing `preflight-unsafe-glob` before ticket execution.
- Session `2026-08-02-dd376715`: two synthesis outputs misused shared source
  directories as `output_artifacts`; after bounded repair the runner stopped
  instead of switching to an independent refinement fallback.
- Session `2026-08-02-e947aa91`: a clean LoanLight worktree lacked
  `node_modules`; missing `tsc`, `tsx`, `jest`, and `vitest` consumed
  ticket attempts. After dependencies were installed manually, review
  refusals (`review.json` missing/without `verdict: approved`) consumed two
  identical full-ticket attempts and stopped the pipeline.

## Requirements

1. Treat generated-manifest defects as recoverable. Canonicalize known-safe
   runner regex arguments; prompt strict artifact ownership; retain the
   rejected candidate and route exhausted synthesis repair to an independent
   fallback refinement.
2. Add a bounded dependency-bootstrap phase before quality baselining. Detect
   a supported lockfile/package manager, install deterministically, record the
   command/result, and rerun readiness. Credential, network, or lockfile
   failures must be explicit recoverable environment state, never ticket
   failures.
3. Turn a lifecycle review refusal into a remediation loop: persist its
   findings, re-enter implementation with that evidence, and retry only the
   affected lifecycle phases. Do not rerun research/plan unchanged or exhaust
   the whole ticket on an identical refusal.
4. Persist a typed recovery history with attempt budgets, cause, action, and
   next checkpoint. Terminal stop is allowed only for cancellation, exhausted
   recovery budget with no new remediation path, or verified unsafe/corrupt
   state.

## Acceptance criteria

- A generated `--testPathPattern` or `--testNamePattern` containing
  wildcards or alternation reaches the runner as one literal argument.
- A shared implementation directory in `output_artifacts` is rejected before
  ticket materialization, then fallback refinement produces a non-overlapping
  plan or a typed, resumable recovery state.
- A clean pnpm worktree with a lockfile installs dependencies before baseline
  quality commands run; a failed install is recorded as environment recovery.
- A review refusal causes an evidence-carrying implementation remediation
  attempt and does not repeat unchanged research/plan phases.
