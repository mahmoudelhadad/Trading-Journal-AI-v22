/**
 * components/auth/LoginForm.tsx
 *
 * Phase 2 (Supabase Authentication) — email/password login screen.
 * Presentational + a thin call into useAuth().signIn(); no business
 * logic, no trade/account/list/settings state touched.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { FormField } from '@components/ui/FormField.js';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from '@hooks/useAuth.js';

export interface LoginFormProps {
  onSwitchToSignUp: () => void;
  onSwitchToForgot: () => void;
}

export function LoginForm({ onSwitchToSignUp, onSwitchToForgot }: LoginFormProps) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setSubmitting(true);
    const { error: signInError } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (signInError) setError(signInError);
  };

  return (
    <AuthLayout title="Log In" subtitle="Sign in to your trading journal">
      <form onSubmit={handleSubmit}>
        <FormField label="Email">
          <Input
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoFocus
          />
        </FormField>

        <FormField label="Password">
          <Input type="password" value={password} onChange={setPassword} placeholder="••••••••" />
        </FormField>

        {error && (
          <div style={{ color: C.red, fontSize: 11, marginBottom: 10 }}>{error}</div>
        )}

        <Button type="submit" variant="primary" fullWidth disabled={submitting} style={{ marginTop: 4 }}>
          {submitting ? 'Signing in…' : 'Log In'}
        </Button>
      </form>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
        <button type="button" onClick={onSwitchToForgot} style={linkStyle}>
          Forgot password?
        </button>
        <button type="button" onClick={onSwitchToSignUp} style={linkStyle}>
          Create an account
        </button>
      </div>
    </AuthLayout>
  );
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: C.blue,
  fontSize: 11,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
};
