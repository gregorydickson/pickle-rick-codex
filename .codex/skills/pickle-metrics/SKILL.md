---
name: pickle-metrics
description: "Show token usage, commit counts, and LOC metrics for Pickle Rick sessions. Flags: --days N, --since YYYY-MM-DD, --weekly, --json."
metadata:
  short-description: "Token/commit/LOC metrics reporter"
---

# Pickle Rick Metrics

Run: `node $HOME/.codex/pickle-rick/bin/metrics.js`

Accepts flags: `--days N`, `--since YYYY-MM-DD`, `--weekly`, `--json`

Reports:
- Token usage when present in Codex JSON output
- Session and ticket event counts
- Commit counts from logged runtime events
- Zero-data periods explicitly instead of crashing
