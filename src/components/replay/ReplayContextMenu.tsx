import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { isTradingMutationDisabled, parseEntryIntent, parseOrderQuantity } from '@calculations/replayWorkspace.js';
import { submitReplayEntryIntent, submitReplayExitAllIntent } from './ReplayTradingPanel.js';
import { COLORS as C } from '@constants/lists.js';
import type { ReplayWorkspaceContextRequest } from '@hooks/useReplayWorkspace.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

/**
 * components/replay/ReplayContextMenu.tsx
 *
 * B2d Phase 5 — the safe chart context menu.
 *
 * Presentation and delegation only. It knows nothing about lightweight-charts
 * and performs no coordinate conversion: the resolved price and bar time arrive
 * already computed by the chart's own scales (Phase 3).
 *
 * ── SAFETY BOUNDARIES ──────────────────────────────────────────
 * 1. NO PENDING ORDERS. Buy/Sell Limit and Buy/Sell Stop do not exist here in
 *    any form, not even disabled — replay has no order book, no trigger
 *    evaluation and no gap-fill semantics.
 * 2. THE CLICKED PRICE IS NEVER AN EXECUTION PRICE. Market actions submit the
 *    shared workspace quantity and, while flat, the shared stop text; while open
 *    they inherit the aggregate's immutable stop. The clicked price reaches
 *    exactly one action — "Use … as Initial Stop" — which writes FORM TEXT and
 *    executes nothing.
 * 3. Unavailable EXECUTION items are OMITTED rather than shown disabled, so a
 *    blocked state cannot look momentarily actionable. (Quick Trade keeps its
 *    fixed buttons visible-but-disabled; that difference is intentional.)
 */
export interface ReplayContextMenuProps {
  request: ReplayWorkspaceContextRequest;
  sessions: ReplaySessionsState;
  /** Shared workspace order text — the same values the other surfaces submit. */
  orderQuantityText: string;
  initialStopText: string;
  /**
   * Presentation text for the TICK-NORMALIZED price — the value that will
   * actually be written into the Initial Stop field, and therefore the value its
   * label names. `Copy Price` deliberately does NOT use this: see `copyPrice`.
   */
  priceText: string | null;
  /** Writes tick-normalized FORM TEXT. Never executes. */
  onUseAsInitialStop: (price: number) => void;
  /** Navigates through the released runtime Go-To authority. */
  onGoToBar: (barStartUtcMs: number) => void;
  onClose: () => void;
}

const MENU: CSSProperties = {
  position: 'fixed', zIndex: 20, minWidth: 180, padding: 4,
  background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
  display: 'grid', gap: 2,
};

const ITEM: CSSProperties = {
  background: 'none', border: 'none', textAlign: 'left', color: C.text,
  font: 'inherit', fontSize: 11, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
};

const VIEWPORT_MARGIN = 4;

export function ReplayContextMenu({
  request, sessions, orderQuantityText, initialStopText, priceText,
  onUseAsInitialStop, onGoToBar, onClose,
}: ReplayContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: request.clientX, top: request.clientY });

  // Viewport clamp from the MEASURED menu box. The clicked chart price is never
  // involved in positioning; only the click's viewport coordinates are.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const { width, height } = element.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxTop = Math.max(0, window.innerHeight - height - VIEWPORT_MARGIN);
    setPosition({ left: Math.min(request.clientX, maxLeft), top: Math.min(request.clientY, maxTop) });
  }, [request]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointerDown = (event: Event) => {
      const element = menuRef.current;
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const open = sessions.projection?.openAggregate ?? null;
  const mutationDisabled = isTradingMutationDisabled(sessions);
  const entryIntent = parseEntryIntent(orderQuantityText, initialStopText);
  const scaleQuantity = parseOrderQuantity(orderQuantityText);

  const run = (action: () => void) => { action(); onClose(); };

  /*
   * Copy Price is an OBSERVATION action: it copies what the chart coordinate
   * actually resolved to, so it must not tick-round. Only "Use … as Initial
   * Stop" normalizes, because that value can later become an execution stop
   * anchor and must obey the instrument tick size. The two utilities therefore
   * legitimately produce different strings for the same click — 21042.63 copied
   * versus 21042.75 written — and that difference is the point.
   */
  const copyPrice = () => {
    // Clipboard denial can never touch session state, execution or the cursor.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (request.price !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
      void clipboard.writeText(String(request.price))
        .catch(() => { /* denied or unavailable: nothing else changes */ });
    }
    onClose();
  };

  const items: Array<{ key: string; label: string; onSelect: () => void }> = [];

  if (!mutationDisabled) {
    if (open === null) {
      items.push({
        key: 'buy', label: 'Buy Market',
        onSelect: () => run(() => {
          if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'long', entryIntent.quantity, entryIntent.initialStopPrice);
        }),
      });
      items.push({
        key: 'sell', label: 'Sell Market',
        onSelect: () => run(() => {
          if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'short', entryIntent.quantity, entryIntent.initialStopPrice);
        }),
      });
    } else {
      items.push({
        key: 'scale', label: open.side === 'long' ? 'Scale In Long' : 'Scale In Short',
        onSelect: () => run(() => {
          if (scaleQuantity !== null) void submitReplayEntryIntent(sessions, open.side, scaleQuantity, open.initialStopPrice);
        }),
      });
      items.push({
        key: 'exit-all', label: 'Exit All at Market',
        onSelect: () => run(() => { void submitReplayExitAllIntent(sessions, open.remainingQuantity); }),
      });
    }
  }

  // Form-state only, and only where a stop can still be chosen: a resolved
  // price, an existing session, and a flat episode.
  if (request.price !== null && priceText !== null && sessions.activeSession !== null && open === null) {
    const price = request.price;
    items.push({
      key: 'use-stop', label: `Use ${priceText} as Initial Stop`,
      onSelect: () => run(() => onUseAsInitialStop(price)),
    });
  }
  // Gated on the RESOLVED price alone — this item never consults the normalized
  // presentation text.
  if (request.price !== null) {
    items.push({ key: 'copy', label: 'Copy Price', onSelect: copyPrice });
  }
  if (request.barStartUtcMs !== null) {
    const barStartUtcMs = request.barStartUtcMs;
    items.push({ key: 'go-to', label: 'Go To This Bar', onSelect: () => run(() => onGoToBar(barStartUtcMs)) });
  }
  items.push({ key: 'cancel', label: 'Cancel', onSelect: onClose });

  return <div ref={menuRef} role="menu" aria-label="Replay chart actions" data-replay-context-menu=""
    style={{ ...MENU, left: position.left, top: position.top }}>
    {items.map((item) => <button key={item.key} type="button" role="menuitem" style={ITEM}
      onClick={item.onSelect}>{item.label}</button>)}
  </div>;
}
