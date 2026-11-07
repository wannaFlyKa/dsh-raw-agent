// Minimal flat config. The import graph rule is also enforced by scripts/check-imports.mjs.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sdk = {
  name: '@anthropic-ai/claude-agent-sdk',
  message: 'Only packages/backend-claude may import the Claude Agent SDK (rule 13).',
};
const backend = {
  name: '@dsh-raw-agent/backend-claude',
  message: 'Only packages/plugin may import backend-claude (D80).',
};
const dshRuntime = {
  group: ['@deepseek-ai/*', 'cordis', '@cordisjs/*'],
  message: 'DSH and Cordis are type-only imports (D65).',
  allowTypeImports: true,
};

export default tseslint.config(
  { ignores: ['**/lib/**', '**/dist/**', '**/node_modules/**', 'research/**', '.dsh-dev/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { paths: [sdk, backend], patterns: [dshRuntime] }],
    },
  },
  {
    // The sample plugin: a browser client in DSH's module-loader format, plain JavaScript.
    files: ['examples/**/client.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/backend-claude/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [dshRuntime] }] },
  },
  {
    files: ['packages/plugin/**'],
    rules: { 'no-restricted-imports': ['error', { paths: [sdk], patterns: [dshRuntime] }] },
  },
);
