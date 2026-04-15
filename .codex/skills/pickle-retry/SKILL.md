---
name: pickle-retry
description: "Retry the current or specified Pickle Rick ticket without unsafe rollback."
metadata:
  short-description: "Retry a ticket safely"
---

# Pickle Rick Retry

Run:

`node $HOME/.codex/pickle-rick/bin/retry-ticket.js --ticket <ticket-id>`

Behavior:

- Resets the ticket status to `Todo`
- Reactivates the session
- Preserves unrelated local edits
- Re-enters the guaranteed sequential path
