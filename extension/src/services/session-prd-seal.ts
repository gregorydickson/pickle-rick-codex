import fs from 'node:fs';
import path from 'node:path';
import {
  approvePrdRevision,
  beginAutonomousExecution,
  createLogicalPipeline,
  readLogicalPipeline,
  requestPrdRevision,
} from './durable-supervisor.js';
import {
  assertPrdSealMatchesPrd,
  createPrdSeal,
  readPrdSeal,
  writePrdSeal,
  type CreatePrdSealInput,
  type PrdAcceptanceCriterion,
  type PrdSeal,
} from './prd-seal.js';
import { readJsonFile } from './pickle-utils.js';
import { validateRefinementAcceptance } from './refinement-artifacts.js';
import { enrichRefinementManifest, readManifest, ticketDependencyIds } from './tickets.js';
import type { PersistedState } from './state-manager.js';
import { recordExecutionControlTelemetry } from './productive-autonomy.js';
import { isVerificationContractError } from './verification-env.js';
import type { RefinementManifest, Ticket } from '../types/index.js';

interface LegacyAdoptionSealTransaction {
  schema_version: 1;
  stage: string;
  session_id: string;
  migration_content_hash?: string;
}

interface LegacyAdoptionMigration {
  content_hash: string;
  resume_checkpoint?: { phase?: string };
}

function readManifestForFencedLegacyAdoption(
  sessionDir: string,
  expectedMigrationContentHash: string,
  state: PersistedState,
): RefinementManifest {
  assertFencedLegacyAdoptionSeal(sessionDir, expectedMigrationContentHash, state);

  try {
    return readManifest(sessionDir);
  } catch (error) {
    if (!isVerificationContractError(error)) throw error;
  }

  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const raw = readJsonFile<RefinementManifest>(manifestPath, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.tickets)) {
    throw new Error(`Invalid refinement manifest JSON: ${manifestPath}`);
  }
  const verificationRepresentations = raw.tickets.map((ticket) => (
    ticket.verification ?? ticket.verify
  ));
  const safeToEnrich: RefinementManifest = {
    ...structuredClone(raw),
    tickets: raw.tickets.map((ticket) => {
      const sanitized = { ...structuredClone(ticket), verification: [] } as Ticket;
      delete sanitized.verify;
      return sanitized;
    }),
  };
  const enriched = enrichRefinementManifest(safeToEnrich).manifest;
  enriched.tickets = enriched.tickets.map((ticket, index) => ({
    ...ticket,
    verification: verificationRepresentations[index],
  }));
  return enriched;
}

function assertFencedLegacyAdoptionSeal(
  sessionDir: string,
  expectedMigrationContentHash: string,
  state: PersistedState,
): void {
  const transaction = readJsonFile<LegacyAdoptionSealTransaction>(
    path.join(sessionDir, 'legacy-session-adoption-transaction.json'),
    null,
  );
  const migration = readJsonFile<LegacyAdoptionMigration>(
    path.join(sessionDir, 'installed-runtime-migration.json'),
    null,
  );
  if (!transaction
    || transaction.schema_version !== 1
    || transaction.stage !== 'migrated'
    || transaction.session_id !== path.basename(sessionDir)
    || transaction.migration_content_hash !== expectedMigrationContentHash
    || !migration
    || migration.content_hash !== expectedMigrationContentHash
    || migration.resume_checkpoint?.phase !== 'verification_contract_repair'
    || state.active !== true
    || Number(state.tmux_runner_pid) > 0
    || Number(state.worker_pid) > 0
    || Number(state.active_child_pid) > 0
    || state.active_child_identity
    || state.step !== 'verification_contract_repair'
    || state.failure_kind !== 'verification_contract_failed') {
    throw new Error('Legacy adoption PRD sealing requires an exact quiesced migration repair fence.');
  }
}

export function initializePrdDevelopmentPipeline(sessionDir: string): void {
  const journalPath = path.join(sessionDir, 'logical-pipeline.json');
  if (!fs.existsSync(journalPath)) createLogicalPipeline(sessionDir, path.basename(sessionDir));
}

export function extractAuthoritativeAcceptanceCriteria(markdown: string): PrdAcceptanceCriterion[] {
  const lines = markdown.split(/\r?\n/);
  const criteria: PrdAcceptanceCriterion[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(AC-[A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[:—-]\s*(.*))?\s*$/i);
    if (!heading) continue;
    const depth = heading[1].length;
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const nextHeading = lines[cursor].match(/^(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= depth) break;
      body.push(lines[cursor]);
    }
    const title = String(heading[3] || '').trim();
    const bodyText = body.join('\n').trim();
    const text = [title, bodyText].filter(Boolean).join('\n\n');
    if (!text) throw new Error(`Authoritative acceptance criterion ${heading[2]} has no text.`);
    criteria.push({ id: heading[2], text });
    index = cursor - 1;
  }
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) throw new Error(`Duplicate authoritative acceptance criterion id: ${criterion.id}.`);
    ids.add(criterion.id);
  }
  return criteria;
}

function resolveSessionPrdSeal(
  sessionDir: string,
  approveRevision: boolean,
  legacyAdoptionMigrationHash?: string,
): PrdSeal {
  const state = readJsonFile<PersistedState>(path.join(sessionDir, 'state.json'), null);
  if (!state || typeof state.working_dir !== 'string' || !state.working_dir) {
    throw new Error('Cannot seal PRD without a valid session working directory.');
  }
  if (legacyAdoptionMigrationHash) {
    assertFencedLegacyAdoptionSeal(sessionDir, legacyAdoptionMigrationHash, state);
  }
  const acceptance = validateRefinementAcceptance(sessionDir, {
    workingDir: state.working_dir,
    verifyRepository: true,
    preserveMalformedVerification: Boolean(legacyAdoptionMigrationHash),
  });
  if (!acceptance.ok || !acceptance.receipt) {
    throw new Error(`Cannot seal an unaccepted refinement: ${acceptance.reason}.`);
  }
  const prdPath = path.join(sessionDir, 'prd.md');
  const prd = fs.readFileSync(prdPath, 'utf8');
  const refinedPrdPath = path.join(sessionDir, 'prd_refined.md');
  const refinedPrd = fs.existsSync(refinedPrdPath) ? fs.readFileSync(refinedPrdPath, 'utf8') : '';
  const manifest = legacyAdoptionMigrationHash
    ? readManifestForFencedLegacyAdoption(sessionDir, legacyAdoptionMigrationHash, state)
    : readManifest(sessionDir);
  const executionBase = String(state.start_commit || 'unversioned');
  const authoritativeCriteria = extractAuthoritativeAcceptanceCriteria(refinedPrd);
  const sourceCriteria = authoritativeCriteria.length > 0
    ? authoritativeCriteria
    : extractAuthoritativeAcceptanceCriteria(prd);
  const acceptanceCriteria = sourceCriteria.length > 0
    ? sourceCriteria
    : manifest.tickets.flatMap((ticket) => (
      (ticket.acceptance_criteria || []).map((text, index) => ({
        id: `${ticket.id}-AC-${index + 1}`,
        text,
      }))
    ));
  if (acceptanceCriteria.length === 0) {
    throw new Error('Cannot seal PRD because refinement produced no acceptance criteria.');
  }
  const sealInput: CreatePrdSealInput = {
    prd,
    repository: {
      identity: `${fs.realpathSync(state.working_dir)}@${executionBase}`,
      working_directory: state.working_dir,
      execution_base_policy: `execute from sealed start commit ${executionBase} and preserve unrelated work`,
    },
    acceptance_criteria: acceptanceCriteria,
    scope_and_ownership: manifest.tickets.map((ticket) => ({
      ticket_id: ticket.id,
      allowed_paths: ticket.allowed_paths || [],
      output_artifacts: ticket.output_artifacts || [],
    })),
    dependencies_and_external_prerequisites: manifest.tickets.map((ticket) => ({
      ticket_id: ticket.id,
      depends_on: ticketDependencyIds(ticket),
      verification_env: ticket.verification_env || null,
      freeze_contract: ticket.freeze_contract || null,
    })),
    risk: manifest.tickets.map((ticket) => ({
      ticket_id: ticket.id,
      complexity_tier: ticket.complexity_tier || 'medium',
      priority: ticket.priority || null,
    })),
    decision_precedence: ['sealed PRD', 'repository AGENTS.md', 'accepted refinement manifest'],
    preservation_and_rollback: {
      preserve_unrelated_work: true,
      require_checkpoint_before_promotion: true,
      broad_destructive_git_operations: 'forbidden',
    },
    completion_definition: {
      tickets: 'all accepted refinement tickets are Done',
      terminal_state: 'completed',
    },
    release_gates: {
      ticket_verification: manifest.tickets.map((ticket) => ({
        ticket_id: ticket.id,
        acceptance_criteria: ticket.acceptance_criteria || [],
        verification: ticket.verification || [],
      })),
      final_gate: 'citadel',
    },
  };
  initializePrdDevelopmentPipeline(sessionDir);
  const logical = readLogicalPipeline(sessionDir);
  if (!fs.existsSync(path.join(sessionDir, 'prd.lock.json'))) {
    const seal = writePrdSeal(sessionDir, sealInput);
    assertPrdSealMatchesPrd(readPrdSeal(sessionDir), prd);
    beginAutonomousExecution(sessionDir);
    return seal;
  }

  const existing = readPrdSeal(sessionDir);
  const candidate = createPrdSeal({ ...sealInput, sealedAt: existing.sealed_at });
  if (candidate.semantic_hash !== existing.semantic_hash) {
    if (logical.control_state === 'prd_revision_required') {
      if (!approveRevision) {
        throw new Error('Accepted refinement changed the sealed PRD; explicit human approval is required before autonomous execution may resume.');
      }
      approvePrdRevision(sessionDir, sealInput);
      return readPrdSeal(sessionDir);
    }
    const executionEvents = logical.events.filter((event) => !['pipeline_created', 'prd_sealed'].includes(event.kind));
    if (logical.control_state !== 'autonomous_execution' || logical.lease !== null || executionEvents.length > 0) {
      throw new Error('Accepted refinement changed after autonomous execution acquired durable history.');
    }
    requestPrdRevision(
      sessionDir,
      'Accepted refinement contract changed before executor ownership.',
      'Replace the pre-launch PRD seal with the newly accepted refinement contract.',
    );
    throw new Error('Accepted refinement changed the sealed PRD; explicit human approval is required before autonomous execution may resume.');
  }

  const seal = writePrdSeal(sessionDir, sealInput);
  assertPrdSealMatchesPrd(seal, prd);
  if (logical.control_state === 'prd_development') {
    beginAutonomousExecution(sessionDir);
    return seal;
  }
  if (logical.control_state !== 'autonomous_execution' || logical.prd_seal_hash !== seal.semantic_hash) {
    throw new Error('Logical pipeline control state does not match the accepted PRD seal.');
  }
  return seal;
}

export function ensureSessionPrdSeal(sessionDir: string): PrdSeal {
  return resolveSessionPrdSeal(sessionDir, false);
}

export function ensureFencedLegacyAdoptionPrdSeal(
  sessionDir: string,
  migrationContentHash: string,
): PrdSeal {
  return resolveSessionPrdSeal(sessionDir, false, migrationContentHash);
}

/** Explicit operator action used only after reviewing a persisted PRD revision request. */
export function approveSessionPrdRevision(sessionDir: string): PrdSeal {
  const seal = resolveSessionPrdSeal(sessionDir, true);
  recordExecutionControlTelemetry(sessionDir, { post_seal_human_interventions: 1 });
  return seal;
}
