import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTicketFile, readJsonFile } from '../lib/pickle-utils.js';
import { createFakeCodex, createFakeTmux, makeTempRoot, prependPath, repoRoot, runNode, writeExecutable, writeJson } from './helpers.js';

function writePreflightManifest(sessionDir, verificationEnv, verificationCommand = 'node -e "process.exit(0)"') {
  writeJson(path.join(sessionDir, 'refinement_manifest.json'), {
    tickets: [
      {
        id: 'R1',
        title: 'Env-gated ticket',
        description: 'Requires deterministic verification env.',
        acceptance_criteria: ['Verification can run with the required env contract.'],
        verification: [verificationCommand],
        verification_env: verificationEnv,
        priority: 'P1',
        status: 'Todo',
      },
    ],
  });
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
  const ticket = parseTicketFile(path.join(sessionDir, 'r1', 'linear_ticket_r1.md'));
  assert.equal(result.status, 'done');
  assert.equal(ticket.status, 'Done');
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
