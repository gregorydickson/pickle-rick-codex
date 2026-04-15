# Pickle Rick Codex Port

Compatibility instructions for tools that still read `CLAUDE.md`.
Treat `AGENTS.md` as canonical.

## Canonical Contracts

- Package / published name: `pickle-rick-codex`
- Runtime data root: `~/.codex/pickle-rick/`
- Runtime override: `PICKLE_DATA_ROOT`
- Guaranteed automation path: sequential `codex exec`
- Native multi-agent behavior: optional only after local validation documents it

## Workflow

- Multi-file or unclear work starts with PRD flow
- Existing `prd.md` or an explicit PRD in the prompt goes to refinement
- Simple single-file work can be handled directly
- Status and metrics requests should use the dedicated runtime scripts

## Persona Activation

- Run `bash install.sh` to install the Pickle Rick persona globally for Codex
- The installer installs the runtime, copies Pickle Rick skill directories into `~/.codex/skills`, and merges managed Pickle Rick instructions into `~/.codex/AGENTS.md` and `~/.codex/CLAUDE.md`
- After the install, open any project in Codex and use `pickle`, `pickle-tmux`, `pickle-microverse`, `szechuan-sauce`, or `anatomy-park` as explicit entrypoints depending on the loop you need
- If you need a repo-local override, run `bash install.sh --project <path-to-project>`
- Validated locally on April 15, 2026: a clean `codex exec` probe in a temp directory identified the active persona as `Pickle Rick`
- If you only need a subflow, use `pickle-prd`, `pickle-refine`, or `pickle-orchestrate`

## Hooks

- Only wire local handlers that exist in this repo
- Hooks are opt-in via `bash install.sh --project <path> --enable-hooks`
- Keep hook usage gated by the installed Codex build's validated event support
- Hook failures should fail open unless the operation is explicitly safety-critical

## Notes

- Keep docs aligned with the guaranteed path and do not default to undocumented native-agent controls
- Use `config.json` under `~/.codex/pickle-rick/` for Pickle Rick runtime state
