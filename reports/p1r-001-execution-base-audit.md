# p1r-001 Execution-Base Audit

## Audit boundary and repository evidence

This is the durable resume audit for the frozen P1 active-drain corpus. The normative requirement and acceptance-criterion text remains, without reduction or replacement, in:

- `prds/p1-autonomous-recovery-field-incidents.md` (`AR`)
- `prds/p1-quality-delta-and-grounded-conformance-field-incident.md` (`QD`)
- `prds/p1-field-run-bootstrap-contract-gaps.md` (`BS`)

At writable implementation start, `HEAD`, `main`, `origin/main`, and `origin/HEAD` all resolved to `9bb9a8d08dfd2bf7f0e495c63c3583c77cf2a70e`. `git status --short --branch` returned only `## main...origin/main`: the index and worktree were clean. The ticket then changed only this report and `prds/p1-active-field-incidents-traceability.md`. Commit `9bb9a8d` followed the ledger-creation commit `9c792b0`, but its runtime-owned staging/advancement and changed-path scanning work supplies no AR, QD, or BS coverage. Coverage below therefore describes the actual `9bb9a8d` execution base.

The proof keys are defined as exact commands in the ledger's deterministic proof catalog. Each row names its targeted proof and composed `P13` parity; `p1r-013` owns composed `P13`, and `p1r-014` owns later `P14` status/evidence-only closure.

## Complete mirrored frozen inventory

### Autonomous recovery (`AR`, 8 criteria)

| Stable ID | Mirrored criterion | Current coverage | Downstream owner(s) | Exact proof key(s) |
| --- | --- | --- | --- | --- |
| `AR-R1` | Generated-manifest defects are recoverable: canonicalize safe regex arguments, enforce artifact ownership, retain rejected candidates, and route exhausted synthesis repair to independent fallback refinement. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `AR-R2` | A bounded dependency-bootstrap phase precedes quality baselining, uses a detected supported lockfile/package manager deterministically, records results, reruns readiness, and represents credential/network/lockfile failure as recoverable environment state rather than ticket failure. | uncovered | `p1r-002`, `p1r-005` | `P02` + `P05` + composed `P13` |
| `AR-R3` | Lifecycle-review refusal persists findings and remediates through affected lifecycle phases without repeating unchanged research/plan or exhausting the ticket on an identical refusal. | uncovered | `p1r-011` | `P11` + composed `P13` |
| `AR-R4` | Typed recovery history persists attempt budgets, cause, action, and next checkpoint; terminal stop is limited to cancellation, exhausted recovery with no new path, or verified unsafe/corrupt state. | uncovered | `p1r-002`, `p1r-004`, `p1r-005`, `p1r-011` | `P02` + `P04` + `P05` + `P11` + composed `P13` |
| `AR-AC1` | Generated `--testPathPattern` or `--testNamePattern` values containing wildcards or alternation reach the runner as one literal argument. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `AR-AC2` | A shared implementation directory in `output_artifacts` is rejected before ticket materialization, then fallback refinement yields a non-overlapping plan or typed resumable recovery state. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `AR-AC3` | A clean pnpm worktree with a lockfile installs dependencies before baseline quality commands; install failure is recorded as environment recovery. | uncovered | `p1r-002`, `p1r-005` | `P02` + `P05` + composed `P13` |
| `AR-AC4` | Review refusal causes evidence-carrying implementation remediation and does not repeat unchanged research/plan phases. | uncovered | `p1r-011` | `P11` + composed `P13` |

### Quality delta and grounded conformance (`QD`, 16 criteria)

| Stable ID | Mirrored criterion | Current coverage | Downstream owner(s) | Exact proof key(s) |
| --- | --- | --- | --- | --- |
| `QD-R1` | Replace raw full-output equality with stable structured diagnostic identities for supported tools; exclude transcript noise and fail closed with a reason when safe extraction is unsupported. | uncovered | `p1r-007` | `P07` + composed `P13` |
| `QD-R2` | Bounded retries compare persistent structured diagnostics: persistent baseline failures are pre-existing, persistent post-worker identities absent from baseline are new, changed identities and newly failing commands are new, command-contract changes fail, and newly green commands are not regressions. | uncovered | `p1r-007` | `P07` + composed `P13` |
| `QD-R3` | Persist bounded per-command baseline attempts, post-worker results, diagnostic identities, subtraction, remaining identities, comparator version, verdict, and reason under the session, and name the artifact from runner errors. | uncovered | `p1r-008` | `P08` + composed `P13` |
| `QD-R4` | Every exact acceptance criterion maps to deterministic verification obligations with expected results, required artifacts/state, and evidence class; exact coverage is validated and generic prose/file checks cannot prove unrelated claims. | uncovered | `p1r-009` | `P09` + composed `P13` |
| `QD-R5` | Completion orders deterministic verification and authenticated receipt persistence before final conformance; receipts bind criterion/check, working directory, environment contract, result/evidence, baseline HEAD, worktree identity, and runner identity/time. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-R6` | Every conformance pass cites substantive runtime-owned receipts for the exact criterion, rejecting missing, failed, stale, foreign, mismatched, prose-only, ungrounded, or diff-contradicted evidence. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-R7` | Preserve rejected-mutation archive/rollback and causal evidence; lifecycle-artifact repair cannot convert failed verification or unsupported quality comparison into a pass. | preserve + gap | `p1r-010`, `p1r-011` | `P10` + `P11` + composed `P13` |
| `QD-AC1` | Parser fixtures prove transcript noise is excluded and real TypeScript, ESLint, Jest, Vitest, pnpm, timeout, and unknown-command diagnostics remain distinct. | uncovered | `p1r-007` | `P07` + composed `P13` |
| `QD-AC2` | The Markdown-only incident fixture stays green despite noisy transcript changes, while one added TypeScript diagnostic or failed test turns red and names only the new diagnostic. | uncovered | `p1r-007` | `P07` + composed `P13` |
| `QD-AC3` | Red and green comparisons persist bounded evidence containing baseline, post-worker, subtracted, and remaining diagnostic identities. | uncovered | `p1r-008` | `P08` + composed `P13` |
| `QD-AC4` | Manifest tests require one exact obligation mapping per criterion and reject missing, duplicate, or dangling mappings. | uncovered | `p1r-009` | `P09` + composed `P13` |
| `QD-AC5` | Lifecycle tests prove deterministic verification precedes conformance and conformance receives authenticated receipts. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-AC6` | A nonexistent-launcher fixture cannot gain narrative acceptance: runtime check fails, no `all_pass` is accepted, mutation is archived, ticket blocks, and downstream work does not start. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-AC7` | A matching actual-executable fixture with a successful receipt proceeds through conformance and completion oracle. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-AC8` | Receipt source search, typecheck, lint, full tests, and release gate prove no completion path accepts narrative-only conformance. | uncovered | `p1r-010` | `P10` + composed `P13` |
| `QD-AC9` | Installed-runtime validation passes after source implementation. | uncovered final-parity obligation | `p1r-013` | `P13` |

### Bootstrap and detached startup (`BS`, 12 criteria)

| Stable ID | Mirrored criterion | Current coverage | Downstream owner(s) | Exact proof key(s) |
| --- | --- | --- | --- | --- |
| `BS-R1` | Refinement publishes one strict literal normalized repository-relative grammar for all path fields, prohibiting globs, absolutes, `.`, traversal, qualifiers, labels, and appended prose without relaxing scope resolution. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `BS-R2` | Invalid synthesized manifests preserve original evidence and diagnostics, receive one diagnostic repair using complete approved inputs, rewrite only the two refinement artifacts, use the production validator, and fail closed without guessed coercion. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `BS-R3` | JavaScript package roots discover at most one script per quality category, preferring exact names over `:all`, preserving the chosen definition, and ignoring arbitrary substring matches. | uncovered/contradictory | `p1r-006` | `P06` + composed `P13` |
| `BS-R4` | A fresh empty quality contract is valid and fresh with empty commands/contract but evaluates to non-green `absent`; supported scripts cannot silently disappear and discovery is logged. | uncovered/contradictory | `p1r-006` | `P06` + composed `P13` |
| `BS-R5` | Detached tmux launch waits for a bounded authenticated runner handoff through readiness/preflight into active execution, fails closed on terminal/disappeared/foreign/timeout state, and does not wait for quality or ticket completion. | uncovered | `p1r-012` | `P12` + composed `P13` |
| `BS-AC1` | Prompt-contract tests prove strict path grammar and all path-bearing field names are documented. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `BS-AC2` | Refinement tests prove rejection, exactly one diagnostics-fed repair, valid continuation or closed second failure, retained evidence, and no regex/silent coercion. | partial | `p1r-003`, `p1r-004` | `P03` + `P04` + composed `P13` |
| `BS-AC3` | Quality tests cover supported package managers, exact-over-`:all` precedence, one command/category, stored definitions, ignored near-matches, persisted empty baseline, non-green absent, and stale/red removal or redefinition. | uncovered/contradictory | `p1r-006` | `P06` + composed `P13` |
| `BS-AC4` | Tmux integration proves immediate dirt/baseline failure is nonzero without success, valid handoff succeeds, timeout/foreign identity fail, and launch does not wait for long quality commands. | uncovered | `p1r-012` | `P12` + composed `P13` |
| `BS-AC5` | Source and compiled runtime alignment passes typecheck, lint, full tests, and release gate. | uncovered final-parity obligation | `p1r-013` | `P13` |
| `BS-AC6` | Installation validation proves the implementation is present in the installed runtime. | uncovered final-parity obligation | `p1r-013` | `P13` |
| `BS-AC7` | No test-only quality override becomes a production configuration surface. | uncovered final-parity obligation | `p1r-013` | `P13` |

Inventory reconciliation: 8 AR + 16 QD + 12 BS = 36 stable criteria. No stable source ID is omitted, duplicated, or replaced.

## Preserved cross-ticket contracts

- **Manifest recovery budget:** primary initial, primary diagnostic repair, fresh-process fallback initial, then fallback diagnostic repair; four candidates maximum. Every candidate uses the same production validator, rejected candidates and diagnostics remain evidence, and exhaustion persists typed resumable `refinement_exhausted`.
- **Authenticated detached tmux handoff:** the runner owns `baseline_started` after first-ticket selection, clean-tree, dependency bootstrap, and readiness. Launch ID/nonce and epoch, lease, tmux session, and PID start identity authenticate the handoff; the launcher returns before baseline completion.
- **Absent quality:** a fresh empty quality contract persists but evaluates to typed non-green `absent` and cannot complete.
- **Receipt freshness:** receipts bind the runner-captured baseline `HEAD` and exact tree/index/worktree identity. Any subsequent mutation makes them stale; final completion requires the committed tree to match the verified identity.
- **Legacy manifests:** an accepted legacy manifest without current obligations transitions to typed `re_refinement_required` before worker mutation; it is never silently enriched.
- **Closure:** only after `P13` may `p1r-014` perform `P14` status/evidence closure. Normative source-PRD requirement and acceptance-criterion text remains verbatim.

## Preserve-and-harden seams

- `verification-env.ts` already shell-quotes generated Jest regex flag/value pairs; `p1r-003` preserves it while completing shared path grammar and mirrored-consumer proof.
- `spawn-refinement-team.ts` already has bounded primary/fallback synthesis attempts, production validation, and retained rejection diagnostics; `p1r-004` adds the shared durable recovery envelope.
- `prompts.ts` already carries strict path and ownership guidance; `p1r-003` completes parser and consumer parity without discarding it.
- `execution-gate.ts` already emits typed non-green `absent` for zero commands, while raw transcript-line failure identities remain the `p1r-007` hardening seam.
- Rejected mutation archival and rollback already exist; `p1r-010` and `p1r-011` preserve them while grounding receipts and refusal remediation.

This ticket audits and reconciles documentation only. It does not recreate already-landed work or mutate runtime code.
