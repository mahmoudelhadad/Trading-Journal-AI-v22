/**
 * components/ui/ConfirmDialog.tsx
 *
 * v1.4 — App-Owned Confirmation Reliability.
 *
 * A destructive/irreversible action's confirmation, rendered by the
 * application itself instead of by `window.confirm`.
 *
 * WHY THIS EXISTS: every destructive flow in the app used to bind the
 * user's decision to `window.confirm`, a host-controlled primitive the
 * browser is free to suppress (a prior "prevent this page from creating
 * additional dialogs" opt-out, a sandboxed frame, an unactivated frame,
 * some automation/enterprise contexts). When suppressed it returns
 * `false` immediately without rendering, and every call site read that
 * as "the user cancelled" — so a capability failure was indistinguish-
 * able from a decision, and Delete silently did nothing. This component
 * removes that ambiguity: the decision is ordinary React state.
 *
 * SCOPE: this is NOT a destructive-action framework. It replaces the
 * six `window.confirm` call sites migrated in v1.4 (pages/Raw.tsx,
 * components/trade/TradeTable.tsx, components/trade/RecoveryBinPanel.tsx)
 * and nothing else. No provider, no context, no portal, no
 * promise-returning `confirm()` shim, no registry.
 *
 * COMPOSITION: reuses the existing Modal + Button atoms and the existing
 * COLORS palette — no new visual language and no new dependency. The
 * shape is lifted from the confirmation that already shipped inside
 * components/backtest/BacktestResultsList.tsx (Modal + secondary Cancel
 * + danger Confirm); that caller is deliberately NOT migrated here.
 *
 * RENDER MODEL: caller-conditional only. There is no `open` prop —
 * callers render `{pending !== null && <ConfirmDialog .../>}`, matching
 * every other Modal consumer in the codebase, so "not open" is
 * structurally unrepresentable rather than a boolean to get wrong.
 *
 * Z-INDEX: 400, passed through Modal's EXISTING `zIndex` prop (Modal is
 * not modified). Sites 4-6 open inside SettingsModal, itself a Modal at
 * the default 300, so the confirmation must paint above it. A backdrop
 * click on this dialog does not close the Settings modal underneath:
 * Modal's handler tests `e.target === e.currentTarget`, and for the
 * outer modal the target is this inner overlay, so the test fails.
 *
 * No Escape handling — that would require changing the shared Modal,
 * which v1.4 does not authorize. Cancel is the explicit button plus
 * Modal's existing backdrop click.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from './Modal.js';
import { Button } from './Button.js';

// ─── Types ───────────────────────────────────────────────────

export interface ConfirmDialogProps {
  /** The question being confirmed, e.g. "Delete this trade?" */
  title:           string;
  /**
   * Supporting sentence — what happens, and whether it can be undone.
   * OPTIONAL: flows whose historical wording is a single sentence omit
   * it entirely, and when omitted NO element is rendered in its place.
   */
  message?:        string;
  /** Explicit verb for the confirming action. Never "OK". */
  confirmLabel:    string;
  onConfirm:       () => void;
  /** Also invoked by a backdrop click, via Modal's existing behavior. */
  onCancel:        () => void;
  /**
   * `danger` for destructive actions (the default).
   *
   * `primary` exists only because Restore All is ADDITIVE — it returns
   * trades to the journal. Native `confirm` carried no severity styling
   * at all, so painting that button red would invent a semantic the app
   * never had. Reuses the existing ButtonVariant vocabulary rather than
   * introducing a separate severity concept.
   */
  confirmVariant?: 'danger' | 'primary';
}

// ─── Component ───────────────────────────────────────────────

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  confirmVariant = 'danger',
}: ConfirmDialogProps) {
  return (
    <Modal onClose={onCancel} zIndex={400}>
      <div
        style={{
          background:   C.card,
          border:       `1px solid ${C.border}`,
          borderRadius: 12,
          width:        '100%',
          maxWidth:     420,
          marginTop:    16,
          padding:      18,
        }}
      >
        <div style={{ color: C.white, fontSize: 13, fontWeight: 700 }}>
          {title}
        </div>

        {/* Ternary, not `message && ...`: an empty-string message must
            not render an empty text node either. */}
        {message ? (
          <div style={{ color: C.text, fontSize: 11, marginTop: 8 }}>
            {message}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant={confirmVariant} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
