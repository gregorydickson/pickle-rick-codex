import path from 'node:path';
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  listTicketFiles,
  parseTicketFile,
  readJsonFile,
  readTextFile,
  slugify,
} from './pickle-utils.js';

export function getManifestPath(sessionDir) {
  return path.join(sessionDir, 'refinement_manifest.json');
}

export function normalizeTicketStatus(status) {
  return String(status ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}

export function isRunnableTicketStatus(status) {
  const normalized = normalizeTicketStatus(status);
  return normalized === '' || normalized === 'todo' || normalized === 'in progress';
}

export function summarizeTickets(sessionDir) {
  const fileTickets = listTickets(sessionDir);
  const sourceTickets = fileTickets.length > 0 ? fileTickets : readManifest(sessionDir).tickets;
  const summary = {
    queued: 0,
    done: 0,
    blocked: 0,
    skipped: 0,
    total: sourceTickets.length,
    runnable: [],
    tickets: sourceTickets,
  };

  for (const ticket of sourceTickets) {
    const normalized = normalizeTicketStatus(ticket.status);
    if (normalized === 'done') {
      summary.done += 1;
    } else if (normalized === 'blocked') {
      summary.blocked += 1;
    } else if (normalized === 'skipped') {
      summary.skipped += 1;
    } else {
      summary.queued += 1;
      summary.runnable.push(ticket);
    }
  }

  return summary;
}

export function readManifest(sessionDir) {
  const manifest = readJsonFile(getManifestPath(sessionDir), { tickets: [] }) || { tickets: [] };
  manifest.tickets ??= [];
  return manifest;
}

export function writeManifest(sessionDir, manifest) {
  atomicWriteJson(getManifestPath(sessionDir), manifest);
  return getManifestPath(sessionDir);
}

function ticketFrontmatter(ticket, order) {
  const verification = Array.isArray(ticket.verification)
    ? ticket.verification.join(' && ')
    : ticket.verification || 'npm test';
  return [
    '---',
    `id: ${JSON.stringify(ticket.id)}`,
    `title: ${JSON.stringify(ticket.title)}`,
    `status: ${JSON.stringify(ticket.status || 'Todo')}`,
    `order: ${order}`,
    `priority: ${JSON.stringify(ticket.priority || 'P1')}`,
    `complexity_tier: ${JSON.stringify(ticket.complexity_tier || 'medium')}`,
    `verify: ${JSON.stringify(verification)}`,
    '---',
    '',
  ].join('\n');
}

export function writeTicketFiles(sessionDir, manifest) {
  const ticketPaths = [];
  manifest.tickets.forEach((ticket, index) => {
    const ticketId = slugify(ticket.id || ticket.title || `ticket-${index + 1}`) || `ticket-${index + 1}`;
    ticket.id = ticketId;
    const ticketDir = path.join(sessionDir, ticketId);
    ensureDir(ticketDir);
    const content = [
      ticketFrontmatter(ticket, index + 1),
      `# ${ticket.title || ticketId}`,
      '',
      '## Description',
      ticket.description || 'No description provided.',
      '',
      '## Acceptance Criteria',
      ...(ticket.acceptance_criteria || []).map((criterion) => `- ${criterion}`),
      '',
      '## Verification',
      ...(ticket.verification || ['npm test']).map((check) => `- \`${check}\``),
      '',
    ].join('\n');
    const filePath = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
    atomicWriteFile(filePath, content);
    ticketPaths.push(filePath);
  });
  return ticketPaths;
}

export function listTickets(sessionDir) {
  return listTicketFiles(sessionDir)
    .map((filePath) => parseTicketFile(filePath))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);
}

export function getTicketById(sessionDir, ticketId) {
  return listTickets(sessionDir).find((ticket) => ticket.id === ticketId) || null;
}

function parseMarkdownTable(sectionContent) {
  const rows = sectionContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (rows.length < 3) return [];
  const headers = rows[0].split('|').map((cell) => cell.trim()).filter(Boolean);
  return rows.slice(2).map((row) => {
    const values = row.split('|').map((cell) => cell.trim()).filter(Boolean);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || '';
    });
    return record;
  });
}

function extractSection(markdown, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = pattern.exec(markdown);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/^##\s+/m);
  return next === -1 ? markdown.slice(start).trim() : markdown.slice(start, start + next).trim();
}

export function fallbackRefinePrd(prdText) {
  const table = parseMarkdownTable(extractSection(prdText, 'Task Breakdown'));
  const tickets = table.map((row) => ({
    id: slugify(row.ID || row.Title || row.ID?.toLowerCase()),
    title: row.Title || row.ID || 'Implementation task',
    description: `Phase ${row.Phase || 'unknown'} task from the PRD.`,
    acceptance_criteria: [
      `Complete ${row.Title || row.ID || 'the task'} in the guaranteed Codex v1 path.`,
      `Satisfy dependencies: ${row['Depends On'] || 'none'}.`,
    ],
    verification: ['npm test'],
    priority: row.Priority || 'P1',
    status: 'Todo',
    depends_on: row['Depends On'] || 'none',
    phase: row.Phase || '',
  }));

  if (tickets.length > 0) {
    return {
      generated_at: new Date().toISOString(),
      source: 'fallback-prd-parser',
      tickets,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    source: 'fallback-prd-parser',
    tickets: [
      {
        id: 'ticket-001',
        title: 'Implement PRD',
        description: 'Fallback ticket generated because no Task Breakdown table was found.',
        acceptance_criteria: ['Implement the requested work.', 'Run npm test.'],
        verification: ['npm test'],
        priority: 'P1',
        status: 'Todo',
      },
    ],
  };
}

export function updateTicketStatus(sessionDir, ticketId, updates) {
  const ticket = getTicketById(sessionDir, ticketId);
  if (!ticket) return null;
  const nextContent = ticket.content.replace(
    /status:\s*.+/m,
    `status: ${JSON.stringify(updates.status || ticket.status)}`,
  );
  const rewritten = Object.entries(updates).reduce((content, [key, value]) => {
    if (key === 'status') return content;
    const pattern = new RegExp(`^${key}:\\s*.+$`, 'm');
    if (pattern.test(content)) {
      return content.replace(pattern, `${key}: ${JSON.stringify(value)}`);
    }
    return content.replace(/^---\n/, `---\n${key}: ${JSON.stringify(value)}\n`);
  }, nextContent);
  atomicWriteFile(ticket.filePath, rewritten);
  const manifest = readManifest(sessionDir);
  const manifestTicket = manifest.tickets.find((entry) => entry.id === ticketId);
  if (manifestTicket) {
    Object.assign(manifestTicket, updates);
    if (updates.status) {
      manifestTicket.status = updates.status;
    }
    writeManifest(sessionDir, manifest);
  }
  return parseTicketFile(ticket.filePath);
}

export function readPrd(sessionDir) {
  return readTextFile(path.join(sessionDir, 'prd.md'), '');
}
