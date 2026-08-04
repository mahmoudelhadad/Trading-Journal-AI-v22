/**
 * components/ErrorBoundary.tsx
 *
 * Phase 20B — Production Readiness Fixes (item 3): global React
 * ErrorBoundary.
 *
 * WHY THIS EXISTS: the production audit found that the app had ZERO
 * error boundaries anywhere, which meant a single component-level bug
 * (the Dashboard crash also fixed in this phase) turned into a total,
 * unrecoverable, blank-white-screen application failure. React error
 * boundaries can ONLY be implemented as class components — there is
 * no hook equivalent — so this is necessarily a class component,
 * unlike every other component in this codebase (all function
 * components). This is a React platform requirement, not a stylistic
 * choice or an architectural pattern change.
 *
 * SCOPE: this component does nothing when there is no error — it
 * renders its children unchanged. It only ever becomes visible if a
 * descendant component throws during render, which was previously
 * unrecoverable. The fallback UI intentionally reuses the existing
 * color palette (COLORS) and matches the app's existing visual
 * language — it is a safety net, not a UI redesign.
 *
 * NOT in scope (per "do not redesign the UI" / "do not change
 * business logic"): no error reporting/logging service integration,
 * no retry-without-reload logic, no per-page error boundaries (one
 * global boundary at the app root is the minimal fix for the specific
 * "total app crash" failure mode found in the audit).
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// ─── Component ───────────────────────────────────────────────

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: C.bg, color: C.text, fontFamily: 'inherit', padding: 24,
        }}>
          <div style={{
            maxWidth: 480, textAlign: 'center', background: C.card,
            border: `1px solid ${C.border}`, borderRadius: 12, padding: 32,
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
              Something went wrong
            </div>
            <div style={{ color: C.dim, fontSize: 12, marginBottom: 20, lineHeight: 1.5 }}>
              The application hit an unexpected error and couldn&apos;t continue. Your saved data is
              untouched — reloading the page will return you to the app.
            </div>
            {this.state.error && (
              <div style={{
                background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                padding: 10, marginBottom: 20, textAlign: 'left', overflowX: 'auto',
              }}>
                <code style={{ color: C.red, fontSize: 11 }}>{this.state.error.message}</code>
              </div>
            )}
            <button
              onClick={this.handleReload}
              style={{
                background: C.blue, color: '#fff', border: 'none', borderRadius: 8,
                padding: '10px 24px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
