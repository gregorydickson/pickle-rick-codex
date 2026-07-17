# Phase 0 / Phase 1 Gap Audit — pickle-rick-codex vs pickle-rick-claude

**Scope:** Read-only audit of Phase 0 (Foundation: 4 P0 safety modules + release gate + R-WGFR/R-WDTF/B-TRGP) and Phase 1 (Reliability Backfill top-10) from `prds/p1-catch-up-to-claude-v2.0.md`. The TS migration mechanics themselves are treated as DONE and not re-audited.

**Method:** Read codex source under `extension/src/{services,bin}/*.ts`, tests under `extension/tests/*.test.js`, `git log`/`git show` of the recent `m1-*` and `recoverable-json*`/`promise-tokens*` commits, and compared against the claude reference under `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/src/`.

**Key structural finding that colors everything below:** codex has a fundamentally simpler completion model than claude. Completion is decided by "did `runTicket()` (spawn-morty) return without throwing after verification passed" — `finalizeSuccess()` flips the ticket to `Done` unconditionally, then `stampCompletionCommit()` writes a forensic `completion_commit` pointer. There is **no completion-evidence predicate**, **no worker-gate verdict**, **no phantom-done watcher**, and **no repo-wide `test:fast` gate**. Consequently, several claude bugs (R-WGFR, B-TRGP, R-TCVC, R-CWGE, the phantom-done/done-guard split) live in subsystems codex has not ported at all — they cannot be "ported as fixes" without first porting the subsystem.

---

## Phase 0 — P0 Safety Modules

### 1. `recoverable-json` — sole JSON recovery primitive — **DONE**
- **Present:** `extension/src/services/recoverable-json.ts` exports `readRecoverableJsonObject(filePath)`. Implements orphan-`.tmp.<pid>` promotion, dead-pid demotion (`shouldSkipLiveTmp`, `readProcessStartTimeMs`), R-CIFB-B coarse-mtime tie handling, first-seen-wins tie-break. Byte-for-byte parity with claude's `recoverable-json.ts` (both 4599 bytes).
- **Wired:** commits `98a7aba recoverable-json-wiring` and `8d3758d recoverable-json-wiring-tmux` route session/state and tmux `state.json` reads through it.
- **Tests:** `recoverable-json.test.js`, `recoverable-json-readdir-bound.test.js`, `recoverable-json-wiring.test.js`, `recoverable-json-wiring-tmux.test.js`.
- **Caveat (not a Phase 0 blocker):** claude's trap door requires this to be the *sole* primitive at *every* mutable-artifact read site. Codex has fewer artifacts (no scope.json, no microverse.json, no anatomy-park.json/szechuan.json cross-phase reads), so full-coverage parity will grow as those subsystems land. The primitive and its current wiring are complete.

### 2. `ticket-completion-evidence` — single completion predicate oracle (B-1SEAM WS-1 / R-AICF) — **MISSING** (stamping infra PARTIAL)
- **No oracle exists.** Grep across `extension/src` for `readEvidence`, `evaluateCompletionEvidence`, `guardCompletionCommitBeforeDone`, `scanGitLog`, `CompletionDecisionCtx` → **zero matches**. There is no `ticket-completion-evidence.ts` under any name.
- **What IS present (recent `m1-*` bundle — stamping seam only):**
  - `pickle-utils.ts`: `readFrontmatterField`, `upsertFrontmatterField`, `normalizeCompletionCommitField` (commit `d2b3dd8`).
  - `ticket-declared-files.ts`: `readDeclaredFiles` unioning `output_artifacts`/`proof_corpus`/`freeze_contract.artifact_path` (commit `036247e`).
  - `spawn-morty.ts`: `resolveCompletionCommitSha()` + `stampCompletionCommit()` write `completion_commit` frontmatter and a `Pickle-Ticket: <id>` commit trailer, reconciling untrailed worker self-commits by amending the tip when the window is a single clean commit (commits `a2a19fb`, `d5d5c97`, `2e18ac9`).
  - `git-utils.ts`: supporting `readCommitTrailer`, `amendCommitTrailer`, `countCommitsSince`, `isIndexClean`, `commitExists`.
  - Tests: `spawn-morty-stamping.test.js`, `spawn-morty-completion-resolve.test.js`, `spawn-morty-untrailed-selfcommit.test.js`, `frontmatter-helpers.test.js`.
- **Why this is not the fix:** stamping *writes* a pointer; it is not a *predicate* consulted at completion decision sites. Codex's single decision site (`finalizeSuccess` in `spawn-morty.ts`) flips `Done` on verification-pass regardless of commit evidence, and mux-runner marks `Done` in memory purely on non-throw. Nothing reads the stamp back to gate `Done`. There is no explicit-reachable-wins ladder, no unreachable-explicit fall-through, no baseline/foreign short-circuit, no single-seam pin.
- **Remaining work:**
  - Port `evaluateCompletionEvidence(ctx)` + `readEvidence()` as the one predicate (explicit-reachable → git-log-scan → inferred → fail-closed ladder).
  - Route the codex decision site(s) — `finalizeSuccess` / the mux-runner `Done` mark — through it; keep `readEvidence` callsites = 0 outside the module.
  - Add a `completion-predicate-single-seam` test + a `check-no-inferred-completion-flag`-style audit.
- **Claude reference:** `extension/src/services/ticket-completion-evidence.ts` (36 KB); trap doors in `extension/src/services/CLAUDE.md` (R-RIC-EXPLICIT and B-1SEAM WS-1 single-seam blocks); `extension/tests/completion-predicate-single-seam.test.js`, `ticket-completion-evidence-predicate.test.js`, `has-completion-commit-explicit-source.test.js`.

### 3. `dirty-tree-salvage` — shared salvage seam (B-1SEAM WS-3) — **MISSING**
- Grep for `dirty-tree-salvage`/`dirtyTreeSalvage`/`salvage`/`bystander`/`listWorkingTreeDirtyPaths` across `extension/` → **no matching files**. Neither the module nor any renamed equivalent exists. `git-utils.ts` has no `listWorkingTreeDirtyPaths` (the dependency the salvage seam needs).
- **Remaining work:** port `dirty-tree-salvage.ts` + `git-utils.listWorkingTreeDirtyPaths`; only meaningful once microverse auto-rescue exists (see item 13).
- **Claude reference:** `extension/src/services/dirty-tree-salvage.ts` (6289 bytes); `git-utils.ts`.

### 4. `promise-tokens` — worker-output token scrubbing — **DONE**
- **Module:** `promise-tokens.ts` exports `PROMISE_TOKENS`, `FORBIDDEN_WORKER_TOKENS`, `scrubForbiddenWorkerTokens` (commit `4cd7a60`; matches claude's 2821-byte module).
- **Companion API + wiring:** `worker-output.ts` exports `scrubWorkerOutput`, `readScrubbedWorkerMessage`, `scrubWorkerMessageFile`, `scrubTicketWorkerMessages` (commit `d5d4ad4`). Wired into `mux-runner.ts` (`scrubTicketWorkerMessages(sessionDir, …)` after each `runTicket`) and into `loop-runner.ts`.
- **Tests:** `promise-tokens.test.js`.
- **Minor divergence (non-blocking):** claude's trap door pins scrubbing on *every* worker stdout/stderr stream *before* promise-token detection. Codex scrubs the last-message artifact at the consumption boundary rather than the live stream; adequate for the codex model but not identical placement.

### 5. `isForeignTmuxSession` ownership guard in tmux helpers — **MISSING (subsystem absent)**
- `extension/src/services/tmux.ts` contains only `ensureTmuxAvailable`, `tmuxSessionExists`, `runTmux`, `waitForTmuxRunnerStart` etc. No `isForeignTmuxSession`, no `sessionHashOf`, no `display-message -p #S`, no `restartDeadWatcherPanes`/`ensureMonitorWindow`/`respawnMonitorWindowForMode`. Grep confirms **zero matches** in codex src.
- The guard in claude lives in `pickle-utils.ts` and protects the monitor-window / watcher-pane respawn subsystem (`send-keys`, `kill-window`, `respawn-pane -k`). **Codex has not ported that subsystem at all**, so there is currently no destructive tmux surface for the guard to protect — but AC-7 and Phase 0 item 8 still require it, and it must land alongside any monitor-respawn port.
- **Remaining work:** add `isForeignTmuxSession(sessionName, sessionDir)` (compare trailing `-`-delimited hash of ambient `#S` vs `path.basename(sessionDir)`, fail CLOSED) and call it before any tmux mutation, whenever the monitor-respawn subsystem is ported.
- **Claude reference:** `extension/src/services/pickle-utils.ts` (`isForeignTmuxSession` ~line 2083; consumers at ~2041/2449/2734); trap door in `extension/src/services/CLAUDE.md`; `extension/tests/restart-dead-watcher-panes-sessiondir-validation.test.js`.

### 6. Release gate — **PARTIAL (minimal)**
- **Codex `extension/package.json` scripts:** `typecheck` (`tsc --noEmit`), `lint` (`eslint src/`), `build` (`tsc`, with `prebuild` → `copy-shell-assets.sh`), `audit:test-tiers`, `pretest` (`build` + `audit:test-tiers`), `test` = `test:fast` + `test:integration` (2 tiers).
- **Codex `extension/scripts/`:** only `audit-test-tiers.sh` (enforces `// @tier:` header) and `copy-shell-assets.sh`. That's it.
- **Audit scripts claude has that codex lacks** (from `pickle-rick-claude/extension/scripts/`): `audit-trap-door-enforcement.sh`, `audit-phantom-done-call-sites.sh`, `check-no-inferred-completion-flag.sh`, `audit-guarded-reset.sh`, `audit-ac-command-glob-safety.sh`, `audit-bundle-thesis.sh`, `audit-canary-flip.sh`, `audit-citadel-wiring.js`, `audit-closer-template-compliance.sh`, `audit-design-ground-truth.sh`, `audit-fix-commits.sh`, `audit-quarantine.sh`, `audit-readiness-allowlist.sh`, `audit-subprocess-heavy-tests.sh`, `audit-subsystem-claude-md.sh`, `audit-test-isolation.sh`, `audit-un-terminalize-single-path.sh`, `check-flake-budget.sh`, `check-scope-schema-parity.js`, `check-wired.sh`, `coverage-delta.sh`, `regression-test-fast-integration-3x.sh`, plus a 3rd `test:expensive` tier and coverage gates. (~22 scripts vs codex's 1.)
- **Remaining work:** the Phase 0 exit bar ("minimal gate: tsc + eslint + node --test") is effectively met. Full parity (the ~10 core audit scripts + `test:expensive` tier + flake budget) is Phase 4 per the PRD; the two most relevant to Phase 0/1 correctness — `audit-trap-door-enforcement.sh` and a `check-no-inferred-completion-flag`/`audit-phantom-done-call-sites` analog — should be pulled forward once the completion oracle lands.
- **Claude reference:** `pickle-rick-claude/extension/package.json` scripts block; `pickle-rick-claude/extension/scripts/*`.

---

## Phase 0 — Reliability Fixes

### 7. R-WGFR — single flaky `test:fast` false-red fatals green bundle — **MISSING (subsystem absent)**
- Grep for `test:fast`/`worker.?gate`/`flaky`/`greenBundle`/`false.?red` in codex src → **zero matches**. Codex runs only the per-ticket `verificationCommands` from the manifest (`runVerificationCommand` in `spawn-morty.ts`) with baseline subtraction (`subtractBaselineFailures`). There is no repo-wide worker `test:fast` gate, hence no flaky-single-test-false-red class to de-flake.
- **Remaining work:** N/A until a worker gate exists (co-arrives with the completion oracle / worker-gate verdict, item 2). Then port the flaky-retry/de-flake logic.
- **Claude reference:** `ticket-completion-evidence.ts` R-CWGE worker-gate verdict (~lines 663–816); `extension/scripts/check-flake-budget.sh`.

### 8. R-WDTF — Done-flip erases `completion_commit` pointer — **PARTIAL (avoided by ordering; no invariant test)**
- In codex `finalizeSuccess()` calls `updateTicketStatus(Done)` **first**, then `stampCompletionCommit()` writes `completion_commit` **last**. `updateTicketStatus` (tickets.ts ~981) does a targeted regex replace of the `status:` line and only rewrites keys it is given, preserving any pre-existing `completion_commit` frontmatter. So the specific "Done-flip wipes the pointer" ordering bug is structurally avoided today, and the stamp survives subsequent status rewrites (retry/reconcile) because unknown frontmatter keys are never stripped.
- **Gap:** there is no oracle-level guard that *requires* the pointer to survive across re-flips, and **no regression test pins the invariant** ("flipping status must not drop `completion_commit`"). The stamp is also written in a separate read-modify-write from the Done flip, so the guarantee is incidental, not enforced.
- **Remaining work:** add a regression test asserting `completion_commit` persists across a Done→(re)flip cycle; fold the pointer write into the completion oracle so it is guaranteed, not order-dependent.
- **Claude reference:** `ticket-completion-evidence.ts`; `extension/scripts/audit-phantom-done-call-sites.sh`.

### 9. B-TRGP + R-TCVC — worker gate is NO-OP on non-pickle-rick repos; portable gate needed — **MISSING (subsystem absent)**
- No worker gate exists in codex (grep `pickle-rick`/`non-pickle`/`portable`/`repoIsPickle` → only data-root/email-identity hits). The per-ticket verification path already runs the ticket's manifest `verification` commands in *any* repo (it is not gated on the repo being pickle-rick), so the "NO-OP on foreign repos" defect does not manifest — but neither does a portable *green-bundle* worker gate.
- **Remaining work:** N/A until the worker-gate/completion-oracle subsystem is ported; then ensure the gate is repo-portable by construction.
- **Claude reference:** `ticket-completion-evidence.ts` (worker-gate verdict); trap-door B-1SEAM block in `extension/src/services/CLAUDE.md`.

---

## Phase 1 — Top-10 Reliability Fixes

### 10. B-WSPU — collapse dual worker-spawn to single synchronous lifecycle — **DONE (by construction) / N/A**
- Codex already has a single synchronous worker lifecycle: `mux-runner.ts::runSequential` awaits `spawn-morty.ts::runTicket` in-process; there is no competing detached per-worker spawn model. `detached-launch.ts` is the *session-level* tmux bootstrap (launching the runner), not a second per-ticket worker-spawn path. No dual-lifecycle to collapse.
- **Remaining work:** none for the collapse itself. (If claude's `worker-shutdown.ts` semantics are later desired they can be added, but that is not the B-WSPU collapse.)
- **Claude reference:** `pickle-rick-claude/extension/src/bin/mux-runner.ts`, `backend-spawn.ts`.

### 11. B-1SEAM WS-1 (R-AICF) — single completion predicate routes all decision sites — **MISSING** (see item 2; same gap). Stamping infra present; predicate + routing absent. Est. the largest single piece of Phase 1.

### 12. B-1SEAM WS-2 (R-PSCG) — symmetric citadel self-heal for `start_commit` — **MISSING**
- Grep for `start_commit`/`citadel` in codex src → **zero matches**. No `start_commit` concept, no citadel, hence no self-heal to make symmetric.
- **Remaining work:** depends on porting the completion oracle (item 2) and citadel (Phase 2). Add `start_commit` capture + symmetric self-heal once those exist.
- **Claude reference:** `ticket-completion-evidence.ts`; `citadel/audit-runner.ts` (R-PSCG self-heal); trap doors in `extension/src/services/CLAUDE.md`.

### 13. B-1SEAM WS-3 (R-MACB) — bystander-stash on microverse auto-rescue — **MISSING**
- No `microverse-state.ts`, no auto-rescue path, and no `dirty-tree-salvage`/bystander-stash in codex (grep → nothing). `pickle-microverse.ts` bin exists as a launcher but there is no violation-ledger/auto-rescue runtime.
- **Remaining work:** port `dirty-tree-salvage.ts` (item 3) + `microverse-state.ts` auto-rescue, then wire bystander-stash.
- **Claude reference:** `dirty-tree-salvage.ts`, `microverse-state.ts` (`updateViolationLedger`), trap door in `extension/src/services/CLAUDE.md`.

### 14. B-SSVR (R-SSBR) — scope-resolver fail-CLOSED — **MISSING**
- No `scope-resolver.ts`, no `scope.json`, no `refreshScope` in codex (grep → nothing). The entire scope-fence subsystem is absent, so there is no fail-open behavior to harden into fail-closed yet.
- **Remaining work:** port `scope-resolver.ts` with fail-CLOSED semantics (and route `scope.json` reads through `recoverable-json`, per claude's trap door).
- **Claude reference:** `extension/src/services/scope-resolver.ts` (32 KB); trap door + OPEN GAP note in `extension/src/services/CLAUDE.md`.

### 15. B-SSVR (R-ISVP) — install.sh prerelease semver fix — **MISSING (N/A today)**
- Codex `install.sh` has **no version/semver logic at all** (grep for `version`/`prerelease`/`semver`/`beta` → nothing). Claude's `install.sh` has a `comparePrerelease` (mirrors `check-update.ts`, release > prerelease, ident lexical then num numeric) around line 77. There is no buggy comparator in codex to fix — the capability is simply absent.
- **Remaining work:** if update/version-gating is desired, port claude's `comparePrerelease` correctly; otherwise this item is not applicable to the current codex install flow.
- **Claude reference:** `pickle-rick-claude/install.sh` (`comparePrerelease`, ~line 77); `check-update.ts`.

### 16. gate-overreach subtraction — advisory gates, delete forward-ref grammar — **N/A (nothing to subtract)**
- Codex has no forward-ref grammar (`forward-ref-annotation.ts` absent), no iteration-0 gate, and no ticket-audit/citadel gates (grep → nothing). The overreaching gates this item removes were never ported, so there is nothing to make advisory or delete.
- **Remaining work:** none for Phase 1. Ensure any future citadel/gate port lands with the advisory posture already applied (do not reintroduce the overreach).
- **Claude reference:** `forward-ref-annotation.ts`; `citadel/*`; convergence-gate advisory logic.

### 17. B-RASO + B-RRPC + B-CSHYG — recovery attributable-work single oracle + sprawl collapse — **MISSING (subsystem absent)**
- No `recovery-controller.ts`, no `attributable`/`recoverAttributableWork`/recovery-sprawl code in codex (grep → nothing). Codex recovery is limited to `bin/retry-ticket.ts` and `bin/cancel.ts`; there is no multi-path recovery sprawl to collapse into one oracle.
- **Remaining work:** port `recovery-controller.ts` with a single attributable-work oracle if/when the fuller recovery model is adopted (this is largely Phase 2/4 territory per the PRD's service priorities).
- **Claude reference:** `extension/src/services/recovery-controller.ts` (15.7 KB); trap doors in `extension/src/services/CLAUDE.md`.

### 18. R-WGFR (duplicate of #7) — **MISSING (subsystem absent).** See item 7.

### 19. B-TRGP + R-TCVC (duplicate of #9) — **MISSING (subsystem absent).** See item 9.

---

## Summary Table

| Item | Fix | Status | Est. effort |
|------|-----|--------|-------------|
| 1 | `recoverable-json` sole primitive | DONE | — |
| 2 | `ticket-completion-evidence` single oracle (WS-1/R-AICF) | MISSING (stamping infra PARTIAL) | L |
| 3 | `dirty-tree-salvage` seam (WS-3) | MISSING | M |
| 4 | `promise-tokens` scrubbing + wiring | DONE | — |
| 5 | `isForeignTmuxSession` tmux ownership guard | MISSING (subsystem absent) | M |
| 6 | Release gate (audit scripts / tiers) | PARTIAL (minimal gate only) | M |
| 7 | R-WGFR flaky `test:fast` false-red | MISSING (subsystem absent) | M |
| 8 | R-WDTF Done-flip erases `completion_commit` | PARTIAL (avoided by ordering; no test) | S |
| 9 | B-TRGP + R-TCVC portable worker gate | MISSING (subsystem absent) | M |
| 10 | B-WSPU collapse dual worker-spawn | DONE (single sync lifecycle already) | — |
| 11 | B-1SEAM WS-1 route all sites through predicate | MISSING (= item 2) | L |
| 12 | B-1SEAM WS-2 symmetric `start_commit` self-heal | MISSING | M |
| 13 | B-1SEAM WS-3 bystander-stash on microverse rescue | MISSING | M |
| 14 | B-SSVR (R-SSBR) scope-resolver fail-CLOSED | MISSING | L |
| 15 | B-SSVR (R-ISVP) install.sh prerelease semver | MISSING (N/A — no version logic) | S |
| 16 | gate-overreach subtraction / delete forward-ref | N/A (nothing to subtract) | — |
| 17 | B-RASO + B-RRPC + B-CSHYG recovery single oracle | MISSING (subsystem absent) | L |
| 18 | R-WGFR (dup of 7) | MISSING | — |
| 19 | B-TRGP + R-TCVC (dup of 9) | MISSING | — |

**Net Phase 0 read:** 2 of 4 P0 modules DONE (`recoverable-json`, `promise-tokens`); `ticket-completion-evidence` MISSING (only the stamping seam landed via the `m1-*` bundle); `dirty-tree-salvage` MISSING; tmux ownership guard MISSING; release gate minimal-only. Of the Phase 0 reliability fixes, only R-WDTF is partially in place (by ordering).

**Net Phase 1 read:** the "top 10" are dominated by subsystems codex has not ported (worker gate, completion oracle, scope fence, microverse rescue, recovery controller, citadel). B-WSPU is already satisfied by codex's single synchronous lifecycle; items 15 and 16 are effectively N/A for the current codex surface. The single highest-leverage, in-scope piece of real Phase 1 work is **item 2/11 (the completion-evidence predicate + routing)** — the `m1-*` commits built the stamping half but not the predicate half.
