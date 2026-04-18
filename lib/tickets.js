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
import { resolveTicketVerificationContract } from './verification-env.js';

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
    let nextTicket = { ...ticket };
    const aliasDependencies = nextTicket.depends_on ?? nextTicket.dependsOn ?? nextTicket.dependencies;
    if (aliasDependencies !== undefined && nextTicket.depends_on === undefined) {
      nextTicket.depends_on = aliasDependencies;
      changed = true;
    }
    if ('dependsOn' in nextTicket) {
      delete nextTicket.dependsOn;
      changed = true;
    }
    if ('dependencies' in nextTicket) {
      delete nextTicket.dependencies;
      changed = true;
    }
    const nextId = canonicalTicketId(ticket, index);
    const normalizedCurrent = normalizeTicketId(ticket.id, nextId);
    if (normalizedCurrent !== nextId) {
      idRewrites.set(String(ticket.id), nextId);
    }

    nextTicket = {
      ...nextTicket,
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

export function ticketDependencyIds(ticket) {
  const dependencyField = ticket?.depends_on ?? ticket?.dependsOn ?? ticket?.dependencies;
  if (Array.isArray(dependencyField)) {
    return dependencyField
      .map((value) => normalizeTicketId(value, ''))
      .filter(Boolean);
  }
  if (typeof dependencyField === 'string' && dependencyField && dependencyField !== 'none') {
    const dependencyId = normalizeTicketId(dependencyField, '');
    return dependencyId ? [dependencyId] : [];
  }
  return [];
}

export function unresolvedTicketDependencies(ticket, tickets) {
  const byId = new Map((tickets || []).map((entry) => [normalizeTicketId(entry.id, entry.id), entry]));
  return ticketDependencyIds(ticket).filter((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || normalizeTicketStatus(dependency.status) !== 'done';
  });
}

export function areTicketDependenciesSatisfied(ticket, tickets) {
  return unresolvedTicketDependencies(ticket, tickets).length === 0;
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
      if (areTicketDependenciesSatisfied(ticket, sourceTickets)) {
        summary.runnable.push(ticket);
      }
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

function ticketVerificationCommands(ticket) {
  if (Array.isArray(ticket.verification) && ticket.verification.length > 0) {
    return ticket.verification.map((command) => String(command));
  }
  if (typeof ticket.verification === 'string' && ticket.verification.trim()) {
    return ticket.verification.split('&&').map((command) => command.trim()).filter(Boolean);
  }
  if (typeof ticket.verify === 'string' && ticket.verify.trim()) {
    return ticket.verify.split('&&').map((command) => command.trim()).filter(Boolean);
  }
  return ['npm test'];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeRepoRelativePath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('$')) return '';
  const normalized = path.posix.normalize(trimmed.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../')) return '';
  return normalized;
}

function normalizePathList(value) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  const entries = [];
  for (const item of source) {
    const parsed = parseMaybeJson(item);
    if (typeof parsed === 'string') {
      const normalized = normalizeRepoRelativePath(parsed);
      if (normalized) entries.push(normalized);
      continue;
    }
    if (isPlainObject(parsed)) {
      const normalized = normalizeRepoRelativePath(
        firstNonEmptyString(parsed.path, parsed.file, parsed.artifact, parsed.artifact_path, parsed.artifactPath),
      );
      if (normalized) entries.push(normalized);
    }
  }
  return [...new Set(entries)];
}

function inferSiblingNameFromEnv(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value
    .trim()
    .replace(/_ROOT$/i, '')
    .replace(/_REPO$/i, '')
    .toLowerCase();
}

function inferSiblingRootEnv(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const upper = value.trim().toUpperCase();
  if (upper.endsWith('_ROOT')) return upper;
  if (upper) return `${upper}_ROOT`;
  return '';
}

function normalizeFreezeShaSource(value, rootEnv = '') {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed.trim();
  }
  if (isPlainObject(parsed)) {
    const fromEnv = firstNonEmptyString(parsed.from_env, parsed.fromEnv);
    if (fromEnv) return `env:${fromEnv}`;
    const command = firstNonEmptyString(parsed.command, parsed.cmd);
    if (command) return command;
    const gitRef = firstNonEmptyString(parsed.git_ref, parsed.gitRef, parsed.ref);
    if (gitRef) return `git:${gitRef}`;
  }
  return rootEnv ? `git:${rootEnv}:HEAD` : '';
}

function normalizeFreezeContract(value) {
  const parsed = parseMaybeJson(value);
  if (!isPlainObject(parsed)) return null;

  const artifactPath = normalizeRepoRelativePath(
    firstNonEmptyString(
      parsed.artifact_path,
      parsed.artifactPath,
      parsed.artifact,
      parsed.output_artifact,
      parsed.outputArtifact,
      parsed.path,
    ),
  );
  const rootEnv = inferSiblingRootEnv(
    firstNonEmptyString(
      parsed.root_env,
      parsed.rootEnv,
      parsed.sibling_root_env,
      parsed.siblingRootEnv,
      parsed.env,
    ),
  );
  const sibling = firstNonEmptyString(
    parsed.sibling,
    parsed.repo,
    parsed.repository,
    inferSiblingNameFromEnv(rootEnv),
  );
  const shaSource = normalizeFreezeShaSource(
    parsed.sha_source ?? parsed.shaSource ?? parsed.authority ?? parsed.source_of_truth ?? parsed.sourceOfTruth,
    rootEnv,
  );

  if (!artifactPath && !rootEnv && !shaSource && !sibling) {
    return null;
  }

  return {
    artifact_path: artifactPath,
    sibling,
    root_env: rootEnv,
    sha_source: shaSource,
  };
}

function freezeContractSignature(contract) {
  if (!contract) return '';
  return JSON.stringify({
    artifact_path: contract.artifact_path || '',
    sibling: contract.sibling || '',
    root_env: contract.root_env || '',
    sha_source: contract.sha_source || '',
  });
}

function normalizeTicketContracts(ticket) {
  let changed = false;
  const nextTicket = { ...ticket };

  const outputArtifacts = normalizePathList(
    ticket.output_artifacts ?? ticket.outputArtifacts ?? ticket.output_files ?? ticket.outputFiles ?? ticket.artifacts,
  );
  if (outputArtifacts.length > 0) {
    if (JSON.stringify(ticket.output_artifacts || []) !== JSON.stringify(outputArtifacts)) {
      changed = true;
    }
    nextTicket.output_artifacts = outputArtifacts;
  }
  for (const alias of ['outputArtifacts', 'output_files', 'outputFiles', 'artifacts']) {
    if (alias in nextTicket) {
      delete nextTicket[alias];
      changed = true;
    }
  }

  const proofCorpus = normalizePathList(
    ticket.proof_corpus ?? ticket.proofCorpus ?? ticket.proof_artifacts ?? ticket.proofArtifacts ?? ticket.corpus,
  );
  if (proofCorpus.length > 0) {
    if (JSON.stringify(ticket.proof_corpus || []) !== JSON.stringify(proofCorpus)) {
      changed = true;
    }
    nextTicket.proof_corpus = proofCorpus;
  }
  for (const alias of ['proofCorpus', 'proof_artifacts', 'proofArtifacts', 'corpus']) {
    if (alias in nextTicket) {
      delete nextTicket[alias];
      changed = true;
    }
  }

  const freezeContract = normalizeFreezeContract(
    ticket.freeze_contract ?? ticket.freezeContract ?? ticket.freeze_artifact ?? ticket.freezeArtifact,
  );
  if (freezeContract) {
    if (JSON.stringify(ticket.freeze_contract || null) !== JSON.stringify(freezeContract)) {
      changed = true;
    }
    nextTicket.freeze_contract = freezeContract;
  }
  for (const alias of ['freezeContract', 'freeze_artifact', 'freezeArtifact']) {
    if (alias in nextTicket) {
      delete nextTicket[alias];
      changed = true;
    }
  }

  return { ticket: nextTicket, changed };
}

function isFallbackManifestSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  return normalized === 'fallback-prd-parser' || normalized.endsWith('task-breakdown-parser');
}

function isPlaceholderAcceptanceCriterion(ticket, criterion) {
  const trimmed = String(criterion || '').trim();
  if (!trimmed) return true;
  if (/^the ticket exists\.?$/i.test(trimmed)) return true;
  if (/^implement the requested work\.?$/i.test(trimmed)) return true;
  if (/^run npm test\.?$/i.test(trimmed)) return true;
  if (/^satisfy dependenc(?:y|ies)\b/i.test(trimmed)) return true;
  if (/^complete .+ in the guaranteed codex v1 path\.?$/i.test(trimmed)) return true;
  const title = String(ticket?.title || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (title && new RegExp(`^complete ${title}\\.?\$`, 'i').test(trimmed)) return true;
  return false;
}

function hasOnlyGenericVerification(ticket) {
  const commands = ticketVerificationCommands(ticket).map((command) => command.trim().toLowerCase());
  if (commands.length === 0) return true;
  return commands.every((command) => command === 'npm test' || command === 'bun test');
}

export function enrichRefinementManifest(manifest, config = null) {
  const normalized = normalizeManifestTicketIds(manifest);
  let changed = normalized.changed;
  normalized.manifest.tickets = (normalized.manifest.tickets || []).map((ticket) => {
    let nextTicket = ticket;
    const normalizedTicket = normalizeTicketContracts(ticket);
    if (normalizedTicket.changed) {
      changed = true;
      nextTicket = normalizedTicket.ticket;
    }

    const contract = resolveTicketVerificationContract({ ticket: nextTicket, config });
    if (!contract) {
      return nextTicket;
    }
    if (JSON.stringify(nextTicket.verification_env || null) === JSON.stringify(contract)) {
      return nextTicket;
    }
    changed = true;
    return {
      ...nextTicket,
      verification_env: contract,
    };
  });
  return { manifest: normalized.manifest, changed };
}

function ticketText(ticket) {
  return [
    ticket?.title,
    ticket?.description,
    ...(Array.isArray(ticket?.acceptance_criteria) ? ticket.acceptance_criteria : []),
    ...ticketVerificationCommands(ticket),
  ].join('\n');
}

function ticketNarrativeText(ticket) {
  return [
    ticket?.title,
    ticket?.description,
    ...(Array.isArray(ticket?.acceptance_criteria) ? ticket.acceptance_criteria : []),
  ].join('\n');
}

function hasDeclaredVerificationContracts(ticket) {
  const verificationEnv = ticket?.verification_env;
  return (
    (Array.isArray(ticket?.output_artifacts) && ticket.output_artifacts.length > 0) ||
    (Array.isArray(ticket?.proof_corpus) && ticket.proof_corpus.length > 0) ||
    Boolean(ticket?.freeze_contract) ||
    Boolean(
      verificationEnv && (
        (Array.isArray(verificationEnv.required) && verificationEnv.required.length > 0) ||
        (isPlainObject(verificationEnv.vars) && Object.keys(verificationEnv.vars).length > 0)
      ),
    )
  );
}

const WRAPPER_CONTRACT_RULES = [
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?check:env\b/i,
    requireAnyContract: true,
  },
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?fixtures:sync\b/i,
    requireAnyContract: true,
    requireArtifacts: true,
    requireProofCorpus: true,
  },
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?validate:attractor\b/i,
    requireAnyContract: true,
    requireArtifacts: true,
    requireProofCorpus: true,
  },
];

function isOpaqueVerificationWrapper(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'npm test' || normalized === 'bun test') return false;
  return /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[a-z0-9:_-]+(?:\s|$)/i.test(normalized) || /^make\s+\S+/.test(normalized);
}

function looksLikeFormatterTicket(ticket) {
  if (ticket?.formatter === true || ticket?.formatter_ticket === true || ticket?.formatterTicket === true) {
    return true;
  }
  if (/\bformatter|formatting\b/i.test(String(ticket?.title || ''))) {
    return true;
  }
  return /\b(formatter ownership|own formatter|formatting ownership|formatter sweep|prettier sweep)\b/i.test(String(ticket?.description || ''));
}

function performsFormatterWork(ticket) {
  return ticketVerificationCommands(ticket).some((command) => /\b(prettier|biome|cargo fmt|gofmt|shfmt|stylua|npm run format|bun run format|pnpm format|yarn format|eslint\b.*--fix)\b/i.test(command));
}

function looksLikeParityTicket(ticket) {
  return /\b(parity|mirror(?:ed|ing)?|proof corpus|fixtures:sync|validate:attractor)\b/i.test(ticketText(ticket));
}

function isFreezeProducerTicket(ticket) {
  if (!ticket?.freeze_contract?.artifact_path) return false;
  if (/\bfreeze\b/i.test(String(ticket?.title || ''))) {
    return true;
  }
  return /\b(record|capture|snapshot)\b/i.test(ticketNarrativeText(ticket));
}

function extractRepoRelativePaths(command) {
  const paths = new Set();
  const pattern = /(^|[\s"'`(])((?:\.[/])?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s"'`):])/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const normalized = normalizeRepoRelativePath(match[2]);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

function isGeneratedArtifactPath(filePath) {
  return /(^|\/)(?:research|artifacts?|reports?|proof|generated|tmp)\//.test(filePath) || /freeze/i.test(filePath);
}

function wrapperRulesForTicket(ticket) {
  return ticketVerificationCommands(ticket)
    .flatMap((command) => WRAPPER_CONTRACT_RULES.filter((rule) => rule.pattern.test(command)));
}

export function validateRefinementManifest(manifest) {
  const issues = [];
  const tickets = Array.isArray(manifest?.tickets) ? manifest.tickets.map((ticket) => normalizeTicketContracts(ticket).ticket) : [];

  if (tickets.length === 0) {
    issues.push('manifest contains zero tickets');
    return issues;
  }

  if (isFallbackManifestSource(manifest?.source)) {
    issues.push(`manifest source "${manifest.source}" is a fallback parser output and is not safe to execute`);
  }

  const ownedArtifacts = new Map();
  const authoritativeFreezeByArtifact = new Map();
  const formatterOwners = new Set();
  for (const ticket of tickets) {
    for (const artifactPath of ticket.output_artifacts || []) {
      const owners = ownedArtifacts.get(artifactPath) || [];
      owners.push(ticket.id || ticket.title || 'ticket');
      ownedArtifacts.set(artifactPath, owners);
    }

    if (looksLikeFormatterTicket(ticket)) {
      formatterOwners.add(ticket.id || ticket.title || 'ticket');
    }

    if (!isFreezeProducerTicket(ticket)) continue;
    const artifactPath = ticket.freeze_contract.artifact_path;
    const signature = freezeContractSignature(ticket.freeze_contract);
    const current = authoritativeFreezeByArtifact.get(artifactPath);
    if (!current) {
      authoritativeFreezeByArtifact.set(artifactPath, {
        owner: ticket.id || ticket.title || 'ticket',
        contract: ticket.freeze_contract,
        signature,
      });
      continue;
    }
    if (current.signature !== signature) {
      issues.push(
        `${ticket.id || ticket.title || 'ticket'}: freeze artifact "${artifactPath}" has conflicting sibling SHA authorities (${current.owner} vs ${ticket.id || ticket.title || 'ticket'})`,
      );
    }
  }

  tickets.forEach((ticket, index) => {
    const label = ticket?.id || `ticket-${index + 1}`;
    const acceptance = Array.isArray(ticket?.acceptance_criteria) ? ticket.acceptance_criteria : [];
    if (acceptance.length === 0) {
      issues.push(`${label}: missing acceptance criteria`);
    }
    if (acceptance.length > 0 && acceptance.every((criterion) => isPlaceholderAcceptanceCriterion(ticket, criterion))) {
      issues.push(`${label}: acceptance criteria are placeholder text, not executable contract`);
    }
    if (hasOnlyGenericVerification(ticket) && acceptance.every((criterion) => isPlaceholderAcceptanceCriterion(ticket, criterion))) {
      issues.push(`${label}: verification is generic test-only fallback with no ticket-specific proof`);
    }
    if (looksLikeFormatterTicket(ticket) && !performsFormatterWork(ticket)) {
      issues.push(`${label}: formatter ownership requires explicit formatter work in verification`);
    }
    if (
      !looksLikeFormatterTicket(ticket) &&
      performsFormatterWork(ticket) &&
      formatterOwners.size > 0 &&
      !ticketDependencyIds(ticket).some((dependencyId) => formatterOwners.has(dependencyId))
    ) {
      issues.push(`${label}: formatter-sensitive verification runs before formatter ownership is declared`);
    }
    if (ticketVerificationCommands(ticket).some(isOpaqueVerificationWrapper) && !hasDeclaredVerificationContracts(ticket)) {
      issues.push(`${label}: opaque verification wrapper commands require explicit verification_env, output_artifacts, proof_corpus, or freeze_contract`);
    }
    for (const rule of wrapperRulesForTicket(ticket)) {
      if (rule.requireArtifacts && (!Array.isArray(ticket.output_artifacts) || ticket.output_artifacts.length === 0)) {
        issues.push(`${label}: wrapper verification requires explicit output_artifacts`);
      }
      if (rule.requireProofCorpus && (!Array.isArray(ticket.proof_corpus) || ticket.proof_corpus.length === 0)) {
        issues.push(`${label}: wrapper verification requires mirrored proof_corpus coverage`);
      }
      if (rule.requireAnyContract && !hasDeclaredVerificationContracts(ticket)) {
        issues.push(`${label}: wrapper verification requires explicit contracts instead of opaque shell assumptions`);
      }
    }
    if (looksLikeParityTicket(ticket) && (!Array.isArray(ticket.proof_corpus) || ticket.proof_corpus.length === 0)) {
      issues.push(`${label}: parity or mirrored tickets must declare proof_corpus coverage`);
    }
    if (isFreezeProducerTicket(ticket) && !ownedArtifacts.has(ticket.freeze_contract.artifact_path)) {
      issues.push(`${label}: freeze producer must declare output_artifacts ownership for "${ticket.freeze_contract.artifact_path}"`);
    }

    const referencedPaths = ticketVerificationCommands(ticket).flatMap((command) => extractRepoRelativePaths(command));
    for (const artifactPath of referencedPaths.filter(isGeneratedArtifactPath)) {
      if (!ownedArtifacts.has(artifactPath)) {
        issues.push(`${label}: verification references artifact "${artifactPath}" but no ticket owns it`);
      }
      if (/freeze/i.test(artifactPath) && !authoritativeFreezeByArtifact.has(artifactPath)) {
        issues.push(`${label}: verification references freeze artifact "${artifactPath}" but no authoritative producer exists`);
      }
      if (ticket.freeze_contract?.artifact_path === artifactPath) {
        const authority = authoritativeFreezeByArtifact.get(artifactPath);
        if (authority && authority.signature !== freezeContractSignature(ticket.freeze_contract)) {
          issues.push(`${label}: freeze_contract disagrees with authoritative producer for "${artifactPath}"`);
        }
      }
    }

    if (ticket.freeze_contract?.artifact_path) {
      const artifactPath = ticket.freeze_contract.artifact_path;
      const authority = authoritativeFreezeByArtifact.get(artifactPath);
      if (!authority) {
        issues.push(`${label}: freeze_contract for "${artifactPath}" has no authoritative producer`);
      } else if (authority.signature !== freezeContractSignature(ticket.freeze_contract)) {
        issues.push(`${label}: freeze_contract disagrees with authoritative producer for "${artifactPath}"`);
      }
    }
  });

  return issues;
}

function collectTicketFrontmatter(ticket, order) {
  const verification = ticketVerificationCommands(ticket);
  const entries = new Map([
    ['id', ticket.id],
    ['title', ticket.title],
    ['status', ticket.status || 'Todo'],
    ['order', order],
    ['priority', ticket.priority || 'P1'],
    ['complexity_tier', ticket.complexity_tier || 'medium'],
    ['verify', verification.join(' && ')],
  ]);
  const excludedKeys = new Set([
    'acceptance_criteria',
    'content',
    'description',
    'filePath',
    'frontmatter',
    'id',
    'title',
    'status',
    'order',
    'priority',
    'complexity_tier',
    'verification',
    'verify',
  ]);

  for (const source of [ticket.frontmatter, ticket]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (excludedKeys.has(key)) continue;
      if (value === undefined || value === null || value === '') continue;
      entries.set(key, value);
    }
  }

  return entries;
}

function ticketFrontmatter(ticket, order) {
  const entries = collectTicketFrontmatter(ticket, order);
  return [
    '---',
    ...[...entries.entries()].map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
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
    const verification = ticketVerificationCommands(ticket);
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
      ...verification.map((check) => `- \`${check}\``),
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

export function getNextRunnableTicket(sessionDir) {
  const manifest = readManifest(sessionDir);
  ensureTicketFilesMaterialized(sessionDir, manifest);
  const currentTickets = listTickets(sessionDir);
  const manifestById = new Map(
    (manifest.tickets || []).map((ticket) => [normalizeTicketId(ticket.id, ticket.id), ticket]),
  );

  for (const ticket of currentTickets) {
    if (!isRunnableTicketStatus(ticket.status)) continue;
    if (!areTicketDependenciesSatisfied(ticket, currentTickets)) continue;
    return manifestById.get(normalizeTicketId(ticket.id, ticket.id)) || ticket;
  }

  return null;
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
  const pattern = heading instanceof RegExp
    ? new RegExp(heading.source, heading.flags.includes('m') ? heading.flags : `${heading.flags}m`)
    : new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = pattern.exec(markdown);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/^##\s+/m);
  return next === -1 ? markdown.slice(start).trim() : markdown.slice(start, start + next).trim();
}

export function fallbackRefinePrd(prdText) {
  const table = parseMarkdownTable(extractSection(prdText, /^##\s+(?:\d+\.\s+)?Task Breakdown\s*$/m));
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
