# FIX PLAN PRD: Ticket-Verification Hardening — review-corrected (LOA-1568)

**Priority:** P1 (Urgent) · **Linear:** [LOA-1568](https://linear.app/loanlight-eng/issue/LOA-1568) · **GitHub:** loanlight-api#2407
**Status:** Ready to build · **Supersedes the Technical Design of:** `prds/p1-harden-ticket-verification-loa-1568.md`
**Validated:** 2026-06-24 against source at HEAD (`pickle-rick-codex` v0.2.15)

## Why this exists

The seed PRD (`p1-harden-ticket-verification-loa-1568.md`) correctly diagnosed the two field defects
(object-shaped `verification` crash + full-suite gate trip) but its **fix design has load-bearing errors**.
A dual review — the `/ll:pr-review` Claude deep-audit lens **and** an independent Codex adversarial pass,
each pointed at the verification path and each told to attack the seed PRD's own design — converged on the
same spine: **the proposed chokepoint does not sit on the path that crashes.** Three independent passes
(manual source grounding + Claude + Codex) agree. This PRD is the corrected, source-verified fix plan.

> **One-line summary of the correction:** normalize at `readManifest`, not `writeManifest`; there are
> **three** divergent helpers, not two (the third is the one that *executes* the gate); and D4's baseline
> subtraction must wrap the verification *result* in `bin/spawn-morty.js`, not the exit-reason classifier.

## Review provenance

| Lens | Confirmed seed defects | Net-new / corrections |
|---|---|---|
| Manual source grounding | both | wrong chokepoint (`writeManifest` is conditional + refiner writes file directly) |
| `/ll:pr-review` Claude deep-audit | both | **third helper `splitVerificationCommands` (the executor)**; raw read at `spawn-morty.js:269/348`; array-of-objects → `[object Object]`; default-divergence semantics; D3 has no enforcement site; D4 wrong file; fail-fast bypassed on resume |
| Codex adversarial | both | `readManifest` bypass (triangulates); D4 missing structured-data contract (triangulates); + 5 adjacent defects (id collision, case-sensitive `none`, `${VAR:-fallback}` regex, contradictory `exitReason`, literal `"null"` frontmatter) |

## Confirmed against source (HEAD v0.2.15)

- `lib/prompts.js:83` — raw `(ticket.verification || ['npm test']).map(...)` — crashes on object shape. ✔
- `lib/tickets.js:179` & `lib/verification-env.js:108` — two divergent `ticketVerificationCommands`
  (defaults `['npm test']` vs `[]`), neither object-aware. ✔
- **`bin/spawn-morty.js:31` — a THIRD helper `splitVerificationCommands`**, object-unaware, returns the
  array un-stringified, falls through to `['npm test']` on the object shape. **This is the helper the gate
  actually executes** (`:382`). ✔ *(missing from the seed PRD)*
- `bin/spawn-morty.js:269` reads the **raw** manifest (`readManifest`); `:348` spreads `...manifestTicket`
  into `buildTicketPhasePrompt` → `prompts.js:83` receives the **raw** `verification` → **the crash is NOT
  fixed by normalizing at `writeManifest`.** ✔
- `lib/tickets.js:165 readManifest` runs only `normalizeManifestTicketIds` (ids/deps); it never touches
  `verification`. `writeManifest` (`:174`) is plain `atomicWriteJson` and is called *conditionally*
  (`:762`, `:920`) — and the refiner writes `refinement_manifest.json` **directly to disk** (per the
  `codex exec` instruction at `prompts.js:20/57`), so object-shaped `verification` never passes through
  `writeManifest()` at all. ✔
- `bin/status.js:31` (`.join(' && ')`) and `bin/loop-runner.js:81/206` — additional raw readers. ✔

## Root causes (corrected)

### RC-1 — object/array-of-objects `verification` crashes or silently degrades

`||` does not catch a truthy object, and **none of the three helpers** has an object branch. The seed PRD
counted two helpers; the executor's `splitVerificationCommands` (`bin/spawn-morty.js:31`) is the third and
the most important — it decides what command the gate runs. Two failure modes, not one:
1. `{ commands: [...] }` → `prompts.js:83` `.map` crash (build path) **and** `splitVerificationCommands`
   silent fall-through to `['npm test']` (executor path).
2. **`[{ command, expect }]`** (array of objects — a plausible refiner shape) → `tickets.js:181`
   `String({...})` = `'[object Object]'`, an executed garbage command. **Worse than a crash.** Uncovered by
   the seed PRD, which only describes the `{ commands: [...] }` wrapper.

### RC-2 — wrong normalization chokepoint

The seed PRD's D1 normalizes at `writeManifest`. The crash/degrade consumers (`prompts.js:83`,
`spawn-morty.js:382`) both read the **raw** manifest via `readManifest`, and the refiner writes the manifest
file directly without calling `writeManifest`. **The only universal read chokepoint is `readManifest`.**

### RC-3 — full-suite gate, no baseline, and D4 aimed at the wrong layer

`pnpm test -- <path>` doesn't filter in vitest → one unrelated base-commit red fails every ticket. The seed
PRD's D3 (scoped emission) is **prompt-only — there is no command-rewrite site in `lib/`** (`splitVerificationCommands`/`ticketVerificationCommands` only split/stringify; `runVerificationCommand` runs verbatim), so scoping rests entirely on D4. And D4's cited sites — `pipeline-bootstrap.js:279`, `pipeline-state.js:88` — are `isBlockedExitReason` **classification** points; the gate decision (`new VerificationContractError`) is thrown at **`bin/spawn-morty.js:401`** after `runVerificationCommand`. By the classifier layer the result is already a collapsed string with no command/test identities to subtract against.

## Goals

- **G1.** Object- and array-of-objects-shaped `verification` never crashes and is never silently replaced by
  `npm test`; the real commands are preserved as `string[]`.
- **G2.** ONE object-aware normalizer; **all three** helpers collapse into it; every consumer
  (`prompts.js`, `bin/spawn-morty.js`, `bin/status.js`, `tickets.js` validators) reads the same `string[]`.
- **G3.** Normalization sits on the **read** path (`readManifest`) so it covers refiner-written and resumed
  manifests, not just freshly-written ones.
- **G4.** A pre-existing base-commit red does not fail an unrelated ticket; subtraction happens where the
  structured result exists (`spawn-morty.js`), keyed by ticket id + command scope.
- **G5.** Fail-fast (clear `ticket <id>` message) on un-normalizable `verification`, on **every** path that
  feeds the executor — refinement, fallback, and resume.
- **G6.** Regression coverage over array / string / `{commands:[...]}` / `[{command}]` / `verify` alias /
  empty / garbage.

## Non-Goals

- Redesigning the `verification_env` contract system (`output_artifacts`, `proof_corpus`, `freeze_contract`).
- Changing the anatomy-park / szechuan-sauce convergence model.
- The adjacent non-gate defects in the Appendix beyond what is explicitly pulled into scope below.

## Technical Design (corrected)

### D1 — ONE object-aware normalizer, on the READ path (G1, G2, G3)

Add `normalizeVerificationCommands(ticket): string[]` (home: `lib/verification-env.js`, exported). Handle, in
order:
1. `string[]` → for each entry: if object, take `.command` (else `String(entry)`); **this covers
   array-of-objects (RC-1.2)**.
2. `string` → split on `&&`, trim, drop empties.
3. **`{ commands: [...] }`** → map each entry to `.command` (object) or `String(entry)` (string).
4. `verify` string alias → split on `&&`.
5. else → default (see D1a).

**Call it on the read path, not the write path.** Normalize `verification` inside
`normalizeManifestTicketIds` (or a sibling invoked by `readManifest`, `lib/tickets.js:165`) so it persists a
normalized `verification: string[]` back to the manifest on every read — covering refiner-written and resumed
manifests. **Delete all three divergent helpers** (`tickets.js:179`, `verification-env.js:108`,
`bin/spawn-morty.js:31`) and route every consumer through the one normalizer:
`prompts.js:83`, `spawn-morty.js:382`, `spawn-morty.js:348` (the spread into `buildTicketPhasePrompt`),
`tickets.js:412/449/770`, `verification-env.js:161`, `bin/status.js:30`.

> **AC-2 cannot be met without auditing `bin/`** — the seed PRD's "two copies" scope misses the executor and
> status readers.

### D1a — pick the unified default deliberately (prevents a silent behavior change)

The two old helpers default differently (`['npm test']` vs `[]`). `hasOnlyGenericVerification`
(`tickets.js:411`, used by `validateRefinementManifest`) calls the `['npm test']` copy; `inferRequiredEnv…`
(`verification-env.js:161`) calls the `[]` copy. Collapsing changes which branch fires. **Decision: default
to `['npm test']`** (preserves today's `hasOnlyGenericVerification` behavior — empty stays "generic"), and
re-baseline `validateRefinementManifest`/env-inference tests against that single default. Document the choice
in the normalizer.

### D2 — pin the refine schema + fail-fast on EVERY feed path (G5)

Tighten `prompts.js:21/:58/:60` to specify `verification` is a JSON array of shell-command strings (exact
shape). Add validation that each ticket's `verification` normalizes to a non-empty `string[]`; on failure,
**fail fast** with the ticket id + offending value. Wire the validation into the **read/load** path (so
resume and `fallbackRefinePrd` are covered), not only into `validateRefinementManifest` during refinement —
the deep-audit confirmed `ensureBootstrapSessionReady` and the fallback parser produce/consume manifests that
never re-run refinement validation.

### D3 — scoped verification needs a real rewrite site, or be honest it's advisory (G4 support)

Prompt guidance alone cannot enforce scoping (no rewrite site exists). Either (a) add a normalization step
that rewrites `pnpm … test -- <path>` → `pnpm --filter <pkg> exec vitest run <path>` for detected vitest
packages inside the new normalizer, or (b) explicitly downgrade D3 to advisory and rely on D4. **Recommend
(a)** for vitest packages (the observed stack); keep the rewrite generic/no-op for unknown runners.

### D4 — base-commit baseline subtraction at the RESULT layer (G4)

Capture the set of tests/commands already failing on the base commit once at pipeline start; store under the
session dir. Apply subtraction where the structured result exists: **`bin/spawn-morty.js:386–408`**, around
the `runVerificationCommand` result, *before* `new VerificationContractError` is thrown at `:401`. A red that
is in the baseline (same command scope, not in the ticket's declared scope) does **not** throw; a new red, or
a red inside the ticket's scope, still throws. Do **not** implement subtraction at
`pipeline-bootstrap.js:279`/`pipeline-state.js:88` — those only classify an already-collapsed string and have
no per-command identity to compare.

## Exact File Changes

- `lib/verification-env.js` — add+export `normalizeVerificationCommands` (object- and array-of-objects-aware);
  remove the local `ticketVerificationCommands`.
- `lib/tickets.js` — remove the local `ticketVerificationCommands`; normalize `verification` on the
  **read** path (`readManifest`/`normalizeManifestTicketIds`); update consumers `:412/:449/:770`; re-baseline
  `hasOnlyGenericVerification` against the unified default (D1a).
- `bin/spawn-morty.js` — **delete `splitVerificationCommands` (`:31`)**; route `:348` and `:382` through the
  normalizer; add D4 baseline subtraction around `runVerificationCommand` (`:386–408`) before the throw at
  `:401`.
- `lib/prompts.js` — `:83` read the normalized array (no raw `.map`); `:21/:58/:60` pin the `string[]` schema
  + scoped-`vitest run` guidance.
- `bin/status.js` — `:30` route through the normalizer.
- `lib/pipeline-bootstrap.js` / `lib/pipeline-state.js` — capture/persist structured verification baseline so
  D4 has identities to subtract (the missing data contract Codex flagged), even though the subtraction
  decision lives in `spawn-morty.js`.
- `test/` — regression suite (G6 / AC-4).

## Acceptance Criteria

- **AC-1 (crash fixed, real path).** A ticket whose refined `verification` is `{ commands: [{command,expect}] }`
  normalizes to the real `string[]` and runs — no `…map is not a function` at `prompts.js:83` **and** no
  silent `npm test` at `spawn-morty.js:382`. Verified through the executor, not just the prompt builder.
- **AC-1b (array-of-objects).** `verification: [{command}]` runs the real command — never `[object Object]`.
- **AC-2 (single chokepoint, all consumers).** Exactly one `normalizeVerificationCommands` exists; all three
  old helpers are gone; `prompts.js`, `spawn-morty.js`, `status.js`, and the `tickets.js` validators all read
  `verification` as `string[]`.
- **AC-3 (read-path coverage).** A refiner-written or hand-edited or resumed manifest with object-shaped
  `verification` is normalized on load — the executor never sees the raw object.
- **AC-4 (fail-fast, every path).** A `verification` that cannot normalize to a non-empty `string[]` fails with
  a clear `ticket <id>` message before any worker spawns — on refinement **and** fallback **and** resume.
- **AC-5 (regression test).** Tests cover `string[]`, `string` (with `&&`), `{commands:[{command}]}`,
  `{commands:["cmd"]}`, `[{command}]`, `verify` alias, empty/garbage → default.
- **AC-6 (scoped verification).** For a vitest package, the emitted/normalized command runs only the targeted
  file (D3a), proven not to run the whole suite.
- **AC-7 (baseline).** A test already failing on the base commit does not fail an unrelated ticket's gate at
  `spawn-morty.js:401`; a new red introduced by the ticket still fails it.
- **AC-8 (no behavior regression).** `hasOnlyGenericVerification` and env-inference behave identically to
  v0.2.15 for all non-object inputs after the helper collapse (D1a default locked + tested).

## Simplification Review (subtract-before-add)

- Core is **subtraction**: collapse **three** divergent helpers + scattered raw indexing into ONE normalizer
  at ONE read chokepoint. −3 helpers, −1 raw `.map` crash site, −1 silent-`npm test` mis-default, −1
  `[object Object]` execution path. The manifest field becomes a single normalized shape on every read.

## Appendix — adjacent defects surfaced by the review (triage)

Pulled into this fix plan (cheap, gate-adjacent):
- **`lib/tickets.js:93` (Codex #5)** — `dependencyField !== 'none'` is case-sensitive and the array branch
  (`:88`) never filters a `["none"]` entry → a valid ticket can be left permanently unrunnable. Normalize
  `none` case-insensitively in both branches. *(in scope — directly gates runnability)*
- **`lib/verification-env.js:163` (Codex #6)** — the env regex captures `VAR` from `${VAR:-fallback}`,
  marking a shell-defaulted var as required → false preflight failure before verification runs. Treat
  `:-`/`:=`/`:?`/`-` default-expansion as not-required. *(in scope — false-blocks the gate)*
- **`lib/pipeline-state.js:268` (Codex #7)** — omitting `exitReason` yields `phase_status=FAILED` but
  `last_exit_reason='success'` (contradictory state). Default both from one source. *(in scope — touches D4
  files; cheap)*

Deferred — file separately, do NOT block this P1:
- **`lib/tickets.js:768` (Codex #2)** — title-fallback ticket id used as both dir name and artifact key →
  identically-titled tickets overwrite each other / drop from the runnable set. Real P1 but a distinct
  id-materialization concern; separate ticket.
- **`lib/tickets.js:911` (Codex #8)** — `null` written into frontmatter persists as literal `"null"` →
  status parser misreads a cleared `failure_reason`. P3 cosmetic; separate ticket.
- **`bin/loop-runner.js:206` (deep-audit)** — `summary.verification.length` on a non-array loop summary →
  `'- n/a'`. Out of the ticket path; low priority.

## Repro / Evidence

- Session: `~/.codex/pickle-rick/sessions/2026-06-24-e1639f60`; `pipeline-runner.log` shows both field failures.
- This fix plan reviewed 2026-06-24 via `/ll:pr-review` (Claude deep-audit) + independent Codex adversarial
  pass, both seeded with `prds/p1-harden-ticket-verification-loa-1568.md` and pointed at the verification path.
