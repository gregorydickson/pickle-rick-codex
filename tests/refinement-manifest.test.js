import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  enrichRefinementManifest,
  ensureTicketFilesMaterialized,
  fallbackRefinePrd,
  getTicketById,
  readManifest,
  summarizeTickets,
  ticketDependencyIds,
  validateRefinementManifest,
  writeManifest,
  writeTicketFiles,
} from '../lib/tickets.js';
import { makeTempRoot } from './helpers.js';

test('fallbackRefinePrd builds tickets from the PRD task breakdown table', () => {
  const prd = [
    '# PRD',
    '',
    '## Task Breakdown',
    '| Order | ID | Title | Priority | Phase | Depends On |',
    '|---|---|---|---|---|---|',
    '| 10 | T0 | Repo Bootstrap and Normalization | P0 | 0 | none |',
    '| 20 | T1 | Codex Validation Report | P0 | 0 | T0 |',
  ].join('\n');

  const manifest = fallbackRefinePrd(prd);
  assert.equal(manifest.tickets.length, 2);
  assert.equal(manifest.tickets[0].title, 'Repo Bootstrap and Normalization');
  assert.equal(manifest.tickets[1].priority, 'P0');
});

test('fallbackRefinePrd accepts numbered Task Breakdown headings', () => {
  const prd = [
    '# PRD',
    '',
    '## 15. Task Breakdown',
    '| Order | ID | Title | Priority | Phase | Depends On |',
    '|---|---|---|---|---|---|',
    '| 10 | T0 | Parse numbered headings | P1 | 0 | none |',
    '| 20 | T1 | Materialize real tickets | P1 | 1 | T0 |',
  ].join('\n');

  const manifest = fallbackRefinePrd(prd);
  assert.equal(manifest.tickets.length, 2);
  assert.equal(manifest.tickets[0].title, 'Parse numbered headings');
  assert.equal(manifest.tickets[1].depends_on, 'T0');
});

test('writeManifest and writeTicketFiles materialize refinement output', () => {
  const sessionDir = makeTempRoot();
  const manifest = {
    tickets: [
      {
        id: 'ticket-001',
        title: 'Implement thing',
        description: 'Do the work',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, manifest);
  writeTicketFiles(sessionDir, manifest);

  const written = readManifest(sessionDir);
  assert.equal(written.tickets.length, 1);
  const ticketDir = path.join(sessionDir, 'ticket-001');
  const files = fs.readdirSync(ticketDir);
  assert.ok(files.some((fileName) => fileName === 'linear_ticket_ticket-001.md'));
});

test('readManifest and writeTicketFiles normalize uppercase ticket ids and persist them', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'R1',
        title: 'Uppercase ID Ticket',
        description: 'Do the work',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const manifest = readManifest(sessionDir);
  writeTicketFiles(sessionDir, manifest);

  const rewritten = readManifest(sessionDir);
  assert.equal(rewritten.tickets[0].id, 'r1');
  assert.ok(fs.existsSync(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')));
  assert.equal(getTicketById(sessionDir, 'R1')?.id, 'r1');
});

test('readManifest normalizes verification variants and persists canonical string arrays', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'A1',
        title: 'Array verification',
        description: 'already normalized',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A2',
        title: 'String verification',
        description: 'split string',
        acceptance_criteria: ['It works'],
        verification: 'npm test && npm run lint',
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A3',
        title: 'Object verification',
        description: 'commands wrapper',
        acceptance_criteria: ['It works'],
        verification: { commands: ['npm test', 'npm run lint'] },
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A4',
        title: 'Array object verification',
        description: 'command objects',
        acceptance_criteria: ['It works'],
        verification: [{ command: 'npm test' }, { command: 'npm run lint' }],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A5',
        title: 'Legacy verify',
        description: 'verify fallback',
        acceptance_criteria: ['It works'],
        verify: 'npm test && npm run lint',
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A6',
        title: 'Empty verification',
        description: 'empty stays empty',
        acceptance_criteria: ['It works'],
        verification: '',
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'A7',
        title: 'Garbage verification',
        description: 'garbage degrades safely',
        acceptance_criteria: ['It works'],
        verification: { nope: true },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const manifest = readManifest(sessionDir);
  assert.deepEqual(manifest.tickets.map((ticket) => ticket.verification), [
    ['npm test'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    [],
    [],
  ]);

  const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'refinement_manifest.json'), 'utf8'));
  assert.deepEqual(persisted.tickets.map((ticket) => ticket.verification), [
    ['npm test'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    ['npm test', 'npm run lint'],
    [],
    [],
  ]);
});

test('normalizeManifestTicketIds rewrites dependency references to canonical ids', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'R1',
        title: 'Root Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'R2',
        title: 'Dependent Ticket',
        description: 'second',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        depends_on: 'R1',
      },
    ],
  });

  const manifest = readManifest(sessionDir);
  assert.equal(manifest.tickets[0].id, 'r1');
  assert.equal(manifest.tickets[1].id, 'r2');
  assert.equal(manifest.tickets[1].depends_on, 'r1');
});

test('enrichRefinementManifest normalizes dependency aliases and materializes verification_env', () => {
  const manifest = {
    tickets: [
      {
        id: 'T00',
        title: 'Freeze contract',
        description: 'Capture sibling repo contract.',
        acceptance_criteria: ['The sibling contract is recorded in repo-owned artifacts.'],
        verification: ['git -C "$ATTRACTOR_ROOT" rev-parse HEAD'],
        priority: 'P0',
        status: 'Todo',
        dependencies: [],
      },
      {
        id: 'T01',
        title: 'Use previous ticket',
        description: 'Depends on the freeze ticket.',
        acceptance_criteria: ['The next ticket depends on the normalized freeze ticket id.'],
        verification: ['test -f research/external-contract-freeze.md'],
        priority: 'P0',
        status: 'Todo',
        dependencies: ['T00'],
      },
    ],
  };

  const enriched = enrichRefinementManifest(manifest);
  assert.equal(enriched.manifest.tickets[1].depends_on[0], 't00');
  assert.deepEqual(
    enriched.manifest.tickets[0].verification_env.required.map((entry) => entry.name),
    ['ATTRACTOR_ROOT'],
  );
});

test('enrichRefinementManifest infers wrapper env requirements and normalizes freeze contract aliases', () => {
  const manifest = {
    tickets: [
      {
        id: 'T00',
        title: 'Freeze attractor contract',
        description: 'Capture sibling SHA into a freeze artifact via wrapper scripts.',
        acceptance_criteria: ['The authoritative sibling SHA is frozen into a repo artifact.'],
        verification: ['bun run check:env && bun run validate:attractor'],
        outputArtifacts: ['research/external-contract-freeze.md'],
        freezeContract: {
          path: 'research/external-contract-freeze.md',
          env: 'ATTRACTOR_ROOT',
          authority: 'git:ATTRACTOR_ROOT:HEAD',
        },
        priority: 'P0',
        status: 'Todo',
      },
    ],
  };

  const enriched = enrichRefinementManifest(manifest);
  assert.deepEqual(
    enriched.manifest.tickets[0].verification_env.required.map((entry) => entry.name),
    ['ATTRACTOR_ROOT', 'DIPPIN_ROOT'],
  );
  assert.deepEqual(enriched.manifest.tickets[0].output_artifacts, ['research/external-contract-freeze.md']);
  assert.deepEqual(enriched.manifest.tickets[0].freeze_contract, {
    artifact_path: 'research/external-contract-freeze.md',
    sibling: 'attractor',
    root_env: 'ATTRACTOR_ROOT',
    sha_source: 'git:ATTRACTOR_ROOT:HEAD',
  });
});

test('enrichRefinementManifest preserves ambiguous evolving external freeze contracts without defaulting to fixed SHA', () => {
  const manifest = {
    tickets: [
      {
        id: 'T02',
        title: 'Decide evolving external contract',
        description: 'Record the contract decision before choosing runtime commit pinning.',
        acceptance_criteria: ['The refinement preserves the ambiguity until commit pinning is explicitly required.'],
        verification: ['test -f research/external-contract-freeze.md'],
        freezeContract: {
          path: 'research/external-contract-freeze.md',
          env: 'ATTRACTOR_ROOT',
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  const enriched = enrichRefinementManifest(manifest);
  assert.deepEqual(enriched.manifest.tickets[0].freeze_contract, {
    artifact_path: 'research/external-contract-freeze.md',
    sibling: 'attractor',
    root_env: 'ATTRACTOR_ROOT',
    sha_source: '',
  });
});

test('validateRefinementManifest rejects fallback parser output with placeholder contracts', () => {
  const issues = validateRefinementManifest(fallbackRefinePrd([
    '# PRD',
    '',
    '## Task Breakdown',
    '| Order | ID | Title | Priority | Phase | Depends On |',
    '|---|---|---|---|---|---|',
    '| 10 | T0 | Placeholder Ticket | P1 | 0 | none |',
  ].join('\n')));

  assert.ok(issues.some((issue) => issue.includes('fallback parser output')));
  assert.ok(issues.some((issue) => issue.includes('placeholder text')));
});

test('validateRefinementManifest rejects formatter ownership drift, opaque wrappers, parity gaps, and unowned artifacts', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'formatter-ticket',
        title: 'Formatter ownership',
        description: 'Own formatter changes for the port.',
        acceptance_criteria: ['Formatter ownership is explicit.'],
        verification: ['test -f README.md'],
        formatter_ticket: true,
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'parity-ticket',
        title: 'Mirror parity fixtures',
        description: 'Keep parity aligned with the sibling wrapper flow.',
        acceptance_criteria: ['Parity stays aligned with mirrored sibling behavior.'],
        verification: ['bun run fixtures:sync'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'artifact-consumer',
        title: 'Verify frozen contract artifact',
        description: 'Check the frozen sibling SHA artifact.',
        acceptance_criteria: ['The freeze artifact exists for downstream verification.'],
        verification: ['test -f research/external-contract-freeze.md'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('formatter ownership requires explicit formatter work')));
  assert.ok(issues.some((issue) => issue.includes('opaque verification wrapper commands require explicit')));
  assert.ok(issues.some((issue) => issue.includes('wrapper verification requires explicit output_artifacts')));
  assert.ok(issues.some((issue) => issue.includes('must declare proof_corpus coverage')));
  assert.ok(issues.some((issue) => issue.includes('verification references artifact "research/external-contract-freeze.md" but no ticket owns it')));
  assert.ok(issues.some((issue) => issue.includes('no authoritative producer exists')));
});

test('validateRefinementManifest rejects formatter-sensitive verification before formatter ownership dependency', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'implementation',
        title: 'Generate parity docs',
        description: 'Writes repo artifacts that still need a later formatter pass.',
        acceptance_criteria: ['Generated docs are checked before handoff.'],
        verification: ['bun run format'],
        priority: 'P0',
        status: 'Todo',
      },
      {
        id: 'formatter-ticket',
        title: 'Formatter ownership',
        description: 'Own formatter changes for the port.',
        acceptance_criteria: ['Formatter ownership is explicit.'],
        verification: ['bun run format'],
        formatter_ticket: true,
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('formatter-sensitive verification runs before formatter ownership is declared')));
});

test('validateRefinementManifest rejects conflicting freeze authorities and consumer drift', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'freeze-attractor',
        title: 'Freeze attractor contract',
        description: 'Record the authoritative ATTRACTOR sibling SHA.',
        acceptance_criteria: ['The attractor SHA is frozen into the artifact.'],
        verification: ['git -C "$ATTRACTOR_ROOT" rev-parse HEAD'],
        output_artifacts: ['research/external-contract-freeze.md'],
        freeze_contract: {
          artifact_path: 'research/external-contract-freeze.md',
          sibling: 'attractor',
          root_env: 'ATTRACTOR_ROOT',
          sha_source: 'git:ATTRACTOR_ROOT:HEAD',
        },
        priority: 'P0',
        status: 'Todo',
      },
      {
        id: 'freeze-dippin',
        title: 'Freeze dippin contract',
        description: 'Record a different sibling SHA into the same artifact.',
        acceptance_criteria: ['The dippin SHA is also frozen.'],
        verification: ['git -C "$DIPPIN_ROOT" rev-parse HEAD'],
        output_artifacts: ['research/external-contract-freeze.md'],
        freeze_contract: {
          artifact_path: 'research/external-contract-freeze.md',
          sibling: 'dippin',
          root_env: 'DIPPIN_ROOT',
          sha_source: 'git:DIPPIN_ROOT:HEAD',
        },
        priority: 'P0',
        status: 'Todo',
      },
      {
        id: 'consumer',
        title: 'Validate frozen contract',
        description: 'Use the existing freeze artifact for downstream checks.',
        acceptance_criteria: ['The downstream checks align with the authoritative freeze contract.'],
        verification: ['test -f research/external-contract-freeze.md'],
        freeze_contract: {
          artifact_path: 'research/external-contract-freeze.md',
          sibling: 'dippin',
          root_env: 'DIPPIN_ROOT',
          sha_source: 'git:DIPPIN_ROOT:HEAD',
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('conflicting sibling SHA authorities')));
  assert.ok(issues.some((issue) => issue.includes('freeze_contract disagrees with authoritative producer')));
});

test('validateRefinementManifest rejects opaque wrapper verification without declared contracts', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'wrapper-only',
        title: 'Run wrapper without proof',
        description: 'This should fail because the wrapper hides the real contract.',
        acceptance_criteria: ['Wrapper execution is backed by explicit artifacts and env contracts.'],
        verification: ['bun run check:env'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('opaque verification wrapper commands require explicit')));
  assert.ok(issues.some((issue) => issue.includes('wrapper verification requires explicit contracts instead of opaque shell assumptions')));
});

test('validateRefinementManifest rejects freeze consumers when no authoritative producer exists', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'artifact-owner',
        title: 'Own freeze artifact path only',
        description: 'This ticket owns the artifact path but does not define the authoritative freeze contract.',
        acceptance_criteria: ['The artifact path is present.'],
        verification: ['test -f research/external-contract-freeze.md'],
        output_artifacts: ['research/external-contract-freeze.md'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'freeze-consumer',
        title: 'Consume contract artifact',
        description: 'This should fail because no authoritative sibling-SHA producer exists.',
        acceptance_criteria: ['The consumer aligns with the frozen sibling SHA.'],
        verification: ['test -f research/external-contract-freeze.md'],
        freeze_contract: {
          artifact_path: 'research/external-contract-freeze.md',
          sibling: 'attractor',
          root_env: 'ATTRACTOR_ROOT',
          sha_source: 'git:ATTRACTOR_ROOT:HEAD',
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('freeze_contract for "research/external-contract-freeze.md" has no authoritative producer')));
});

test('validateRefinementManifest requires an explicit contract-decision ticket for ambiguous evolving external contracts', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'consumer',
        title: 'Validate frozen contract',
        description: 'Use a freeze artifact before any producer ticket exists.',
        acceptance_criteria: ['The consumer checks the frozen contract artifact.'],
        verification: ['test -f research/external-contract-freeze.md'],
        freezeContract: {
          path: 'research/external-contract-freeze.md',
          env: 'ATTRACTOR_ROOT',
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('explicit contract-decision ticket')));
  assert.ok(!issues.some((issue) => issue.includes('freeze_contract for "research/external-contract-freeze.md" has no authoritative producer')));
});

test('validateRefinementManifest preserves explicit contract-decision tickets for ambiguous evolving external contracts', () => {
  const issues = validateRefinementManifest({
    source: 'fake-codex-synthesis',
    tickets: [
      {
        id: 'contract-decision',
        title: 'Contract decision for evolving external validation',
        description: 'Decide whether this artifact stays live against the evolving sibling or requires fixed-SHA commit pinning.',
        acceptance_criteria: ['The refinement captures the chosen contract explicitly before implementation proceeds.'],
        verification: ['test -f research/external-contract-freeze.md'],
        output_artifacts: ['research/external-contract-freeze.md'],
        contract_decision: true,
        priority: 'P0',
        status: 'Todo',
      },
      {
        id: 'consumer',
        title: 'Validate external contract artifact',
        description: 'Preserve the ambiguity until the contract-decision ticket resolves pinning.',
        acceptance_criteria: ['Verification defers fixed-SHA enforcement until the decision ticket resolves it.'],
        verification: ['test -f research/external-contract-freeze.md'],
        freezeContract: {
          path: 'research/external-contract-freeze.md',
          env: 'ATTRACTOR_ROOT',
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.ok(!issues.some((issue) => issue.includes('explicit contract-decision ticket')));
  assert.ok(!issues.some((issue) => issue.includes('no authoritative producer exists')));
});

test('summarizeTickets and ensureTicketFilesMaterialized restore missing ticket files from the manifest', () => {
  const sessionDir = makeTempRoot();
  const manifest = {
    tickets: [
      {
        id: 'ticket-a',
        title: 'First Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'ticket-b',
        title: 'Second Ticket',
        description: 'second',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, manifest);
  writeTicketFiles(sessionDir, { tickets: [manifest.tickets[0]] });

  const materialized = ensureTicketFilesMaterialized(sessionDir);
  const summary = summarizeTickets(sessionDir);
  assert.equal(materialized.length, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.runnable.length, 2);
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-b', 'linear_ticket_ticket-b.md')));
});

test('ticket rematerialization preserves operational frontmatter needed by status and config protection', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'ticket-a',
        title: 'Config Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Blocked',
        config_change: true,
        failed_at: '2026-04-15T12:00:00.000Z',
        failure_reason: 'verification failed',
        retry_requested_at: '2026-04-15T13:00:00.000Z',
      },
    ],
  });

  ensureTicketFilesMaterialized(sessionDir);
  const ticket = getTicketById(sessionDir, 'ticket-a');

  assert.equal(ticket.frontmatter.failed_at, '2026-04-15T12:00:00.000Z');
  assert.equal(ticket.frontmatter.failure_reason, 'verification failed');
  assert.equal(ticket.frontmatter.retry_requested_at, '2026-04-15T13:00:00.000Z');
  assert.match(ticket.content, /config_change: true/);
});

test('ensureTicketFilesMaterialized rewrites stale ticket files when manifest status changes without an id change', () => {
  const sessionDir = makeTempRoot();
  const baseManifest = {
    tickets: [
      {
        id: 'ticket-a',
        title: 'Config Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, baseManifest);
  writeTicketFiles(sessionDir, baseManifest);
  writeManifest(sessionDir, {
    tickets: [
      {
        ...baseManifest.tickets[0],
        status: 'Skipped',
      },
    ],
  });

  const materialized = ensureTicketFilesMaterialized(sessionDir);
  const summary = summarizeTickets(sessionDir);

  assert.equal(materialized[0].status, 'Skipped');
  assert.equal(summary.queued, 0);
  assert.equal(summary.skipped, 1);
  assert.match(
    fs.readFileSync(path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md'), 'utf8'),
    /status: "Skipped"/,
  );
});

test('summarizeTickets and ensureTicketFilesMaterialized prune obsolete ticket files when the manifest shrinks or empties', () => {
  const sessionDir = makeTempRoot();
  const manifest = {
    tickets: [
      {
        id: 'ticket-a',
        title: 'First Ticket',
        description: 'first',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
      {
        id: 'ticket-b',
        title: 'Second Ticket',
        description: 'second',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };

  writeManifest(sessionDir, manifest);
  writeTicketFiles(sessionDir, manifest);

  writeManifest(sessionDir, { tickets: [manifest.tickets[0]] });

  const shrunkMaterialized = ensureTicketFilesMaterialized(sessionDir);
  const shrunkSummary = summarizeTickets(sessionDir);

  assert.equal(shrunkMaterialized.length, 1);
  assert.equal(shrunkSummary.total, 1);
  assert.equal(shrunkSummary.runnable.length, 1);
  assert.ok(fs.existsSync(path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md')));
  assert.equal(fs.existsSync(path.join(sessionDir, 'ticket-b', 'linear_ticket_ticket-b.md')), false);

  writeManifest(sessionDir, { tickets: [] });

  const emptiedMaterialized = ensureTicketFilesMaterialized(sessionDir);
  const emptiedSummary = summarizeTickets(sessionDir);

  assert.equal(emptiedMaterialized.length, 0);
  assert.equal(emptiedSummary.total, 0);
  assert.equal(emptiedSummary.runnable.length, 0);
  assert.equal(fs.existsSync(path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md')), false);
});

test('ticketDependencyIds treats any case of none as empty for scalar dependencies', () => {
  for (const spelling of ['none', 'None', 'NONE', 'nOnE']) {
    assert.deepEqual(ticketDependencyIds({ depends_on: spelling }), [], `spelling "${spelling}" should produce empty deps`);
  }
});

test('ticketDependencyIds treats any case of none as empty for array dependencies', () => {
  assert.deepEqual(ticketDependencyIds({ depends_on: ['none'] }), []);
  assert.deepEqual(ticketDependencyIds({ depends_on: ['None'] }), []);
  assert.deepEqual(ticketDependencyIds({ depends_on: ['NONE', 'T1'] }), ['t1']);
  assert.deepEqual(ticketDependencyIds({ depends_on: ['T1', 'none', 'T2'] }), ['t1', 't2']);
});

test('enrichRefinementManifest treats case-insensitive none dependencies as empty', () => {
  const enriched = enrichRefinementManifest({
    tickets: [
      {
        id: 'T0',
        title: 'Root',
        description: 'root',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        depends_on: 'None',
      },
      {
        id: 'T1',
        title: 'Dependent',
        description: 'depends on T0',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        depends_on: ['NONE', 'T0'],
      },
    ],
  });
  assert.deepEqual(ticketDependencyIds(enriched.manifest.tickets[0]), []);
  assert.deepEqual(ticketDependencyIds(enriched.manifest.tickets[1]), ['t0']);
});

test('summarizeTickets does not block runnable tickets with case-insensitive none dependencies', () => {
  const sessionDir = makeTempRoot();
  writeManifest(sessionDir, {
    tickets: [
      {
        id: 'ticket-a',
        title: 'None dependency ticket',
        description: 'Should be runnable despite case-variant none dependency.',
        acceptance_criteria: ['It works'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
        depends_on: 'None',
      },
    ],
  });

  const summary = summarizeTickets(sessionDir);
  assert.equal(summary.runnable.length, 1);
  assert.equal(summary.runnable[0].id, 'ticket-a');
});
