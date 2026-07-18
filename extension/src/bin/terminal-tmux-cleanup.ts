#!/usr/bin/env node
import { cleanupTerminalTmuxSession } from '../services/terminal-tmux-cleanup.js';

function main(argv: string[]): void {
  const sessionDir = argv.find((arg) => !arg.startsWith('--'));
  if (!sessionDir) {
    throw new Error('Usage: node bin/terminal-tmux-cleanup.js <session-dir>');
  }
  const result = cleanupTerminalTmuxSession(sessionDir);
  if (result.status === 'quarantined') {
    console.error(`Tmux cleanup quarantined ${result.sessionName}: ${result.reason}`);
    process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
