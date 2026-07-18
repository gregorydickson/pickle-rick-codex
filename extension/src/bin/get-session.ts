#!/usr/bin/env node
import { listSessions, removeSessionMapEntry } from '../services/session-map.js';
import { getSessionMapCwds, loadSessionState, reconcileAllSessionLiveness, resolveSessionForCwd } from '../services/session.js';

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log('Usage: node bin/get-session.js [--cwd DIR] [--last] [--list]');
    return;
  }

  let cwd = process.cwd();
  let last = false;
  let list = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--last') {
      last = true;
    } else if (arg === '--list') {
      list = true;
    }
  }

  if (list) {
    const stale = reconcileAllSessionLiveness();
    for (const session of stale) {
      for (const mappedCwd of getSessionMapCwds(session.state)) {
        await removeSessionMapEntry(mappedCwd, session.sessionDir);
      }
    }
    for (const mapped of listSessions()) {
      try {
        const state = loadSessionState(mapped.sessionDir);
        if (state.active !== true && state.recovery_required !== true) {
          await removeSessionMapEntry(mapped.cwd, mapped.sessionDir);
        }
      } catch {
        await removeSessionMapEntry(mapped.cwd, mapped.sessionDir);
      }
    }
    console.log(JSON.stringify(listSessions(), null, 2));
    return;
  }

  const sessionDir = await resolveSessionForCwd(cwd, { last });
  if (!sessionDir) {
    process.exitCode = 1;
    return;
  }
  console.log(sessionDir);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
