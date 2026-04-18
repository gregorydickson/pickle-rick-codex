---
name: pickle-cancel
description: "Cancel the active Pickle Rick session without destroying current branch state."
metadata:
  short-description: "Cancel the active session"
---

# Pickle Rick Cancel

Run:

`node $HOME/.codex/pickle-rick/bin/cancel.js`

Behavior:

- Marks the active session inactive
- Preserves state files, logs, and ticket artifacts
- Removes the active `current_sessions.json` entry for the current working directory
