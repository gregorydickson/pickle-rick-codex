# P1 Active Field-Incident Traceability and Current-Main Gap Audit

This document freezes the implementation contract for the P1 drain before runtime mutation. It is an audit and traceability ledger, not a replacement for the normative text in these sources:

- `prds/p1-autonomous-recovery-field-incidents.md` (`AR`)
- `prds/p1-quality-delta-and-grounded-conformance-field-incident.md` (`QD`)
- `prds/p1-field-run-bootstrap-contract-gaps.md` (`BS`)

The exact Requirements and Acceptance Criteria text in those three source PRDs is immutable during implementation. This audit records current-source observations; revisions in older reports are observations, not pins. Only after composed `P13` proof passes may ticket `p1r-014` change source-PRD status and completion-evidence sections, while preserving that normative text verbatim.

## Execution-base repository condition

- Actual execution-start `HEAD`: `536aecbbff83733fddc212b7e4a6576db3ae455a`.
- At execution start, `HEAD`, local `main`, `origin/main`, `origin/HEAD`, and configured upstream `@{upstream}` all resolved to that revision. Branch `main` tracked `origin/main`, and `git rev-list --left-right --count origin/main...HEAD` returned `0 0` (zero behind, zero ahead).
- Before mutation, the index and worktree were clean: `git status --porcelain=v1`, `git diff --name-only`, and `git diff --cached --name-only` were empty, and both worktree and index diff checks returned zero. `git status --short --branch` produced only `## main...origin/main`.
- This SHA is execution evidence, not a fixed or prescribed historical base. The previously recorded `82bbe93f432a95bad9735bf6a5b2d88421a6c17a` ledger revision and `9bb9a8d08dfd2bf7f0e495c63c3583c77cf2a70e` report revision were valid observations of older executions, not pins that this execution was required to use.
- Coverage below comes from inspection of current source and regression tests, not from commit subjects. Current main retains validated and persisted `changes_requested` artifacts, typed refusal propagation, and forwarding of the newest refusal evidence into later worker prompts. That supplies partial refusal-remediation coverage, but retry still lacks the complete checkpointed implementation-side recovery contract.

Coverage states below describe the actual execution base: **preserve** means an already-correct seam must survive downstream work although adjacent obligations remain; **partial** means correct behavior exists but the frozen contract is incomplete; **uncovered** means the required contract/proof is not yet present. Notes such as contradictory or final-parity obligation explain a gap without creating another classification.

## Deterministic proof catalog

Every matrix proof key expands to these exact commands. Typecheck and lint in `P02` through `P12` mean the two literal commands shown, not package-wide wrappers.

| Key | Exact deterministic proof commands |
| --- | --- |
| `P02` | `node --test extension/tests/recovery-controller.test.js extension/tests/state-manager.test.js extension/tests/state-terminal.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P03` | `node --test extension/tests/path-grammar-parity.test.js`<br>`node --test extension/tests/prompts-prd-contract.test.js extension/tests/refinement-manifest.test.js extension/tests/scope-contract.test.js extension/tests/ticket-declared-files.test.js extension/tests/verification-command-safety.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P04` | `node --test extension/tests/command-flows.test.js extension/tests/refinement-manifest.test.js extension/tests/recovery-controller.test.js extension/tests/session-flow.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P05` | `node --test extension/tests/readiness.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js extension/tests/recovery-controller.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P06` | `node --test extension/tests/execution-gate.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P07` | `node --test extension/tests/execution-gate.test.js` (including noisy Markdown-only and new-diagnostic fixtures)<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P08` | `node --test extension/tests/execution-gate.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P09` | `node --test extension/tests/refinement-manifest.test.js extension/tests/frontmatter-helpers.test.js extension/tests/verification-preflight.test.js extension/tests/command-flows.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P10` | `node --test extension/tests/worker-lifecycle-contract.test.js extension/tests/ac-phase-gate.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js extension/tests/mux-runner-oracle-refusal.test.js`<br>`rg -n "verification_receipt|verificationReceipt" extension/src/services extension/src/bin`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P11` | `node --test extension/tests/worker-lifecycle.test.js extension/tests/worker-lifecycle-contract.test.js extension/tests/ac-phase-gate.test.js extension/tests/session-flow.test.js extension/tests/recovery-controller.test.js extension/tests/mux-runner-oracle-refusal.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P12` | `node --test extension/tests/tmux-contract.test.js extension/tests/pickle-pipeline.test.js extension/tests/session-flow.test.js extension/tests/mux-runner-oracle-refusal.test.js extension/tests/runner-descriptors.test.js extension/tests/is-foreign-tmux-session.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint` |
| `P13` | `node --test extension/tests/field-incidents-e2e.test.js`<br>`npm --prefix extension run typecheck`<br>`npm --prefix extension run lint`<br>`npm test`<br>`npm run release:gate`<br>`runtime_root="$(mktemp -d)"; PICKLE_DATA_ROOT="$runtime_root" bash install.sh && PICKLE_DATA_ROOT="$runtime_root" npm run test:installed` |
| `P14` | all `P13` source/full/release proof, then `test "$(node -p "require('./package.json').version")" = "$(node -p "require('./extension/package.json').version")"` and `rg -n "Complete|COMPLETE" prds/p1-autonomous-recovery-field-incidents.md prds/p1-quality-delta-and-grounded-conformance-field-incident.md prds/p1-field-run-bootstrap-contract-gaps.md prds/MASTER_PLAN.md`, plus an adversarial final-diff review proving normative source text unchanged |

## Frozen criterion inventory

### Autonomous recovery (`AR`)

| Stable ID | Owning ticket(s) | Current coverage | Exact proof |
| --- | --- | --- | --- |
| `AR-R1` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `AR-R2` | `p1r-002`, `p1r-005` | uncovered | `P02` + `P05` + composed `P13` |
| `AR-R3` | `p1r-011` | partial | `P11` + composed `P13` |
| `AR-R4` | `p1r-002`, `p1r-004`, `p1r-005`, `p1r-011` | partial | `P02` + `P04` + `P05` + `P11` + composed `P13` |
| `AR-AC1` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `AR-AC2` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `AR-AC3` | `p1r-002`, `p1r-005` | uncovered | `P02` + `P05` + composed `P13` |
| `AR-AC4` | `p1r-011` | partial | `P11` + composed `P13` |

### Quality delta and grounded conformance (`QD`)

| Stable ID | Owning ticket(s) | Current coverage | Exact proof |
| --- | --- | --- | --- |
| `QD-R1` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-R2` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-R3` | `p1r-008` | uncovered | `P08` + composed `P13` |
| `QD-R4` | `p1r-009` | uncovered | `P09` + composed `P13` |
| `QD-R5` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-R6` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-R7` | `p1r-010`, `p1r-011` | preserve | `P10` + `P11` + composed `P13` |
| `QD-AC1` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-AC2` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-AC3` | `p1r-008` | uncovered | `P08` + composed `P13` |
| `QD-AC4` | `p1r-009` | uncovered | `P09` + composed `P13` |
| `QD-AC5` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-AC6` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-AC7` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-AC8` | `p1r-010` | uncovered | `P10` + composed `P13` |
| `QD-AC9` | `p1r-013` | uncovered (final-parity obligation) | targeted `P13` + composed `P13` |

### Bootstrap and detached startup (`BS`)

| Stable ID | Owning ticket(s) | Current coverage | Exact proof |
| --- | --- | --- | --- |
| `BS-R1` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `BS-R2` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `BS-R3` | `p1r-006` | uncovered (current source is contradictory) | `P06` + composed `P13` |
| `BS-R4` | `p1r-006` | uncovered (current source is contradictory) | `P06` + composed `P13` |
| `BS-R5` | `p1r-012` | uncovered | `P12` + composed `P13` |
| `BS-AC1` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `BS-AC2` | `p1r-003`, `p1r-004` | partial | `P03` + `P04` + composed `P13` |
| `BS-AC3` | `p1r-006` | uncovered (current source is contradictory) | `P06` + composed `P13` |
| `BS-AC4` | `p1r-012` | uncovered | `P12` + composed `P13` |
| `BS-AC5` | `p1r-013` | uncovered (final-parity obligation) | targeted `P13` + composed `P13` |
| `BS-AC6` | `p1r-013` | uncovered (final-parity obligation) | targeted `P13` + composed `P13` |
| `BS-AC7` | `p1r-013` | uncovered (final-parity obligation) | targeted `P13` + composed `P13` |

Every row names composed end-to-end parity proof under `P13`, owned by `p1r-013`. After that proof passes, `p1r-014` owns `P14` status/evidence closure. The refinement dependency graph makes every `p1r-002` through `p1r-014` ticket depend directly or transitively on this `p1r-001` decision record.

## Resolved cross-ticket contracts

### Absolute four-candidate manifest recovery budget

Each synthesis/fallback lane gets exactly one initial candidate plus at most one diagnostic repair. The primary synthesis lane runs first. Only if it remains invalid may an independent fallback lane run in a fresh process and fresh context using the approved original inputs and validator diagnostics; it also gets one initial candidate plus at most one repair. Four generated candidates is the absolute combined maximum. Every candidate passes through the same production validator. Rejected output and diagnostics remain evidence and may not be silently rewritten. Exhaustion persists typed, resumable `refinement_exhausted`; retry requires changed remediation input or operator retry authority. `p1r-004` implements this on the `p1r-002` recovery model after `p1r-003` path-contract hardening.

### Authenticated detached tmux handoff

Launch success requires authentication of the launch ID/nonce and launch epoch, operation lease, tmux session, and PID start identity. The runner—not the launcher—writes `baseline_started`, and only after first-ticket selection, the clean-tree gate, dependency bootstrap, and verification-readiness gates pass. The launcher returns at that authenticated start boundary before quality commands finish and never claims baseline completion; later baseline failure is asynchronous session failure with preserved evidence. `p1r-012` owns this contract after `p1r-005`, `p1r-006`, `p1r-008`, and `p1r-011`.

### Remaining frozen decisions

- Fresh empty quality discovery is valid and persists, but evaluates to typed non-green `absent`; it blocks completion. `p1r-006` owns the behavior.
- A verification receipt binds the runner-captured baseline `HEAD` and the exact verified tree/index/worktree identity. Any later mutation makes it stale and forces deterministic verification and conformance to rerun; final completion requires the committed tree to equal the verified identity. `p1r-010` owns the receipt boundary and `p1r-011` owns refusal remediation.
- Older accepted manifests are never silently enriched with new verification obligations. Resume enters typed `re_refinement_required` before worker mutation. `p1r-009` owns this migration boundary.
- Source-PRD closure is status-and-evidence-only. After `p1r-013` parity, `p1r-014` may reconcile permitted `MASTER_PLAN.md` and version metadata, but must preserve all normative requirement and acceptance-criterion text verbatim.

## Already-landed preserve-and-harden seams

These are correct starting seams, not blank-slate implementation invitations:

- `extension/src/services/verification-env.ts` already canonicalizes generated regex runner flag/value pairs into one shell-quoted literal argv value. `p1r-003` must preserve this while unifying the shared literal path grammar and mirrored-consumer proof; it must not reimplement quoting blindly.
- `extension/src/bin/spawn-refinement-team.ts` already provides two attempts in each synthesis/fallback lane, changes to an independent fallback after synthesis exhaustion, uses production validation, and retains per-worker rejection diagnostics. `p1r-004` must harden it with durable typed recovery, monotonic budgets, crash/cancel resume, and persisted `refinement_exhausted`.
- `extension/src/services/prompts.ts` already directs synthesis to quote regex/glob runner values, use literal repository-relative paths, reject globs and repository-root `.`, distinguish exclusive artifacts from shared paths, and remain read-only. `p1r-003` must complete parser and mirrored-consumer parity without discarding that guidance.
- `extension/src/services/execution-gate.ts` already emits typed non-green `absent` when no quality commands exist, while failure identity still depends on normalized raw transcript lines. `p1r-006` preserves the absent state and `p1r-007` hardens diagnostic identity.
- Rejected-mutation archival and rollback already exist. `p1r-010` and `p1r-011` must preserve that machinery while binding it to authenticated receipts and evidence-carrying refusal remediation.
- Worker lifecycle refusal handling already validates and persists evidence-bearing `changes_requested` artifacts, raises a typed `WorkerLifecycleRefusalError`, and forwards the newest refusal artifact as remediation feedback. `p1r-011` must preserve that plumbing while adding checkpointed recovery and attempt accounting so a refusal re-enters the affected implementation-side phases instead of consuming another identical full research-to-conformance attempt.
- `extension/src/bin/spawn-morty.ts` now gives missing or invalid read-only lifecycle artifacts one bounded same-phase recovery attempt only when the repository-mutation fingerprint is unchanged. It archives the candidate artifact, last message, and metadata beneath `worker-lifecycle-failures` and feeds the validator diagnostic back to the retry; writable phases remain single-attempt. `extension/tests/worker-lifecycle.test.js` proves the malformed-conformance case, the one extra invocation, archival, retained implementation, and correction feedback. This source-inspected behavior advances `AR-R4` to partial and is part of the `QD-R7` preserve seam, but it does not provide full typed recovery history, receipt-grounded refusal, structured quality comparison, action/next-checkpoint history, or the required terminal-stop policy.
- `extension/src/services/verification-env.ts` masks quotes, comments, and escapes; recognizes only structurally complete simple shell `for` loops; and suppresses the bound variable only inside the loop body, failing closed when syntax is ambiguous. `extension/tests/verification-preflight.test.js` proves that a loop-local `id` is not inferred as required while `TRACEABILITY_FILE` is, and that word-list/post-loop, non-loop, subshell-external, quoted, and Unicode-prefixed lookalikes remain required. This is an already-landed verification-preflight preserve seam; it does not reclassify `QD-R4`, bootstrap path grammar, receipt, or composed-proof obligations.

## Closure guard

This ticket changes only this ledger and `reports/p1r-001-execution-base-audit.md`. It does not alter the three normative source PRDs. Their exact Requirements and Acceptance Criteria text remains verbatim; any later source-PRD edit is limited to status and completion evidence after composed `P13` proof. Final closure remains blocked until `P13` and `P14` pass and the final diff proves that normative text unchanged.
