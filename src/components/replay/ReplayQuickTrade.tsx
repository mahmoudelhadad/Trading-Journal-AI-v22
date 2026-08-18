import type { CSSProperties } from 'react';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { isTradingMutationDisabled, parseEntryIntent, parseOrderQuantity } from '@calculations/replayWorkspace.js';
import { submitReplayEntryIntent, submitReplayExitAllIntent } from './ReplayTradingPanel.js';
import { COLORS as C } from '@constants/lists.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

/**
 * components/replay/ReplayQuickTrade.tsx
 *
 * B2d Phase 5 — compact MARKET-only trading controls over the chart.
 *
 * A new CALL SITE, not a new command path: every execution goes through the same
 * released `sessions.enter` / `sessions.exit` seams the detailed panel uses, with
 * the same shared parsing authority and the same shared trading-disabled
 * predicate, so the two surfaces cannot drift.
 *
 * ── WHAT THIS SURFACE DELIBERATELY DOES NOT HAVE ───────────────
 * No Buy/Sell Limit, no Buy/Sell Stop, no pending order of any kind — replay has
 * no order book and an arbitrary chart price carries no execution authority.
 * No Bid / Ask / Spread either: the historical feed is OHLCV, so a two-sided
 * quote would be fabricated. The single readout is `Last revealed close`, which
 * is advisory: it never enables, disables or prices an execution.
 */
export interface ReplayQuickTradeProps {
  sessions: ReplaySessionsState;
  /** Shared workspace Order Quantity — the same value the detailed panel edits. */
  orderQuantityText: string;
  onOrderQuantityTextChange: (text: string) => void;
  /** Shared workspace Initial Stop text. Read-only here; FLAT entries only. */
  initialStopText: string;
  /** Advisory close of the newest rendered bar, or null when nothing is rendered. */
  lastRevealedClose: number | null;
}

const BOX: CSSProperties = {
  position: 'absolute', top: 8, left: 8, zIndex: 2,
  display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
  background: 'rgba(13, 20, 33, 0.88)', border: `1px solid ${C.border}`,
  borderRadius: 8, padding: '6px 8px',
};

export function ReplayQuickTrade({
  sessions, orderQuantityText, onOrderQuantityTextChange, initialStopText, lastRevealedClose,
}: ReplayQuickTradeProps) {
  const open = sessions.projection?.openAggregate ?? null;
  const mutationDisabled = isTradingMutationDisabled(sessions);
  const entryIntent = parseEntryIntent(orderQuantityText, initialStopText);
  const scaleQuantity = parseOrderQuantity(orderQuantityText);

  return <div style={BOX} aria-label="Chart quick trade" data-replay-quick-trade="">
    <label style={{ color: C.dim, fontSize: 10 }}>Order quantity<Input type="number" min={1} step={1} width={72}
      value={orderQuantityText} onChange={onOrderQuantityTextChange} disabled={mutationDisabled} /></label>

    {open === null
      ? <>
        <Button size="sm" variant="success" disabled={mutationDisabled || entryIntent === null}
          onClick={() => { if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'long', entryIntent.quantity, entryIntent.initialStopPrice); }}>BUY MARKET</Button>
        <Button size="sm" variant="danger" disabled={mutationDisabled || entryIntent === null}
          onClick={() => { if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'short', entryIntent.quantity, entryIntent.initialStopPrice); }}>SELL MARKET</Button>
      </>
      : <>
        <Button size="sm" variant={open.side === 'long' ? 'success' : 'danger'}
          disabled={mutationDisabled || scaleQuantity === null}
          onClick={() => {
            // The episode's stop is immutable and inherited from the aggregate —
            // never from the shared workspace stop text.
            if (scaleQuantity !== null) void submitReplayEntryIntent(sessions, open.side, scaleQuantity, open.initialStopPrice);
          }}>{open.side === 'long' ? 'SCALE IN LONG' : 'SCALE IN SHORT'}</Button>
        <Button size="sm" disabled={mutationDisabled}
          onClick={() => void submitReplayExitAllIntent(sessions, open.remainingQuantity)}>EXIT ALL</Button>
      </>}

    <span style={{ color: C.dim, fontSize: 10 }}>
      Last revealed close · {lastRevealedClose === null ? '—' : String(lastRevealedClose)}
    </span>
  </div>;
}
