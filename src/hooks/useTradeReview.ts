/**
 * hooks/useTradeReview.ts
 *
 * Phase 15 — Trade Review hook.
 *
 * NEW hook — manages Checklist templates + per-trade completions, and
 * Custom Field definitions + per-trade values. Follows the exact same
 * pattern established in Phase 2A/2B/14 (lazy-init from storage,
 * persist via useEffect, expose typed CRUD functions).
 *
 * SCOPE NOTE: Not consumed by any existing page in this phase — see
 * calculations/tradeReview.ts's file header for the full rationale
 * (mirrors the Phase 8 / Phase 14 precedent).
 */

import { useState, useEffect, useCallback } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import {
  createChecklistTemplate, createCustomFieldDef,
  type ChecklistTemplate, type ChecklistCompletions,
  type CustomFieldDef, type CustomFieldValues, type CustomFieldType,
} from '@calculations/tradeReview.js';

// ─── Hook ────────────────────────────────────────────────────

export interface UseTradeReviewReturn {
  // ── Checklist templates ──
  checklistTemplates: ChecklistTemplate[];
  addChecklistTemplate: (name: string, itemTexts: string[]) => void;
  deleteChecklistTemplate: (id: string) => void;

  // ── Per-trade checklist completions ──
  checklistCompletions: ChecklistCompletions;
  toggleChecklistItem: (tradeId: number, itemId: string) => void;

  // ── Custom field definitions ──
  customFieldDefs: CustomFieldDef[];
  addCustomFieldDef: (name: string, type: CustomFieldType) => void;
  deleteCustomFieldDef: (id: string) => void;

  // ── Per-trade custom field values ──
  customFieldValues: CustomFieldValues;
  setCustomFieldValue: (tradeId: number, fieldId: string, value: string) => void;
}

export function useTradeReview(): UseTradeReviewReturn {
  const { storage } = useUserStorage();
  const [checklistTemplates, setChecklistTemplates] = useState<ChecklistTemplate[]>(
    () => storage.loadChecklistTemplates() as ChecklistTemplate[],
  );
  const [checklistCompletions, setChecklistCompletions] = useState<ChecklistCompletions>(
    () => storage.loadChecklistCompletions() as ChecklistCompletions,
  );
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>(
    () => storage.loadCustomFieldDefs() as CustomFieldDef[],
  );
  const [customFieldValues, setCustomFieldValues] = useState<CustomFieldValues>(
    () => storage.loadCustomFieldValues() as CustomFieldValues,
  );

  useEffect(() => { storage.saveChecklistTemplates(checklistTemplates); }, [storage, checklistTemplates]);
  useEffect(() => { storage.saveChecklistCompletions(checklistCompletions); }, [storage, checklistCompletions]);
  useEffect(() => { storage.saveCustomFieldDefs(customFieldDefs); }, [storage, customFieldDefs]);
  useEffect(() => { storage.saveCustomFieldValues(customFieldValues); }, [storage, customFieldValues]);

  // ── Checklist template CRUD ──
  const addChecklistTemplate = useCallback((name: string, itemTexts: string[]) => {
    const items = itemTexts.filter((t) => t.trim()).map((text) => ({ id: `item_${Date.now()}_${Math.random()}`, text: text.trim() }));
    const template = createChecklistTemplate(name || 'Untitled Checklist', items);
    setChecklistTemplates((prev) => [...prev, template]);
  }, []);

  const deleteChecklistTemplate = useCallback((id: string) => {
    setChecklistTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Per-trade checklist completion toggle ──
  const toggleChecklistItem = useCallback((tradeId: number, itemId: string) => {
    setChecklistCompletions((prev) => {
      const tradeCompletion = prev[tradeId] || {};
      return {
        ...prev,
        [tradeId]: { ...tradeCompletion, [itemId]: !tradeCompletion[itemId] },
      };
    });
  }, []);

  // ── Custom field definition CRUD ──
  const addCustomFieldDef = useCallback((name: string, type: CustomFieldType) => {
    if (!name.trim()) return;
    setCustomFieldDefs((prev) => [...prev, createCustomFieldDef(name.trim(), type)]);
  }, []);

  const deleteCustomFieldDef = useCallback((id: string) => {
    setCustomFieldDefs((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // ── Per-trade custom field value ──
  const setCustomFieldValue = useCallback((tradeId: number, fieldId: string, value: string) => {
    setCustomFieldValues((prev) => {
      const tradeValues = prev[tradeId] || {};
      return {
        ...prev,
        [tradeId]: { ...tradeValues, [fieldId]: value },
      };
    });
  }, []);

  return {
    checklistTemplates, addChecklistTemplate, deleteChecklistTemplate,
    checklistCompletions, toggleChecklistItem,
    customFieldDefs, addCustomFieldDef, deleteCustomFieldDef,
    customFieldValues, setCustomFieldValue,
  };
}
