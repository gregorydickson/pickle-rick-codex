# Remaining-Gap Transplant PRD — pickle-rick-claude → pickle-rick-codex

| Remaining-Gap Transplant PRD | | Current parity gap after the July 2026 landings |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: 2026-07-18 | **Visibility**: Internal |

## Introduction

Donor: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude` (actively developed).
Target: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-codex` @ `v0.2.17-beta.1`.

This PRD supersedes the gap sections of `prds/p1-catch-up-to-claude-v2.0.md` and corrects
`prds/_audit-phase01-gap.md`. It enumerates **only work that has not landed**, verified against
current source by three independent evidence passes (catch-up-item audit, 46-service diff,
57-bin + skill diff). Every row carries donor `file:line` evidence.

### Corrections to `_audit-phase01-gap.md` (do NOT re-port these)

Five items recorded as MISSING have since **LANDED with tests**. Building from that stale audit
would re-port five working subsystems:

| Stale item | Actual status | Evidence |
|:---|:---|:---|
| 2/11 — completion-evidence oracle | LANDED | `services/ticket-completion-evidence.ts:715`; single-seam PINs in `tests/completion-predicate-single-seam.test.js:84,109` |
| 3 — dirty-tree-salvage | LANDED | `services/dirty-tree-salvage.ts:34,96,113`; 6 tests |
| 5 — tmux ownership guard | LANDED | `services/tmux.ts:35,39`; 8 tests |
| 9 — portable worker gate | LANDED | `services/execution-gate.ts:76,102,198` |
| 14 — scope fail-CLOSED | LANDED | `services/execution-gate.ts:302-309`; `tests/execution-gate.test.js:98` |

Items 7 (R-WGFR), 12 (WS-2 self-heal), 17 (recovery oracle) remain accurate and are ticketed below.

**Renamed landings.** Several catch-up items landed under different module names than predicted. A
filename grep scores these MISSING; they are not. `convergence-gate` + `scope-resolver` behavior →
`services/execution-gate.ts`. `microverse-state` runtime → `services/metric-convergence.ts`.
Ticket work must extend these modules, not create the donor-named ones.

## Objective & Scope

**Objective**: Close the verified remaining parity gap, prioritizing gaps that cause silent
incorrectness or unrecoverable runs on the Codex runtime.

**Non-goal**: Donor-size parity. The target is deliberately a single-backend port; several donor
subsystems are Claude-Code-specific and are explicitly excluded below.

---

## P0 — Inverted Codex Gaps

Donor modules **written for the Codex runtime** that the Codex port lacks. Highest value in the
entire audit: the donor hardened against Codex failure modes the target still has.

| # | Item | Donor source | Target action | Why P0 |
|:---|:---|:---|:---|:---|
| P0-1 | `orphan-reaper.ts` — `reapOrphanedWorkerProcs` | `services/orphan-reaper.ts:308`, `:141`, `:52`, `:37` | New `services/orphan-reaper.ts`; wire into `detached-launch.ts` and runner exit paths | Header (`:2`) names **R-CXHANG**, a *codex-motivated* incident: "codex hangs on network I/O and never [exits]" (`:11`). Reaper covers both backends (`:8,:18`) but `:106` branches on `base === 'codex'` for `codex exec --dangerously-bypass-approvals-and-sandbox`. Target reaps nothing — orphaned worker process groups survive runs |
| P0-2 | `bundle-state-integrity.ts` + `manager-relaunch.ts` | `bundle-state-integrity.ts:79`; `manager-relaunch.ts:50,74,149,42` | New services; audit manager relaunch caps at bundle boundaries | Function is `auditCodexManagerRelaunchCaps`; donor caps **Codex** managers differently from Claude. Target has no relaunch cap → unbounded manager respawn |
| P0-3 | `classifier-utils.ts` — codex stream parsing | `classifier-utils.ts:4,157,173,181` | New service; consume in `services/codex.ts` | Exports `CODEX_DELIMITER_RE`, `observeCodexToolCallStream`, `detectOutputFormat`. Target runs `codex exec` but never parses the codex-block stream format or discriminates `stream-json` / `codex-block` / `plain-text` |

## P1 — Correctness & Recoverability

| # | Item | Donor source | What's absent in target |
|:---|:---|:---|:---|
| P1-1 | Recovery ladder | `recovery-controller.ts:166,227,240,264,323` | `runRecoveryLadder`, `classifyRecoveryTaxonomy`, `isConvergedPlanEligible`, `executePhaseLoop`. **Target failures are terminal — no escalation path exists.** |
| P1-2 | Circuit-breaker execution gating + R-DEFCHURN | `circuit-breaker.ts:209,213,256-268,400,330` | `canExecute` (nothing gates execution on OPEN); `detectProgress` incl. the empty-commit `HEAD^{tree}` vs `lastKnownHead^{tree}` comparison so no-op deferral commits don't falsely reset the breaker; `resetCircuitBreaker`; `isConstraintDiscoverySignature` exemption |
| P1-3 | Convergence-gate baseline contract | `convergence-gate.ts:301,40,47,54,246` | `assertBaselineFresh`, `BaselineMissing/Stale/WriteFailed` errors, `subtractBaseline`. Target captures a baseline but never asserts freshness |
| P1-4 | No-disown failure classification | `convergence-gate.ts:231,212,197,188` | `classifyNoDisown`, `isSelfIntroducedFailure`, `extractTscFailureIdentifiers` — target cannot distinguish self-introduced from pre-existing failures |
| P1-5 | `scope-resolver.ts` full subsystem | `scope-resolver.ts:109,154,311,459,527,604` | `parseScope`, `resolveScope`, `refreshScope`, `buildScopeV1Schema`, `computeOneHop`, `computeReviewBase`. Target's `execution-gate.ts:277,302` is a narrow per-ticket path check — no one-hop graph expansion, no scope.json v1, no review-base |
| P1-6 | State terminal finalization | `state-manager.ts:1336,1372,1430,1458,1534,1552` | `safeDeactivate`, `finalizeTerminalState`, `graduationDecision`, `finalizeIfTrulyComplete`, `recordExitReason`, `clearExitReason` |
| P1-7 | Schema-version deploy parity | `state-manager.ts:62,45,83` | `assertSchemaVersionDeployParity`, `SchemaVersionDeployDriftError`, `SchemaVersionAheadError` — no guard against runtime/source schema skew |
| P1-8 | `transaction-ticket-ops.ts` reverse ledger | `transaction-ticket-ops.ts:235,313,558,753,201` | `materializeNewTicket`, `replayReverseLedger`, `recoverCourseCorrectionFromLedger`, `applyCourseCorrectionRestructure`. Target `tickets.ts:1003` is a non-transactional single-file write |
| P1-9 | `ac-phase-gate.ts` | `ac-phase-gate.ts:196,9,12` | `runAcPhaseGate`, `AC_PHASE_MANIFEST`, four-phase taxonomy. Target evaluates acceptance criteria as a phased gate nowhere |
| P1-10 | `check-readiness` engine | `bin/check-readiness.ts` (55.8K) | Entire pre-flight readiness engine: findings, source-requirement checks, `computeOneHop`, readiness cycle history, manifest validation, false-positive telemetry. No CLI at all in target |
| P1-11 | `signature-caller-gap.ts` | `signature-caller-gap.ts:285,46,15` | `detectSignatureCallerGaps`, `SCOPE_AUTO_EXTEND_MAX` — no detection of callers left stale by a signature/schema change |
| P1-12 | `verify-command-safety.ts` | `verify-command-safety.ts:35,52,4` | `detectMissingTools`, `containsUnquotedGlobHazard`. Target never checks referenced tools exist on PATH |
| P1-13 | `artifact-progress-detector.ts` | `artifact-progress-detector.ts:82,28,43,19` | `detectArtifactProgress`, mtime liveness. **A slow-but-progressing worker is indistinguishable from a hung one** |
| P1-14 | `worker-shutdown.ts` | `worker-shutdown.ts:9` | `flushAndExit` — no flush-then-exit guarantee; final worker messages can truncate |
| P1-15 | Destructive-op archive net | `git-utils.ts:388,302,281,208` | `archiveBeforeDestructive`, `ArchiveAbortError`, `resetToSha` with `preservePrefixes`/`archive`. Target `resetHeadPreservingWorktree:232` has no archiving |
| P1-16 | Activity-log durability | `activity-logger.ts:30,31,32` | Retry/pending-buffer for failed appends. **Target drops events on write failure** |
| P1-17 | Sandbox add-dir guard | `backend-spawn.ts:51,21,795` | `assertAddDirsUnderTmpdirIfTestMode`, `AddDirOutsideSandboxError`, `shouldIsolateSessionGroup` — backend-neutral guards omitted along with the backend abstraction |
| P1-18 | R-WGFR flake handling | catch-up E1/E9 | Worker gate is single-shot; no de-flake/retry. Confirmed absent (`flaky`/`retry`/`rerun` → zero hits in `execution-gate.ts`) |
| P1-19 | WS-2 citadel self-heal | `services/citadel.ts:166-168` | Citadel **throws** rather than self-healing when `start_commit` is absent. No symmetric self-heal path |
| P1-20 | R-WDTF regression pin | `ticket-completion-evidence.ts:536,750` | Behavior is owned by the oracle, but no test pins "flipping status must not drop `completion_commit`" across a Done→re-flip cycle |

## P2 — Skill Doctrine Restoration

**The most under-recognized gap.** The binaries were ported; the prompt doctrine that drives them
was not. These skills exist and would score FULL on a file-existence audit while being functionally
hollow — the target skill is a launcher, the donor command is the actual protocol.

| # | Skill | Donor | Target | Missing doctrine |
|:---|:---|:---|:---|:---|
| P2-1 | `pickle-refine-prd` | 47.3K | 1.1K | Atomic-ticket rubric, parallel analysis protocol, ticket schema/validation guidance |
| P2-2 | `anatomy-park` | 33.3K | 2.8K | Per-phase trace → fix → catalog protocol |
| P2-3 | `szechuan-sauce` | 31.6K | 1.0K | Principle catalog, convergence criteria |
| P2-4 | `pickle-pipeline` | 18.5K | 1.0K | Gate phases, remediation, phase-contract semantics |
| P2-5 | `pickle-microverse` | 11.0K | 1.7K | Violation ledger, stall recovery, gate baselines, exit-reason taxonomy |
| P2-6 | `pickle-tmux` | 7.2K | 1.9K | True-context-clearing iteration doctrine, pane layout |
| P2-7 | `pickle-prd` | 4.5K | 1.2K | Machine-checkable AC templates |
| P2-8 | `fom-blocks` injection | `fom-blocks.ts:7,11` | — | `FOM_EVIDENCE_RULES` / `FOM_HONEST_REPORTING_RULES` not injected by `prompts.ts` |

**Acceptance rule for P2**: a restored skill is Done only when its protocol sections are present and
a run exercises them — not when the file grows.

## P3 — Missing Runtime State & Command Surface

| # | Item | Donor source | Missing |
|:---|:---|:---|:---|
| P3-1 | Microverse violation ledger | `microverse-state.ts:289,300,315,357,445,390` | `recordStall`, `recordAmnesiacExit`, `recordFailedApproach`, `classifyFailure`, `updateViolationLedger`, `isConverged`. **No failed-approach memory — the loop can retry an approach it already disproved** |
| P3-2 | `pickle-recover` | `bin/pickle-recover.ts` (15.1K) | `recovery_exhausted` operator command, `--resume-from-todo`, `detectAndRecoverHeadRegression` |
| P3-3 | `finalize-gate` + `check-gate` | `bin/finalize-gate.ts`, `bin/check-gate.ts` | Scope-partitioned gate, AC gate, remediator auto-spawn; `--mode baseline\|strict`, `--scope`, `--since`, `--baseline-path`, `--json` |
| P3-4 | `spawn-gate-remediator` | `bin/spawn-gate-remediator.ts` | Auto-spawn on gate failure (spawn path is backend-abstracted → portable) |
| P3-5 | Scope CLI trio | `bin/lock-scope.ts`, `resolve-scope.ts`, `check-scope-diff.ts` | Scope lock/resolve CLIs, allowed-paths-file contract, one-hop auto-extension |
| P3-6 | `circuit-reset` | `bin/circuit-reset.ts` | No CLI to reset a tripped breaker — operator must hand-edit state |
| P3-7 | `check-flake-budget` | `bin/check-flake-budget.ts` | Flake budget concept absent entirely |
| P3-8 | Metrics depth | `metrics-utils.ts:223,435,505,738,849,895` | Token accounting, git LOC attribution, skip-flag budget report, readiness false-positive report, refused/recovered counts |
| P3-9 | `audit-ticket-bundle` | `bin/audit-ticket-bundle.ts` (25.9K) | Manifest schema v1 validation, hash/SHA/version drift detection, severity + defect classes |
| P3-10 | `bundle-finalize.ts` | `bundle-finalize.ts:101,55,70,151` | `computeBundleTestFloor` — no test-count-floor regression guard at bundle end |
| P3-11 | Jar enqueue | `jar-utils.ts:19` | `addToJar`; target runs a jar but cannot enqueue. No SKILL.md for `add-to-pickle-jar` / `pickle-jar-open` |
| P3-12 | `citadel` skill surface | `.claude/commands/citadel.md` | Runs as pipeline phase but is not user-invocable as a skill |
| P3-13 | Monitor depth | `bin/monitor.ts` (42.3K) | `writeWithWatchdog`, `restartDeadWatcherPanes` (30s respawn), `inferMonitorMode`, per-ticket symbol table, circuit-breaker pane |
| P3-14 | Release-gate audit scripts | donor ~22 scripts | Target ships **1** (`audit-test-tiers.sh`). Missing trap-door enforcement, phantom-done call-site audit, coverage-delta, flake budget |
| P3-15 | `test:expensive` tier | — | Only fast + integration enforced |
| P3-16 | `cancel` / `retry-ticket` depth | `bin/cancel.ts`, `bin/retry-ticket.ts` | Terminal-state finalization, exit-reason recording, orphan cleanup, rollback guards |
| P3-17 | `artifact-validation.ts` + tier taxonomy | `artifact-validation.ts:5,33,39`; `pickle-utils.ts:503,505` | `findMissingPrefixes`, `TICKET_TIER_BUDGETS`, `VALID_TICKET_COMPLEXITY_TIERS` |
| P3-18 | `sync-schema` / `prune-activity` / `log-activity` CLIs | donor bins | No schema sync guard, no activity pruning, no external activity-log CLI |

## P4 — Optional Subsystems (defer unless prioritized)

| # | Item | Donor | Note |
|:---|:---|:---|:---|
| P4-1 | Codegraph | `codegraph-service.ts:129`, `codegraph-query-runner.ts:84`, `bin/codegraph-efficacy-probe.ts` | Zero Claude references — fully portable, large |
| P4-2 | Linear integration | `linear-integration.ts:168,201` | `syncLinearTicketStatus`, `emitBundleLinearComments` |
| P4-3 | `standup` | `bin/standup.ts` (18.8K) | Depends on P4-2 |
| P4-4 | Calibration | `calibration-corpus.ts:81,110`, `bin/calibrate.ts` | Judgment-drift regression detection; machinery is model-agnostic |
| P4-5 | `death-crystal` | `death-crystal-html.ts:154,183` | Runtime-agnostic, portable |
| P4-6 | `project-type-classifier.ts` | `:82,76,4` | Partly covered heuristically by `discoverQualityCommands` |
| P4-7 | `archaeology` | `bin/archaeology.ts` | Depends on P4-6; spawn path is abstracted → portable |
| P4-8 | `check-update` | `bin/check-update.ts` (24.5K) | Version/self-update flow |
| P4-9 | `pr-factory.ts` | `:9` | `createPR` |
| P4-10 | `project-mayhem` | `.claude/commands/project-mayhem.md` | Chaos engineering; portable |
| P4-11 | TUI render layer | `pickle-utils.ts:109,123,133,164` | `Style`, `wrapText`, `printMinimalPanel` |

## Excluded — Claude-Specific (do NOT ticket)

| Item | Reason |
|:---|:---|
| `council-publish.ts`, `council-fanout.ts`, `council-schema.ts:284`, `council-of-ricks` | Graphite stack review via Claude subagent fanout; `validateSubagentPayload` targets Claude payload shape |
| `debate.ts` teams mode, `generate-debate-personas.ts`, `validate-teams-ticket.ts` | Teams mode = Claude Task-tool fanout |
| `judge-spawn-env.ts:32,45,92` | Exists solely to sanitize nested-Claude spawns (`isNestedClaude`) |
| `agent-md-loader.ts:52`, 19 Morty agent defs, `.codex/agents/` | Loads Claude Code `.claude/agents/*.md`; Codex has no equivalent agent-definition format |
| `.dot` / attractor family: `dot-builder.ts`, `convergence-defaults.ts`, `pickle-dot`, `pickle-dot-patterns`, `plumbus`, `attract`, `portal-gun` | Attractor executes `--backend claude-code` |
| `codex-rescue` | Meaningless in a Codex-native runtime |
| `backend-spawn.ts` backend multiplexing (`resolveBackend`, `build*Invocation`, MCP config) | Single-backend port is a declared design decision. **Exception**: P1-17 guards are backend-neutral and ARE ticketed |
| `--backend` / `--teams` flags | Same rationale |
| `send-to-morty`, `send-to-morty-review` | Folded into `services/prompts.ts` — acceptable non-port |
| `forward-ref-annotation.ts` | Intentional subtraction; catch-up item 16 is a delete, nothing to do |
| `pickle-zellij` | Zellij mode not a Codex-port goal |

---

## Acceptance Criteria

**P0**
- [ ] P0-1: `reapOrphanedWorkerProcs` reaps orphaned `codex exec` process groups; test asserts a killed group after abnormal runner exit
- [ ] P0-2: manager relaunch cap enforced for the codex backend; `auditCodexManagerRelaunchCaps` fails a bundle exceeding cap
- [ ] P0-3: `detectOutputFormat` discriminates `stream-json` / `codex-block` / `plain-text`; `observeCodexToolCallStream` parses a real codex-block fixture

**P1**
- [ ] P1-1: a failing ticket escalates through the recovery ladder rather than terminating
- [ ] P1-2: breaker refuses execution when OPEN; empty-commit tree-equality does NOT reset progress (R-DEFCHURN pin)
- [ ] P1-3: stale/missing baseline raises the typed error instead of silently passing
- [ ] P1-4: a pre-existing failure is classified not-self-introduced and does not fail the worker
- [ ] P1-5: `scope.json` v1 emitted; one-hop expansion covers a caller outside the declared set
- [ ] P1-6: abnormal termination records an exit reason and finalizes terminal state
- [ ] P1-7: runtime/source schema skew raises `SchemaVersionDeployDriftError`
- [ ] P1-8: an interrupted restructure replays the reverse ledger to a consistent tree
- [ ] P1-9: AC gate evaluates at all four declared phases
- [ ] P1-10: `check-readiness` CLI emits findings + cycle history for a bundle
- [ ] P1-11: a changed exported signature surfaces its stale callers and auto-extends scope within `SCOPE_AUTO_EXTEND_MAX`
- [ ] P1-12: a verification command naming an absent tool is rejected pre-flight
- [ ] P1-13: a slow-but-progressing worker is not killed as hung (artifact-mtime pin)
- [ ] P1-14: final worker message is never truncated at exit
- [ ] P1-15: a destructive reset archives first; abort on cap breach
- [ ] P1-16: an activity append failure is retried, not dropped
- [ ] P1-17: an add-dir outside the sandbox raises `AddDirOutsideSandboxError`
- [ ] P1-18: a known-flaky test does not produce a false red on the worker gate
- [ ] P1-19: absent `start_commit` self-heals instead of throwing
- [ ] P1-20: Done→re-flip cycle preserves `completion_commit`

**P2**
- [ ] P2-1..P2-7: each restored skill's protocol sections present AND exercised by a real run
- [ ] P2-8: FOM evidence + honest-reporting blocks injected by `prompts.ts`

**P3** — one checkbox per P3-1..P3-18 row; each requires a passing regression test.
**P4** — deferred; promote individually.

## Behavioral Validation Tests

| Test | Item | Donor behavior | Expected target behavior |
|:---|:---|:---|:---|
| `orphan-reaper.test.js` | P0-1 | Reaps codex process groups on abnormal exit | Same, `base === 'codex'` path |
| `manager-relaunch.test.js` | P0-2 | Caps codex manager relaunches | Same cap enforced |
| `codex-stream-classify.test.js` | P0-3 | Parses codex-block delimiters | Same on real fixture |
| `recovery-ladder.test.js` | P1-1 | Escalates through taxonomy | Same ladder ordering |
| `circuit-defchurn.test.js` | P1-2 | Empty-commit tree equality ≠ progress | Breaker does not reset |
| `baseline-freshness.test.js` | P1-3 | Typed error on stale baseline | Same |
| `no-disown-classify.test.js` | P1-4 | Pre-existing failure disowned | Same |
| `scope-onehop.test.js` | P1-5 | One-hop covers stale caller | Same |
| `artifact-progress.test.js` | P1-13 | Progressing worker survives window | Same |

## Risks & Mitigations

| Risk | Severity | Mitigation |
|:---|:---|:---|
| **Donor is a moving target** — recent donor commits (codegraph term harvesting, microverse dirty-tree auto-commit, source-authoritative settings) postdate this audit | High | Re-run the three evidence passes before starting P2+; treat this PRD as a dated snapshot |
| **55 uncommitted files in target**, incl. all P0-adjacent new services (`citadel.ts`, `execution-gate.ts`, `metric-convergence.ts`) | High | **Commit before any execution run.** A bad iteration eats untracked work |
| Renamed landings re-ported under donor names | High | Ticket text must name the *target* module to extend (`execution-gate.ts`, `metric-convergence.ts`), never the donor filename |
| P2 skills scored Done on file growth rather than restored protocol | Medium | Acceptance requires an exercising run, not a size delta |
| Porting `backend-spawn` guards drags in backend multiplexing | Medium | P1-17 is scoped to the three named backend-neutral guards only |
| Scope-resolver port conflicts with the landed narrow `evaluateTicketScope` | Medium | Extend the existing seam; do not fork a parallel scope path |

## Portal Artifacts

- Donor analyzed in place (local sibling repo; no copy made — donor is a live working tree)
- Evidence passes: catch-up-item audit, 46-service diff, 57-bin + skill diff
- Supersedes: gap sections of `prds/p1-catch-up-to-claude-v2.0.md`
- Corrects: `prds/_audit-phase01-gap.md` items 2, 3, 5, 9, 11, 14

## Coverage Tracking

Total ticketable items: 3 (P0) + 20 (P1) + 8 (P2) + 18 (P3) = **49** | Ported: 0 | Coverage: 0%
P4 (11 items) and Excluded (12 groups) are out of the coverage denominator.
