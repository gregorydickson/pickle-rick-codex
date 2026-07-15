import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pickle from './eslint-plugin-pickle/index.js';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { pickle },
    rules: {
      'pickle/promise-token-format': 'warn',
      'pickle/no-raw-state-write': 'warn',
      'pickle/cli-guard-basename': 'warn',
      'pickle/no-process-exit-in-library': 'warn',
    },
  },
  {
    ignores: ['bin/**', 'services/**', 'types/**', 'tests/**', '*.js', 'src/**/*.js', 'eslint.config.js', 'eslint-plugin-pickle/**'],
  },
);
