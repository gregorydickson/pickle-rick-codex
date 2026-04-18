import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { makeTempRoot, repoRoot, runNode, writeJson } from './helpers.js';

function createSessionFixture(dataRoot, ticketContent) {
  const sessionDir = path.join(dataRoot, 'sessions', 'session-a');
  fs.mkdirSync(path.join(sessionDir, 'ticket-a'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'ticket-a', 'linear_ticket_ticket-a.md'),
    ticketContent,
  );
  writeJson(path.join(sessionDir, 'state.json'), {
    active: true,
    working_dir: repoRoot,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 10,
    worker_timeout_seconds: 60,
    start_time_epoch: 0,
    original_prompt: 'test',
    current_ticket: 'ticket-a',
    history: [],
    started_at: '2026-04-15T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 1,
  });
  writeJson(path.join(dataRoot, 'current_sessions.json'), {
    [repoRoot]: sessionDir,
  });
}

test('config protection blocks protected file writes without an override', () => {
  const dataRoot = makeTempRoot();
  createSessionFixture(
    dataRoot,
    '---\nid: "ticket-a"\ntitle: "A"\nstatus: "Todo"\n---\n# body\n',
  );

  const output = runNode(
    ['bin/config-protection.js'],
    {
      env: { PICKLE_DATA_ROOT: dataRoot, PICKLE_ACTIVE_TICKET: 'ticket-a' },
      input: JSON.stringify({ tool_input: { file_path: 'package.json' } }),
    },
  ).trim();

  assert.match(output, /"decision":"block"/);
});

test('config protection allows protected writes with config_change override', () => {
  const dataRoot = makeTempRoot();
  createSessionFixture(
    dataRoot,
    '---\nid: "ticket-a"\ntitle: "A"\nstatus: "Todo"\nconfig_change: true\n---\n# body\n',
  );

  const output = runNode(
    ['bin/config-protection.js'],
    {
      env: { PICKLE_DATA_ROOT: dataRoot, PICKLE_ACTIVE_TICKET: 'ticket-a' },
      input: JSON.stringify({ tool_input: { file_path: 'package.json' } }),
    },
  ).trim();

  assert.match(output, /"decision":"approve"/);
});

test('config protection blocks install.sh when it is invoked through a shell command', () => {
  const dataRoot = makeTempRoot();
  createSessionFixture(
    dataRoot,
    '---\nid: "ticket-a"\ntitle: "A"\nstatus: "Todo"\n---\n# body\n',
  );

  const output = runNode(
    ['bin/config-protection.js'],
    {
      env: { PICKLE_DATA_ROOT: dataRoot, PICKLE_ACTIVE_TICKET: 'ticket-a' },
      input: JSON.stringify({ tool_input: { command: 'bash ./install.sh --project /tmp/workspace' } }),
    },
  ).trim();

  assert.match(output, /"decision":"block"/);
  assert.match(output, /install\.sh/);
});

test('loadConfig falls back to safe defaults when nested config shapes are malformed', () => {
  const dataRoot = makeTempRoot();
  const configPath = path.join(dataRoot, 'config.json');
  writeJson(configPath, {
    runtime: 'codex --bad-shape',
    defaults: {
      max_iterations: 'lots',
      activity_logging: 'yes',
      circuit_breaker: ['broken'],
    },
    hooks: {
      enabled: 'sometimes',
      validated_events: 'SessionStart',
    },
  });

  const config = loadConfig(configPath);

  assert.equal(config.runtime.command, 'codex');
  assert.deepEqual(config.runtime.exec_args, ['--full-auto']);
  assert.equal(config.defaults.max_iterations, 25);
  assert.equal(config.defaults.max_time_minutes, 0);
  assert.equal(config.defaults.activity_logging, true);
  assert.deepEqual(config.defaults.circuit_breaker, {
    enabled: true,
    no_progress_threshold: 5,
    half_open_after: 2,
    same_error_threshold: 5,
  });
  assert.equal(config.hooks.enabled, true);
  assert.deepEqual(config.hooks.validated_events, ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse']);
});
