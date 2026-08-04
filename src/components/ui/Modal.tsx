/**
 * components/ui/Modal.tsx
 *
 * Full-screen overlay with backdrop-click-to-close.
 * Matches original Modal(p) function exactly:
 *   h("div", { onClick: e => { if (e.target === e.currentTarget) p.onClose(); },
 *     style: { position:"fixed", inset:0, background:"#00000099", zIndex:300,
 *              display:"flex", alignItems:"flex-start", justifyContent:"center",
 *              overflowY:"auto", padding:"16px" } }, p.children)
 *
 * Phase 3 — presentational only.
 */

import React from 'react';

export interface ModalProps {
  onClose:   () => void;
  children:  React.ReactNode;
  /** z-index override — default matches original (300) */
  zIndex?:   number;
  /** Padding around the inner panel */
  padding?:  number;
}

export function Modal({ onClose, children, zIndex = 300, padding = 16 }: ModalProps) {
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position:       'fixed',
        inset:          0,
        background:     '#00000099',
        zIndex,
        display:        'flex',
        alignItems:     'flex-start',
        justifyContent: 'center',
        overflowY:      'auto',
        padding,
      }}
    >
      {children}
    </div>
  );
}
