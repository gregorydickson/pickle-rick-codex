---
name: szechuan-sauce
description: "Iterative code deslopping loop with principle-driven quality convergence. Use for cleaning up code quality issues across 10+ files or 500+ LOC diffs."
metadata:
  short-description: "Code quality convergence loop"
---

# Szechuan Sauce — Code Quality Loop

Principle-driven iterative code cleanup.

Launch the detached tmux runner:

`node $HOME/.codex/pickle-rick/extension/bin/szechuan-sauce.js <target>`

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

1. Discover the contracts, tests, public interfaces, and local conventions that constrain the target.
2. Scan only the immutable runtime scope and discard false positives.
3. Rank surviving findings by severity and confidence; fix one highest-value finding.
4. Verify the fix and add the smallest regression test for any recurring trap door.
5. Check staged and unstaged paths against scope before committing.
6. Re-scan and converge on a clean pass.

## Finding Rubric

- P0 — data loss, security, or catastrophic correctness
- P1 — production correctness, scope breach, or serious diff hygiene
- P2 — material maintainability defect with concrete evidence
- P3 — localized low-risk simplification
- P4 — optional polish

Score confidence as 0/25/50/75/100 and drop anything below 80. Severity never substitutes for evidence.

Do not flag pre-existing out-of-scope issues, compiler/linter noise, author-silenced findings, uncodified style preferences, generic coverage complaints, speculative future risk, or a finding family already resolved in this loop.

Diff hygiene forbids scratch notes, generated debris, unrelated formatting, broad dependency churn, and out-of-scope edits. If an iteration crosses scope, the runtime archives the attempted state, rolls back to its checkpoint, and blocks the phase.
