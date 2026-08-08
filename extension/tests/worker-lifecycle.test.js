// @tier: integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile } from '../services/pickle-utils.js';
import {
  WORKER_LIFECYCLE_PHASES,
  WorkerLifecycleRefusalError,
  isWorkerLifecycleRefusalError,
  readAndValidateWorkerLifecycleArtifact,
  workerLifecycleArtifactPath,
} from '../services/worker-lifecycle.js';
import { acceptTestRefinement, createFakeCodex, makeTempRoot, prependPath, repoRoot, runNode, writeJson } from './helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setupLifecycleRun(env, ticketOverrides = {}) {
  const projectDir = makeTempRoot('pickle-worker-lifecycle-project-');
  git(projectDir, ['init']);
  git(projectDir, ['config', 'user.name', 'Lifecycle Tests']);
  git(projectDir, ['config', 'user.email', 'lifecycle@example.test']);
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\n');
  git(projectDir, ['add', 'feature.txt']);
  git(projectDir, ['commit', '-m', 'base']);
  const baseline = git(projectDir, ['rev-parse', 'HEAD']);
  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'causal worker lifecycle'], {
    env,
    cwd: projectDir,
  }).trim();
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.active = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [{
      id: 'R1',
      title: 'Causal lifecycle ticket',
      description: 'Carry approved research and planning into implementation.',
      acceptance_criteria: ['The implementation consumes approved lifecycle artifacts.'],
      verification: ['node -e "process.exit(0)"'],
      allowed_paths: ['feature.txt'],
      priority: 'P1',
      complexity_tier: 'high',
      status: 'Todo',
      ...ticketOverrides,
    }],
  });
  acceptTestRefinement(sessionDir, projectDir);
  return { projectDir, sessionDir, baseline };
}

test('review lifecycle validation preserves truthful changes-requested findings', () => {
  const artifactRoot = makeTempRoot('pickle-worker-lifecycle-review-');
  const artifactPath = workerLifecycleArtifactPath(artifactRoot, 'r1', 'review');
  const review = {
    schema_version: 1,
    phase: 'review',
    ticket_id: 'r1',
    summary: 'Implementation needs remediation.',
    verdict: 'changes_requested',
    implementation_reviewed: true,
    evidence: ['Inspected the implementation diff.'],
    findings: ['Recovery can resume against a changed repository fingerprint.'],
  };
  writeJson(artifactPath, review);

  assert.deepEqual(
    readAndValidateWorkerLifecycleArtifact(artifactPath, 'review', 'r1', []),
    review,
  );

  for (const invalid of [
    { ...review, verdict: 'rejected' },
    { ...review, evidence: [] },
    { ...review, implementation_reviewed: false },
    { ...review, findings: [] },
  ]) {
    writeJson(artifactPath, invalid);
    assert.throws(
      () => readAndValidateWorkerLifecycleArtifact(artifactPath, 'review', 'r1', []),
      /worker-lifecycle-invalid-artifact/,
    );
  }

  const refusal = new WorkerLifecycleRefusalError('review', artifactPath, review);
  assert.equal(isWorkerLifecycleRefusalError(refusal), true);
  assert.equal(isWorkerLifecycleRefusalError(new Error('review refused')), false);
  assert.equal(refusal.phase, 'review');
  assert.equal(refusal.artifactPath, artifactPath);
  assert.deepEqual(refusal.artifact, review);
  assert.match(refusal.message, /evidence persisted/);
});

test('worker lifecycle persists eight validated phases and reads approved research and plan into implement', () => {
  const fakeBin = makeTempRoot('pickle-worker-lifecycle-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const promptLog = makeTempRoot('pickle-worker-lifecycle-prompts-');
  const invocationLog = path.join(dataRoot, 'codex-invocations.jsonl');
  writeJson(path.join(dataRoot, 'config.json'), {
    runtime: {
      add_dirs: [dataRoot],
      exec_args: ['--dangerously-bypass-approvals-and-sandbox'],
    },
  });
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
    FAKE_LIFECYCLE_PROMPT_LOG: promptLog,
  });
  const { projectDir, sessionDir, baseline } = setupLifecycleRun(env);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  assert.notEqual(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  const artifactDir = path.join(sessionDir, 'worker-lifecycle', 'r1');
  for (const phase of WORKER_LIFECYCLE_PHASES) {
    const artifact = JSON.parse(fs.readFileSync(path.join(artifactDir, `${phase}.json`), 'utf8'));
    assert.equal(artifact.phase, phase);
    assert.equal(artifact.ticket_id, 'r1');
  }
  const implementPrompt = fs.readFileSync(path.join(promptLog, 'implement.prompt.txt'), 'utf8');
  assert.match(implementPrompt, /approved research marker/);
  assert.match(implementPrompt, /approved plan marker/);
  assert.match(implementPrompt, /Approved research_review artifact/);
  assert.match(implementPrompt, /Approved plan_review artifact/);
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.args[0] === 'exec');
  assert.equal(invocations.length, WORKER_LIFECYCLE_PHASES.length);
  const telemetry = JSON.parse(fs.readFileSync(path.join(sessionDir, 'execution-telemetry.json'), 'utf8'));
  assert.deepEqual(telemetry.events.map((event) => event.phase), WORKER_LIFECYCLE_PHASES);
  assert.ok(telemetry.events.every((event) => event.outcome === 'success'));
  assert.ok(telemetry.events.every((event) => event.duration_ms > 0));
  for (const invocation of invocations) {
    assert.ok(invocation.args.includes('--sandbox'));
    assert.ok(invocation.args.includes('workspace-write'));
    assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    const addDirs = invocation.args.flatMap((arg, index) => arg === '--add-dir' ? [invocation.args[index + 1]] : []);
    assert.equal(addDirs.length, 1);
    assert.ok(addDirs[0].startsWith(`${path.join(sessionDir, 'worker-lifecycle-candidates')}${path.sep}`));
    assert.notEqual(addDirs[0], sessionDir);
    assert.notEqual(addDirs[0], dataRoot);
  }
  assert.equal(fs.existsSync(path.join(sessionDir, 'refinement-repository-advance.json')), false);
  assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
});

test('low-risk lifecycle records a policy skip without invoking simplification', () => {
  const fakeBin = makeTempRoot('pickle-worker-lifecycle-low-risk-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const invocationLog = path.join(dataRoot, 'codex-invocations.jsonl');
  writeJson(path.join(dataRoot, 'config.json'), {
    runtime: { add_dirs: [dataRoot], exec_args: ['--dangerously-bypass-approvals-and-sandbox'] },
  });
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
  });
  const { projectDir, sessionDir } = setupLifecycleRun(env, {
    complexity_tier: 'low',
    priority: 'P3',
  });

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  const phases = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.args[0] === 'exec')
    .map((entry) => path.basename(entry.args[entry.args.indexOf('--output-last-message') + 1]).split('.')[1]);
  assert.equal(phases.includes('simplify'), false);
  assert.deepEqual(phases, ['research', 'research_review', 'plan', 'plan_review', 'implement', 'review', 'conformance']);
  const skipped = JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'worker-lifecycle', 'r1', 'simplify.json'), 'utf8',
  ));
  assert.equal(skipped.skipped, true);
});

test('worker lifecycle retries malformed read-only conformance output without discarding reviewed implementation', () => {
  const fakeBin = makeTempRoot('pickle-worker-lifecycle-artifact-retry-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const invocationLog = path.join(dataRoot, 'codex-invocations.jsonl');
  const promptLog = makeTempRoot('pickle-worker-lifecycle-artifact-retry-prompts-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
    FAKE_LIFECYCLE_INVALID_ONCE_PHASE: 'conformance',
    FAKE_LIFECYCLE_PROMPT_LOG: promptLog,
  });
  const { projectDir, sessionDir, baseline } = setupLifecycleRun(env);

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir });

  assert.notEqual(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.args[0] === 'exec');
  assert.equal(invocations.length, WORKER_LIFECYCLE_PHASES.length + 1);
  const failureDir = path.join(sessionDir, 'worker-lifecycle-failures', 'r1');
  const failureFiles = fs.readdirSync(failureDir);
  const rawArtifact = failureFiles.find((file) => file.startsWith('conformance.') && file.endsWith('.artifact'));
  const metadata = failureFiles.find((file) => file.startsWith('conformance.') && file.endsWith('.json'));
  assert.ok(rawArtifact);
  assert.ok(metadata);
  assert.equal(fs.readFileSync(path.join(failureDir, rawArtifact), 'utf8'), '{invalid json');
  assert.match(
    JSON.parse(fs.readFileSync(path.join(failureDir, metadata), 'utf8')).error,
    /conformance wrote invalid JSON/,
  );
  const retriedPrompt = fs.readFileSync(path.join(promptLog, 'conformance.prompt.txt'), 'utf8');
  assert.match(retriedPrompt, /Prior artifact-contract attempt failed and must be corrected in this retry/);
  assert.match(retriedPrompt, /conformance wrote invalid JSON/);
});

test('deterministic verification fails immediately after implement before review phases run', () => {
  const fakeBin = makeTempRoot('pickle-worker-verify-order-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const invocationLog = path.join(dataRoot, 'codex-invocations.jsonl');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
  });
  const { projectDir, sessionDir } = setupLifecycleRun(env);
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.tickets[0].verification = [{ kind: 'process', executable: 'node', args: ['-e', 'process.exit(23)'] }];
  writeJson(manifestPath, manifest);
  acceptTestRefinement(sessionDir, projectDir);

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir }),
    /verification-command-failed|verification-contract-failed/,
  );
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const phases = invocations.filter((entry) => entry.args[0] === 'exec')
    .map((entry) => entry.args[entry.args.indexOf('--output-last-message') + 1])
    .map((lastMessagePath) => path.basename(lastMessagePath).split('.')[1]);
  assert.deepEqual(phases, ['research', 'research_review', 'plan', 'plan_review', 'implement']);
});

for (const refusalPhase of ['review', 'conformance']) {
test(`worker lifecycle persists ${refusalPhase} refusal and feeds its findings into bounded remediation`, () => {
  const fakeBin = makeTempRoot('pickle-worker-lifecycle-refusal-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const promptLog = makeTempRoot('pickle-worker-lifecycle-refusal-prompts-');
  const invocationLog = path.join(dataRoot, `codex-${refusalPhase}.jsonl`);
  const baseEnv = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
  });
  const { projectDir, sessionDir, baseline } = setupLifecycleRun(baseEnv);

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], {
      env: { ...baseEnv, FAKE_LIFECYCLE_REFUSAL_PHASE: refusalPhase },
      cwd: projectDir,
    }),
    new RegExp(`worker-lifecycle-refusal: ${refusalPhase} requested changes`),
  );

  const refusalPath = path.join(sessionDir, 'worker-lifecycle', 'r1', `${refusalPhase}.json`);
  const refusedArtifact = JSON.parse(fs.readFileSync(refusalPath, 'utf8'));
  assert.equal(refusedArtifact.verdict, 'changes_requested');
  assert.deepEqual(refusedArtifact.findings, ['retry dispatch is not repository-bound']);
  const refusalArchiveDir = path.join(sessionDir, 'worker-lifecycle-refusals', 'r1');
  const archivedRefusals = fs.readdirSync(refusalArchiveDir);
  assert.deepEqual(archivedRefusals, [`0001-${refusalPhase}.json`]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(refusalArchiveDir, archivedRefusals[0]), 'utf8')),
    refusedArtifact,
  );
  assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
  assert.equal(git(projectDir, ['status', '--porcelain']), '');
  const candidateCheckpointPath = path.join(sessionDir, 'rejected-candidates', 'r1.json');
  assert.equal(fs.existsSync(candidateCheckpointPath), true);
  const candidateCheckpoint = JSON.parse(fs.readFileSync(candidateCheckpointPath, 'utf8'));
  assert.match(candidateCheckpoint.recovery_ref, /^refs\/pickle\/salvage-history\//);
  assert.deepEqual(candidateCheckpoint.changed_paths, ['feature.txt']);
  const firstRunCalls = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length;

  runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], {
    env: { ...baseEnv, FAKE_LIFECYCLE_PROMPT_LOG: promptLog },
    cwd: projectDir,
  });

  const implementPrompt = fs.readFileSync(path.join(promptLog, 'implement.prompt.txt'), 'utf8');
  assert.match(implementPrompt, /Prior rejected lifecycle feedback/);
  assert.match(implementPrompt, /retry dispatch is not repository-bound/);
  assert.match(implementPrompt, /rejected candidate was restored from durable ref/);
  const allCalls = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const retryPhases = allCalls.slice(firstRunCalls)
    .map((entry) => entry.args[entry.args.indexOf('--output-last-message') + 1])
    .map((lastMessagePath) => path.basename(lastMessagePath).split('.')[1]);
  assert.deepEqual(retryPhases, ['implement', 'review', 'simplify', 'conformance']);
  assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
  assert.equal(fs.existsSync(candidateCheckpointPath), false);
});
}

test('field-equivalent malformed contract plus two review refusals completes within fifteen model calls', () => {
  const fakeBin = makeTempRoot('pickle-field-equivalent-bin-');
  createFakeCodex(fakeBin);
  const dataRoot = makeTempRoot();
  const invocationLog = path.join(dataRoot, 'codex-field-equivalent.jsonl');
  const promptLog = makeTempRoot('pickle-field-equivalent-prompts-');
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_INVOCATION_LOG: invocationLog,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'implemented\n',
    FAKE_LIFECYCLE_REFUSAL_PHASE: 'review',
    FAKE_LIFECYCLE_REFUSAL_COUNT: '2',
    FAKE_LIFECYCLE_PROMPT_LOG: promptLog,
  });
  const { projectDir, sessionDir } = setupLifecycleRun(env);
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const originalCriteria = structuredClone(manifest.tickets[0].acceptance_criteria);
  manifest.tickets[0].verification = ['node -e "const ids=[...s.matchAll(new RegExp(`(AR-`+p+)`,`g`))]"'];
  writeJson(manifestPath, manifest);

  runNode([path.join(repoRoot, 'bin/mux-runner.js'), sessionDir, '--on-failure=retry'], { env, cwd: projectDir });

  const calls = fs.readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.args[0] === 'exec');
  assert.ok(calls.length <= 15, `expected <=15 model calls, got ${calls.length}`);
  assert.equal(calls.length, 13);
  const phases = calls.map((entry) => path.basename(entry.args[entry.args.indexOf('--output-last-message') + 1] || '').split('.')[1]);
  assert.equal(phases.filter((phase) => phase === 'research').length, 1);
  assert.equal(phases.filter((phase) => phase === 'plan').length, 1);
  assert.equal(phases[0], 'contract-repair');
  const repairedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(repairedManifest.tickets[0].acceptance_criteria, originalCriteria);
  assert.equal(parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')).status, 'Done');
  const finalImplementPrompt = fs.readFileSync(path.join(promptLog, 'implement.prompt.txt'), 'utf8');
  assert.match(finalImplementPrompt, /Mandatory recovery strategy:/);
  assert.match(finalImplementPrompt, /rejected candidate was restored from durable ref/);
});

for (const [label, envFlag, phase, expected] of [
  ['missing', 'FAKE_LIFECYCLE_MISSING_PHASE', 'plan', /worker-lifecycle-missing-artifact/],
  ['invalid', 'FAKE_LIFECYCLE_INVALID_PHASE', 'plan_review', /worker-lifecycle-invalid-artifact/],
]) {
  test(`worker lifecycle fails closed on a ${label} pre-implementation artifact`, () => {
    const fakeBin = makeTempRoot(`pickle-worker-lifecycle-${label}-bin-`);
    createFakeCodex(fakeBin);
    const env = prependPath(fakeBin, {
      PICKLE_DATA_ROOT: makeTempRoot(),
      FAKE_CODEX_MUTATE_FILE: 'feature.txt',
      FAKE_CODEX_APPEND_TEXT: 'must-not-run\n',
      [envFlag]: phase,
    });
    const { projectDir, sessionDir, baseline } = setupLifecycleRun(env);

    assert.throws(
      () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'R1'], { env, cwd: projectDir }),
      expected,
    );

    assert.equal(git(projectDir, ['rev-parse', 'HEAD']), baseline);
    assert.equal(git(projectDir, ['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8'), 'base\n');
    const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
    assert.equal(ticket.status, 'Blocked');
    assert.match(String(ticket.frontmatter.failure_reason), expected);
    assert.ok(!fs.existsSync(path.join(sessionDir, 'worker-lifecycle', 'r1', 'implement.json')));
  });
}
