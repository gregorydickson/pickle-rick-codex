---
name: pickle-microverse
description: "Start the Pickle Rick microverse convergence loop to optimize a measurable metric through targeted, incremental iterations. Use only when the worker path has been validated."
metadata:
  short-description: "Metric convergence optimization loop"
---

# Pickle Rick Microverse

Iterative metric optimization loop: measure -> compare -> accept/revert -> repeat.

Launch the detached tmux runner:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-microverse.js --metric "<command-that-prints-one-number>" --direction higher --tolerance 0 --target 90 --target-relation gt --task "<task>"`

Or use a qualitative goal:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-microverse.js --goal "<goal>" --task "<task>"`

Resume:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-microverse.js --resume`

Command metrics are measured by the runtime before the first iteration and after every valid experiment. The command must exit successfully and print exactly one finite number. Improved iterations are retained; held or regressed iterations are archived to the experiment ledger and reverted. Use `--metric-timeout <seconds>` to bound each measurement. Use `--protected-path <repo-relative-path-or-glob>` repeatedly to prevent workers from changing evaluation inputs. `--worker-failure-limit <N>` defaults to 3; the research stall limit defaults to 8.

## Process

1. Establish baseline measurement
2. Persist a falsifiable hypothesis in the experiment ledger
3. Run the optimization worker through the validated execution path
4. Verify authoritative final-message evidence and protected paths
5. Measure result
6. Compare: improved/held/regressed (with tolerance)
7. Accept improvement or archive and revert the rejected experiment
8. Escalate at 3/5/8 valid stalls: warn/paradigm shift/stop
9. Repeat until the runtime-owned target is met or convergence is reached

## Failure Classification

- worker_incomplete: no authoritative final-message or required experiment evidence
- worker_error: subprocess failed
- worker_timeout: subprocess exceeded its bound
- protected_path_tamper: worker changed protected evaluation inputs
- held/regressed: a valid experiment did not improve the metric

Worker failures use a separate retry counter and never count as scientific stalls.
