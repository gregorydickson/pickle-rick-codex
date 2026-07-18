# MASTER_PLAN — Pickle Rick Codex

**Live ledger** for `pickle-rick-codex` (the Codex/`codex exec` port of Pickle Rick). Kept lean. PRDs live in
`prds/`; shipped detail lives in `git log`. `AGENTS.md` is the canonical runtime contract.

**Updated 2026-07-18.** A fresh source, installation, integration, safety, and Claude-parity audit replaced
the stale June snapshot. The TypeScript migration and detached pipeline with mandatory Citadel are present, but the
port remains beta while missing safety gates and reduced parity surfaces are hardened. Distribution
findings—truthful source/installed tests, package metadata, command paths, prerequisites, and CI install
smoke—are release-gate work rather than documentation-only claims.

## Status

| Item | Value |
|---|---|
| Version | **0.2.17-beta.1** (`package.json`) |
| Runtime data root | `~/.codex/pickle-rick/` (override `PICKLE_DATA_ROOT`) |
| Source → deploy | `extension/src/**/*.ts` → `npm ci` + `tsc` → `rsync` compiled runtime → `~/.codex/pickle-rick/extension/` |
| Guaranteed path | sequential `codex exec`; native multi-agent only after local validation |
| Canonical contract | `AGENTS.md` (`CLAUDE.md` is contributor-only and is not installed) |

**Directives.** Drain bugs before features, P1 > P2 > P3. Every non-trivial change starts from a PRD in
`prds/` and (per AGENTS.md) the three-analyst refine flow. Log every real field incident as a PRD here + a
drain row — field runs are the evidence that drives the work. Keep docs aligned to the guaranteed
`codex exec` path; do not default to undocumented native-agent controls.

## Drain Queue

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| LOA-1568 | **Harden ticket verification** — object-shaped `verification` crash + full-suite gate trip + no base-commit baseline. Corrected fix plan (dual `/ll:pr-review` + Codex review) moved the chokepoint to the read path, caught the third executing helper (`bin/spawn-morty.js`), and relocated baseline subtraction to the result layer. | **P1** | ✅ **SHIPPED v0.2.16-beta.1** — pipeline session `2026-06-24-f66adb81`: 6 pickle commits (D1–D4 + adjacents) + 37 anatomy-park trap-door fixes; tests 208/0 (+48). | `p1-fix-plan-ticket-verification-loa-1568.md` (corrects `p1-harden-ticket-verification-loa-1568.md`) |
| citadel-cleanup | **Citadel findings cleanup (post-beta debt)** — 22 open citadel findings from the LOA-1568 run: 16 brace-free `if` (CLAUDE.md-banned, mechanical) in `verification-env.js`/`pipeline-state.js`/`status.js`/a test, 4 orphan test files (no inbound ENFORCE ref), 1 Critical AC-4 coverage heuristic misfire (test-only AC → likely false positive), 1 Low ordering artifact. **No correctness defects** (suite 208/0). Clears the path beta→stable `v0.2.16`. | **P3** (1 P2 triage) | **READY TO BUILD** — mechanical; candidate for `morty-gate-remediator`. Blocks promotion of the beta to stable. | `p3-citadel-findings-cleanup-v0.2.16-beta.md` |
| catch-up-v2.0 | **Catch up to pickle-rick-claude v2.0** — the July 15 inventory remains historical gap analysis, but several baseline claims (plain JS, no release gate, missing safety services) are superseded. Re-audit remaining parity items against current source before implementation. | **P1** | **IN PROGRESS** — TypeScript and core reliability seams landed; correctness gates and reduced/missing command surfaces remain. | `p1-catch-up-to-claude-v2.0.md` |

## Foundational PRDs

| Item | State | Source |
|---|---|---|
| `pickle-pipeline` full port (detached pickle → anatomy-park → szechuan-sauce → final citadel, resume/cancel, monitor) | Delivered and hardened with a mandatory final release-review phase | `pickle-pipeline-port.md` |
