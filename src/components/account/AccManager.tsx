/**
 * components/account/AccManager.tsx
 *
 * Phase 19 — Integration: Account Manager.
 *
 * MIGRATION GAP FILLED (not "new feature development" — flagged in the
 * Architecture Cleanup audit as L-1: the original app's AccManager
 * component was never migrated in any of Phases 1-18, even though its
 * backing hook, useAccounts() (Phase 2B, addAccount/editAccount/
 * deleteAccount), has existed and been fully validated since Phase 2B).
 * Migrated verbatim from the original single-file app's
 * AccManager(props) component now, because Phase 19 explicitly requires
 * "wire account management" to be reachable, and no UI existed to wire.
 *
 * Every workflow (add account, inline edit, color picker, delete with
 * the "at least 1 account must remain" guard) is preserved exactly.
 * Reuses Modal, FormField, Input, Divider, SectionHeader UI atoms
 * (Phase 3) — no new visual language introduced.
 */

import React, { useState } from 'react';
import { COLORS as C, ACCOUNT_COLORS } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { FormField } from '@components/ui/FormField.js';
import { Input } from '@components/ui/Input.js';
import { Divider } from '@components/ui/Divider.js';
import { SectionHeader } from '@components/ui/SectionHeader.js';
import type { Account, AccountContent } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface AccManagerProps {
  accounts: Account[];
  // AccountContent, not Account — this component only ever constructs
  // a plain business-fields object (no sync identity yet); useAccounts'
  // addAccount/editAccount are what actually stamp/merge it.
  onAdd:    (account: AccountContent) => void;
  onEdit:   (account: AccountContent) => void;
  onDelete: (id: string) => void;
  onClose:  () => void;
}

interface EditState {
  id:      string;
  name:    string;
  capital: string;
  color:   string;
}

// ─── Component ───────────────────────────────────────────────

export function AccManager({ accounts, onAdd, onEdit, onDelete, onClose }: AccManagerProps) {
  const [form, setForm] = useState({ name: '', capital: '10000', color: '#3B82F6' });
  const [editing, setEditing] = useState<EditState | null>(null);

  function setField(k: keyof typeof form) {
    return (v: string) => setForm((p) => ({ ...p, [k]: v }));
  }
  function setEditField(k: keyof EditState) {
    return (v: string) => setEditing((p) => (p ? { ...p, [k]: v } : p));
  }

  function addAcc() {
    if (!form.name.trim() || !form.capital) return;
    onAdd({ id: 'acc_' + Date.now(), name: form.name.trim(), capital: parseFloat(form.capital) || 10000, color: form.color });
    setForm({ name: '', capital: '10000', color: '#3B82F6' });
  }

  function startEdit(a: Account) {
    setEditing({ id: a.id, name: a.name, capital: String(a.capital), color: a.color });
  }

  function saveEdit() {
    if (!editing) return;
    onEdit({ id: editing.id, name: editing.name.trim() || 'Account', capital: parseFloat(editing.capital) || 10000, color: editing.color });
    setEditing(null);
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 520, marginTop: 16 }}>
        <div style={{ padding: '13px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>💼 Manage Accounts</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          {accounts.map((a) => {
            const isEd = editing && editing.id === a.id;
            return (
              <div key={a.id} style={{ background: C.row, borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 8, overflow: 'hidden' }}>
                {isEd && editing ? (
                  <div style={{ padding: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                      <FormField label="Account Name"><Input value={editing.name} onChange={setEditField('name')} placeholder="Name" /></FormField>
                      <FormField label="Capital ($)"><Input value={editing.capital} onChange={setEditField('capital')} type="number" placeholder="10000" /></FormField>
                    </div>
                    <FormField label="Color">
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {ACCOUNT_COLORS.map((col) => (
                          <div
                            key={col}
                            onClick={() => setEditField('color')(col)}
                            style={{ width: 20, height: 20, borderRadius: '50%', background: col, cursor: 'pointer', border: editing.color === col ? '3px solid #fff' : '3px solid transparent' }}
                          />
                        ))}
                      </div>
                    </FormField>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button onClick={saveEdit} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                      <button onClick={() => setEditing(null)} style={{ background: C.border, color: C.text, border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{a.name}</div>
                      <div style={{ color: C.dim, fontSize: 10 }}>{`Capital: $${a.capital.toLocaleString()}`}</div>
                    </div>
                    <button onClick={() => startEdit(a)} style={{ background: '#1A3A6B', border: 'none', color: C.blue, borderRadius: 5, padding: '3px 9px', fontSize: 10, marginRight: 4, cursor: 'pointer' }}>Edit</button>
                    {accounts.length > 1 && (
                      <button onClick={() => onDelete(a.id)} style={{ background: '#3A1A1A', border: 'none', color: C.red, borderRadius: 5, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>Delete</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <Divider />
          <SectionHeader color={C.teal} label="Add New Account" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <FormField label="Account Name"><Input value={form.name} onChange={setField('name')} placeholder="e.g. FTMO $100k" /></FormField>
            <FormField label="Starting Capital ($)"><Input value={form.capital} onChange={setField('capital')} type="number" placeholder="10000" /></FormField>
          </div>
          <FormField label="Color">
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {ACCOUNT_COLORS.map((col) => (
                <div
                  key={col}
                  onClick={() => setField('color')(col)}
                  style={{ width: 20, height: 20, borderRadius: '50%', background: col, cursor: 'pointer', border: form.color === col ? '3px solid #fff' : '3px solid transparent' }}
                />
              ))}
            </div>
          </FormField>
          <button onClick={addAcc} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginTop: 8, width: '100%' }}>
            + Add Account
          </button>
        </div>
      </div>
    </Modal>
  );
}
