## Trap Doors

- `status.js` — INVARIANT: pipeline progress counts only `done` phases plus the current `running` phase. BREAKS: failed/cancelled phases render as completed work and mislead resume triage. ENFORCE: `session-flow` pipeline status regression. PATTERN_SHAPE: `completedPhases + 1` on non-complete current phase without checking `phaseStatuses[currentPhase]`.
