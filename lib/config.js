import fs from 'node:fs';
import {
  atomicWriteJson,
  ensureDir,
  getConfigPath,
  getDataRoot,
  readJsonFile,
} from './pickle-utils.js';

export const DEFAULT_CONFIG = {
  runtime: {
    command: process.env.PICKLE_CODEX_BIN || 'codex',
    model: null,
    exec_args: ['--full-auto'],
    add_dirs: [],
    json_output: true,
  },
  defaults: {
    max_iterations: 25,
    max_time_minutes: 120,
    worker_timeout_seconds: 900,
    refinement_timeout_seconds: 600,
    max_retry_attempts: 2,
    activity_logging: true,
    hook_timeout_seconds: 10,
    circuit_breaker: {
      enabled: true,
      no_progress_threshold: 5,
      half_open_after: 2,
      same_error_threshold: 5,
    },
  },
  hooks: {
    enabled: true,
    validated_events: ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse'],
  },
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? structuredClone(base) : structuredClone(override);
  }

  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const output = { ...base };
    for (const [key, value] of Object.entries(override)) {
      output[key] = key in output ? deepMerge(output[key], value) : structuredClone(value);
    }
    return output;
  }

  return override === undefined ? base : override;
}

export function loadConfig(configPath = getConfigPath()) {
  const raw = readJsonFile(configPath, {});
  return deepMerge(DEFAULT_CONFIG, raw || {});
}

export function ensureConfigFile(configPath = getConfigPath()) {
  ensureDir(getDataRoot());
  if (!fs.existsSync(configPath)) {
    atomicWriteJson(configPath, DEFAULT_CONFIG);
  }
  return loadConfig(configPath);
}

export function saveConfig(config, configPath = getConfigPath()) {
  ensureDir(getDataRoot());
  atomicWriteJson(configPath, config);
}
