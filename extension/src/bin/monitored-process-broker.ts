#!/usr/bin/env node
import { spawn } from 'node:child_process';

interface LaunchRequest {
  type: 'launch';
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

let launched = false;
const registrationDeadline = setTimeout(() => {
  if (!launched) fail('Monitored process broker registration timed out.');
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.exit(1);
  }
}, 30_000);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

process.once('disconnect', () => {
  // The controller owns the durable registration handshake. If it disappears
  // before releasing this broker, no model process has been started and there
  // is therefore nothing unrecorded that can outlive it.
  if (!launched) process.exit(125);
});

process.once('message', (raw: unknown) => {
  const request = raw as Partial<LaunchRequest> | null;
  if (!request || request.type !== 'launch'
    || typeof request.command !== 'string' || !request.command
    || !Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')
    || !request.env || typeof request.env !== 'object') {
    fail('Invalid monitored process broker launch request.');
  }

  // Receipt of this message is the release fence: the controller sends it
  // only after its synchronous onSpawn callback has durably published this
  // broker's immutable process-group identity.
  launched = true;
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: false,
    stdio: 'inherit',
  });
  child.once('spawn', () => {
    clearTimeout(registrationDeadline);
    process.send?.({ type: 'launched' });
  });
  child.once('error', (error) => fail(error.message));
  child.once('exit', (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 1);
  });
});
