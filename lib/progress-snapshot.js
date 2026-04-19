import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getHeadSha, getWorkingTreeFingerprint } from './git-utils.js';

function canonicalProgressArtifacts(mode) {
  switch (mode) {
    case 'anatomy-park':
      return ['anatomy-park-summary.json', 'anatomy-park-summary.md'];
    case 'microverse':
      return ['microverse-summary.json', 'microverse-summary.md'];
    case 'szechuan-sauce':
      return ['szechuan-sauce-summary.json', 'szechuan-sauce-summary.md'];
    default:
      return [];
  }
}

function ticketPhaseArtifactPaths(sessionDir, currentTicket, step) {
  if (!sessionDir || !currentTicket || !step) {
    return [];
  }

  const paths = new Set();
  const exactPrefix = `${currentTicket}.${step}.`;
  const ticketDir = path.join(sessionDir, currentTicket);

  try {
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(exactPrefix)) {
        paths.add(entry.name);
      }
    }
  } catch {
    // Best-effort only.
  }

  const walkTicketDir = (currentDir, relativePrefix = currentTicket) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childPath = path.join(currentDir, entry.name);
      const relativePath = path.join(relativePrefix, entry.name);
      if (entry.isDirectory()) {
        walkTicketDir(childPath, relativePath);
      } else if (entry.isFile()) {
        paths.add(relativePath);
      }
    }
  };

  if (fs.existsSync(ticketDir)) {
    walkTicketDir(ticketDir);
  }

  return [...paths].sort();
}

function fileDigest(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function progressArtifactDigests(sessionDir, mode, { currentTicket = null, step = null } = {}) {
  const digests = {};
  const relativePaths = [
    ...canonicalProgressArtifacts(mode),
    ...ticketPhaseArtifactPaths(sessionDir, currentTicket, step),
  ];
  for (const relativePath of relativePaths) {
    digests[relativePath] = fileDigest(path.join(sessionDir, relativePath));
  }
  return digests;
}

export function captureProgressSnapshot({ sessionDir, workingDir, mode, step = null, currentTicket = null }) {
  return {
    head_sha: getHeadSha(workingDir),
    worktree_fingerprint: getWorkingTreeFingerprint(workingDir),
    step: step || null,
    current_ticket: currentTicket || null,
    progress_artifacts: progressArtifactDigests(sessionDir, mode, { currentTicket, step }),
  };
}

export function diffProgressSnapshot(previous, next) {
  if (!previous) {
    return ['initial_snapshot'];
  }

  const reasons = [];
  if (previous.head_sha !== next.head_sha) {
    reasons.push('head_sha');
  }
  if (previous.worktree_fingerprint !== next.worktree_fingerprint) {
    reasons.push('worktree_fingerprint');
  }
  const previousArtifacts = previous.progress_artifacts || {};
  const nextArtifacts = next.progress_artifacts || {};
  const artifactKeys = new Set([...Object.keys(previousArtifacts), ...Object.keys(nextArtifacts)]);
  for (const key of artifactKeys) {
    if ((previousArtifacts[key] || null) !== (nextArtifacts[key] || null)) {
      reasons.push(`progress_artifact:${key}`);
    }
  }

  return reasons;
}
