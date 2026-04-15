#!/usr/bin/env node
import { listSessions } from '../lib/session-map.js';
import { resolveSessionForCwd } from '../lib/session.js';

async function main(argv) {
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
