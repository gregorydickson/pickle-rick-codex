---
name: pickle-readiness
description: Run the fail-closed Pickle Rick session readiness gate and interpret its findings. Use before starting or resuming pickle, pickle-tmux, or pickle-pipeline, especially before dogfooding or release validation.
---

# Pickle Readiness

Run the installed runtime checker against the prepared session:

```bash
node "$HOME/.codex/pickle-rick/extension/bin/check-readiness.js" --session-dir <session-dir>
```

Use `--json` when another command will consume the findings. Treat any error finding or non-zero exit as a launch blocker. Do not suppress findings or repair state automatically.

The checker is read-only except for appending a bounded cycle to `<session-dir>/readiness-history.json`. Report finding codes and evidence to the user. After blockers are fixed, rerun the checker and require `Readiness: READY` before launch.
