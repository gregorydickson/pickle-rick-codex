---
name: pickle-tmux
description: "Launch Pickle Rick in detached tmux mode with a runner window and monitor dashboard. Use for longer epics where you want the runtime detached from the current Codex interaction."
metadata:
  short-description: "Detached tmux orchestration mode"
---

# Pickle Rick tmux Mode

Launch the detached tmux manager:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js "<task>"`

Resume the latest session for the current repo:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --resume`

Resume a specific session:

`node $HOME/.codex/pickle-rick/bin/pickle-tmux.js --resume <session-dir>`

## Behavior

1. Verifies `tmux` is available
2. Creates or resumes a Pickle Rick session in tmux mode
3. Launches the detached `mux-runner`
4. Creates a monitor window for status, runner logs, state, and latest worker output
5. Prints `tmux attach` instructions

## Use It When

- The task is large enough that you want a detached runtime
- You want a live monitor without keeping the current Codex prompt occupied
- You expect the run to continue while you detach and come back later
