---
name: pickle-refine
description: "Refine and decompose a PRD into atomic tickets on the guaranteed sequential codex exec path in a workspace where the Pickle Rick persona is installed globally or via a repo-local override. Optional parallel analysis is validation-gated."
metadata:
  short-description: "PRD refinement with validation-gated analysts"
---

# Pickle Rick PRD Refinement

Decompose a PRD into atomic, implementable tickets on the guaranteed `codex exec` path.

Run:

`node $HOME/.codex/pickle-rick/bin/spawn-refinement-team.js <session-dir>`

The v1 runtime uses sequential orchestration and file outputs. If future Codex builds validate native parallel analyst behavior safely, it can be added as an optimization behind the validation gate.

## Output

- `prd_refined.md` — Gap-filled, concrete PRD
- `refinement_manifest.json` — Ticket decomposition with dependencies and priorities
- Individual ticket files: `<ticket-hash>/linear_ticket_<hash>.md`
