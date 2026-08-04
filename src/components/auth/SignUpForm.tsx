/**
 * components/auth/SignUpForm.tsx
 *
 * Phase 2 (Supabase Authentication) — email/password sign-up screen.
 * Presentational + a thin call into useAuth().signUp(); no business
 * logic, no trade/account/list/settings state touched.
 *
 * By default, a Supabase project requires email confirmation before a
 * new user can sign in (project-level setting, not controlled by this
 * code). signUp() succeeding does not necessarily mean the user is
 * immediately signed in — this form shows a "check your email" message
 * in that case rather than assuming success means an active session.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { FormField } from '@components/ui/FormField.js';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from '@hooks/useAuth.js';

export interface SignUpFormProps {
  onSwitchToLogin: () => void;
}

export function SignUpForm({ onSwitchToLogin }: SignUpFormProps) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('Enter an email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const { error: signUpError } = await signUp(email.trim(), password);
    setSubmitting(false);

    if (signUpError) {
      setError(signUpError);
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <AuthLayout title="Check your email">
        <div style={{ color: C.text, fontSize: 12, lineHeight: 1.6, marginBottom: 16 }}>
          We&apos;ve sent a confirmation link to <strong style={{ color: C.white }}>{email.trim()}</strong>.
          Confirm your address, then log in below.
        </div>
        <Button variant="primary" fullWidth onClick={onSwitchToLogin}>
          Back to Log In
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create Account" subtitle="Start your trading journal">
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
          <Input type="password" value={password} onChange={setPassword} placeholder="At least 6 characters" />
        </FormField>

        <FormField label="Confirm Password">
          <Input type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder="••••••••" />
        </FormField>

        {error && (
          <div style={{ color: C.red, fontSize: 11, marginBottom: 10 }}>{error}</div>
        )}

        <Button type="submit" variant="primary" fullWidth disabled={submitting} style={{ marginTop: 4 }}>
          {submitting ? 'Creating account…' : 'Sign Up'}
        </Button>
      </form>

      <div style={{ textAlign: 'center', marginTop: 14 }}>
        <button type="button" onClick={onSwitchToLogin} style={linkStyle}>
          Already have an account? Log in
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
