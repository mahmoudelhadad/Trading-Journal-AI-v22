import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// ── ROOT CAUSE FIX (build-verification pass, revision 4) ─────────
//
// Throughout this project, every import consistently uses the
// TypeScript-ESM convention of writing a `.js` extension in the
// specifier even when the real source file is `.ts`/`.tsx` (e.g.
// `import { DashboardPage } from '@pages/Dashboard.js'`, where the
// real file is `Dashboard.tsx`). This is intentional and matches
// tsconfig.json's `"moduleResolution": "bundler"` +
// `"allowImportingTsExtensions": true` — `tsc --noEmit` and Vite's
// dev server both resolve this correctly.
//
// NARROWED ROOT CAUSE (confirmed across 4 real production build
// attempts): every single failure so far — Dashboard.js, Raw.js,
// AppShell.js, ErrorBoundary.js — has been an ALIASED import
// (`@pages/...`, `@components/...`). None has been a plain relative
// import (`./Foo.js`), even though 35 such relative `.js`-to-`.tsx`
// mismatches also exist in this codebase — evidence that Vite's
// native resolver already handles plain relative extension-fallback
// correctly on its own. The problem is narrower than originally
// scoped: it is specifically that `resolve.alias` substitution
// produces an exact, already-`.js`-extended absolute path, and once a
// specifier has an explicit extension, nothing downstream tries
// `.tsx`/`.ts` as a fallback.
//
// REVISION HISTORY (kept for anyone debugging this later):
//   Rev 1: hand-rolled alias matching + manual path string
//          concatenation. Bug: string concatenation (not path.join)
//          produces a mixed-separator path on Windows. Fixed
//          Dashboard.js only.
//   Rev 2: delegated to Rollup's `this.resolve(...)` API from within
//          a `resolveId` hook. Fixed Dashboard.js AND Raw.js, but
//          failed on AppShell.js — most likely a Rollup lifecycle
//          subtlety around re-entrant resolve() calls that could not
//          be fully verified from source alone.
//   Rev 3: removed the this.resolve() dependency, went back to
//          direct, synchronous fs.existsSync() checks with the
//          path-joining bug properly fixed and a single shared alias
//          map. This should have been fully deterministic and was
//          exhaustively tested against all 356 real imports in an
//          isolated harness — yet the real build still failed, this
//          time on ErrorBoundary.js, even earlier in the module graph
//          (4 modules in, versus 10-12 before). The most likely
//          explanation: Vite does not `import()` vite.config.js
//          directly — it bundles it through esbuild first via its own
//          `loadConfigFromFile`, and a custom plugin object built at
//          module scope is a meaningfully different execution context
//          than a plain isolated Node harness importing the same file
//          directly. Three custom-plugin revisions in a row each
//          having a different, hard-to-verify failure mode is itself
//          signal: a hand-written resolveId plugin is the wrong tool
//          here, not just imperfectly implemented.
//   Rev 4 (this version): removes ALL custom plugin code. Uses ONLY
//          Vite's own native, first-class `resolve.alias` array form
//          with regex `find` patterns — a documented, heavily-used
//          Vite/Rollup mechanism (wraps @rollup/plugin-alias, which
//          every Vite project already depends on transitively).
//          For each alias, a regex entry matches ONLY `.js`-suffixed
//          specifiers under that alias and rewrites them to the SAME
//          path with the extension stripped — handing an extensionless
//          specifier to Vite's native resolver, which already
//          correctly tries `.tsx`, `.ts`, `.js`, `.jsx` in order (this
//          is standard, default Vite behavior for extensionless
//          specifiers, not something this config invents). The
//          original plain-string alias entries remain, for anything
//          NOT ending in `.js` under these prefixes (there is no
//          custom code left that could have its own bugs — only
//          configuration, evaluated by Vite's own tested alias
//          plugin).
//
// This is a config-only change. No application source file's import
// statements were touched, and the project's `.js`-in-imports
// convention is completely unchanged — only how the ALIAS PORTION of
// those specifiers is substituted.

const srcDir = path.resolve(__dirname, './src');

// ── v1.1 release/build identification ────────────────────────────
// package.json is the SINGLE source of the semantic version — no second
// constant to keep in sync. Vite loads this config as CommonJS (this file
// already relies on `__dirname`), so `require` is available here.
//
// Commit resolution, in order:
//   1. GITHUB_SHA — set automatically by GitHub Actions. Public build
//      metadata, not a secret, and requires no runtime GitHub API call.
//   2. local `git rev-parse --short HEAD` — development convenience only,
//      wrapped so a missing/!git environment can never fail the build.
//   3. 'dev'.
const pkg = require('./package.json');

function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const aliasNames = [
  'components', 'pages', 'hooks', 'services',
  'calculations', 'constants', 'contexts', 'apptypes', 'sync',
];

const aliasEntries = [];
for (const name of aliasNames) {
  const dir = name === 'apptypes' ? 'types' : name;
  const target = path.join(srcDir, dir);
  // .js-stripping regex entry — MUST come before the plain entry
  // below, since Vite/@rollup/plugin-alias tries `alias` array
  // entries in order and uses the first match.
  aliasEntries.push({
    find: new RegExp(`^@${name}/(.*)\\.js$`),
    replacement: `${target}/$1`,
  });
  // Plain entry — unchanged from before, for any non-.js-suffixed
  // usage under this prefix.
  aliasEntries.push({ find: `@${name}`, replacement: target });
}
// Catch-all '@' — checked last, since it's a prefix of every alias
// above; same .js-stripping-then-plain pattern.
aliasEntries.push({ find: /^@\/(.*)\.js$/, replacement: `${srcDir}/$1` });
aliasEntries.push({ find: '@', replacement: srcDir });

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Compile-time constants — see resolveCommit() above.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(resolveCommit()),
  },

  // Base path for GitHub Pages deployment.
  //
  // Release Hardening (H-2): this was previously '/Trading-Journal-AI/',
  // inherited unchanged from this repository's first commit. That path is
  // stale — the repository that owned the `Trading-Journal-AI` name was
  // renamed to `Trading-Journal-AI-v1`, so the old URL 404s and its slot
  // now belongs to a different app. This repository had no GitHub Pages
  // deployment at all (Settings → Pages: disabled, Branch: None).
  //
  // Frozen production target: project-pages site of THIS repository,
  // deployed by .github/workflows/deploy.yml.
  // Matches: https://mahmoudelhadad.github.io/Trading-Journal-AI-v22/
  //
  // NOTE: contexts/AuthContext.tsx builds the Supabase auth redirect from
  // `window.location.origin + import.meta.env.BASE_URL`, so this value
  // determines the redirect URL that must be allow-listed in Supabase.
  base: '/Trading-Journal-AI-v22/',

  resolve: {
    alias: aliasEntries,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        manualChunks: {
          react: ['react', 'react-dom'],
          recharts: ['recharts'],
          xlsx: ['xlsx'],
        },
      },
    },
  },
});
