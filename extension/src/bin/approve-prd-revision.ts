#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveSessionPrdRevision } from '../services/session-prd-seal.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sessionDir = process.argv[2];
  if (!sessionDir) throw new Error('Usage: node bin/approve-prd-revision.js <session-dir>');
  const seal = approveSessionPrdRevision(path.resolve(sessionDir));
  process.stdout.write(`${JSON.stringify({ semantic_hash: seal.semantic_hash })}\n`);
}
