# PRD: Harden Ticket Verification (object-shaped `verification` crash + full-suite gate trips)

**Priority:** P1 (Urgent) · **Linear:** [LOA-1568](https://linear.app/loanlight-eng/issue/LOA-1568) · **GitHub:** loanlight-api#2407
**Status:** Ready to build · **Validated:** 2026-06-24 against source at HEAD (`pickle-rick-codex` v0.2.15)
**Reported by:** Max Klein · **Observed in:** session `2026-06-24-e1639f60`, repo `loanlight-api`, branch `feat/aus-v1`

## Summary

The detached `pickle-pipeline` aborts before any remediation lands because of two ticket-verification
defects that surfaced back-to-back in one pre-PR-review run, each needing a manual session-manifest edit
to get past. Both are in the verification path: (1) an unguarded `.map` on `ticket.verification` hard-crashes
the runner when the refiner emits an object-shaped `verification`; (2) verification commands run the **whole**
test suite, so one pre-existing unrelated failing test fails the gate for **every** ticket.

## Motivation

The pipeline exists to land automated pre-PR remediation hands-off. Today a single object-shaped
`verification` field crashes ticket #1, and a single unrelated red test on the base commit blocks all
tickets — so the operator hand-edits `refinement_manifest.json` and skips tests on every run. That defeats
the tool's purpose and makes the gate untrustworthy.

## Root Cause 1 — unguarded `.map` on `ticket.verification` (hard crash)

`lib/prompts.js:83` (verified):

```js
`Verification commands:\n${(ticket.verification || ['npm test']).map((item) => `- ${item}`).join('\n')}`,
```

`||` does not catch a truthy **object**, so when the refiner emits the richer shape the model is actually
invited to produce —

```json
"verification": { "commands": [ { "command": "pnpm … test …", "expect": "…" } ] }
```

— `.map` is `undefined` → `(ticket.verification || ["npm test"]).map is not a function` → ticket fails both
attempts → `pipeline-runner aborting` on ticket #1.

**The refiner actively invites the object shape.** `lib/prompts.js:21`, `:58`, `:60` instruct the model to
include `verification` and to "Emit `verification_env`, `output_artifacts`, `proof_corpus`, and
`freeze_contract` … for truthful execution" **without pinning the `verification` shape**. So the object form
is the prompt working as written, not the model misbehaving.

**New findings beyond the Linear report (from source validation):**

1. **The "defensive helper" does NOT cover the object shape.** `ticketVerificationCommands`
   (`lib/tickets.js:179`) handles `string[]`, `string` (split on `&&`), and the `verify` alias, then defaults
   to `['npm test']`. It has **no `{ commands: [...] }` branch.** So merely routing `prompts.js` through it
   (the Linear-proposed fix) stops the crash but **silently swaps the real commands for `npm test`** — a
   quieter version of the same bug.
2. **There are TWO divergent copies of the helper.** `lib/tickets.js:179` (default `['npm test']`, no optional
   chaining) and `lib/verification-env.js:108` (default `[]`, with `?.`). Same name, different behavior,
   neither object-aware. Consumers split across them (`prompts.js:83` indexes the raw field; `tickets.js:412`
   & `:449` and `verification-env.js:161` call a helper).
3. **No normalization at manifest write.** `writeManifest` (`lib/tickets.js:174`) stores whatever the refiner
   emitted verbatim; normalization is ad-hoc at each consumer.

## Root Cause 2 — verification runs the full suite (unrelated reds block every ticket)

The refiner emitted, e.g.:

```
pnpm --filter @loanlight/app test -- "src/components/scenario-engine/__tests__/scenario-inputs.test.tsx"
```

vitest's positional filter through the npm `test` script does **not** filter — it runs the **entire** suite.
So one pre-existing unrelated red test (`packages/app/src/components/chat/__tests__/history-overlay.test.tsx`,
which spawns `node --import tsx`, unresolvable in the sandbox) failed the gate for every remediation ticket
(`aus-v1-02` → `verification-contract-failed`, suite output ending on that unrelated test). The run only
proceeded after the unrelated test was skipped.

**New finding (from source validation):** there is **no test-baseline / quarantine mechanism** in `lib/`
(grep for `baseline|quarantine|pre-existing` finds only prompt prose + a git commit label) — so any red on
the base commit is indistinguishable from a red the ticket caused.

## Goals

- G1. An object-shaped (`{ commands: [...] }`) refined `verification` never crashes the runner; it is
  normalized to `string[]` with the real commands preserved (never silently replaced by `npm test`).
- G2. One normalization chokepoint at manifest load; every consumer reads the same `string[]`.
- G3. Ticket verification runs only the intended scoped tests; a pre-existing unrelated red on the base
  commit does not fail unrelated remediation tickets.
- G4. Regression coverage over array / string / `{ commands: [...] }` / `verify`-alias inputs.

## Non-Goals

- Redesigning the verification-contract / `verification_env` system (`output_artifacts`, `proof_corpus`,
  `freeze_contract` stay as-is).
- Changing the anatomy-park / szechuan-sauce convergence model.
- Cross-runner test selection beyond vitest/pnpm (handle the observed stack; keep the normalizer generic).

## Constraints

- Source = `lib/*.js` (plain JS, no compile); deployed by `bash install.sh` (`cp -R`) to `~/.codex/pickle-rick/`.
- Fail-fast with a clear message is preferable to a mid-run crash, per AGENTS.md "truthful runnable baseline".

## User Journeys

- **CUJ-1 (object-shaped verification):** refiner emits `verification: { commands: [{command, expect}] }` →
  manifest load normalizes to `["pnpm … test …"]` → ticket runs the real command, no crash.
- **CUJ-2 (scoped verification):** refiner emits a path-scoped test command → it actually filters (runs only
  that file), so a ticket passes/fails on its own change.
- **CUJ-3 (pre-existing red):** a test already failing on the base commit is captured as baseline and does
  **not** fail an unrelated ticket's gate; only new reds (or reds in the ticket's scope) fail it.

## Technical Design

### D1 — Single object-aware normalizer (G1, G2)

Add `normalizeVerificationCommands(ticket): string[]` (one home — recommend `lib/verification-env.js`, then
re-export). It MUST handle, in order: `string[]` → map String; `string` → split `&&`; **`{ commands: [...] }`
→ map each entry to its `.command` when an object, or `String(entry)` when a string**; `verify` string alias;
else default. Call it **once in `writeManifest` (`lib/tickets.js:174`)** to write a normalized
`verification: string[]` back into the manifest, so all downstream consumers (`prompts.js:83`,
`tickets.js:412/449`, `verification-env.js:161`) read a uniform array. **Delete the two divergent
`ticketVerificationCommands` copies** (`tickets.js:179`, `verification-env.js:108`) in favor of the one
normalizer. `prompts.js:83` reads the normalized field directly (no raw `.map`).

### D2 — Pin the refinement schema + validate the manifest (G1)

Tighten `lib/prompts.js:21/:58/:60` to specify `verification` is a JSON array of shell command strings (give
the exact shape). After refinement, validate each ticket's `verification` normalizes to a non-empty
`string[]`; on failure, **fail fast** with the ticket id + offending value, not a mid-run `.map` crash.

### D3 — Scoped verification emission (G3)

Refiner emits commands that actually filter for the detected runner — e.g. `pnpm --filter <pkg> exec vitest
run <path>` (direct vitest), **not** `pnpm test -- <path>`. Encode this guidance in the refiner prompt and,
where the pipeline rewrites/normalizes commands, prefer the `exec vitest run` form for vitest packages.

### D4 — Base-commit test baseline / quarantine (G3)

Before remediation, capture the set of tests already failing on the base commit; subtract that set when
judging a ticket's gate, so only **new** reds (or reds in the ticket's declared scope) fail it. (This is the
pattern the claude sibling implements as `convergence-gate.ts` baseline-subtraction — portable design, not
novel.) Smallest viable version: capture once at pipeline start, store under the session dir, subtract in the
`verification-contract-failed` decision (`lib/pipeline-bootstrap.js:279`, `lib/pipeline-state.js:88`).

## Exact File Changes

- `lib/verification-env.js` — add `normalizeVerificationCommands` (object-aware); remove the local
  `ticketVerificationCommands` duplicate; export the normalizer.
- `lib/tickets.js` — remove the `ticketVerificationCommands` duplicate; call the normalizer in `writeManifest`
  to persist `verification: string[]`; update `:412`/`:449` consumers.
- `lib/prompts.js` — `:83` read the normalized `verification` array (no raw `.map`); `:21/:58/:60` pin the
  `verification: string[]` schema; add the scoped-`vitest run` guidance (D3).
- `lib/pipeline-bootstrap.js` / `lib/pipeline-state.js` — baseline subtraction in the
  `verification-contract-failed` path (D4).
- `test/` — regression suite (D5 / AC-4).

## Acceptance Criteria

- **AC-1 (crash fixed).** A ticket whose refined `verification` is `{ commands: [{command, expect}] }`
  normalizes to the real `string[]` and runs — no `…map is not a function`. The real command is preserved
  (NOT replaced by `npm test`).
- **AC-2 (single chokepoint).** After manifest load every consumer reads `verification` as `string[]`; only
  one `normalizeVerificationCommands` exists; the two old `ticketVerificationCommands` copies are gone.
- **AC-3 (fail-fast).** A `verification` value that cannot normalize to a non-empty `string[]` fails refinement
  with a clear `ticket <id>` message before any worker spawns — never a mid-run crash.
- **AC-4 (regression test).** Tests cover `normalizeVerificationCommands` over: `string[]`, `string` (with
  `&&`), `{ commands: [{command}] }`, `{ commands: ["cmd"] }`, `verify` alias, and empty/garbage → default.
- **AC-5 (scoped verification).** For a vitest package, emitted/normalized verification uses a path-filtering
  form (`exec vitest run <path>`), proven to run only the targeted file, not the whole suite.
- **AC-6 (baseline).** A test already failing on the base commit does not fail an unrelated ticket's gate;
  a new red introduced by the ticket still fails it.

## Simplification Review (subtract-before-add)

- **Necessary?** Yes — a crash + a false-blocking gate. The core is **subtraction**: collapse two divergent
  helpers + scattered raw indexing into ONE normalizer at ONE chokepoint.
- **Reuse vs add?** Reuse the existing helper logic; extend it for the object shape; D4 ports the sibling's
  proven baseline-subtraction pattern rather than inventing one.
- **Subtraction?** −1 duplicated helper, −1 raw `.map` indexing site, −1 silent-`npm test` mis-default; the
  manifest field becomes a single normalized shape.

## Repro / Evidence

- Session: `~/.codex/pickle-rick/sessions/2026-06-24-e1639f60`; `pipeline-runner.log` shows both failures.
- Workaround applied that run: hand-normalized the `verification` object → `string[]` in the manifest;
  skipped the unrelated env-only test.
