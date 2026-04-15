# pickle-rick-codex

Local-only Codex CLI packaging for Pickle Rick with global persona install by default.

Published package identity: `pickle-rick-codex`.
Runtime data root: `~/.codex/pickle-rick/` unless `PICKLE_DATA_ROOT` overrides it.

## Guaranteed Path

- The v1 automation path is sequential `codex exec`
- Project-local hooks are wired in `.codex/hooks/hooks.json`, but their use stays gated by local validation
- Native multi-agent controls are not part of the default contract

## Install Into Codex

Install the runtime into the local Codex root:

```bash
bash install.sh
```

That copies this checkout into `~/.codex/pickle-rick/`, installs Pickle Rick skills into `~/.codex/skills/`, and merges managed Pickle Rick instructions into `~/.codex/AGENTS.md` and `~/.codex/CLAUDE.md`. After that, the persona is available in Codex generally, not just in one repo. If `PICKLE_DATA_ROOT` is set, the installer renders skill and hook commands to that installed runtime root.

## Optional Project Override

Bootstrap a target project only if you want repo-local Pickle Rick instructions or repo-local skill copies:

```bash
bash install.sh --project /path/to/project
```

That still installs the runtime, but it also copies managed `AGENTS.md`, `CLAUDE.md`, and Pickle Rick skill directories into the target project without deleting unrelated project-local skills. Existing `AGENTS.md` and `CLAUDE.md` content is preserved under a managed block with backups in `.codex/pickle-rick-backups/`. Use this only when you want a workspace-local override on top of the global install.

Hooks are not installed by default because they are not part of the guaranteed path. To opt in:

```bash
bash install.sh --project /path/to/project --enable-hooks
```

Validated locally on April 15, 2026: a clean `codex exec` probe in a bootstrapped target repo identified the repository persona as `Pickle Rick`.
Validated locally on April 15, 2026: a clean `codex exec` probe in a temp directory with only `~/.codex/AGENTS.md` installed identified the active persona as `Pickle Rick`.

## Invoke

- `pickle` starts the autonomous loop
- `pickle-prd` drafts the PRD
- `pickle-refine` breaks a PRD into tickets
- `pickle-orchestrate` runs the multi-ticket sequence
- `pickle-status` and `pickle-metrics` expose runtime state
- `pickle-cancel` and `pickle-retry` manage session recovery
- `szechuan-sauce`, `pickle-microverse`, and `anatomy-park` are advanced or deferred surfaces

## Hooks

The repo ships local handlers for:

- `SessionStart` -> `bin/session-start.js`
- `Stop` -> `bin/stop-hook.js`
- `PreToolUse` -> `bin/config-protection.js`
- `PostToolUse` -> `bin/log-commit.js`

Hook support is documented in `docs/codex-api-validation.md` and should stay gated by the installed Codex build.

## Docs

- `AGENTS.md` is the canonical agent instruction file
- `CLAUDE.md` exists only as a compatibility mirror
- `docs/codex-api-validation.md` records the local Codex CLI validation facts
