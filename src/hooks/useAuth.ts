/**
 * hooks/useAuth.ts
 *
 * Phase 2 (Supabase Authentication) — public auth hook.
 *
 * Thin re-export of contexts/AuthContext.tsx's useAuthContext(), kept as
 * its own hooks/ file so auth is consumed the same way every other piece
 * of app state is (`import { useAuth } from '@hooks/useAuth.js'`),
 * matching this codebase's existing hook conventions. Contains zero
 * logic of its own — see AuthContext.tsx for the actual implementation.
 *
 * NOT added to hooks/index.ts's barrel export: that barrel is
 * consumed by pages/components that receive data purely via props from
 * App.jsx (see MIGRATION_NOTES.md), a pattern this auth layer
 * deliberately sits outside of — auth is consumed only by
 * components/auth/*. Leaving the existing barrel untouched avoids any
 * risk to its current exports.
 */

export { useAuthContext as useAuth } from '@contexts/AuthContext.js';
export type { AuthContextValue, AuthResult } from '@contexts/AuthContext.js';
