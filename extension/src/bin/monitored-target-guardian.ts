#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [, command, ...args] = process.argv.slice(2);
if (!command) process.exit(126);

// The guardian provides a stable, nonce-bearing process identity before any
// user command can run. The controller persists that identity, then releases
// this stop fence through the broker.
if (process.platform !== 'win32') process.kill(process.pid, 'SIGSTOP');

const child = spawn(command, args, { env: process.env, stdio: 'inherit', detached: false });
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    return;
  }
  process.exit(code ?? 1);
});
