# MASTER_PLAN — Pickle Rick Codex

**Live ledger** for `pickle-rick-codex` (the Codex/`codex exec` port of Pickle Rick). Kept lean. PRDs live in
`prds/`; shipped detail lives in `git log`. `AGENTS.md` is the canonical runtime contract.

**Updated 2026-07-15.** Full audit completed against `pickle-rick-claude` (v2.0.0-beta.46+). The codex port
is 3 weeks and ~46 beta releases behind. A comprehensive catch-up PRD has been authored:
`p1-catch-up-to-claude-v2.0.md` — covering TS migration, 35 commands, 19 agents, ~70 reliability fixes,
26-analyzer citadel subsystem, convergence runtime, and full release gate. A droid mission will execute
the phased work breakdown (Phase 0 through Phase 5). The foundational delivery remains the full
**`pickle-pipeline` port** (`prds/pickle-pipeline-port.md`) — detached `pickle → anatomy-park →
szechuan-sauce` over sequential `codex exec`. **Field-hardening underway:** LOA-1568 (the two
ticket-verification defects that aborted the pipeline) is **shipped in `v0.2.16-beta.1`** via a full
self-hosted pipeline run (the runtime fixing its own verification path). Beta carries 22 deferred citadel
findings (all mechanical/advisory, suite 208/0) tracked as `citadel-cleanup` before a stable `v0.2.16`.

## Status

| Item | Value |
|---|---|
| Version | **0.2.16-beta.1** (`package.json`) — released as GitHub prerelease 2026-06-24 |
| Runtime data root | `~/.codex/pickle-rick/` (override `PICKLE_DATA_ROOT`) |
| Source → deploy | `lib/*.js` (plain JS, no compile) → `bash install.sh` (`cp -R`) → `~/.codex/pickle-rick/` |
| Guaranteed path | sequential `codex exec`; native multi-agent only after local validation |
| Canonical contract | `AGENTS.md` (`CLAUDE.md` is a compat shim) |

**Directives.** Drain bugs before features, P1 > P2 > P3. Every non-trivial change starts from a PRD in
`prds/` and (per AGENTS.md) the three-analyst refine flow. Log every real field incident as a PRD here + a
drain row — field runs are the evidence that drives the work. Keep docs aligned to the guaranteed
`codex exec` path; do not default to undocumented native-agent controls.

## Drain Queue

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| LOA-1568 | **Harden ticket verification** — object-shaped `verification` crash + full-suite gate trip + no base-commit baseline. Corrected fix plan (dual `/ll:pr-review` + Codex review) moved the chokepoint to the read path, caught the third executing helper (`bin/spawn-morty.js`), and relocated baseline subtraction to the result layer. | **P1** | ✅ **SHIPPED v0.2.16-beta.1** — pipeline session `2026-06-24-f66adb81`: 6 pickle commits (D1–D4 + adjacents) + 37 anatomy-park trap-door fixes; tests 208/0 (+48). | `p1-fix-plan-ticket-verification-loa-1568.md` (corrects `p1-harden-ticket-verification-loa-1568.md`) |
| citadel-cleanup | **Citadel findings cleanup (post-beta debt)** — 22 open citadel findings from the LOA-1568 run: 16 brace-free `if` (CLAUDE.md-banned, mechanical) in `verification-env.js`/`pipeline-state.js`/`status.js`/a test, 4 orphan test files (no inbound ENFORCE ref), 1 Critical AC-4 coverage heuristic misfire (test-only AC → likely false positive), 1 Low ordering artifact. **No correctness defects** (suite 208/0). Clears the path beta→stable `v0.2.16`. | **P3** (1 P2 triage) | **READY TO BUILD** — mechanical; candidate for `morty-gate-remediator`. Blocks promotion of the beta to stable. | `p3-citadel-findings-cleanup-v0.2.16-beta.md` |
| catch-up-v2.0 | **Catch up to pickle-rick-claude v2.0** — full audit identified: 17 missing commands, 10 partial commands, 19 missing agents, 35+ missing services, 26-analyzer citadel subsystem absent, ~70 reliability fixes unported, no TS build, no release gate, no convergence runtime, no FOM, no codegraph, no Linear. Phased migration: Phase 0 (TS + P0 safety) → Phase 1 (top 10 fixes) → Phase 2 (missing commands) → Phase 3 (agent system) → Phase 4 (quality gates) → Phase 5 (polish). Mission to execute. | **P1** | **READY TO BUILD** — PRD authored, mission launching. | `p1-catch-up-to-claude-v2.0.md` |

## Foundational PRDs

| Item | State | Source |
|---|---|---|
| `pickle-pipeline` full port (detached pickle → anatomy-park → szechuan-sauce, resume/cancel, monitor) | Delivered baseline (runtime present at v0.2.15) | `pickle-pipeline-port.md` |
