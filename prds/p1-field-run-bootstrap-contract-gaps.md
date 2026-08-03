# PRD: P1 Field-Run Bootstrap Contract Gaps

## Status

Ready for refinement.

## Summary

Harden Pickle Rick's PRD-to-tmux bootstrap after a real `loanlight-api` field
run exposed three fail-closed contract gaps:

1. refinement synthesis emitted descriptive and globbed `proof_corpus` entries
   that the manifest validator rejects;
2. repository quality discovery returned no commands for a pnpm monorepo whose
   root scripts were named `typecheck:all`, `lint:all`, and `test:all`, then
   baseline persistence rejected the empty command set; and
3. `pickle-tmux` printed a successful launch and exited zero before runner
   preflight failed and destroyed the tmux session.

Keep strict path validation and quality gates. Align prompts, discovery,
baseline semantics, and launcher handoff so valid repositories do not require
PRD wording tricks or compatibility scripts.

## Field evidence

Repository under test: `loanlight-api`.

- Session `2026-07-24-a1f58326` failed refinement with:
  `invalid ticket scope path: packages/api/** at frozen source commit` and
  `invalid ticket scope path: packages/api/infra/** assignment`.
- The invalid values were synthesized into `proof_corpus`, while
  `resolveTicketScope()` correctly rejects glob and annotation syntax.
- Session `2026-07-24-c0a9d0ec` printed
  `Pickle Rick tmux mode launched` and exited zero, but ticket `aud-001` failed
  immediately on the clean-worktree preflight and the owned tmux session was
  removed.
- After the worktree was cleaned, the resumed runner failed twice with
  `quality-baseline-write-failed`.
- The persisted baseline contained `commands: []` and
  `command_contract: {}` because root quality discovery recognizes only the
  exact script names `typecheck`, `lint`, and `test`.
- `loanlight-api` already declared the equivalent workspace commands as
  `typecheck:all`, `lint:all`, and `test:all`.
- `evaluateWorkerQualityGate()` already models a repository with no portable
  quality commands as `absent`, but `assertQualityBaselineFresh()` rejects an
  empty command list. Those contracts disagree.

## Motivation

These failures occur before any implementation worker can make progress. They
consume refinement work, leave blocked session state, and require a human to
reverse-engineer hidden runtime grammar.

Fail-closed behavior is correct when scope or verification is genuinely
ambiguous. It is not correct for the synthesizer to violate an undocumented
consumer grammar, for a supported monorepo naming convention to produce an
internally inconsistent empty baseline, or for a launcher to report success
after ownership has transferred to a runner that immediately fails preflight.

## Users and critical journeys

- As a PRD author, I can describe recursive repository scope in normal prose
  without causing the refinement model to place prose or globs in path-bearing
  manifest fields.
- As a monorepo maintainer, existing workspace-wide `*:all` quality scripts are
  discovered without adding redundant aliases solely for Pickle Rick.
- As a repository with no portable quality command, I receive an explicit
  `absent` quality-gate result rather than an impossible baseline-persistence
  failure.
- As a tmux user, a zero-exit successful launch means the session survived
  startup preflight and remains attachable.
- As an operator, a failed bootstrap reports the exact failing contract and
  preserves enough session evidence for retry.

## Requirements

### R1: Publish one strict path-field grammar to refinement

Update the synthesis prompt to state that all path-bearing fields use literal,
normalized, repository-relative paths:

- `allowed_paths`
- `output_artifacts`
- `proof_corpus`
- `freeze_contract.artifact_path`

The prompt must explicitly prohibit:

- glob or wildcard characters;
- absolute paths;
- `.` or parent traversal;
- commit qualifiers;
- assignment labels; and
- descriptive prose appended to a path.

The prompt must distinguish existing evidence paths from artifacts a ticket
will create. Broad recursive evidence uses a literal directory such as
`packages/api`, with recursive intent in the ticket description.

Do not relax `resolveTicketScope()` to accept or silently reinterpret globs or
prose.

### R2: Perform one bounded manifest-repair pass

When refinement synthesis writes both required artifacts but manifest
validation fails:

1. preserve the original invalid manifest and validation diagnostics in the
   session;
2. invoke one repair pass with the exact diagnostics, strict path grammar,
   original PRD, analyst reports, refined PRD, and invalid manifest;
3. require the repair pass to rewrite only the refined PRD and manifest;
4. validate the repaired manifest through the same production validator; and
5. fail closed after that single repair if any error remains.

Do not regex-rewrite model output or guess whether an invalid value meant a
file, directory, glob, or annotation.

The refine log must distinguish initial validation, repair attempt, repaired
validation, and terminal failure.

### R3: Discover conventional monorepo quality scripts

For JavaScript package roots, discover at most one script for each quality
category, in this precedence order:

1. exact `typecheck`, `lint`, or `test`;
2. corresponding `typecheck:all`, `lint:all`, or `test:all`.

Use the detected package manager exactly as current discovery does. Preserve
the chosen script name and exact script definition in `command_contract`.

Do not execute both the exact and `:all` variant. Do not infer arbitrary script
names from substrings.

### R4: Make an empty quality contract internally consistent

A repository with no discoverable portable quality commands must have a valid,
persistable baseline:

- `commands` is empty;
- `command_contract` is empty;
- freshness still pins `head_sha` and `captured_at`; and
- the worker gate reports `absent`.

An empty contract is not a bypass when the repository declares a supported
quality script. Discovery and freshness tests must prove that supported scripts
cannot silently disappear.

Log the discovered command list or an explicit `quality gate absent` message
before worker execution.

### R5: Add a startup handoff to `pickle-tmux`

After creating the tmux session, wait for a bounded startup handshake recorded
in session state:

- success requires the runner to survive readiness/preflight and enter active
  ticket execution, including quality-baseline capture; or
- failure occurs if the runner reaches a terminal error, the tmux session
  disappears, or the handshake cannot be authenticated against the launched
  runner identity.

Only print `Pickle Rick tmux mode launched` and exit zero after successful
handoff. On failure:

- exit nonzero;
- print the session directory, failing ticket, failure reason, and runner log;
- do not claim the session is attachable; and
- preserve the normal fail-closed cleanup policy.

The handshake must not wait for completion of repository quality commands or
the ticket. It only proves that startup ownership transferred to a live,
authenticated runner and that no synchronous preflight failure has already
terminated it.

## Machine-checkable acceptance criteria

Run from the `pickle-rick-codex` repository root.

1. The synthesis prompt documents the strict path grammar and its field names:

   ```bash
   node --test extension/tests/prompts-prd-contract.test.js
   ```

2. Refinement integration tests prove:

   - a first manifest containing annotated or globbed `proof_corpus` paths is
     rejected;
   - exactly one diagnostic repair pass receives the validation errors;
   - a valid repaired manifest proceeds;
   - a second invalid manifest fails closed;
   - the invalid original and diagnostics remain in session evidence; and
   - no regex or silent path coercion occurs.

   ```bash
   node --test extension/tests/refinement-team.test.js extension/tests/refinement-manifest.test.js
   ```

   If the existing refinement integration test has a different filename, use
   the owning test file and update this command in the refined PRD.

3. Quality discovery and baseline tests cover npm, pnpm, yarn, and bun where
   supported by the existing harness:

   - exact scripts win over `*:all`;
   - `*:all` is used when the exact script is absent;
   - only one command per category is selected;
   - the exact selected script definition is stored in the contract;
   - arbitrary similarly named scripts are ignored;
   - an empty baseline persists and re-reads successfully;
   - empty quality evaluates as `absent`; and
   - removing or redefining a discovered command makes the baseline stale or
     the worker gate red.

   ```bash
   node --test extension/tests/execution-gate.test.js
   ```

4. Tmux integration tests prove:

   - immediate pre-existing-dirt failure returns nonzero and never prints the
     success banner;
   - immediate baseline-contract failure returns nonzero and never prints the
     success banner;
   - successful runner handoff returns zero and prints an attachable session;
   - handshake timeout fails closed;
   - a stale or foreign runner identity cannot satisfy handoff; and
   - the launcher does not wait for a long-running quality command to finish.

   ```bash
   node --test extension/tests/pickle-tmux.test.js extension/tests/mux-runner.test.js
   ```

5. Source and compiled runtime remain aligned:

   ```bash
   npm --prefix extension run typecheck
   npm --prefix extension run lint
   npm test
   npm run release:gate
   ```

6. Installation validation proves the fix is present in the installed runtime:

   ```bash
   bash install.sh
   npm run test:installed
   ```

7. No test-only quality override becomes a production configuration surface:

   ```bash
   ! rg -n "PICKLE_TEST_QUALITY_COMMANDS" README.md docs skills
   ```

## Out of scope

- Weakening scope containment or accepting globbed mutation ownership
- Automatically guessing corrections for ambiguous model-produced paths
- Running arbitrary user-configured shell commands as quality discovery
- Discovering every possible monorepo script naming convention
- Treating missing quality commands as a passing quality gate
- Waiting for full baseline or ticket completion before tmux launch returns
- Changing retry limits for worker implementation failures
- Repairing or resuming the historical LoanLight sessions
- Time estimates

## Technical notes

- Prompt ownership is in `extension/src/services/prompts.ts`.
- Scope grammar is enforced by
  `extension/src/services/execution-gate.ts#resolveTicketScope`.
- Manifest validation routes through the same scope resolver; keep one source of
  truth.
- Quality discovery, contract capture, freshness, and absent-gate semantics are
  in `extension/src/services/execution-gate.ts`.
- Worker baseline persistence is initiated by
  `extension/src/bin/spawn-morty.ts`.
- Tmux bootstrap and handoff ownership belong in
  `extension/src/bin/pickle-tmux.ts` and related runner/session services.
- Add regression fixtures to existing test families rather than creating an
  unreferenced parallel harness.

## Release priority

P1. This blocks reliable autonomous runs in otherwise valid monorepos and makes
the launcher success contract untrustworthy.

