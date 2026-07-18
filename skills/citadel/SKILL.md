---
name: citadel
description: "Run the fail-closed final Pickle Rick release review for a prepared session. Use after implementation and cleanup when acceptance-criteria coverage, deterministic checks, and an adversarial read-only review must all approve the release."
metadata:
  short-description: "Run the final release gate"
---

# Citadel — Final Release Gate

Resolve the prepared session for the current repository:

`node $HOME/.codex/pickle-rick/extension/bin/get-session.js --cwd "$PWD" --last`

Run Citadel with the returned session directory:

`node $HOME/.codex/pickle-rick/extension/bin/citadel.js <session-dir>`

Citadel fails closed unless:

- the target Git tree starts and remains clean;
- at least one deterministic project check executes and all executed checks pass;
- the report covers every acceptance criterion declared by the refined tickets or PRD;
- the read-only reviewer leaves the repository unchanged; and
- the reviewer emits `<promise>THE_CITADEL_APPROVES</promise>`.

Treat a nonzero exit or `citadel-blocked` report as a release blocker. Read `citadel-checks.json` and `citadel-report.json` in the session directory for evidence.
