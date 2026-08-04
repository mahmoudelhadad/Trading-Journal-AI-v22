/**
 * services/supabaseClient.ts
 *
 * Phase 2 (Supabase Authentication) — Supabase client singleton.
 *
 * SCOPE: this file ONLY constructs and exports the Supabase client used
 * for authentication. It does not read or write any trade/account/list/
 * settings data, and it is never imported by storage.js or any hook
 * that manages LocalStorage-backed state. It is a completely new,
 * additive dependency of the auth layer only (contexts/AuthContext.tsx).
 *
 * CONFIGURATION: reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from
 * the environment (Vite exposes .env.local at build/dev time). Both are
 * required — see .env.example for the expected shape. Intentionally
 * does NOT throw at module scope if they're missing/placeholder values:
 * createClient() itself does not make a network call, so an invalid or
 * placeholder key only surfaces as an error from the actual auth call
 * (sign in / sign up / etc.), which the auth forms already display to
 * the user. Throwing here would crash the whole app via ErrorBoundary
 * before the user ever sees a usable error message.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.error(
    'Supabase environment variables are missing. Set VITE_SUPABASE_URL and ' +
    'VITE_SUPABASE_ANON_KEY in .env.local (see .env.example). Auth calls will fail until this is fixed.',
  );
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '');
