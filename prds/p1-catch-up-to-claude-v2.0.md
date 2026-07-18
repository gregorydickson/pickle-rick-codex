# PRD: Catch Up pickle-rick-codex to pickle-rick-claude v2.0

**Priority:** P1 · **Status:** In progress; inventory snapshot partially superseded · **Source:** July 15 audit of pickle-rick-claude (v2.0.0-beta.46+) vs pickle-rick-codex (then v0.2.16-beta.1)
**Captured:** 2026-07-15 · **Blocks:** All future codex work until parity is achieved

> **Status note (2026-07-18):** This is a frozen historical gap inventory, not current-state evidence. The port is now TypeScript-based, deploys a compiled `extension/`, has enforced fast/integration tiers plus a CI release gate, includes recoverable JSON and completion-evidence services, runs measured Microverse iterations, and has a compact final Citadel gate. That Citadel is intentionally not the Claude port's 26-analyzer subsystem. Re-run each gap check against the current tree before treating a row as open. `prds/MASTER_PLAN.md` is the live ledger.

## Summary

The codex port is 3 weeks and ~46 beta releases behind the claude version. The claude version has evolved
from a shared baseline into a hardened multi-backend convergence + review platform with ~70 shipped
reliability fixes, 35 commands, 19 agents, a TypeScript extension architecture, and a full release gate.
At capture time, the codex port was a minimum-viable pipeline runner with 14 skills, plain JS, no agents,
no Citadel, no convergence runtime, and only 1 shipped fix (LOA-1568). Those facts are retained below as
the July 15 comparison baseline and must not be quoted as the current implementation state.

This PRD catalogs every gap and proposes a phased migration to bring codex to parity, including the
architectural migration from plain JS to TypeScript (matching claude's extension model).

## Motivation

The codex port is the Codex CLI native variant of Pickle Rick, but it lacks the reliability, safety, and
quality layers that make the claude version production-viable. Every bug the claude version fixed in the
last 3 weeks is still present in codex. The codex port cannot dogfood itself reliably until the completion
oracle, worker spawn, and gate correctness fixes are ported. The missing review phases (citadel,
council-of-ricks, death-crystal) mean codex cannot run the full pipeline that claude runs.

## Historical State At Capture (Superseded)

| Metric | Codex (v0.2.16-beta.1) | Claude (v2.0.0-beta.46+) |
|--------|------------------------|--------------------------|
| Last commit | Jun 24, 2026 | Jul 15, 2026 |
| Architecture | Plain JS (lib/ + bin/) | TypeScript extension (compiled) |
| Commands/skills | 14 | 35 |
| Agents | 0 (no agents/ dir) | 19 (Morty system) |
| Bin scripts | 26 | 59 (in extension/src/bin/) |
| Services | 0 (flat lib/) | 47 (extension/src/services/) |
| Test files | 17 | 3 tiers (fast/integration/expensive) |
| Release gate | `node --test` | tsc + eslint + 10 audit scripts |
| Shipped reliability fixes | 1 (LOA-1568) | ~70 |
| Bug reports | 0 | 31 + 8 fix bundles |
| PRDs | 5 | 60+ |
| Citadel | Absent | 26-analyzer subsystem |
| Codegraph | Absent | v2.0 opt-in |
| FOM infusion | Absent | Live on judging surfaces |
| Linear integration | Absent | Runtime ticket sync |

## Gap Catalog

### A. Architecture Migration (Plain JS → TypeScript Extension)

**Current codex:** `lib/*.js` (24 modules) + `bin/*.js` (26 scripts), no compilation, deployed via `cp -R`.
**Claude target:** `extension/src/*.ts` → compiled to `extension/**/*.js` → deployed via `install.sh` rsync.

**Migration scope:**
1. Create `extension/` directory with `package.json`, `tsconfig.json`, `eslint` config
2. Create `extension/src/{bin,services,lib,hooks,types}/` structure matching claude
3. Port all 24 `lib/*.js` modules to `extension/src/services/*.ts` (see module mapping below)
4. Port all 26 `bin/*.js` scripts to `extension/src/bin/*.ts`
5. Add `npx tsc` build step to `install.sh`
6. Add full release gate (tsc --noEmit + eslint + audit scripts + test tiers)
7. Update `package.json` with TypeScript deps, build scripts, test tier scripts

**Module mapping (codex lib → claude extension/src):**

| Codex module | Claude target | Migration notes |
|---|---|---|
| `activity-logger.js` | `services/activity-logger.ts` | Add R-CIFB buffered-write root-drop invariant |
| `circuit-breaker.js` | `services/circuit-breaker.ts` | Add `detectProgress`, error-signature normalization |
| `codex.js` | `services/backend-spawn.ts` (codex branch) | Generalize to multi-backend interface |
| `config.js` | split into `services/state-manager.ts` + `services/pickle-utils.ts` | Distribute config logic |
| `detached-launch.js` | `bin/pipeline-runner.ts` (tmux spawn) | Fold into pipeline-runner |
| `git-utils.js` | `services/git-utils.ts` | Add bystander-stash, frontmatter-slice, `listWorkingTreeDirtyPaths` |
| `metrics.js` | `services/metrics-utils.ts` + `bin/metrics.ts` | Add skip-flag budgets, backend columns |
| `pickle-utils.js` | `services/pickle-utils.ts` | **Major expansion** — add `composeManagerPromptFromSkill`, `topoSortTickets`, tier budgets, watcher repair |
| `pipeline-bootstrap.js` | `bin/pipeline-runner.ts` + `services/bundle-state-integrity.ts` | Fold baseline-capture into pipeline-runner |
| `pipeline-phase-setup.js` | `bin/pipeline-runner.ts` | Add `PhaseSetupResult` with skip-reason observability |
| `pipeline-state.js` | `services/state-manager.ts` + `services/microverse-state.ts` | Split state.json vs pipeline-status.json |
| `pipeline.js` | `bin/pipeline-runner.ts` | Add citadel phase, orphan-mux subtree reap |
| `progress-snapshot.js` | `services/artifact-progress-detector.ts` + `services/microverse-state.ts` | Split artifact detection from stall classification |
| `prompts.js` | `services/pickle-utils.ts` + `services/fom-blocks.ts` | Add FOM blocks, skill-template resolution |
| `runner-descriptors.js` | folded into `bin/mux-runner.ts` / `bin/pipeline-runner.ts` | Inline descriptor emission |
| `session-map.js` | `services/state-manager.ts` + `services/pickle-utils.ts` | Split lock primitives from map logic |
| `session.js` | `services/state-manager.ts` | Add identity-bound locks, `SchemaVersionAheadError` |
| `setup-session.js` | `bin/setup.ts` | Add resume orphan-reattach, paused-orphan scan |
| `state-manager.js` | `services/state-manager.ts` | Add nonce+linkSync locks, inode recycling guard, phantom-leak pid stamping |
| `tickets.js` | `services/pickle-utils.ts` + `services/ticket-completion-evidence.ts` + `services/transaction-ticket-ops.ts` + `services/ticket-declared-files.ts` | **Decompose monolith** — extract single completion predicate oracle |
| `tmux.js` | `services/pickle-utils.ts` + `lib/monitor-respawn.ts` | Add `isForeignTmuxSession` ownership guard |
| `verification-env.js` | `services/convergence-gate.ts` + `services/verify-command-safety.ts` + `services/ac-phase-gate.ts` | **Decompose** — add env-noise stripping, shared command-safety predicate |

### B. Missing Modules (35+ services, 13 lib modules)

**Critical services with zero codex equivalent:**

| Module | Purpose | Priority |
|---|---|---|
| `recoverable-json.ts` | Sole JSON recovery primitive (orphan-tmp promotion, dead-pid demotion) | P0 |
| `ticket-completion-evidence.ts` | Single completion predicate oracle (B-1SEAM WS-1) | P0 |
| `dirty-tree-salvage.ts` | Shared salvage seam preventing false-Done bystander sweeps (B-1SEAM WS-3) | P0 |
| `promise-tokens.ts` | Worker-output token scrubbing (`scrubForbiddenWorkerTokens`) | P0 |
| `scope-resolver.ts` | Ticket scope resolution, fail-CLOSED (R-SSBR) | P1 |
| `convergence-gate.ts` | Gate runner with env-noise stripping, baseline subtract | P1 |
| `orphan-reaper.ts` | Orphaned worker-proc reaper (R-CXHANG) | P1 |
| `manager-relaunch.ts` | Codex max-turns relaunch, continuation (R-CMWL) | P1 |
| `microverse-state.ts` | Violation ledger, stall classification | P1 |
| `verify-command-safety.ts` | Shared `detectMissingTools`/`containsUnquotedGlobHazard` | P1 |
| `backend-spawn.ts` | Full multi-backend resolution | P2 |
| `convergence-defaults.ts` | Microverse convergence defaults | P2 |
| `judge-spawn-env.ts` | Judge env hygiene (R-SJET) | P2 |
| `calibration-corpus.ts` | Judge calibration drift detection | P2 |
| `codegraph-service.ts` + `codegraph-query-runner.ts` | Codegraph context injection | P2 |
| `linear-integration.ts` | Linear ticket status sync | P2 |
| `recovery-controller.ts` | Recovery controller | P2 |
| `transaction-ticket-ops.ts` | Restructure lock, dead-holder reclaim | P2 |
| `ticket-declared-files.ts` | Ticket declared files tracking | P2 |
| `agent-md-loader.ts` | Agent frontmatter YAML/CSV loader | P2 |
| `artifact-validation.ts` | Tier artifact prefix validation | P2 |
| `bundle-finalize.ts` | Bundle test-floor computation, morning summary | P2 |
| `bundle-state-integrity.ts` | Codex manager relaunch-cap audit | P2 |
| `council-fanout.ts` + `council-schema.ts` | Council-of-ricks fanout + schema | P3 |
| `death-crystal-html.ts` | Death-crystal HTML report | P3 |
| `fom-blocks.ts` | Figure-of-merit blocks | P3 |
| `forward-ref-annotation.ts` | Forward-ref annotation (if needed) | P3 |
| `jar-utils.ts` | `addToJar` | P3 |
| `pr-factory.ts` | `createPR` | P3 |
| `project-type-classifier.ts` | Project type classification | P3 |
| `signature-caller-gap.ts` | Signature caller gap analysis | P3 |
| `worker-shutdown.ts` | Worker shutdown | P3 |
| `classifier-utils.ts` | Codex tool-call stream observation | P3 |

**Entire Citadel subsystem (26 analyzers):**
`services/citadel/` — `audit-runner`, `reporter`, `ac-shape-audit`, `ac-coverage-scorecard`,
`banned-casts-audit`, `banned-constructs-audit`, `crossfile-behavior-drift-audit`, `diff-hygiene`,
`diff-walker`, `divergence-reconciliation`, `endpoint-contract-conformance`, `frontend-prop-drift-audit`,
`mechanical-finding-classifier`, `allowlist-dead-entry-detector`, `pattern-conformance-audit`,
`prd-parser`, `project-shape`, `rule-set-invariant-audit`, `schema-registry-drift-audit`,
`sibling-auth-audit`, `skeptic-lens`, `stale-reference-audit`, `state-transition-audit`,
`test-authenticity-audit`, `trap-door-coverage-audit`, `trap-doors-section`,
`citadel-findings-to-gate-result`

**Missing lib modules (13):**
`context-key-matrix.ts`, `diamond-routing.ts`, `engine-keys-registry.ts`, `is-record.ts`,
`linear-comment.ts`, `plumbus-kill-switch.ts`, `reconcile-ticket-truth.ts`, `salvage-ticket.ts`,
`severity.ts`, `tarjan-scc.ts`, `verification-comparator.ts`, `cluster-fix-selector.ts`,
`monitor-respawn.ts` (ownership-guarded version)

**Missing hooks (4):**
`hooks/dispatch.ts`, `hooks/resolve-state.ts`, `hooks/handlers/tsc-gate.ts`, `hooks/handlers/tool-error.ts`

### C. Missing Commands (17 missing, 10 partial)

**Missing commands (no codex equivalent at all):**

| Command | Description | Priority |
|---|---|---|
| `citadel` | Post-implementation conformance audit | P1 |
| `council-of-ricks` | Graphite PR stack review with directives | P2 |
| `death-crystal` | Interface design with multi-axis Morty fanout | P2 |
| `portal-gun` | Cross-repo pattern extraction/transplant | P2 |
| `plumbus` | Iterative DAG shaping on .dot files | P2 |
| `cronenberg` | Meta-router for deterministic command selection | P2 |
| `attract` | Submit pipeline to attractor server | P3 |
| `pickle-dot` | Convert PRD to attractor-compatible DOT digraph | P3 |
| `pickle-dot-patterns` | DOT pattern library (101KB) | P3 |
| `pickle-standup` | Linear-keyed standup report | P2 |
| `pickle-zellij` | Zellij alternative to tmux | P3 |
| `help-pickle` | Command index/help | P3 |
| `add-to-pickle-jar` | Queue session for Night Shift | P3 |
| `pickle-jar-open` | Run all Jar tasks sequentially | P3 |
| `disable-pickle` | Disable stop hook globally | P3 |
| `enable-pickle` | Re-enable stop hook | P3 |
| `eat-pickle` | Cancel active loop (joke command) | P3 |
| `project-mayhem` | Chaos engineering | P3 |
| `pickle-debate` | Multi-persona debate | P3 |

**Partial commands (need flag/capability backfill):**

| Command | Gap | Priority |
|---|---|---|
| `pickle-pipeline` | Missing SKILL.md, citadel stage, refinement prerequisite logic | P1 |
| `pickle-refine-prd` | Renamed to pickle-refine; prompt depth much reduced (48KB → 32 lines) | P1 |
| `pickle-tmux` | Missing `--backend`, `--teams` flags | P2 |
| `pickle-microverse` | Missing `--backend`, `--judge-model`, `--interactive` flags | P2 |
| `pickle-prd` | Missing paused-session mode, state.json step advance, full template | P2 |
| `pickle-recover` | Renamed to pickle-cancel; possible capability loss | P2 |
| `add-to-pickle-jar` | Has bin/jar-runner.js but no SKILL.md | P3 |
| `pickle-jar-open` | Has bin/jar-runner.js but no SKILL.md | P3 |

### D. Missing Agents (19 total — zero in codex)

**Agent families with no codex equivalent:**

| Agent family | Agents | Purpose | Priority |
|---|---|---|---|
| Phase specialists | morty-phase-researcher, -planner, -implementer, -verifier, -reviewer, -simplifier | Per-phase personas with tool contracts | P1 |
| Core workers | morty-implementer, morty-reviewer | 8-phase worker + cross-ticket review | P1 |
| Gate remediator | morty-gate-remediator | Mechanical toolchain-drift fixer | P2 |
| Course corrector | morty-course-corrector | Read-only mid-execution change proposals | P2 |
| Debaters (4) | morty-debater-architect, -implementer, -researcher, -skeptic | Multi-persona debate | P3 |
| Design Mortys (4) | morty-design-common-case, -flexible, -minimal, -ports | Interface design axes | P3 |

**Key difference:** Codex `spawn-morty.js` runs 5 phases (research, plan, implement, review, simplify).
Claude's `morty-implementer` runs 8 phases (Research → Research Review → Plan → Plan Review → Implement →
Spec Conformance → Code Review → Simplify). The two review gates are absent in codex.

### E. Reliability Fixes (Top 10 critical, ~70 total)

| # | Bug ID | Description | Priority |
|---|---|---|---|
| 1 | R-WGFR | Worker-gate single flaky test:fast false-red fatals green bundle | P0 |
| 2 | B-WSPU | Dual worker-spawn model collapse (delete detached lifecycle, unify on sync) | P0 |
| 3 | B-1SEAM WS-1 (R-AICF) | Collapse completion oracles to single predicate; hash-tag trailer injection | P0 |
| 4 | B-1SEAM WS-2 (R-PSCG) | Symmetric citadel self-heal for start_commit | P1 |
| 5 | B-1SEAM WS-3 (R-MACB) | Port bystander-stash to microverse auto-rescue | P1 |
| 6 | B-SSVR (R-SSBR + R-ISVP) | Scope-resolver fail-CLOSED + install.sh prerelease semver fix | P1 |
| 7 | gate-overreach subtraction | Make iteration-0/ticket-audit gates advisory; delete forward-ref grammar | P1 |
| 8 | B-RASO + B-RRPC + B-CSHYG | Recovery attributable-work single oracle; recovery sprawl collapse | P1 |
| 9 | R-WDTF | Done-flip erases completion_commit pointer to worker's real commit | P0 |
| 10 | B-TRGP + R-TCVC | Worker gate is NO-OP on non-pickle-rick repos; portable gate needed | P0 |

**Full reliability backlog (~70 items) categorized:**
- Completion/oracle fixes: ~14
- Worker spawn fixes: ~10
- Gate/scope fixes: ~13
- Recovery sprawl: ~13
- FOM/citation fixes: ~6
- Other: ~15

### F. Missing Infrastructure

| Item | Description | Priority |
|---|---|---|
| Release gate | tsc + eslint + 10 audit scripts + 3 test tiers | P1 |
| Test tiers | fast/integration/expensive separation | P1 |
| FOM infusion | Fabrication-of-mind guards on judging surfaces | P2 |
| Codegraph v2.0 | Opt-in code indexing + context injection | P2 |
| Linear integration | Runtime ticket status sync | P2 |
| Promise token scrubbing | Prevent worker-emitted orchestrator tokens | P0 |
| Tmux ownership guard | `isForeignTmuxSession` preventing foreign-pane injection | P0 |
| Recoverable JSON | Sole primitive for interrupted-write recovery | P0 |
| Hooks subsystem | PreToolUse dispatch + handlers | P2 |
| Activity event schema | JSON schema for activity events | P2 |
| Refinement manifest schema | JSON schema for refinement manifests | P3 |

## Phased Work Breakdown

### Phase 0: Foundation (TS migration + critical safety)

**Goal:** Migrate to TypeScript, port the 4 P0 safety modules, establish the release gate.

1. Create `extension/` directory structure with `package.json`, `tsconfig.json`, eslint
2. Port all 24 `lib/*.js` → `extension/src/services/*.ts` (use module mapping above)
3. Port all 26 `bin/*.js` → `extension/src/bin/*.ts`
4. Create `services/recoverable-json.ts` — sole JSON recovery primitive
5. Create `services/ticket-completion-evidence.ts` — single completion oracle (B-1SEAM WS-1)
6. Create `services/dirty-tree-salvage.ts` — shared salvage seam (B-1SEAM WS-3)
7. Create `services/promise-tokens.ts` — worker output scrubbing
8. Add `isForeignTmuxSession` ownership guard to tmux helpers
9. Add `install.sh` TypeScript build step (`npx tsc` before rsync)
10. Establish release gate: `tsc --noEmit && eslint && node --test` (minimal, expand later)
11. Port R-WGFR (flaky-gate false-red fix), R-WDTF (Done-flip commit pointer), B-TRGP (portable worker gate)

**Exit criteria:** TS build green, all existing tests pass in new structure, 4 P0 modules in place.

### Phase 1: Reliability Backfill (top 10 fixes)

**Goal:** Port the 10 most critical reliability fixes from claude's drain queue.

1. B-WSPU — collapse dual worker-spawn to single synchronous lifecycle
2. B-1SEAM WS-1 (R-AICF) — wire all completion decision sites through single predicate
3. B-1SEAM WS-2 (R-PSCG) — symmetric self-heal for start_commit
4. B-1SEAM WS-3 (R-MACB) — bystander-stash on microverse auto-rescue
5. B-SSVR (R-SSBR) — scope-resolver fail-CLOSED
6. B-SSVR (R-ISVP) — install.sh prerelease semver fix
7. gate-overreach subtraction — advisory gates, delete forward-ref grammar
8. B-RASO + B-RRPC + B-CSHYG — recovery single oracle + sprawl collapse
9. R-WGFR — flaky-gate de-flaker
10. B-TRGP + R-TCVC — portable worker gate

**Exit criteria:** All 10 fixes ported with regression tests, suite green, codex pipeline runs clean on a test bundle.

### Phase 2: Missing Commands (P1-P2)

**Goal:** Port the 6 P1-P2 missing commands.

1. `citadel` — port 26-analyzer subsystem + command + pipeline integration
2. `council-of-ricks` — port fanout + schema + command
3. `death-crystal` — port interface design with design-Morty fanout
4. `portal-gun` — port cross-repo pattern extraction
5. `plumbus` — port iterative DAG shaping
6. `cronenberg` — port meta-router

**Also:** Backfill partial commands (pickle-pipeline citadel stage, pickle-refine-prd depth, pickle-tmux flags, pickle-microverse flags, pickle-prd paused mode).

**Exit criteria:** All 6 commands invocable with `codex exec`, citadel runs as the final pipeline stage, and pickle-pipeline runs full 4-phase (build → anatomy → szechuan → citadel).

### Phase 3: Agent System (19 agents)

**Goal:** Port the Morty agent system with agent-md-loader.

1. Create `.codex/agents/` directory
2. Port `services/agent-md-loader.ts`
3. Port 6 phase specialist agents (researcher, planner, implementer, verifier, reviewer, simplifier)
4. Port morty-implementer (8-phase lifecycle with Research Review + Plan Review gates)
5. Port morty-reviewer (cross-ticket review-group dispatch)
6. Port morty-gate-remediator
7. Port morty-course-corrector
8. Port 4 debater agents + debate runner
9. Port 4 design Mortys + death-crystal integration
10. Expand spawn-morty.ts from 5 phases to 8 phases

**Exit criteria:** All 19 agents loadable, spawn-morty runs 8-phase lifecycle, review-group dispatch works.

### Phase 4: Quality Gates + Remaining Services

**Goal:** Port convergence runtime, codegraph, FOM, Linear, hooks, remaining services.

1. Port `convergence-gate.ts` + `convergence-defaults.ts` + `microverse-state.ts`
2. Port `judge-spawn-env.ts` + `calibration-corpus.ts`
3. Port `codegraph-service.ts` + `codegraph-query-runner.ts`
4. Port `fom-blocks.ts` — FOM infusion on judging surfaces
5. Port `linear-integration.ts` + `lib/linear-comment.ts`
6. Port hooks subsystem (`dispatch.ts`, `resolve-state.ts`, `tsc-gate.ts`, `tool-error.ts`)
7. Port remaining 13 lib modules
8. Port remaining services (backend-spawn, recovery-controller, transaction-ticket-ops, etc.)
9. Expand release gate to full 10-audit-script + 3-test-tier parity
10. Port `pickle-standup`, `add-to-pickle-jar`, `pickle-jar-open` commands

**Exit criteria:** Full release gate green, convergence runtime functional, codegraph opt-in, FOM guards live.

### Phase 5: Remaining Commands + Polish

**Goal:** Port all P3 commands, fill remaining gaps, match claude parity.

1. Port `attract`, `pickle-dot`, `pickle-dot-patterns`, `pickle-zellij`
2. Port `help-pickle`, `disable-pickle`, `enable-pickle`, `eat-pickle`
3. Port `project-mayhem`, `pickle-debate`
4. Port remaining ~60 reliability fixes from claude's backlog
5. Update AGENTS.md, CLAUDE.md, README.md for new command set
6. Full end-to-end pipeline test (pickle-pipeline running a real bundle)
7. Version bump to v2.1.0 (codex port matching claude v2.0 parity)

**Exit criteria:** All 35 commands available, all 19 agents loadable, full release gate green, pipeline runs a real bundle end-to-end clean.

## Acceptance Criteria

- **AC-1.** The codex port builds via `npx tsc` with zero errors in `extension/`.
- **AC-2.** The release gate (`tsc --noEmit && eslint && audit scripts && test tiers`) is green.
- **AC-3.** All 35 claude commands have codex equivalents (skill or bin) with matching flags.
- **AC-4.** All 19 agents are loadable via `agent-md-loader.ts`.
- **AC-5.** The single completion predicate oracle (`evaluateCompletionEvidence`) routes all decision sites.
- **AC-6.** `recoverable-json.ts` is the sole JSON read primitive for session artifacts.
- **AC-7.** Tmux ownership guard prevents foreign-pane keystroke injection.
- **AC-8.** Promise token scrubbing is applied to all worker output.
- **AC-9.** Citadel runs as a pipeline stage in `pickle-pipeline`.
- **AC-10.** `pickle-pipeline` runs a real multi-ticket bundle end-to-end (build → anatomy → szechuan → citadel) hands-off with zero interventions.
- **AC-11.** All top 10 reliability fixes are ported with regression tests.
- **AC-12.** Version bumped to v2.1.0 with matching git tag.

## Non-Goals

- Porting the `attractor` server itself (external dependency; codex just submits to it).
- Porting claude-specific features that are truly claude-only (e.g., `--teams` harness primitives that codex doesn't support).
- Porting the VS Code extension (if claude has one — codex is CLI-only).
- Rolling back the codex-native `codex exec` guaranteed path (codex remains single-backend by design).
- Porting historical bug reports (we port the fixes, not the documentation of the bugs).

## Constraints

- Source = `extension/src/*.ts` (TypeScript, compiled); deployed via `bash install.sh` (tsc + rsync).
- Preserve the `~/.codex/pickle-rick/` runtime data root and `PICKLE_DATA_ROOT` override.
- Preserve the sequential `codex exec` guaranteed path (single backend).
- Every non-trivial change starts from a PRD and the three-analyst refine flow (per AGENTS.md).
- The pipeline must be able to dogfood itself (fix its own bugs via pickle-pipeline).
- Match claude's CLAUDE.md required patterns: CLI guard, hook decisions, error messages, extension path.

## Risks

- **Scope risk:** This is 3 weeks of claude work. The mission must be broken into milestone-sized chunks.
- **Architecture risk:** TS migration could break the `cp -R` deploy model if not handled carefully.
- **Backend divergence:** Codex is single-backend (`codex exec`); claude's multi-backend abstraction adds complexity that may not be needed. Port the interface but keep codex-only implementation.
- **Test debt:** Claude has 3 test tiers; codex has 1. Migrating tests alongside source is required.
- **FOM infusion:** Porting FOM blocks to codex judging surfaces requires the judge prompts to exist first (Phase 3 dependency).

## Evidence

- Claude repo: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/` (v2.0.0-beta.46+, last commit Jul 15)
- Codex repo: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-codex/` (v0.2.16-beta.1, last commit Jun 24)
- Claude MASTER_PLAN: `prds/MASTER_PLAN.md` (582 lines, documents all shipped bundles)
- Claude BUG-INDEX: `prds/BUG-INDEX.md` (133KB, ~70 findings cataloged)
- Full audit reports from 4 parallel research workers (commands, agents, modules, reliability)
