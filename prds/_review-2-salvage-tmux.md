# Adversarial Review #2 — dirty-tree-salvage + git-utils + tmux ownership guard

**Reviewer lens:** Mechanism 2 (dirty-tree-salvage), `git-utils.listWorkingTreeDirtyPaths`, Mechanism 3 (tmux ownership guard).
**Mode:** READ-ONLY. No code modified.
**Verdict:** Faithful port. **Zero CRITICAL/HIGH/MEDIUM correctness bugs found.** The ported seams are byte-for-byte behavior-equivalent to the reference; only cosmetic/intentional divergences noted below (all NIT/LOW, all sanctioned by the port spec).

Files scrutinized (target):
- `extension/src/services/dirty-tree-salvage.ts`
- `extension/src/services/git-utils.ts` (`listWorkingTreeDirtyPaths`/`statusArgs`/`normalizeExcludePrefixes`/`runGit`)
- `extension/src/services/tmux.ts` (`sessionHashOf`/`isForeignTmuxSession`)
- `extension/src/services/pickle-utils.ts` (`safeErrorMessage`)
- `extension/tests/dirty-tree-salvage.test.js`, `git-list-working-tree-dirty-paths.test.js`, `is-foreign-tmux-session.test.js`
Reference: `pickle-rick-claude/extension/src/services/{dirty-tree-salvage,git-utils,pickle-utils}.ts`.

---

## Findings table

| ID | Severity | file:line | Description | Reference behavior violated | Failure scenario | Suggested fix |
|----|----------|-----------|-------------|-----------------------------|------------------|---------------|
| F1 | NIT | `git-utils.ts:140` | `listWorkingTreeDirtyPaths` routes through shared `runGit` (execFileSync) instead of reference's inline `spawnSync`. On non-zero exit codex throws the raw `execFileSync` error (`Command failed: git status ...` from node) rather than the reference's hand-rolled `Command failed: git <args>\nError: <stderr>`. | None — reference contract is only "throw on non-zero git exit"; both throw. Message text differs. | An operator diffing thrown-error strings between repos sees different wording; no behavioral impact. | Optional: none. Parity is preserved (both throw; the codex test `throws when git exits non-zero (non-git dir)` pins it). |
| F2 | LOW/INFO | `git-utils.ts:115` | Codex's legacy `isWorkingTreeDirty(cwd)` still uses `getWorkingTreeStatus` (no `excludePrefixes` param), whereas reference's `isWorkingTreeDirty(cwd, excludePrefixes?)` now delegates to `listWorkingTreeDirtyPaths`. | Reference `isWorkingTreeDirty` signature/semantics. | A future codex consumer expecting exclude-aware dirtiness from `isWorkingTreeDirty` would get unfiltered results. | Explicitly **sanctioned by the port spec** ("codex `git-utils.ts` currently has `getWorkingTreeStatus`/`isWorkingTreeDirty` ... add `listWorkingTreeDirtyPaths`"). No action; document that dirtiness-with-excludes must call `listWorkingTreeDirtyPaths` directly. |
| F3 | NIT | `dirty-tree-salvage.ts:31-35` | Comment text trimmed vs reference (dropped `#b736337f`, `R-WSRC`, "parity with the pre-WS-3 scoped preflight"). | None — code identical. | None. | None. |

No other divergences. Every substantive line of the salvage module and the two guard functions is verbatim-identical to the reference.

---

## Point-by-point verification (what I checked and found CLEAN)

### Mechanism 2 — dirty-tree-salvage (`dirty-tree-salvage.ts`)

1. **Throwaway `GIT_INDEX_FILE` (hunt #1) — CLEAN.**
   - Temp index path built with pid+timestamp: `dirty-tree-salvage.ts:53` `path.join(os.tmpdir(), \`pickle-salvage-index-${process.pid}-${Date.now()}\`)` — verbatim to reference.
   - `env = { ...process.env, GIT_INDEX_FILE: tmpIndex }` and passed only when `useEnv` (`:54`, `:57`). The mutating steps (`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`) use `useEnv=true`; the read-only comparison (`rev-parse HEAD^{tree}`) and `update-ref` use `useEnv=false`. Correct.
   - Exact ladder present and ordered (`:62-72`): `read-tree HEAD` → `add -A` → `write-tree` → `if rev-parse HEAD^{tree} === tree return null` → `commit-tree <tree> -p HEAD -m "pickle exit-path bystander salvage (<session>)"` → `update-ref refs/pickle/salvage/<basename(sessionDir)>`.
   - Temp index removed in `finally` (`:80`) via `fs.rmSync(tmpIndex, { force: true })` inside a swallowing try. Correct.
   - **Containment: EXACTLY ONE `add -A` in the module** (`:63`), inside the throwaway-index stash. `stageOwnedPaths` uses per-path `['add','--',p]` (`:159`). No `add -u` anywhere. The integration test source-pin (`dirty-tree-salvage.test.js:186-207`) independently enforces `add -A` count === 1, `add -u` count === 0, and `GIT_INDEX_FILE` presence.
   - Worktree/real-index byte-identity is proven by the test (`dirty-tree-salvage.test.js` compares `status --porcelain` and `diff --cached` before/after) — passes on green baseline.

2. **`salvageDirtyTree` partition (hunt #2) — CLEAN.** `:130-138`: `foreign.length > 0` → `stashUnattributableRemainder(...)` then returns `{ stagePaths: [...owned], salvageRef }`; `foreign.length === 0` → skips stash, returns `{ stagePaths: [...owned], salvageRef: null }`. `stagePaths` is a fresh copy of `owned` in BOTH branches — **no path where foreign leaks into stageable**. Verbatim to reference.

3. **`stageOwnedPaths` (hunt #3) — CLEAN.** `:158-164`: per-path `execFileSync('git', ['add','--',p], {cwd})` with the `--` terminator present, so a path beginning with `-` cannot be parsed as a flag (no arg injection). Deleted + new handled by `git add` semantics; the test stages a deleted (`D`) and a new (`A`) file and confirms unlisted dirt stays untracked.

4. **Best-effort / no-throw-leak (hunt #4) — CLEAN.** Inner `git()` helper returns `null` on any non-zero status (`:58`); each step short-circuits to `return null`. Outer `try/catch` (`:76-79`) swallows any throw and returns `null` after logging via `safeErrorMessage`. Clean tree (`rev-parse HEAD^{tree} === tree`) → `null`. Matches reference exactly. `safeErrorMessage` (`pickle-utils.ts:10`) is `err instanceof Error ? err.message : String(err)` — identical to reference `pickle-utils.ts:105`, and is **exported** (import at `dirty-tree-salvage.ts:14` resolves).

### git-utils.listWorkingTreeDirtyPaths (hunt #5) — CLEAN

- `statusArgs` (`git-utils.ts:127`): `['status','--porcelain','-z']`, and when excludes present appends `'--','.'` then `:!<prefix>` and `:!<prefix>/**` per cleaned prefix. Verbatim to reference `:222`.
- `normalizeExcludePrefixes` (`:120`): strips leading `./` / `/` and trailing `/`, drops empties. Verbatim to reference `:215`.
- Parse loop (`:145-155`): `token.length < 4` guard, `token.slice(3)` for path, `status = token.slice(0,2)`, and **rename/copy second-token skip when `status[0]` or `status[1]` is `R`/`C`** (`index += 1`). This correctly handles the porcelain `-z` two-record rename (`<new>\0<orig>`): the new path is captured, the orig token is skipped — no off-by-one. Verbatim to reference `:246-256`.
- De-dupe + `localeCompare` sort: `[...new Set(paths)].sort((l,r)=>l.localeCompare(r))` (`:157`). Verbatim.
- **Throws on non-zero git exit:** `runGit(statusArgs(...), cwd, { trim:false, timeout:30_000 })` is called WITHOUT `allowFailure`, so `runGit` re-throws the `execFileSync` error on non-zero exit (`git-utils.ts:19-22`). Test `throws when git exits non-zero (non-git dir)` pins this. Matches the reference's explicit throw.
- Empty output → `[]` (`:143`), matching reference.

### Mechanism 3 — tmux ownership guard (hunt #6) — CLEAN

- `sessionHashOf` (`tmux.ts:18-19`): `name.slice(name.lastIndexOf('-') + 1)` — verbatim. No-hyphen returns whole string; empty returns empty (pinned by test).
- `isForeignTmuxSession` (`tmux.ts:35-36`): `sessionHashOf(sessionName) !== sessionHashOf(path.basename(sessionDir))` — verbatim.
- **Fails CLOSED:** any name whose trailing hash != our dir's trailing hash returns `true` (foreign). Test `fails CLOSED on an unrelated ambient name` (`pickle-dead` vs `...-86dd509f`) confirms.
- **Does NOT call `getDataRoot()`/`readdirSync`/`display-message`:** grep across `tmux.ts` shows the function body is pure string math; no data-root resolution, so it does not fall OPEN under a sandboxed `PICKLE_DATA_ROOT`.
- **Both exported** from `tmux.ts` (`export function sessionHashOf` / `export function isForeignTmuxSession`) for testability. (Reference kept them module-private; exporting is the sanctioned codex adaptation for unit tests.)

### Test-fixture sanity (hunt #7) — CLEAN

`is-foreign-tmux-session.test.js` fixtures are all coherent:
- Foreign: `pipeline-aaaaaaaa` vs `.../some-session-bbbbbbbb` → hashes `aaaaaaaa`≠`bbbbbbbb` → `true`. ✓
- Ours: `pipeline-86dd509f` vs `.../some-session-86dd509f` → hashes match → `false`. ✓
- Fail-closed: `pickle-dead` vs `.../some-session-86dd509f` → `dead`≠`86dd509f` → `true`. ✓
No impossible layout (e.g. dir `session` vs name `pickle-abc12345`) is used; every dir carries a trailing hash that the paired tmux name can (or intentionally cannot) match. The rename test uses `git mv` (staged rename → porcelain `R ` record) which is the correct shape for exercising the second-token skip.

---

## Areas explicitly found with NOTHING wrong
- Throwaway-index isolation, add-A containment, and worktree/index byte-identity.
- `salvageDirtyTree` foreign/owned partition — no leak path for foreign staging.
- `stageOwnedPaths` `--` terminator (no arg injection), deleted/new handling.
- Best-effort null-on-failure and no-throw-leak semantics; `safeErrorMessage` parity and export.
- `-z` NUL parse including the classic rename off-by-one (skip is correct).
- Exclude-prefix arg builder (`:!<prefix>` + `:!<prefix>/**`) and prefix normalization.
- tmux guard fail-closed rule; absence of `getDataRoot`/`readdirSync`; export for tests.
- Test fixtures are layout-coherent.

## Real bugs vs nits
- **Real correctness bugs: NONE.**
- **Nits/informational (F1, F2, F3):** cosmetic error-message wording, the sanctioned decision to leave legacy `isWorkingTreeDirty` on the old status path, and trimmed comment anchors. None affect behavior.
