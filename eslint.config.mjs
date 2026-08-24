// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the whole monorepo.
 *
 * The rules below are not stylistic preferences — they encode §7 QUALITY BAR:
 * no `any`, no unjustified non-null assertions, and no floating promises (which
 * in an event-ingest hot path silently drop data).
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // §7: "no `any`".
      '@typescript-eslint/no-explicit-any': 'error',
      // §7: "no non-null assertions without a comment justifying them".
      // ESLint cannot check for the comment, so the rule bans them outright and
      // the rare justified case must use an explicit `eslint-disable-next-line`
      // with the justification on the same line — which is exactly the comment.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSUnknownKeyword',
          message:
            'Do not cast through `unknown` to defeat the type checker; parse with zod instead.',
        },
      ],
    },
  },
  {
    // The adaptive package is pure maths: allow the bitwise operators the PRNG needs.
    files: ['packages/adaptive/**/*.ts'],
    rules: {
      'no-bitwise': 'off',
    },
  },
  {
    // Repo-level config files and Node scripts are outside every package tsconfig,
    // so type-aware rules cannot run on them. Linting them without type information
    // is better than not linting them, and far better than widening a tsconfig to
    // include files that are not part of any build.
    files: ['*.mjs', '*.ts', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      // Declared explicitly rather than pulling in the `globals` package for two names.
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
