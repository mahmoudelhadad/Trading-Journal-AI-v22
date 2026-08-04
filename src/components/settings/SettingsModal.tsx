/**
 * components/settings/SettingsModal.tsx
 *
 * Phase 19 — Integration: composite Settings modal.
 *
 * COMPOSITION DECISION (this is the decision explicitly deferred in
 * Phase 16's report — AN-009 — and Phase 14/15/18's "not wired into
 * any page" scope notes): rather than inventing several new header
 * buttons/entry points, every previously-standalone-but-unwired
 * capability from Phases 14 (Advanced Filters), 15 (Trade Review
 * templates), 16 (General Settings, Backup/Restore), and 18 (Recovery
 * Bin, Restore Points) is made reachable through ONE modal, behind the
 * SAME single ⚙ button the original app already used for settings —
 * preserving the original app's exact entry point while giving it the
 * fuller content pre-approved in the original migration plan's
 * SETTINGS section ("Theme, Currency, Risk Settings... Backup,
 * Restore"). A left-side section nav switches between:
 *   General · Backup & Restore Points · Recovery Bin ·
 *   Advanced Filters · Checklists & Custom Fields
 *
 * NOTE ON LISTS: `ListEditor.tsx` (Phase 16) renders its OWN top-level
 * `<Modal>` internally, by design (it was built as a faithful migration
 * of the original standalone SettingsManager modal). Embedding it as a
 * section INSIDE this modal would stack two Modal overlays/backdrops —
 * a genuine visual bug caught during this phase's own build, not a
 * style choice. Rather than modify ListEditor.tsx's internal structure
 * (out of scope for an integration-only phase — "do not perform any
 * cleanup or refactoring"), the General section instead has a "Manage
 * Dropdown Lists" button that closes this modal and opens ListEditor
 * as its own separate, mutually-exclusive top-level modal — exactly
 * how it was designed to run standalone.
 *
 * This is a NEW wrapper component (Phase 19), but it introduces ZERO
 * new business logic — it only composes already-built, already-
 * validated components (GeneralSettings, ListEditor, BackupPanel,
 * RestorePointsPanel, RecoveryBinPanel, FilterPanel, SavedFiltersList,
 * TradeReviewSettings) behind a section switcher, passing through
 * props unchanged.
 *
 * NOT wired in this phase (documented, not silently skipped): actually
 * restricting what Dashboard/Equity/Calendar/Strategy/Insights display
 * based on an "applied" Advanced Filter would require threading a new
 * filter-group concept into the trades pipeline every page already
 * consumes — a genuine architectural addition, not "wiring an existing
 * piece reachable." SavedFiltersList's "Apply" here re-loads a saved
 * filter's conditions back into the FilterPanel builder for viewing/
 * editing/match-count preview only.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { GeneralSettings } from './GeneralSettings.js';
import { BackupPanel } from './BackupPanel.js';
import { RestorePointsPanel } from './RestorePointsPanel.js';
import { RecoveryBinPanel } from '@components/trade/RecoveryBinPanel.js';
import { TradeReviewSettings } from '@components/trade/TradeReviewSettings.js';
import { FilterPanel } from '@components/filters/FilterPanel.js';
import { SavedFiltersList } from '@components/filters/SavedFiltersList.js';
import type { AppSettings } from '@hooks/useSettings.js';
import type { RestorePoint } from '@calculations/recoveryBin.js';
import type { RestoreResult } from '@services/backupService.js';
import type { RecoveryBinEntry } from '@calculations/recoveryBin.js';
import type { ChecklistTemplate, CustomFieldDef, CustomFieldType } from '@calculations/tradeReview.js';
import type { FilterGroup, SavedFilter } from '@calculations/filterEngine.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface SettingsModalProps {
  onClose:      () => void;
  onOpenLists:  () => void; // closes this modal, opens ListEditor standalone

  // General
  settings:       AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onResetSettings:  () => void;

  // Restore points
  // Phase 6g-1: onCreateRestorePoint/onRestoreFromPoint are now async
  // (§3.4 — the resolver-backed sections require it).
  restorePoints:      RestorePoint[];
  onCreateRestorePoint: (label: string) => Promise<void>;
  onRestoreFromPoint:   (id: string) => Promise<RestoreResult>;
  onDeleteRestorePoint: (id: string) => void;

  // Recovery bin (generic, but this app only soft-deletes trades so far
  // — see MIGRATION_NOTES.md AN-011: useTrades' delete is NOT wired to
  // soft-delete in this phase, so the bin will be empty until a future
  // phase makes that connection. Reachable and functional regardless.)
  recoveryBinEntries: RecoveryBinEntry<unknown>[];
  onRestoreFromBin:   (id: string) => void;
  onRestoreAllFromBin: () => void;
  onPermanentlyDelete: (id: string) => void;
  onEmptyBin:         () => void;

  // Advanced filters
  trades:          EnrichedTrade[];
  savedFilters:     SavedFilter[];
  onSaveFilter:     (name: string, group: FilterGroup) => void;
  onDeleteFilter:   (id: string) => void;
  onToggleFavoriteFilter: (id: string) => void;
  /**
   * Phase 22 — applies a saved filter as the application's global lens.
   * Optional: when omitted, "Apply" is inert, which is exactly this
   * modal's pre-Phase-22 behavior, so no existing caller can break.
   */
  onApplyFilter?:   (filter: SavedFilter) => void;

  // Trade review templates
  checklistTemplates: ChecklistTemplate[];
  onAddChecklistTemplate: (name: string, itemTexts: string[]) => void;
  onDeleteChecklistTemplate: (id: string) => void;
  customFieldDefs:    CustomFieldDef[];
  onAddCustomFieldDef: (name: string, type: CustomFieldType) => void;
  onDeleteCustomFieldDef: (id: string) => void;
}

type Section = 'general' | 'backup' | 'recovery' | 'filters' | 'review';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'general',  label: '⚙ General' },
  { id: 'backup',   label: '💾 Backup & Restore' },
  { id: 'recovery', label: '🗑 Recovery Bin' },
  { id: 'filters',  label: '🔍 Advanced Filters' },
  { id: 'review',   label: '✅ Checklists & Fields' },
];

// ─── Component ───────────────────────────────────────────────

export function SettingsModal(props: SettingsModalProps) {
  const [section, setSection] = useState<Section>('general');

  return (
    <Modal onClose={props.onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 820, marginTop: 16, marginBottom: 20, display: 'flex', minHeight: 480, maxHeight: '85vh' }}>
        {/* Section nav */}
        <div style={{ width: 190, borderRight: `1px solid ${C.border}`, padding: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, padding: '0 4px' }}>
            <span style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>Settings</span>
            <button onClick={props.onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 18, cursor: 'pointer' }}>×</button>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: section === s.id ? '#1A3A6B' : 'none',
                color: section === s.id ? C.blue : C.dim,
                border: 'none', borderRadius: 7, padding: '8px 10px', fontSize: 11, fontWeight: 600,
                cursor: 'pointer', marginBottom: 2,
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Section content */}
        <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
          {section === 'general' && (
            <div>
              <GeneralSettings settings={props.settings} onUpdate={props.onUpdateSettings} onReset={props.onResetSettings} />
              <button
                onClick={props.onOpenLists}
                style={{ marginTop: 12, background: C.row, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '8px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', width: '100%' }}
              >
                📋 Manage Dropdown Lists →
              </button>
            </div>
          )}

          {section === 'backup' && (
            <div>
              <BackupPanel />
              <div style={{ marginTop: 14 }}>
                <RestorePointsPanel
                  restorePoints={props.restorePoints}
                  onCreate={props.onCreateRestorePoint}
                  onRestore={props.onRestoreFromPoint}
                  onDelete={props.onDeleteRestorePoint}
                />
              </div>
            </div>
          )}

          {section === 'recovery' && (
            <RecoveryBinPanel
              entries={props.recoveryBinEntries}
              onRestore={props.onRestoreFromBin}
              onRestoreAll={props.onRestoreAllFromBin}
              onPermanentlyDelete={props.onPermanentlyDelete}
              onEmptyBin={props.onEmptyBin}
            />
          )}

          {section === 'filters' && (
            <div>
              <FilterPanel
                trades={props.trades}
                onSave={props.onSaveFilter}
              />
              <div style={{ marginTop: 14 }}>
                <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>Saved Filters</div>
                <SavedFiltersList
                  filters={props.savedFilters}
                  onApply={(f) => props.onApplyFilter?.(f)}
                  onToggleFavorite={props.onToggleFavoriteFilter}
                  onDelete={props.onDeleteFilter}
                />
              </div>
            </div>
          )}

          {section === 'review' && (
            <TradeReviewSettings
              checklistTemplates={props.checklistTemplates}
              onAddChecklistTemplate={props.onAddChecklistTemplate}
              onDeleteChecklistTemplate={props.onDeleteChecklistTemplate}
              customFieldDefs={props.customFieldDefs}
              onAddCustomFieldDef={props.onAddCustomFieldDef}
              onDeleteCustomFieldDef={props.onDeleteCustomFieldDef}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
