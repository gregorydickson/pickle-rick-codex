# PRD: P1 Stale-Process Leakage

## Status

Ready for refinement.

## Summary

Fix lifecycle defects that allow Pickle Rick recovery daemons, brokers,
executors, runners, test keepalives, descendants, sockets, and PID files to
survive after their owning session or test has ended. The solution must repair
ownership and shutdown contracts at the spawn sites; it must not be a cleanup
script, broad process-name scan, or `pkill` workaround.

This is a P1 autonomous-reliability defect. A stopped pipeline makes autonomy,
reliability, quality, and every other project metric zero. The inverse failure
also matters: preserving detached autonomy cannot mean retaining abandoned
processes forever. Legitimate detached and recoverable sessions must survive
parent-shell exit, while processes proven stale must terminate without operator
intervention.

All implementation work is confined to the `pickle-rick-codex` source
repository. Deployed files under `~/.codex` and `~/.claude` are evidence only
and must not be edited. Active pipelines must not be restarted, cancelled,
signalled, or otherwise disturbed during investigation or verification.

## Motivation and production evidence

- 27 orphaned `autonomous-owner-recovery-daemon.js` processes remained under
  PPID 1 for more than a day. They had no children but collectively consumed
  approximately 1.31 GiB RSS and 34% CPU.
- Old `app-server-broker.mjs` processes survived for days after their working
  directories were deleted.
- Stale brokers retained app-server children and Unix sockets despite having no
  connected clients.
- Test fixtures leaked `setInterval` keepalives, `descendant.mjs` processes,
  and supervised Codex executors.
- Repeated test and development runs accumulated more than 50 stale Node
  processes.

The current checked-in source contains detached and keepalive spawn surfaces in
`extension/src/services/codex.ts`, `citadel.ts`, `execution-gate.ts`,
`detached-launch.ts`, `orphan-reaper.ts`, `session.ts`,
`extension/src/bin/spawn-morty.ts`, and several integration-test fixtures.
`app-server-broker.mjs` and `descendant.mjs` are not presently discoverable as
checked-in paths, so refinement must identify whether they are generated test
artifacts, dependency-owned programs, historical names, or an untracked spawn
surface before assigning ownership.

## Users and critical journeys

### Autonomous pipeline operator

- Starts a detached pipeline, closes the parent shell, and expects the valid
  pipeline and its recovery mechanism to continue.
- Completes or cancels a session and expects its entire owned process tree and
  runtime artifacts to disappear within a bounded grace period.
- Leaves a genuinely abandoned session unattended and expects authenticated,
  bounded cleanup without manual process-table surgery.

### Contributor running tests

- Runs lifecycle tests repeatedly, including assertion failures and timeouts,
  and receives control back with no test-owned processes, sockets, or PID files.
- Can identify every live test process by captured identity and owner metadata;
  unrelated processes are never selected by name.

### Broker client

- Keeps a broker alive while a valid owning session/client remains connected.
- Disconnects from a broker whose owner or working directory is gone and
  expects the broker to reap its app-server tree and owned artifacts.

## Lifecycle investigation and root-cause deliverable

Before implementation, produce a checked-in lifecycle inventory with file and
line references for every spawn site for:

1. `autonomous-owner-recovery-daemon.js`;
2. `app-server-broker.mjs`, including dynamically generated or dependency-owned
   copies;
3. supervised executors and runners;
4. test keepalives and `descendant.mjs` fixtures.

For each process, document:

- owner identity and persisted ownership metadata;
- expected lifetime and terminal states;
- parent, child, descendant, session, and process-group topology;
- detached, `ref`/`unref`, and parent-death semantics;
- heartbeats, leases, grace periods, PID/start identity, and PID-reuse defense;
- PID files, Unix sockets, and other owned artifacts;
- signals sent and received, escalation policy, and bounded shutdown path;
- cleanup behavior on completion, cancellation, failure, timeout, assertion
  failure, parent death, deleted working directory, and client disconnect;
- every timer or listener capable of retaining the event loop;
- every missing or bypassable `finally`, `afterEach`, or `afterAll` path.

The analysis must explain the observed leaks causally, not infer ownership from
the process name. Unknown provenance is a finding that must be resolved before
the corresponding implementation ticket can be accepted.

## Functional requirements

### Explicit ownership contracts

1. Every long-lived spawned process must have one explicit owner, a persisted
   process identity where recovery crosses process boundaries, and a documented
   termination contract.
2. Process identity must bind at least PID, process start identity, expected
   command/immutable executable evidence, owner/session identity, and process
   group where applicable.
3. Cleanup must revalidate identity immediately before signalling. PID reuse,
   ambiguous identity, or changed topology must fail closed and never signal an
   unrelated process.
4. Child processes must receive termination through a controlled process group
   or explicit authenticated descendant traversal. Broad process-name matching
   is prohibited.

### Recovery daemon lifecycle

5. A recovery daemon must exit after its supervised session reaches completion,
   cancellation, invalid state, or demonstrable abandonment and all required
   reconciliation is complete.
6. Parent-shell death alone is not abandonment. A valid detached pipeline with
   current persisted state and ownership/lease evidence must remain recoverable.
7. Abandonment decisions must use persisted session state, authenticated process
   identity, lease/heartbeat evidence, and bounded grace periods. Missing one
   sample or a transient read failure must not destroy an active pipeline.
8. Daemon startup and periodic reconciliation must detect redundant daemons and
   stale terminal owners safely, while preserving exactly one valid recovery
   owner where recovery remains necessary.
9. Polling timers that do not define the daemon's required lifetime must be
   `unref()`'d; the daemon's own required lifetime must be governed by explicit
   ownership state rather than accidental event-loop retention.

### Broker lifecycle

10. A broker must stop when its authenticated owner is gone and no valid clients
    remain, especially when its working directory no longer exists.
11. A connected broker must remain alive while its valid client/session remains
    active, including across the original parent-shell exit where detachment is
    part of the contract.
12. Broker shutdown must reject new work, close listeners/connections, reap the
    complete authenticated app-server child tree, close handles, and remove only
    its owned socket and PID files.
13. `SIGTERM` and `SIGINT` handlers must run idempotent bounded cleanup and then
    exit. A second termination signal may force the already-authenticated tree
    down but must not widen the ownership boundary.

### Executors, runners, and tests

14. Supervised executors/runners must publish ownership immediately after spawn
    and clear or transfer it atomically at every terminal/handoff boundary.
15. All spawned test processes must be registered immediately after spawn in a
    top-level test-owned registry containing captured process identities and
    owned artifacts.
16. Test teardown must execute from `finally`, `afterEach`, or `afterAll` paths
    for success, assertion failure, rejection, cancellation, and timeout. Cleanup
    must be idempotent and bounded.
17. Fixture timers not intentionally under test must be `unref()`'d or explicitly
    cleared. Fixture processes intended to test keepalive behavior must still be
    owned and reaped by the top-level registry.
18. Startup reconciliation, if introduced, may clean only identities proven
    stale and must leave all active or ambiguous sessions untouched.

## Machine-checkable acceptance criteria

1. A real completed-session lifecycle test captures every daemon, runner,
   executor, broker, and app-server PID/process group and proves each identity is
   absent after a documented bounded grace period; its owned socket and PID paths
   are also absent.
2. The same real-process assertion passes after explicit session cancellation.
3. Dedicated failure and timeout tests intentionally fail/expire fixture work,
   then prove from captured process identities that no fixture process remains.
4. A detached-pipeline test kills only the original parent shell, verifies the
   authenticated pipeline/recovery owners remain live, then completes the
   session and proves bounded cleanup.
5. An abandonment test expires persisted lease/heartbeat evidence under a dead
   authenticated owner, performs no operator cleanup, and proves reconciliation
   reaps the complete owned tree and artifacts.
6. A broker test deletes its working directory, disconnects all clients, and
   proves the broker, app-server descendants, socket, and PID file disappear.
7. A paired broker test keeps a valid client/session connected and proves the
   broker and authenticated app-server remain live beyond the abandonment grace
   period.
8. A PID-reuse test substitutes a live unrelated process at the recorded numeric
   PID with mismatched start/command/owner identity and proves no signal is sent
   to it while stale ownership evidence remains fail-closed and diagnosable.
9. A lifecycle soak executes the focused real-process suite at least 25 times.
   Its final process-table and filesystem audit reports zero test-owned live
   identities and zero stale socket/PID files.
10. Existing recovery, retry, cancellation, detached execution, and autonomous
    reliability suites pass without weakening assertions or skipping tests.
11. Leak assertions use captured real PIDs, process groups, start identities, and
    filesystem artifacts; mocked `spawn`/`kill` assertions alone cannot satisfy
    criteria 1–9.
12. A source audit test or lint rule proves every test fixture spawn is registered
    immediately and that its suite has a top-level cleanup path.
13. Static source checks find no broad cleanup via `pkill`, `killall`, or
    process-name-only matching in the new lifecycle implementation.
14. TypeScript typecheck, ESLint, the focused lifecycle suite, the 25-iteration
    soak, and the full release gate all exit zero.
15. A before/after process-table report records exact test-owned identities and
    proves active pre-existing pipelines were neither signalled nor changed.

## Verification contract

Refinement may adjust test filenames, but it must preserve equivalent dedicated
commands and record exact output in the final verification report. The expected
command surface is:

```bash
npm --prefix extension run build
node --test extension/tests/process-lifecycle.test.js extension/tests/broker-lifecycle.test.js extension/tests/session-liveness.test.js extension/tests/orphan-reaper.test.js
for iteration in $(seq 1 25); do node --test extension/tests/process-lifecycle.test.js extension/tests/broker-lifecycle.test.js; done
npm --prefix extension run typecheck
npm --prefix extension run lint
npm run release:gate
```

The soak harness must perform its own captured-identity/process-table and
socket/PID-file audit after every iteration and fail immediately on a leak. The
final report must list commands, exit codes, test counts, bounded grace periods,
captured identities, artifact paths, and evidence that unrelated active
pipelines were unchanged.

## Deliverables

- Root-cause analysis with file and line references and a complete spawn/lifetime
  matrix.
- Minimal source changes that repair ownership, signalling, shutdown, and
  teardown behavior at the responsible lifecycle boundaries.
- Regression tests for normal exit, failure, timeout, cancellation, parent
  death, deleted working directory, broker disconnect/continued connection,
  abandonment, and PID reuse.
- A 25-iteration real-process soak and final process-table/artifact audit.
- Verification report containing exact commands and results.
- Remaining risks and intentionally deferred cases, each with an owner and
  follow-up condition.

## Out of scope

- Editing deployed runtime files under `~/.codex` or `~/.claude`.
- Restarting, cancelling, or signalling active pipelines to make tests pass.
- Broad `pkill`, `killall`, process-name matching, or an operator cleanup script
  as the product fix.
- Treating parent-shell death by itself as proof of abandonment.
- Replacing authenticated ownership with short global timeouts that can kill
  slow but valid autonomous work.
- Unrelated pipeline features, performance tuning, or refactors not required to
  close a demonstrated lifecycle defect.

## Technical notes and constraints

- Work from the confirmed repository root before every git operation;
  `loanlight/` itself is not a Git repository.
- Preserve the existing detached-execution contract and the prime directive:
  valid pipelines keep running until completion, explicit cancellation, or a
  verified unsafe/corrupt terminal state.
- Prefer existing process-identity and orphan-reaper primitives over parallel
  PID logic. Any missing identity fields should be added once at the shared
  boundary and consumed consistently.
- Use monotonic durations for grace/lease decisions where possible; persist
  wall-clock timestamps only where restart recovery requires them.
- Signal handlers and teardown paths must be idempotent, race-safe, and bounded.
- Tests must use unique temporary ownership namespaces and never inspect or reap
  processes they did not create.
