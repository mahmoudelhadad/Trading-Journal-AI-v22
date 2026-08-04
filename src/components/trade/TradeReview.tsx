/**
 * components/trade/TradeReview.tsx
 *
 * Phase 15 — Trade Review component.
 *
 * NEW component — displays/edits a single trade's checklist completion
 * and custom field values. Reuses Card, Badge, Input, EmptyState UI
 * atoms (Phase 3) — no new visual language introduced.
 *
 * SCOPE NOTE: This component is NOT rendered by TradeForm.tsx or any
 * existing page in this phase — see calculations/tradeReview.ts's file
 * header for the full rationale. It is a complete, standalone,
 * independently-usable component ready for a future phase to wire in
 * (e.g. as an extra section inside TradeForm.tsx, or a tab inside a
 * trade-detail view) with your separate, explicit approval.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Badge } from '@components/ui/Badge.js';
import { Input } from '@components/ui/Input.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { getCompletionPercent, isValidCustomFieldValue } from '@calculations/tradeReview.js';
import type {
  ChecklistTemplate, ChecklistCompletion,
  CustomFieldDef, CustomFieldValueSet,
} from '@calculations/tradeReview.js';

// ─── Types ───────────────────────────────────────────────────

export interface TradeReviewProps {
  tradeId:            number;
  checklistTemplates: ChecklistTemplate[];
  completion:         ChecklistCompletion | undefined;
  onToggleItem:       (itemId: string) => void;
  customFieldDefs:    CustomFieldDef[];
  fieldValues:        CustomFieldValueSet | undefined;
  onSetFieldValue:    (fieldId: string, value: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function TradeReview({
  tradeId,
  checklistTemplates,
  completion,
  onToggleItem,
  customFieldDefs,
  fieldValues,
  onSetFieldValue,
}: TradeReviewProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(checklistTemplates[0]?.id ?? '');
  const selectedTemplate = checklistTemplates.find((t) => t.id === selectedTemplateId);

  return (
    <div>
      {/* ── Checklist section ─────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>✅ Pre-Trade Checklist</div>
          {checklistTemplates.length > 1 && (
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 10 }}
            >
              {checklistTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>

        {!selectedTemplate ? (
          <EmptyState message="No checklist templates yet." padding={16} fontSize={11} />
        ) : selectedTemplate.items.length === 0 ? (
          <EmptyState message="This checklist has no items yet." padding={16} fontSize={11} />
        ) : (
          <div>
            <div style={{ marginBottom: 8 }}>
              <Badge color={getCompletionPercent(selectedTemplate, completion) === 100 ? C.green : C.gold}>
                {`${getCompletionPercent(selectedTemplate, completion)}% complete`}
              </Badge>
            </div>
            {selectedTemplate.items.map((item) => (
              <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 11, color: C.text }}>
                <input
                  type="checkbox"
                  checked={!!completion?.[item.id]}
                  onChange={() => onToggleItem(item.id)}
                  style={{ accentColor: C.blue, cursor: 'pointer' }}
                />
                <span style={{ textDecoration: completion?.[item.id] ? 'line-through' : 'none', color: completion?.[item.id] ? C.dim : C.text }}>
                  {item.text}
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>

      {/* ── Custom fields section ─────────────────────────────── */}
      <Card>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>🏷️ Custom Fields</div>
        {customFieldDefs.length === 0 ? (
          <EmptyState message="No custom fields defined yet." padding={16} fontSize={11} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {customFieldDefs.map((def) => {
              const value = fieldValues?.[def.id] ?? '';
              const valid = isValidCustomFieldValue(def.type, value);
              return (
                <div key={def.id}>
                  <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>
                    {`${def.name} (${def.type})`}
                  </div>
                  {def.type === 'boolean' ? (
                    <select
                      value={value}
                      onChange={(e) => onSetFieldValue(def.id, e.target.value)}
                      style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${valid ? C.border : C.red}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}
                    >
                      <option value="">—</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <Input
                      value={value}
                      onChange={(v) => onSetFieldValue(def.id, v)}
                      type={def.type === 'number' ? 'number' : 'text'}
                      style={!valid ? { borderColor: C.red } : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
