// .eslintrc.cjs
//
// Gap-analysis G-2 (Backtesting Foundation readiness) — the `lint`
// script existed in package.json but had no configuration file, so
// `npm run lint` failed immediately with no config found, and its
// `--ext .js,.jsx` scope covered only 9 of 137 source files even if it
// had run. This file makes the existing script actually work, and
// extends it to the TypeScript files that are the overwhelming
// majority of the codebase.
//
// Scope decision: non-type-aware linting only (`plugin:@typescript-
// eslint/recommended`, not the `-requiring-type-checking` / `-type-
// checked` variants). Type-aware linting needs `parserOptions.project`
// wired to tsconfig.json and is a meaningfully larger, separately-
// scoped change (project-wide type-aware rules on a 128-file
// TypeScript codebase that has never been linted before would surface
// an unknown, potentially large number of new findings unrelated to
// this fix). `tsc --noEmit` (the new `typecheck` script) already
// provides full type checking; this config's job is syntax/pattern
// linting (unused vars, hooks rules, obvious bugs), not type checking.
module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: {
    react: { version: 'detect' },
  },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    // TypeScript already enforces this; the base JS rule false-positives
    // on type-only declarations (interfaces, overloads).
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // React 17+ JSX transform (react-jsx) — no React import needed per file.
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    // Matches tsconfig's migration-era allowance (noUnusedLocals off);
    // codebase has extensive `any` at legacy/JS-interop boundaries
    // (storage.js, importService.ts parsing) — tightening this is a
    // separate, deliberate future decision, not a side effect of
    // making `lint` merely run.
    '@typescript-eslint/no-explicit-any': 'off',
  },
  overrides: [
    {
      // Legacy JS/JSX files predate the TypeScript migration and are
      // not parsed by @typescript-eslint (no TS syntax to parse), but
      // share the same JSX/React rule set.
      files: ['*.js', '*.jsx'],
      parser: 'espree',
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      },
    },
  ],
};
