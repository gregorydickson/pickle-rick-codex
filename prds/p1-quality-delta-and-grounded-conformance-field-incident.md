# PRD: P1 Quality-Delta and Grounded-Conformance Field Incident

## Status

Ready for refinement.

## Summary

Fix two correctness defects exposed by the LoanLight subsystem-audit field run:

1. the repository quality gate classified unchanged pre-existing typecheck and
   test failures as new failures after a documentation-only ticket; and
2. the conformance phase approved an installed launcher path that did not exist
   because conformance ran before deterministic verification and accepted
   model-authored narrative as evidence.

The quality gate happened to block the bad ticket, but for the wrong reason.
The intended acceptance/conformance gate approved a false claim, while the
unrelated broad-suite gate rejected a diff that could not have caused the
reported source failures.

## Field evidence

Repository under test: `loanlight-api`.

Session: `2026-07-24-fed336a8`.

- Ticket `audit-001` changed only
  `docs/technical-debt/subsystem-audit/execution-contract.md`.
- Rejected commit:
  `c0541520b9d9ff0db40ac161ddfc84be69fe38b6`.
- The baseline already contained failures from `pnpm run typecheck`,
  `pnpm run lint`, and `pnpm run test`.
- The post-worker quality gate reported new failures for
  `pnpm run typecheck` and `pnpm run test`, despite the ticket changing no
  TypeScript, JavaScript, package, configuration, or dependency file.
- `failureSet()` in `extension/src/services/execution-gate.ts` treats every
  nonempty normalized stdout/stderr line as a failure identity.
- `sameFailureSet()` requires exact equality of those complete line sets.
- Concurrent pnpm, Jest, and Vitest output contains progress, warnings,
  completed-test subsets, worker-specific output, and other nondiagnostic
  variance. Sorting removes order variance but not set-membership variance.
- The rejected document approved
  `/Users/gregorydickson/.claude/pickle-rick/extension/bin/mux-runner.js`.
- That executable and its parent `bin` directory did not exist.
- The ticket's deterministic verification checked only that the document
  existed and contained `Status: approved` and the phrase
  `sequential codex exec`.
- The persisted conformance artifact declared all criteria passed using
  narrative evidence that repeated the nonexistent-path claim.
- Runtime deterministic verification executes after the conformance lifecycle
  phase, so conformance cannot consume runtime-owned verification receipts.
- The post-gate failure details were not persisted as structured session
  evidence; the runner log recorded only the two command names.

## Severity

P1.

- False quality deltas block valid tickets and exhaust retries.
- Ungrounded conformance can approve nonexistent executables, invalid
  infrastructure, or other false external-state claims.
- In this incident, one bug accidentally masked the other. Fixing only the
  noisy quality comparison would allow the false conformance result to proceed.

## Users and critical journeys

- As a worker, a documentation-only change is not blamed for unchanged
  pre-existing compiler or test failures.
- As an operator, a genuinely new diagnostic still blocks completion even when
  the baseline was already red.
- As a reviewer, I can inspect the exact baseline and post-worker diagnostic
  delta from session artifacts.
- As a conformance reviewer, I receive runtime-owned deterministic verification
  receipts before deciding whether each acceptance criterion passed.
- As a PRD author, every acceptance criterion maps to explicit verification
  obligations during refinement.
- As a safety owner, an LLM's prose assertion cannot prove that a file,
  executable, command, service, or external contract exists.

## Requirements

### R1: Separate diagnostics from command transcript noise

Replace full-output-line equality as the quality failure identity.

For supported quality commands, extract stable diagnostic identities from
recognized tool output:

- TypeScript compiler diagnostics;
- ESLint diagnostics;
- Jest failed suites/tests and terminal errors;
- Vitest failed files/tests and terminal errors;
- package-manager wrapper failures that identify the failing workspace and
  underlying command; and
- timeout, signal, spawn, and nonzero-without-diagnostic failures.

Diagnostic identities must retain enough information to distinguish a new
failure: tool, workspace when available, file, rule or diagnostic code, test
name, and normalized message.

Progress lines, passing-test lines, timestamps, durations, PIDs, warning
repetition, worker ordering, and partial successful-work subsets must not become
failure identities.

Do not use permissive subset comparison against raw output. For an unrecognized
failed command whose diagnostic identity cannot be extracted safely, mark
baseline subtraction unsupported and fail closed with a specific reason.

### R2: Compare stable persistent diagnostics

Keep the bounded retry used to distinguish one-off flakes, but compute
persistence from structured diagnostic identities.

- A diagnostic present in both failed baseline attempts is pre-existing.
- A diagnostic present in both failed post-worker attempts and absent from the
  baseline is new.
- A diagnostic that changes identity is new.
- A previously passing command that fails is new.
- A command-contract change remains a hard failure.
- A command that becomes green is not a regression.

The comparator must not require equality of unrelated transcript content.

### R3: Persist complete quality-gate evidence

Persist, per command:

- baseline result and diagnostic identities;
- both bounded-attempt results or a documented compact representation;
- post-worker result and diagnostic identities;
- subtracted pre-existing identities;
- remaining new identities;
- comparator version; and
- final verdict and reason.

Store this evidence under the session directory and reference it from runner
state/logs. Bound artifact size without discarding the diagnostic identities
that determined the verdict.

Runner errors must name the evidence artifact, not only the failed command.

### R4: Map every criterion to verification obligations

Extend the refined ticket contract so every exact acceptance criterion maps to
one or more verification obligations.

Each obligation identifies:

- the exact criterion;
- deterministic commands or runtime checks;
- expected result;
- required artifact or state when applicable; and
- whether the check requires repository, filesystem, process, network, or
  external-system evidence.

Manifest validation must require exact criterion coverage. A generic grep or
file-existence check cannot be reused as proof of unrelated executable,
behavioral, or external-state claims.

For the incident fixture, the criterion “selected launcher is an installed
binary” must require an executable/file check of the selected path. Text in a
Markdown document is not sufficient.

### R5: Run deterministic verification before final conformance

Reorder the completion path:

1. research and plan phases;
2. implementation, review, and simplification;
3. deterministic ticket verification;
4. persisted verification receipts;
5. final conformance review consuming the receipts;
6. repository quality delta, scope fence, and completion oracle.

If a verification command fails, final conformance must not run. If receipt
capture is incomplete or unauthenticated, conformance fails closed.

Each receipt must bind:

- ticket and criterion IDs;
- exact command/check definition;
- working directory;
- relevant environment contract without secret values;
- exit status;
- normalized evidence or artifact digest;
- repository HEAD and worktree fingerprint; and
- runner-controlled identity/timestamp metadata.

### R6: Ground conformance evidence

Conformance may add semantic analysis, but every `pass` entry must reference
runtime-owned verification receipt IDs that substantively address the exact
criterion.

Reject conformance when:

- a receipt is missing, failed, stale, or belongs to another ticket/HEAD;
- the cited receipt does not cover the criterion's declared obligation;
- evidence consists only of model-authored prose;
- a filesystem/executable claim lacks the corresponding runtime check;
- an external-state claim lacks the declared authenticated check; or
- the implementation diff contradicts the receipt.

Keep exact acceptance-criterion text matching, but do not mistake exact text
coverage for truthful evidence.

### R7: Preserve fail-closed recovery

Continue archiving and rolling back rejected worker mutations. Preserve the
conformance, verification, and quality-delta evidence that caused rejection.

Retry may correct an invalid lifecycle artifact. It must not transform a failed
verification receipt or unsupported quality comparison into a pass.

## Machine-checkable acceptance criteria

Run from the `pickle-rick-codex` repository root.

1. Quality parsing tests prove transcript noise is excluded while real
   diagnostics remain distinct:

   ```bash
   node --test extension/tests/execution-gate.test.js
   ```

   Fixtures must include TypeScript, ESLint, Jest, Vitest, pnpm recursive
   failure, timeout, and an unknown failed command.

2. A regression fixture modeled on the field incident proves:

   - the baseline and post-worker commands both fail;
   - only Markdown changes between runs;
   - progress, passing-test, PID, duration, warning-count, and worker-order
     output differs;
   - the underlying TypeScript and test diagnostics are identical; and
   - the worker quality verdict is green.

   Adding one TypeScript diagnostic or one failed test to the post-worker
   fixture must produce a red verdict naming only the new diagnostic.

3. Quality evidence persistence tests prove a red or green comparison writes a
   bounded artifact containing baseline, post-worker, subtracted, and remaining
   diagnostic identities:

   ```bash
   node --test extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js
   ```

4. Refined-manifest tests require one exact verification-obligation mapping for
   every acceptance criterion and reject missing, duplicate, or dangling
   criterion mappings:

   ```bash
   node --test extension/tests/refinement-manifest.test.js
   ```

5. Lifecycle tests prove deterministic verification runs before conformance and
   that conformance receives authenticated receipts:

   ```bash
   node --test extension/tests/worker-lifecycle-contract.test.js extension/tests/ac-phase-gate.test.js extension/tests/session-flow.test.js
   ```

6. The nonexistent-launcher regression fixture must fail:

   - the implementation writes an approved contract naming a nonexistent
     executable;
   - prose review and conformance claim it exists;
   - the runtime executable check fails;
   - no final `all_pass` conformance artifact is accepted;
   - the ticket is blocked and its mutation is archived; and
   - downstream tickets do not start.

7. A matching fixture with an actual executable and successful receipt proceeds
   through conformance and the completion oracle.

8. No completion path accepts narrative-only conformance:

   ```bash
   rg -n "verification_receipt|verificationReceipt" extension/src/services extension/src/bin
   npm --prefix extension run typecheck
   npm --prefix extension run lint
   npm test
   npm run release:gate
   ```

9. Installed-runtime validation passes after source implementation:

   ```bash
   bash install.sh
   npm run test:installed
   ```

## Out of scope

- Making existing LoanLight typecheck or test failures green
- Treating all baseline failures as ignorable
- Comparing raw output with permissive subset semantics
- Building parsers for arbitrary third-party tools without a declared adapter
- Allowing model-authored prose to act as a deterministic receipt
- Performing unauthenticated external-system checks
- Weakening mutation archival, scope fencing, or completion-oracle behavior
- Resuming the historical LoanLight session
- Time estimates

## Technical notes

- Quality command execution and current raw-line comparison are in
  `extension/src/services/execution-gate.ts`.
- Worker quality evaluation and lifecycle ordering are in
  `extension/src/bin/spawn-morty.ts`.
- Lifecycle artifact shape validation is in
  `extension/src/services/worker-lifecycle.ts`.
- Phase prompts and their current evidence instructions are in
  `extension/src/services/prompts.ts`.
- Refined ticket validation and normalization are in
  `extension/src/services/tickets.ts`.
- Reuse the existing session transaction and state services for receipt
  persistence; do not introduce an unaudited side channel.

## Trap doors

- `failureSet()` currently names every output line as a failure. Any future
  baseline subtraction built on it will confuse transcript variance with
  diagnostic variance.
- Conformance currently precedes runtime verification. A conformance artifact
  cannot truthfully cite evidence that does not exist yet.
- Exact acceptance-criterion text coverage proves only that the model repeated
  each criterion, not that its evidence is true.
- Broad-suite failure subtraction and ticket-specific deterministic
  verification are separate gates; neither can substitute for the other.

