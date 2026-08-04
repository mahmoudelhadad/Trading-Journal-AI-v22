/**
 * components/auth/AuthLayout.tsx
 *
 * Phase 2 (Supabase Authentication) — shared centered-card shell used by
 * LoginForm / SignUpForm / ForgotPasswordForm. Purely presentational —
 * reuses the existing COLORS palette and Card primitive
 * (components/ui/Card.tsx) so the auth screens match the app's existing
 * visual language, the same approach already used by ErrorBoundary.tsx.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';

export interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        padding: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div
            style={{
              width: 48,
              height: 48,
              margin: '0 auto 10px',
              borderRadius: 10,
              background: 'linear-gradient(135deg,#1E3A6E,#0D2344)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
            }}
          >
            📈
          </div>
          <div style={{ color: C.white, fontWeight: 800, fontSize: 18 }}>Trading Journal</div>
        </div>

        <Card>
          <div style={{ color: C.white, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{title}</div>
          {subtitle && (
            <div style={{ color: C.dim, fontSize: 11, marginBottom: 16 }}>{subtitle}</div>
          )}
          {!subtitle && <div style={{ marginBottom: 10 }} />}
          {children}
        </Card>
      </div>
    </div>
  );
}
