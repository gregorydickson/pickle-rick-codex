import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_SCHEMA_VERSION = 1;

export function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function getDataRoot() {
  return process.env.PICKLE_DATA_ROOT || path.join(os.homedir(), '.codex', 'pickle-rick');
}

export function getSessionsRoot() {
  return path.join(getDataRoot(), 'sessions');
}

export function getActivityRoot() {
  return path.join(getDataRoot(), 'activity');
}

export function getConfigPath() {
  return path.join(getDataRoot(), 'config.json');
}

export function getSessionMapPath() {
  return path.join(getDataRoot(), 'current_sessions.json');
}

export function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  return dirPath;
}

export function atomicWriteFile(filePath, content, options = {}) {
  const directory = path.dirname(filePath);
  const mode = options.mode ?? 0o600;
  ensureDir(directory);
  const tempPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, content, { mode });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
    throw error;
  }
}

export function atomicWriteJson(filePath, value, options = {}) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function backupFile(filePath, suffix = 'bak') {
  const backupPath = `${filePath}.${suffix}.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainder}s`;
  }
  return `${minutes}m ${remainder}s`;
}

export function statusSymbol(status) {
  const normalized = String(status ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (normalized === 'done') return '[x]';
  if (normalized === 'in progress') return '[~]';
  if (normalized === 'skipped') return '[!]';
  return '[ ]';
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function extractFrontmatter(content) {
  const openLength = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLength === 0) return null;
  const closeIndex = content.indexOf('\n---', openLength);
  if (closeIndex === -1) return null;
  const rawEnd = closeIndex + 4;
  const end =
    content[rawEnd] === '\n'
      ? rawEnd + 1
      : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n'
        ? rawEnd + 2
        : rawEnd;
  return { body: content.slice(openLength, closeIndex), start: 0, end };
}

export function parseFrontmatter(content) {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;

  const parsed = {};
  for (const rawLine of frontmatter.body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;
    parsed[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  return parsed;
}

export function updateFrontmatter(content, updates) {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return content;

  const lines = frontmatter.body.split(/\r?\n/);
  const seen = new Set();
  const rewritten = lines.map((line) => {
    const separator = line.indexOf(':');
    if (separator === -1) return line;
    const key = line.slice(0, separator).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}: ${JSON.stringify(updates[key])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      rewritten.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  return `---\n${rewritten.join('\n')}\n---\n${content.slice(frontmatter.end)}`;
}

export function readTextFile(filePath, fallback = null) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function listTicketFiles(sessionDir) {
  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const ticketDir = path.join(sessionDir, entry.name);
        try {
          return fs.readdirSync(ticketDir)
            .filter((fileName) => /^linear_ticket_.*\.md$/.test(fileName))
            .map((fileName) => path.join(ticketDir, fileName));
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function parseTicketFile(filePath) {
  const content = readTextFile(filePath);
  if (!content) return null;
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return null;
  return {
    id: frontmatter.id || path.basename(path.dirname(filePath)),
    title: frontmatter.title || path.basename(filePath, '.md'),
    status: frontmatter.status || 'Todo',
    order: Number(frontmatter.order || 0),
    complexity_tier: frontmatter.complexity_tier || 'medium',
    verify: frontmatter.verify || '',
    filePath,
    content,
    frontmatter,
  };
}

export function nowIso() {
  return new Date().toISOString();
}
