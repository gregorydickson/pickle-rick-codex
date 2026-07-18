# Codex Integration Validation

Current distribution baseline: `2026-07-18`, `codex-cli 0.144.5`, Node.js 20 or newer. The checked-in `validate:codex` probe records CLI identity and the command contract; it is not an authenticated execution probe.

This records the supported integration contract, not a promise that behavior observed in one Codex release applies forever. CI verifies source and installed-runtime layouts without requiring a Codex login. A release operator must run the authenticated probe when changing Codex invocation or hook behavior.

## Historical authenticated pipeline evidence (pre-hardening)

On July 18, 2026, installed runtime `0.2.17-beta.1` completed session `2026-07-18-1c18e785` against a disposable clean Git repository using `codex-cli 0.144.5`. That historical run used the earlier five-phase worker, before persisted `research_review`, `plan_review`, and `conformance` artifacts, exact Citadel acceptance-criteria coverage, progress-aware shutdown, and recoverable destructive-operation hardening were added. Its Citadel report recorded no acceptance criteria. It is useful evidence for the older sequential process shape, but it is **not current release evidence** and must not be cited as validation of the hardened pipeline now in this repository.

No replacement authenticated run is claimed here. Before calling the current build release-validated, install it into an isolated Codex home and run a clean authenticated pipeline that produces all eight lifecycle artifacts, exact acceptance-criteria conformance, a clean repository boundary, and final Citadel approval. CI remains intentionally unauthenticated and uses controlled fake Codex workers.

## Guaranteed contract

- Automation uses sequential `codex exec --full-auto` processes.
- Runtime state lives under `~/.codex/pickle-rick/`, or `PICKLE_DATA_ROOT` when set.
- `bash install.sh` installs global skills under `~/.agents/skills` and merges one managed block into `~/.codex/AGENTS.md`; it does not modify `CLAUDE.md`.
- `bash install.sh --project <path>` adds a project-local override without deleting unrelated Codex state.
- Native multi-agent features may accelerate interactive work, but are not required by the runtime.
- Hooks are disabled. `--enable-hooks` fails before mutation until authenticated validation proves the installed Codex release's event, payload, decision, and trust contracts.

## Reproducible release evidence

Run from a clean checkout:

```bash
npm ci --prefix extension
npm run release:gate

validation_root="$(mktemp -d)"
CODEX_HOME="$validation_root/codex" \
PICKLE_DATA_ROOT="$validation_root/runtime" \
bash install.sh
npm --prefix "$validation_root/runtime" test
```

The gate must prove TypeScript compilation, lint, both test tiers, package installation, and execution of the installed suite against `extension/services` and `extension/bin`. The GitHub workflow performs these checks on supported Node versions.

The installed suite covers the causal eight-phase worker and recoverable reset behavior with controlled workers. It does not substitute for the authenticated current-build pipeline required above.

For changes to Codex invocation, additionally run:

```bash
codex --version
npm run validate:codex
```

Record the date, exact CLI version, and probe result in the pull request or release notes. Do not rewrite the baseline merely because a newer CLI is installed.

## Disabled hook surface

The legacy template maps `SessionStart`, `Stop`, `PreToolUse`, and `PostToolUse` handlers to compiled files under `extension/bin/`, but it is inactive reference material. A handler existing on disk is not evidence that a Codex build emits the event or accepts the template's matcher, payload, and decision schemas. The installer therefore rejects `--enable-hooks` before changing state.
