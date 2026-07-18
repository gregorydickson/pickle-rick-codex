// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTicketVerificationReady, PreflightError } from '../services/verification-env.js';

test('verification preflight rejects a command whose executable is missing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-preflight-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['definitely-not-a-real-pickle-executable --version'] },
      config: null,
      cwd,
      ambientEnv: { PATH: cwd },
    }),
    (error) => error instanceof PreflightError
      && error.kind === 'preflight-missing-executable'
      && error.prerequisite === 'definitely-not-a-real-pickle-executable',
  );
});

test('verification preflight rejects unquoted glob expansion but accepts an explicitly quoted pattern', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-glob-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['/usr/bin/find src/*.ts'] },
      config: null,
      cwd,
    }),
    (error) => error instanceof PreflightError && error.kind === 'preflight-unsafe-glob',
  );
  assert.doesNotThrow(() => assertTicketVerificationReady({
    ticket: { id: 'R1', verification: ["/usr/bin/find 'src/*.ts'"] },
    config: null,
    cwd,
  }));
});

test('verification preflight checks every executable in a compound command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-command-compound-'));
  assert.throws(
    () => assertTicketVerificationReady({
      ticket: { id: 'R1', verification: ['/usr/bin/true && missing-after-and'] },
      config: null,
      cwd,
      ambientEnv: { PATH: cwd },
    }),
    /preflight-missing-executable/,
  );
});
