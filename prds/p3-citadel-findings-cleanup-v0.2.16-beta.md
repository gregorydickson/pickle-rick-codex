# PRD: Citadel Findings Cleanup — v0.2.16-beta post-ship debt

**Priority:** P3 (one P2 triage item) · **Status:** Ready to build · **Source:** citadel phase of pipeline
session `2026-06-24-f66adb81` (the LOA-1568 verification-hardening run)
**Captured:** 2026-06-24 from `citadel_report.json` (final cycle; 3-cycle remediation cap exhausted with
findings still open → pipeline continued without halt)
**Blocks:** promotion of `v0.2.16-beta.1` → stable `v0.2.16`

## Summary

The `v0.2.16-beta.1` release shipped with citadel's remediation cap exhausted and **22 findings open**. None
are correctness defects — the suite is **208 pass / 0 fail** — so they were deferred to ship the beta. This
PRD catalogs them so a stable `v0.2.16` can clear the debt. The work is overwhelmingly **mechanical** (16
brace-free `if` lint fixes + 4 test-linkage annotations); one Critical is a heuristic misfire to confirm, one
Low is an informational ordering artifact.

## Motivation

Citadel is the post-implementation conformance gate. It did not halt the pipeline (these are advisory/mechanical,
not trap doors), but the findings represent real CLAUDE.md style violations introduced/touched by the pipeline
plus a few convention gaps. Clearing them is the difference between a beta and a clean stable cut. This is
exactly the polish the skipped szechuan-sauce phase would have done.

## Findings (authoritative catalog — 22)

### P2 — triage (1 Critical, likely false positive)

- **`citadel-ac-coverage-AC-4-implementation` (AC-4).** "AC-4 has no production implementation evidence in
  changed files." **Assessment: heuristic misfire.** AC-4 of the LOA-1568 fix plan is the *regression-test*
  criterion ("tests cover `normalizeVerificationCommands` over array/string/object/alias/garbage") — it is
  test-only by design, so the absence of production-code changes is expected, not a gap. The coverage exists
  in `tests/verification-preflight.test.js`. **Action:** confirm the test coverage satisfies AC-4 and mark the
  finding a false positive (or, if citadel's AC→code map is desired, add an ENFORCE annotation linking AC-4 to
  its test file — see orphan-test items below, which would resolve this in the same pass).

### P3 — mechanical: brace-free `if` (16, CLAUDE.md-banned → wrap in `{ … }`)

- `bin/status.js:31`
- `lib/pipeline-state.js:107`, `:112`, `:113`, `:122`, `:203`, `:261`
- `lib/verification-env.js:112`, `:209`, `:226`, `:234`, `:237`, `:298`, `:369`, `:370`
- `tests/verification-preflight.test.js:44`

Single mechanical sweep: wrap each brace-free `if` body in a block. Re-run `node --test tests/*.test.js`
(expect 208/0 unchanged). Candidate for `morty-gate-remediator` (autofix-class), not a semantic change.

### P3 — convention: orphan test files (4, no inbound ENFORCE ref)

- `tests/pipeline.test.js`
- `tests/refinement-manifest.test.js`
- `tests/session-flow.test.js`
- `tests/verification-preflight.test.js`

Each lacks an inbound `ENFORCE:` reference tying the test to the invariant/trap-door it guards (the citadel
convention used by the anatomy-park trap-door entries in `lib/CLAUDE.md` / `bin/CLAUDE.md`). Add an ENFORCE
annotation (or trap-door note) pointing at each test. Annotating `verification-preflight.test.js` also resolves
the Critical AC-4 coverage finding above.

### Informational — Low (1, no action / infra)

- **`anatomy-park:missing`.** "anatomy-park.json is absent; skipping Citadel pattern-replay safety-net input."
  Ordering artifact: citadel (phase 2) ran *before* anatomy-park (phase 3), so the anatomy report didn't exist
  yet. Not a code defect. **Optional infra follow-up:** if citadel's pattern-replay should consume anatomy
  output, the phase order or a second citadel pass would be needed — out of scope here; note only.

## Goals

- G1. Zero brace-free `if` findings in the changed verification-path files (CLAUDE.md compliant).
- G2. Every `tests/*.test.js` touched by the LOA-1568 run carries an inbound ENFORCE/trap-door reference.
- G3. The Critical AC-4 coverage finding is resolved (confirmed false positive or annotated).
- G4. Suite stays green (208/0) — no behavior change.

## Non-Goals

- Any verification-path logic change (LOA-1568 is shipped; this is cleanup only).
- Re-architecting citadel's AC→code coverage heuristic or phase ordering (the Low item).

## Acceptance Criteria

- **AC-1.** A re-run of citadel (or `node --test`) reports 0 brace-free `if` findings in the listed files.
- **AC-2.** The 4 orphan test files each have an inbound ENFORCE reference; citadel reports 0 orphan-test findings.
- **AC-3.** The Critical AC-4 finding is closed (documented false positive or annotation added).
- **AC-4.** `node --test tests/*.test.js` → 208 pass / 0 fail (unchanged).

## Constraints

- Source = `lib/*.js` / `bin/*.js` (plain JS, no compile); deployed via `bash install.sh`.
- Mechanical-only; prefer `morty-gate-remediator` for the brace sweep (forbidden from semantic refactors).

## Repro / Evidence

- Session: `~/.codex/pickle-rick/sessions/2026-06-24-f66adb81/citadel_report.json` (summary: 22 findings —
  1 Critical, 20 Medium, 1 Low; runner log: "remediation cap (3) exhausted with 17 finding(s) still open —
  continuing pipeline").
- Released as `v0.2.16-beta.1` (prerelease) with these findings noted as the beta caveat.
