import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import hornetSwarm from './eslint-rules/hornet-swarm-rules.js';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'images/**', '**/.past-*/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    plugins: { 'hornet-swarm': hornetSwarm },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/core/src/secure-fs.ts'],
    rules: {
      'hornet-swarm/secure-fs-only': 'error',
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/core/src/redactor.ts'],
    rules: {
      'hornet-swarm/sealed-artifacts-only': 'error',
    },
  },
  {
    files: ['packages/report/src/**/*.ts', 'packages/runner/src/**/*.ts', 'packages/controller/src/audit.ts'],
    rules: {
      'hornet-swarm/sealed-artifacts-only': ['error', { forbidUnsealedWriters: true }],
    },
  },
  {
    files: ['test/**/*.{ts,js,mjs}'],
    ignores: ['test/fixture-app/**'],
    rules: {
      'hornet-swarm/no-live-hosts-in-tests': 'error',
    },
  },
);
