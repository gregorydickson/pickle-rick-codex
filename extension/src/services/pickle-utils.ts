import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParsedTicket } from '../types/index.js';

export { STATE_SCHEMA_VERSION } from '../types/index.js';

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getDataRoot(): string {
  return process.env.PICKLE_DATA_ROOT || path.join(os.homedir(), '.codex', 'pickle-rick');
}

export function getSessionsRoot(): string {
  return path.join(getDataRoot(), 'sessions');
}

export function getActivityRoot(): string {
  return path.join(getDataRoot(), 'activity');
}

export function getConfigPath(): string {
  return path.join(getDataRoot(), 'config.json');
}

export function getSessionMapPath(): string {
  return path.join(getDataRoot(), 'current_sessions.json');
}

export function ensureDir(dirPath: string, mode: number = 0o700): string {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  return dirPath;
}

interface AtomicWriteOptions {
  mode?: number;
}

export function atomicWriteFile(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
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

export function atomicWriteJson<T>(filePath: string, value: T, options: AtomicWriteOptions = {}): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function readJsonFile<T = unknown>(filePath: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function backupFile(filePath: string, suffix: string = 'bak'): string {
  const backupPath = `${filePath}.${suffix}.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainder}s`;
  }
  return `${minutes}m ${remainder}s`;
}

export function statusSymbol(status: string | null | undefined): string {
  const normalized = String(status ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (normalized === 'done') return '[x]';
  if (normalized === 'in progress') return '[~]';
  if (normalized === 'skipped') return '[!]';
  return '[ ]';
}

export function slugify(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface ExtractedFrontmatter {
  body: string;
  start: number;
  end: number;
}

export function extractFrontmatter(content: string): ExtractedFrontmatter | null {
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

export function parseFrontmatter(content: string): Record<string, string> | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;

  const parsed: Record<string, string> = {};
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

export function updateFrontmatter(content: string, updates: Record<string, unknown>): string {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return content;

  const lines = frontmatter.body.split(/\r?\n/);
  const seen = new Set<string>();
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

export function readTextFile(filePath: string, fallback: string | null = null): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function listTicketFiles(sessionDir: string): string[] {
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

export function parseTicketFile(filePath: string): ParsedTicket | null {
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

export function nowIso(): string {
  return new Date().toISOString();
}
