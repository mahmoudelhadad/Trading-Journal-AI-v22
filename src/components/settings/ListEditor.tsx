/**
 * components/settings/ListEditor.tsx
 *
 * Phase 16 — Settings: dropdown list editor.
 *
 * Migrated from the original single-file app's SettingsManager(props)
 * component. Every workflow (select list, edit item inline, move up/
 * down, remove, add, reset to default) is preserved exactly.
 *
 * CENTRALIZATION (per your rules 2 & 3): this component contains ZERO
 * list-manipulation logic of its own. `updateList`/`resetList` from
 * the EXISTING useLists() hook (Phase 2A) map directly onto the
 * original's `props.onChange`/`props.onReset` — this is a pure UI
 * migration wired to already-centralized business logic, not a
 * reimplementation of it.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { FormField } from '@components/ui/FormField.js';
import { Input } from '@components/ui/Input.js';
import type { ListsState } from '@hooks/useLists.js';

// ─── Types ───────────────────────────────────────────────────

export interface ListEditorProps {
  lists:      ListsState;
  onChange:   (key: string, items: string[]) => void; // = useLists().updateList
  onReset:    (key: string) => void;                   // = useLists().resetList
  onClose:    () => void;
}

// ─── Component ───────────────────────────────────────────────

export function ListEditor({ lists, onChange, onReset, onClose }: ListEditorProps) {
  const listKeys = Object.keys(lists);
  const [selKey, setSelKey] = useState(listKeys[0] ?? '');
  const [newItem, setNewItem] = useState('');

  const curList = lists[selKey] ?? [];

  function addItem() {
    if (!newItem.trim()) return;
    onChange(selKey, [...curList, newItem.trim()]);
    setNewItem('');
  }
  function removeItem(idx: number) {
    onChange(selKey, curList.filter((_, i) => i !== idx));
  }
  function moveUp(idx: number) {
    if (idx === 0) return;
    const a = curList.slice();
    [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]];
    onChange(selKey, a);
  }
  function moveDown(idx: number) {
    if (idx === curList.length - 1) return;
    const a = curList.slice();
    [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]];
    onChange(selKey, a);
  }
  function editItem(idx: number, val: string) {
    const a = curList.slice();
    a[idx] = val;
    onChange(selKey, a);
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 580, marginTop: 16 }}>
        <div style={{ padding: '13px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>⚙ Settings — Edit Lists</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          <FormField label="Select list to edit">
            <select value={selKey} onChange={(e) => setSelKey(e.target.value)} style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              {listKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </FormField>

          <div style={{ background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`, maxHeight: 280, overflowY: 'auto', marginBottom: 12 }}>
            {curList.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: `1px solid ${C.border}` }}>
                <input
                  value={item}
                  onChange={(e) => editItem(idx, e.target.value)}
                  style={{ flex: 1, background: 'none', border: 'none', color: C.text, fontSize: 11, outline: 'none' }}
                />
                <button onClick={() => moveUp(idx)} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 12, cursor: 'pointer', padding: '0 3px' }}>▲</button>
                <button onClick={() => moveDown(idx)} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 12, cursor: 'pointer', padding: '0 3px' }}>▼</button>
                <button onClick={() => removeItem(idx)} style={{ background: 'none', border: 'none', color: C.red, fontSize: 13, cursor: 'pointer', padding: '0 4px' }}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Input value={newItem} onChange={setNewItem} placeholder="Add new item..." style={{ flex: 1 }} />
            <button onClick={addItem} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>+Add</button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => onReset(selKey)} style={{ background: '#2A1A1A', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 7, padding: '6px 14px', fontSize: 11, cursor: 'pointer' }}>
              Reset to Default
            </button>
            <button onClick={onClose} style={{ background: C.blue, color: '#fff', border: 'none', borderRadius: 7, padding: '6px 18px', fontSize: 11, fontWeight: 700, marginLeft: 'auto', cursor: 'pointer' }}>
              Done ✓
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
