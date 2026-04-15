---
name: pickle-microverse
description: "Start the Pickle Rick microverse convergence loop to optimize a measurable metric through targeted, incremental iterations. Use only when the worker path has been validated."
metadata:
  short-description: "Metric convergence optimization loop"
---

# Pickle Rick Microverse

Iterative metric optimization loop: measure -> compare -> accept/revert -> repeat.

Launch the detached tmux runner:

`node $HOME/.codex/pickle-rick/bin/pickle-microverse.js --metric "<cmd>" --task "<task>"`

Or use a qualitative goal:

`node $HOME/.codex/pickle-rick/bin/pickle-microverse.js --goal "<goal>" --task "<task>"`

Resume:

`node $HOME/.codex/pickle-rick/bin/pickle-microverse.js --resume`

## Process

1. Establish baseline measurement
2. Run the optimization worker through the validated execution path
3. Measure result
4. Compare: improved/held/regressed (with tolerance)
5. Accept improvement or revert regression
6. Stall detection: halt after N iterations without progress
7. Repeat until target met or stall limit reached

## Failure Classification

- tool_failure: subprocess crashed
- approach_exhaustion: too many similar attempts
- regression: metric went backwards
- metric_unstable: measurement variance > tolerance
- no_progress: no commits produced
