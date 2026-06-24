# MASTER_PLAN — Pickle Rick Codex

**Live ledger** for `pickle-rick-codex` (the Codex/`codex exec` port of Pickle Rick). Kept lean. PRDs live in
`prds/`; shipped detail lives in `git log`. `AGENTS.md` is the canonical runtime contract.

**Updated 2026-06-24.** Established this ledger. The repo's foundational delivery is the full
**`pickle-pipeline` port** (`prds/pickle-pipeline-port.md`) — detached `pickle → anatomy-park →
szechuan-sauce` over sequential `codex exec`. Now entering **field-hardening from real runs**: the first
pre-PR-review run surfaced two ticket-verification defects (LOA-1568) that abort the pipeline before any
remediation lands.

## Status

| Item | Value |
|---|---|
| Version | **0.2.15** (`package.json`) |
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
| LOA-1568 | **Harden ticket verification** — (1) object-shaped `verification` (`{commands:[…]}`) hard-crashes the runner via an unguarded `.map` at `lib/prompts.js:83`; the cited "defensive" helper `ticketVerificationCommands` has **no object branch** and exists in **two divergent copies** (`tickets.js:179` default `['npm test']` vs `verification-env.js:108` default `[]`), neither object-aware, with no normalization at `writeManifest`. (2) verification runs the **whole** suite (`pnpm test -- <path>` does not filter in vitest), so one pre-existing unrelated red blocks every ticket; **no base-commit baseline/quarantine** exists. Fix = ONE object-aware normalizer at the manifest chokepoint + pinned refine schema + fail-fast validation + scoped `exec vitest run <path>` emission + base-commit baseline-subtraction (port the claude sibling's `convergence-gate` pattern). | **P1** | **READY TO BUILD** — validated against source 2026-06-24 (v0.2.15). Urgent: aborts on ticket #1 with no remediation; currently needs a hand-edited `refinement_manifest.json` + skipped tests every run. | `p1-harden-ticket-verification-loa-1568.md` |

## Foundational PRDs

| Item | State | Source |
|---|---|---|
| `pickle-pipeline` full port (detached pickle → anatomy-park → szechuan-sauce, resume/cancel, monitor) | Delivered baseline (runtime present at v0.2.15) | `pickle-pipeline-port.md` |
