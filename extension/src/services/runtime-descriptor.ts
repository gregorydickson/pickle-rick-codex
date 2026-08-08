import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InstalledRuntimeDescriptor } from './durable-supervisor.js';
import { atomicWriteJson } from './pickle-utils.js';

export const RUNTIME_DESCRIPTOR_FILE = '.runtime-descriptor.json';

const HASHED_RUNTIME_PATHS = [
  'install.sh',
  'package.json',
  'skills',
  'extension/package.json',
  'extension/state-schema.json',
  'extension/bin',
  'extension/services',
  'extension/types',
] as const;

// Construct this marker so the descriptor implementation itself does not
// contain the reserved byte sequence it rejects in hashed runtime files.
const RUNTIME_ROOT_NORMALIZATION_TOKEN = ['<PICKLE', 'RUNTIME', 'ROOT>'].join('_');

function filesUnder(root: string, relative: string): string[] {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Runtime descriptor refuses symbolic link: ${relative}.`);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => (
    filesUnder(root, path.join(relative, entry.name))
  ));
}

function normalizedRuntimeContent(root: string, raw: Buffer): Buffer {
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return raw;
  if (text.includes(RUNTIME_ROOT_NORMALIZATION_TOKEN)) {
    throw new Error('Runtime descriptor refuses reserved runtime-root normalization token in runtime contents.');
  }
  const aliases = [root, '$HOME/.codex/pickle-rick', '~/.codex/pickle-rick']
    .sort((left, right) => right.length - left.length);
  let normalized = text;
  for (const alias of aliases) normalized = normalized.split(alias).join(RUNTIME_ROOT_NORMALIZATION_TOKEN);
  return Buffer.from(normalized, 'utf8');
}

export function runtimeBuildHash(runtimeRoot: string): string {
  const root = fs.realpathSync(runtimeRoot);
  const files = HASHED_RUNTIME_PATHS.flatMap((relative) => filesUnder(root, relative)).sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const raw = fs.readFileSync(path.join(root, relative));
    const normalized = normalizedRuntimeContent(root, raw);
    hash.update(relative);
    hash.update('\0');
    hash.update(normalized);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computedRuntimeDescriptor(runtimeRoot: string): InstalledRuntimeDescriptor {
  const root = fs.realpathSync(runtimeRoot);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'package.json'), 'utf8')) as Record<string, unknown>;
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'state-schema.json'), 'utf8')) as Record<string, unknown>;
  const version = String(pkg.version || '').trim();
  const schemaVersion = Number(schema.schema_version);
  if (!version) throw new Error('Runtime descriptor requires extension/package.json version.');
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Runtime descriptor requires a positive state schema version.');
  const buildHash = runtimeBuildHash(root);
  return {
    runtime_id: `pickle-rick-codex:${buildHash.slice(0, 16)}`,
    version,
    build_hash: buildHash,
    min_state_schema: 1,
    max_state_schema: schemaVersion,
  };
}

export function describeInstalledRuntime(runtimeRoot: string): InstalledRuntimeDescriptor {
  const root = fs.realpathSync(runtimeRoot);
  const computed = computedRuntimeDescriptor(root);
  const descriptorPath = path.join(root, RUNTIME_DESCRIPTOR_FILE);
  if (!fs.existsSync(descriptorPath)) return computed;
  const persisted = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as InstalledRuntimeDescriptor;
  if (JSON.stringify(persisted) !== JSON.stringify(computed)) {
    throw new Error('Installed runtime descriptor hash does not match runtime contents.');
  }
  return persisted;
}

export function writeInstalledRuntimeDescriptor(runtimeRoot: string): InstalledRuntimeDescriptor {
  const root = fs.realpathSync(runtimeRoot);
  const descriptor = computedRuntimeDescriptor(root);
  atomicWriteJson(path.join(root, RUNTIME_DESCRIPTOR_FILE), descriptor);
  return descriptor;
}
