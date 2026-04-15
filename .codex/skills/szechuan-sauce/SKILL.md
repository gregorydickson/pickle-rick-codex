---
name: szechuan-sauce
description: "Iterative code deslopping loop with principle-driven quality convergence. Use for cleaning up code quality issues across 10+ files or 500+ LOC diffs."
metadata:
  short-description: "Code quality convergence loop"
---

# Szechuan Sauce — Code Quality Loop

Principle-driven iterative code cleanup.

Launch the detached tmux runner:

`node $HOME/.codex/pickle-rick/bin/szechuan-sauce.js <target>`

Optional flags:

- `--focus "<text>"`
- `--domain <name>`
- `--dry-run`
- `--resume`

## Principles

- KISS: Simplest solution that works
- DRY: No duplicated logic (but don't abstract prematurely)
- SOLID: Single responsibility, open/closed, etc.
- No dead code, no commented-out code
- Consistent patterns across the codebase
- Error handling at boundaries, not everywhere

## Process

1. Scan modified files for principle violations
2. Fix violations (one principle per pass)
3. Verify fixes don't break tests
4. Re-scan for remaining violations
5. Converge when clean pass achieved
