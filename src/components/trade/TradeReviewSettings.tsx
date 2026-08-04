/**
 * components/trade/TradeReviewSettings.tsx
 *
 * Phase 15 — Trade Review: checklist template & custom field
 * definition management UI.
 *
 * NEW component — lets the user create/delete checklist templates
 * (name + list of item texts) and custom field definitions (name +
 * type). Reuses Card, Button, Input, Divider UI atoms (Phase 3).
 *
 * SCOPE NOTE: Not wired into any existing page/settings UI in this
 * phase — see calculations/tradeReview.ts's file header for the full
 * rationale (mirrors the Phase 8 / Phase 14 precedent).
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Divider } from '@components/ui/Divider.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import type { ChecklistTemplate, CustomFieldDef, CustomFieldType } from '@calculations/tradeReview.js';

// ─── Types ───────────────────────────────────────────────────

export interface TradeReviewSettingsProps {
  checklistTemplates: ChecklistTemplate[];
  onAddChecklistTemplate: (name: string, itemTexts: string[]) => void;
  onDeleteChecklistTemplate: (id: string) => void;

  customFieldDefs: CustomFieldDef[];
  onAddCustomFieldDef: (name: string, type: CustomFieldType) => void;
  onDeleteCustomFieldDef: (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function TradeReviewSettings({
  checklistTemplates, onAddChecklistTemplate, onDeleteChecklistTemplate,
  customFieldDefs, onAddCustomFieldDef, onDeleteCustomFieldDef,
}: TradeReviewSettingsProps) {
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newItemsText, setNewItemsText] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<CustomFieldType>('text');

  function handleAddTemplate() {
    if (!newTemplateName.trim()) return;
    const items = newItemsText.split('\n').map((l) => l.trim()).filter(Boolean);
    onAddChecklistTemplate(newTemplateName.trim(), items);
    setNewTemplateName('');
    setNewItemsText('');
  }

  function handleAddField() {
    if (!newFieldName.trim()) return;
    onAddCustomFieldDef(newFieldName.trim(), newFieldType);
    setNewFieldName('');
    setNewFieldType('text');
  }

  return (
    <div>
      {/* ── Checklist templates ────────────────────────────────── */}
      <Card>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>✅ Checklist Templates</div>

        {checklistTemplates.length === 0 ? (
          <EmptyState message="No checklist templates yet." padding={14} fontSize={11} />
        ) : (
          <div style={{ marginBottom: 12 }}>
            {checklistTemplates.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.row, border: `1px solid ${C.border}`, borderRadius: 7, padding: '7px 12px', marginBottom: 6 }}>
                <div>
                  <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{t.name}</div>
                  <div style={{ color: C.dim, fontSize: 10 }}>{`${t.items.length} item${t.items.length !== 1 ? 's' : ''}`}</div>
                </div>
                <button onClick={() => onDeleteChecklistTemplate(t.id)} style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer' }}>🗑</button>
              </div>
            ))}
          </div>
        )}

        <Divider />
        <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>New Checklist Name</div>
        <div style={{ marginBottom: 8 }}><Input value={newTemplateName} onChange={setNewTemplateName} placeholder="e.g. Pre-Trade Checklist" /></div>
        <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>Items (one per line)</div>
        <textarea
          value={newItemsText}
          onChange={(e) => setNewItemsText(e.target.value)}
          placeholder={'Checked higher timeframe?\nSetup matches my A+ criteria?\nRisk sized correctly?'}
          rows={3}
          style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11, marginBottom: 8, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <Button variant="primary" size="sm" onClick={handleAddTemplate} disabled={!newTemplateName.trim()}>+ Add Checklist</Button>
      </Card>

      {/* ── Custom field definitions ───────────────────────────── */}
      <Card>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>🏷️ Custom Fields</div>

        {customFieldDefs.length === 0 ? (
          <EmptyState message="No custom fields defined yet." padding={14} fontSize={11} />
        ) : (
          <div style={{ marginBottom: 12 }}>
            {customFieldDefs.map((d) => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.row, border: `1px solid ${C.border}`, borderRadius: 7, padding: '7px 12px', marginBottom: 6 }}>
                <div>
                  <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{d.name}</div>
                  <div style={{ color: C.dim, fontSize: 10 }}>{d.type}</div>
                </div>
                <button onClick={() => onDeleteCustomFieldDef(d.id)} style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer' }}>🗑</button>
              </div>
            ))}
          </div>
        )}

        <Divider />
        <div style={{ display: 'flex', gap: 8 }}>
          <Input value={newFieldName} onChange={setNewFieldName} placeholder="Field name..." />
          <select
            value={newFieldType}
            onChange={(e) => setNewFieldType(e.target.value as CustomFieldType)}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, width: 100 }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Yes/No</option>
          </select>
          <Button variant="primary" size="sm" onClick={handleAddField} disabled={!newFieldName.trim()}>+ Add</Button>
        </div>
      </Card>
    </div>
  );
}
