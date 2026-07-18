import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './pickle-utils.js';
import { StateManager } from './state-manager.js';

export const CODEX_MANAGER_RELAUNCH_CAP = 10;
export const DECLARED_RUNNER_RELAUNCH_PATHS = Object.freeze([
  'pickle-tmux',
  'pickle-pipeline',
  'detached-loop',
] as const);
export type RunnerRelaunchPath = typeof DECLARED_RUNNER_RELAUNCH_PATHS[number];

interface RelaunchHistoryEntry {
  path: RunnerRelaunchPath;
  timestamp: string;
}

export interface RelaunchAuditViolation {
  statePath: string;
  count: number | null;
  cap: number;
  reason: string;
}

export interface RelaunchAuditResult {
  cap: number;
  checkedStatePaths: string[];
  violations: RelaunchAuditViolation[];
}

export function auditCodexManagerRelaunchCaps(sessionDir: string): RelaunchAuditResult {
  const statePath = path.join(sessionDir, 'state.json');
  const violations: RelaunchAuditViolation[] = [];
  const state = readJsonFile<Record<string, unknown>>(statePath, null);
  const rawCount = state?.manager_relaunch_count ?? 0;
  const count = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : null;
  if (!state) {
    violations.push({ statePath, count: null, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'state file is unreadable or absent' });
  } else if (count === null) {
    violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'manager_relaunch_count is not a non-negative integer' });
  } else if (count > CODEX_MANAGER_RELAUNCH_CAP) {
    violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: `manager_relaunch_count ${count} exceeds cap ${CODEX_MANAGER_RELAUNCH_CAP}` });
  }

  const history = state?.manager_relaunch_history;
  if (history !== undefined && !Array.isArray(history)) {
    violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: 'manager_relaunch_history is not an array' });
  } else if (Array.isArray(history)) {
    for (const entry of history) {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
      if (!value || !DECLARED_RUNNER_RELAUNCH_PATHS.includes(value.path as RunnerRelaunchPath)) {
        violations.push({ statePath, count, cap: CODEX_MANAGER_RELAUNCH_CAP, reason: `undeclared runner relaunch path: ${String(value?.path ?? '<invalid>')}` });
      }
    }
  }
  return { cap: CODEX_MANAGER_RELAUNCH_CAP, checkedStatePaths: [statePath], violations };
}

export function recordCodexManagerRelaunch(sessionDir: string, relaunchPath: RunnerRelaunchPath): number {
  if (!DECLARED_RUNNER_RELAUNCH_PATHS.includes(relaunchPath)) {
    throw new Error(`Undeclared Codex runner relaunch path: ${relaunchPath}`);
  }
  const audit = auditCodexManagerRelaunchCaps(sessionDir);
  if (audit.violations.length) {
    throw new Error(`Cannot relaunch Codex manager: ${audit.violations.map((item) => item.reason).join('; ')}`);
  }
  const manager = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  let nextCount = 0;
  manager.update(statePath, (state) => {
    const current = Number(state.manager_relaunch_count || 0);
    if (!Number.isInteger(current) || current < 0 || current >= CODEX_MANAGER_RELAUNCH_CAP) {
      throw new Error(`Codex manager relaunch cap ${CODEX_MANAGER_RELAUNCH_CAP} reached for ${sessionDir}`);
    }
    nextCount = current + 1;
    state.manager_relaunch_count = nextCount;
    const history = Array.isArray(state.manager_relaunch_history)
      ? state.manager_relaunch_history as unknown[]
      : [];
    history.push({ path: relaunchPath, timestamp: new Date().toISOString() } satisfies RelaunchHistoryEntry);
    state.manager_relaunch_history = history;
    return state;
  });
  return nextCount;
}

export function auditDeclaredRunnerRelaunchCallsites(sourceRoot: string): string[] {
  const expected = new Map<string, RunnerRelaunchPath>([
    ['bin/pickle-tmux.ts', 'pickle-tmux'],
    ['bin/pickle-pipeline.ts', 'pickle-pipeline'],
    ['services/detached-launch.ts', 'detached-loop'],
  ]);
  const violations: string[] = [];
  const observed = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const relative = path.relative(sourceRoot, filePath).split(path.sep).join('/');
        if (relative === 'services/manager-relaunch-integrity.ts') continue;
        const text = fs.readFileSync(filePath, 'utf8');
        if (!text.includes('recordCodexManagerRelaunch(')) continue;
        observed.add(relative);
        const declared = expected.get(relative);
        if (!declared || !text.includes(`, '${declared}')`)) {
          violations.push(`undeclared or mismatched relaunch callsite: ${relative}`);
        }
      }
    }
  };
  walk(sourceRoot);
  for (const relative of expected.keys()) {
    if (!observed.has(relative)) violations.push(`missing declared relaunch callsite: ${relative}`);
  }
  return violations;
}
