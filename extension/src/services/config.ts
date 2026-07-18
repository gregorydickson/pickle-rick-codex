import fs from 'node:fs';
import {
  atomicWriteJson,
  ensureDir,
  getConfigPath,
  getDataRoot,
  readJsonFile,
} from './pickle-utils.js';
import type { Config } from '../types/index.js';

export const DEFAULT_CONFIG: Config = {
  runtime: {
    command: process.env.PICKLE_CODEX_BIN || 'codex',
    model: null,
    exec_args: ['--full-auto'],
    add_dirs: [],
    json_output: true,
  },
  defaults: {
    max_iterations: 25,
    max_time_minutes: 480,
    worker_timeout_seconds: 900,
    refinement_timeout_seconds: 600,
    max_retry_attempts: 2,
    activity_logging: true,
    hook_timeout_seconds: 10,
    verification_env: null,
    circuit_breaker: {
      enabled: true,
      no_progress_threshold: 5,
      half_open_after: 2,
      same_error_threshold: 5,
    },
  },
  hooks: {
    enabled: false,
    validated_events: [],
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? structuredClone(base) : structuredClone(override) as T;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const output: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      output[key] = key in output ? deepMerge(output[key], value) : structuredClone(value);
    }
    return output as T;
  }

  return (override === undefined ? base : override) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

interface NormalizeIntegerOptions {
  min?: number;
}

function normalizeInteger(value: unknown, fallback: number, options: NormalizeIntegerOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  if (!Number.isSafeInteger(normalized)) return fallback;
  if (options.min !== undefined && normalized < options.min) return fallback;
  return normalized;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return structuredClone(fallback);
  return value
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .map((entry) => entry.trim());
}

function normalizeObjectOrNull(value: unknown, fallback: Record<string, unknown> | null = null): Record<string, unknown> | null {
  if (value === null) return null;
  if (isPlainObject(value)) return structuredClone(value);
  return fallback;
}

function normalizeConfig(raw: unknown): Config {
  const defaults = structuredClone(DEFAULT_CONFIG);
  if (!isPlainObject(raw)) {
    return defaults;
  }

  const runtime = isPlainObject(raw.runtime) ? raw.runtime : {};
  const rawDefaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const circuitBreaker = isPlainObject(rawDefaults.circuit_breaker) ? rawDefaults.circuit_breaker : {};
  const hooks = isPlainObject(raw.hooks) ? raw.hooks : {};

  return deepMerge<Config>(defaults, {
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
      verification_env: normalizeObjectOrNull(rawDefaults.verification_env, defaults.defaults.verification_env),
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

type LegacyMaxTimeConfig = Record<string, unknown> & { defaults: Record<string, unknown> };

function shouldMigrateLegacyMaxTimeConfig(raw: unknown): raw is LegacyMaxTimeConfig {
  if (!isPlainObject(raw)) return false;
  const legacyDefaultMaxTime = 120;
  const rawDefaults = raw.defaults;
  if (!isPlainObject(rawDefaults) || rawDefaults.max_time_minutes !== legacyDefaultMaxTime) {
    return false;
  }

  const normalized = normalizeConfig(raw);
  const legacyHooks = {
    enabled: true,
    validated_events: ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse'],
  };
  const hooksAreManagedDefaults = JSON.stringify(normalized.hooks) === JSON.stringify(DEFAULT_CONFIG.hooks)
    || JSON.stringify(normalized.hooks) === JSON.stringify(legacyHooks);
  return (
    JSON.stringify(normalized.runtime) === JSON.stringify(DEFAULT_CONFIG.runtime)
    && JSON.stringify(normalized.defaults) === JSON.stringify({
      ...DEFAULT_CONFIG.defaults,
      max_time_minutes: legacyDefaultMaxTime,
    })
    && hooksAreManagedDefaults
  );
}

export function loadConfig(configPath: string = getConfigPath()): Config {
  const raw = readJsonFile<unknown>(configPath, {});
  return normalizeConfig(raw);
}

export function ensureConfigFile(configPath: string = getConfigPath()): Config {
  ensureDir(getDataRoot());
  if (!fs.existsSync(configPath)) {
    atomicWriteJson(configPath, DEFAULT_CONFIG);
  } else {
    const raw = readJsonFile<unknown>(configPath, null);
    if (isPlainObject(raw)) {
      let migrated = raw;
      let changed = false;
      if (shouldMigrateLegacyMaxTimeConfig(raw)) {
        migrated = {
          ...migrated,
          defaults: {
            ...(migrated.defaults as Record<string, unknown>),
            max_time_minutes: DEFAULT_CONFIG.defaults.max_time_minutes,
          },
          hooks: DEFAULT_CONFIG.hooks,
        };
        changed = true;
      }
      if (changed) atomicWriteJson(configPath, migrated);
    }
  }
  return loadConfig(configPath);
}

export function saveConfig(config: unknown, configPath: string = getConfigPath()): void {
  ensureDir(getDataRoot());
  atomicWriteJson(configPath, normalizeConfig(config));
}
