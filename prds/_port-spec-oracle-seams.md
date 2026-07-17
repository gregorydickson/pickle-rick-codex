# Porting Spec — Oracle + Safety Seams (pickle-rick-claude → pickle-rick-codex)

**Status:** READ-ONLY analysis. This document is the implementation contract for worker engineers. It quotes reference signatures verbatim and maps each mechanism onto the concrete codex surface.

**Reference repo (port FROM):** `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`
**Target repo (port INTO):** `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-codex`

**Orientation read:** `prds/_audit-phase01-gap.md` (items 2/11 = Mechanism 1, item 3 = Mechanism 2, item 5 = Mechanism 3).

---

## ⚠️ Cross-cutting helper-API divergence (read before porting Mechanism 1)

The claude oracle's private helpers operate on the **ticket file *content* string**. Codex's same-named helpers operate on **file paths / (sessionDir, ticketId) tuples** and some **write directly** instead of returning a string. This is the single biggest porting hazard. Verbatim divergence table:

| Helper | Claude signature (content-based) | Codex signature (path-based) |
|---|---|---|
| `readFrontmatterField` | `readFrontmatterField(content: string, field: string): string \| null` | `readFrontmatterField(ticketFilePath: string, field: string): string \| null` |
| `upsertFrontmatterField` | `upsertFrontmatterField(content, field, value): string \| null` (returns new content) | `upsertFrontmatterField(ticketFilePath, field, value): void` (writes file) |
| `readDeclaredFiles` | `readDeclaredFiles(content: string): string[]` | `readDeclaredFiles(sessionDir: string, ticketId: string): string[]` |
| `ticketFilePath` | `ticketFilePath(sessionDir, ticketId): string` (exists) | **absent** — use `getTicketById(sessionDir, ticketId).filePath` or derive path |
| `normalizeCompletionCommitField` | content-agnostic, identical | identical (`pickle-utils.ts:207`) |

**Implication:** the ported oracle CANNOT copy claude's `readEvidence` body verbatim. Every `readFrontmatterField(content, …)` / `readDeclaredFiles(content)` / `upsertFrontmatterField(content, …)` call inside the claude module must be re-expressed against codex's path/id-based API. Two equally-valid strategies (pick ONE and keep it consistent):
- **(A) Adapter shim in the oracle:** read the ticket content once (`fs.readFileSync`), then port claude's private content-based helpers *inline* into the oracle (they are already `function`-scoped in claude: `resolveTicketPath`, `readFirstHeading`, `extractRCodeTokens`, etc.). For `completion_commit`/`id`/`title`/`r_code` frontmatter reads, use a small local content-based reader (copy claude's `readFrontmatterFieldFromContent` — note codex already has a private `readFrontmatterFieldFromContent` in `pickle-utils.ts` but it is NOT exported).
- **(B) Call codex's path-based exports:** pass `ticketFilePath` into `readFrontmatterField(ticketFilePath, field)` and `readDeclaredFiles(sessionDir, ticketId)`; for the promote-once write use codex's void `upsertFrontmatterField(ticketFilePath, 'completion_commit', sha)` directly (no re-read-and-return).

Strategy (B) is lower-risk (reuses tested codex helpers) but requires the oracle to always resolve a concrete `ticketFilePath` + `(sessionDir, ticketId)`; the sibling-declared-files walk (`enumerateSiblingDeclaredFiles`) then calls `readDeclaredFiles(sessionDir, siblingId)` per sibling instead of parsing content. Recommend **(B)**.

---

# Mechanism 1 — Completion-Evidence Oracle (HIGHEST PRIORITY)

Reference: `pickle-rick-claude/extension/src/services/ticket-completion-evidence.ts` (the sole completion oracle; `hasCompletionCommit` was deleted).

## Reference API (quoted signatures)

Public types:
```ts
export type EvidenceKind = 'committed' | 'absent';
export type EvidenceVia = 'explicit' | 'inferred' | 'scan';
export type EvidenceAbsentReason =
  | 'no_evidence'
  | 'baseline_sha'
  | 'unreachable_explicit_unattributable'
  | 'foreign_attribution';

export interface EvidenceResult {
  kind: EvidenceKind;
  sha?: string;
  via?: EvidenceVia;
  absentReason?: EvidenceAbsentReason;
  usedFallback?: boolean;
}

export interface EvidenceCtx {
  sessionDir?: string;
  ticketId?: string;
  ticketPath?: string;
  workingDir: string;
  startTimeEpoch?: number | null;
  fallbackDir?: string;
  startCommit?: string | null;
  pinnedSha?: string | null;
  ownAttributionTokens?: string[];
  greenGate?: () => GateVerdict;
}

export interface PersistOpts { stage: 'best-effort' | 'required'; }
export interface PersistResult { action: 'written' | 'already_present' | 'no_file' | 'unwritable'; sha?: string; staged?: boolean; }
export interface RevertPolicy { flags?: Record<string, unknown> | null; }
export type RevertDecision = { action: 'keep' | 'revert'; kind: EvidenceKind; sha?: string; fallbackFired?: boolean; };

export type CompletionDecisionKind = 'done-flip' | 'phantom-watch' | 'attribution';

export interface CompletionDecisionCtx extends EvidenceCtx {
  startCommit: string | null;   // REQUIRED (nullable but explicit)
  pinnedSha: string | null;     // REQUIRED (nullable but explicit)
  decision: CompletionDecisionKind;
  workerGateVerdict?: () => { verdict: 'green' | 'red' | 'absent'; computedVia: string };
  announcedSha?: () => string | null;
  rereadBackoffMs?: number;
}

export type CompletionDecisionRefusalReason =
  | EvidenceAbsentReason | 'worker_gate_red' | 'worker_gate_unavailable';

export type CompletionDecision =
  | { ok: true; sha: string; via: EvidenceVia | 'announcement'; usedFallback?: boolean }
  | { ok: false; reason: CompletionDecisionRefusalReason; gate?: { verdict: 'green' | 'red' | 'absent'; computedVia: string } };
```

Public entry points (4):
```ts
export function readEvidence(ctx: EvidenceCtx): EvidenceResult;
export function persistEvidence(ctx: EvidenceCtx, sha: string, opts: PersistOpts): PersistResult;
export function evaluateCompletionEvidence(ctx: CompletionDecisionCtx): CompletionDecision;   // the ONE predicate
export function gateForPhantomDoneRevert(ctx: EvidenceCtx, _policy?: RevertPolicy): RevertDecision;
```

`GateVerdict` is imported in claude from `../lib/salvage-ticket.js` (`'passing' | 'red'-ish` verdict enum). Codex has **no `salvage-ticket.ts` / `GateVerdict`** — see "Codex helpers missing".

## Behavior / ladder

### `readEvidence` decision ladder (exact order, from the module body):
1. **Resolve ticket path** (`resolveTicketPath`): `ticketPath` overrides, else `sessionDir + ticketId → ticketFilePath`. No path → `{ kind: 'absent' }`. Unreadable file → `{ kind: 'absent' }`.
2. **Explicit `completion_commit` field** (`normalizeCompletionCommitField(readFrontmatterField(content,'completion_commit'))`):
   - **Baseline short-circuit (R-CXOR-2):** if SHA equals `ctx.startCommit` or `ctx.pinnedSha` → **hard-absent** `{ kind:'absent', absentReason:'baseline_sha' }` (stderr warn). No fallback.
   - Probe reachability (`probeExplicitSha` → `git cat-file -e <sha>^{commit}`, with `fallbackDir` retry on `git-could-not-run`).
   - If reachable AND **foreign-attributed (R-OMA)** (`isForeignAttributedExplicitSha`: commit message word-boundary-matches a *sibling* ticket id but NOT own id/r_code/ownAttributionTokens) → **hard-absent** `{ absentReason:'foreign_attribution' }`. No fallback.
   - If reachable and not foreign → `{ kind:'committed', sha, via:'explicit' }` (**explicit-reachable-wins**).
   - If **unreachable (R-AICF):** DO NOT hard-return. Set `unreachableExplicit = true` and **fall through** to inferred/scan (a hallucinated/dropped stamp must not bury real untagged work). The eventual absent reason becomes `unreachable_explicit_unattributable`.
3. **Inferred field `completion_commit_inferred`:** if present and `commitExists(workingDir, sha)` → `{ kind:'committed', sha, via:'inferred' }`. If present but not git-verifiable → **short-circuit absent** (R-AFCC-STAGE; the scan would fail identically).
4. **Git-log scan** (`scanGitLog`), two passes:
   - **Pass 1 (ref-token):** `git log -n 20 -- <ticketPath>` then `git log -n 50 HEAD`, format `%H%n%ct%n%B%n---pickle-commit-boundary---`. Word-boundary match of lowercased ticket-id + r_code tokens against commit message, filtered by `startTimeEpoch`. First hit wins → `via:'scan'`.
   - **Pass 2 (R-CECB declared-file-touch):** only when ticket declares files. A post-`startTimeEpoch` commit attributes iff it touches ≥1 declared file (`git show --name-only`), is NOT ambiguous (no sibling ticket also declares a touched file), AND `greenGate() === 'passing'`. Newest green wins.
5. No match → `{ kind:'absent', absentReason: unreachableExplicit ? 'unreachable_explicit_unattributable' : 'no_evidence' }`.

### `evaluateCompletionEvidence` predicate ladder (the ONE seam):
1. `readEvidence`. If not accepted (committed+sha):
2. **R-CCGR single backoff re-read:** `sleepSyncMs(rereadBackoffMs ?? defaultRereadBackoffMs())` (env `PICKLE_GUARD_REREAD_BACKOFF_MS`, clamp ≤5000, default 500; via `Atomics.wait`), then `readEvidence` again.
3. **R-CCEM announcement recovery:** if still absent and `announcedSha()` returns a SHA → persist it as `completion_commit_inferred` and re-probe; on accept `via='announcement'`.
4. If still not accepted → `refuseAbsent(evidence)` (`{ ok:false, reason: absentReason ?? 'no_evidence' }`).
5. **R-WUWC promote-once:** `persistEvidence(ctx, sha, {stage:'best-effort'})` writes the accepted SHA into explicit `completion_commit` (no-op if already present) + re-probe. Best-effort.
6. **R-CWGE worker-gate verdict (done-flip ONLY):** if `decision==='done-flip'`, require `workerGateVerdict().verdict === 'green'`; red → `worker_gate_red`; absent/throwing/un-injected → `worker_gate_unavailable`. `phantom-watch` and `attribution` **never** consult the verdict (R-DSAN never-discard).
7. Accept → `{ ok:true, sha, via, usedFallback }`.

`gateForPhantomDoneRevert` is a **thin adapter**: `evaluateCompletionEvidence({...ctx, startCommit:ctx.startCommit??null, pinnedSha:ctx.pinnedSha??null, decision:'phantom-watch', rereadBackoffMs:0})`; ok → `{action:'keep',...}`, else `{action:'revert', kind:'absent'}`.

### Pointer-write fold (R-WDTF)
Claude guarantees the `completion_commit` pointer via the promote-once step (5) *inside the predicate* — the SHA is written into the durable explicit field at the moment evidence is accepted, so a subsequent Done→re-flip status rewrite cannot "erase" it (the field already exists and `updateTicketStatus` only rewrites the `status:` line). Codex today writes the stamp in a *separate* `stampCompletionCommit()` call after `finalizeSuccess()` flips Done — see reroute below to fold it into the oracle.

## Single-seam invariant (how claude enforces it)

- **`readEvidence(<arg>)` callsites outside the oracle module MUST be 0.** Every decision site routes through `evaluateCompletionEvidence` (or its `gateForPhantomDoneRevert` adapter).
- **`evaluateCompletionEvidence(` callsites pinned EXACTLY:** 6 in `mux-runner.ts` (all via a local `buildCompletionCtx`) + 1 in `auto-fill-completion-commit.ts`. Importer set of the oracle == exactly `{mux-runner.ts, auto-fill-completion-commit.ts}` (R-AFCC-CALLER-ENUMERATION).
- **`scripts/check-no-inferred-completion-flag.sh`** (quoted intent): scans `$PICKLE_DATA_ROOT/sessions/*/state.json`; exits 2 if any `active===true` session persists `state.flags.allow_inferred_completion_commit === true` (pre-deploy live-state guard for the deleted flag). It greps for the JSON flag `allow_inferred_completion_commit`.
- **`scripts/audit-phantom-done-call-sites.sh`** (quoted intent): parses `src/bin/mux-runner.ts` function bodies and asserts:
  - `correctPhantomDoneTickets` calls `batchLoopPhantomDoneKind(` before `writeTicketStatus(...,'Todo')`.
  - `batchLoopPhantomDoneKind` contains `gateForPhantomDoneRevert(`, `return 'inferred';`, `return 'explicit-reachable';`.
  - `validateAutoTicketCompletion` calls `evaluateCompletionEvidence(` before its `no_commit_referencing_ticket` skip-return, and contains `!decision.ok`.
  - `inspectPhantomDoneTicketFile` delegates to `applyInspectPhantomDoneDecision(`.
  - `applyInspectPhantomDoneDecision` calls `gateForPhantomDoneRevert(` before `writeTicketStatus(`.
- The `completion-predicate-single-seam.test.js` PIN block mirrors the pins (see Tests).

## Codex reality mapping

Codex has **no phantom-done watcher, no `auto-fill-completion-commit.ts`, no worker-gate verdict, no `correctPhantomDoneTickets`/`validateAutoTicketCompletion`/`batchLoopPhantomDoneKind`**. Codex's ONLY completion decision surface is:
- `extension/src/bin/spawn-morty.ts`: `finalizeSuccess(applied)` (flips `updateTicketStatus(...'Done')` unconditionally after verification passes), `resolveCompletionCommitSha(...)`, `stampCompletionCommit(sessionDir, ticketId, sha)`.
- `extension/src/bin/mux-runner.ts`: `runSequential(...)` marks `ticket.status = 'Done'` **in memory** purely on `runTicket` non-throw (line ~136). This is an in-memory bookkeeping flip, not a disk status write; the disk write already happened in `finalizeSuccess`.

### Codex functions to create
1. **New file `extension/src/services/ticket-completion-evidence.ts`** exporting the 4 entry points + types above, adapted to codex's path/id-based helpers (Strategy B). Two-state `EvidenceKind` collapse retained.
2. In `spawn-morty.ts`, a **local `buildCompletionCtx(...)`** builder producing a `CompletionDecisionCtx` (mirror claude's mux-runner pattern) — must set `startCommit`/`pinnedSha` explicitly (codex has neither concept yet → pass `null` for both; keep the compile-time-required fields so the R-CXOR-2 baseline pin is not silently omitted). `workerGateVerdict` is **un-injected** in codex (no worker gate) → a `done-flip` decision would fail-closed as `worker_gate_unavailable`. **Therefore the codex done-flip site must use `decision:'attribution'` (or `'phantom-watch'`) — NOT `'done-flip'`** unless/until a worker gate exists. Document this explicitly: porting the R-CWGE verdict rung is out of scope (no worker gate subsystem in codex per audit items 7/9); the oracle ships with the rung present but codex never selects `'done-flip'`.

### Codex decision sites to reroute
- **`spawn-morty.ts` completion tail (the block that currently calls `resolveCompletionCommitSha` → `finalizeSuccess` → `stampCompletionCommit`):** route the pointer decision through `evaluateCompletionEvidence({ sessionDir, ticketId, workingDir, startCommit:null, pinnedSha:null, decision:'attribution' })`. On `ok:true`, the oracle's promote-once already stamped `completion_commit`; `stampCompletionCommit` becomes redundant (or a thin wrapper over `persistEvidence`). Fold the pointer write into the oracle so R-WDTF is guaranteed, not order-dependent. Keep `resolveCompletionCommitSha` as the SHA *resolver* feeding the oracle's explicit-field write (or feed via `announcedSha`).
- Keep `readEvidence` callsites = 0 outside the new module. `spawn-morty.ts` and (optionally) `mux-runner.ts` become the ONLY importers → the codex analog of the R-AFCC-CALLER-ENUMERATION pin is `{spawn-morty.ts}` (+ `mux-runner.ts` if the in-memory Done mark is also gated).

### Codex helpers to reuse (already present)
- `git-utils.ts`: `commitExists` (`cat-file -e ^{commit}`, `git-utils.ts:40`), `readCommitTrailer` (`:70`), `amendCommitTrailer` (`:78`), `countCommitsSince` (`:54`), `isIndexClean` (`:61`), `getHeadSha` (`:36`).
- `pickle-utils.ts`: `readFrontmatterField(path, field)` (`:193`), `upsertFrontmatterField(path, field, value)` (`:199`, void/writes), `normalizeCompletionCommitField` (`:207`), `readTextFile`, `readJsonFile`.
- `ticket-declared-files.ts`: `readDeclaredFiles(sessionDir, ticketId)` (`:90`).
- `tickets.ts`: `getTicketById(sessionDir, ticketId)` (`:888`, exposes `.filePath`), `updateTicketStatus` (`:980`, regex-replaces only the `status:` line — preserves unknown frontmatter keys, which is why R-WDTF holds by ordering today).

### Codex helpers missing (MUST add)
- **`GateVerdict` type + greenness oracle.** No `salvage-ticket.ts` in codex. Port a minimal `GateVerdict = 'passing' | 'red' | 'errored'` (or inline the two-state union the oracle needs) so `EvidenceCtx.greenGate` typechecks. The R-CECB declared-file-touch pass can be shipped but is inert unless a `greenGate` is injected; codex has no `runBetweenTicketFastTests` equivalent → default `() => 'errored'` (conservative not-green), matching claude's default.
- **Git-log scan helper.** Codex `git-utils.ts` has no `git log --format=%H%n%ct%n%B` scan. Port `parseGitLog` + the `execFileSync('git', ['-C', dir, 'log', ...])` calls **inside the oracle** (claude keeps them module-private — do the same; do not add to `git-utils.ts` unless a second consumer appears).
- **`commitTouchedFiles` (`git show --name-only`) and `commitMessage` (`git show -s --format=%B`)** — module-private in claude; port inline.
- **`sessionDir` sibling enumeration** (`enumerateSiblingTicketIds`, `enumerateSiblingDeclaredFiles`) — port inline; for declared files call codex `readDeclaredFiles(sessionDir, siblingId)` per sibling (NOT content-based).
- **`ticketFilePath(sessionDir, ticketId)`** — absent in codex; either add a tiny helper or resolve via `getTicketById(...).filePath`.
- **`sleepSyncMs` / `Atomics.wait` backoff + `defaultRereadBackoffMs`** — port inline.
- **Reachability with 3-way `probeCatFile`** (`exists` / `not-exists` / `git-could-not-run`) — codex `commitExists` collapses error+not-found to `false`. The oracle needs the 3-way distinction for the `fallbackDir` retry (`R-CCR-1`). Port claude's `probeCatFile` inline (do not reuse codex's boolean `commitExists` for the explicit-SHA branch).

### Tests to mirror (names + what they assert)
- **`ticket-completion-evidence-predicate.test.js`** (`@tier: fast`): R-AICF unreachable-explicit → scan fallback attributes real declared-file commit; unreachable + no attributable commit → `absent/unreachable_explicit_unattributable`; baseline SHA → hard `absent/baseline_sha` even with an attributable commit; foreign-attributed SHA → hard `absent/foreign_attribution`; done-flip GREEN verdict → `ok:true via:'explicit'`; RED → `worker_gate_red`; ABSENT → `worker_gate_unavailable`; NO injected verdict → `worker_gate_unavailable`; phantom-watch/attribution NEVER consult verdict; announcement recovery persists `completion_commit_inferred` + `via:'announcement'` + promote-once stamps `completion_commit`; scan-attributed evidence promoted-once (via stays `scan`); no evidence → `no_evidence`; baseline-stamped → `baseline_sha`; `gateForPhantomDoneRevert` keeps hallucinated-stamp ticket whose real work is scan-attributable, reverts when no usable evidence. **Codex adaptation:** drop/adjust the 4 `done-flip` worker-gate cases (codex has no verdict; assert `worker_gate_unavailable` on `done-flip` and use `attribution`/`phantom-watch` for the accept cases).
- **`has-completion-commit-explicit-source.test.js`** (`@tier: fast`): R-AICF quoted/unquoted × full/short unreachable SHA all fall through to scan and attribute the real `fix(<ticketId>)` commit; `normalizeCompletionCommitField` normalizes quoted/unquoted full/short → plain hex.
- **`completion-predicate-single-seam.test.js`** (`@tier: fast`): PIN-1 zero `readEvidence(<arg>)` callsites outside the oracle (regex `/\breadEvidence\(\s*[^)\s]/`, spares zero-arg prose); PIN-2 `evaluateCompletionEvidence(` exact counts per decision file; PIN-3 importer set is exactly the codex pinned set; PIN-4/5 the codex done-decision function body routes through `evaluateCompletionEvidence(` with no bare `.length > 0` field-presence accept; FAIL-INJECTION regex self-test. **Codex adaptation:** retarget PIN-2/3/4/5 to codex's actual decision function (`finalizeSuccess`/completion tail in `spawn-morty.ts`) and the codex importer set.
- **New codex-only regression (R-WDTF, audit item 8):** assert `completion_commit` survives a `Done → re-flip` status-rewrite cycle (currently no test pins this invariant).

---

# Mechanism 2 — dirty-tree-salvage seam

Reference: `pickle-rick-claude/extension/src/services/dirty-tree-salvage.ts` + `git-utils.listWorkingTreeDirtyPaths`.

**Codex consumer status:** codex has **no microverse auto-rescue / mux exit-path committer**. Per the task, port as a **standalone, unit-tested module + the `git-utils.listWorkingTreeDirtyPaths` helper. NO consumer wiring is required** (and the callsite-count pins that assume `mux-runner.ts`/`microverse-runner.ts` callers do NOT apply until those subsystems land).

## Reference API (quoted signatures)
```ts
export function stashUnattributableRemainder(workingDir: string, sessionDir: string, log: (msg: string) => void): string | null;

export interface SalvageDirtyTreeInput {
  workingDir: string;
  sessionDir: string;
  owned: readonly string[];
  foreign: readonly string[];
  log: (msg: string) => void;
}
export interface SalvageDirtyTreePlan {
  stagePaths: string[];
  salvageRef: string | null;
}
export function salvageDirtyTree(input: SalvageDirtyTreeInput): SalvageDirtyTreePlan;
export function stageOwnedPaths(workingDir: string, paths: readonly string[]): void;
```
Dependency (`git-utils.ts`):
```ts
export function listWorkingTreeDirtyPaths(cwd: string, excludePrefixes?: string[]): string[];
```

## Behavior (bystander-stash semantics)
- **`stashUnattributableRemainder`:** snapshots the WHOLE dirty tree (tracked mods + untracked) into a dangling commit using a **throwaway `GIT_INDEX_FILE`** (temp path, `process.pid`+`Date.now()`), so neither the real index nor the worktree is mutated. Steps: `read-tree HEAD` (temp env) → `add -A` (temp env) → `write-tree` → if `write-tree` equals `HEAD^{tree}` return null (nothing to anchor) → `commit-tree <tree> -p HEAD -m "pickle exit-path bystander salvage (<session>)"` → `update-ref refs/pickle/salvage/<basename(sessionDir)> <sha>`. Best-effort: any git failure or clean tree → `null`. Temp index removed in `finally`.
- **`salvageDirtyTree`:** if `foreign.length > 0` → call `stashUnattributableRemainder` (anchor the whole dirty tree recoverably) and return `{ stagePaths:[...owned], salvageRef }`; a foreign-free tree passes through untouched (`salvageRef:null`). Invariant: **only the `owned` set is ever stageable**; NO whole-tree `git add -A`/`-u` exists outside the throwaway-index stash.
- **`stageOwnedPaths`:** per-path `execFileSync('git', ['add','--',p], {cwd})` (never whole-tree). Handles new/modified/deleted; rename caveat: `listWorkingTreeDirtyPaths` surfaces only the NEW path of a rename.

**`listWorkingTreeDirtyPaths`:** `git status --porcelain -z` (+ optional `-- . :!<prefix> :!<prefix>/**` excludes via `statusArgs`/`normalizeExcludePrefixes`); parses `\0`-delimited tokens, `token.slice(3)` for path, skips the rename/copy second token (status `R`/`C` in either column); returns de-duped, `localeCompare`-sorted paths. Throws on non-zero git exit.

## Codex functions to create
- **New file `extension/src/services/dirty-tree-salvage.ts`** with the 3 exports above (port verbatim; claude's only non-node import is `safeErrorMessage` from `pickle-utils.ts` — codex has a local `safeErrorMessage` in `spawn-morty.ts` but NOT exported from `pickle-utils.ts`; add/port a `safeErrorMessage` to codex `pickle-utils.ts` or inline it).
- **Add `listWorkingTreeDirtyPaths(cwd, excludePrefixes?)` + `statusArgs`/`normalizeExcludePrefixes` to codex `git-utils.ts`** (codex `git-utils.ts` currently has `getWorkingTreeStatus`/`isWorkingTreeDirty` but no `-z` porcelain path-list parser).

## Codex decision sites to reroute
- **None.** No consumer exists; module ships standalone.

## Codex helpers to reuse
- `git-utils.ts` `runGit`/`execFileSync` patterns for the porcelain call. (The salvage module itself uses raw `spawnSync`/`execFileSync` in claude — port as-is.)

## Codex helpers missing (must add)
- `git-utils.listWorkingTreeDirtyPaths` (+ its two private arg builders).
- A `safeErrorMessage` importable by the salvage module (port from claude `pickle-utils.ts` or reuse spawn-morty's, but export it).

## Tests to mirror (names + what they assert)
- **`services/dirty-tree-salvage.test.js`** (`@tier: integration`): clean tree → `null`, no ref created; dirty tree → anchors tracked+untracked into `refs/pickle/salvage/<session>` while worktree AND real index stay byte-identical; `salvageDirtyTree` foreign>0 → ref anchored + `stagePaths===owned` + foreign recoverable from ref; foreign=0 → `salvageRef:null`, no ref, owned passes through; `stageOwnedPaths` stages a DELETED tracked file (`D\t`) + a listed new file (`A\t`) and leaves unlisted dirty paths untracked.
- **`dirty-tree-salvage-callsites.test.js`** — **DO NOT PORT AS-IS.** It pins consumer callsite counts (`salvageDirtyTree == 2`, `stashUnattributableRemainder in mux-runner == 2`, `AUTO_COMMIT_DIRT_EXCLUDES`, `stageAutoCommitPaths` deleted) that assume the microverse/mux consumers exist. Port only the **`add -A` containment** assertion adapted to the standalone module: the service contains exactly ONE `'add', '-A'` (inside the throwaway-index stash) and uses `GIT_INDEX_FILE`. Re-introduce the full callsite pins when the consumers land.
- **Add a codex `listWorkingTreeDirtyPaths` unit test** (`@tier: fast`): porcelain parse of new/modified/deleted, rename second-token skip, exclude-prefix filtering, throw on git error — mirror the shape in claude's `git-utils.test.js`.

---

# Mechanism 3 — isForeignTmuxSession ownership guard

Reference: `pickle-rick-claude/extension/src/services/pickle-utils.ts` — `sessionHashOf` (~line 2064) and `isForeignTmuxSession` (~line 2083).

## Reference API (quoted signatures)
```ts
/** Trailing `-`-delimited segment: the session hash both names are keyed by. */
function sessionHashOf(name: string): string {
  return name.slice(name.lastIndexOf('-') + 1);
}

function isForeignTmuxSession(sessionName: string, sessionDir: string): boolean {
  return sessionHashOf(sessionName) !== sessionHashOf(path.basename(sessionDir));
}
```
Both are **module-private** in claude (not exported). Consumers call `isForeignTmuxSession(sessionName, sessionDir)` before mutating.

## Behavior (ownership comparison + fail-CLOSED rule)
- `#S` (ambient `tmux display-message -p #S`) answers "which tmux session is this PROCESS in", not "which session do we manage". Launchers name the tmux session `<prefix>-<session-hash>` for the dir they manage. Ownership = the trailing `-`-delimited hash of the ambient name **equals** the trailing hash of `path.basename(sessionDir)`.
- **Fail CLOSED:** any ambient name whose trailing hash it cannot tie to our own session-dir hash is treated as **foreign** → the caller must NOT mutate (skip). It MUST NOT resolve the name against `getDataRoot()/sessions` (that falls OPEN for a sandboxed `PICKLE_DATA_ROOT`).
- In claude, ALL THREE ambient-`#S` mutation resolvers gate on it BEFORE acting: `restartDeadWatcherPanes` (before any `send-keys`/`split-window`), `ensureMonitorWindow` (before `kill-window`/`new-window`), `respawnMonitorWindowForMode` (before `respawn-pane -k`).

## Codex reality mapping
Codex `extension/src/services/tmux.ts` has ONLY `ensureTmuxAvailable`, `tmuxSessionExists`, `clearTmuxSession`, `runTmux`, `waitForTmuxRunnerStart`. There is **no ambient-`#S` resolver, no monitor-window/watcher-pane respawn subsystem** (grep confirms zero `display-message`/`send-keys`/`kill-window`/`respawn-pane` in `extension/src/services` or `bin` except the bootstrap launchers).

**Every existing codex tmux MUTATION site** (from grep across `extension/src`):
- `services/tmux.ts:44` — `clearTmuxSession` → `runTmux(['kill-session','-t', sessionName])`.
- `services/detached-launch.ts:371,373,394,395,409` — `new-session`, `rename-window`, `set-option`, `respawn-pane -k`, `kill-session` (session **bootstrap**, using an explicitly-constructed `sessionName`, not an ambient `#S`).
- `bin/pickle-tmux.ts:189,191,211,212,225` — same bootstrap sequence.
- `bin/pickle-pipeline.ts:287,289,309,310,323` — same bootstrap sequence.
- `scripts/tmux-monitor.sh` — shell monitor pane builder (new-window/split-window/send-keys), invoked with an explicit `$NAME`, not ambient `#S`.

**Critical distinction:** none of these codex sites resolve their target from an **ambient `#S`**; they all pass a `sessionName` they constructed for the session they own. `isForeignTmuxSession` guards the *ambient-resolution* hazard (a runner inheriting `$TMUX` from a stranger's window). **That hazard does not exist in codex yet** — there is no destructive ambient-`#S` surface for the guard to protect.

**Therefore the only safe/meaningful insertion point today is:**
1. Add `isForeignTmuxSession(sessionName, sessionDir)` + `sessionHashOf(name)` to codex (recommended home: `tmux.ts`, exported so it is unit-testable; or `pickle-utils.ts` to mirror claude). Fail-CLOSED body verbatim.
2. Optionally add a **defensive check in `tmux.ts` mutation helpers** that already receive a `sessionName` derived from an ambient source — but since codex's current mutators receive an owner-constructed name, wiring the guard there would be inert (name always self-consistent). Document that the guard is a **prerequisite that must be called before any FUTURE ambient-`#S`-resolved mutation** (monitor-respawn subsystem port), not retrofitted into the current bootstrap mutators.

State clearly in the PR: **codex ports the guard function + its unit tests as a standing safety primitive; there is no live ambient-`#S` mutation to route through it until the monitor-respawn subsystem is ported.**

## Codex functions to create
- `sessionHashOf(name: string): string` and `isForeignTmuxSession(sessionName: string, sessionDir: string): boolean` (export both from `tmux.ts` for testability).

## Codex decision sites to reroute
- **None live today.** (Future: any ambient-`#S`-resolved `send-keys`/`kill-window`/`respawn-pane` must call `isForeignTmuxSession` first and skip when true.)

## Codex helpers to reuse
- `path.basename`, existing `runTmux`/`spawnSync` for reading `#S` when a future consumer needs it.

## Codex helpers missing (must add)
- The two functions above. No other dependency.

## Tests to mirror (names + what they assert)
- **`restart-dead-watcher-panes-sessiondir-validation.test.js`** — the claude file bundles `validateSessionDirOrSkip`, `restartDeadWatcherPanes`, `ensureMonitorWindow`, and `respawnMonitorWindowForMode` cases; **those consumers do not exist in codex**, so port ONLY the **ownership-guard cases** as a focused new test (e.g. `is-foreign-tmux-session.test.js`, `@tier: fast`):
  - ambient tmux session owned by ANOTHER session (hash mismatch) → `isForeignTmuxSession` returns `true` (foreign).
  - ambient session hash == `basename(sessionDir)` hash → returns `false` (ours).
  - ambient name carrying no hash of ours (`pickle-dead` vs `...-86dd509f`) → `true` (fail CLOSED).
  - fixture invariant: pair a session dir whose trailing hash matches the tmux name the fake `#S` advertises (`pipeline-<hash>` for dir `<...>-<hash>`); a fixture pairing `session` with `pickle-abc12345` exercises an impossible layout — avoid it.
- Do **not** port the `validateSessionDirOrSkip`/`ensureMonitorWindow`/`respawnMonitorWindowForMode` cases until those subsystems exist.

---

## Appendix — reference trap-door text (verbatim anchors)

- **R-RIC-EXPLICIT / R-AICF** (`services/CLAUDE.md:40`): `readEvidence` MUST honor an explicit reachable `completion_commit` BEFORE inferred/scan (`via:'explicit'`); an UNREACHABLE explicit SHA falls through to inferred/scan (`unreachable_explicit_unattributable`); ONLY `baseline_sha` (R-CXOR-2) and `foreign_attribution` (R-OMA) stay hard-absent short-circuits.
- **B-1SEAM WS-1 single seam** (`services/CLAUDE.md:42`): `evaluateCompletionEvidence` is the ONE predicate (ladder: readEvidence → R-CCGR backoff re-read → R-CCEM announcement → R-WUWC promote-once → R-CWGE verdict done-flip-only); `readEvidence(` callsites outside the module MUST be 0.
- **B-1SEAM WS-3 salvage** (`services/CLAUDE.md:46`): `salvageDirtyTree` anchors foreign remainder via `stashUnattributableRemainder` (throwaway `GIT_INDEX_FILE`), returns only owned as stageable; no whole-tree `add -A`/`-u` outside the throwaway-index stash.
- **tmux ownership** (`services/CLAUDE.md:18`): `isForeignTmuxSession` compares `sessionHashOf(sessionName)` vs `sessionHashOf(basename(sessionDir))`; NO `getDataRoot()`/`readdirSync` inside it; fail CLOSED.
