import fs from 'node:fs';
import path from 'node:path';
import { scrubForbiddenWorkerTokens } from './promise-tokens.js';

/**
 * Neutralize orchestrator-scoped completion tokens in raw worker output before
 * the orchestrator interprets it. A per-ticket worker's only legitimate
 * completion signal is `<promise>I AM DONE</promise>`; every forbidden token it
 * emits is rewritten to that value at the consumption boundary.
 */
export function scrubWorkerOutput(content: string): string {
  return scrubForbiddenWorkerTokens(content).scrubbed;
}

/**
 * Read a worker last-message artifact with forbidden tokens neutralized. Returns
 * an empty string when the file is absent, mirroring the raw-read helpers it
 * replaces.
 */
export function readScrubbedWorkerMessage(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }
  return scrubWorkerOutput(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Scrub a worker last-message file in place so no downstream orchestrator reader
 * can act on a forbidden token. Only rewrites when a forbidden token was found.
 * Returns the number of neutralized tokens.
 */
export function scrubWorkerMessageFile(filePath: string): number {
  if (!filePath || !fs.existsSync(filePath)) {
    return 0;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const { scrubbed, replacements } = scrubForbiddenWorkerTokens(raw);
  const count = Object.values(replacements).reduce((sum, value) => sum + value, 0);
  if (count > 0) {
    fs.writeFileSync(filePath, scrubbed);
  }
  return count;
}

/**
 * Scrub every worker last-message artifact for a ticket at the point the
 * orchestrator consumes the worker result. Best-effort: an unreadable session
 * directory yields zero neutralizations rather than throwing.
 */
export function scrubTicketWorkerMessages(sessionDir: string, ticketId: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return 0;
  }
  const prefix = `${ticketId}.`;
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.last-message.txt') || !name.startsWith(prefix)) {
      continue;
    }
    total += scrubWorkerMessageFile(path.join(sessionDir, name));
  }
  return total;
}
