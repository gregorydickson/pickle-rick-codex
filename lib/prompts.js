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

export function buildLoopPrompt({ mode, sessionDir, workingDir, state, loopConfig }) {
  const common = [
    `Loop mode: ${mode}`,
    `Session dir: ${sessionDir}`,
    `Working directory: ${workingDir}`,
    `Original task: ${state.original_prompt}`,
    `Iteration: ${state.iteration + 1} / ${state.max_iterations}`,
    'You are running in a detached Pickle Rick tmux loop with fresh Codex context for this iteration.',
    'Make one coherent iteration of progress, grounded in the current repository state.',
    'Write short notes or artifacts to the session directory if useful, but keep the main work in the repository.',
    'If the loop should continue after this iteration, return <promise>CONTINUE</promise>.',
    'If the objective is complete or converged, return <promise>LOOP_COMPLETE</promise>.',
  ];

  if (mode === 'microverse') {
    return [
      ...common,
      `Objective: ${loopConfig.task}`,
      loopConfig.metric ? `Metric command: ${loopConfig.metric}` : `Goal: ${loopConfig.goal}`,
      `Direction: ${loopConfig.direction || 'higher'}`,
      `Stall limit: ${loopConfig.stall_limit || 5}`,
      'Process: make one targeted change, measure or reason about impact, avoid repeating failed approaches, and converge deliberately.',
    ].join('\n\n');
  }

  if (mode === 'szechuan-sauce') {
    return [
      ...common,
      `Target: ${loopConfig.target}`,
      loopConfig.focus ? `Focus: ${loopConfig.focus}` : 'Focus: none',
      loopConfig.domain ? `Domain principles: ${loopConfig.domain}` : 'Domain principles: none',
      loopConfig.dry_run ? 'Dry run: catalog violations only, do not edit files.' : 'Fix exactly one highest-value code quality issue this iteration.',
      'Use principle-driven cleanup: KISS, DRY, consistency, dead-code removal, boundary error handling, and simpler structure.',
    ].join('\n\n');
  }

  if (mode === 'anatomy-park') {
    return [
      ...common,
      `Target: ${loopConfig.target}`,
      loopConfig.dry_run ? 'Dry run: review and catalog findings only, do not edit files.' : 'Fix at most one high-severity correctness issue this iteration.',
      'Trace data flow through the subsystem, identify where meaning changes incorrectly, and prefer correctness bugs over style complaints.',
      'Record trap doors when you discover structural invariants likely to break in future edits.',
    ].join('\n\n');
  }

  return common.join('\n\n');
}
