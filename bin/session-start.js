#!/usr/bin/env node
import { pruneSessionMap } from '../lib/session-map.js';

pruneSessionMap().catch(() => {
  process.exit(0);
});
