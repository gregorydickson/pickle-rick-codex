import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  getActivityRoot,
  nowIso,
} from './pickle-utils.js';

export interface ActivityEvent {
  ts?: string;
  [key: string]: unknown;
}

export interface LogActivityOptions {
  enabled?: boolean;
  maxAttempts?: number;
}

export interface ReadActivityLogsOptions {
  since?: Date;
  until?: Date;
}

function activityFilePath(date: Date = new Date()): string {
  const datePart = date.toISOString().slice(0, 10);
  return path.join(getActivityRoot(), `${datePart}.jsonl`);
}

interface PendingActivity {
  filePath: string;
  line: string;
  event: ActivityEvent;
}

const MAX_PENDING_ACTIVITY = 1_024;
const pendingActivity: PendingActivity[] = [];
type ActivityWriter = (filePath: string, line: string) => void;
let activityWriter: ActivityWriter = (filePath, line) => {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line, { mode: 0o600 });
};

export interface FlushActivityResult {
  written: number;
  pending: number;
  error: Error | null;
}

export function flushPendingActivity(maxAttempts: number = 3): FlushActivityResult {
  const attempts = Math.max(1, Math.min(10, Math.trunc(maxAttempts) || 1));
  let written = 0;
  let lastError: Error | null = null;
  while (pendingActivity.length > 0) {
    const next = pendingActivity[0];
    let succeeded = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        activityWriter(next.filePath, next.line);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!succeeded) break;
    pendingActivity.shift();
    written += 1;
  }
  return { written, pending: pendingActivity.length, error: lastError };
}

export function pendingActivityCount(): number {
  return pendingActivity.length;
}

/** Test seam for deterministic write-failure coverage. */
export function setActivityWriterForTests(writer: ActivityWriter | null): void {
  activityWriter = writer || ((filePath, line) => {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, line, { mode: 0o600 });
  });
}

export function resetActivityLoggerForTests(): void {
  pendingActivity.length = 0;
  setActivityWriterForTests(null);
}

export function logActivity(event: ActivityEvent, options: LogActivityOptions = {}): boolean {
  if (options.enabled === false) return true;
  if (pendingActivity.length >= MAX_PENDING_ACTIVITY) {
    console.error(`[pickle-activity] pending buffer full (${MAX_PENDING_ACTIVITY}); event was not accepted`);
    return false;
  }
  const persistedEvent = { ts: nowIso(), ...event };
  let line: string;
  try {
    line = JSON.stringify(persistedEvent) + '\n';
  } catch (error) {
    console.error(`[pickle-activity] event serialization failed; event was not accepted: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  pendingActivity.push({
    filePath: activityFilePath(new Date(String(persistedEvent.ts))),
    line,
    event: persistedEvent,
  });
  const result = flushPendingActivity(options.maxAttempts ?? 3);
  if (result.pending > 0) {
    console.error(`[pickle-activity] write failed after bounded retry; ${result.pending} event(s) remain pending: ${result.error?.message || 'unknown error'}`);
    return false;
  }
  return true;
}

export function readActivityLogs({ since, until }: ReadActivityLogsOptions = {}): ActivityEvent[] {
  const lower = since ? since.getTime() : Number.NEGATIVE_INFINITY;
  const upper = until ? until.getTime() : Number.POSITIVE_INFINITY;
  const events: ActivityEvent[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(getActivityRoot()).filter((fileName) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName));
  } catch { /* pending in-memory events remain readable */ }

  for (const fileName of files) {
    try {
      const day = new Date(fileName.replace('.jsonl', '') + 'T00:00:00Z');
      const dayTime = day.getTime();
      if (dayTime < lower - 86_400_000 || dayTime > upper) continue;

      const filePath = path.join(getActivityRoot(), fileName);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as ActivityEvent;
          const timestamp = new Date(parsed.ts || '').getTime();
          if (timestamp >= lower && timestamp <= upper) {
            events.push(parsed);
          }
        } catch {
          // Skip malformed lines.
        }
      }
    } catch { /* skip unreadable activity files without hiding pending events */ }
  }

  for (const pending of pendingActivity) {
    const timestamp = new Date(pending.event.ts || '').getTime();
    if (timestamp >= lower && timestamp <= upper) events.push(pending.event);
  }

  return events.sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
}

export function pruneActivity(maxAgeDays: number = 365): number {
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
