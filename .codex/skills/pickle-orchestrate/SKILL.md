---
name: pickle-orchestrate
description: "Launch the Pickle Rick orchestration loop for multi-ticket implementation on the guaranteed sequential codex exec path in a workspace where the persona is installed globally or via a repo-local override. Native multi-agent fanout is optional and validation-gated."
metadata:
  short-description: "Multi-ticket sequential orchestration"
---

# Pickle Rick Orchestration Loop

Run:

`node $HOME/.codex/pickle-rick/bin/mux-runner.js <session-dir> --on-failure=retry-once`

## Loop Engine

For each ticket in manifest order:
1. Create an isolated git worktree
2. Run the ticket through `research -> plan -> implement -> review -> simplify`
3. Run verification commands
4. Apply the resulting patch back to the main worktree only if it can be applied safely
5. Advance state and move to the next ticket

## Failure Modes

- `--on-failure=abort` stops at the first failed ticket
- `--on-failure=skip` marks the ticket skipped and continues
- `--on-failure=retry-once` retries the ticket once, then aborts on repeat failure
