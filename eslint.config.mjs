// ESLint flat config for godot-mcp-runtime.
//
// Architectural rules of note for this codebase:
// - no-console with allow ["error", "warn"]: stdout is reserved for the MCP
//   stdio transport. A stray console.log corrupts the protocol. All operational
//   logging goes to stderr via console.error / logError / logDebug.
// - import/no-default-export: codebase uses named exports throughout for
//   grep-ability and refactor safety.
// - eslint-comments/require-description: every eslint-disable must justify
//   itself, so suppressions are visible during review.
//
// Unencodable architectural constraints (documented in CONTRIBUTING.md):
// - All mutation operations auto-save scenes (runtime invariant in
//   godot_operations.gd; cannot be enforced statically).
// - Path-traversal protection lives in validateProjectArgs / validateSceneArgs.
//   Handlers must use them rather than constructing paths ad hoc.
// - Error responses use createErrorResponse, not raw throws.
// - TypeScript uses camelCase, GDScript uses snake_case;
//   normalizeParameters / convertCamelToSnakeCase bridge them.

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.test-project/**', 'tests/fixtures/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      '@eslint-community/eslint-comments': eslintComments,
    },
    rules: {
      // Sensible TS defaults
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',

      // MCP stdio invariant: stdout is the transport. console.log corrupts the
      // protocol. Use console.error / logError / logDebug for all server output.
      'no-console': ['error', { allow: ['error', 'warn'] }],

      // Named exports throughout the codebase.
      'import/no-default-export': 'error',

      // Forbid drive-by suppression.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',

      // General hygiene
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    // index.ts is the bin entry — main module, not imported. No default export needed but allow if added.
    files: ['src/index.ts'],
    rules: {
      'no-console': 'off', // entry point bootstrapping uses console.error directly
    },
  },
  {
    // Test files: relax some rules.
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Config files conventionally export default — vitest, prettier, etc. expect it.
    files: ['*.config.ts', '*.config.mjs', '*.config.js'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  // Prettier compatibility: turn off rules that conflict with the formatter.
  prettierConfig,
];
