# Codex API Validation

Validated locally on `2026-04-15` against `codex-cli 0.120.0`.

## Verified Facts

- Codex CLI version: `codex-cli 0.120.0`
- Guaranteed automation path: `codex exec`
- Hook usage is gated by local validation of the installed build
- Native multi-agent controls are not part of the guaranteed v1 contract
- Reliable progress signaling for v1 comes from session state plus filesystem artifacts under `~/.codex/pickle-rick/`

## Installation Facts

- `bash install.sh` installs the runtime into the local Codex root at `~/.codex/pickle-rick/`, installs Pickle Rick skills into `~/.codex/skills/`, and merges managed Pickle Rick instructions into `~/.codex/AGENTS.md` and `~/.codex/CLAUDE.md`
- `bash install.sh --project <path-to-project>` is optional and adds repo-local Pickle Rick persona files plus Pickle Rick skill directories to the target project
- Existing `AGENTS.md` and `CLAUDE.md` content is preserved under a managed Pickle Rick block, with backups written under `.codex/pickle-rick-backups/`
- The Pickle Rick persona is active generally once Codex reads the global `~/.codex/AGENTS.md` and the `pickle` skill is available
- The install flow stays local-only; no marketplace publishing is required for the validated path
- A clean `codex exec` probe in a temp directory returned `Pickle Rick` when asked for the active persona after global install
- If `PICKLE_DATA_ROOT` overrides the runtime root, the installer renders global and project-facing skills plus optional hooks to the actual installed path

## Local Hook Surface

Project-local hooks are optional and are only installed when the user passes `--enable-hooks`:

- `SessionStart` -> `bin/session-start.js`
- `Stop` -> `bin/stop-hook.js`
- `PreToolUse` -> `bin/config-protection.js`
- `PostToolUse` -> `bin/log-commit.js`

These handlers are present for the local install, but the event registrations remain outside the guaranteed path and should stay gated by the installed Codex build's validated support.

## Guaranteed Fallback

- Use `codex exec` for the guaranteed path
- Do not assume `UserPromptSubmit`
- Do not assume `spawn_agent`, `send_message`, `list_agents`, `LastNTurns(0)`, or `job_max_runtime_seconds` in default behavior
- If a hook event or native control is not validated locally, keep it out of the default runtime path
