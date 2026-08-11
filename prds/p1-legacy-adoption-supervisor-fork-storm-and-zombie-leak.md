# P1 — Bounded legacy-adoption fleet ownership

**Filed:** 2026-08-10  
**Status:** Refined for implementation  
**Component:** Legacy adoption ownership and supervision  
**Severity:** P1 — an unbounded fleet can degrade the entire host

## Outcome

Replace unbounded per-session adoption-supervisor creation with one durable, capacity-limited fleet
per canonical Pickle data root. Requests above capacity are durable FIFO records with no process,
tmux pane, or polling loop. They promote autonomously when a slot becomes safe to reuse. Existing
executor zombie containment, exact identity fencing, and launch/restart WAL behavior remain
protected invariants.

The prime directive is autonomous development. A queued or recovering pipeline must continue
without a human, installer retry, CLI invocation, hook, or interactive agent. If the pipeline stops,
autonomy, reliability, quality, and every dependent metric are zero.

## Observed incident

A developer machine became broadly unresponsive. Measured state before cleanup:

| Metric | Value |
| --- | --- |
| Total processes | 9,325 |
| Zombie (`<defunct>`) processes | 8,288 |
| Live `legacy-adoption-executor*` processes | 79–130 (churning) |
| Distinct `pickle-adoption-supervisor-*` tmux sessions | 38 |
| Resident memory held by the fleet | 4.9 GB |
| Load average (1m) | 15.28, peaking to 51.06 during teardown |

Every attributable zombie's parent was a `legacy-adoption-executor-supervisor.js` process. All 38
supervisor sessions had been created the previous day and had written zero files to their session
directories in the preceding 30 minutes. That observation describes the incident; directory mtime
is not authoritative evidence of semantic idleness and must not control production retirement.

Killing the 38 tmux sessions dropped the process count to about 1,000 and the zombie count to 2,
and freed 4.9 GB. Roughly 53 executors survived tmux teardown reparented to PID 1 and required exact
follow-up cleanup.

## Confirmed causes

### Fork amplification

The original report estimated discovery as `1 + 2N` `ps` processes and assumed discovery ran on
every one-second supervision poll. Investigation corrected both claims. Full discovery cost
`1 + 4N`: capture and inspect each invoked two `ps` processes per candidate. Full discovery occurred
in restart/recovery paths, while steady supervision used two targeted `ps` calls per supervisor per
poll. Fleet cardinality amplified both costs.

### Zombie accumulation

The supervisor spawned an asynchronous detached executor and then permanently blocked its Node
event loop with synchronous `Atomics.wait` polling. When an executor exited, libuv could not process
its child-exit notification while the parent remained inside the synchronous loop, leaving the child
as a zombie until the supervisor returned or exited. A macOS reproduction kept the parent alive and
observed the exited child as `Z+ <defunct>` throughout the blocking wait.

The earlier `spawnSync` timeout hypothesis was disproven.

## Implemented containment — preserve as invariants

The following work is already shipped and is not to be redesigned:

- Executor discovery uses one immutable
  `ps -ww -axo pid,pgid,sess,state,lstart,command` snapshot, rejects zombies, and performs no
  per-candidate capture/inspect fanout before selection.
- Executors carry an exact no-space spec-hash marker; ambiguous pre-marker processes fail closed.
- A synchronously reaped launcher reparents the detached executor so a supervisor using synchronous
  `Atomics.wait` does not own an asynchronous child.
- Initial-launch and restart WALs fence spawn/capture windows, preserve the same nonce/spec authority
  during recovery, and converge exact duplicates.
- Migration excludes only exact mutable authority artifacts and their atomic temporary residues
  while preserving competing receipts.
- No operation signals a PID, PGID, pane, or tmux session without immutable attributable identity.

All existing supervisor, owner, migration, zombie, integration, and installed-runtime tests remain
release gates. New work is authored in `extension/src`; compiled `extension/bin` and
`extension/services` artifacts are produced by `npm --prefix extension run build`.

## Scope decision and authority contract

The capacity domain is one canonical `PICKLE_DATA_ROOT`, not the source runtime root, target runtime
root, or host as a whole. Textual and symlink aliases of the same existing root converge on one
identity. Genuinely distinct overrides are separate, visibly reported capacity domains. A future
host-wide policy requires a separate host authority and is out of scope.

The root must exist before enqueue. Its versioned identity consists of `realpath`, device, and inode,
persisted after verifying same-user ownership and rejecting group/other write permission. Session
membership uses the canonical sessions root and session map with path-component-aware containment,
never string prefix matching. A deleted and recreated root with a different filesystem identity is a
different authority and must fail closed against old records.

Each root has exactly two bounded control-plane stacks:

1. A deterministic tmux coordinator owner whose shell restarts the coordinator process with bounded
   backoff.
2. One detached root guardian, started through the synchronously reaped launcher pattern, that
   validates immutable coordinator state and recreates the coordinator tmux owner after tmux loss.

The coordinator validates and recreates the guardian. Both use persisted generation, nonce, exact
argv hash, immutable process/tmux identity, and compare-and-swap under the root publication lock.
Neither may rotate authority while an attributable older window is unresolved. Coordinator-process
or coordinator-tmux loss recovers without one guardian per request. Simultaneous loss of both
authorities, such as host reboot, resumes on the next authenticated runtime entrypoint; durable
claims still prevent duplicate launch. Hooks, native-agent fanout, and interactive Codex are not
recovery authorities.

The first implementation ticket must encode and test this authority contract before any process
launch behavior changes. If the bounded two-authority topology cannot be expressed with existing
identity and synchronous-launch primitives, that ticket fails closed rather than weakening
caller-free recovery.

## Fleet durable protocol

### Configuration

- Configuration key: `legacy_adoption_fleet_capacity`.
- Default: `4`.
- Valid values: integers `1..32`. A malformed explicit value returns a typed configuration error and
  launches nothing.
- Effective capacity and provenance are persisted in coordinator authority state and updated under
  the publication lock.
- Reducing capacity below attributable occupancy never kills legitimate work. Incumbents are
  grandfathered and new admission pauses until occupancy falls below capacity.

### Durable records and trust boundary

The implementation contract must define versioned validators, integrity binding, restrictive file
permissions, and atomic-write rules for:

- Fleet authority: canonical root identity, capacity/provenance, coordinator
  state/generation/nonce/binding, guardian identity, and next enqueue sequence.
- Request and receipt: immutable request ID, canonical root/session identity, source and target
  runtime descriptors, optional validation-session identity, exact spec hash, publication nonce,
  enqueue sequence, state, timestamps, and retry metadata.
- Claim/launch WAL: request ID, sequence, coordinator generation, immutable claim/owner nonce, spec
  hash, stage, and captured tmux/manager/executor identities.
- Quarantine/dead-letter evidence: typed permanent or transient classification, bounded attempt
  epoch, next retry, evidence hash, and operator-visible reason.

The trust boundary is same-user local runtime state. “Identity-fenced” and “attributable” mean exact
process/tmux/spec/nonce binding; they do not imply protection from a malicious same-user writer.

### State machines and linearization

Coordinator states are `booting -> reconciling -> running -> closing -> closed`, bound to a
generation and immutable tmux/guardian evidence. Closing commits only under the publication lock
after re-reading queue, claims, owner evidence, and generation. A concurrent enqueue either cancels
closing in the current generation or creates a strictly newer generation; delayed old writes fail
their generation compare-and-swap.

Request states are `queued -> claiming -> launching -> ready -> active -> terminal`, with legal exits
to `cancelled`, `recovering`, or `quarantined`. Quarantine is durable dead-letter state and does not
keep an otherwise empty coordinator alive. A corrected request is new; corrupt immutable bytes are
not silently retried as changed data.

The enqueue linearization point is an atomically committed request plus monotonic sequence allocation
under the publication lock. Re-enqueue of the same canonical session and exact spec returns its
existing nonterminal receipt. A conflicting spec returns a typed conflict without mutation.

The admission linearization point is the claim WAL written after a capacity check against a
reconciled fleet snapshot. `claiming`, `launching`, `ready`, `active`, imported-live, and any
`recovering` request with a possibly live attributable window consume one slot. `queued`, `terminal`,
`cancelled`, and `quarantined` consume none. Release occurs exactly once, only after durable terminal
or cancellation evidence and proof that every attributable manager, executor, pane, and window has
exited or been safely reaped.

FIFO order is ascending coordinator-assigned enqueue sequence among eligible requests. Cancelled,
terminal, and permanently quarantined entries are skipped. A transiently failing entry retains its
sequence but yields until `next_retry_at`, so it cannot block later eligible work. Each retry epoch
uses attempts at 250 ms, 1 s, and 4 s, then enters a nonblocking recovery lane capped at 5 s. A
semantic evidence-hash change begins a new bounded epoch.

### Import and admission

Before a new claim, reconciliation inventories durable session/request/owner records and takes
exactly one process-table snapshot plus one bounded tmux inventory snapshot. Candidate validation is
pure against those observations; no per-candidate `ps` or tmux inspection occurs before selection.

All attributable live legacy owners are imported and counted. Stable import order is `started_at`,
then canonical session identity. Imported owners do not enter queued FIFO. If imports exceed
capacity, legitimate incumbents are grandfathered, admission pauses, and natural terminal/cancel
transitions reduce occupancy. Only exact duplicate windows under the same immutable
session/spec/nonce authority may converge, using existing identity-safe reaping. Ambiguous or corrupt
evidence beside a possibly live window consumes a recovery slot and is neither overwritten nor
signalled until resolved.

The coordinator is control plane only. Admitted sessions retain isolated per-session tmux manager
owners. Every initial start and shell restart validates root identity, fleet generation, claim nonce,
and spec hash. Queued requests have no per-session tmux owner, shell, Node process, timer, or poll
loop.

The coordinator claim WAL checkpoints: claim committed; nonce/spec sealed; manager launch pending;
tmux created; binding captured; manager-ready identity validated; active committed; terminal cleanup;
and claim released. It nests above, and does not replace, existing executor launch/restart WALs.
Recovery reuses the same claim/owner nonce until every attributable older window is proven absent.

### Adoption, cancellation, and receipts

Owner APIs, `LegacyAdoptionDependencies.startWatchdog`, and the adoption CLI expose a discriminated
receipt: `queued | launching | ready | terminal | cancelled | quarantined`.

- A queued receipt contains request ID, sequence, canonical root/session identity, spec hash, queue
  status, and coordinator generation. It never contains ready-only identity fields.
- A ready receipt publishes only when claim, owner nonce, argv/spec hash, immutable manager/executor
  identities, tmux pane binding, and persisted executor status agree.
- `prepare` returns promptly with structured success for a durably queued handoff, records it in the
  adoption transaction, and stops before controller fencing or quiescence. The legacy controller
  stays live.
- Autonomous promotion resumes that same transaction with no installer, CLI, hook, human, or
  interactive agent.
- The request seals source/target runtime descriptors and revalidates them at claim. Missing or
  incompatible runtime material enters typed nonblocking recovery.
- Queued cancellation atomically terminalizes without launch. Cancellation racing a claim uses
  request-state compare-and-swap. Launching/active cancellation reuses identity-safe teardown, and
  promotion follows only after exact slot release.

## Reconciliation, backoff, and retirement

- Reconciliation starts at 250 ms and doubles to a 5 s maximum while the semantic evidence hash is
  unchanged. Deterministic tests use no jitter.
- Queue generation, request/claim stage, owner/manager/executor generation or status,
  cancellation/terminal evidence, tmux binding, WAL presence, configuration generation, and retry
  deadline are semantic wake inputs. File or directory mtime is never semantic progress.
- Under a healthy coordinator, terminal-to-next-claim latency is at most 6 s.
- Existing manager lease renewal keeps its tighter contract; fleet backoff may not weaken it.
- The fleet closes only when no queued, claiming, launching, ready, active, imported-live, or
  live-window recovery evidence remains. Diagnostic terminal/cancelled/dead-letter records may stay.
- After fenced `closed` publication, coordinator tmux and guardian exit. A later enqueue creates a new
  generation under the publication lock. Cleanup always targets immutable identity.

## Machine-checkable acceptance criteria

1. With capacity `C`, newly admitted slot occupancy never exceeds `C`. Grandfathered imports above
   `C` are reported separately, are not killed, and block new claims until occupancy is below `C`.
2. Concurrent enqueues receive unique monotonic sequences. Exact duplicate enqueue is idempotent;
   conflicting spec is rejected. The oldest eligible request promotes after exact slot release
   without another caller.
3. Queued requests create zero per-session processes, panes, tmux sessions, timers, or polling
   stacks.
4. Coordinator-process loss is recovered by its tmux owner; coordinator-tmux loss is recovered by
   the single root guardian. Recovery retains generation/nonce/spec claims, never duplicates an
   admitted owner/executor, and never exceeds capacity.
5. Each multi-candidate reconciliation epoch uses exactly one `ps` snapshot and one bounded tmux
   inventory, with no per-candidate capture/inspect fanout.
6. Import accounts for every attributable incumbent before admission. Ambiguous evidence is
   isolated without signalling or overwriting a live window; unrelated work continues when capacity
   is genuinely free.
7. Crash injection at every coordinator claim/launch/release checkpoint converges with the same
   claim nonce, exactly one exact-spec owner/executor or safely reaped attributable windows, and no
   lost request.
8. Queued `prepare` leaves the legacy controller pre-quiescence, returns a distinct durable queued
   receipt, and later autonomous promotion resumes the same transaction. Only full identity
   agreement publishes ready.
9. Cancellation in queued, claiming, launch-pending, ready/active, restart-WAL, and terminalizing
   states releases exactly one slot only after attributable cleanup; no unauthenticated identity is
   signalled.
10. Permanent invalid requests become durable nonblocking dead letters. Transient failures follow
    bounded epochs and cannot starve later eligible work. Semantic evidence changes restart recovery.
11. Closing raced by enqueue produces either a live current generation or a newer generation with
    the request visible. Empty retirement removes both control stacks; recreation rejects stale
    authority.
12. Existing one-snapshot discovery, no-direct-async-child, spec-marker, launch/restart WAL,
    migration, zombie, and exact-cleanup regressions remain green.
13. A required Darwin/tmux soak runs 50 sessions at capacity 4, with at least 46 simultaneously
    queued at peak. It injects imported overflow, malformed request, manager death,
    coordinator-process death, coordinator-tmux loss, cancellation, drain, retirement, and
    recreation. Every valid nonterminal request promotes within 30 s of eligibility. Its ticket
    verification invokes the newly implemented harness directly as
    `node extension/scripts/legacy-adoption-fleet-soak.js --sessions 50 --capacity 4 --timeout-seconds 900`;
    refinement must not require a package script that does not exist before the ticket runs. The
    structured verification environment uses `mode: merge`, an empty `required` list, and
    `vars: { PICKLE_DARWIN_SOAK: "1" }`; it must not depend on ambient shell or tmux environment.
14. During the soak there is at most one coordinator tmux stack and one guardian per root; queued
    stack count is zero; newly admitted manager/executor pairs are at most capacity; transient
    launcher overlap is at most one per launching claim for at most 5 s; coordinator-plus-guardian
    RSS growth is at most 256 MiB; total attributable RSS is at most
    `256 MiB + 128 MiB * (grandfathered_live + capacity)`.
15. After every fault phase and final cleanup, attributable zombies are zero, host zombie count is at
    or below its pre-phase baseline, exact-argv orphan count is zero, and residual attributable
    processes/tmux sessions are zero. A machine-readable report records inventories, peak RSS,
    promotions, faults, and cleanup.
16. `npm run release:gate`, a clean temporary `bash install.sh`, and `npm run test:installed` pass
    using compiled entrypoints. A skipped Darwin soak is pending and cannot satisfy the P1 gate.

## Sequencing

1. Freeze and test the authority, root identity, schemas, state machines, slot equation, FIFO,
   retries, retirement, and stale-generation contract without changing production launch behavior.
2. Implement canonical identity, configuration, durable publication, receipts, and queued
   cancellation without launching tmux.
3. Implement coordinator/guardian recovery while keeping the production route dark.
4. Add bounded snapshot import and incumbent accounting before permitting admission.
5. Add coordinator claim/launch WAL recovery and claim-bound per-session manager restarts.
6. Add promotion, cleanup, fairness, and all-state cancellation.
7. Atomically switch adoption and installer flow to fleet receipts; queued success and the
   pre-quiescence stop must land together.
8. Add migration, status, diagnostics, installed-artifact coverage, and deterministic release gates.
9. Run and retain the real Darwin 50-session fault soak as the final P1 gate.

## Detection signature

```sh
ps -Ao stat | grep -c Z
ps -Ao ppid=,command= | grep '[l]egacy-adoption-executor-supervisor'
```

Diagnose on attributable zombie count, exact adoption-process cardinality, and durable fleet state.
Load average alone is not authoritative because unrelated applications can dominate swap pressure.

## Non-goals and trap doors

- No host-wide claim across distinct data-root overrides in this feature.
- No deduplication by source runtime root; legitimate sessions may share installed code.
- No capacity-as-refusal and no queued per-session loop.
- No termination based on directory mtime.
- No rotation of claim/owner nonce while an old exact window may exist.
- No weakening of exact argv/spec/tmux/process identity or signalling by bare PID, PGID, or name.
- No direct async executor child ownership by a synchronously polling supervisor.
- No removal or replacement of existing executor launch/restart WALs.
- No hooks, native-agent fanout, or interactive process in the guaranteed path.
- No verification manifest may depend on a package script introduced by the same ticket. New
  harnesses use an explicit `node <path> ...` process command so preflight can validate the
  executable contract before implementation.
- No required soak opt-in may be ambient-only. Bind `PICKLE_DARWIN_SOAK=1` in the verification
  command's persisted environment contract so detached and resumed runners behave identically.
