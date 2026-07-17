# Adversarial Review #1 — Completion-Evidence Oracle (Mechanism 1)

**Reviewer lens:** the completion-evidence oracle and its single-seam reroute.
**Scope:** read-only. Reference = `pickle-rick-claude`; target = `pickle-rick-codex`.
**Verdict:** No CRITICAL or HIGH correctness bug found. The port is high-fidelity: the
`readEvidence` decision ladder, the `evaluateCompletionEvidence` predicate ladder, the
3-way `probeCatFile`, word-boundary + `startTimeEpoch` filtering, the R-WDTF pointer
fold, the single-seam invariant, and the helper-API re-expression are all faithful.
Findings below are behavioral divergences and one codex-only glue-logic robustness
concern — none produce a false Done-flip or a fail-open where the reference fails closed.

---

## Findings (severity-ordered)

| ID | Severity | file:line | Description | Reference behavior violated | Concrete failure scenario | Suggested fix |
|----|----------|-----------|-------------|-----------------------------|---------------------------|---------------|
| O-1 | MEDIUM | `extension/src/bin/spawn-morty.ts:687-694` | `committedCandidateExists` forces `finalizeRefusal` ('incomplete') whenever HEAD advanced past baseline but the oracle could not attribute — this is codex-only glue with no reference analog. | N/A (new codex logic; reference gates Done via `done-flip`+worker-gate, not a HEAD-advanced heuristic). | A legitimate completion where (a) `resolveCompletionCommitSha` could NOT stamp the `Pickle-Ticket` trailer (multi-commit window `countCommitsSince !== 1`, dirty index, or HEAD moved — all early-`return head` paths at `spawn-morty.ts:242-250`), AND (b) the worker's commit subject does not word-boundary-match the ticket id/r_code, AND (c) the ticket declares no files → oracle returns `no_evidence` → ticket marked `incomplete` and aborted/retried despite real, verified work. Fails safe (never false-Done) but can wedge a genuinely-complete ticket. | Either (a) broaden the trailer reconciliation so multi-commit windows still get an attributable marker, or (b) treat a green-verified run whose sole new commit(s) sit in the ticket window as attributable-by-window when scan/field both miss, or (c) document this as an accepted conservative failure and ensure retry/skip surfaces a clear operator message. |
| O-2 | MEDIUM (latent) | `extension/src/services/ticket-completion-evidence.ts:518` | Self declared-files gated on `ctx.sessionDir && ctx.ticketId`; when a caller passes only `ticketPath`, `declaredFiles = []` and the R-CECB declared-file-touch scan pass (pass 2) is silently disabled. | Claude derives `declaredFiles = readDeclaredFiles(content)` unconditionally from ticket content (`ticket-completion-evidence.ts` reference readEvidence), so pass 2 works for any resolvable ticket. | A future/external `readEvidence`/`gateForPhantomDoneRevert` caller that supplies `ticketPath` alone (no `sessionDir`+`ticketId`) loses declared-file-touch attribution and can mis-classify a real, file-touch-only completion as `absent`. Inert today: the sole production caller (`buildCompletionCtx`) always supplies `sessionDir`+`ticketId`; all tests pass both. | Resolve declared files from the ticket frontmatter/content when `ticketId` is absent (parse `output_artifacts`/`proof_corpus`/`freeze_contract` from `content`), matching the reference's content-based derivation, or fall back to `sessionDir` + resolved `selfId`. |
| O-3 | LOW (intentional divergence) | `extension/src/services/ticket-completion-evidence.ts:466-471` | R-OMA foreign-attribution message is read from `attributionDir` (= `fallbackDir` when reachability was resolved via fallback), not always `ctx.workingDir`. | Claude's `isForeignAttributedExplicitSha` always reads `commitMessage(ctx.workingDir, sha)` — in the fallback-reachable case claude reads an empty message and thus **accepts** (fails open); codex reads the real message and can **reject** as `foreign_attribution` (fails closed). | When `workingDir` cannot run git but `fallbackDir` can, and the explicit SHA's message word-boundary-names a sibling ticket (and not self), codex hard-absents where claude would have accepted. Stricter and arguably more correct, but a documented behavioral divergence from the reference. | None required if the stricter behavior is intended (recommend keeping). If strict reference parity is required, read the foreign-attribution message from `ctx.workingDir` only. Note the divergence in the trap-door text. |
| O-4 | NIT | `extension/src/services/ticket-completion-evidence.ts:429-448` | `enumerateSiblingDeclaredFiles` self-exclusion is case-insensitive (`entry.name.toLowerCase() === selfLower`) vs claude's case-sensitive `entry.name === selfTicketId`. | Minor divergence from reference exact-case comparison. | If a session dir basename and the frontmatter id differ only by case, codex correctly excludes self (avoids treating the ticket's own declared files as an ambiguity source); claude would not. Codex is more robust — no defect. | No change. |
| O-5 | NIT | `extension/src/services/ticket-completion-evidence.ts:445-448, 511` | `readEvidence` re-reads the ticket file via `readFrontmatterField(tPath, …)` several times after already loading `content` once, and derives `declaredFiles` via `readDeclaredFiles(sessionDir, ticketId)` (a separate file/manifest walk) rather than from the in-hand `content`. | Claude reads fields from the already-loaded `content` string. | Extra syscalls per evaluation; no correctness impact (file is not mutated mid-call). | Optionally read fields from the loaded `content` for consistency/perf. |

---

## Area-by-area confirmations (no issue found)

**readEvidence decision-ladder fidelity — CLEAN.** Order matches the port spec exactly:
explicit → baseline hard-absent (`R-CXOR-2`, `:454-459`) → 3-way probe with fallback
(`probeExplicitSha`, `:264-271`) → foreign hard-absent (`R-OMA`, `:472-477`) →
explicit-reachable-wins (`:478`) → UNREACHABLE explicit sets `unreachableExplicit` and
**falls through** (`R-AICF`, `:481-484`, no hard return) → inferred field git-verified
(`:496-503`, short-circuit absent when unverifiable per `R-AFCC-STAGE`) → git-log scan
(`:505-524`). Word-boundary matching is genuine regex `\b…\b` (`wordBoundaryRe`, `:344-346`;
`scanGitLogByRefToken`, `:406-414`), NOT substring. `startTimeEpoch` filter uses `e.epoch <
startEpoch` with `Number.isFinite && > 0` guards in both passes (`:373`, `:401`) — matches
claude, no off-by-one, not omitted.

**evaluateCompletionEvidence ladder — CLEAN.** R-CCGR single backoff re-read (`:716-720`),
R-CCEM announcement recovery persisting `completion_commit_inferred` + re-probe with
`via='announcement'` (`:652-671`, `:723-728`), R-WUWC promote-once writing explicit
`completion_commit` + re-probe (`:677-687`, `:734-735`), R-CWGE worker-gate **done-flip-ONLY**
(`workerGateRefusal` returns `null` unless `decision==='done-flip'`, `:694`). Phantom-watch and
attribution never consult the verdict — pinned by tests VAL-ORACLE-021/022.

**Codex never selects `done-flip` — CONFIRMED.** `buildCompletionCtx` sets
`decision:'attribution'` (`spawn-morty.ts:355`); `gateForPhantomDoneRevert` sets
`'phantom-watch'` (`ticket-completion-evidence.ts:754`). No `'done-flip'` producer exists in
codex, so `worker_gate_unavailable` can never fire in production. Test VAL-ORACLE-023 pins
that a `done-flip` WITHOUT an injected gate correctly refuses `worker_gate_unavailable`.

**Helper-API divergence (content-based → path/id-based) — CORRECTLY RE-EXPRESSED (Strategy B).**
Every ported call was re-expressed: `readFrontmatterField(tPath, …)` path-based (`:450`, `:462-464`,
`:509-512`); `readDeclaredFiles(sessionDir, ticketId)` id-based (`:518`, `:439`);
`upsertFrontmatterField(tPath, …)` treated as **void/writes** (`:665`, `persistEvidence`
fallback `:628`); `normalizeCompletionCommitField` used identically. No place passes `content`
where a path is expected, and no void return is consumed as if it were new content.

**probeCatFile 3-way — RETAINED for the explicit-SHA branch.** The explicit branch uses
`probeExplicitSha` (3-way `exists`/`not-exists`/`git-could-not-run` + `fallbackDir` retry,
`:246-271`); only the inferred branch uses the boolean `commitReachable` (matching claude's
`commitExists`). Codex did NOT collapse the explicit branch to a boolean — `R-CCR-1` fallback
is preserved (test VAL fallback cases at predicate.test.js:175-197).

**Single-seam invariant — HOLDS.** `readEvidence(<arg>)` callsites outside the oracle module = 0
(grep: only inside `ticket-completion-evidence.ts` + tests). `evaluateCompletionEvidence(`
appears exactly once in a decision file: `spawn-morty.ts:676`. Oracle importer set = exactly
`{ spawn-morty.ts }` (`mux-runner.ts` delegates via `runTicket`, does not import the oracle).
Pinned by `completion-predicate-single-seam.test.js` PIN 1-4.

**R-WDTF pointer survival — GUARANTEED AND PINNED.** `persistEvidence` writes the pointer
through `updateTicketStatus(sessionDir, ticketId, { completion_commit })` when
`sessionDir`+`ticketId` are present (`spawn-morty` path), landing it in the manifest AND the
file (`ticket-completion-evidence.ts:614-628`). Durability holds even under
`ensureTicketFilesMaterialized` re-materialization: `collectTicketFrontmatter`
(`tickets.ts:809-844`) serializes arbitrary non-excluded manifest keys, so a rewrite from the
manifest re-emits `completion_commit`. The fold is in the predicate (promote-once), not an
order-dependent separate `stampCompletionCommit()`; `resolveCompletionCommitSha`'s return
value is intentionally discarded (called only for its trailer-amend side effect,
`spawn-morty.ts:668-673`). Regression test VAL-ORACLE-028 (`ticket-completion-evidence-predicate.test.js:393-419`)
pins survival across Done → Todo → Done rewrites.

**mux-runner honor-oracle-refusal — CORRECT.** In-memory `ticket.status = 'Done'` set ONLY on
`result.status === 'done'` (`mux-runner.ts:141-146`); a non-throwing refusal (`status:'incomplete'`)
is routed through the same failure-mode handling as a real failure (`:150-176`). Pinned by
`mux-runner-oracle-refusal.test.js`.

**No TODO / stub / half-ported branch / swallowed-error fail-open** found in the oracle or the
reroute. All `catch {}` blocks are the intended best-effort git/FS degradations that map to
`absent`/`no_file`/`staged:false`, matching the reference's fail-closed-to-absent posture.
