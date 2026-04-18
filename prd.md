# PRD: Pickle Rick - Codex CLI Native Port

## Summary

Port Pickle Rick from the Claude Code implementation to Codex CLI using the Codex-facing scaffolding already present in this repo:

- `.codex/skills/*/SKILL.md`
- `.codex/hooks/hooks.json`
- `.codex-plugin/plugin.json`

The port should be **Codex-aware**, but it must not depend on undocumented or unverified Codex internals. For v1, the guaranteed execution path is Node-based orchestration plus `codex exec`. Interactive native multi-agent behavior is an optimization to validate in Phase 0, not a hard dependency.

## Current Baseline

The repo is still a scaffold, not an implementation:

- `AGENTS.md`, `CLAUDE.md`, `.codex-plugin/plugin.json`, `.codex/hooks/hooks.json`, and skill manifests exist
- `bin/`, `lib/`, `tests/`, `docs/`, and `prds/` exist but are empty
- `package.json` exists, but its scripts are aspirational rather than backed by real source files
- the runtime config contract is now aligned on `config.json` for Pickle Rick runtime data, but the actual runtime implementation does not exist yet

This PRD is written against that real baseline.

## Goals

1. Port the Pickle Rick lifecycle to Codex in a way that is accurate to the installed Codex build.
2. Keep the Claude implementation as the behavioral reference while avoiding Claude-specific mechanisms that do not map cleanly.
3. Deliver a usable v1 with:
   - session setup
   - PRD drafting
   - PRD refinement
   - single-ticket execution
   - multi-ticket sequential orchestration
   - state, metrics, and retry/cancel support
4. Preserve user work safely. The port must not destroy unrelated edits during retries, failures, or cancellation.

## Non-Goals

- Replacing `pickle-rick-claude`
- Supporting multiple runtimes from this repo
- Depending on undocumented Codex agent internals as a v1 requirement
- Marketplace publishing
- Full microverse / Anatomy Park / dashboard parity in the first usable release

## V1 Decisions

### Execution Model

- **Guaranteed path**: Node scripts orchestrate work and invoke `codex exec` for automated runs.
- **Optional path**: interactive Codex usage may leverage native multi-agent controls when the installed Codex build and operator workflow support them.
- The PRD must not assume specific native controls such as `LastNTurns(0)`, `list_agents`, `send_message`, or `job_max_runtime_seconds` until Phase 0 documents them for the installed build.

### Hooks

- The repo may use project-local `.codex/hooks/hooks.json`.
- Only hook events proven to work in the installed Codex build should be treated as supported.
- Do not assume `UserPromptSubmit` support.
- Keep hook handlers short-running and bounded by the configured hook timeout.

### Config Policy

- **Codex platform config** remains `~/.codex/config.toml`.
- **Pickle Rick runtime config** for v1 is `~/.codex/pickle-rick/config.json`.
- This keeps the Pickle Rick runtime portable while avoiding confusion with Codex's own platform config.

### Rollback Safety

- Do not use `git checkout -- .` as a failure or cancel rollback strategy.
- v1 works directly in the active branch working tree and must fail open rather than attempt destructive rollback.
- Unrelated user changes must survive failure, retry, cancel, and skip flows.

### Monitoring Scope

- v1 keeps one observability path: file/state-based status and logs.
- A Codex-native agent-status dashboard is deferred until native agent controls are validated and stable.

## MVP

The MVP is Phases 0-3:

- **Phase 0**: repo bootstrap, naming/config normalization, Codex validation
- **Phase 1**: core runtime foundation
- **Phase 2**: session UX and skill flow
- **Phase 3**: ticket execution loop with sequential fallback guaranteed

The MVP must work even if native multi-agent behavior is unavailable.

## Critical User Journeys

### CUJ-1: First Run to First Ticket

1. User installs the repo locally.
2. User opens Codex in a project.
3. User triggers `pickle`.
4. Pickle Rick creates or resumes a session under `~/.codex/pickle-rick/`.
5. User drafts a PRD.
6. User refines the PRD into tickets.
7. Pickle Rick executes the first ticket.
8. User sees completed work plus verification output.

Success:

- No manual file shuffling is required.
- Session state exists and is queryable.
- At least one ticket can be completed through the supported execution path.

### CUJ-2: Resume After Interruption

1. A session stops mid-ticket.
2. User re-enters Codex and triggers `pickle`.
3. Pickle Rick finds the active session from `current_sessions.json`.
4. The orchestrator resumes from the last safe checkpoint.

Success:

- Completed work is not repeated.
- Unsafe partial rollback is avoided.

### CUJ-3: Failure, Retry, or Skip

1. A ticket fails verification or times out.
2. Pickle Rick records failure metadata and preserves the current branch state without destructive rollback.
3. User chooses retry, skip, or abort.

Success:

- State remains consistent.
- Unrelated local edits are preserved.

## Architecture

### Reference Mapping

| Claude Reference | Codex Port Decision |
|---|---|
| `.claude/commands/*.md` | `.codex/skills/*/SKILL.md` |
| Claude hook settings | Project-local `.codex/hooks/hooks.json` where supported |
| `CLAUDE.md` | `AGENTS.md` |
| `pickle_settings.json` | `config.json` for Pickle Rick runtime config |
| tmux/zellij worker subprocesses | Sequential `codex exec` guaranteed; optional native agent behavior validated separately |
| activity/state/session files | Keep JSON/JSONL compatibility under `~/.codex/pickle-rick/` |

### Data Paths

All runtime data lives under `~/.codex/pickle-rick/` unless overridden by `PICKLE_DATA_ROOT`.

| Path | Purpose |
|---|---|
| `~/.codex/pickle-rick/sessions/<id>/` | session state, tickets, logs |
| `~/.codex/pickle-rick/activity/<date>.jsonl` | activity log |
| `~/.codex/pickle-rick/current_sessions.json` | active session map |
| `~/.codex/pickle-rick/config.json` | Pickle Rick runtime config |

### Orchestration Modes

#### Mode A: Guaranteed v1 Path

Node orchestration scripts call `codex exec` sequentially for:

- PRD drafting
- refinement
- ticket implementation
- review / simplify passes

This path is always supported if `codex exec` works.

#### Mode B: Optional Native-Agent Path

When the installed Codex build and operator workflow support native agent controls reliably, interactive sessions may use them for:

- parallel PRD refinement
- ticket fanout
- richer live progress reporting

This mode is **not** a prerequisite for MVP. It is enabled only after Phase 0 validation documents a safe contract.

### State Schema

The port should preserve the existing state-file shape where practical:

```ts
interface State {
  active: boolean;
  working_dir: string;
  step: string;
  iteration: number;
  max_iterations: number;
  max_time_minutes: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  original_prompt: string;
  current_ticket: string | null;
  history: Array<{ step: string; ticket?: string; timestamp: string }>;
  started_at: string;
  session_dir: string;
  schema_version: number;
  pid?: number;
}
```

Codex-specific additions are allowed, but the state file should remain simple JSON with atomic writes and migration support.

## Implementation Plan

### Phase 0: Bootstrap and Validation

#### T0: Repo Bootstrap and Normalization

Bring the scaffold to a truthful baseline before porting behavior.

Acceptance criteria:

- `bin/`, `lib/`, `tests/`, and `docs/` gain real starter files
- `package.json` scripts point at real paths
- skill naming is normalized so path and frontmatter agree
- the runtime config policy is aligned across `prd.md`, `AGENTS.md`, and `CLAUDE.md`
- `npm test` runs real tests instead of relying on an empty glob

#### T1: Codex Validation Report

Document the installed Codex build instead of assuming behavior.

Acceptance criteria:

- `docs/codex-api-validation.md` exists
- it records the Codex version tested and the validation date
- it documents whether project-local hooks work in the target workflow
- it documents whether interactive native agent controls are usable for this project
- it documents what completion/progress signaling is reliable
- it documents the guaranteed fallback path using `codex exec`

### Phase 1: Core Runtime Foundation

#### T2: Core Utilities

Port foundational utilities from the Claude implementation into `lib/`.

Acceptance criteria:

- path resolution works for `~/.codex/pickle-rick/`
- atomic JSON writes exist
- frontmatter parsing exists
- session path resolution exists
- tests cover the happy path plus env-var overrides

#### T3: State Manager

Acceptance criteria:

- state files are written atomically
- concurrent writes are guarded
- schema migration is supported
- corrupted state is backed up and reinitialized safely
- stale lock handling is covered by tests

#### T4: Activity Logger

Acceptance criteria:

- events are written to date-partitioned JSONL
- failure to log does not crash the orchestrator
- file permissions are restricted
- tests cover empty state and write failure behavior

#### T5: Circuit Breaker and Progress Detection

Acceptance criteria:

- closed / half-open / open transitions are implemented
- progress detection uses git state and ticket history
- repeated failure signatures are normalized
- tests cover transition behavior and corruption recovery

#### T6: Git Safety Helpers

Acceptance criteria:

- a safe isolation strategy exists for ticket execution
- rollback does not destroy unrelated edits
- tests cover retry and failure cleanup behavior

#### T7: Hook Handlers

Only implement handlers for hook events proven in T1.

Acceptance criteria:

- supported hook handlers exist in `bin/`
- unsupported hook assumptions are not encoded into the runtime
- hook failures fail open unless the operation is explicitly safety-critical
- tests cover missing state and timeout behavior

### Phase 2: Session and Skill Flow

#### T8: Session Setup and Resume

Acceptance criteria:

- session directories are created under the Codex data root
- `current_sessions.json` is maintained safely
- session collision and corruption cases are handled
- resume behavior is test-covered

#### T9: `pickle-prd`

Acceptance criteria:

- interview covers what / why / who / verification / scope / constraints
- `prd.md` is written into the session
- empty input falls back to guided questioning

#### T10: `pickle-status` and `pickle-metrics`

Acceptance criteria:

- empty-state behavior is explicit and non-fatal
- status reports current step, ticket, and runtime state
- metrics report activity data when present
- tests cover zero-data paths

#### T11: Cancel and Retry

Acceptance criteria:

- cancel marks the session inactive
- retry resets ticket state safely
- neither path destroys unrelated edits
- already-completed tickets do not re-enter accidentally

### Phase 3: Execution Loop

#### T12: PRD Refinement

Acceptance criteria:

- a sequential refinement path exists using `codex exec`
- if native multi-agent behavior is validated, it can be used as an optional acceleration path
- outputs include `prd_refined.md` and a manifest of tickets
- zero-ticket refinement fails clearly without crashing

#### T13: Single-Ticket Execution

Acceptance criteria:

- one ticket can run through `research -> plan -> implement -> verify -> review -> simplify -> done`
- the ticket state is checkpointed between phases
- review can block completion until findings are addressed
- simplify cannot finalize a broken build

#### T14: Multi-Ticket Sequential Orchestration

Acceptance criteria:

- tickets execute in manifest order
- state advances between tickets
- retry / skip / abort flows are explicit
- the orchestrator works without any native-agent dependency

#### T15: Progress and Completion Signaling

Acceptance criteria:

- the guaranteed path uses a reliable file/state-based signal
- any interactive native-agent signaling is gated behind T1 validation
- tests cover phase transitions and completion detection

### Phase 4: Packaging and Docs

#### T16: Packaging

Acceptance criteria:

- `.codex-plugin/plugin.json` is internally consistent
- skill names, paths, and published names align
- `install.sh` installs locally without assuming marketplace distribution

#### T17: Documentation Port

Acceptance criteria:

- root docs are updated for Codex terminology
- no stale Claude-only commands remain outside comparison sections
- config policy is documented consistently

#### T18: Images and Static Assets

Acceptance criteria:

- referenced images exist locally
- docs point at the right asset paths

### Phase 5: Deferred Advanced Features

These are explicitly deferred until the core port is real:

- microverse convergence
- Anatomy Park
- tmux dashboard parity
- Codex-native agent-status dashboard

They may be reintroduced after the core loop is stable.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Native agent controls differ from the assumptions in the old PRD | High | Validate them in T1 and keep `codex exec` as the guaranteed path |
| Hook behavior differs between Codex workflows/builds | High | Treat hooks as build-specific until documented locally |
| Shared-tree execution destroys user work | High | Require isolation or exact patch rollback |
| The scaffold encourages fake progress because scripts/tests do not exist yet | Medium | Make T0 a hard prerequisite |
| Scope balloons back into tmux/dashboard parity too early | Medium | Keep advanced monitoring deferred |

## Open Questions

1. Which hook events are reliable in the exact Codex workflow this project targets?
2. Can interactive native-agent behavior be used consistently enough to justify an optional acceleration path?
3. What is the cleanest retry and recovery policy for direct branch execution without destructive rollback?
4. Should `pickle-orchestrate` remain a separate skill, or should `pickle` absorb orchestration for v1 simplicity?

## Success Criteria

1. The repo has a truthful runnable baseline: real source files, real tests, real scripts.
2. `docs/codex-api-validation.md` documents the installed Codex behavior instead of assuming it.
3. `pickle-prd`, `pickle-refine`, `pickle-status`, and `pickle-metrics` work on the guaranteed execution path.
4. A single ticket can complete through the full lifecycle on the guaranteed path.
5. Multiple tickets can run sequentially with safe retry/skip/abort behavior.
6. Failure handling preserves unrelated user changes.
7. Packaging and docs are internally consistent with the actual repo layout.

## Task Breakdown

| Order | ID | Title | Priority | Phase | Depends On |
|---|---|---|---|---|---|
| 10 | T0 | Repo Bootstrap and Normalization | P0 | 0 | none |
| 20 | T1 | Codex Validation Report | P0 | 0 | T0 |
| 30 | T2 | Core Utilities | P0 | 1 | T0 |
| 40 | T3 | State Manager | P0 | 1 | T2 |
| 50 | T4 | Activity Logger | P0 | 1 | T2 |
| 60 | T5 | Circuit Breaker and Progress Detection | P0 | 1 | T2 |
| 70 | T6 | Git Safety Helpers | P0 | 1 | T2 |
| 80 | T7 | Hook Handlers | P1 | 1 | T1, T2, T3 |
| 90 | T8 | Session Setup and Resume | P0 | 2 | T2, T3 |
| 100 | T9 | `pickle-prd` | P0 | 2 | T8 |
| 110 | T10 | `pickle-status` and `pickle-metrics` | P0 | 2 | T3, T4 |
| 120 | T11 | Cancel and Retry | P0 | 2 | T3, T6, T8 |
| 130 | T12 | PRD Refinement | P0 | 3 | T1, T8, T9 |
| 140 | T13 | Single-Ticket Execution | P0 | 3 | T1, T3, T5, T6 |
| 150 | T14 | Multi-Ticket Sequential Orchestration | P0 | 3 | T13 |
| 160 | T15 | Progress and Completion Signaling | P0 | 3 | T13, T14 |
| 170 | T16 | Packaging | P1 | 4 | T7, T9, T14 |
| 180 | T17 | Documentation Port | P1 | 4 | T16 |
| 190 | T18 | Images and Static Assets | P2 | 4 | none |
| 200 | T19 | Deferred Advanced Features Revisit | P2 | 5 | T14, T17 |
