/**
 * components/auth/UserMenu.tsx
 *
 * Phase 2.1 — professional avatar + dropdown menu, replacing the
 * temporary floating "email + Log Out" badge that used to live in
 * AuthGate.tsx.
 *
 * SCOPE: presentational, reading `user`/`signOut` from the EXISTING,
 * UNCHANGED useAuth() hook (hooks/useAuth.ts → contexts/AuthContext.tsx
 * → services/supabaseClient.ts — none of those three files are touched
 * by this phase). Contains no trading logic, no LocalStorage access, no
 * calculations.
 *
 * PLACEMENT: rendered inside the app's real top header via a new,
 * optional `userMenu` slot on Header.tsx, wired in from App.jsx. This
 * component does not know or care where it's mounted — it manages only
 * its own open/closed state and reads auth state itself.
 *
 * DISPLAY NAME: Supabase's sign-up flow in this app (SignUpForm.tsx)
 * only collects email/password — there is no name field yet — so
 * `user_metadata` will typically be empty for users created through
 * this app. The avatar/name logic below still checks the common
 * metadata keys (`full_name`, `name`, `display_name`) other Supabase
 * flows (OAuth, dashboard-created users, a future profile-edit screen)
 * populate, falling back to the email — matching the exact "display
 * name if available, otherwise email" requirement, without inventing a
 * profile-editing feature that doesn't exist yet.
 *
 * "Profile" MENU ITEM: there is no profile page anywhere in this
 * codebase (auth is brand new as of Phase 2). `onProfileClick` is an
 * optional prop; the caller (App.jsx) does not currently pass one, so
 * clicking "Profile" today just closes the menu — the item is present
 * to match the required layout, not wired to a real destination yet.
 * "Settings" IS wired by App.jsx to the existing SettingsModal.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { COLORS as C } from '@constants/lists.js';
import { useAuth } from '@hooks/useAuth.js';

// ─── Types ───────────────────────────────────────────────────

export interface UserMenuProps {
  /** Called when "Settings" is clicked. Optional — item still renders without it. */
  onSettingsClick?: () => void;
  /** Called when "Profile" is clicked. Optional — no profile page exists yet (see file header). */
  onProfileClick?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────

const AVATAR_COLORS = [C.blue, C.green, C.purple, C.teal, C.orange, C.pink, C.gold];

/** Small, deterministic string hash — just used to pick a stable avatar color per user. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getDisplayName(user: User | null): string | null {
  if (!user) return null;
  const meta = (user.user_metadata || {}) as Record<string, unknown>;
  const candidates = [meta.full_name, meta.name, meta.display_name];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

// ─── Component ───────────────────────────────────────────────

export function UserMenu({ onSettingsClick, onProfileClick }: UserMenuProps) {
  const { user, signOut } = useAuth();

  // `open` is the logical state; `rendered` stays true slightly longer
  // so the closing transition can play before the menu leaves the DOM.
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      window.clearTimeout(closeTimer.current);
      setRendered(true);
    } else if (rendered) {
      closeTimer.current = window.setTimeout(() => setRendered(false), 160);
    }
    return () => window.clearTimeout(closeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click + Escape; keyboard-accessible (Escape returns
  // focus to the trigger, matching standard menu-button behavior).
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  const closeThen = useCallback(
    (fn?: () => void) => () => {
      setOpen(false);
      fn?.();
    },
    [],
  );

  const handleLogout = closeThen(() => {
    void signOut();
  });

  if (!user) return null;

  const email = user.email ?? '';
  const displayName = getDisplayName(user);
  const initialSource = displayName || email;
  const initial = initialSource ? initialSource.trim().charAt(0).toUpperCase() : '?';
  const avatarColor = AVATAR_COLORS[hashString(user.id || email) % AVATAR_COLORS.length];

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={displayName || email}
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: avatarColor,
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
      >
        {initial}
      </button>

      {rendered && (
        <div
          role="menu"
          aria-label="Account menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 220,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 200,
            overflow: 'hidden',
            transformOrigin: 'top right',
            opacity: open ? 1 : 0,
            transform: open ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(-4px)',
            transition: 'opacity 140ms ease, transform 140ms ease',
          }}
        >
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
            {displayName && (
              <div style={{ color: C.white, fontWeight: 700, fontSize: 12, marginBottom: 2 }}>
                {displayName}
              </div>
            )}
            <div
              style={{
                color: C.dim,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {email}
            </div>
          </div>

          <div style={{ padding: 6 }}>
            <MenuItem icon="👤" label="Profile" onClick={closeThen(onProfileClick)} />
            <MenuItem icon="⚙" label="Settings" onClick={closeThen(onSettingsClick)} />
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, padding: 6 }}>
            <MenuItem icon="🚪" label="Logout" onClick={handleLogout} danger />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Menu item ───────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'none',
        border: 'none',
        borderRadius: 6,
        padding: '8px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
        color: danger ? C.red : C.text,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = C.row;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'none';
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>
      {label}
    </button>
  );
}
