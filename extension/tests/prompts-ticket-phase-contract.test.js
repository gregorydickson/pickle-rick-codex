// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketPhasePrompt } from '../services/prompts.js';

const phaseContracts = {
  research: 'evidence: non-empty string[]',
  research_review: 'verdict: "approved"; evidence: non-empty string[]',
  plan: 'steps: non-empty string[]',
  plan_review: 'verdict: "approved"; evidence: non-empty string[]',
  implement: 'files_changed: string[]; verification: non-empty string[]',
  review: 'verdict: "approved"; implementation_reviewed: true; evidence: non-empty string[]',
  simplify: 'verification: non-empty string[]',
  conformance: 'verdict: "all_pass"; implementation_reviewed: true; acceptance_criteria:',
};

const readOnlyPhases = new Set([
  'research',
  'research_review',
  'plan',
  'plan_review',
  'review',
  'conformance',
]);

for (const [phase, contract] of Object.entries(phaseContracts)) {
  test(`buildTicketPhasePrompt binds the ${phase} artifact and repository contract`, () => {
    const prompt = buildTicketPhasePrompt({
      phase,
      ticket: {
        id: 'T-17',
        title: 'Guard lifecycle prompts',
        description: 'Keep phase permissions explicit.',
        acceptance_criteria: ['Each phase persists its exact artifact.'],
        verification: ['node --test tests/lifecycle.test.js'],
        allowed_paths: ['services/prompts.js', 'tests/prompts.test.js'],
      },
      sessionDir: '/sessions/pickle-17',
      workingDir: '/repos/pickle',
    });

    assert.match(prompt, new RegExp(`executing the "${phase}" phase for ticket T-17`));
    assert.match(prompt, new RegExp(`/worker-lifecycle/T-17/${phase}\\.json`));
    assert.match(prompt, new RegExp(`phase: "${phase}"; ticket_id: "T-17"`));
    assert.ok(prompt.includes(contract));
    assert.match(prompt, new RegExp(`<promise>${phase.toUpperCase()}_COMPLETE</promise>`));

    if (readOnlyPhases.has(phase)) {
      assert.match(prompt, /read-only repository phase/);
      assert.match(prompt, /inspection context only/);
      assert.match(prompt, /Do not create, modify, stage, or commit them/);
      assert.match(prompt, /downstream evidence contracts only/);
      assert.doesNotMatch(prompt, /You may modify only these ticket-owned paths/);
    } else {
      assert.match(prompt, /Work directly in the repository working tree/);
      assert.match(prompt, /You may modify only these ticket-owned paths/);
    }

    if (phase === 'review' || phase === 'conformance') {
      assert.match(prompt, /Inspect the actual implementation diff and verification evidence/);
    } else {
      assert.doesNotMatch(prompt, /Inspect the actual implementation diff and verification evidence/);
    }
  });
}

test('buildTicketPhasePrompt serializes rich implement inputs and a custom artifact identity', () => {
  const prompt = buildTicketPhasePrompt({
    phase: 'implement',
    ticket: {
      id: 'T-18',
      title: 'Implement scoped change',
      description: 'Change only the owned service.',
      acceptance_criteria: ['The focused test passes.', 'The broad suite stays green.'],
      verification: 'npm run test:focused && npm run lint',
      verificationContract: {
        mode: 'merge',
        required: [{ name: 'FIXTURE_ROOT', format: 'string' }],
        vars: { MODE: { value: 'deterministic' } },
      },
      allowedPaths: ['services/focused.js'],
    },
    sessionDir: '/sessions/pickle-18',
    workingDir: '/repos/pickle',
    artifactPath: '/artifacts/renamed-ticket/implement.json',
    priorArtifacts: [{
      phase: 'plan_review',
      verdict: 'approved',
      evidence: ['Plan is executable.'],
    }],
    tmuxMode: true,
  });

  assert.match(prompt, /ticket_id: "renamed-ticket"/);
  assert.match(prompt, /\["services\/focused\.js"\]/);
  assert.match(prompt, /- npm run test:focused\n- npm run lint/);
  assert.match(prompt, /Verification env contract:/);
  assert.match(prompt, /FIXTURE_ROOT/);
  assert.match(prompt, /MODE/);
  assert.match(prompt, /Approved plan_review artifact:/);
  assert.match(prompt, /"verdict": "approved"/);
  assert.match(prompt, /finish with committed changes/);
});

test('contract-decision research defers its repository deliverable to implementation', () => {
  const prompt = buildTicketPhasePrompt({
    phase: 'research',
    ticket: {
      id: 'P1-001',
      title: 'Record runtime decisions',
      description: 'Create the normative decision record.',
      contract_decision: true,
      acceptance_criteria: ['The decision record defines startup_accepted.'],
      verification: ['test -f docs/runtime-decisions.md'],
      allowed_paths: ['docs/runtime-decisions.md'],
      output_artifacts: ['docs/runtime-decisions.md'],
    },
    sessionDir: '/sessions/pickle-contract',
    workingDir: '/repos/pickle',
    tmuxMode: true,
  });

  assert.match(prompt, /Do not execute them or perform the ticket deliverable/);
  assert.match(prompt, /persist only the lifecycle JSON artifact outside the repository/);
  assert.match(prompt, /do not create ticket deliverables or commits/);
  assert.doesNotMatch(prompt, /finish with committed changes/);
  assert.doesNotMatch(prompt, /You may modify only these ticket-owned paths/);
});

test('buildTicketPhasePrompt uses safe defaults for sparse tickets', () => {
  const prompt = buildTicketPhasePrompt({
    phase: 'simplify',
    ticket: {
      id: 'T-19',
      title: 'Simplify safely',
      files: ['services/simple.js'],
    },
    sessionDir: '/sessions/pickle-19',
    workingDir: '/repos/pickle',
  });

  assert.match(prompt, /\["services\/simple\.js"\]/);
  assert.match(prompt, /No description provided\./);
  assert.match(prompt, /Verification commands:\n- npm test/);
  assert.match(prompt, /No earlier lifecycle artifacts exist for this phase\./);
  assert.doesNotMatch(prompt, /Detached tmux ticket boundary/);
  assert.doesNotMatch(prompt, /Verification env contract/);
});
