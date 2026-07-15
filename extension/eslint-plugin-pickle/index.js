/**
 * eslint-plugin-pickle — curated architectural lint rules for the pickle-rick-codex port.
 *
 * Scaffold milestone (M1): the four curated rules are registered as stubs so the flat
 * config loads and `--print-config` reports them. Full enforcement logic lands in M6
 * (safety-worker), where each `create()` gains its AST visitors and the severities move
 * to `error`.
 *
 * Curated rules:
 *   pickle/promise-token-format        — promise tokens must go through the PromiseTokens enum
 *   pickle/no-raw-state-write          — no raw fs writes to state.json; use StateManager
 *   pickle/cli-guard-basename          — CLI guards must use path.basename(process.argv[1]) === '...'
 *   pickle/no-process-exit-in-library  — services/ must throw, never process.exit()
 */

const promiseTokenFormat = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Promise tokens must be referenced via the PromiseTokens enum, not hardcoded strings.',
    },
    messages: {
      useEnum: 'Hardcoded promise token "{{token}}" — use PromiseTokens.* from types/index.js instead.',
    },
    schema: [],
  },
  create() {
    return {};
  },
};

const noRawStateWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw state.json writes — use StateManager.update() / forceWrite().',
    },
    messages: {
      useStateManager: 'Use StateManager.update()/forceWrite() instead of writing state.json directly. Raw writes risk corruption on crash.',
    },
    schema: [],
  },
  create() {
    return {};
  },
};

const cliGuardBasename = {
  meta: {
    type: 'problem',
    docs: {
      description: 'CLI entry guards must use path.basename(process.argv[1]) === "file.js".',
    },
    messages: {
      requireBasename: 'Use `path.basename(process.argv[1]) === "file.js"` for CLI guards, never startsWith/endsWith/includes or bare equality on process.argv[1].',
    },
    schema: [],
  },
  create() {
    return {};
  },
};

const noProcessExitInLibrary = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow process.exit() in services/ files — services throw, only bin/ scripts may exit.',
    },
    messages: {
      noExitInService: 'Do not call process.exit() in service/library files. Throw an error and let the caller decide how to exit.',
    },
    schema: [],
  },
  create() {
    return {};
  },
};

const plugin = {
  meta: {
    name: 'eslint-plugin-pickle',
    version: '0.1.0',
  },
  rules: {
    'promise-token-format': promiseTokenFormat,
    'no-raw-state-write': noRawStateWrite,
    'cli-guard-basename': cliGuardBasename,
    'no-process-exit-in-library': noProcessExitInLibrary,
  },
};

export default plugin;
