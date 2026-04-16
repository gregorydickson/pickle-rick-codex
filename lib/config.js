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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeNullableString(value, fallback) {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInteger(value, fallback, options = {}) {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  if (!Number.isSafeInteger(normalized)) return fallback;
  if (options.min !== undefined && normalized < options.min) return fallback;
  return normalized;
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return structuredClone(fallback);
  return value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
}

function normalizeConfig(raw) {
  const defaults = structuredClone(DEFAULT_CONFIG);
  if (!isPlainObject(raw)) {
    return defaults;
  }

  const runtime = isPlainObject(raw.runtime) ? raw.runtime : {};
  const rawDefaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const circuitBreaker = isPlainObject(rawDefaults.circuit_breaker) ? rawDefaults.circuit_breaker : {};
  const hooks = isPlainObject(raw.hooks) ? raw.hooks : {};

  return deepMerge(defaults, {
    runtime: {
      command: normalizeString(runtime.command, defaults.runtime.command),
      model: normalizeNullableString(runtime.model, defaults.runtime.model),
      exec_args: normalizeStringArray(runtime.exec_args, defaults.runtime.exec_args),
      add_dirs: normalizeStringArray(runtime.add_dirs, defaults.runtime.add_dirs),
      json_output: normalizeBoolean(runtime.json_output, defaults.runtime.json_output),
    },
    defaults: {
      max_iterations: normalizeInteger(rawDefaults.max_iterations, defaults.defaults.max_iterations, { min: 0 }),
      max_time_minutes: normalizeInteger(rawDefaults.max_time_minutes, defaults.defaults.max_time_minutes, { min: 0 }),
      worker_timeout_seconds: normalizeInteger(
        rawDefaults.worker_timeout_seconds,
        defaults.defaults.worker_timeout_seconds,
        { min: 0 },
      ),
      refinement_timeout_seconds: normalizeInteger(
        rawDefaults.refinement_timeout_seconds,
        defaults.defaults.refinement_timeout_seconds,
        { min: 0 },
      ),
      max_retry_attempts: normalizeInteger(rawDefaults.max_retry_attempts, defaults.defaults.max_retry_attempts, { min: 0 }),
      activity_logging: normalizeBoolean(rawDefaults.activity_logging, defaults.defaults.activity_logging),
      hook_timeout_seconds: normalizeInteger(rawDefaults.hook_timeout_seconds, defaults.defaults.hook_timeout_seconds, { min: 0 }),
      circuit_breaker: {
        enabled: normalizeBoolean(circuitBreaker.enabled, defaults.defaults.circuit_breaker.enabled),
        no_progress_threshold: normalizeInteger(
          circuitBreaker.no_progress_threshold,
          defaults.defaults.circuit_breaker.no_progress_threshold,
          { min: 0 },
        ),
        half_open_after: normalizeInteger(
          circuitBreaker.half_open_after,
          defaults.defaults.circuit_breaker.half_open_after,
          { min: 0 },
        ),
        same_error_threshold: normalizeInteger(
          circuitBreaker.same_error_threshold,
          defaults.defaults.circuit_breaker.same_error_threshold,
          { min: 0 },
        ),
      },
    },
    hooks: {
      enabled: normalizeBoolean(hooks.enabled, defaults.hooks.enabled),
      validated_events: normalizeStringArray(hooks.validated_events, defaults.hooks.validated_events),
    },
  });
}

export function loadConfig(configPath = getConfigPath()) {
  const raw = readJsonFile(configPath, {});
  return normalizeConfig(raw);
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
  atomicWriteJson(configPath, normalizeConfig(config));
}
