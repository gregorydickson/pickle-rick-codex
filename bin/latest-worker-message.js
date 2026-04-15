#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function findLatestMessageFile(sessionDir) {
  const candidates = [];
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.last-message.txt')) continue;
    const filePath = path.join(sessionDir, entry.name);
    const stats = fs.statSync(filePath);
    candidates.push({ filePath, mtimeMs: stats.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
  return candidates[0]?.filePath || null;
}

function main(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    throw new Error('Usage: node bin/latest-worker-message.js <session-dir>');
  }

  if (!fs.existsSync(sessionDir)) {
    console.log('Session directory does not exist yet.');
    return;
  }

  const latest = findLatestMessageFile(sessionDir);
  if (!latest) {
    console.log('No worker last-message files yet.');
    return;
  }

  console.log(latest);
  console.log('');
  const lines = fs.readFileSync(latest, 'utf8').split('\n');
  console.log(lines.slice(-80).join('\n'));
}

main(process.argv.slice(2));
