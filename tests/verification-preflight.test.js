import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runTicket, subtractBaselineFailures } from '../bin/spawn-morty.js';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { buildTicketPhasePrompt } from '../lib/prompts.js';
import { writePipelineContract } from '../lib/pipeline.js';
import { buildVerificationCommandScope, buildVerificationFailureSet, ensurePipelineState, writeVerificationBaselines } from '../lib/pipeline-state.js';
import { normalizeVerificationCommands, resolveTicketVerificationContract } from '../lib/verification-env.js';
import { createFakeCodex, createFakeTmux, makeTempRoot, prependPath, repoRoot, runNode, writeJson } from './helpers.js';

function runGit(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writePreflightManifest(sessionDir, verificationEnv, verification = ['node -e "process.exit(0)"']) {
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Env-gated ticket',
        description: 'Requires deterministic verification env.',
        acceptance_criteria: ['Verification can run with the required env contract.'],
        verification,
        verification_env: verificationEnv,
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
}

function buildVerificationWriteCommand(targetPath, contents) {
  return `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(targetPath)}, ${JSON.stringify(contents)})`)}`;
}

function buildVerificationReadCommand(targetPath, expectedContents) {
  return `node -e ${JSON.stringify(`const fs = require('node:fs'); if (fs.readFileSync(${JSON.stringify(targetPath)}, 'utf8') !== ${JSON.stringify(expectedContents)}) process.exit(1);`)}`;
}

async function runTicketWithEnv(sessionDir, ticketId, envPatch) {
  const previous = new Map();
  for (const [key, value] of Object.entries(envPatch || {})) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    return await runTicket(sessionDir, ticketId);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('pickle-tmux resume fails fast on missing GITHUB_PACKAGES_TOKEN and recovers on resume once provided', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-preflight-resume.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const baseEnv = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'resume gated session'], {
    env: baseEnv,
    cwd: projectDir,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Existing PRD\n\n## Summary\nResume from this PRD.\n');
  writePreflightManifest(sessionDir, {
    mode: 'replace',
    required: ['GITHUB_PACKAGES_TOKEN'],
    vars: {
      GITHUB_PACKAGES_TOKEN: { from_env: 'GITHUB_PACKAGES_TOKEN' },
    },
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
      env: baseEnv,
      cwd: projectDir,
    }),
    /preflight-missing-env: GITHUB_PACKAGES_TOKEN is required for verification/,
  );

  const blockedState = readJsonFile(path.join(sessionDir, 'state.json'));
  const blockedTicket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const blockedStatus = runNode([path.join(repoRoot, 'bin/status.js'), '--session-dir', sessionDir], {
    env: baseEnv,
    cwd: projectDir,
  }).trim();

  assert.equal(blockedState.last_exit_reason, 'preflight-missing-env');
  assert.equal(blockedState.step, 'blocked');
  assert.equal(blockedState.current_ticket, 'r1');
  assert.equal(blockedTicket.status, 'Todo');
  assert.equal(blockedTicket.frontmatter.failure_kind, 'preflight-missing-env');
  assert.match(blockedTicket.frontmatter.failure_reason, /GITHUB_PACKAGES_TOKEN/);
  assert.match(blockedStatus, /Last Exit: preflight-missing-env/);
  assert.match(blockedStatus, /Last Failure: preflight-missing-env: GITHUB_PACKAGES_TOKEN is required for verification/);

  const resumedOutput = runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
    env: {
      ...baseEnv,
      GITHUB_PACKAGES_TOKEN: 'token-from-env',
    },
    cwd: projectDir,
  }).trim();

  assert.match(resumedOutput, /Pickle Rick tmux mode launched/);
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(tmuxLines.some((args) => args[0] === 'new-session'));
});

test('pickle-tmux blocks malformed DATABASE_URL before detached launch', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-preflight-invalid-url.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
    DATABASE_URL: 'not-a-url',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'invalid database url'], {
    env,
    cwd: projectDir,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Existing PRD\n\n## Summary\nResume from this PRD.\n');
  writePreflightManifest(sessionDir, {
    mode: 'replace',
    required: [{ name: 'DATABASE_URL', format: 'url' }],
    vars: {
      DATABASE_URL: { from_env: 'DATABASE_URL' },
    },
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
      env,
      cwd: projectDir,
    }),
    /preflight-invalid-env: DATABASE_URL must be a valid URL for verification/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(state.last_exit_reason, 'preflight-invalid-env');
  assert.ok(!tmuxLines.some((args) => args[0] === 'new-session'));
});

test('spawn-morty uses deterministic verification env when configured', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    GOOD_DATABASE_URL: 'https://example.com/deterministic',
    SHOULD_NOT_EXIST: 'ambient-leak',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'deterministic verification env'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Deterministic verification',
        description: 'Verification should run with replace-mode env.',
        acceptance_criteria: ['Verification succeeds with deterministic env replacement.'],
        verification: [
          'node -e "if (process.env.SHOULD_NOT_EXIST) process.exit(1); if (process.env.DATABASE_URL !== \'https://example.com/deterministic\') process.exit(1); process.exit(0)"',
        ],
        verification_env: {
          mode: 'replace',
          required: [{ name: 'DATABASE_URL', format: 'url' }],
          vars: {
            DATABASE_URL: { from_env: 'GOOD_DATABASE_URL' },
          },
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();

  const result = JSON.parse(output);
  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(result.status, 'done');
  assert.equal(result.applied, false);
  assert.equal(state.step, 'done');
  assert.equal(state.history.at(-1)?.step, 'done');
  assert.equal(ticket.status, 'Done');
});

test('spawn-morty works directly in the current branch working tree', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-working-branch-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_MUTATE_FILE: 'feature.txt',
    FAKE_CODEX_MUTATE_PHASE: 'implement',
    FAKE_CODEX_APPEND_TEXT: 'agent-change\n',
  });

  runGit(projectDir, ['init']);
  runGit(projectDir, ['config', 'user.name', 'Pickle Rick Tests']);
  runGit(projectDir, ['config', 'user.email', 'pickle-rick-tests@example.com']);
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\n');
  runGit(projectDir, ['add', 'feature.txt']);
  runGit(projectDir, ['commit', '-m', 'base']);
  const baseHead = runGit(projectDir, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(projectDir, 'feature.txt'), 'base\nuser-change\n');

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'working tree ticket'], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Working branch execution',
        description: 'Run directly in the repository working tree.',
        acceptance_criteria: ['The ticket succeeds on top of existing uncommitted branch changes.'],
        verification: [
          'node -e "const fs = require(\'fs\'); const text = fs.readFileSync(\'feature.txt\', \'utf8\'); if (text !== \'base\\nuser-change\\nagent-change\\n\') process.exit(1)"',
        ],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: projectDir,
  }).trim();

  const result = JSON.parse(output);
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(result.status, 'done');
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(projectDir, 'feature.txt'), 'utf8'), 'base\nuser-change\nagent-change\n');
  assert.equal(runGit(projectDir, ['rev-parse', 'HEAD']).trim(), baseHead);
  assert.equal(ticket.status, 'Done');
});

test('spawn-morty executes object-wrapped verification commands after shared normalization', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'object wrapped verification execution'], {
    env,
    cwd: repoRoot,
  }).trim();
  const proofPath = path.join(sessionDir, 'verification-proof.txt');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Object wrapped verification execution',
        description: 'Executor uses normalized object-wrapped verification commands.',
        acceptance_criteria: ['Object wrapped verification commands execute without executor-local parsing.'],
        verification: {
          commands: [
            {
              command: buildVerificationWriteCommand(proofPath, 'verified\n'),
              expect: { exitCode: 0 },
            },
            {
              command: buildVerificationReadCommand(proofPath, 'verified\n'),
              expect: { exitCode: 0 },
            },
          ],
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();

  const result = JSON.parse(output);
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(proofPath, 'utf8'), 'verified\n');
});

test('spawn-morty executes array-of-object verification commands after shared normalization', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'array object verification execution'], {
    env,
    cwd: repoRoot,
  }).trim();
  const proofPath = path.join(sessionDir, 'verification-proof.txt');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Array object verification execution',
        description: 'Executor uses normalized array-of-object verification commands.',
        acceptance_criteria: ['Array object verification commands execute without executor-local parsing.'],
        verification: [
          { command: buildVerificationWriteCommand(proofPath, 'verified\n') },
          { command: buildVerificationReadCommand(proofPath, 'verified\n') },
        ],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();

  const result = JSON.parse(output);
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(proofPath, 'utf8'), 'verified\n');
});

test('spawn-morty preserves quoted && inside string-form verification commands', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'quoted verification command'], {
    env,
    cwd: repoRoot,
  }).trim();
  const proofPath = path.join(sessionDir, 'verification-proof.txt');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Quoted verification command',
        description: 'String verification should only split on shell-level && operators.',
        acceptance_criteria: ['Quoted logical operators inside a single verification command are preserved.'],
        verification: `node -e ${JSON.stringify(`const fs = require('node:fs'); const ok = true && true; if (!ok) process.exit(1); fs.writeFileSync(${JSON.stringify(proofPath)}, 'verified\\n');`)}`,
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();

  const result = JSON.parse(output);
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(proofPath, 'utf8'), 'verified\n');
});

test('spawn-morty rewrites scoped vitest verification commands into targeted execution', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-vitest-project-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'vitest-fixture',
    private: true,
    scripts: {
      test: 'vitest run --config vitest.config.mjs',
    },
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'vitest.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(projectDir, 'tests', 'targeted.test.ts'), 'export {};\n');
  fs.writeFileSync(path.join(fakeBin, 'pnpm'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const broadMarker = path.join(process.cwd(), 'broad-suite-ran.txt');
const targetedMarker = path.join(process.cwd(), 'targeted-suite-ran.txt');
if (args[0] === 'test') {
  fs.writeFileSync(broadMarker, args.join(' ') + '\\n');
  console.error('broad test wrapper invoked');
  process.exit(1);
}
if (
  args[0] === 'exec'
  && args[1] === 'vitest'
  && args[2] === 'run'
  && args.includes('--config')
  && args.includes('tests/targeted.test.ts')
) {
  fs.writeFileSync(targetedMarker, args.join(' ') + '\\n');
  process.exit(0);
}
console.error('unexpected pnpm invocation: ' + args.join(' '));
process.exit(1);
`, { mode: 0o755 });
  fs.chmodSync(path.join(fakeBin, 'pnpm'), 0o755);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'targeted vitest verification'], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Targeted vitest verification',
        description: 'Scoped verification should rewrite into a targeted vitest run.',
        acceptance_criteria: ['Scoped vitest verification runs only the targeted file.'],
        verification: ['pnpm test -- tests/targeted.test.ts'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: projectDir,
  }).trim();

  const result = JSON.parse(output);
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  const prompt = buildTicketPhasePrompt({
    phase: 'implement',
    ticket: {
      id: 'R1',
      title: 'Targeted vitest verification',
      description: 'Scoped verification should rewrite into a targeted vitest run.',
      acceptance_criteria: ['Scoped vitest verification runs only the targeted file.'],
      verification: ['pnpm test -- tests/targeted.test.ts'],
    },
    sessionDir,
    workingDir: projectDir,
  });

  assert.equal(result.status, 'done');
  assert.equal(ticket.status, 'Done');
  assert.ok(fs.existsSync(path.join(projectDir, 'targeted-suite-ran.txt')));
  assert.ok(!fs.existsSync(path.join(projectDir, 'broad-suite-ran.txt')));
  assert.match(
    fs.readFileSync(path.join(projectDir, 'targeted-suite-ran.txt'), 'utf8'),
    /exec vitest run --config vitest\.config\.mjs tests\/targeted\.test\.ts/,
  );
  assert.match(prompt, /'pnpm' 'exec' 'vitest' 'run' '--config' 'vitest\.config\.mjs' 'tests\/targeted\.test\.ts'/);
});

test('spawn-morty rewrites npm --prefix scoped vitest verification commands into targeted execution', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-npm-prefix-vitest-project-');
  const packageDir = path.join(projectDir, 'packages', 'app');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'npm-prefix-vitest-fixture',
    private: true,
    scripts: {
      test: 'vitest run --config vitest.config.mjs',
    },
  }, null, 2));
  fs.writeFileSync(path.join(packageDir, 'vitest.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(packageDir, 'tests', 'targeted.test.ts'), 'export {};\n');
  fs.writeFileSync(path.join(fakeBin, 'npm'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const broadMarker = path.join(process.cwd(), 'broad-suite-ran.txt');
const targetedMarker = path.join(process.cwd(), 'targeted-suite-ran.txt');
if (args[0] === 'test') {
  fs.writeFileSync(broadMarker, args.join(' ') + '\\n');
  console.error('broad test wrapper invoked');
  process.exit(1);
}
if (
  args[0] === 'exec'
  && args[1] === '--'
  && args[2] === 'vitest'
  && args[3] === 'run'
  && args.includes('--config')
  && args.includes('tests/targeted.test.ts')
) {
  fs.writeFileSync(targetedMarker, args.join(' ') + '\\n');
  process.exit(0);
}
console.error('unexpected npm invocation: ' + args.join(' '));
process.exit(1);
`, { mode: 0o755 });
  fs.chmodSync(path.join(fakeBin, 'npm'), 0o755);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'targeted npm prefix vitest verification'], {
    env,
    cwd: projectDir,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Targeted npm prefix vitest verification',
        description: 'Scoped verification should rewrite npm --prefix into a targeted vitest run.',
        acceptance_criteria: ['Scoped npm --prefix vitest verification runs only the targeted file.'],
        verification: ['npm --prefix packages/app test -- tests/targeted.test.ts'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: projectDir,
  }).trim();

  const result = JSON.parse(output);
  assert.equal(result.status, 'done');
  assert.ok(fs.existsSync(path.join(packageDir, 'targeted-suite-ran.txt')));
  assert.ok(!fs.existsSync(path.join(projectDir, 'broad-suite-ran.txt')));
  assert.match(
    fs.readFileSync(path.join(packageDir, 'targeted-suite-ran.txt'), 'utf8'),
    /exec -- vitest run --config vitest\.config\.mjs tests\/targeted\.test\.ts/,
  );
});

test('normalizeVerificationCommands leaves unknown runners unchanged', () => {
  const projectDir = makeTempRoot('pickle-rick-non-vitest-project-');
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'non-vitest-fixture',
    private: true,
    scripts: {
      test: 'node custom-runner.js',
    },
  }, null, 2));

  const commands = normalizeVerificationCommands(['pnpm test -- tests/targeted.test.ts'], {
    cwd: projectDir,
  });

  assert.deepEqual(commands, ['pnpm test -- tests/targeted.test.ts']);
});

test('spawn-morty stops phases promptly after writing phase promise tokens', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_CODEX_HANG_MS: '3000',
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'phase promise stop'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Phase promise stop',
        description: 'Phase runs should stop promptly once the promise token is written.',
        acceptance_criteria: ['The ticket completes without waiting for each lingering fake codex process to self-exit.'],
        verification: ['node -e "process.exit(0)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const started = Date.now();
  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 7000, `spawn-morty took too long after phase success: ${elapsed}ms`);
  const result = JSON.parse(output);
  assert.equal(result.status, 'done');
});

test('spawn-morty distinguishes normal verification command failure from preflight failures', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'verification failure'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Verification failure',
        description: 'The verification command itself fails.',
        acceptance_criteria: ['Failure is reported as a command failure, not a preflight failure.'],
        verification: ['node -e "process.exit(7)"'],
        verification_env: {
          mode: 'replace',
          vars: {
            NODE_ENV: 'test',
          },
        },
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /verification-command-failed:/,
  );

  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Blocked');
  assert.equal(ticket.frontmatter.failure_kind, 'command_failed');
  assert.match(ticket.frontmatter.failure_reason, /verification-command-failed:/);
});

test('spawn-morty subtracts persisted broad node --test baseline failures before blocking a pipeline ticket', { concurrency: false }, async () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-broad-baseline-project-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'baseline-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('baseline red', () => {
  assert.equal(1, 2);
});
`);
  fs.writeFileSync(path.join(projectDir, 'tests', 'ticket-pass.test.js'), `
import test from 'node:test';
test('ticket pass', () => {});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'subtract known reds'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'subtract known reds',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Subtract known reds',
        description: 'Broad node --test runs should ignore matching baseline reds.',
        acceptance_criteria: ['Known unrelated reds do not block the ticket.'],
        verification: ['node --test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'node --test';
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [buildVerificationCommandScope(command, projectDir).key]: {
          command,
          scope: buildVerificationCommandScope(command, projectDir),
          failures: [
            {
              identity: 'tests/baseline-red.test.js::baseline red',
              file: 'tests/baseline-red.test.js',
              testName: 'baseline red',
              in_scope: false,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const result = await runTicketWithEnv(sessionDir, 'r1', env);
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(result.status, 'done');
  assert.equal(ticket.status, 'Done');
});

test('spawn-morty still blocks a broad node --test ticket when verification reports a new failure outside the baseline', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-broad-new-red-project-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'baseline-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('baseline red', () => {
  assert.equal(1, 2);
});
`);
  fs.writeFileSync(path.join(projectDir, 'tests', 'new-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('new red', () => {
  assert.equal(3, 4);
});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'new failure outside baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'new failure outside baseline',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'New failure outside baseline',
        description: 'Broad node --test runs should still block on new reds.',
        acceptance_criteria: ['New failures still block the ticket.'],
        verification: ['node --test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'node --test';
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [buildVerificationCommandScope(command, projectDir).key]: {
          command,
          scope: buildVerificationCommandScope(command, projectDir),
          failures: [
            {
              identity: 'tests/baseline-red.test.js::baseline red',
              file: 'tests/baseline-red.test.js',
              testName: 'baseline red',
              in_scope: false,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, [
    {
      identity: 'tests/baseline-red.test.js::baseline red',
      file: 'tests/baseline-red.test.js',
      testName: 'baseline red',
      in_scope: false,
      source: 'node-test',
    },
    {
      identity: 'tests/new-red.test.js::new red',
      file: 'tests/new-red.test.js',
      testName: 'new red',
      in_scope: false,
      source: 'node-test',
    },
  ]);

  assert.deepEqual(
    remaining.map((failure) => failure.identity),
    ['tests/new-red.test.js::new red'],
  );
});

test('spawn-morty still blocks explicit in-scope node --test failures even when the same identity exists in the baseline', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-scoped-baseline-project-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'scoped-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('scoped red', () => {
  assert.equal(5, 6);
});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'scoped failure baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'scoped failure baseline',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Scoped failure baseline',
        description: 'Explicit node --test targets remain blocking even if they were red in the baseline.',
        acceptance_criteria: ['In-scope failures still block the ticket.'],
        verification: ['node --test tests/scoped-red.test.js'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'node --test tests/scoped-red.test.js';
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [buildVerificationCommandScope(command, projectDir).key]: {
          command,
          scope: buildVerificationCommandScope(command, projectDir),
          failures: [
            {
              identity: 'tests/scoped-red.test.js::scoped red',
              file: 'tests/scoped-red.test.js',
              testName: 'scoped red',
              in_scope: true,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, [
    {
      identity: 'tests/scoped-red.test.js::scoped red',
      file: 'tests/scoped-red.test.js',
      testName: 'scoped red',
      in_scope: true,
      source: 'node-test',
    },
  ]);

  assert.deepEqual(
    remaining.map((failure) => failure.identity),
    ['tests/scoped-red.test.js::scoped red'],
  );
});

test('spawn-morty still blocks scoped package-manager test failures when the same identity exists in the baseline', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  const projectDir = makeTempRoot('pickle-rick-scoped-package-baseline-project-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  writeJson(path.join(projectDir, 'package.json'), {
    name: 'scoped-package-baseline',
    private: true,
    scripts: {
      test: 'node --test',
    },
  });
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'scoped-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('spawn-morty still blocks scoped package-manager test failures when the same identity exists in the baseline', () => {
  assert.equal(7, 8);
});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'scoped package failure baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'scoped package failure baseline',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Scoped package failure baseline',
        description: 'Scoped package-manager verification must keep explicit target failures blocking.',
        acceptance_criteria: ['A targeted package-manager test failure still blocks the ticket even if it is persisted in the baseline.'],
        verification: ['npm test -- tests/scoped-red.test.js'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'npm test -- tests/scoped-red.test.js';
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [buildVerificationCommandScope(command, projectDir).key]: {
          command,
          scope: buildVerificationCommandScope(command, projectDir),
          failures: [
            {
              identity: 'tests/scoped-red.test.js::spawn-morty still blocks scoped package-manager test failures when the same identity exists in the baseline',
              file: 'tests/scoped-red.test.js',
              testName: 'spawn-morty still blocks scoped package-manager test failures when the same identity exists in the baseline',
              in_scope: true,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const verificationResult = spawnSync('npm', ['test', '--', 'tests/scoped-red.test.js'], {
    cwd: projectDir,
    env: {
      ...env,
      NODE_OPTIONS: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(verificationResult.status, 0);

  const failures = buildVerificationFailureSet({
    command,
    cwd: projectDir,
    stdout: verificationResult.stdout || '',
    stderr: verificationResult.stderr || '',
    exitCode: verificationResult.status ?? 1,
  });
  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, failures);

  assert.deepEqual(
    remaining.map((failure) => failure.identity),
    ['tests/scoped-red.test.js::spawn-morty still blocks scoped package-manager test failures when the same identity exists in the baseline'],
  );
});

test('spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-prefix-scoped-package-baseline-project-');
  const packageDir = path.join(projectDir, 'packages', 'app');
  const env = { PICKLE_DATA_ROOT: dataRoot };

  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  writeJson(path.join(packageDir, 'package.json'), {
    name: 'prefix-scoped-package-baseline',
    private: true,
    scripts: {
      test: 'node --test',
    },
  });
  fs.writeFileSync(path.join(packageDir, 'tests', 'scoped-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline', () => {
  assert.equal(9, 10);
});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'prefixed scoped package failure baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'prefixed scoped package failure baseline',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Prefixed scoped package failure baseline',
        description: 'Scoped package-manager verification with --prefix must keep explicit target failures blocking.',
        acceptance_criteria: ['A targeted npm --prefix test failure still blocks the ticket even if it is persisted in the baseline.'],
        verification: ['npm --prefix packages/app test -- tests/scoped-red.test.js'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'npm --prefix packages/app test -- tests/scoped-red.test.js';
  const scope = buildVerificationCommandScope(command, projectDir);
  assert.equal(scope.key, 'package-test:packages/app/tests/scoped-red.test.js');
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [scope.key]: {
          command,
          scope,
          failures: [
            {
              identity: 'packages/app/tests/scoped-red.test.js::spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline',
              file: 'packages/app/tests/scoped-red.test.js',
              testName: 'spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline',
              in_scope: true,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const failures = buildVerificationFailureSet({
    command,
    cwd: projectDir,
    stdout: [
      '> test',
      '> node --test tests/scoped-red.test.js',
      '',
      '✖ spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline (0.6055ms)',
      'ℹ tests 1',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at tests/scoped-red.test.js:3:1',
      '✖ spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline (0.6055ms)',
    ].join('\n'),
    stderr: '',
    exitCode: 1,
  });
  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, failures);

  assert.deepEqual(
    remaining.map((failure) => failure.identity),
    ['packages/app/tests/scoped-red.test.js::spawn-morty still blocks prefixed scoped package-manager test failures when the same identity exists in the baseline'],
  );
});

test('spawn-morty migrates legacy scoped package-manager baseline keys before subtracting known unrelated failures', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-prefix-package-baseline-project-');
  const packageDir = path.join(projectDir, 'packages', 'app');
  const env = { PICKLE_DATA_ROOT: dataRoot };

  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  writeJson(path.join(packageDir, 'package.json'), {
    name: 'prefix-scoped-package-baseline',
    private: true,
    scripts: {
      test: 'node --test',
    },
  });
  fs.writeFileSync(path.join(packageDir, 'tests', 'scoped-red.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('spawn-morty migrates legacy scoped package-manager baseline keys before subtracting known unrelated failures', () => {
  assert.equal(7, 8);
});
`);

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'prefix scoped package failure baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'prefix scoped package failure baseline',
  });
  ensurePipelineState(sessionDir);
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Prefix scoped package failure baseline',
        description: 'Scoped package-manager verification must keep explicit prefixed target failures blocking.',
        acceptance_criteria: ['A targeted npm --prefix test failure still blocks the ticket even if it is persisted in the baseline.'],
        verification: ['npm --prefix packages/app test -- tests/scoped-red.test.js'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
  const command = 'npm --prefix packages/app test -- tests/scoped-red.test.js';
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [`command:${command}`]: {
          command,
          scope: {
            key: `command:${command}`,
            kind: 'command',
            command,
            targets: [],
          },
          failures: [
            {
              identity: 'packages/app/tests/unrelated-red.test.js::known unrelated red',
              file: 'packages/app/tests/unrelated-red.test.js',
              testName: 'known unrelated red',
              in_scope: false,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const failures = [
    {
      identity: 'packages/app/tests/unrelated-red.test.js::known unrelated red',
      file: 'packages/app/tests/unrelated-red.test.js',
      testName: 'known unrelated red',
      in_scope: false,
      source: 'node-test',
    },
  ];
  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, failures);

  assert.deepEqual(remaining, []);
});

test('spawn-morty preserves absolute --prefix scoped baseline keys across session-state normalization', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-absolute-prefix-package-baseline-project-');
  const packageDir = path.join(projectDir, 'packages', 'app');
  const env = { PICKLE_DATA_ROOT: dataRoot };

  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  writeJson(path.join(packageDir, 'package.json'), {
    name: 'absolute-prefix-scoped-package-baseline',
    private: true,
    scripts: {
      test: 'node --test',
    },
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'absolute prefix scoped package failure baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'absolute prefix scoped package failure baseline',
  });
  ensurePipelineState(sessionDir);

  const command = `npm --prefix ${packageDir} test -- tests/scoped-red.test.js`;
  const scope = buildVerificationCommandScope(command, projectDir);
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [scope.key]: {
          command,
          scope,
          failures: [
            {
              identity: 'packages/app/tests/unrelated-red.test.js::known unrelated red',
              file: 'packages/app/tests/unrelated-red.test.js',
              testName: 'known unrelated red',
              in_scope: false,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const failures = [
    {
      identity: 'packages/app/tests/unrelated-red.test.js::known unrelated red',
      file: 'packages/app/tests/unrelated-red.test.js',
      testName: 'known unrelated red',
      in_scope: false,
      source: 'node-test',
    },
  ];
  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, failures);

  assert.deepEqual(remaining, []);
});

test('spawn-morty migrates legacy absolute node --test baseline keys against the session working dir', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-absolute-node-baseline-project-');
  const env = { PICKLE_DATA_ROOT: dataRoot };

  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  const targetedPath = path.join(projectDir, 'tests', 'targeted-red.test.js');

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'absolute node test baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'absolute node test baseline',
  });
  ensurePipelineState(sessionDir);

  const command = `node --test ${targetedPath}`;
  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [`command:${command}`]: {
          command,
          scope: {
            key: `command:${command}`,
            kind: 'command',
            command,
            targets: [],
          },
          failures: [
            {
              identity: 'tests/unrelated-red.test.js::known unrelated red',
              file: 'tests/unrelated-red.test.js',
              testName: 'known unrelated red',
              in_scope: false,
              source: 'node-test',
            },
          ],
        },
      },
    },
  });

  const failures = [
    {
      identity: 'tests/unrelated-red.test.js::known unrelated red',
      file: 'tests/unrelated-red.test.js',
      testName: 'known unrelated red',
      in_scope: false,
      source: 'node-test',
    },
  ];
  const remaining = subtractBaselineFailures(sessionDir, 'r1', command, projectDir, failures);

  assert.deepEqual(remaining, []);
});

test('spawn-morty preserves scoped baseline subtraction after rewriting npm --prefix vitest verification', { concurrency: false }, () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-rewritten-prefix-vitest-baseline-project-');
  const packageDir = path.join(projectDir, 'packages', 'app');
  const env = { PICKLE_DATA_ROOT: dataRoot };

  fs.mkdirSync(path.join(packageDir, 'tests'), { recursive: true });
  writeJson(path.join(packageDir, 'package.json'), {
    name: 'rewritten-prefix-vitest-baseline',
    private: true,
    scripts: {
      test: 'vitest run --config vitest.config.mjs',
    },
  });
  fs.writeFileSync(path.join(packageDir, 'vitest.config.mjs'), 'export default {};\n');

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'rewritten prefix vitest baseline'], {
    env,
    cwd: projectDir,
  }).trim();
  writePipelineContract(sessionDir, {
    working_dir: projectDir,
    target: projectDir,
    phases: ['pickle'],
    bootstrap_source: 'task',
    task: 'rewritten prefix vitest baseline',
  });
  ensurePipelineState(sessionDir);

  const originalCommand = 'npm --prefix packages/app test -- tests/targeted.test.ts';
  const rewrittenCommand = normalizeVerificationCommands([originalCommand], { cwd: projectDir })[0];
  const rewrittenScope = buildVerificationCommandScope(rewrittenCommand, projectDir);
  assert.equal(rewrittenScope.key, 'package-test:packages/app/tests/targeted.test.ts');

  writeVerificationBaselines(sessionDir, {
    captured_at: '2026-06-24T00:00:00.000Z',
    by_ticket: {
      r1: {
        [rewrittenScope.key]: {
          command: rewrittenCommand,
          scope: rewrittenScope,
          failures: [
            {
              identity: 'packages/app/tests/unrelated-red.test.ts::known unrelated red',
              file: 'packages/app/tests/unrelated-red.test.ts',
              testName: 'known unrelated red',
              in_scope: false,
              source: 'vitest',
            },
          ],
        },
      },
    },
  });

  const failures = buildVerificationFailureSet({
    command: rewrittenCommand,
    cwd: projectDir,
    stdout: [
      ' FAIL  tests/targeted.test.ts > keeps targeted failures visible',
      ' FAIL  tests/unrelated-red.test.ts > known unrelated red',
    ].join('\n'),
    stderr: '',
    exitCode: 1,
  });
  const remaining = subtractBaselineFailures(sessionDir, 'r1', rewrittenCommand, projectDir, failures);

  assert.deepEqual(
    remaining.map((failure) => failure.identity),
    ['packages/app/tests/targeted.test.ts::keeps targeted failures visible'],
  );
});

test('spawn-morty classifies verification contract execution failures separately from generic command failures', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'verification contract failure'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Verification contract failure',
        description: 'Verification fails while enforcing a declared artifact contract.',
        acceptance_criteria: ['Contract failures are distinct from generic implementation failures.'],
        verification: ['test -f research/proof.txt'],
        output_artifacts: ['research/proof.txt'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /verification-contract-failed:/,
  );

  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Blocked');
  assert.equal(ticket.frontmatter.failure_kind, 'verification-contract-failed');
  assert.match(ticket.frontmatter.failure_reason, /research\/proof\.txt/);
});

test('spawn-morty blocks timed-out verification commands instead of treating signal exits as passing verification', async () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  writeJson(path.join(dataRoot, 'config.json'), {
    defaults: {
      worker_timeout_seconds: 1,
    },
  });
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'timed verification command'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Timed verification command',
        description: 'Verification timeouts must remain blocking failures.',
        acceptance_criteria: ['Timed-out verification commands block the ticket.'],
        verification: ['node -e "setTimeout(() => process.exit(0), 2000)"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  await assert.rejects(async () => {
    await runTicketWithEnv(sessionDir, 'r1', env);
  });

  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Blocked');
  assert.equal(ticket.frontmatter.failure_kind, 'command_failed');
});

test('spawn-morty infers required env vars from verification commands', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'inferred env preflight'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Inferred env verification',
        description: 'Verification references a custom env var without an explicit contract.',
        acceptance_criteria: ['Missing env is caught before verification runs.'],
        verification: ['test -f "$SIBLING_REPO_ROOT/fixture.dot"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /preflight-missing-env: SIBLING_REPO_ROOT is required for verification/,
  );

  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Todo');
  assert.equal(ticket.frontmatter.failure_kind, 'preflight-missing-env');
  assert.match(ticket.frontmatter.failure_reason, /SIBLING_REPO_ROOT/);
});

test('spawn-morty infers env vars from braced shell expansions', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'braced inferred env preflight'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Braced inferred env verification',
        description: 'Verification uses a braced shell parameter expansion without a default.',
        acceptance_criteria: ['Missing env is caught even when the variable is referenced with braces.'],
        verification: ['test -f "${SIBLING_REPO_ROOT}/fixture.dot"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /preflight-missing-env: SIBLING_REPO_ROOT is required for verification/,
  );
});

test('spawn-morty accepts object-shaped verification commands during preflight', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'object verification preflight'], {
    env,
    cwd: repoRoot,
  }).trim();
  writePreflightManifest(
    sessionDir,
    null,
    { commands: ['test -f "$SIBLING_REPO_ROOT/fixture.dot"'] },
  );

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /preflight-missing-env: SIBLING_REPO_ROOT is required for verification/,
  );
});

test('spawn-morty accepts array-of-object verification commands during preflight', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'array object verification preflight'], {
    env,
    cwd: repoRoot,
  }).trim();
  writePreflightManifest(
    sessionDir,
    null,
    [{ command: 'test -f "$SIBLING_REPO_ROOT/fixture.dot"' }],
  );

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /preflight-missing-env: SIBLING_REPO_ROOT is required for verification/,
  );
});

test('spawn-morty fails fast on invalid verification manifests before worker execution', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'invalid verification execution'], {
    env,
    cwd: repoRoot,
  }).trim();
  writePreflightManifest(sessionDir, null, { commands: [{ expect: { exitCode: 0 } }] });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /ticket r1 has invalid verification manifest: expected one or more verification commands/,
  );

  assert.equal(fs.existsSync(path.join(sessionDir, 'r1', 'linear_ticket_r1.md')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'r1.research.last-message.txt')), false);
});

test('spawn-morty infers sibling roots from repo wrapper verification commands', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'wrapper inferred env preflight'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Wrapper inferred env verification',
        description: 'Verification delegates to repo-owned wrapper scripts.',
        acceptance_criteria: ['Missing sibling roots are caught before wrapper verification runs.'],
        verification: ['bun run check:env && bun run validate:attractor'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
      env,
      cwd: repoRoot,
    }),
    /preflight-missing-env: ATTRACTOR_ROOT is required for verification/,
  );

  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(ticket.status, 'Todo');
  assert.equal(ticket.frontmatter.failure_kind, 'preflight-missing-env');
  assert.match(ticket.frontmatter.failure_reason, /ATTRACTOR_ROOT/);
});

test('spawn-morty ignores vars assigned inside verification commands', () => {
  const dataRoot = makeTempRoot();
  const fakeBin = makeTempRoot('pickle-rick-codex-bin-');
  createFakeCodex(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), 'local assignment verification env'], {
    env,
    cwd: repoRoot,
  }).trim();
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Local assignment verification',
        description: 'Verification assigns its own shell variable before using it.',
        acceptance_criteria: ['Shell-local assignments do not trigger missing-env preflight failures.'],
        verification: ['export SIBLING_REPO_ROOT=. ; test -d "$SIBLING_REPO_ROOT"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  const output = runNode([path.join(repoRoot, 'bin/spawn-morty.js'), sessionDir, 'r1'], {
    env,
    cwd: repoRoot,
  }).trim();

  const result = JSON.parse(output);
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(result.status, 'done');
  assert.equal(ticket.status, 'Done');
});

test('pickle-tmux infers required env vars from verification commands before launch', () => {
  const dataRoot = makeTempRoot();
  const projectDir = makeTempRoot('pickle-rick-project-');
  const fakeBin = makeTempRoot('pickle-rick-runtime-bin-');
  const tmuxLog = path.join(dataRoot, 'tmux-inferred-env.jsonl');
  createFakeCodex(fakeBin);
  createFakeTmux(fakeBin);
  const env = prependPath(fakeBin, {
    PICKLE_DATA_ROOT: dataRoot,
    FAKE_TMUX_LOG: tmuxLog,
  });

  const sessionDir = runNode([path.join(repoRoot, 'bin/setup.js'), '--tmux', 'inferred env tmux'], {
    env,
    cwd: projectDir,
  }).trim();
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Existing PRD\n\n## Summary\nResume from this PRD.\n');
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Inferred env tmux ticket',
        description: 'Verification references a custom env var without an explicit contract.',
        acceptance_criteria: ['Missing env is caught before tmux launch.'],
        verification: ['test -f "$EXTERNAL_FIXTURE_ROOT/fixture.dot"'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });

  assert.throws(
    () => runNode([path.join(repoRoot, 'bin/pickle-tmux.js'), '--resume', sessionDir], {
      env,
      cwd: projectDir,
    }),
    /preflight-missing-env: EXTERNAL_FIXTURE_ROOT is required for verification/,
  );

  const state = readJsonFile(path.join(sessionDir, 'state.json'));
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(state.last_exit_reason, 'preflight-missing-env');
  assert.equal(state.step, 'blocked');
  assert.equal(ticket.status, 'Todo');
  assert.equal(ticket.frontmatter.failure_kind, 'preflight-missing-env');
  assert.match(ticket.frontmatter.failure_reason, /EXTERNAL_FIXTURE_ROOT/);
  const tmuxLines = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(!tmuxLines.some((args) => args[0] === 'new-session'));
});

test('resolveTicketVerificationContract ignores shell-default expansions when inferring required env', () => {
  const contract = resolveTicketVerificationContract({
    ticket: {
      verification: [
        'echo "${SIBLING_REPO_ROOT:-/default/path}"',
        'echo "${DATABASE_URL:=fallback}"',
        'echo "${API_TOKEN:?missing token}"',
        'echo "${CACHE_DIR-fallback}"',
      ],
    },
    config: null,
  });
  const required = (contract?.required || []).map((entry) => entry.name);
  assert.ok(!required.includes('SIBLING_REPO_ROOT'), `SIBLING_REPO_ROOT should not be required, got: ${required.join(', ')}`);
  assert.ok(!required.includes('DATABASE_URL'), `DATABASE_URL should not be required, got: ${required.join(', ')}`);
  assert.ok(!required.includes('API_TOKEN'), `API_TOKEN should not be required, got: ${required.join(', ')}`);
  assert.ok(!required.includes('CACHE_DIR'), `CACHE_DIR should not be required, got: ${required.join(', ')}`);
});

test('resolveTicketVerificationContract still infers real unbound variables without defaults', () => {
  const contract = resolveTicketVerificationContract({
    ticket: {
      verification: [
        'test -f "${SIBLING_REPO_ROOT}/fixture.dot"',
        'echo "$DATABASE_URL"',
      ],
    },
    config: null,
  });
  const required = (contract?.required || []).map((entry) => entry.name);
  assert.ok(required.includes('SIBLING_REPO_ROOT'), `SIBLING_REPO_ROOT should be required, got: ${required.join(', ')}`);
  assert.ok(required.includes('DATABASE_URL'), `DATABASE_URL should be required, got: ${required.join(', ')}`);
});
