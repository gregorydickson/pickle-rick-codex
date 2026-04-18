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

function fileDigest(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function progressArtifactDigests(sessionDir, mode) {
  const digests = {};
  for (const relativePath of canonicalProgressArtifacts(mode)) {
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
    progress_artifacts: progressArtifactDigests(sessionDir, mode),
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
