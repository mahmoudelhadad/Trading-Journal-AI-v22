// vitest.config.ts
//
// Gap-analysis G-2 (Backtesting Foundation readiness) — establishes
// the project's first automated test runner. Reuses vite.config.js's
// alias map directly rather than redeclaring it, so `@calculations/*`
// etc. resolve identically in tests and in the app; there is exactly
// one place that decides what those aliases mean.
//
// Scope: the global `environment: 'node'` stays, because the calculation,
// service, and hook suites are DOM-free. Component tests opt into jsdom
// per file with a `// @vitest-environment jsdom` docblock, so no suite pays
// for a DOM it does not need. Both `.test.ts` and `.test.tsx` are collected.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
      ],
    },
  }),
);
