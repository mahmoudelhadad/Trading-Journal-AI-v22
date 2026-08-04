// vitest.config.ts
//
// Gap-analysis G-2 (Backtesting Foundation readiness) — establishes
// the project's first automated test runner. Reuses vite.config.js's
// alias map directly rather than redeclaring it, so `@calculations/*`
// etc. resolve identically in tests and in the app; there is exactly
// one place that decides what those aliases mean.
//
// Scope: `environment: 'node'` — the calculation layer under test
// (src/calculations/) is pure, dependency-free, DOM-free (verified in
// the gap analysis: zero imports from services/, hooks/, components/,
// pages/, contexts/, or sync/). A jsdom environment is unnecessary
// until component tests are added, which is not part of this change.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }),
);
