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
  type PrdSeal,
} from './prd-seal.js';
import { readJsonFile } from './pickle-utils.js';
import { validateRefinementAcceptance } from './refinement-artifacts.js';
import { readManifest, ticketDependencyIds } from './tickets.js';
import type { PersistedState } from './state-manager.js';

export function initializePrdDevelopmentPipeline(sessionDir: string): void {
  const journalPath = path.join(sessionDir, 'logical-pipeline.json');
  if (!fs.existsSync(journalPath)) createLogicalPipeline(sessionDir, path.basename(sessionDir));
}

export function ensureSessionPrdSeal(sessionDir: string): PrdSeal {
  const state = readJsonFile<PersistedState>(path.join(sessionDir, 'state.json'), null);
  if (!state || typeof state.working_dir !== 'string' || !state.working_dir) {
    throw new Error('Cannot seal PRD without a valid session working directory.');
  }
  const acceptance = validateRefinementAcceptance(sessionDir, {
    workingDir: state.working_dir,
    verifyRepository: true,
  });
  if (!acceptance.ok || !acceptance.receipt) {
    throw new Error(`Cannot seal an unaccepted refinement: ${acceptance.reason}.`);
  }
  const prdPath = path.join(sessionDir, 'prd.md');
  const prd = fs.readFileSync(prdPath, 'utf8');
  const manifest = readManifest(sessionDir);
  const executionBase = String(state.start_commit || 'unversioned');
  const acceptanceCriteria = manifest.tickets.flatMap((ticket) => (
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
      ticket_verification: manifest.tickets.map((ticket) => ({ ticket_id: ticket.id, verification: ticket.verification || [] })),
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
    const executionEvents = logical.events.filter((event) => !['pipeline_created', 'prd_sealed'].includes(event.kind));
    if (logical.control_state !== 'autonomous_execution' || logical.lease !== null || executionEvents.length > 0) {
      throw new Error('Accepted refinement changed after autonomous execution acquired durable history.');
    }
    requestPrdRevision(
      sessionDir,
      'Accepted refinement contract changed before executor ownership.',
      'Replace the pre-launch PRD seal with the newly accepted refinement contract.',
    );
    const revised = approvePrdRevision(sessionDir, sealInput);
    const seal = readPrdSeal(sessionDir);
    if (revised.prd_seal_hash !== seal.semantic_hash) throw new Error('Revised logical pipeline seal projection mismatch.');
    return seal;
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
