/**
 * components/filters/SavedFiltersList.tsx
 *
 * Phase 14 — Advanced Filters: saved/favorite filter list ("Saved
 * Filters, Favorite Filters" from the approved plan).
 *
 * NEW component — no original-app equivalent. Displays each saved
 * filter as a chip-like row with an Apply action, a favorite-star
 * toggle, and a delete action. Favorites are sorted first. Reuses
 * Badge and EmptyState UI atoms (Phase 3).
 *
 * NOT wired into any existing page in this phase — see
 * calculations/filterEngine.ts's file header for the scope rationale.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Badge } from '@components/ui/Badge.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import type { SavedFilter } from '@calculations/filterEngine.js';

// ─── Types ───────────────────────────────────────────────────

export interface SavedFiltersListProps {
  filters:        SavedFilter[];
  onApply:        (filter: SavedFilter) => void;
  onToggleFavorite: (id: string) => void;
  onDelete:       (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function SavedFiltersList({ filters, onApply, onToggleFavorite, onDelete }: SavedFiltersListProps) {
  if (filters.length === 0) {
    return <EmptyState message="No saved filters yet. Build a filter above and save it." padding={20} fontSize={11} />;
  }

  // Favorites first, matching the approved plan's "Favorite Filters" intent
  const sorted = [...filters].sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sorted.map((f) => (
        <div
          key={f.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: C.row, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px',
          }}
        >
          <button
            onClick={() => onToggleFavorite(f.id)}
            title={f.isFavorite ? 'Remove from favorites' : 'Mark as favorite'}
            style={{ background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', color: f.isFavorite ? C.gold : C.dim, padding: 0 }}
          >
            {f.isFavorite ? '★' : '☆'}
          </button>

          <div style={{ flex: 1 }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{f.name}</div>
            <div style={{ color: C.dim, fontSize: 10 }}>
              <Badge color={f.group.logic === 'AND' ? C.blue : C.purple}>{f.group.logic}</Badge>
              {` · ${f.group.conditions.length} condition${f.group.conditions.length !== 1 ? 's' : ''}`}
            </div>
          </div>

          <button
            onClick={() => onApply(f)}
            style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}44`, color: C.blue, borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
          >
            Apply
          </button>
          <button
            onClick={() => onDelete(f.id)}
            style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer', padding: '0 4px' }}
            title="Delete filter"
          >
            🗑
          </button>
        </div>
      ))}
    </div>
  );
}
