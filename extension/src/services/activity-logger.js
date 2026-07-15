import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  getActivityRoot,
  nowIso,
} from './pickle-utils.js';

function activityFilePath(date = new Date()) {
  const datePart = date.toISOString().slice(0, 10);
  return path.join(getActivityRoot(), `${datePart}.jsonl`);
}

export function logActivity(event, options = {}) {
  if (options.enabled === false) return;
  try {
    ensureDir(getActivityRoot());
    const line = JSON.stringify({ ts: nowIso(), ...event }) + '\n';
    fs.appendFileSync(activityFilePath(), line, { mode: 0o600 });
  } catch {
    // Logging must never break the caller.
  }
}

export function readActivityLogs({ since, until } = {}) {
  try {
    const files = fs.readdirSync(getActivityRoot()).filter((fileName) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName));
    const lower = since ? since.getTime() : Number.NEGATIVE_INFINITY;
    const upper = until ? until.getTime() : Number.POSITIVE_INFINITY;
    const events = [];

    for (const fileName of files) {
      const day = new Date(fileName.replace('.jsonl', '') + 'T00:00:00Z');
      const dayTime = day.getTime();
      if (dayTime < lower - 86_400_000 || dayTime > upper) continue;

      const filePath = path.join(getActivityRoot(), fileName);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const timestamp = new Date(parsed.ts || '').getTime();
          if (timestamp >= lower && timestamp <= upper) {
            events.push(parsed);
          }
        } catch {
          // Skip malformed lines.
        }
      }
    }

    return events.sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  } catch {
    return [];
  }
}

export function pruneActivity(maxAgeDays = 365) {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const fileName of fs.readdirSync(getActivityRoot())) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName)) continue;
      const day = new Date(fileName.replace('.jsonl', '') + 'T00:00:00Z').getTime();
      if (day < cutoff) {
        fs.rmSync(path.join(getActivityRoot(), fileName), { force: true });
        removed += 1;
      }
    }
  } catch {
    return removed;
  }
  return removed;
}
