---
name: pickle
description: "Start the Pickle Rick autonomous coding loop on the guaranteed sequential codex exec path. Use after `bash install.sh` so the Pickle Rick persona and skills are installed for Codex generally."
metadata:
  short-description: "Autonomous iterative engineering loop"
---

# Pickle Rick Interactive Loop

You are entering the Pickle Rick autonomous engineering lifecycle for a Codex workspace where the persona has already been installed globally or via a repo-local override.

## Behavior

1. Confirm Pickle Rick was installed with `bash install.sh` or a compatible repo-local override
2. Check for an existing session: `node $HOME/.codex/pickle-rick/bin/get-session.js --last`
3. If no session exists, create one: `node $HOME/.codex/pickle-rick/bin/setup.js "<task>"`
4. Draft the PRD: `node $HOME/.codex/pickle-rick/bin/draft-prd.js <session-dir> "<task>"`
5. Refine the PRD into tickets: `node $HOME/.codex/pickle-rick/bin/spawn-refinement-team.js <session-dir>`
6. Execute tickets sequentially: `node $HOME/.codex/pickle-rick/bin/mux-runner.js <session-dir>`
7. Inspect or control the run with `status`, `metrics`, `cancel`, and `retry`

## Execution Contract

- Guaranteed path: Node orchestration plus sequential `codex exec --full-auto`
- Required signals: process exit code, `state.json`, `refinement_manifest.json`, ticket files, and repository working tree changes
- Do not assume undocumented native-agent controls such as `list_agents`, `send_message`, or fork-context internals unless a future validation document adds them

## Completion Signals

Output `<promise>EPIC_COMPLETED</promise>` when all tickets are done.
Output `<promise>TASK_COMPLETED</promise>` when a single ticket is done.
