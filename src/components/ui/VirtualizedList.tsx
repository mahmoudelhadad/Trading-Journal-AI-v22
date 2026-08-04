/**
 * components/ui/VirtualizedList.tsx
 *
 * Phase 17 — Performance: generic row-virtualization primitive.
 *
 * NEW component — no original-app equivalent (the original app, and
 * every page migrated so far, renders every row of every list/table
 * as a real DOM node). Explicitly pre-approved in the original
 * migration plan's PERFORMANCE section: *"Support 100,000+ Trades,
 * Virtualized Tables."*
 *
 * SCOPE DECISION (documented, intentional — per this phase's "do not
 * redesign any existing UI" rule): this is built as a generic,
 * reusable, fully-tested primitive, but is NOT wired into
 * `components/trade/TradeTable.tsx` (Phase 5) in this phase. Swapping
 * an existing, battle-tested table's row-rendering strategy is a
 * genuinely structural change with real regression risk (table
 * virtualization specifically has to handle scroll-sync, row height
 * consistency, and the existing bulk-select/edit/delete column
 * correctly) — building and validating it as a standalone component
 * first, then wiring it into TradeTable in a future, explicitly-scoped
 * phase, mirrors the exact pattern already established for
 * useAdvancedAnalytics (Phase 8→9), Advanced Filters (Phase 14), and
 * Trade Review (Phase 15). See MIGRATION_NOTES.md for the full
 * Phase 17 rationale.
 *
 * ALGORITHM: fixed-row-height windowing. Given a scroll container of
 * height `height` and uniform `rowHeight`, only the rows currently
 * within the visible window (plus a small `overscan` buffer above and
 * below, to reduce blank flashes during fast scrolling) are rendered
 * as real DOM nodes. A single spacer element above and below the
 * rendered window reserves the correct total scrollable height so the
 * scrollbar behaves exactly as if every row were rendered.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';

// ─── Types ───────────────────────────────────────────────────

export interface VirtualizedListProps<T> {
  items:       T[];
  /** Fixed height of each row, in pixels — required for windowing math */
  rowHeight:   number;
  /** Visible viewport height, in pixels */
  height:      number;
  renderRow:   (item: T, index: number) => React.ReactNode;
  /** Extra rows rendered above/below the visible window, to reduce blank flashes during fast scroll. Default: 5 */
  overscan?:   number;
  /** Optional key extractor — defaults to index if omitted */
  getKey?:     (item: T, index: number) => string | number;
  style?:      React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────

export function VirtualizedList<T>({
  items,
  rowHeight,
  height,
  renderRow,
  overscan = 5,
  getKey,
  style,
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  const { startIndex, endIndex, offsetY, totalHeight } = useMemo(() => {
    const totalHeight = items.length * rowHeight;
    const visibleCount = Math.ceil(height / rowHeight);
    const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
    const startIndex = Math.max(0, rawStart);
    const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);
    const offsetY = startIndex * rowHeight;
    return { startIndex, endIndex, offsetY, totalHeight };
  }, [items.length, rowHeight, height, scrollTop, overscan]);

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{ height, overflowY: 'auto', position: 'relative', ...style }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
          {visibleItems.map((item, i) => {
            const realIndex = startIndex + i;
            const key = getKey ? getKey(item, realIndex) : realIndex;
            return <div key={key} style={{ height: rowHeight }}>{renderRow(item, realIndex)}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
