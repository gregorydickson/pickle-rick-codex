# P1 Active Field-Incident Traceability and Current-Main Gap Audit

This document freezes the implementation contract for the P1 drain before runtime mutation. It is an audit and traceability ledger, not a replacement for the normative text in these sources:

- `prds/p1-autonomous-recovery-field-incidents.md` (`AR`)
- `prds/p1-quality-delta-and-grounded-conformance-field-incident.md` (`QD`)
- `prds/p1-field-run-bootstrap-contract-gaps.md` (`BS`)

The requirement and acceptance-criterion text in those three source PRDs is immutable during implementation. Ticket `p1-014` may change only status and completion-evidence sections after proof is complete.

## Starting repository condition

- Audit and implementation starting `HEAD`: `c75ea543318b1af0618630f3e2859e6a0249d78f`.
- Starting `origin/main`: `c75ea543318b1af0618630f3e2859e6a0249d78f`; the repository was synchronized.
- Starting worktree: clean; `git status --short` produced no entries.
- Starting gap: this traceability document did not exist. No runtime file had been changed for this drain.

Coverage states below describe that starting revision: **partial** means correct behavior exists but the frozen contract is incomplete; **uncovered** means the required contract/proof is not yet present; **preserve + gap** means relevant archive/rollback behavior exists but the receipt-grounded remediation contract does not.

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

| Stable ID | Owning ticket(s) | Starting coverage | Exact proof |
| --- | --- | --- | --- |
| `AR-R1` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `AR-R2` | `p1-002`, `p1-005` | uncovered | `P02` + `P05` |
| `AR-R3` | `p1-011` | uncovered | `P11` |
| `AR-R4` | `p1-002` plus recovery-consuming tickets | uncovered | `P02` and the consuming ticket's targeted recovery tests |
| `AR-AC1` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `AR-AC2` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `AR-AC3` | `p1-002`, `p1-005` | uncovered | `P02` + `P05` |
| `AR-AC4` | `p1-011` | uncovered | `P11` |

### Quality delta and grounded conformance (`QD`)

| Stable ID | Owning ticket(s) | Starting coverage | Exact proof |
| --- | --- | --- | --- |
| `QD-R1` | `p1-007` | uncovered | `P07` |
| `QD-R2` | `p1-007` | uncovered | `P07` |
| `QD-R3` | `p1-008` | uncovered | `P08` |
| `QD-R4` | `p1-009` | uncovered | `P09` |
| `QD-R5` | `p1-010` | uncovered | `P10` |
| `QD-R6` | `p1-010` | uncovered | `P10` |
| `QD-R7` | `p1-010`, `p1-011` | preserve + gap | `P10` + `P11` |
| `QD-AC1` | `p1-007` | uncovered | `P07` |
| `QD-AC2` | `p1-007` | uncovered | `P07` |
| `QD-AC3` | `p1-008` | uncovered | `P08` |
| `QD-AC4` | `p1-009` | uncovered | `P09` |
| `QD-AC5` | `p1-010` | uncovered | `P10` |
| `QD-AC6` | `p1-010` | uncovered | `P10` |
| `QD-AC7` | `p1-010` | uncovered | `P10` |
| `QD-AC8` | `p1-010` | uncovered | `P10` |
| `QD-AC9` | `p1-013` | uncovered final-parity obligation | `P13` |

### Bootstrap and detached startup (`BS`)

| Stable ID | Owning ticket(s) | Starting coverage | Exact proof |
| --- | --- | --- | --- |
| `BS-R1` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `BS-R2` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `BS-R3` | `p1-006` | uncovered/contradictory | `P06` |
| `BS-R4` | `p1-006` | uncovered/contradictory | `P06` |
| `BS-R5` | `p1-012` | uncovered | `P12` |
| `BS-AC1` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `BS-AC2` | `p1-003`, `p1-004` | partial | `P03` + `P04` |
| `BS-AC3` | `p1-006` | uncovered/contradictory | `P06` |
| `BS-AC4` | `p1-012` | uncovered | `P12` |
| `BS-AC5` | `p1-013` | uncovered final-parity obligation | `P13` |
| `BS-AC6` | `p1-013` | uncovered final-parity obligation | `P13` |
| `BS-AC7` | `p1-013` | uncovered final-parity obligation | `P13` |

All frozen criteria also receive composed end-to-end parity proof under `P13`. After that proof passes, `p1-014` owns `P14` status/evidence closure. The refinement dependency graph makes every `p1-002` through `p1-014` ticket depend directly or transitively on this `p1-001` decision record.

## Resolved cross-ticket contracts

### Manifest recovery budget

Each synthesis/fallback lane gets exactly one initial candidate plus at most one diagnostic repair. The primary synthesis lane runs first. Only if it remains invalid may an independent fallback lane run in a fresh process and fresh context using the approved original inputs and validator diagnostics; it also gets one initial candidate plus at most one repair. Four generated candidates is the absolute combined maximum. Every candidate passes through the same production validator. Rejected output and diagnostics remain evidence and may not be silently rewritten. Exhaustion persists typed, resumable `refinement_exhausted`; retry requires changed remediation input or operator retry authority. `p1-004` implements this on the `p1-002` recovery model after `p1-003` path-contract hardening.

### Authenticated detached tmux handoff

Launch success requires authentication of the launch ID/nonce and launch epoch, operation lease, tmux session, and PID start identity. The runner—not the launcher—writes `baseline_started`, and only after first-ticket selection, the clean-tree gate, dependency bootstrap, and verification-readiness gates pass. The launcher returns at that authenticated start boundary before quality commands finish and never claims baseline completion; later baseline failure is asynchronous session failure with preserved evidence. `p1-012` owns this contract after `p1-005`, `p1-006`, `p1-008`, and `p1-011`.

### Remaining frozen decisions

- Fresh empty quality discovery is valid and persists, but evaluates to typed non-green `absent`; it blocks completion. `p1-006` owns the behavior.
- A verification receipt binds the runner-captured baseline `HEAD` and the exact verified tree/worktree digest. Any later mutation makes it stale and forces deterministic verification and conformance to rerun; final completion requires the committed tree to equal the verified digest. `p1-010` owns the receipt boundary and `p1-011` owns refusal remediation.
- Older accepted manifests are never silently enriched with new verification obligations. Resume enters typed `re_refinement_required` before worker mutation. `p1-009` owns this migration boundary.
- Source-PRD closure is status-and-evidence-only. After `p1-013` parity, `p1-014` may reconcile permitted `MASTER_PLAN.md` and version metadata, but must preserve all normative requirement and acceptance-criterion text verbatim.

## Already-landed preserve-and-harden seams

These are correct starting seams, not blank-slate implementation invitations:

- `extension/src/services/verification-env.ts` already canonicalizes generated regex runner flag/value pairs into one shell-quoted literal argv value. `p1-003` must preserve this while unifying the shared literal path grammar and mirrored-consumer proof; it must not reimplement quoting blindly.
- `extension/src/bin/spawn-refinement-team.ts` already provides two attempts in each synthesis/fallback lane, changes to an independent fallback after synthesis exhaustion, uses production validation, and retains per-worker rejection diagnostics. `p1-004` must harden it with durable typed recovery, monotonic budgets, crash/cancel resume, and persisted `refinement_exhausted`.
- `extension/src/services/prompts.ts` already directs synthesis to quote regex/glob runner values, use literal repository-relative paths, reject globs and repository-root `.`, distinguish exclusive artifacts from shared paths, and remain read-only. `p1-003` must complete parser and mirrored-consumer parity without discarding that guidance.

## Closure guard

This ticket creates only this audit. It does not alter the three normative source PRDs. Final closure remains blocked until `P13` and `P14` pass and the final diff proves their normative requirement and acceptance-criterion text unchanged.
