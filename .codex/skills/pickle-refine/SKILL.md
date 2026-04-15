---
name: pickle-refine
description: "Refine and decompose a PRD into atomic tickets using a real three-analyst review pass plus synthesis on the guaranteed codex exec path."
metadata:
  short-description: "Three-analyst PRD refinement and synthesis"
---

# Pickle Rick PRD Refinement

Decompose a PRD into atomic, implementable tickets on the guaranteed `codex exec` path.

Run:

`node $HOME/.codex/pickle-rick/bin/spawn-refinement-team.js <session-dir>`

The runtime runs three focused analyst passes first:

- requirements gaps
- codebase integration
- risk and sequencing

Then it synthesizes those reports into final executable artifacts.

## Output

- `analyst-requirements.md` — Requirements and acceptance-criteria review
- `analyst-codebase.md` — Codebase integration and interface review
- `analyst-risk.md` — Risk, sequencing, and dependency review
- `prd_refined.md` — Gap-filled, concrete PRD
- `refinement_manifest.json` — Ticket decomposition with dependencies and priorities
- Individual ticket files: `<ticket-hash>/linear_ticket_<hash>.md`
