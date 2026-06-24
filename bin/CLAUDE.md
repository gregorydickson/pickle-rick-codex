## Trap Doors

- `draft-prd.js` — INVARIANT: bootstrap advances to `refine` only after Codex succeeds; fallback PRDs are artifact recovery only. BREAKS: failed drafting becomes placeholder requirements and misroutes downstream ticket generation. ENFORCE: `command-flows` draft-prd failure regression. PATTERN_SHAPE: bootstrap fallback artifact write before `assertCodexSucceeded(...)`.
- `status.js` — INVARIANT: pipeline progress counts only `done` phases plus the current `running` phase. BREAKS: failed/cancelled phases render as completed work and mislead resume triage. ENFORCE: `session-flow` pipeline status regression. PATTERN_SHAPE: `completedPhases + 1` on non-complete current phase without checking `phaseStatuses[currentPhase]`.
