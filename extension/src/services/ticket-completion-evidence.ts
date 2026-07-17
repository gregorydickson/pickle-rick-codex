/**
 * Unified ticket completion-evidence oracle (codex port of the claude
 * `ticket-completion-evidence` module, Strategy B — path/id-based helpers).
 *
 * Single conceptual entity for "is this ticket attributably done, and what commit
 * proves it?". `evaluateCompletionEvidence` is THE ONE completion predicate; every
 * completion decision site routes through it (or its `gateForPhantomDoneRevert`
 * adapter). `readEvidence` must have no callsite outside this module.
 *
 * EvidenceKind is the two-state collapse: `committed` (a git-reachable attributable
 * commit — explicit field, git-verified inferred field, or a git-log scan hit) or
 * `absent` (no usable evidence, an unreachable/foreign/baseline explicit SHA, or a
 * stored-but-unverifiable inferred SHA). A non-repo workingDir is a legitimate
 * `absent`, never an exception.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  readFrontmatterField,
  upsertFrontmatterField,
  normalizeCompletionCommitField,
  readTextFile,
} from './pickle-utils.js';
import { readDeclaredFiles } from './ticket-declared-files.js';
import { getTicketById, updateTicketStatus } from './tickets.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Greenness verdict for the R-CECB declared-file-touch scan pass. Codex has no
 * worker fast-test gate, so `greenGate` defaults to the conservative not-green
 * `'errored'` and the file-touch pass is inert unless a caller injects a gate.
 */
export type GateVerdict = 'passing' | 'red' | 'errored';

export type EvidenceKind = 'committed' | 'absent';

/** Attribution source for a `committed` EvidenceResult. */
export type EvidenceVia = 'explicit' | 'inferred' | 'scan';

/**
 * Refusal detail for an `absent` EvidenceResult.
 *   no_evidence                          — no field/scan match at all.
 *   baseline_sha                         — explicit sha equals a session baseline (R-CXOR-2, hard-absent).
 *   unreachable_explicit_unattributable  — explicit sha unreachable AND inferred/scan found nothing (R-AICF).
 *   foreign_attribution                  — explicit sha positively attributed to a DIFFERENT ticket (R-OMA, hard-absent).
 */
export type EvidenceAbsentReason =
  | 'no_evidence'
  | 'baseline_sha'
  | 'unreachable_explicit_unattributable'
  | 'foreign_attribution';

export interface EvidenceResult {
  kind: EvidenceKind;
  sha?: string;
  /** Attribution source when kind === 'committed'. */
  via?: EvidenceVia;
  /** Refusal detail when kind === 'absent'. */
  absentReason?: EvidenceAbsentReason;
  /** R-CCR-1: true when per-ticket workingDir was unusable and fallbackDir succeeded. */
  usedFallback?: boolean;
}

/** Context needed to locate and probe a ticket's completion evidence. */
export interface EvidenceCtx {
  /** Session root directory. Used with ticketId to resolve the ticket path. */
  sessionDir?: string;
  /** Short ticket id. Used with sessionDir to resolve the ticket path. */
  ticketId?: string;
  /** Absolute path to the ticket markdown file; overrides sessionDir+ticketId. */
  ticketPath?: string;
  /** Working directory for git probe operations. */
  workingDir: string;
  /** Optional epoch for filtering git-log commits before session start. */
  startTimeEpoch?: number | null;
  /** R-CCR-1: fallback directory when workingDir is unusable for git. */
  fallbackDir?: string;
  /** R-CXOR-2: baseline commit SHA at session start — rejected as completion evidence. */
  startCommit?: string | null;
  /** R-CXOR-2: pinned SHA at session bootstrap — rejected as completion evidence. */
  pinnedSha?: string | null;
  /** R-PDUP: extra ids/r_codes treated as OWN attribution by the R-OMA check. */
  ownAttributionTokens?: string[];
  /** R-CECB: greenness oracle for the declared-file-touch scan pass. */
  greenGate?: () => GateVerdict;
}

/** Options for persistEvidence. */
export interface PersistOpts {
  /**
   * 'best-effort': write the frontmatter field; swallow git-stage failure (a
   *   non-repo workingDir is a legitimate state per R-AFCC-STAGE).
   * 'required': write the frontmatter field; throw if git-stage fails.
   */
  stage: 'best-effort' | 'required';
}

export interface PersistResult {
  action: 'written' | 'already_present' | 'no_file' | 'unwritable';
  sha?: string;
  /** True when git-stage succeeded; false when it failed (best-effort only). */
  staged?: boolean;
}

/** Policy for gateForPhantomDoneRevert (reserved; no flag gates revert policy today). */
export interface RevertPolicy {
  flags?: Record<string, unknown> | null;
}

export type RevertDecision = {
  action: 'keep' | 'revert';
  kind: EvidenceKind;
  sha?: string;
  fallbackFired?: boolean;
};

// ---------------------------------------------------------------------------
// Private helpers (ported inline; kept module-private per single-seam invariant)
// ---------------------------------------------------------------------------

function resolveTicketPath(ctx: Pick<EvidenceCtx, 'sessionDir' | 'ticketId' | 'ticketPath'>): string | null {
  if (typeof ctx.ticketPath === 'string' && ctx.ticketPath.length > 0) return ctx.ticketPath;
  if (
    typeof ctx.sessionDir === 'string' && ctx.sessionDir.length > 0 &&
    typeof ctx.ticketId === 'string' && ctx.ticketId.length > 0
  ) {
    return getTicketById(ctx.sessionDir, ctx.ticketId)?.filePath ?? null;
  }
  return null;
}

/**
 * 3-way git cat-file probe. Returns 'exists' (exit 0), 'not-exists' (exit 1), or
 * 'git-could-not-run' (exit 128, ENOENT, ETIMEDOUT, SIGTERM — git gave no answer).
 * Codex's boolean `commitExists` collapses error+not-found, so the explicit-SHA
 * branch needs this distinction for the fallbackDir retry.
 */
function probeCatFile(workingDir: string, sha: string): 'exists' | 'not-exists' | 'git-could-not-run' {
  try {
    execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'exists';
  } catch (err) {
    const e = err as { status?: number | null; code?: string; signal?: string | null };
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' || e.status === 128 || e.code === 'ENOENT') {
      return 'git-could-not-run';
    }
    return 'not-exists';
  }
}

/** Boolean commit-reachability; false for both "not found" and "git error". */
function commitReachable(workingDir: string, sha: string): boolean {
  return probeCatFile(workingDir, sha) === 'exists';
}

function extractRCodeTokens(title: string | null): string[] {
  if (!title) return [];
  return [...new Set(Array.from(title.matchAll(/\bR-[A-Z0-9-]+\b/gi), (m) => m[0].toLowerCase()))];
}

function readFirstHeading(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() || null;
}

/** R-CXOR-2: true when sha is a session baseline (start_commit or pinned_sha). */
function isBaselineSha(sha: string, ctx: Pick<EvidenceCtx, 'startCommit' | 'pinnedSha'>): boolean {
  return (ctx.startCommit != null && sha === ctx.startCommit) ||
    (ctx.pinnedSha != null && sha === ctx.pinnedSha);
}

/**
 * Probes whether an explicit SHA is git-reachable, falling back to fallbackDir on
 * 'git-could-not-run'. Returns the EvidenceResult on success, or null when the SHA
 * is not reachable (caller maps null → absent / fall-through).
 */
function probeExplicitSha(sha: string, workingDir: string, fallbackDir?: string): EvidenceResult | null {
  const primary = probeCatFile(workingDir, sha);
  if (primary === 'exists') return { kind: 'committed', sha };
  if (primary !== 'git-could-not-run') return null;
  if (!fallbackDir || fallbackDir === workingDir) return null;
  if (probeCatFile(fallbackDir, sha) === 'exists') return { kind: 'committed', sha, usedFallback: true };
  return null;
}

type GitLogEntry = { sha: string; epoch: number; message: string };

function parseGitLog(raw: string): GitLogEntry[] {
  return raw
    .split('\n---pickle-commit-boundary---\n')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [sha = '', epochRaw = '0', ...parts] = e.split('\n');
      return { sha: sha.trim(), epoch: Number(epochRaw.trim()) || 0, message: parts.join('\n').trim() };
    })
    .filter((e) => /^[0-9a-f]{40}$/i.test(e.sha));
}

/** R-CECB: the files a commit touched, via `git show --name-only`. Best-effort → []. */
function commitTouchedFiles(workingDir: string, sha: string): string[] {
  try {
    const raw = execFileSync(
      'git',
      ['-C', workingDir, 'show', '--name-only', '--format=', sha],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return raw.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** True when a git-tracked path in `touched` matches a declared path (exact membership). */
function touchesDeclared(touched: string[], declared: string[]): boolean {
  if (declared.length === 0) return false;
  const set = new Set(declared);
  return touched.some((t) => set.has(t));
}

/** Commit subject+body for `sha`, via `git show -s --format=%B`. Best-effort → ''. */
function commitMessage(workingDir: string, sha: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', workingDir, 'show', '-s', '--format=%B', sha],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

function wordBoundaryRe(token: string): RegExp {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

/**
 * R-OMA: every OTHER ticket id (directory basename) under `sessionDir`, lowercased,
 * excluding `selfTicketId`. Best-effort → []. Used to detect a commit whose subject
 * positively names a DIFFERENT ticket (foreign attribution).
 */
function enumerateSiblingTicketIds(sessionDir: string, selfTicketId: string | null): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const selfLower = selfTicketId ? selfTicketId.toLowerCase() : null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name.toLowerCase();
    if (selfLower && id === selfLower) continue;
    out.push(id);
  }
  return out;
}

/**
 * R-OMA: true iff the explicit-completion-commit `sha` is POSITIVELY attributed to
 * a DIFFERENT ticket — its commit message word-boundary-matches a sibling ticket id
 * WITHOUT also naming THIS ticket's id / r_code / ownAttributionTokens. Default is
 * accept; absence of a match is never grounds for rejection (explicit-SHA-wins).
 */
function isForeignAttributedExplicitSha(
  sha: string,
  ctx: Pick<EvidenceCtx, 'workingDir' | 'sessionDir' | 'ticketId' | 'ownAttributionTokens'>,
  selfId: string | null,
  selfRCode: string | null,
): boolean {
  if (!ctx.sessionDir) return false;
  const siblingIds = enumerateSiblingTicketIds(ctx.sessionDir, selfId);
  if (siblingIds.length === 0) return false;
  const message = commitMessage(ctx.workingDir, sha).toLowerCase();
  if (!message) return false;
  const ownTokens = [
    ...(selfId ? [selfId.toLowerCase()] : []),
    ...(selfRCode ? [selfRCode.trim().toLowerCase()] : []),
    ...(ctx.ownAttributionTokens ?? []).map((t) => t.trim().toLowerCase()),
  ].filter(Boolean);
  if (ownTokens.some((t) => wordBoundaryRe(t).test(message))) return false;
  return siblingIds.some((id) => wordBoundaryRe(id).test(message));
}

/**
 * R-CECB: declared in-scope files for every OTHER ticket under `sessionDir`, via the
 * codex path/id-based `readDeclaredFiles(sessionDir, siblingId)`. Best-effort → [].
 */
function enumerateSiblingDeclaredFiles(
  sessionDir: string,
  selfTicketId: string | null,
): Array<{ ticketId: string; files: string[] }> {
  const out: Array<{ ticketId: string; files: string[] }> = [];
  const selfLower = selfTicketId ? selfTicketId.toLowerCase() : null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (selfLower && entry.name.toLowerCase() === selfLower) continue;
    const files = readDeclaredFiles(sessionDir, entry.name);
    if (files.length > 0) out.push({ ticketId: entry.name, files });
  }
  return out;
}

/**
 * R-CECB: declared-file-touch attribution. A post-startTimeEpoch commit attributes
 * iff it touches ≥1 declared file, is NOT ambiguous (no sibling declares a touched
 * file), AND greenGate() === 'passing'. Newest green wins (entries are newest-first).
 */
function scanGitLogByFileTouch(
  entries: GitLogEntry[],
  args: {
    workingDir: string;
    startTimeEpoch?: number | null;
    declaredFiles: string[];
    siblingDeclared: Array<{ ticketId: string; files: string[] }>;
    greenGate: () => GateVerdict;
  },
): { sha: string } | null {
  const startEpoch = Number(args.startTimeEpoch);
  for (const e of entries) {
    if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch) continue;
    const touched = commitTouchedFiles(args.workingDir, e.sha);
    if (!touchesDeclared(touched, args.declaredFiles)) continue;
    const ambiguous = args.siblingDeclared.some((s) => touchesDeclared(touched, s.files));
    if (ambiguous) continue;
    if (args.greenGate() !== 'passing') continue;
    return { sha: e.sha };
  }
  return null;
}

/**
 * Pass 1 of the git-log scan: ref-token attribution (word-boundary ticket-id +
 * word-boundary r_code). Captures the HEAD-pass entries into `headEntriesOut` so the
 * caller can reuse them for the file-touch fallback.
 */
function scanGitLogByRefToken(
  commands: string[][],
  args: {
    matchers: string[];
    rCodeRe: RegExp | null;
    startTimeEpoch?: number | null;
    headEntriesOut: GitLogEntry[];
  },
): { sha: string } | null {
  const startEpoch = Number(args.startTimeEpoch);
  const lastCmd = commands[commands.length - 1];
  const matcherRes = args.matchers.map((t) => wordBoundaryRe(t));
  const checkEntry = (e: GitLogEntry): { sha: string } | null => {
    if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch) return null;
    const lower = e.message.toLowerCase();
    if (matcherRes.some((re) => re.test(lower))) return { sha: e.sha };
    if (args.rCodeRe && args.rCodeRe.test(lower)) return { sha: e.sha };
    return null;
  };
  for (const gitArgs of commands) {
    let parsed: GitLogEntry[];
    try {
      const raw = execFileSync('git', gitArgs, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      parsed = parseGitLog(raw);
    } catch {
      continue;
    }
    if (gitArgs === lastCmd) args.headEntriesOut.push(...parsed);
    for (const entry of parsed) {
      const matched = checkEntry(entry);
      if (matched) return matched;
    }
  }
  return null;
}

function scanGitLog(args: {
  workingDir: string;
  ticketId: string | null;
  title: string | null;
  startTimeEpoch?: number | null;
  ticketPath?: string | null;
  rCode?: string | null;
  declaredFiles?: string[];
  siblingDeclared?: Array<{ ticketId: string; files: string[] }>;
  greenGate?: () => GateVerdict;
}): { sha: string } | null {
  const matchers = [
    ...(args.ticketId ? [args.ticketId.toLowerCase()] : []),
    ...extractRCodeTokens(args.title),
  ];
  const rCodeRe: RegExp | null = (() => {
    if (!args.rCode) return null;
    const code = args.rCode.trim().toLowerCase();
    if (!code) return null;
    return wordBoundaryRe(code);
  })();
  const declaredFiles = args.declaredFiles ?? [];
  if (matchers.length === 0 && !rCodeRe && declaredFiles.length === 0) return null;

  const commands: string[][] = [];
  if (args.ticketPath) {
    commands.push(['-C', args.workingDir, 'log', '-n', '20', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', '--', args.ticketPath]);
  }
  commands.push(['-C', args.workingDir, 'log', '-n', '50', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', 'HEAD']);

  const headEntries: GitLogEntry[] = [];
  const refHit = scanGitLogByRefToken(commands, {
    matchers,
    rCodeRe,
    startTimeEpoch: args.startTimeEpoch,
    headEntriesOut: headEntries,
  });
  if (refHit) return refHit;

  if (declaredFiles.length > 0 && headEntries.length > 0) {
    return scanGitLogByFileTouch(headEntries, {
      workingDir: args.workingDir,
      startTimeEpoch: args.startTimeEpoch,
      declaredFiles,
      siblingDeclared: args.siblingDeclared ?? [],
      greenGate: args.greenGate ?? (() => 'errored' as GateVerdict),
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point 1: readEvidence
// ---------------------------------------------------------------------------

export function readEvidence(ctx: EvidenceCtx): EvidenceResult {
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return { kind: 'absent' };

  const content = readTextFile(tPath);
  if (content === null) return { kind: 'absent' };

  // --- Explicit completion_commit field ---
  const explicit = normalizeCompletionCommitField(readFrontmatterField(tPath, 'completion_commit'));
  let unreachableExplicit = false;
  if (explicit) {
    // R-CXOR-2: a ticket whose only "commit" is the session baseline did no real work.
    if (isBaselineSha(explicit, ctx)) {
      process.stderr.write(
        `[ticket-completion-evidence] baseline sha ${explicit} rejected as completion evidence — ticket did no work beyond session start\n`,
      );
      return { kind: 'absent', absentReason: 'baseline_sha' };
    }
    const reachable = probeExplicitSha(explicit, ctx.workingDir, ctx.fallbackDir);
    if (reachable) {
      const selfId = readFrontmatterField(tPath, 'id') ?? ctx.ticketId ?? null;
      const selfRCode = readFrontmatterField(tPath, 'r_code');
      // R-OMA: reject a reachable explicit SHA ONLY when positively attributed to a
      // DIFFERENT ticket. Default = accept (explicit-SHA-wins).
      if (isForeignAttributedExplicitSha(explicit, ctx, selfId, selfRCode)) {
        process.stderr.write(
          `[ticket-completion-evidence] explicit sha ${explicit} rejected — positively attributed to a different ticket (R-OMA foreign-attribution)\n`,
        );
        return { kind: 'absent', absentReason: 'foreign_attribution' };
      }
      return { ...reachable, via: 'explicit' };
    }
    // R-AICF: explicit SHA present but UNREACHABLE (hallucinated/dropped stamp). Fall
    // through to inferred/scan so real untagged work is still attributable.
    unreachableExplicit = true;
    process.stderr.write(
      `[ticket-completion-evidence] explicit sha ${explicit} unreachable — falling through to inferred/scan attribution (R-AICF)\n`,
    );
  }

  const absent = (): EvidenceResult => ({
    kind: 'absent',
    absentReason: unreachableExplicit ? 'unreachable_explicit_unattributable' : 'no_evidence',
  });

  // --- Inferred field (completion_commit_inferred) ---
  const inferredField = normalizeCompletionCommitField(readFrontmatterField(tPath, 'completion_commit_inferred'));
  if (inferredField) {
    if (commitReachable(ctx.workingDir, inferredField)) {
      return { kind: 'committed', sha: inferredField, via: 'inferred' };
    }
    // R-AFCC-STAGE: stored but git-unverifiable → absent (the scan would fail too).
    return absent();
  }

  // --- Git log scan (ref token + R-CECB declared-file-touch) ---
  const selfId = readFrontmatterField(tPath, 'id') ?? ctx.ticketId ?? null;
  const declaredFiles = ctx.sessionDir && ctx.ticketId ? readDeclaredFiles(ctx.sessionDir, ctx.ticketId) : [];
  const scan = scanGitLog({
    workingDir: ctx.workingDir,
    ticketId: selfId,
    title: readFrontmatterField(tPath, 'title') ?? readFirstHeading(content),
    startTimeEpoch: ctx.startTimeEpoch,
    ticketPath: tPath,
    rCode: readFrontmatterField(tPath, 'r_code'),
    declaredFiles,
    siblingDeclared: ctx.sessionDir ? enumerateSiblingDeclaredFiles(ctx.sessionDir, selfId) : [],
    greenGate: ctx.greenGate,
  });
  if (scan) return { kind: 'committed', sha: scan.sha, via: 'scan' };

  return absent();
}

// ---------------------------------------------------------------------------
// Entry point 2: persistEvidence
// ---------------------------------------------------------------------------

/**
 * Writes sha into the ticket's completion_commit frontmatter field and optionally
 * git-stages the file.
 *
 * Codex adaptation of the R-WDTF pointer-survival guarantee: a manifest-backed
 * session re-materializes ticket files from the refinement manifest on the next
 * status rewrite, so a file-only write would be dropped. When the ctx carries a
 * (sessionDir, ticketId), persist through `updateTicketStatus` so the pointer lands
 * in BOTH the manifest and the file; otherwise fall back to a direct frontmatter write.
 */
export function persistEvidence(ctx: EvidenceCtx, sha: string, opts: PersistOpts): PersistResult {
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return { action: 'no_file' };
  if (readTextFile(tPath) === null) return { action: 'no_file' };

  const existing = readFrontmatterField(tPath, 'completion_commit');
  if (existing) return { action: 'already_present', sha: existing };

  let persisted = false;
  if (ctx.sessionDir && ctx.ticketId) {
    try {
      updateTicketStatus(ctx.sessionDir, ctx.ticketId, { completion_commit: sha });
      persisted = readFrontmatterField(tPath, 'completion_commit') === sha;
    } catch {
      // fall through to the direct frontmatter write
    }
  }
  if (!persisted) {
    upsertFrontmatterField(tPath, 'completion_commit', sha);
    persisted = readFrontmatterField(tPath, 'completion_commit') === sha;
  }
  if (!persisted) return { action: 'unwritable' };

  let staged = false;
  try {
    execFileSync('git', ['-C', ctx.workingDir, 'add', '--', tPath], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    staged = true;
  } catch {
    if (opts.stage === 'required') throw new Error(`persistEvidence: git add failed for ${tPath}`);
    // best-effort: staged stays false
  }

  return { action: 'written', sha, staged };
}

// ---------------------------------------------------------------------------
// Entry point 3: evaluateCompletionEvidence — the ONE completion predicate
// ---------------------------------------------------------------------------

/** Decision site invoking the predicate; only 'done-flip' consults the worker-gate verdict. */
export type CompletionDecisionKind = 'done-flip' | 'phantom-watch' | 'attribution';

export interface CompletionDecisionCtx extends EvidenceCtx {
  /** R-CXOR-2: session start_commit — REQUIRED wiring, null when genuinely unknown. */
  startCommit: string | null;
  /** R-CXOR-2: session pinned_sha — REQUIRED wiring, null when genuinely unknown. */
  pinnedSha: string | null;
  decision: CompletionDecisionKind;
  /**
   * R-CWGE: worker-gate verdict resolver, consulted ONLY when decision === 'done-flip'.
   * Fail-closed: red/absent/un-injected refuses the Done-flip. Codex has no worker gate,
   * so this rung ships present-but-unused (codex never selects 'done-flip').
   */
  workerGateVerdict?: () => { verdict: 'green' | 'red' | 'absent'; computedVia: string };
  /** R-CCEM: the worker's own announced completion SHA (state.activity), or null. */
  announcedSha?: () => string | null;
  /** R-CCGR: backoff (ms) before the single absent re-read; defaults to the env-clamped 500ms. */
  rereadBackoffMs?: number;
}

export type CompletionDecisionRefusalReason =
  | EvidenceAbsentReason
  | 'worker_gate_red'
  | 'worker_gate_unavailable';

export type CompletionDecision =
  | { ok: true; sha: string; via: EvidenceVia | 'announcement'; usedFallback?: boolean }
  | {
      ok: false;
      reason: CompletionDecisionRefusalReason;
      gate?: { verdict: 'green' | 'red' | 'absent'; computedVia: string };
    };

/** R-CCGR: process-blocking sleep for the single backoff re-read (no child process). */
function sleepSyncMs(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer disabled — skip the backoff
  }
}

/** R-CCGR backoff before the single re-read; env-overridable, clamped ≤5000ms. */
function defaultRereadBackoffMs(): number {
  const raw = Number(process.env.PICKLE_GUARD_REREAD_BACKOFF_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 5000);
  return 500;
}

function isAcceptedEvidence(r: EvidenceResult): r is EvidenceResult & { kind: 'committed'; sha: string } {
  return r.kind === 'committed' && !!r.sha;
}

function refuseAbsent(evidence: EvidenceResult): CompletionDecision {
  return { ok: false, reason: evidence.absentReason ?? 'no_evidence' };
}

/**
 * R-CCEM: absent evidence + a worker-announced SHA → persist the announced SHA as
 * `completion_commit_inferred` and re-probe. readEvidence still gates on reachability
 * + baseline rejection, so a bad/baseline SHA stays absent. Never overwrites an
 * existing explicit `completion_commit`. Best-effort.
 */
function recoverFromAnnouncement(ctx: CompletionDecisionCtx): EvidenceResult | null {
  if (!ctx.announcedSha) return null;
  let announced: string | null;
  try {
    announced = ctx.announcedSha();
  } catch {
    return null;
  }
  if (!announced) return null;
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return null;
  try {
    if (readTextFile(tPath) === null) return null;
    if (!readFrontmatterField(tPath, 'completion_commit')) {
      upsertFrontmatterField(tPath, 'completion_commit_inferred', announced);
      return readEvidence(ctx);
    }
  } catch {
    // best-effort — fall through to existing classification
  }
  return null;
}

/**
 * R-WUWC promote-once: write the accepted SHA into the explicit completion_commit
 * field (persistEvidence no-ops when already present), then re-probe so the accepted
 * evidence is the durable on-disk state. Best-effort.
 */
function promoteOnceAndReprobe(ctx: CompletionDecisionCtx, sha: string): EvidenceResult | null {
  try {
    const result = persistEvidence(ctx, sha, { stage: 'best-effort' });
    if (result.action === 'written') {
      return readEvidence(ctx);
    }
  } catch {
    // best-effort — fall through to existing classification
  }
  return null;
}

/**
 * R-CWGE: Done requires a GREEN worker-gate verdict; fail-closed. Consulted ONLY for
 * 'done-flip'. An un-injected or throwing resolver reads as absent/unavailable and refuses.
 */
function workerGateRefusal(ctx: CompletionDecisionCtx): CompletionDecision | null {
  if (ctx.decision !== 'done-flip') return null;
  let gate: { verdict: 'green' | 'red' | 'absent'; computedVia: string };
  try {
    gate = ctx.workerGateVerdict
      ? ctx.workerGateVerdict()
      : { verdict: 'absent', computedVia: 'unavailable' };
  } catch {
    gate = { verdict: 'absent', computedVia: 'unavailable' };
  }
  if (gate.verdict === 'green') return null;
  return {
    ok: false,
    reason: gate.verdict === 'red' ? 'worker_gate_red' : 'worker_gate_unavailable',
    gate,
  };
}

/**
 * The ONE completion predicate. Ladder:
 *   1. readEvidence (explicit-reachable-wins; baseline + foreign hard-absent; R-AICF
 *      unreachable-explicit falls to inferred/scan).
 *   2. Single backoff re-read on absent (R-CCGR flush race).
 *   3. Announcement recovery (R-CCEM).
 *   4. Promote-once durable write (R-WUWC) + re-probe.
 *   5. decision === 'done-flip' ONLY: worker-gate verdict fail-closed (R-CWGE).
 * 'phantom-watch' and 'attribution' apply everything EXCEPT the verdict (R-DSAN never-discard).
 */
export function evaluateCompletionEvidence(ctx: CompletionDecisionCtx): CompletionDecision {
  let evidence = readEvidence(ctx);
  if (!isAcceptedEvidence(evidence)) {
    sleepSyncMs(ctx.rereadBackoffMs ?? defaultRereadBackoffMs());
    evidence = readEvidence(ctx);
  }
  let via: EvidenceVia | 'announcement' | undefined = evidence.via;
  if (!isAcceptedEvidence(evidence)) {
    const recovered = recoverFromAnnouncement(ctx);
    if (recovered) {
      evidence = recovered;
      if (isAcceptedEvidence(recovered)) via = 'announcement';
    }
  }
  if (!isAcceptedEvidence(evidence)) return refuseAbsent(evidence);
  const viaAtAccept: EvidenceVia | 'announcement' = via ?? evidence.via ?? 'scan';
  const reprobed = promoteOnceAndReprobe(ctx, evidence.sha);
  if (reprobed) evidence = reprobed;
  if (!isAcceptedEvidence(evidence)) return refuseAbsent(evidence);
  const refusal = workerGateRefusal(ctx);
  if (refusal) return refusal;
  return { ok: true, sha: evidence.sha, via: viaAtAccept, usedFallback: evidence.usedFallback };
}

// ---------------------------------------------------------------------------
// Entry point 4: gateForPhantomDoneRevert
// ---------------------------------------------------------------------------

/**
 * Thin adapter over `evaluateCompletionEvidence` ({ decision: 'phantom-watch' }) so the
 * phantom-Done watcher and the Done-flip gate share ONE policy. ok → keep; else revert.
 */
export function gateForPhantomDoneRevert(ctx: EvidenceCtx, policy?: RevertPolicy): RevertDecision {
  // Reserved for future policy-gated revert behavior; no flag gates revert today.
  void policy;
  const decision = evaluateCompletionEvidence({
    ...ctx,
    startCommit: ctx.startCommit ?? null,
    pinnedSha: ctx.pinnedSha ?? null,
    decision: 'phantom-watch',
    // Watcher re-checks are not racing a done-promise flush; skip the sleep.
    rereadBackoffMs: 0,
  });
  if (decision.ok) {
    return { action: 'keep', kind: 'committed', sha: decision.sha, fallbackFired: decision.usedFallback };
  }
  return { action: 'revert', kind: 'absent' };
}
