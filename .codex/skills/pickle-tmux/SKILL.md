---
name: pickle-tmux
description: "Bootstrap a detached Pickle Rick tmux run from an existing PRD or resume a prepared session, then launch the runner and monitor dashboard."
metadata:
  short-description: "Detached tmux bootstrap and resume mode"
---

# Pickle Rick tmux Mode

Bootstrap from an existing PRD file:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --prd ./prd.md`

Alias:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --bootstrap-from ./prd.md`

Resume the latest session for the current repo:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --resume`

Resume a specific session:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --resume <session-dir>`

Resume only if the session is already fully prepared:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --resume <session-dir> --resume-ready-only`

## Behavior

1. Verifies `tmux` is available
2. `--prd` creates a tmux session, copies `prd.md`, runs refinement if needed, and materializes ticket files
3. `--resume` loads an existing session and refines it if `prd.md` exists but the manifest is missing
4. Validates readiness before launch: `state.json`, `refinement_manifest.json`, and at least one runnable ticket
5. Refuses zero-ticket or blocked-only sessions instead of launching tmux anyway
6. Launches the detached `mux-runner`
7. Creates a monitor window that shows ticket counts, current ticket title, last failure, next verification, state, logs, and latest worker output by mtime
8. Prints `tmux attach` instructions

## Use It When

- You already have a PRD and want tmux to refine it and execute it end to end
- You already have a prepared session and want to resume it in detached mode
- You want a live monitor without keeping the current Codex prompt occupied
- You expect the run to continue while you detach and come back later
