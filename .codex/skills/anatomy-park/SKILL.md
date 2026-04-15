---
name: anatomy-park
description: "Deep subsystem correctness review. Use when a subsystem keeps breaking, data flows look suspicious, or you need a read-trace-fix-verify loop focused on correctness rather than design polish."
metadata:
  short-description: "Deep subsystem correctness review"
---

# Anatomy Park — Deep Subsystem Review

Trace data flows through a subsystem, find correctness bugs, fix one issue at a time, and document structural trap doors for future passes.

Launch the detached tmux runner:

`node $HOME/.codex/pickle-rick/bin/anatomy-park.js <target>`

Optional flags:

- `--dry-run`
- `--resume`

## When To Use It

- Flaky multi-file subsystems
- Schema drift between producers and consumers
- ID mismatches across service boundaries
- Timezone bugs from date parsing or local/UTC confusion
- Financial or aggregate calculations with inconsistent rounding
- "This area keeps breaking and nobody trusts it" situations

## Core Rule

Szechuan Sauce asks: "Is this code well-designed?"

Anatomy Park asks: "Is this code correct?"

Do not collapse those into the same pass.

## Three-Phase Process

1. **Review** — read-only
   - Trace the complete data path from input to incorrect output
   - Identify the exact file and line transitions where meaning changes
   - Rate findings by severity
   - Prefer concrete runtime scenarios over abstract style complaints
2. **Fix** — one finding only
   - Fix the single highest-severity finding
   - Keep the edit minimal and local
   - Add or update a regression test that would have caught the bug
3. **Verify** — read-only
   - Re-read every changed file
   - Check callers, consumers, branches, and affected schemas
   - Verify the fix did not create dead code or shift the bug downstream

## Review Checklist

- Every ID/index: constructed value matches consumed meaning
- Every schema/type: consumers import the current version, not a stale copy
- Every date parse: local vs UTC behavior is explicit and consistent
- Every financial calculation: rounding rules match across pipeline boundaries
- Every new field: stored, read, transformed, and returned consistently
- Every validation rule: actually runs at runtime, not just in static typing

## Trap Doors

If you discover a structural invariant that future work is likely to break, record it explicitly in your findings summary as a trap door.

Example:

```markdown
## Trap Doors
- `bank-statement.service.ts` — borrowerFileId must equal the S3 batch UUID or tenant isolation breaks downstream
```

## Output Expectations

- Findings should include the exact data flow path
- Fixes should be minimal and regression-tested
- Verification should explicitly mention downstream impact checks
- If the user asked for review only, stop after the review phase and do not edit files
