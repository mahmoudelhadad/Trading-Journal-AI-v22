/**
 * components/auth/AuthGate.tsx
 *
 * Phase 2 (Supabase Authentication) — auth gate rendered around <App/>.
 *
 * SCOPE / ISOLATION: this is the ONLY place the auth layer wraps the
 * existing application. When signed out, it renders one of the three
 * auth screens instead of `children`. When signed in, it renders
 * `children` (<App/>) completely unchanged.
 *
 * Phase 2.1: the temporary floating "email + Log Out" badge this
 * component used to render as a sibling of `children` has been removed.
 * Logout (and the rest of the account menu) now lives inside the app's
 * real header via components/auth/UserMenu.tsx, wired through
 * App.jsx/Header.tsx — see UserMenu.tsx's file header for details. This
 * component no longer needs `user`/`signOut` from useAuth(), only
 * `session`/`loading` for gating.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Spinner } from '@components/ui/Spinner.js';
import { LoginForm } from './LoginForm.js';
import { SignUpForm } from './SignUpForm.js';
import { ForgotPasswordForm } from './ForgotPasswordForm.js';
import { useAuth } from '@hooks/useAuth.js';

type AuthMode = 'login' | 'signup' | 'forgot';

export interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { session, loading } = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: C.bg,
        }}
      >
        <Spinner message="Loading…" />
      </div>
    );
  }

  if (!session) {
    if (mode === 'signup') {
      return <SignUpForm onSwitchToLogin={() => setMode('login')} />;
    }
    if (mode === 'forgot') {
      return <ForgotPasswordForm onSwitchToLogin={() => setMode('login')} />;
    }
    return (
      <LoginForm
        onSwitchToSignUp={() => setMode('signup')}
        onSwitchToForgot={() => setMode('forgot')}
      />
    );
  }

  return <>{children}</>;
}
