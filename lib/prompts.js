export function buildDraftPrdPrompt({ task, sessionDir }) {
  return [
    'You are drafting a PRD for the Pickle Rick Codex runtime.',
    `Write the PRD to ${sessionDir}/prd.md.`,
    'Cover: summary, goals, non-goals, critical user journeys, architecture, implementation plan, risks, success criteria, and machine-checkable verification.',
    'Stay grounded in the current repository and prefer a truthful runnable baseline over aspirational text.',
    `Task: ${task}`,
    'Return <promise>PRD_COMPLETE</promise> when the file is written.',
    'Stop immediately after writing the file and the promise token. Do not continue with extra analysis, follow-up suggestions, or additional turns.',
  ].join('\n\n');
}

export function buildRefinePrdPrompt({ sessionDir, prdPath }) {
  return [
    'Refine the PRD into atomic implementation tickets for the guaranteed Codex v1 path.',
    `Read ${prdPath}.`,
    `Write ${sessionDir}/prd_refined.md with clarified acceptance criteria.`,
    `Write ${sessionDir}/refinement_manifest.json with a top-level {"tickets":[...]} array.`,
    'Each ticket should be self-contained, sequentially executable, and include id, title, description, acceptance_criteria, verification, and priority.',
    'Return <promise>REFINEMENT_COMPLETE</promise> when both files are written.',
    'Stop immediately after writing the files and the promise token. Do not continue with extra analysis or follow-up turns.',
  ].join('\n\n');
}

export function buildTicketPhasePrompt({ phase, ticket, sessionDir, worktreeDir }) {
  return [
    `You are executing the "${phase}" phase for ticket ${ticket.id}: ${ticket.title}.`,
    `Session dir: ${sessionDir}`,
    `Working directory: ${worktreeDir}`,
    'Follow the guaranteed sequential path. Do not assume undocumented native agent controls.',
    'Use the repository tests and local commands needed for this phase.',
    `Ticket description:\n${ticket.description || 'No description provided.'}`,
    `Acceptance criteria:\n${(ticket.acceptance_criteria || []).map((item) => `- ${item}`).join('\n')}`,
    `Verification commands:\n${(ticket.verification || ['npm test']).map((item) => `- ${item}`).join('\n')}`,
    `Return <promise>${phase.toUpperCase()}_COMPLETE</promise> when this phase is finished.`,
  ].join('\n\n');
}
