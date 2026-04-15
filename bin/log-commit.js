#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from '../lib/activity-logger.js';
import { loadConfig } from '../lib/config.js';
import { getHeadSha } from '../lib/git-utils.js';
import { resolveSessionForCwd } from '../lib/session.js';

async function main() {
  const sessionDir = await resolveSessionForCwd(process.cwd(), { last: true });
  if (!sessionDir) return;

  const head = getHeadSha(process.cwd());
  if (!head) return;

  const markerPath = path.join(sessionDir, '.last-hook-head');
  const previous = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
  if (previous === head) return;

  fs.writeFileSync(markerPath, head);
  const config = loadConfig();
  logActivity({
    event: 'commit',
    source: 'hook',
    session: path.basename(sessionDir),
    commit_hash: head,
  }, { enabled: config.defaults.activity_logging });
}

main().catch(() => {
  process.exit(0);
});
