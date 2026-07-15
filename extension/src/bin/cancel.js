#!/usr/bin/env node
import { deactivateSession, loadSessionState, resolveSessionForCwd } from '../services/session.js';

function signalProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function runtimePids(state) {
  return [...new Set([
    Number(state?.active_child_pid),
  ].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}

async function main(argv) {
  let cwd = process.cwd();
  let sessionDir;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--session-dir') {
      sessionDir = argv[index + 1];
      index += 1;
    }
  }

  const resolved = sessionDir || await resolveSessionForCwd(cwd, { last: true });
  if (!resolved) {
    console.log('No session to cancel.');
    return;
  }

  const stateBeforeCancel = loadSessionState(resolved);
  const pidsToSignal = runtimePids(stateBeforeCancel);

  await deactivateSession(resolved, 'cancelled');
  pidsToSignal.forEach((pid) => {
    signalProcess(pid);
  });
  console.log(`Cancelled ${resolved}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
