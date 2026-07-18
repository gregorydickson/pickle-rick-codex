# PRD: Full `pickle-pipeline` Port For Codex

## Summary

Port the Claude-era `/pickle-pipeline` workflow into `pickle-rick-codex` as a first-class detached tmux command and skill.

The Codex port already has the constituent loops:

- build and ticket execution via `pickle` / `pickle-tmux`
- fail-closed release review via `citadel`
- correctness review via `anatomy-park`
- code-quality cleanup via `szechuan-sauce`

What is missing is the orchestration layer that runs those phases in one tmux session, under one session directory, with one monitor, resume support, and phase-aware status/cancel behavior.

This PRD adds that missing layer without reintroducing Claude-specific assumptions. The implementation must use the current Codex runtime contracts:

- `bin/mux-runner.js` for the build phase
- `bin/loop-runner.js` for advanced loop phases
- `state.json`, `loop_config.json`, and session artifacts under `~/.codex/pickle-rick/`
- detached tmux launch and locking behavior already implemented in `lib/detached-launch.js`

## Motivation

Today the Codex port exposes the phases individually, but not the lifecycle that made `pickle-pipeline` useful.

This creates three problems:

1. Users who know the Claude surface expect a single full-lifecycle command and do not get one.
2. The current Codex docs describe `anatomy-park` and `szechuan-sauce` as optional follow-up loops instead of a composable pipeline.
3. The current detached infrastructure already supports the right building blocks, but users must manually chain them and cannot resume a multi-phase run as one logical session.

## Users

- Existing Pickle Rick users migrating from `pickle-rick-claude`
- Codex users who want one long-running detached command instead of manually chaining three commands
- Maintainers who need a truthful, tested Codex equivalent of the older pipeline surface

## Goals

1. Add a first-class `pickle-pipeline` skill and CLI to the Codex port.
2. Run `pickle -> anatomy-park -> szechuan-sauce -> citadel` sequentially in one tmux session, with Citadel mandatory and final.
3. Support starting from either a task string or an existing `prd.md`.
4. Support resume at the first incomplete phase.
5. Preserve the current detached-launch safety guarantees:
   - tmux launch locks
   - cwd reservation locks
   - live-session detection
   - target immutability on resume
6. Expose pipeline phase progress through existing status and monitor surfaces.
7. Ship with automated tests that cover launch, sequencing, skip flags, resume, and failure/cancel behavior.

## Non-Goals

- Recreating Claude’s extension-only `pipeline.json` and `pipeline-runner` contracts verbatim
- Launching nested tmux sessions for downstream phases
- Requiring undocumented native-agent or hook behavior
- Changing the semantics of standalone `pickle-tmux`, `anatomy-park`, or `szechuan-sauce` beyond shared-helper extraction
- Implementing a new dashboard beyond minimal monitor/status integration

## Constraints

- The port must work with the current Node runtime and `codex exec` path.
- The pipeline runner must execute inside a single detached tmux runner window, not by invoking `anatomy-park.js` or `szechuan-sauce.js` as nested launchers.
- The runner must build on the existing session and state model instead of creating a second incompatible orchestration stack.
- Resume must not permit target mutation for advanced phases once a pipeline session exists.
- Failure and cancel flows must fail open and must not revert unrelated user work.

## User Journeys

### CUJ-1: Start Full Pipeline From A Task

1. User runs `pickle-pipeline "add retry logic to loan webhooks"`.
2. Runtime creates a session and detached tmux session.
3. Build phase creates/refines the PRD and executes tickets.
4. On success, the same runner executes the mandatory deterministic and adversarial Citadel release gate.
5. On success, the same tmux runner advances to Anatomy Park.
6. On success, the same tmux runner advances to Szechuan Sauce.
7. User reattaches later and sees the whole run under one session.

Success:

- One tmux session
- One session directory
- Three phases run in order unless skipped or blocked

### CUJ-2: Start Full Pipeline From An Existing PRD

1. User runs `pickle-pipeline --prd ./prd.md`.
2. Runtime copies the PRD into a detached session.
3. Refinement runs if needed.
4. Ticket execution starts.
5. Advanced review phases follow on success.

Success:

- No task-string workaround required
- Existing PRD bootstrap works through the same pipeline surface

### CUJ-3: Resume An Interrupted Pipeline

1. User runs `pickle-pipeline --resume`.
2. Runtime locates the last pipeline session for the cwd.
3. Runtime reads pipeline progress and resumes at the first incomplete phase.

Success:

- Completed phases are not rerun unless explicitly requested later
- The target path is unchanged

### CUJ-4: Cancel During An Active Phase

1. User cancels the active pipeline session through the existing cancel path or tmux teardown.
2. The current child runner exits.
3. The pipeline records the stop reason and does not advance to the next phase.

Success:

- No false success
- No silent advancement to later phases

## Product Surface

### New Skill

Add `.codex/skills/pickle-pipeline/SKILL.md` with a detached full-lifecycle contract.

### New CLI

Add `bin/pickle-pipeline.js` with this supported surface:

```bash
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js "task"
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js --prd ./prd.md
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js --resume
node ~/.codex/pickle-rick/extension/bin/pickle-pipeline.js --resume <session-dir>
```

Supported flags:

- `--target <path>`
- `--skip-anatomy`
- `--skip-szechuan`
- `--max-time <minutes>`
- `--worker-timeout <seconds>`
- `--on-failure=abort|skip|retry-once`
- `--anatomy-max-iterations <n>`
- `--anatomy-stall-limit <n>`
- `--anatomy-dry-run`
- `--szechuan-max-iterations <n>`
- `--szechuan-stall-limit <n>`
- `--szechuan-domain <name>`
- `--szechuan-focus "<text>"`
- `--szechuan-dry-run`

`--resume` may not be combined with `--prd` or a new task string.

## Technical Design

### Core Architecture

Implement the port as a detached launcher plus a single-session pipeline runner.

#### Launcher

`bin/pickle-pipeline.js` is responsible for:

- parsing args
- creating or resuming a session
- writing `pipeline.json`
- setting pipeline metadata in `state.json`
- creating one detached tmux session
- launching `bin/pipeline-runner.js`
- reusing the existing monitor bootstrap path

#### Runner

`bin/pipeline-runner.js` is responsible for:

- loading `pipeline.json`
- determining the next incomplete phase
- updating `pipeline-state.json`
- invoking:
  - `runSequential()` from `bin/mux-runner.js` for `pickle`
  - `runLoop()` from `bin/loop-runner.js` for `anatomy-park`
  - `runLoop()` from `bin/loop-runner.js` for `szechuan-sauce`
- preparing per-phase config before advanced phases
- stopping on failure, cancel, or preflight block
- writing final summary and exit state

### State Contracts

#### `pipeline.json`

Add a stable per-session pipeline contract:

```json
{
  "schema_version": 1,
  "phases": ["pickle", "anatomy-park", "szechuan-sauce", "citadel"],
  "target": "/abs/path",
  "task": "optional task string",
  "bootstrap_prd": "/abs/path/to/original/prd.md",
  "pickle": {
    "on_failure": "retry-once",
    "max_time_minutes": 720,
    "worker_timeout_seconds": 1200
  },
  "anatomy": {
    "max_iterations": 100,
    "stall_limit": 3,
    "dry_run": false
  },
  "szechuan": {
    "max_iterations": 50,
    "stall_limit": 5,
    "dry_run": false,
    "domain": null,
    "focus": null
  }
}
```

#### `pipeline-state.json`

Add a dynamic pipeline progress file:

```json
{
  "schema_version": 1,
  "current_phase": "pickle",
  "current_phase_index": 0,
  "phase_statuses": {
    "pickle": "done",
    "anatomy-park": "running",
    "szechuan-sauce": "todo"
  },
  "started_at": "ISO-8601",
  "phase_started_at": "ISO-8601",
  "completed_at": null,
  "last_error": null,
  "last_exit_reason": null
}
```

#### `state.json` Additions

Augment the existing `state.json` with optional fields:

- `pipeline_mode: boolean`
- `pipeline_phase: string | null`
- `pipeline_total_phases: number | null`
- `pipeline_phase_index: number | null`

These are optional additions, not a schema rewrite.

### Phase Execution Rules

#### Pickle Phase

- Use the existing detached pickle bootstrap path for task or PRD setup.
- If the session is PRD-only and missing a manifest, refinement must run before execution.
- Build phase exits according to current `mux-runner` semantics.

#### Anatomy Park Phase

- Do not launch `bin/anatomy-park.js` from inside the pipeline.
- Instead, prepare `loop_config.json` for `mode: "anatomy-park"` and invoke `runLoop(sessionDir)`.
- Persist target, dry-run, stall-limit, and max-iteration values into the loop config.

#### Szechuan Sauce Phase

- Do not launch `bin/szechuan-sauce.js` from inside the pipeline.
- Instead, prepare `loop_config.json` for `mode: "szechuan-sauce"` and invoke `runLoop(sessionDir)`.
- Persist target, dry-run, stall-limit, domain, focus, and max-iteration values into the loop config.

### Resume Semantics

- Resume finds the last pipeline session for the current repo unless an explicit session dir is provided.
- Resume must reject a non-pipeline session.
- Resume must restart at the first phase whose status is not `done`.
- Resume may not change the stored target.
- Resume may update tunable limits only where the current detached-loop model already permits safe reconfiguration.

### Monitor And Status

`bin/tmux-monitor.sh` gains a `pipeline` mode:

- runner pane tails `pipeline-runner.log`
- status pane still uses `bin/status.js`
- state pane still shows `state.json`
- worker pane still shows latest worker message

`bin/status.js` gains pipeline-aware output:

- `Pipeline Mode: Yes`
- `Pipeline Phase: anatomy-park (2/3)`
- fallback to current output when pipeline fields are absent

## Exact File Changes

### New Files

- `.codex/skills/pickle-pipeline/SKILL.md`
- `bin/pickle-pipeline.js`
- `bin/pipeline-runner.js`
- `lib/pipeline.js`
- `lib/pipeline-state.js`
- `lib/pipeline-bootstrap.js`
- `lib/pipeline-phase-setup.js`
- `prds/pickle-pipeline-port.md`

### Modified Files

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `bin/pickle-tmux.js`
- `bin/anatomy-park.js`
- `bin/szechuan-sauce.js`
- `bin/status.js`
- `bin/tmux-monitor.sh`
- `lib/detached-launch.js`
- `lib/session.js`
- `tests/helpers.js`
- `tests/install.test.js`
- `tests/session-flow.test.js`

### File-Level Intent

#### `.codex/skills/pickle-pipeline/SKILL.md`

- expose the new skill surface
- document arguments and full-lifecycle behavior

#### `bin/pickle-pipeline.js`

- parse pipeline-specific CLI flags
- create or resume pipeline sessions
- write `pipeline.json`
- launch detached tmux running `pipeline-runner.js`

#### `bin/pipeline-runner.js`

- own cross-phase orchestration
- manage `pipeline-state.json`
- call `runSequential()` and `runLoop()`
- stop on failure or cancel

#### `lib/pipeline.js`

- parse and validate `pipeline.json`
- normalize phases and flags
- resolve next runnable phase

#### `lib/pipeline-state.js`

- atomic read/write helpers for `pipeline-state.json`
- state transition helpers for start, phase advance, fail, cancel, complete

#### `lib/pipeline-bootstrap.js`

- extract reusable detached bootstrap logic from `bin/pickle-tmux.js`
- support task-based and PRD-based session creation without immediately launching `mux-runner`

#### `lib/pipeline-phase-setup.js`

- extract reusable advanced-loop prep logic currently embedded in standalone launchers
- write `loop_config.json` for anatomy and szechuan phases
- update `state.json` safely between phases

#### `bin/pickle-tmux.js`

- consume shared bootstrap helpers
- keep behavior unchanged for standalone detached build runs

#### `bin/anatomy-park.js`

- consume shared advanced-loop prep helpers
- keep standalone detached anatomy behavior unchanged

#### `bin/szechuan-sauce.js`

- consume shared advanced-loop prep helpers
- keep standalone detached szechuan behavior unchanged

#### `bin/status.js`

- surface pipeline metadata when present

#### `bin/tmux-monitor.sh`

- support `pipeline` as a monitor mode
- choose the correct runner log file for pipeline sessions

#### `lib/detached-launch.js`

- support `pipeline` mode in launch output and runner-start detection
- preserve current lock semantics

#### `lib/session.js`

- extend default state with optional pipeline metadata fields

#### `tests/helpers.js`

- fake tmux and runner helpers must recognize `pipeline-runner.js`

#### `tests/install.test.js`

- verify the `pickle-pipeline` skill is installed by `install.sh`

#### `tests/session-flow.test.js`

- add full pipeline integration coverage using the existing fake tmux harness

## Acceptance Criteria

### A1: Skill And Docs Surface

- `.codex/skills/pickle-pipeline/SKILL.md` exists
- `README.md` lists `pickle-pipeline` in the primary skill surface
- `AGENTS.md` lists `pickle-pipeline` in the skills section

Verification:

- `test -f .codex/skills/pickle-pipeline/SKILL.md`
- `rg -n "pickle-pipeline" README.md AGENTS.md .codex/skills/pickle-pipeline/SKILL.md`

### A2: Detached Launch From Existing PRD

- `bin/pickle-pipeline.js --prd <path>` launches one tmux session
- session dir contains `pipeline.json`
- pipeline runner is the launched runner, not `mux-runner.js`

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline bootstraps from --prd"`

### A3: Detached Launch From Task String

- `bin/pickle-pipeline.js "task"` creates a detached session and pipeline config
- build phase is configured as the first pipeline phase

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline bootstraps from task"`

### A4: Sequential Phase Chaining

- successful build phase advances to anatomy
- successful anatomy phase advances to szechuan
- successful szechuan phase marks the pipeline complete

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline advances through all phases"`

### A5: Skip Flags

- `--skip-anatomy` removes anatomy from the phase list
- `--skip-szechuan` removes szechuan from the phase list
- skip behavior is persisted in `pipeline.json`

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline honors skip flags"`

### A6: Resume

- `--resume` resumes the first incomplete phase
- completed phases remain marked complete
- target changes on resume are rejected

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline resumes first incomplete phase"`
- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline resume rejects target change"`

### A7: Failure And Cancel Semantics

- failed build phase stops the pipeline
- failed anatomy phase stops before szechuan starts
- cancel during any phase records a non-success exit and prevents phase advance

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline stops on phase failure"`
- `node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline does not advance after cancel"`

### A8: Status And Monitor Integration

- `bin/status.js` prints pipeline phase metadata when the session is a pipeline session
- `bin/tmux-monitor.sh` supports pipeline runner logs

Verification:

- `node --test tests/session-flow.test.js --test-name-pattern "status renders pipeline phase metadata"`
- `node --test tests/session-flow.test.js --test-name-pattern "tmux monitor supports pipeline mode"`

### A9: Install Surface

- `bash install.sh` copies the new `pickle-pipeline` skill into the Codex skills tree

Verification:

- `node --test tests/install.test.js --test-name-pattern "install copies pickle-pipeline skill"`

## Test Plan

### New Test Cases To Add

Add these named tests under `tests/session-flow.test.js` unless the harness split becomes necessary:

- `pickle-pipeline bootstraps from task`
- `pickle-pipeline bootstraps from --prd`
- `pickle-pipeline advances through all phases`
- `pickle-pipeline honors skip flags`
- `pickle-pipeline resumes first incomplete phase`
- `pickle-pipeline resume rejects target change`
- `pickle-pipeline stops on phase failure`
- `pickle-pipeline does not advance after cancel`
- `status renders pipeline phase metadata`
- `tmux monitor supports pipeline mode`

Add this named test under `tests/install.test.js`:

- `install copies pickle-pipeline skill`

### Full Verification Command

```bash
npm test
```

### Focused Verification Commands

```bash
node --test tests/install.test.js --test-name-pattern "pickle-pipeline"
node --test tests/session-flow.test.js --test-name-pattern "pickle-pipeline|pipeline phase|pipeline mode"
```

## Implementation Tickets

### T1: Pipeline Contracts And Shared Helpers

Scope:

- add `lib/pipeline.js`
- add `lib/pipeline-state.js`
- add `lib/pipeline-bootstrap.js`
- add `lib/pipeline-phase-setup.js`
- extend `lib/session.js` defaults

Acceptance criteria:

- pipeline config and state read/write are atomic
- phase normalization and next-phase resolution are tested
- shared bootstrap helpers do not change standalone `pickle-tmux` behavior

### T2: Pipeline CLI And Runner

Scope:

- add `bin/pickle-pipeline.js`
- add `bin/pipeline-runner.js`
- wire detached tmux launch

Acceptance criteria:

- task and PRD bootstrap both work
- runner chains phases in one tmux session
- resume works at phase granularity

### T3: Existing Launcher Refactor

Scope:

- update `bin/pickle-tmux.js`
- update `bin/anatomy-park.js`
- update `bin/szechuan-sauce.js`

Acceptance criteria:

- standalone commands preserve current behavior
- shared helper extraction does not break current detached-loop tests

### T4: Status, Monitor, Docs, And Install Surface

Scope:

- update `bin/status.js`
- update `bin/tmux-monitor.sh`
- update `README.md`
- update `AGENTS.md`
- update `CLAUDE.md`
- update install coverage

Acceptance criteria:

- docs and install surface mention `pickle-pipeline`
- status and monitor show pipeline-aware output

### T5: Automated Tests

Scope:

- extend `tests/helpers.js`
- extend `tests/session-flow.test.js`
- extend `tests/install.test.js`

Acceptance criteria:

- all new acceptance tests are present
- `npm test` passes

## Risks

### R1: Nested Detached Launches

Risk:

- calling standalone advanced-loop launchers from the pipeline would create nested tmux sessions and break the single-session UX

Mitigation:

- invoke `runLoop()` directly after writing phase config

### R2: Divergent State Sources

Risk:

- pipeline state and normal state may drift if phase transitions are only recorded in one file

Mitigation:

- update both `pipeline-state.json` and `state.json` in one transition helper

### R3: Resume Ambiguity

Risk:

- resuming a pipeline session could accidentally rerun completed phases

Mitigation:

- derive the resume point from persisted `phase_statuses`, not from inference on logs alone

### R4: Monitor Regression

Risk:

- changing monitor behavior could break existing detached-loop commands

Mitigation:

- add pipeline mode as an additive branch, not a rewrite of existing `pickle` vs non-`pickle` behavior

## Out Of Scope

- multi-pipeline fanout
- zellij parity
- automatic phase retries beyond the existing per-phase semantics
- a new dashboard UI
- native multi-agent acceleration

## Definition Of Done

The port is done when:

- `pickle-pipeline` exists as a skill and CLI
- one detached tmux session can run build, anatomy, and szechuan in sequence
- resume, skip, cancel, and failure behavior are tested
- docs and install surfaces expose the command truthfully
- `npm test` passes with the new coverage in place
