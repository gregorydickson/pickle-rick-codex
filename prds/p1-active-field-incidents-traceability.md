# P1 Active Field-Incident Traceability and Current-Main Gap Audit

This document freezes the implementation contract for the P1 drain before runtime mutation. It is a current-main delta decision and traceability ledger, not a replacement for the normative text in these sources:

- `prds/p1-autonomous-recovery-field-incidents.md` (`AR`)
- `prds/p1-quality-delta-and-grounded-conformance-field-incident.md` (`QD`)
- `prds/p1-field-run-bootstrap-contract-gaps.md` (`BS`)

The exact Requirements and Acceptance Criteria text in those three source PRDs is immutable during implementation. This audit changes only the ledger. After composed `P13` proof passes, ticket `p1r-014` may change source-PRD status and completion-evidence sections only; it must preserve the normative text byte-for-byte.

## Implementation-start repository evidence

- Observed implementation-start `HEAD`: `be14b71ef1277b4c5301709ad5e67dd978b84346`.
- At implementation start, `HEAD`, local `main`, `origin/main`, `origin/HEAD`, and configured upstream `@{upstream}` all resolved to that revision. `git rev-list --left-right --count origin/main...HEAD` returned `0 0` (zero behind, zero ahead).
- Before mutation, the index and worktree were clean. `git status --short --branch` produced only `## main...origin/main`; no staged or unstaged path was reported.
- The observed revision is execution evidence, not a required fixed SHA, sibling pin, or `freeze_contract`. The prior ledger basis `536aecbbff83733fddc212b7e4a6576db3ae455a` is a historical observation only.

### Normative-input drift guards

These SHA-256 values bind this decision to the three same-repository normative inputs observed before mutation:

| Normative input | SHA-256 |
| --- | --- |
| `prds/p1-autonomous-recovery-field-incidents.md` | `3d9eb5f76341bd4d1263095d8b0d4033a3c85b5fa2cb08aacd89377fbbeb8b6c` |
| `prds/p1-quality-delta-and-grounded-conformance-field-incident.md` | `5dd404ea3e82acc551a8ad1f29b9d70fa69ae330de14912ac4e7741995a1d1da` |
| `prds/p1-field-run-bootstrap-contract-gaps.md` | `74f0a4a10992d3061d1f598dbfdbd53f77e792c04928b9117ccda6fff09f2cb9` |

These are local input-drift guards, not sibling SHA pins. A later mismatch before worker mutation must stop in typed `re_refinement_required`; it must not be modeled as a sibling `freeze_contract`.

## Current-main delta classification

Coverage is based on source and test inspection at the observed implementation start, not commit subjects:

- **covered**: the complete component obligation and proof already exist.
- **partial**: some required behavior exists, but the frozen contract is incomplete.
- **preserve-plus-gap**: a correct current seam must be preserved and hardened while its remaining component and composed-proof obligations are implemented.
- **uncovered**: the required component contract or proof is not present.

The historical snapshot predates changes that must not be erased or misclassified as blank-slate work:

- Generated regex flag/value argv canonicalization is a **preserve-and-harden** seam for `AR-R1` and `AR-AC1`.
- The bounded primary initial/repair and fresh fallback initial/repair manifest lanes, common production validator, and retained rejection diagnostics are **preserve-and-harden** seams for `AR-R1`, `AR-AC2`, `BS-R2`, and `BS-AC2`.
- Evidence-bearing lifecycle refusal, bounded malformed read-only lifecycle-artifact regeneration, retained lifecycle failure evidence, and durable adaptive recovery history/budgets are **preserve-and-harden** seams for `AR-R3`, `AR-R4`, `AR-AC4`, and the `QD-R7` refusal/archival boundary.
- Rejected-mutation archival and rollback are a **preserve-and-harden** seam for `QD-R7`.
- Strict manifest prompt guidance is a **preserve-and-harden** seam for `BS-R1` and `BS-AC1`.
- Typed non-green empty-quality `absent` behavior is a **preserve-and-harden** seam for `BS-R4` and `BS-AC3`.
- Shell-loop verification-preflight hardening is an adjacent **preserve-and-harden** seam. It does not satisfy or reclassify `QD-R4`.
- Exact-name quality discovery exists, so `BS-R3` is **partial**; conventional `*:all` selection and precedence remain missing.

No row is currently **covered**. The matrix contains 13 **preserve-plus-gap**, one **partial**, and 22 **uncovered** rows.

## Frozen criterion inventory and ownership

The exact criterion text remains the immutable text at the stable ID in the applicable normative source PRD. This matrix contains exactly all 36 obligations: 8 AR, 16 QD, and 12 BS. Every row names its owning ticket(s), component proof, and composed `P13` proof.

### Autonomous recovery (`AR`)

| Stable ID | Owning ticket(s) | Current classification | Component plus composed proof |
| --- | --- | --- | --- |
| `AR-R1` | `p1r-003`, `p1r-004` | preserve-plus-gap | `P03` + `P04` + composed `P13` |
| `AR-R2` | `p1r-002`, `p1r-005` | uncovered | `P02` + `P05` + composed `P13` |
| `AR-R3` | `p1r-011` | preserve-plus-gap | `P11` + composed `P13` |
| `AR-R4` | `p1r-002`, `p1r-004`, `p1r-005`, `p1r-011` | preserve-plus-gap | `P02` + `P04` + `P05` + `P11` + composed `P13` |
| `AR-AC1` | `p1r-003`, `p1r-004` | preserve-plus-gap | `P03` + `P04` + composed `P13` |
| `AR-AC2` | `p1r-003`, `p1r-004` | preserve-plus-gap | `P03` + `P04` + composed `P13` |
| `AR-AC3` | `p1r-002`, `p1r-005` | uncovered | `P02` + `P05` + composed `P13` |
| `AR-AC4` | `p1r-011` | preserve-plus-gap | `P11` + composed `P13` |

### Quality delta and grounded conformance (`QD`)

| Stable ID | Owning ticket(s) | Current classification | Component plus composed proof |
| --- | --- | --- | --- |
| `QD-R1` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-R2` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-R3` | `p1r-008` | uncovered | `P08` + composed `P13` |
| `QD-R4` | `p1r-009` | uncovered | `P09` + composed `P13` |
| `QD-R5` | `p1r-010a`, `p1r-010b` | uncovered | `P10A` + `P10B` + composed `P13` |
| `QD-R6` | `p1r-010a`, `p1r-010b` | uncovered | `P10A` + `P10B` + composed `P13` |
| `QD-R7` | `p1r-010b`, `p1r-011` | preserve-plus-gap | `P10B` + `P11` + composed `P13` |
| `QD-AC1` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-AC2` | `p1r-007` | uncovered | `P07` + composed `P13` |
| `QD-AC3` | `p1r-008` | uncovered | `P08` + composed `P13` |
| `QD-AC4` | `p1r-009` | uncovered | `P09` + composed `P13` |
| `QD-AC5` | `p1r-010a`, `p1r-010b` | uncovered | `P10A` + `P10B` + composed `P13` |
| `QD-AC6` | `p1r-010b` | uncovered | `P10B` + composed `P13` |
| `QD-AC7` | `p1r-010b` | uncovered | `P10B` + composed `P13` |
| `QD-AC8` | `p1r-010b` | uncovered | `P10B` + composed `P13` |
| `QD-AC9` | `p1r-013` | uncovered | component `P13` + composed `P13` |

### Bootstrap and detached startup (`BS`)

| Stable ID | Owning ticket(s) | Current classification | Component plus composed proof |
| --- | --- | --- | --- |
| `BS-R1` | `p1r-003` | preserve-plus-gap | `P03` + composed `P13` |
| `BS-R2` | `p1r-004` | preserve-plus-gap | `P04` + composed `P13` |
| `BS-R3` | `p1r-006` | partial | `P06` + composed `P13` |
| `BS-R4` | `p1r-006` | preserve-plus-gap | `P06` + composed `P13` |
| `BS-R5` | `p1r-012` | uncovered | `P12` + composed `P13` |
| `BS-AC1` | `p1r-003` | preserve-plus-gap | `P03` + composed `P13` |
| `BS-AC2` | `p1r-003`, `p1r-004` | preserve-plus-gap | `P03` + `P04` + composed `P13` |
| `BS-AC3` | `p1r-006` | preserve-plus-gap | `P06` + composed `P13` |
| `BS-AC4` | `p1r-012` | uncovered | `P12` + composed `P13` |
| `BS-AC5` | `p1r-013` | uncovered | component `P13` + composed `P13` |
| `BS-AC6` | `p1r-013` | uncovered | component `P13` + composed `P13` |
| `BS-AC7` | `p1r-013` | uncovered | component `P13` + composed `P13` |

Every row receives composed end-to-end parity proof under `P13`, owned by `p1r-013`. After that proof passes, `p1r-014` owns `P14` status/evidence closure.

## Deterministic proof catalog

Run these commands from the repository root. New test files named below are created by their owning tickets before later tickets cite them. Typecheck and lint are the literal commands listed, not package-wide substitutes.

- `P01R`: `git diff --check`; verify this ledger contains all 36 unique IDs, the current observed start evidence, all delta classifications, and the resolved contracts without prescribing a fixed SHA.
- `P02`: `node --test extension/tests/recovery-controller.test.js extension/tests/state-manager.test.js extension/tests/state-terminal.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P03`: `node --test extension/tests/path-grammar-contract.test.js`; `node --test extension/tests/prompts-prd-contract.test.js extension/tests/refinement-manifest.test.js extension/tests/scope-contract.test.js extension/tests/ticket-declared-files.test.js extension/tests/verification-command-safety.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P04`: `node --test extension/tests/command-flows.test.js extension/tests/refinement-manifest.test.js extension/tests/recovery-controller.test.js extension/tests/session-flow.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P05`: `node --test extension/tests/dependency-bootstrap.test.js extension/tests/readiness.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js extension/tests/recovery-controller.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P06`: `node --test extension/tests/execution-gate.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P07`: `node --test extension/tests/execution-gate.test.js extension/tests/quality-diagnostics.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P08`: `node --test extension/tests/quality-evidence.test.js extension/tests/execution-gate.test.js extension/tests/verification-preflight.test.js extension/tests/session-flow.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P09`: `node --test extension/tests/refinement-manifest.test.js extension/tests/frontmatter-helpers.test.js extension/tests/verification-preflight.test.js extension/tests/command-flows.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P10A`: `node --test extension/tests/verification-receipts.test.js extension/tests/verification-preflight.test.js extension/tests/state-manager.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P10B`: `node --test extension/tests/worker-lifecycle-contract.test.js extension/tests/ac-phase-gate.test.js extension/tests/verification-receipts.test.js extension/tests/session-flow.test.js extension/tests/mux-runner-oracle-refusal.test.js`; `rg -n 'verification_receipt|verificationReceipt' extension/src/services extension/src/bin`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P11`: `node --test extension/tests/worker-lifecycle.test.js extension/tests/worker-lifecycle-contract.test.js extension/tests/ac-phase-gate.test.js extension/tests/session-flow.test.js extension/tests/recovery-controller.test.js extension/tests/mux-runner-oracle-refusal.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P12`: `node --test extension/tests/tmux-contract.test.js extension/tests/pickle-pipeline.test.js extension/tests/session-flow.test.js extension/tests/mux-runner-oracle-refusal.test.js extension/tests/runner-descriptors.test.js extension/tests/is-foreign-tmux-session.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`.
- `P13`: `node --test extension/tests/field-incidents-e2e.test.js`; `npm --prefix extension run typecheck`; `npm --prefix extension run lint`; `npm test`; `npm run release:gate`; `runtime_root="$(mktemp -d)"; trap 'rm -rf "$runtime_root"' EXIT; CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" bash install.sh && CODEX_HOME="$runtime_root/codex" AGENTS_HOME="$runtime_root/agents" PICKLE_DATA_ROOT="$runtime_root/data" npm run test:installed`; `! rg -n 'PICKLE_TEST_QUALITY_COMMANDS' README.md docs skills`; then `bash extension/scripts/authenticated-field-incidents-smoke.sh reports/p1r-013-authenticated-smoke.md` under an authenticated Codex operator account. The smoke uses installed sequential `codex exec --full-auto`, records CLI/runtime identity plus command and evidence paths/digests, and ends with final Citadel approval. Unavailable credentials or network yields `Implemented, release validation pending`, never `Shipped`.
- `P14`: rerun `P13`, verify root/extension version equality when a bump is required, validate all 36 ledger rows against passing evidence, and perform an adversarial final-diff review that fails unless normative source Requirements and Acceptance Criteria remain byte-for-byte unchanged and the final worktree is clean.

## Resolved cross-ticket contracts

### Absolute four-candidate manifest recovery budget

The absolute combined maximum is four generated candidates: primary initial, primary diagnostic repair, fresh-process/fresh-context fallback initial, and fallback diagnostic repair. The fallback receives approved original inputs plus validator diagnostics only after primary exhaustion. Every candidate uses the same production validator; rejected output and diagnostics remain evidence and are never silently coerced. Exhaustion persists typed, resumable `refinement_exhausted`; retry requires changed remediation input or operator retry authority.

### Empty quality is non-green

A fresh persisted empty quality contract is valid evidence but evaluates to typed non-green `absent` and blocks completion. Exact script names take precedence over conventional `*:all` variants; a stale or missing persisted decision must be recomputed under the `p1r-006` contract.

### Mutation-sensitive verification receipts

A verification receipt binds the runner-captured baseline `HEAD` and exact tree, index, and worktree identity. Any later mutation makes the receipt stale and forces deterministic verification and conformance to rerun. Final completion requires the committed tree to equal the verified identity; a commit SHA alone is not a substitute.

### Legacy manifest boundary

An older accepted manifest without the current verification obligations is never silently enriched. Resume enters typed `re_refinement_required` before worker mutation. This is an input-contract migration boundary, not a sibling `freeze_contract`.

### Authenticated detached tmux handoff

Launch success is the runner-owned `baseline_started` checkpoint after first-ticket selection, the clean-tree gate, dependency bootstrap, and verification readiness, immediately before long quality execution. It authenticates launch ID/nonce and epoch, lease, tmux/session identity, runner mode, PID/process-start identity, ticket, checkpoint, and transition. The launcher returns at this boundary—not at PID liveness or baseline completion—and later failure remains asynchronous session failure with preserved evidence.

### Authenticated release closure

Release closure requires source, full, release-gate, and isolated-installed-runtime proof plus an operator-authenticated smoke on the installed sequential `codex exec --full-auto` path and final Citadel approval. The smoke must cover all eight lifecycle artifacts, exact criterion receipts and conformance, checkpoint remediation, authenticated tmux ownership transfer, and a clean completion boundary. Without authenticated proof, status remains `Implemented, release validation pending`, never `Shipped`.

## Documentation closure guard

Documentation closure is status-and-evidence-only after `P13`. Ticket `p1r-014` may update permitted source-PRD status/completion-evidence sections and `prds/MASTER_PLAN.md`, with version metadata only when release policy requires it. It may not change normative Requirements or Acceptance Criteria text. Final `P14` must prove that text is byte-for-byte unchanged and that every ledger row points to passing component and composed evidence.

This ticket modifies only `prds/p1-active-field-incidents-traceability.md`. It does not modify the three normative source PRDs or imply a separate report edit.
