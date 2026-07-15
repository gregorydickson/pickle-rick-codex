import fs from 'node:fs';
import path from 'node:path';
import type {
  ConfigVerificationInput,
  PreflightDiagnostic,
  TicketVerificationInput,
  VerificationContract,
  VerificationEnvMode,
  VerificationEnvResult,
  VerificationEnvVarSpec,
  VerificationRequirement,
} from '../types/index.js';

const SAFE_REPLACE_ENV_KEYS: readonly string[] = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SHLVL',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'TZ',
  'USER',
];

const INFERRED_ENV_IGNORE_KEYS = new Set<string>([
  ...SAFE_REPLACE_ENV_KEYS,
  'PWD',
  'OLDPWD',
  '_',
  'IFS',
  'OPTARG',
  'OPTIND',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeMode(value: unknown): VerificationEnvMode {
  if (value === 'inherit' || value === 'merge' || value === 'replace') return value;
  return 'inherit';
}

function normalizeRequirement(value: unknown): VerificationRequirement | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      name: value.trim(),
      format: 'string',
    };
  }

  if (!isPlainObject(value) || typeof value.name !== 'string' || !value.name.trim()) {
    return null;
  }

  return {
    name: value.name.trim(),
    format: value.format === 'url' ? 'url' : 'string',
  };
}

function normalizeRequiredList(value: unknown): VerificationRequirement[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeRequirement)
      .filter((entry): entry is VerificationRequirement => entry !== null);
  }
  const single = normalizeRequirement(value);
  return single ? [single] : [];
}

function normalizeVarSpec(value: unknown): VerificationEnvVarSpec | null {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === 'string') {
    return { type: 'literal', value: parsed };
  }
  if (typeof parsed === 'number' || typeof parsed === 'boolean') {
    return { type: 'literal', value: String(parsed) };
  }
  if (!isPlainObject(parsed)) return null;

  const fromEnv = parsed.from_env || parsed.fromEnv;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { type: 'env', fromEnv: fromEnv.trim() };
  }

  if ('value' in parsed) {
    return { type: 'literal', value: parsed.value == null ? '' : String(parsed.value) };
  }

  return null;
}

function normalizeVars(value: unknown): Record<string, VerificationEnvVarSpec> {
  if (!isPlainObject(value)) return {};
  const entries: Record<string, VerificationEnvVarSpec> = {};
  for (const [key, spec] of Object.entries(value)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const normalized = normalizeVarSpec(spec);
    if (!normalized) continue;
    entries[key.trim()] = normalized;
  }
  return entries;
}

function normalizeVerificationCommandList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      commands.push(entry.trim());
      continue;
    }
    if (isPlainObject(entry) && typeof entry.command === 'string' && entry.command.trim()) {
      commands.push(entry.command.trim());
    }
  }
  return commands;
}

function splitShellCommandList(value: string): string[] {
  const commands: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < value.length) {
        index += 1;
        current += value[index];
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '\\' && index + 1 < value.length) {
      current += char;
      index += 1;
      current += value[index];
      continue;
    }

    if (char === '&' && next === '&') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      index += 1;
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) commands.push(trailing);
  return commands;
}

function normalizeVerificationValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeVerificationCommandList(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return splitShellCommandList(value);
  }
  if (isPlainObject(value)) {
    if ('commands' in value) {
      return normalizeVerificationValue(value.commands);
    }
    if (typeof value.command === 'string' && value.command.trim()) {
      return [value.command.trim()];
    }
  }
  return [];
}

function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function packageManagerExecArgs(packageManager: string): string[] | null {
  if (packageManager === 'pnpm' || packageManager === 'yarn') {
    return [packageManager, 'exec'];
  }
  if (packageManager === 'bun') {
    return [packageManager, 'x'];
  }
  if (packageManager === 'npm') {
    return [packageManager, 'exec', '--'];
  }
  return null;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

function extractPackageDirFromTokens(tokens: string[], cwd: string): string {
  let packageDir = cwd;
  let pnpmFilter = '';
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'test') break;
    if ((token === '--filter' || token === '-F') && tokens[index + 1]) {
      pnpmFilter = tokens[index + 1];
      index += 1;
      continue;
    }
    const inlineFilterMatch = token.match(/^(?:--filter|-F)=(.+)$/);
    if (inlineFilterMatch) {
      pnpmFilter = inlineFilterMatch[1];
      continue;
    }
    if ((token === '-C' || token === '--dir' || token === '--cwd' || token === '--prefix') && tokens[index + 1]) {
      packageDir = path.resolve(cwd, tokens[index + 1]);
      index += 1;
      continue;
    }
    const inlineMatch = token.match(/^(?:--dir|--cwd|--prefix)=(.+)$/);
    if (inlineMatch) {
      packageDir = path.resolve(cwd, inlineMatch[1]);
    }
  }

  if (tokens[0] === 'pnpm') {
    const filteredPackageDir = resolvePnpmFilterPackageDir(cwd, pnpmFilter);
    if (filteredPackageDir) {
      return filteredPackageDir;
    }
  }

  return packageDir;
}

function normalizePnpmFilterSelector(value: unknown): string {
  let normalized = String(value || '').trim();
  if (!normalized) return '';
  normalized = normalized.replace(/^!+/, '');
  normalized = normalized.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').replace(/^\^\.\.\.$/, '');
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function readPackageName(packageDir: string): string {
  const pkg = readPackageJson(packageDir);
  return typeof pkg?.name === 'string' && pkg.name.trim() ? pkg.name.trim() : '';
}

function findWorkspacePackageDirByName(rootDir: string, packageName: string): string | null {
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    const currentName = readPackageName(currentDir);
    if (currentName === packageName) {
      return currentDir;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      queue.push(path.join(currentDir, entry.name));
    }
  }

  return null;
}

function resolvePnpmFilterPackageDir(cwd: string, selector: string): string | null {
  const normalized = normalizePnpmFilterSelector(selector);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('.') || normalized.startsWith('/')) {
    return path.resolve(cwd, normalized);
  }

  return findWorkspacePackageDirByName(cwd, normalized);
}

function readPackageJson(packageDir: string): PackageJson | null {
  try {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function extractVitestScriptArgs(script: unknown): string[] | null {
  if (typeof script !== 'string' || !script.trim()) return null;
  const tokens = tokenizeShellWords(script);
  const vitestIndex = tokens.findIndex((token) => /(?:^|[\\/])vitest(?:\.mjs)?$/.test(token));
  if (vitestIndex === -1) return null;
  const args = tokens.slice(vitestIndex + 1);
  if (args[0] && ['run', 'watch', 'dev'].includes(args[0])) {
    args.shift();
  }
  return args;
}

function rewriteScopedVitestCommand(command: string, cwd: string | undefined): string {
  if (typeof command !== 'string' || !command.trim() || typeof cwd !== 'string' || !cwd.trim()) {
    return command;
  }

  const tokens = tokenizeShellWords(command);
  const packageManager = tokens[0];
  if (!['pnpm', 'npm', 'yarn', 'bun'].includes(packageManager)) {
    return command;
  }

  const testIndex = tokens.indexOf('test');
  const separatorIndex = tokens.indexOf('--');
  if (testIndex === -1 || separatorIndex === -1 || separatorIndex <= testIndex || separatorIndex === tokens.length - 1) {
    return command;
  }

  if (tokens.some((token, index) => index > separatorIndex && token === '&&')) {
    return command;
  }

  const targetArgs = tokens.slice(separatorIndex + 1).filter(Boolean);
  if (targetArgs.length === 0) {
    return command;
  }

  const packageDir = extractPackageDirFromTokens(tokens, cwd);
  const packageJson = readPackageJson(packageDir);
  const scriptArgs = extractVitestScriptArgs(packageJson?.scripts?.test);
  const execArgs = packageManagerExecArgs(packageManager);
  if (!scriptArgs || !execArgs) {
    return command;
  }

  const rewritten = [
    'cd',
    shellQuote(packageDir),
    '&&',
    ...execArgs.map(shellQuote),
    shellQuote('vitest'),
    shellQuote('run'),
    ...scriptArgs.map(shellQuote),
    ...targetArgs.map(shellQuote),
  ];
  return rewritten.join(' ');
}

function rewriteScopedVerificationCommands(commands: string[], cwd: string | undefined): string[] {
  return commands.map((command) => rewriteScopedVitestCommand(command, cwd));
}

interface NormalizeVerificationCommandsOptions {
  cwd?: string;
  verify?: unknown;
}

export function normalizeVerificationCommands(value: unknown, options: NormalizeVerificationCommandsOptions = {}): string[] {
  const commands = normalizeVerificationValue(value);
  if (commands.length > 0) return rewriteScopedVerificationCommands(commands, options.cwd);
  if ('verify' in options) {
    return rewriteScopedVerificationCommands(normalizeVerificationValue(options.verify), options.cwd);
  }
  return [];
}

function ticketVerificationCommands(ticket: TicketVerificationInput | null | undefined): string[] {
  return normalizeVerificationCommands(ticket?.verification, { verify: ticket?.verify });
}

const REPO_WRAPPER_ENV_RULES: readonly { pattern: RegExp; required: readonly string[] }[] = [
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?check:env\b/i,
    required: ['ATTRACTOR_ROOT', 'DIPPIN_ROOT'],
  },
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?fixtures:sync\b/i,
    required: ['ATTRACTOR_ROOT', 'DIPPIN_ROOT'],
  },
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?validate:attractor\b/i,
    required: ['ATTRACTOR_ROOT'],
  },
];

function inferLocallyAssignedEnvNames(command: string): Set<string> {
  const assigned = new Set<string>();
  const assignmentPattern = /(?:^|[;&|()]\s*|\s+)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g;

  let match: RegExpExecArray | null;
  while ((match = assignmentPattern.exec(command)) !== null) {
    assigned.add(match[1]);
  }

  return assigned;
}

function inferWrapperRequiredEnv(command: string): Set<string> {
  const inferred = new Set<string>();
  for (const rule of REPO_WRAPPER_ENV_RULES) {
    if (!rule.pattern.test(command)) continue;
    for (const name of rule.required) {
      inferred.add(name);
    }
  }
  return inferred;
}

function inferRequiredEnvFromVerificationCommands(
  ticket: TicketVerificationInput | null | undefined,
  contract: VerificationContract | null = null,
): VerificationRequirement[] {
  const inferred = new Map<string, VerificationRequirement>();
  const commands = ticketVerificationCommands(ticket);
  const contractVars = new Set<string>(Object.keys(contract?.vars || {}));
  const pattern = /(?<!\\)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

  for (const command of commands) {
    const locallyAssigned = inferLocallyAssignedEnvNames(command);
    for (const name of inferWrapperRequiredEnv(command)) {
      if (INFERRED_ENV_IGNORE_KEYS.has(name) || contractVars.has(name) || locallyAssigned.has(name)) {
        continue;
      }
      inferred.set(name, {
        name,
        format: 'string',
      });
    }

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(command)) !== null) {
      const name = match[1] || match[3] || '';
      const expansionRest = match[2] || '';
      if (!name) continue;
      if (/^:?[-=?]/.test(expansionRest)) continue;
      if (INFERRED_ENV_IGNORE_KEYS.has(name) || contractVars.has(name) || locallyAssigned.has(name)) {
        continue;
      }
      inferred.set(name, {
        name,
        format: 'string',
      });
    }
  }

  return [...inferred.values()];
}

function extractTicketContract(ticket: TicketVerificationInput | null | undefined): VerificationContract | null {
  const explicitContract = (() => {
    if (ticket?.verification_env != null || ticket?.verificationEnv != null) {
      return normalizeVerificationEnvContract(ticket.verification_env ?? ticket.verificationEnv);
    }
    if (ticket?.required_env != null || ticket?.requiredEnv != null) {
      return normalizeVerificationEnvContract({
        required: ticket.required_env ?? ticket.requiredEnv,
      });
    }
    return normalizeVerificationEnvContract(null);
  })();

  const inferredRequired = inferRequiredEnvFromVerificationCommands(ticket, explicitContract);
  if (inferredRequired.length === 0) {
    return explicitContract;
  }

  const inferredContract: VerificationContract = {
    mode: explicitContract?.mode || 'inherit',
    required: inferredRequired,
    vars: {},
  };

  return mergeContracts(explicitContract, inferredContract);
}

function mergeContracts(
  baseContract: VerificationContract | null,
  ticketContract: VerificationContract | null,
): VerificationContract | null {
  if (!baseContract && !ticketContract) return null;
  if (!baseContract) return ticketContract;
  if (!ticketContract) return baseContract;

  const required = new Map<string, VerificationRequirement>(baseContract.required.map((entry) => [entry.name, entry]));
  for (const entry of ticketContract.required) {
    required.set(entry.name, entry);
  }

  return {
    mode: ticketContract.mode || baseContract.mode || 'inherit',
    required: [...required.values()],
    vars: {
      ...baseContract.vars,
      ...ticketContract.vars,
    },
  };
}

export function normalizeVerificationEnvContract(value: unknown): VerificationContract | null {
  const parsed = parseMaybeJson(value);
  if (!isPlainObject(parsed)) return null;

  const required = [
    ...normalizeRequiredList(parsed.required),
    ...normalizeRequiredList(parsed.required_env || parsed.requiredEnv),
  ];

  const byName = new Map<string, VerificationRequirement>();
  for (const entry of required) {
    byName.set(entry.name, entry);
  }

  return {
    mode: normalizeMode(parsed.mode),
    required: [...byName.values()],
    vars: normalizeVars(parsed.vars),
  };
}

export function resolveTicketVerificationContract({
  ticket,
  config,
}: {
  ticket: TicketVerificationInput | null | undefined;
  config: ConfigVerificationInput | null | undefined;
}): VerificationContract | null {
  const baseContract = normalizeVerificationEnvContract(config?.defaults?.verification_env);
  const ticketContract = extractTicketContract(ticket);
  return mergeContracts(baseContract, ticketContract);
}

function pickReplaceBaseEnv(ambientEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of SAFE_REPLACE_ENV_KEYS) {
    if (ambientEnv[key] !== undefined) {
      env[key] = ambientEnv[key];
    }
  }
  return env;
}

function validateRequirement(name: string, format: string, value: string | undefined): PreflightDiagnostic | null {
  if (value == null || String(value).trim() === '') {
    return {
      kind: 'preflight-missing-env',
      name,
      message: `${name} is required for verification`,
    };
  }

  if (format === 'url') {
    try {
      new URL(String(value));
    } catch {
      return {
        kind: 'preflight-invalid-env',
        name,
        message: `${name} must be a valid URL for verification`,
      };
    }
  }

  return null;
}

export class PreflightError extends Error {
  kind: string;
  ticketId: string | null;
  prerequisite: string | null;
  constructor({
    kind,
    ticketId,
    prerequisite,
    message,
  }: {
    kind: string;
    ticketId?: string | null;
    prerequisite?: string | null;
    message: string;
  }) {
    super(`${kind}: ${message}`);
    this.name = 'PreflightError';
    this.kind = kind;
    this.ticketId = ticketId || null;
    this.prerequisite = prerequisite || null;
  }
}

export function isPreflightError(error: unknown): boolean {
  return error instanceof PreflightError;
}

export class VerificationContractError extends Error {
  kind: string;
  ticketId: string | null;
  command: string | null;
  constructor({
    ticketId,
    command,
    message,
  }: {
    ticketId?: string | null;
    command?: string | null;
    message: string;
  }) {
    super(`verification-contract-failed: ${message}`);
    this.name = 'VerificationContractError';
    this.kind = 'verification-contract-failed';
    this.ticketId = ticketId || null;
    this.command = command || null;
  }
}

export function isVerificationContractError(error: unknown): boolean {
  return error instanceof VerificationContractError;
}

export function resolveVerificationEnv({
  ticket,
  config,
  ambientEnv = process.env,
}: {
  ticket: TicketVerificationInput | null | undefined;
  config: ConfigVerificationInput | null | undefined;
  ambientEnv?: NodeJS.ProcessEnv;
}): VerificationEnvResult {
  const contract = resolveTicketVerificationContract({ ticket, config });

  if (!contract) {
    return {
      contract: null,
      env: ambientEnv,
      diagnostics: [],
    };
  }

  const env: Record<string, string | undefined> = contract.mode === 'replace'
    ? pickReplaceBaseEnv(ambientEnv)
    : { ...ambientEnv };

  for (const [key, spec] of Object.entries(contract.vars)) {
    if (spec.type === 'env') {
      env[key] = ambientEnv[spec.fromEnv];
    } else {
      env[key] = spec.value;
    }
  }

  const diagnostics = contract.required
    .map((entry) => validateRequirement(entry.name, entry.format, env[entry.name]))
    .filter((d): d is PreflightDiagnostic => d !== null);

  return { contract, env, diagnostics };
}

export function assertTicketVerificationReady({
  ticket,
  config,
  ambientEnv = process.env,
}: {
  ticket: TicketVerificationInput | null | undefined;
  config: ConfigVerificationInput | null | undefined;
  ambientEnv?: NodeJS.ProcessEnv;
}): VerificationEnvResult {
  const resolved = resolveVerificationEnv({ ticket, config, ambientEnv });
  const first = resolved.diagnostics[0];
  if (first) {
    throw new PreflightError({
      kind: first.kind,
      ticketId: ticket?.id || null,
      prerequisite: first.name,
      message: first.message,
    });
  }
  return resolved;
}

export function describeVerificationContract(contract: VerificationContract | null | undefined): string {
  if (!contract) return '';
  const lines = [`mode: ${contract.mode}`];
  if (contract.required.length > 0) {
    lines.push(
      `required: ${contract.required
        .map((entry) => (entry.format === 'url' ? `${entry.name} (url)` : entry.name))
        .join(', ')}`,
    );
  }
  const vars = Object.entries(contract.vars);
  if (vars.length > 0) {
    lines.push(
      `vars: ${vars
        .map(([key, spec]) => (spec.type === 'env'
          ? `${key} <- $${spec.fromEnv}`
          : `${key} <- ${JSON.stringify(spec.value)}`))
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
