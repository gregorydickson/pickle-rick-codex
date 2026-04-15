#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveSessionForCwd } from '../lib/session.js';
import { getTicketById } from '../lib/tickets.js';

const PROTECTED_PATTERNS = [
  /^\.codex\/hooks\/hooks\.json$/,
  /^\.codex-plugin\/plugin\.json$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^package\.json$/,
  /^install\.sh$/,
];

function approve() {
  console.log(JSON.stringify({ decision: 'approve' }));
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) {
    approve();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    approve();
    return;
  }

  const sessionDir = await resolveSessionForCwd(process.cwd(), { last: true });
  const ticketId = process.env.PICKLE_ACTIVE_TICKET || null;
  const ticket = sessionDir && ticketId ? getTicketById(sessionDir, ticketId) : null;
  const hasOverride = /config_change:\s*true/i.test(ticket?.content || '');
  if (hasOverride) {
    approve();
    return;
  }

  const filePath = payload.tool_input?.file_path || payload.file_path || '';
  const command = payload.tool_input?.command || payload.command || '';
  const candidates = [filePath, ...String(command).split(/\s+/)].filter(Boolean);
  const blocked = candidates.find((candidate) =>
    PROTECTED_PATTERNS.some((pattern) => pattern.test(path.normalize(candidate).replace(/^[./]+/, ''))),
  );

  if (!blocked) {
    approve();
    return;
  }

  console.log(JSON.stringify({
    decision: 'block',
    reason: `Protected file targeted without config_change override: ${blocked}`,
  }));
}

main().catch(() => approve());
