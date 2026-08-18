import { Fragment, useState } from 'react';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Select } from '@components/ui/Select.js';
import { isTradingMutationDisabled, parseEntryIntent, parseOrderQuantity } from '@calculations/replayWorkspace.js';
import { COLORS as C } from '@constants/lists.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

function money(value: number): string { return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }

/**
 * The single Entry call site for every Replay trading surface — the detailed
 * panel, the chart Quick Trade controls and the chart context menu all route
 * here, so no surface can invent its own command construction. Execution
 * semantics stay entirely inside the released `sessions` controller.
 */
export function submitReplayEntryIntent(
  sessions: ReplaySessionsState,
  side: 'long' | 'short',
  quantity: number,
  initialStopPrice: number | null,
): Promise<void> {
  return sessions.enter(side, quantity, initialStopPrice);
}

/** The single Exit-All call site. `remainingQuantity` is the verified aggregate. */
export function submitReplayExitAllIntent(
  sessions: ReplaySessionsState,
  remainingQuantity: number,
): Promise<void> {
  return sessions.exit(remainingQuantity);
}

export interface ReplayTradingPanelProps {
  sessions: ReplaySessionsState;
  /**
   * Shared workspace Order Quantity text — ONE value for the initial Entry and
   * for Scale In (B2d Phase 4 consolidation). Phase 5's chart Quick Trade reads
   * the same value, so the two surfaces cannot disagree.
   */
  orderQuantityText: string;
  onOrderQuantityTextChange: (text: string) => void;
  /**
   * Shared workspace Initial Stop text. Used ONLY for a FLAT entry: an open
   * episode's stop is immutable and inherited from `openAggregate`, never from
   * this text.
   */
  initialStopText: string;
  onInitialStopTextChange: (text: string) => void;
}

export function ReplayTradingPanel({
  sessions, orderQuantityText, onOrderQuantityTextChange, initialStopText, onInitialStopTextChange,
}: ReplayTradingPanelProps) {
  // Partial-exit quantity stays panel-local: reducing a position is a different
  // intention from opening or adding to one.
  const [exitText, setExitText] = useState('1');
  const active = sessions.activeSession;
  const projection = sessions.projection;
  // Canonical B2c open state. The legacy `openPosition` compatibility view is
  // never consulted for any panel decision or display.
  const open = projection?.openAggregate ?? null;
  // The one shared trading-disabled authority; the chart surfaces use the same
  // helper, so no second inline expression can drift from it.
  const mutationDisabled = isTradingMutationDisabled(sessions);

  // One parsed Order Quantity now serves both the initial Entry and Scale In,
  // through the one shared parsing authority. Accepted and rejected inputs are
  // unchanged from the released panel.
  const orderQuantity = parseOrderQuantity(orderQuantityText);
  const entryIntent = parseEntryIntent(orderQuantityText, initialStopText);
  const validEntry = entryIntent !== null;
  const exitQuantity = parseOrderQuantity(exitText);
  const validExit = open !== null && exitQuantity !== null && exitQuantity <= open.remainingQuantity;

  const summaryRows: Array<[string, string]> = open === null ? [] : [
    ['Side', open.side],
    ['Entered', String(open.totalEntryQuantity)],
    ['Exited', String(open.totalExitedQuantity)],
    ['Remaining', String(open.remainingQuantity)],
    ['Avg Entry', String(open.weightedAverageEntryPrice)],
    ['Realized P/L', money(open.realizedGrossPL)],
    ['Risk Stop Anchor', open.initialStopPrice === null ? 'No stop anchor' : String(open.initialStopPrice)],
    ...(open.anchoredRisk === null ? [] : [['Anchored Risk', money(open.anchoredRisk)] as [string, string]]),
  ];

  return <div style={{ display: 'grid', gap: 10 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Select value={active?.sessionId ?? ''} width={280} placeholder="Select saved session"
        options={sessions.sessions.map((session) => ({
          value: session.sessionId,
          label: `${session.series.root} ${String(session.series.expiryMonth).padStart(2, '0')}-${String(session.series.expiryYear).slice(-2)} · ${session.status}`,
        }))}
        disabled={sessions.pending} onChange={(id) => { if (id) void sessions.selectSession(id); }} />
      {active === null
        ? <Button variant="primary" disabled={!sessions.hydrated || sessions.pending || sessions.safetyBlocked} onClick={() => void sessions.createCurrentSession()}>Create Session Here</Button>
        : <Button disabled={sessions.pending} onClick={() => void sessions.leaveSession()}>Leave Session</Button>}
    </div>

    {active !== null && <>
      <div style={{ color: C.dim, fontSize: 11 }}>
        {active.status === 'completed'
          ? 'Completed session · Replay navigation is read-only and non-persisted.'
          : projection?.rewound
            ? 'Rewound before saved actions · trading and completion are read-only until the high-water mark.'
            : `Active session · revision ${active.revision} · changes are saved locally for this signed-in user.`}
      </div>

      {open === null
        ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
          <label style={{ color: C.dim, fontSize: 10 }}>Whole contracts<Input type="number" min={1} step={1} width={110} value={orderQuantityText} onChange={onOrderQuantityTextChange} disabled={mutationDisabled} /></label>
          <label style={{ color: C.dim, fontSize: 10 }}>Initial stop (optional)<Input type="number" step="0.25" width={140} value={initialStopText} onChange={onInitialStopTextChange} disabled={mutationDisabled} /></label>
          <Button variant="success" disabled={mutationDisabled || !validEntry}
            onClick={() => { if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'long', entryIntent.quantity, entryIntent.initialStopPrice); }}>Long</Button>
          <Button variant="danger" disabled={mutationDisabled || !validEntry}
            onClick={() => { if (entryIntent !== null) void submitReplayEntryIntent(sessions, 'short', entryIntent.quantity, entryIntent.initialStopPrice); }}>Short</Button>
          <Button disabled={mutationDisabled} onClick={() => void sessions.complete()}>Complete Session</Button>
        </div>
        : <>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0, fontSize: 11 }}>
            {summaryRows.map(([term, value]) => <Fragment key={term}>
              <dt style={{ color: C.dim }}>{term}</dt>
              <dd style={{ color: C.text, margin: 0 }}>{value}</dd>
            </Fragment>)}
          </dl>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
            <label style={{ color: C.dim, fontSize: 10 }}>Scale quantity<Input type="number" min={1} step={1} width={110} value={orderQuantityText} onChange={onOrderQuantityTextChange} disabled={mutationDisabled} /></label>
            <Button variant={open.side === 'long' ? 'success' : 'danger'} disabled={mutationDisabled || orderQuantity === null}
              onClick={() => {
                // The controller independently inherits the immutable stop; the
                // third argument only satisfies the existing entry signature, and
                // it comes from the OPEN AGGREGATE — never from the shared
                // workspace stop text, which applies to a flat entry only.
                if (orderQuantity !== null) void submitReplayEntryIntent(sessions, open.side, orderQuantity, open.initialStopPrice);
              }}>{open.side === 'long' ? 'Scale In Long' : 'Scale In Short'}</Button>
            <label style={{ color: C.dim, fontSize: 10 }}>Exit quantity<Input type="number" min={1} max={open.remainingQuantity} step={1} width={110} value={exitText} onChange={setExitText} disabled={mutationDisabled} /></label>
            <Button disabled={mutationDisabled || !validExit}
              onClick={() => { if (validExit && exitQuantity !== null) void sessions.exit(exitQuantity); }}>Exit</Button>
            <Button disabled={mutationDisabled}
              onClick={() => void submitReplayExitAllIntent(sessions, open.remainingQuantity)}>Exit All</Button>
            <Button disabled onClick={() => void sessions.complete()}>Complete Session</Button>
          </div>
        </>}

      <div style={{ color: C.text, fontSize: 11 }}>
        {open === null ? 'Flat' : `Open ${open.side} · ${open.remainingQuantity} remaining @ ${open.weightedAverageEntryPrice}`}
        {' · '}{projection?.closedTrades.length ?? 0} closed trade(s)
        {' · Realized Gross P/L '}{money(projection?.closedTrades.reduce((sum, trade) => sum + trade.grossPL, 0) ?? 0)}
      </div>
      {(projection?.closedTrades.length ?? 0) > 0 && <div style={{ display: 'grid', gap: 3 }}>
        {projection!.closedTrades.map((trade) => <div key={trade.tradeId} style={{ color: C.dim, fontSize: 10 }}>
          {trade.side} {trade.quantity} · {trade.points} points · {trade.ticks} ticks · gross {money(trade.grossPL)}
          {trade.rMultiple === null ? '' : ` · ${trade.rMultiple}R`}
        </div>)}
      </div>}
    </>}

    {sessions.error && <div role="alert" style={{ color: C.red, fontSize: 11 }}>
      {sessions.error}{' '}<Button size="sm" onClick={() => void sessions.recover()}>Reload Sessions Safely</Button>
    </div>}
  </div>;
}
