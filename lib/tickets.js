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

export function normalizeTicketId(value, fallback = 'ticket') {
  return slugify(value) || fallback;
}

function canonicalTicketId(ticket, index) {
  return normalizeTicketId(ticket.id || ticket.title || `ticket-${index + 1}`, `ticket-${index + 1}`);
}

export function normalizeManifestTicketIds(manifest) {
  let changed = false;
  manifest.tickets ??= [];
  const idRewrites = new Map();
  manifest.tickets = manifest.tickets.map((ticket, index) => {
    const nextId = canonicalTicketId(ticket, index);
    const normalizedCurrent = normalizeTicketId(ticket.id, nextId);
    if (normalizedCurrent !== nextId) {
      idRewrites.set(String(ticket.id), nextId);
    }

    const nextTicket = {
      ...ticket,
      id: nextId,
    };
    if (ticket.id !== nextId) changed = true;
    return nextTicket;
  }).map((ticket) => {
    let nextTicket = ticket;
    if (Array.isArray(ticket.depends_on)) {
      const nextDependsOn = ticket.depends_on.map((value) => idRewrites.get(String(value)) || normalizeTicketId(value, String(value)));
      if (JSON.stringify(nextDependsOn) !== JSON.stringify(ticket.depends_on)) {
        changed = true;
        nextTicket = { ...nextTicket, depends_on: nextDependsOn };
      }
    } else if (typeof ticket.depends_on === 'string' && ticket.depends_on && ticket.depends_on !== 'none') {
      const nextDependsOn = idRewrites.get(ticket.depends_on) || normalizeTicketId(ticket.depends_on, ticket.depends_on);
      if (nextDependsOn !== ticket.depends_on) {
        changed = true;
        nextTicket = { ...nextTicket, depends_on: nextDependsOn };
      }
    }
    return nextTicket;
  });
  return { manifest, changed };
}

export function normalizeTicketStatus(status) {
  return String(status ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}

export function isRunnableTicketStatus(status) {
  const normalized = normalizeTicketStatus(status);
  return normalized === '' || normalized === 'todo' || normalized === 'in progress';
}

export function summarizeTickets(sessionDir) {
  const manifest = readManifest(sessionDir);
  const fileTickets = ensureTicketFilesMaterialized(sessionDir, manifest);
  const sourceTickets = manifest.tickets.length > 0 ? fileTickets : fileTickets.length > 0 ? fileTickets : manifest.tickets;
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

function fileTicketsCoverManifest(fileTickets, manifestTickets) {
  if (manifestTickets.length === 0) return fileTickets.length === 0;
  if (fileTickets.length !== manifestTickets.length) return false;
  const fileIds = new Set(fileTickets.map((ticket) => normalizeTicketId(ticket.id, ticket.id)));
  if (fileIds.size !== manifestTickets.length) return false;
  return manifestTickets.every((ticket, index) => fileIds.has(canonicalTicketId(ticket, index)));
}

export function ensureTicketFilesMaterialized(sessionDir, manifest = readManifest(sessionDir)) {
  const fileTickets = listTickets(sessionDir);
  if (fileTicketsCoverManifest(fileTickets, manifest.tickets || [])) {
    return fileTickets;
  }
  if ((manifest.tickets || []).length === 0) {
    return fileTickets;
  }
  writeTicketFiles(sessionDir, manifest);
  return listTickets(sessionDir);
}

export function readManifest(sessionDir) {
  const manifest = readJsonFile(getManifestPath(sessionDir), { tickets: [] }) || { tickets: [] };
  const normalized = normalizeManifestTicketIds(manifest);
  if (normalized.changed) {
    atomicWriteJson(getManifestPath(sessionDir), normalized.manifest);
  }
  return normalized.manifest;
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
  const normalized = normalizeManifestTicketIds(manifest);
  if (normalized.changed || !readJsonFile(getManifestPath(sessionDir), null)) {
    writeManifest(sessionDir, normalized.manifest);
  }
  const ticketPaths = [];
  normalized.manifest.tickets.forEach((ticket, index) => {
    const ticketId = canonicalTicketId(ticket, index);
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
    .map((ticket) => ({
      ...ticket,
      id: normalizeTicketId(ticket.id, path.basename(path.dirname(ticket.filePath))),
    }))
    .sort((left, right) => left.order - right.order);
}

export function getTicketById(sessionDir, ticketId) {
  const normalizedId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  return listTickets(sessionDir).find((ticket) => normalizeTicketId(ticket.id, ticket.id) === normalizedId) || null;
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
  const manifest = readManifest(sessionDir);
  const normalizedId = normalizeTicketId(ticketId, String(ticketId || 'ticket'));
  ensureTicketFilesMaterialized(sessionDir, manifest);
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
  const manifestTicket = manifest.tickets.find((entry) => normalizeTicketId(entry.id, entry.id) === normalizedId);
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
