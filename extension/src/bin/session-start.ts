#!/usr/bin/env node
import { pruneSessionMap } from '../services/session-map.js';

pruneSessionMap().catch(() => {
  process.exit(0);
});
