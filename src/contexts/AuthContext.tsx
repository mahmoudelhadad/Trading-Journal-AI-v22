/**
 * contexts/AuthContext.tsx
 *
 * Phase 2 (Supabase Authentication) — AuthProvider + auth state.
 *
 * NEW, additive layer. Follows the same lazy-init/effect-driven pattern
 * already used by every hook in hooks/ (see e.g. useAccounts.ts), but as
 * a Context rather than a standalone hook, since auth state must be
 * shared between the auth gate (components/auth/AuthGate.tsx) and any
 * future consumer without threading it through prop drilling.
 *
 * SCOPE: manages the Supabase auth session (sign in / sign up / sign
 * out / password reset / session persistence). It does not read or
 * write any localStorage key used by the existing app's business data
 * directly (trades, accounts, lists, settings, etc.) — those remain
 * owned by their own hooks. See MIGRATION_NOTES.md for the existing
 * storage architecture.
 *
 * SESSION PERSISTENCE: handled entirely by the Supabase client itself
 * (supabase-js persists the session to its own localStorage key,
 * `sb-<project-ref>-auth-token`, distinct from every `fxj_v4_*` /
 * `fxj_prop_rules` key already in use). This provider just mirrors that
 * session into React state via getSession() on mount and
 * onAuthStateChange() for subsequent changes (sign in elsewhere, token
 * refresh, sign out, etc.).
 *
 * Phase 5d — SYNC_ARCHITECTURE_SPEC.md §6.3/§3.5: this is also now the
 * single place that starts/stops the Sync Engine, gated behind
 * `isSyncEngineEnabled()` (services/syncEngineSetup.ts). §6.3's "App
 * start, after auth resolves" trigger is exactly `loading` becoming
 * false with a non-null `session`. §3.5's sign-out sequence is
 * implemented to the extent the current, already-approved architecture
 * supports without adding new infrastructure — see the effect below
 * for the precise, disclosed limitation on steps 1–2.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@services/supabaseClient.js';
import { startSyncEngine, stopSyncEngine, startLeaderElection, stopLeaderElection } from '@sync/syncEngine.js';
import { buildSyncEngineDependencies, isSyncEngineEnabled, isStorageCutoverEnabled } from '@services/syncEngineSetup.js';
import { runStorageCutover } from '@services/storageCutover.js';

/**
 * §13 Step 6's cutover, as a leader callback.
 *
 * DECLARED AT MODULE SCOPE, DELIBERATELY: `startLeaderElection` dedupes
 * registrations by function REFERENCE (src/sync/syncEngine.ts), and this
 * provider's effect re-runs whenever the Supabase `session` object
 * identity changes — which it does on every token refresh. An inline
 * arrow would be a new reference each time and would register (and run)
 * the cutover again on every refresh; a stable module-scope reference
 * makes re-registration a genuine no-op.
 *
 * Errors are swallowed by `runStorageCutover` itself, which always
 * returns a result object and never throws (services/storageCutover.ts).
 * A non-completing outcome leaves the marker unwritten, so the cutover
 * simply retries on the next load — §13 Step 6 sub-step 5.
 */
async function runCutoverAsLeader(): Promise<void> {
  await runStorageCutover();
}

// ─── Types ───────────────────────────────────────────────────

export interface AuthResult {
  error: string | null;
}

export interface AuthContextValue {
  /** Current Supabase session, or null when signed out. */
  session: Session | null;
  /** Convenience accessor — session?.user ?? null */
  user: User | null;
  /** True until the initial session lookup (getSession()) resolves. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<AuthResult>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ─── Provider ────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setLoading(false);
      })
      .catch(() => {
        // Initial session lookup failed (e.g. network error). Fall back to
        // signed-out rather than leaving `loading` true forever — the
        // existing login screen (AuthGate.tsx) is the safe default.
        if (!mounted) return;
        setSession(null);
        setLoading(false);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // §6.3 "App start, after auth resolves" trigger / §3.5 sign-in and
  // sign-out sequences. Gated behind the §13 Step 5 rollout flag.
  //
  // KNOWN, DISCLOSED LIMITATION (per explicit decision — do not extend
  // without separate approval): §3.5's sign-out sequence has 5 steps.
  // This effect implements ONLY:
  //   - step 3 (release leadership, cancel timers/listeners) —
  //     stopSyncEngine(), already built for this (§5.4).
  //   - step 4 (reset in-memory state) — a consequence of step 3.
  //   - step 5 (never touch the local DB) — nothing here does.
  // It does NOT implement:
  //   - step 1 (abort in-flight requests, and guarantee any response
  //     arriving after sign-out begins is discarded without effect on
  //     syncStatus/baseUpdatedAt/cursor). No cancellation/abort
  //     mechanism exists anywhere in PushTransport, PullTransport, or
  //     the LocalStore layer, and adding one is explicitly out of
  //     scope for this phase.
  //   - step 2 (revert every record stuck in `syncing`).
  //     runStartupReconciliation() (scheduler.ts, §6.1) performs
  //     exactly this rule, but it is deliberately NOT called here: that
  //     function is a startup concern, owned by the Scheduler's own
  //     "first cycle after becoming leader" orchestration — calling it
  //     directly from this sign-out path would hand this file a
  //     responsibility (deciding when reconciliation runs) that
  //     belongs to the Scheduler, which is a behavior change beyond
  //     this phase's approved scope, not merely a reuse of an existing
  //     function.
  // Practical consequence of both gaps: a push or pull already in
  // flight when sign-out begins can still complete afterward and write
  // its result, and any record left in `syncing` from an interrupted
  // request is only cleaned up the next time a tab becomes leader
  // (startup reconciliation), not immediately at sign-out. See
  // MIGRATION_NOTES.md AN-015 for the full writeup.
  // PHASE 6g-2 — the §13 Step 6 storage cutover is wired here too, behind
  // its OWN flag, fully independent of the Sync Engine's:
  //
  //   - Both gates are satisfied exactly here. Sub-step 0 requires the
  //     cutover to run "only once an authenticated `user_id` is
  //     available" (that is `session` being non-null below) and to be
  //     "leader-only... elected by the same Web Lock that governs
  //     ongoing sync" (that is `startLeaderElection`, which shares the
  //     single `coordinatorStart`/lock name — src/sync/syncEngine.ts).
  //   - REGISTRATION ORDER IS LOAD-BEARING: the cutover registers BEFORE
  //     `startSyncEngine`, and leader callbacks run in registration
  //     order, each awaited before the next. So the cutover settles
  //     before the engine's first push/pull cycle — required, because
  //     the engine must not read local data until the resolver's backend
  //     decision is final.
  //   - Enabling the cutover does NOT enable cloud sync, and vice versa.
  //     With only `VITE_STORAGE_CUTOVER_ENABLED` set, leader election
  //     runs and the cutover executes, but no Scheduler, timer, listener,
  //     or network request is ever created.
  //   - Sign-out tears down both. `stopSyncEngine()` internally calls
  //     `stopLeaderElection()`, but it early-returns when the engine was
  //     never started — so the explicit call after it is what covers the
  //     cutover-only configuration. Both are idempotent.
  useEffect(() => {
    if (loading) return;
    const cutoverEnabled = isStorageCutoverEnabled();
    const syncEnabled = isSyncEngineEnabled();
    if (!cutoverEnabled && !syncEnabled) return;

    if (session) {
      if (cutoverEnabled) startLeaderElection({ onBecameLeader: runCutoverAsLeader });
      if (syncEnabled) startSyncEngine(buildSyncEngineDependencies());
    } else {
      stopSyncEngine();
      stopLeaderElection();
    }
  }, [session, loading]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    // emailRedirectTo mirrors sendPasswordReset() below, so the emailed
    // confirmation link always returns to this deployed app instead of
    // falling back to the Supabase project's dashboard-configured default.
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
    return { error: error ? error.message : null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const sendPasswordReset = useCallback(async (email: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + import.meta.env.BASE_URL,
    });
    return { error: error ? error.message : null };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    loading,
    signIn,
    signUp,
    signOut,
    sendPasswordReset,
  }), [session, loading, signIn, signUp, signOut, sendPasswordReset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Consumer helper ─────────────────────────────────────────
// Exported so hooks/useAuth.ts can wrap it without duplicating the
// context-presence check.

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within an <AuthProvider>.');
  }
  return ctx;
}
