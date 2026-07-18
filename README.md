<p align="center">
  <img src="images/pickle-rick.png" alt="Pickle Rick for Codex" width="100%" />
</p>

# 🥒 Pickle Rick for Codex

> *"Wubba Lubba Dub Dub! I'm not just an assistant anymore, Morty — I'm an autonomous engineering machine jammed into Codex."*

Pickle Rick is a PRD-driven engineering workflow for Codex. Hand it a task or an existing `prd.md`, and it drives the work through a concrete lifecycle:

`PRD -> refinement -> ticket execution -> status/metrics -> retry/cancel`

This port is intentionally narrower than the Claude version. That is deliberate. The guaranteed v1 path is a Node runtime orchestrating sequential `codex exec` runs with filesystem-backed state under `~/.codex/pickle-rick/`. Anything beyond that, especially hooks and native multi-agent behavior, is treated as optional and validation-gated instead of being hand-waved into the contract.

If you want the short version: this repo gives Codex a real Pickle Rick persona, a global install path, a practical workflow, and a runtime that can carry a feature from vague task to reviewed ticket execution without pretending unsupported Codex features are stable. ⚗️

## What This Port Actually Does

- Installs a global Pickle Rick persona into Codex
- Installs Pickle Rick skills into Codex's supported user location at `~/.agents/skills`
- Drafts PRDs with machine-checkable acceptance criteria
- Refines PRDs into ticket manifests and per-ticket markdown files
- Executes tickets sequentially in the current branch working tree
- Supports detached tmux orchestration with a runner window and live monitor
- Supports a detached `pickle-pipeline` path that runs `pickle`, optional `anatomy-park` and `szechuan-sauce`, then a mandatory final fail-closed `citadel` gate in one tmux session
- Supports detached context-clearing loops for `pickle-tmux`, `pickle-microverse`, `szechuan-sauce`, and `anatomy-park`
- Tracks runtime state, session mappings, metrics, and circuit-breaker state
- Supports safe cancel and retry flows; rejected mutations are archived to Git recovery refs before the clean checkpoint is restored

## What It Does Not Promise

- It does not assume undocumented native agent controls
- It does not require project-local install to work
- It does not rely on hooks for the default path
- It does not claim feature parity with the Claude repo's broader command set

## Quick Start

### Requirements

- Node.js `>=20`
- npm (bundled with Node.js)
- `rsync` for runtime deployment
- `tmux` for detached and pipeline modes
- `codex` installed and authenticated
- Git available in the target repo

### Install Globally

```bash
git clone https://github.com/gregorydickson/pickle-rick-codex.git
cd pickle-rick-codex
bash install.sh
```

That install does three things:

1. Copies the runtime to `~/.codex/pickle-rick/`
2. Copies Pickle Rick skills to `~/.agents/skills/`
3. Merges the managed Pickle Rick marker block into `~/.codex/AGENTS.md` (Codex reads `AGENTS.md`; the installer does not touch `CLAUDE.md`)

After that, the Pickle Rick persona is available in Codex generally. You do not need to reinstall it per project.

### Optional Project Override

Only use project bootstrap if you explicitly want repo-local Pickle Rick instructions or repo-local skill copies:

```bash
bash install.sh --project /path/to/project
```

That keeps the global install, and also adds managed Pickle Rick files to the target repo without deleting unrelated project-local Codex configuration. The installed runtime carries the canonical root `skills/` tree it needs, so the documented `~/.codex/pickle-rick/install.sh --project ...` path works after the first global install too.

Hook installation currently fails closed:

```bash
bash install.sh --project /path/to/project --enable-hooks
```

That command exits without changing the runtime or project. The former hook template has not passed authenticated validation for Codex's current event names, payloads, decisions, and trust behavior, so the installer will not present it as usable configuration.

### Plugin Packaging

The repository is a validator-clean Codex plugin source: `.codex-plugin/plugin.json` points to the canonical root `skills/` directory. The local `bash install.sh` path remains the guaranteed compatibility install; it does not silently edit a marketplace or claim that the plugin is installed through `codex plugin add`.

## How To Build Things With It

This is the real workflow. You do not need to memorize every command. You need to understand the loop.

### Step 1: Draft A PRD

Every serious feature starts with a PRD. Open Codex in your repo and ask Pickle Rick to turn the rough task into something verifiable.

Examples:

```text
Use the pickle-prd skill to draft a PRD for caching loan status API responses in Redis.
```

```text
Use the pickle skill and continue from the existing prd.md in this repo.
```

The important part is not the markdown file. The important part is that the PRD ends with machine-checkable acceptance criteria instead of vague aspirations and hand-wavy “done when it feels done” nonsense. 🧪

### Step 2: Refine The PRD Into Tickets

Once the PRD exists, refinement turns it into execution material:

- `analyst-requirements.md`
- `analyst-codebase.md`
- `analyst-risk.md`
- `prd_refined.md`
- `refinement_manifest.json`
- ticket markdown files under per-ticket directories

This is where broad intent gets narrowed into atomic work that can be run in order, verified, retried, and inspected later. The Codex port now does this through a real three-analyst review pass followed by a synthesis step, instead of a single blind rewrite.

### Step 3: Execute Tickets Sequentially

The orchestrator runs tickets in manifest order. For each ticket it:

1. works directly in the current branch working tree
2. runs a causal eight-phase lifecycle: `research`, `research_review`, `plan`, `plan_review`, `implement`, `review`, `simplify`, `conformance`
3. persists and validates a ticket-scoped JSON artifact after every phase, reading approved research and plan artifacts into implementation
4. verifies outputs and exact acceptance-criteria conformance
5. advances state or stops on policy

The point is not “maximum chaos.” The point is controlled sequential autonomy. Each ticket works on the branch as it exists now, carries forward prior ticket changes naturally, and still records explicit session artifacts and verification results.

For longer runs, launch the detached tmux version instead of keeping the current session occupied:

```text
Use the pickle-tmux skill with --prd ./prd.md so the runtime refines the PRD, launches detached, and gives me a tmux monitor I can reattach to later.
```

If the work should move through the full proven multi-phase path, use the dedicated detached pipeline entrypoint instead:

```text
Use the pickle-pipeline skill with "ship the feature" so the runtime launches one tmux session, runs pickle, advances through anatomy-park and szechuan-sauce when enabled, then blocks final completion on Citadel release findings.
```

### Step 4: Inspect, Retry, Or Cancel

Pickle Rick is not a black box. The runtime exposes state and recovery tools:

- `pickle-status` for the current session snapshot
- `pickle-metrics` for usage and activity reporting
- `pickle-retry` to safely re-run a ticket
- `pickle-cancel` to stop the active session; any rejected in-flight mutation is retained through recovery refs before checkpoint restoration

### Step 5: Optional Polish Loops

Two advanced surfaces are included for targeted cleanup after the main loop:

- `pickle-microverse` for metric-convergence work
- `szechuan-sauce` for principle-driven code cleanup
- `anatomy-park` for subsystem correctness tracing

## The Flow At A Glance

```text
You describe a feature
       │
       ▼
  pickle-prd
       │
       ▼
  pickle-refine
       │
       ▼
  pickle-orchestrate
       │
       └── or pickle-tmux for detached tmux mode
       │
       ├── status / metrics while running
       ├── retry if a ticket fails
       └── cancel if you want the loop stopped safely
       ▼
  optional polish
       ├── pickle-microverse
       └── szechuan-sauce
       ▼
  ship it 🥒
```

## Skill Surface

The current Codex install exposes these primary skills:

- `pickle` — end-to-end autonomous loop
- `pickle-pipeline` — detached multi-phase pipeline across `pickle`, optional `anatomy-park` and `szechuan-sauce`, and mandatory final `citadel`
- `pickle-tmux` — bootstrap from a PRD or resume a prepared session in detached tmux
- `pickle-prd` — draft a PRD
- `pickle-refine` — run three analyst passes, synthesize the result, and decompose the PRD into tickets
- `pickle-orchestrate` — execute the manifest sequentially
- `pickle-status` — inspect current runtime state
- `pickle-metrics` — session, token, commit, and LOC reporting
- `pickle-cancel` — cancel the active session safely
- `pickle-retry` — retry a failed or current ticket safely

The Codex Citadel is deliberately compact: declared typecheck/lint/test scripts plus one adversarial read-only acceptance-criteria review. It is a fail-closed final gate, not a claim of parity with the Claude edition's larger analyzer suite.

Detached advanced loops currently present in the repo:

- `pickle-microverse`
- `szechuan-sauce`
- `anatomy-park`

### 🏥 Anatomy Park — Deep Subsystem Review

<p align="center">
  <img src="images/anatomy-park.jpeg" alt="Anatomy Park — Deep Subsystem Review" width="100%" />
</p>

> *"Welcome to Anatomy Park! It's like Jurassic Park but inside a human body. Way more dangerous."*

`anatomy-park` is the correctness loop. Use it when a subsystem keeps breaking, when IDs or schemas drift across boundaries, or when the code is technically "clean" but still wrong. It is about tracing data flow, finding where meaning changes, fixing one high-severity issue at a time, and documenting trap doors so the next pass does not walk into the same structural hazard.

<p align="center">
  <img src="images/microverse.png" alt="Pickle Rick Microverse" width="100%" />
</p>

`pickle-microverse` is the metric-convergence loop. Command metrics must print exactly one finite number. The runtime captures a baseline, measures each iteration, accepts only improvements, reverts held/regressed work, records failed approaches, and stops at the stall limit. It launches as a detached tmux loop with fresh Codex context per iteration.

### Recoverable destructive operations

Worker rejection, Citadel read-only enforcement, and Microverse held/regressed iterations share one destructive Git seam. Before `git reset --hard` or removal of iteration-created untracked files, the runtime anchors committed work and snapshots dirty/untracked evidence under `refs/pickle/recovery/*`, `refs/pickle/salvage/*`, or the subsystem-specific rejected/recovery ref. If the archive cannot be created, the reset aborts and the attempted working tree is left in place.

Recovery archival is capped at 50 MiB by default. Set `PICKLE_DESTRUCTIVE_ARCHIVE_MAX_BYTES` to a positive byte count when a repository needs a different limit. Exceeding the cap fails closed: the session does not report success and the runtime does not perform the destructive restore. Inspect the error, preserve or commit the attempted tree, or raise the cap deliberately before retrying.

<p align="center">
  <img src="images/szechwan-sauce.jpeg" alt="Szechuan Sauce code quality loop" width="600" />
</p>

`szechuan-sauce` is the principle-driven cleanup loop. Use it after implementation when the code works but still needs a deliberate pass for simplification, duplication cleanup, and consistency. It now launches as a detached tmux loop with fresh Codex context per iteration.

## Direct Runtime Commands

If you want the guaranteed path without relying on skill invocation, use the runtime directly:

```bash
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js "<task>"
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js --resume
node ~/.codex/pickle-rick/extension/bin/pickle-tmux.js --prd ./prd.md
node ~/.codex/pickle-rick/extension/bin/pickle-tmux.js --resume
node ~/.codex/pickle-rick/extension/bin/pickle-microverse.js --metric "<cmd>" --task "<task>"
node ~/.codex/pickle-rick/extension/bin/szechuan-sauce.js <target>
node ~/.codex/pickle-rick/extension/bin/anatomy-park.js <target>
node ~/.codex/pickle-rick/extension/bin/setup.js "<task>"
node ~/.codex/pickle-rick/extension/bin/draft-prd.js <session-dir> "<task>"
node ~/.codex/pickle-rick/extension/bin/spawn-refinement-team.js <session-dir>
node ~/.codex/pickle-rick/extension/bin/mux-runner.js <session-dir> --on-failure=retry-once
```

Support commands:

```bash
tmux attach -t pickle-<session-id>
node ~/.codex/pickle-rick/extension/bin/status.js
node ~/.codex/pickle-rick/extension/bin/metrics.js --weekly
node ~/.codex/pickle-rick/extension/bin/cancel.js
node ~/.codex/pickle-rick/extension/bin/retry-ticket.js --ticket <ticket-id>
```

For pipeline sessions, `status.js` prints the active pipeline phase, per-phase status summary, bootstrap source, and target path while preserving the existing non-pipeline status output.

`pickle-tmux` has two first-class modes now:

- `--prd <path>` or `--bootstrap-from <path>`: create a detached session from an existing PRD, run refinement if needed, then launch tmux
- `--resume [session-dir]`: relaunch an existing session after validating that the manifest exists and there is at least one runnable ticket

## Session Model

Runtime state is persisted under `~/.codex/pickle-rick/`, including:

- session directories
- activity logs
- metrics inputs
- current session mappings
- state snapshots
- refinement manifests
- ticket artifacts

The design is deliberately file-backed so runs can resume and be inspected outside the model loop.

## Reliability Primitives (Internal)

The TypeScript extension under `extension/src/services/` carries git/tmux safety seams ported from the Phase 0/1 safety-seams work. They are wired into worker commits, advanced-loop commits, and detached tmux lifecycle paths:

- `git-utils.listWorkingTreeDirtyPaths(cwd, excludePrefixes?)` — parses `git status --porcelain -z` into a de-duped, sorted list of dirty working-tree paths (skipping rename/copy source tokens), with optional exclude-prefix pathspecs
- `dirty-tree-salvage.ts` — `stashUnattributableRemainder` snapshots the whole dirty tree into a dangling commit under `refs/pickle/salvage/<session>` via a throwaway `GIT_INDEX_FILE` without mutating the real index or worktree, `salvageDirtyTree` anchors foreign dirt and returns only owned paths, and `stageOwnedPaths` stages per-path rather than whole-tree
- `tmux.ts` — `sessionHashOf` and `isForeignTmuxSession(sessionName, sessionDir)` provide a fail-closed ownership guard via trailing-hash comparison with no filesystem or data-root access

## Install Layout

Global install:

- `~/.codex/pickle-rick/` — runtime, scripts, docs
- `~/.codex/pickle-rick/skills/` — canonical plugin skill definitions used by the installed `install.sh --project ...` path
- `~/.codex/pickle-rick/.codex/skills` — compatibility symlink to the canonical root `skills/`
- `~/.codex/pickle-rick/.codex/hooks/` — empty default hook contract plus inactive, unvalidated reference material
- `~/.codex/pickle-rick/extension/tests/` — installed regression tests beside the compiled modules they import
- `~/.agents/skills/` — globally available Pickle Rick skills
- `~/.codex/AGENTS.md` — managed Pickle Rick persona block (the only markdown the installer merges)

Optional project override:

- `<project>/.agents/skills/` — repo-local skill copies
- `<project>/AGENTS.md` — managed Pickle Rick block merged into project instructions
- project hooks are never written; `--enable-hooks` is rejected before installation mutates state

## Hooks

Hooks are not part of the guaranteed path.

The repo ships local handlers for:

- `SessionStart -> extension/bin/session-start.js`
- `Stop -> extension/bin/stop-hook.js`
- `PreToolUse -> extension/bin/config-protection.js`
- `PostToolUse -> extension/bin/log-commit.js`

The installed runtime ships `.codex/hooks/hooks.json` as an empty fail-open contract and retains `.codex/hooks/hooks.template.json` only as historical reference. `bash install.sh --project <path> --enable-hooks` fails before changing installation or project state. Re-enable hook installation only after authenticated tests prove the installed Codex build's event names, input payloads, output decisions, trust prompts, and failure behavior.

## Validated Behavior

The distribution checks below were rerun on July 18, 2026; `validate:codex` recorded the locally installed CLI as `codex-cli 0.144.5`. Hook delivery remains unvalidated, but the installed sequential pipeline now has authenticated disposable-repository evidence:

- `bash install.sh` installs the runtime, persona, and skills globally
- `~/.codex/pickle-rick/install.sh --project <path>` works from the installed runtime because the canonical root skill tree is shipped with it; `--enable-hooks` is intentionally rejected
- a clean `codex exec` probe in a temp directory returned `Pickle Rick`
- the PRD and refinement flows can detect success artifacts and exit promptly even if the child Codex process lingers
- `pickle-pipeline` launches one detached tmux session, records immutable pipeline metadata, advances through configured cleanup phases, and runs the mandatory Citadel release gate last, with `pipeline-runner.log` in the monitor pane
- authenticated installed-runtime dogfood completed PRD refinement, one scoped worker ticket, an attributable clean commit, 8/8 target tests, and final Citadel approval in session `2026-07-18-1c18e785`
- `status.js` renders pipeline metadata for pipeline sessions without changing legacy non-pipeline status output
- `pickle-tmux --prd ./prd.md` bootstraps, refines, and launches detached tmux instead of requiring a task-string workaround
- zero-ticket detached runs fail closed with `last_exit_reason = "no_tickets"` instead of marking the session complete
- detached tmux launchers for `pickle-tmux`, `pickle-microverse`, `szechuan-sauce`, and `anatomy-park` are covered by local tests with a fake `tmux` binary
- source and isolated installed-runtime suites pass: 238/238 fast tests and 176/176 integration tests

Validation details live in [docs/codex-api-validation.md](docs/codex-api-validation.md).

## Repo Structure

- [AGENTS.md](AGENTS.md) — canonical persona and install contract
- [CLAUDE.md](CLAUDE.md) — retained for Claude Code contributors to build/review/test this repo; not part of the Codex install
- [extension/src/bin](extension/src/bin) — TypeScript runtime entrypoints
- [extension/src/services](extension/src/services) — TypeScript runtime internals
- [skills](skills) — canonical plugin skill definitions (`.codex/skills` is a compatibility symlink)
- [extension/tests](extension/tests) — regression coverage against compiled runtime artifacts
- [images](images) — README assets
- [docs/codex-api-validation.md](docs/codex-api-validation.md) — local validation notes

## Development

```bash
npm test
npm run release:gate
node ./extension/bin/validate-codex.js
bash install.sh
```

The installed runtime keeps tests under `extension/tests` and source-level invariant fixtures under `extension/src`; its conditional pretest skips compilation because development dependencies are intentionally not deployed, then tests the exact compiled files that were installed.

If you change install behavior, persona wiring, or runtime completion detection, update the tests and the validation doc in the same change.
