/**
 * components/auth/ForgotPasswordForm.tsx
 *
 * Phase 2 (Supabase Authentication) — password reset request screen.
 * Presentational + a thin call into useAuth().sendPasswordReset(); no
 * business logic, no trade/account/list/settings state touched.
 *
 * SCOPE: this screen only requests the reset email (Supabase's
 * resetPasswordForEmail). Handling the reset-link redirect itself (the
 * page a user lands on after clicking the emailed link, where they'd
 * set a new password) is a separate concern outside Phase 2's "Login /
 * Sign Up / Forgot Password / Logout / session persistence / auth gate"
 * scope and is not implemented here.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { FormField } from '@components/ui/FormField.js';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from '@hooks/useAuth.js';

export interface ForgotPasswordFormProps {
  onSwitchToLogin: () => void;
}

export function ForgotPasswordForm({ onSwitchToLogin }: ForgotPasswordFormProps) {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Enter your email.');
      return;
    }

    setSubmitting(true);
    const { error: resetError } = await sendPasswordReset(email.trim());
    setSubmitting(false);

    if (resetError) {
      setError(resetError);
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <AuthLayout title="Check your email">
        <div style={{ color: C.text, fontSize: 12, lineHeight: 1.6, marginBottom: 16 }}>
          If an account exists for <strong style={{ color: C.white }}>{email.trim()}</strong>,
          we&apos;ve sent a password reset link.
        </div>
        <Button variant="primary" fullWidth onClick={onSwitchToLogin}>
          Back to Log In
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset Password" subtitle="We'll email you a reset link">
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

        {error && (
          <div style={{ color: C.red, fontSize: 11, marginBottom: 10 }}>{error}</div>
        )}

        <Button type="submit" variant="primary" fullWidth disabled={submitting} style={{ marginTop: 4 }}>
          {submitting ? 'Sending…' : 'Send Reset Link'}
        </Button>
      </form>

      <div style={{ textAlign: 'center', marginTop: 14 }}>
        <button type="button" onClick={onSwitchToLogin} style={linkStyle}>
          Back to Log In
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
