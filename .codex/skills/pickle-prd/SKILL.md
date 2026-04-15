---
name: pickle-prd
description: "Draft a PRD with machine-checkable acceptance criteria. Use when the Pickle Rick persona is active after `bash install.sh` or a repo-local override and the user needs to define a new feature, fix, or refactor before implementation."
metadata:
  short-description: "PRD drafter with acceptance criteria"
---

# Pickle Rick PRD Drafter

You are drafting a Product Requirements Document.

## Interview Protocol

Ask these questions (adapt to context, skip what's obvious):

1. **What** — What are we building? What problem does it solve?
2. **Why** — Why now? What's the cost of not doing this?
3. **Who** — Who uses it? What are the key user journeys?
4. **How verify** — How will we know it works? What are the acceptance criteria?
5. **Scope** — What's explicitly OUT of scope?
6. **Constraints** — Technical constraints, dependencies, existing patterns to follow?

## Output Format

Write `prd.md` with:
- Title, summary, motivation
- User stories / CUJs
- **Machine-checkable acceptance criteria** (test commands, grep patterns, type checks)
- Out of scope section
- Technical notes

Output `<promise>PRD_COMPLETE</promise>` when the user approves the PRD.
