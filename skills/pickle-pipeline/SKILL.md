---
name: pickle-pipeline
description: "Launch the detached Pickle Rick pipeline: pickle, optional anatomy-park and szechuan-sauce, then a mandatory final Citadel review in one tmux session."
metadata:
  short-description: "Detached multi-phase pipeline mode"
---

# Pickle Rick Pipeline

Launch from a task or an existing PRD:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-pipeline.js "ship the feature"`

`node $HOME/.codex/pickle-rick/extension/bin/pickle-pipeline.js --prd ./prd.md`

Optionally lock review/cleanup mutations to one or more repository-relative paths:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-pipeline.js --prd ./prd.md --scope extension/src --scope extension/tests`

Scope is immutable on resume. Without `--scope`, the runtime derives the narrow union of `allowed_paths` and implementation `files_changed` from completed tickets. If it cannot derive a non-root scope, optional phases fail closed; they never silently fall back to the repository root.

Resume the current repository's pipeline, or a specific session:

`node $HOME/.codex/pickle-rick/extension/bin/pickle-pipeline.js --resume [session-dir]`

Use `--skip-anatomy` or `--skip-szechuan` to disable downstream cleanup phases. Citadel cannot be skipped: it runs declared typecheck/lint/test scripts and an adversarial read-only acceptance-criteria review, blocking critical/high findings. The command validates tmux, persists an immutable pipeline contract, launches one detached runner plus monitor, and prints reattach instructions.
