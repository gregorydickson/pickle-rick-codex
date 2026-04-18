const SAFE_REPLACE_ENV_KEYS = [
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

const INFERRED_ENV_IGNORE_KEYS = new Set([
  ...SAFE_REPLACE_ENV_KEYS,
  'PWD',
  'OLDPWD',
  '_',
  'IFS',
  'OPTARG',
  'OPTIND',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value) {
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

function normalizeMode(value) {
  return ['inherit', 'merge', 'replace'].includes(value) ? value : 'inherit';
}

function normalizeRequirement(value) {
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

function normalizeRequiredList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeRequirement).filter(Boolean);
  }
  const single = normalizeRequirement(value);
  return single ? [single] : [];
}

function normalizeVarSpec(value) {
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

function normalizeVars(value) {
  if (!isPlainObject(value)) return {};
  const entries = {};
  for (const [key, spec] of Object.entries(value)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const normalized = normalizeVarSpec(spec);
    if (!normalized) continue;
    entries[key.trim()] = normalized;
  }
  return entries;
}

function ticketVerificationCommands(ticket) {
  if (Array.isArray(ticket?.verification) && ticket.verification.length > 0) {
    return ticket.verification.map((command) => String(command));
  }
  if (typeof ticket?.verification === 'string' && ticket.verification.trim()) {
    return ticket.verification.split('&&').map((command) => command.trim()).filter(Boolean);
  }
  if (typeof ticket?.verify === 'string' && ticket.verify.trim()) {
    return ticket.verify.split('&&').map((command) => command.trim()).filter(Boolean);
  }
  return [];
}

function inferLocallyAssignedEnvNames(command) {
  const assigned = new Set();
  const assignmentPattern = /(?:^|[;&|()]\s*|\s+)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g;

  let match;
  while ((match = assignmentPattern.exec(command)) !== null) {
    assigned.add(match[1]);
  }

  return assigned;
}

function inferRequiredEnvFromVerificationCommands(ticket, contract = null) {
  const inferred = new Map();
  const commands = ticketVerificationCommands(ticket);
  const contractVars = new Set(Object.keys(contract?.vars || {}));
  const pattern = /(?<!\\)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

  for (const command of commands) {
    const locallyAssigned = inferLocallyAssignedEnvNames(command);
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const name = match[1] || match[2] || '';
      if (!name || INFERRED_ENV_IGNORE_KEYS.has(name) || contractVars.has(name) || locallyAssigned.has(name)) {
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

function extractTicketContract(ticket) {
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

  const inferredContract = {
    mode: explicitContract?.mode || 'inherit',
    required: inferredRequired,
    vars: {},
  };

  return mergeContracts(explicitContract, inferredContract);
}

function mergeContracts(baseContract, ticketContract) {
  if (!baseContract && !ticketContract) return null;
  if (!baseContract) return ticketContract;
  if (!ticketContract) return baseContract;

  const required = new Map(baseContract.required.map((entry) => [entry.name, entry]));
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

export function normalizeVerificationEnvContract(value) {
  const parsed = parseMaybeJson(value);
  if (!isPlainObject(parsed)) return null;

  const required = [
    ...normalizeRequiredList(parsed.required),
    ...normalizeRequiredList(parsed.required_env || parsed.requiredEnv),
  ];

  const byName = new Map();
  for (const entry of required) {
    byName.set(entry.name, entry);
  }

  return {
    mode: normalizeMode(parsed.mode),
    required: [...byName.values()],
    vars: normalizeVars(parsed.vars),
  };
}

function pickReplaceBaseEnv(ambientEnv) {
  const env = {};
  for (const key of SAFE_REPLACE_ENV_KEYS) {
    if (ambientEnv[key] !== undefined) {
      env[key] = ambientEnv[key];
    }
  }
  return env;
}

function validateRequirement(name, format, value) {
  if (value == null || String(value).trim() === '') {
    return {
      kind: 'preflight-missing-env',
      name,
      message: `${name} is required for verification`,
    };
  }

  if (format === 'url') {
    try {
      // eslint-disable-next-line no-new
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
  constructor({ kind, ticketId, prerequisite, message }) {
    super(`${kind}: ${message}`);
    this.name = 'PreflightError';
    this.kind = kind;
    this.ticketId = ticketId || null;
    this.prerequisite = prerequisite || null;
  }
}

export function isPreflightError(error) {
  return error instanceof PreflightError;
}

export function resolveVerificationEnv({ ticket, config, ambientEnv = process.env }) {
  const baseContract = normalizeVerificationEnvContract(config?.defaults?.verification_env);
  const ticketContract = extractTicketContract(ticket);
  const contract = mergeContracts(baseContract, ticketContract);

  if (!contract) {
    return {
      contract: null,
      env: ambientEnv,
      diagnostics: [],
    };
  }

  const env = contract.mode === 'replace'
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
    .filter(Boolean);

  return { contract, env, diagnostics };
}

export function assertTicketVerificationReady({ ticket, config, ambientEnv = process.env }) {
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

export function describeVerificationContract(contract) {
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
