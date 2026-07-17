# Adversarial Review #3 — Integration, Wiring & Port Completeness

**Reviewer lens:** integration/wiring correctness + port completeness.
**Mode:** READ-ONLY. No code modified.
**Scope:** oracle + safety seams port (`ticket-completion-evidence`, `dirty-tree-salvage`, `isForeignTmuxSession`, `listWorkingTreeDirtyPaths`) against contract `prds/_port-spec-oracle-seams.md`.
**Baseline:** GREEN (typecheck/lint/build; 163/163 tests) per parent handoff.

## Verdict

The port is substantially complete and the headline integration claims hold: the completion oracle **is** wired into `spawn-morty.ts` as the single seam, `mux-runner.ts` **does** honor an oracle refusal (`RunTicketResult.status`), and the "honor-oracle-refusal" commit is genuinely closed for the commit-producing path. The three standalone seams (dirty-tree-salvage, tmux guard, `listWorkingTreeDirtyPaths`) are correctly shipped unwired-by-design and are fully unit-tested. **All port-spec "Tests to mirror" are present (0 missing required tests).**

I found **one real correctness gap (MEDIUM)** in the spawn-morty completion tail's no-new-commit fallback and **one status-hygiene gap (MEDIUM)** in the refusal path, plus a few LOW/NIT items. No CRITICAL/HIGH defects.

---

## Findings (CRITICAL/HIGH first)

| ID | Severity | File:line / area | Description | Concrete gap / failure scenario | Suggested fix |
|----|----------|------------------|-------------|----------------------------------|---------------|
| F1 | MEDIUM | `extension/src/bin/spawn-morty.ts:612-628` (completion tail `committedCandidateExists` fallback) | On oracle refusal, Done is withheld ONLY when `getHeadSha(workingDir) !== baselineHeadSha`. A **hard-absent** refusal (`foreign_attribution`, `baseline_sha`, `unreachable_explicit_unattributable`) can be produced by a *pre-existing* explicit `completion_commit` even when this run made **no new commit** — and in that case the code falls to `finalizeSuccess(applied)` and flips Done anyway, retaining the rejected stamp. The gate trusts HEAD-advancement instead of the refusal *reason*, so it partially defeats the R-OMA / baseline guards. | A ticket carries a surviving `completion_commit` that is reachable-but-foreign (points at a sibling's commit) or equals the session baseline (hand-authored manifest, prior session, or a stamp preserved across a re-flip per R-WDTF). It is retried; the worker is a no-op so `HEAD == baselineHeadSha`. `evaluateCompletionEvidence` correctly returns `{ok:false, reason:'foreign_attribution'/'baseline_sha'}`, but `committedCandidateExists === false` → `finalizeSuccess` marks the ticket **Done** with the foreign/baseline pointer intact — a phantom-Done the oracle explicitly tried to prevent. | Gate the fallback on the refusal *reason*, not HEAD movement: only `finalizeSuccess` when `decision.reason === 'no_evidence'` (genuinely nothing to attribute). For `foreign_attribution` / `baseline_sha` / `unreachable_explicit_unattributable`, treat as refusal (`finalizeRefusal`) regardless of HEAD, since those signal a positively-bad stamp. |
| F2 | MEDIUM | `extension/src/bin/spawn-morty.ts:596-603` (`finalizeRefusal`) + `extension/src/bin/mux-runner.ts:159-205` | On a real (non-mocked) oracle refusal, `runTicket` returns `{status:'incomplete'}` **without resetting the ticket status**, which was set to `'In Progress'` at the start of the try block (`spawn-morty.ts:566`). Under `on-failure=abort`, mux-runner sets `exitReason='error'` and breaks with **no status write**, so the ticket is left `In Progress` on disk with no `failure_reason`/`failure_kind` recorded. This diverges from the error path (which writes `Blocked` + `failure_reason`) and the dependency-block path (`Blocked`). | Session aborts on a foreign/unattributable commit; the ticket file stays `status: In Progress` forever. On resume the mux-runner loop treats `In Progress` as runnable (`mux-runner.ts:105` only skips Done/Skipped/Blocked) so it silently re-runs, and status summaries misreport a refused ticket as still-running. The refusal reason lives only in `mux-runner.log`, not on the ticket. **This drift is untested**: `mux-runner-oracle-refusal.test.js` mocks `runTicket` so the ticket never receives the real `In Progress` write (it stays at manifest `Todo`), hiding the production status. | In `finalizeRefusal`, write a terminal/parkable status (e.g. `Todo` with `failure_reason`/`failed_at`, mirroring the preflight-Todo path) so a refused ticket carries its verdict. Add an integration test asserting the on-disk status + `failure_reason` of a *really-refused* ticket (not a mock). |
| F3 | LOW | `extension/src/bin/spawn-morty.ts:433-451` (`resolveCompletionCommitSha`) + oracle scan branch | The single-commit reconcile amends `Pickle-Ticket: <ticketId>` onto the sole post-baseline commit **regardless of its message** (`countCommitsSince == 1`). The oracle's R-OMA foreign-attribution guard only applies to the **explicit `completion_commit` field** branch, not the git-log **scan** branch, so after the amend the scan attributes even a "deliver r2 milestone"-worded single commit to the current ticket. | A single-commit window whose message names a sibling gets amended to the current ticket and then accepted via `via:'scan'`. This is arguably the *intended* single-commit reconcile semantics (one commit in the window ⇒ it is this ticket's work), and `VAL-ORACLE-030` deliberately uses TWO commits to avoid it — but the boundary is undocumented and defeats R-OMA for the single-commit case. | Document the interaction explicitly (single-commit reconcile intentionally overrides message-based foreign detection), or skip the trailer amend when the existing message positively attributes a sibling. |
| F4 | NIT | `extension/src/services/ticket-completion-evidence.ts:396-441` (`readEvidence`) | `readEvidence` reads the ticket file once via `readTextFile(tPath)` for the heading fallback, then re-reads the same file through `readFrontmatterField(tPath, …)` for each of `completion_commit`, `id`, `r_code`, `title`, `completion_commit_inferred` (Strategy B path-based helpers each `readFileSync`). 5+ synchronous reads of one small file per evidence probe; the predicate calls `readEvidence` up to 3× (backoff, promote re-probe). | No correctness impact; extra filesystem syscalls only. | Optional: parse frontmatter once and reuse, or accept the cost given file sizes are tiny. |
| F5 | NIT | `extension/src/services/ticket-completion-evidence.ts` exports `readEvidence`, `persistEvidence`, `gateForPhantomDoneRevert`; `PersistOpts.stage:'required'` | These are part of the ported API but have **no production consumer** in codex (only tests + the module's own internals). `gateForPhantomDoneRevert` exists for a phantom-Done watcher codex has not ported; `persistEvidence(..., {stage:'required'})` throw-branch is never exercised in prod. | Not dead in a harmful sense — matches the "ship the full oracle surface" intent and is test-covered. Flagged only for the completeness inventory. | Leave as-is; re-verify consumers when the phantom-done watcher lands. |

---

## Detailed trace notes

### 1. Wiring / reroute integration — VERIFIED CLOSED (with F1/F2 caveats)

- `spawn-morty.ts` completion tail (`~600-628`): runs `resolveCompletionCommitSha(...)` for its trailer-amend side effect only (return value discarded — comment at `589-593`), computes `applied`, then calls `evaluateCompletionEvidence(buildCompletionCtx({sessionDir,ticketId,workingDir}))`.
- `buildCompletionCtx` (`spawn-morty.ts:406-414`) sets `decision:'attribution'`, `startCommit:null`, `pinnedSha:null` — matching the port spec's explicit requirement that codex NEVER selects `'done-flip'` (no worker gate ⇒ would always `worker_gate_unavailable`).
- On `decision.ok` → `finalizeSuccess`. On refusal with a new commit (`committedCandidateExists`) → `finalizeRefusal` returns `{status:'incomplete', reason}` and does NOT flip Done or stamp. **This is the exact bug the "honor-oracle-refusal" commit fixes, and it is genuinely closed for the commit-producing path** (proved by `VAL-ORACLE-030` end-to-end through the bin: foreign two-commit window ⇒ ticket not Done, `completion_commit` null). F1 is the residual no-new-commit hole.
- `mux-runner.ts::runSequential` (`159-205`): `runTicketFn` result — `status === 'done'` ⇒ scrub + `ticket.status='Done'` + "completed" log; otherwise the in-memory Done mark is **withheld** and the ticket is routed through the same abort/skip/retry-once failure handling as a throw. So the in-memory Done flip honors the oracle refusal. Confirmed by all four `mux-runner-oracle-refusal.test.js` cases (abort/accept/skip/retry-once).
- The pointer write is folded into the oracle's promote-once `persistEvidence` (R-WDTF), and `stampCompletionCommit` is fully removed from `src` (grep: only a negative pin reference remains in `completion-predicate-single-seam.test.js:142`).

### 2. Dead / unreachable seams — AS DESIGNED

- `dirty-tree-salvage.ts` (3 exports) and `git-utils.listWorkingTreeDirtyPaths` + `tmux.sessionHashOf`/`isForeignTmuxSession`: exported, unit-tested, **no production consumer** — exactly what the port spec mandates ("ships standalone; no consumer wiring required"). `README.md:270-275` explicitly documents them as "shipped with tests but not yet wired into any consumer path." No accidental orphaning.
- The completion oracle, which MUST be wired, **is** wired (single seam in `spawn-morty.ts`). `completion-predicate-single-seam.test.js` PIN 1/2/3 enforce: 0 external `readEvidence(<arg>)` callsites, exactly 1 `evaluateCompletionEvidence(` in `spawn-morty.ts` and 0 elsewhere, and importer set == exactly `{spawn-morty.ts}`.

### 3. Half-ported / stubs / suppressions — NONE FOUND

- Grep of `extension/src` for `TODO|FIXME|not implemented|@ts-ignore|@ts-expect-error|eslint-disable|as any`: the only hit is `pipeline-state.ts:130 // eslint-disable-next-line no-control-regex` (a legitimate control-char regex, unrelated to this port). No stubs, no swallowed-error gaps beyond the documented best-effort `catch` blocks in the oracle/salvage modules (each annotated and intentional per the port spec's best-effort semantics). `safeErrorMessage` is properly exported from `pickle-utils.ts:10` (the salvage module's only non-node import) — no missing dependency.

### 4. Consistency / doc drift — NONE

- `README.md:270-275` (commit 806e26c) lists exactly the three standalone primitives and correctly omits the completion oracle from the "not yet wired" set (the oracle IS wired). No code/doc drift.

### 5. Working-tree / branch completeness — CLEAN

- `git status --porcelain`: only `?? prds/_audit-phase01-gap.md` and `?? prds/_port-spec-oracle-seams.md` (the two known analysis docs). No other uncommitted/untracked implementation files. Branch `main`.

---

## Missing tests — port-spec "Tests to mirror" → present/absent

| Port-spec required test | Codex file | Status |
|---|---|---|
| `ticket-completion-evidence-predicate.test.js` (R-AICF fall-through, unreachable_explicit_unattributable, baseline_sha, foreign_attribution, done-flip GREEN/RED/absent/no-verdict, phantom-watch & attribution never consult verdict, announcement recovery, promote-once via stays scan, no_evidence, gateForPhantomDoneRevert keep/revert) | `ticket-completion-evidence-predicate.test.js` (VAL-ORACLE-001…034) | **PRESENT** — all listed cases covered, incl. fallbackDir R-OMA (032) and usedFallback (033/034) |
| `has-completion-commit-explicit-source.test.js` (R-AICF quoted/unquoted × full/short unreachable → scan; `normalizeCompletionCommitField`) | `has-completion-commit-explicit-source.test.js` | **PRESENT** — 4 variants + normalize cases |
| `completion-predicate-single-seam.test.js` (PIN-1 readEvidence=0 external; PIN-2 evaluateCompletionEvidence counts; PIN-3 importer set; PIN-4 done-decision routes/attribution/.ok-gated/no bare presence-accept; FAIL-INJECTION) | `completion-predicate-single-seam.test.js` | **PRESENT** — PIN 1-4 + fail-injection, retargeted to `spawn-morty.ts` |
| New codex R-WDTF regression (completion_commit survives Done→re-flip) | `ticket-completion-evidence-predicate.test.js` VAL-ORACLE-028 | **PRESENT** |
| `services/dirty-tree-salvage.test.js` (clean→null; dirty→ref anchors tracked+untracked with worktree AND index byte-identical; salvageDirtyTree foreign>0 ⇒ ref + stagePaths===owned + foreign recoverable; foreign=0 ⇒ null/passthrough; stageOwnedPaths deleted+new, unlisted left untracked) | `dirty-tree-salvage.test.js` | **PRESENT** — all cases, incl. byte-identical index+worktree assertions |
| dirty-tree-salvage `add -A` containment (adapted, NOT the full callsite pins) | `dirty-tree-salvage.test.js` "source pin" case (exactly one `add -A`, no `add -u`, uses `GIT_INDEX_FILE`) | **PRESENT** — correctly adapted; full consumer callsite pins NOT ported (per spec) |
| `listWorkingTreeDirtyPaths` unit test (new/modified/deleted, rename second-token skip, exclude-prefix, throw on git error) | `git-list-working-tree-dirty-paths.test.js` | **PRESENT** — all 4 cases |
| `is-foreign-tmux-session.test.js` (hash mismatch→foreign true; match→false; unrelated ambient name fail-CLOSED→true; sessionHashOf) | `is-foreign-tmux-session.test.js` | **PRESENT** — incl. `pickle-dead` fail-closed case + `sessionHashOf` edge cases |
| `validateSessionDirOrSkip`/`ensureMonitorWindow`/`respawnMonitorWindowForMode` cases | — | **CORRECTLY ABSENT** — spec says do NOT port until those subsystems exist |

**Missing required tests: 0.**

Optional gaps worth adding (not port-spec-required): a test asserting the on-disk ticket status + `failure_reason` after a *real* (non-mocked) oracle refusal (would cover F2), and a predicate test for the F1 no-new-commit + surviving-foreign-stamp path.

---

## Where I found nothing wrong

- Oracle ladder ordering (baseline short-circuit → probe → foreign → explicit-wins → R-AICF fall-through → inferred → scan) matches the contract, including the fallbackDir attribution-dir fix (`ticket-completion-evidence.ts:411-418`, verified by VAL-ORACLE-032).
- `probeCatFile` 3-way distinction (exists / not-exists / git-could-not-run) is correctly used for the fallbackDir retry rather than reusing boolean `commitExists`.
- `listWorkingTreeDirtyPaths` porcelain `-z` parse (`git-utils.ts:139-157`): correct `token.slice(3)` path extraction, rename/copy second-token skip on either status column, de-dup + `localeCompare` sort, throws on non-zero git exit. Matches spec + tests.
- `stashUnattributableRemainder` throwaway-index invariant (`dirty-tree-salvage.ts`): temp `GIT_INDEX_FILE`, `read-tree`→`add -A`→`write-tree`→HEAD-tree equality bail→`commit-tree`→`update-ref`, real index/worktree untouched, temp index removed in `finally`. Byte-identical assertions in the test confirm no worktree/index mutation.
- `isForeignTmuxSession`/`sessionHashOf` are pure (no `getDataRoot()`/`readdirSync`), fail-closed, exported for testability. Matches spec verbatim.
- R-WDTF durability: promote-once persists through `updateTicketStatus({completion_commit})` into BOTH manifest and file, and `updateTicketStatus` preserves unknown frontmatter across status re-flips (VAL-ORACLE-028 proves survival across Done→Todo→Done).
