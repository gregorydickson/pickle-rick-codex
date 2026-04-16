# pickle-rick-codex

Canonical agent instructions for the Codex CLI port of Pickle Rick.

## Persona

- Default persona after global install: `Pickle Rick`
- Style: direct, sharp, technically rigorous, non-sycophantic
- Activation: run `bash install.sh`, then open Codex in any workspace
- Opt-out: if the user asks to drop the persona, continue in standard mode

## Canonical Contracts

- Package / published name: `pickle-rick-codex`
- Runtime data root: `~/.codex/pickle-rick/`
- Runtime override: `PICKLE_DATA_ROOT`
- Guaranteed automation path: sequential `codex exec`
- Native multi-agent behavior: optional only after local validation documents it
- Project-local hooks: wired for local handlers, but treated as validated only after the installed build proves the event

## Install

- Use the local installer: `bash install.sh`
- Optional project-local override: `bash install.sh --project <path-to-project>`
- Keep installs local; do not assume marketplace publishing
- Preserve unrelated runtime data under the Codex root when reinstalling
- The installed runtime keeps its source `.codex/skills` and `.codex/hooks` trees so `~/.codex/pickle-rick/install.sh --project <path>` remains supported after global install

## Persona Activation

- To activate the Pickle Rick persona generally, run `bash install.sh`
- That installs the runtime, copies Pickle Rick skill directories into `~/.codex/skills`, and merges managed Pickle Rick marker blocks into `~/.codex/AGENTS.md` and `~/.codex/CLAUDE.md`
- Open any project in Codex after the install; the persona is active when Codex reads the global instructions and the `pickle` skill is available
- If you want a repo-local override, run `bash install.sh --project <path-to-project>`
- Existing `AGENTS.md` and `CLAUDE.md` content is preserved below the managed Pickle Rick block, with backups written under `.codex/pickle-rick-backups/`
- Use `pickle` for the full autonomous loop, or invoke `pickle-prd`, `pickle-refine`, and `pickle-orchestrate` directly for subflows

## Skills

- `pickle` is the primary entrypoint for the autonomous loop
- `pickle-tmux` bootstraps from a PRD or resumes a prepared session in detached tmux with a live monitor
- `pickle-prd` drafts the PRD
- `pickle-refine` runs three analyst passes, synthesizes the result, and decomposes the PRD into tickets
- `pickle-orchestrate` runs multi-ticket sequential orchestration
- `pickle-status` and `pickle-metrics` expose runtime state
- `pickle-cancel` and `pickle-retry` manage session recovery
- `pickle-microverse` launches the detached metric-convergence tmux loop
- `szechuan-sauce` launches the detached principle-driven cleanup tmux loop
- `anatomy-park` launches the detached subsystem correctness tmux loop

## Hooks

- Hooks are optional; install them explicitly with `bash install.sh --project <path> --enable-hooks`
- The installed runtime ships `.codex/hooks/hooks.json` as an empty default contract and `.codex/hooks/hooks.template.json` for rendered project hooks
- Keep `.codex/hooks/hooks.json` limited to handlers that exist locally
- Do not encode unsupported hook events into the default path
- Hook failures should fail open unless the operation is explicitly safety-critical

## Notes

- Use `codex exec` for the guaranteed path and treat any interactive native-agent behavior as optional acceleration
- Keep docs aligned with the data-root contract and do not reintroduce Claude-era runtime assumptions
