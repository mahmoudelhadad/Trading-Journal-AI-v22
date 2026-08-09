/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// v1.1 build identification — substituted at build time by vite.config.js's
// `define`. Not environment variables and not secrets: the version comes
// from package.json and the commit from GITHUB_SHA (or a local git lookup).
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
