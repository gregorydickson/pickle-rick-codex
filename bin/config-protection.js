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

function unwrapShellToken(candidate) {
  let value = String(candidate || '').trim();
  if (!value) return '';
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function tokenizeShellWords(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizedPathSuffixes(candidate) {
  const normalized = path.normalize(unwrapShellToken(candidate)).replace(/\\/g, '/');
  const trimmed = normalized.replace(/^[./]+/, '');
  const segments = trimmed.split('/').filter(Boolean);
  const suffixes = new Set([trimmed]);
  for (let index = 0; index < segments.length; index += 1) {
    suffixes.add(segments.slice(index).join('/'));
  }
  return [...suffixes].filter(Boolean);
}

function matchesProtectedPattern(candidate) {
  return normalizedPathSuffixes(candidate).some((value) =>
    PROTECTED_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

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
  const candidates = [filePath, ...tokenizeShellWords(String(command))].filter(Boolean);
  const blocked = candidates.find((candidate) => matchesProtectedPattern(candidate));

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
