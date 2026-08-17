import { Fragment, useState } from 'react';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Select } from '@components/ui/Select.js';
import { COLORS as C } from '@constants/lists.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

function money(value: number): string { return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }

/** Parses a positive whole-contract quantity, or null when the text is not one. */
function wholeContracts(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function submitReplayEntryIntent(
  sessions: ReplaySessionsState,
  side: 'long' | 'short',
  quantity: number,
  initialStopPrice: number | null,
): Promise<void> {
  return sessions.enter(side, quantity, initialStopPrice);
}

export function ReplayTradingPanel({ sessions }: { sessions: ReplaySessionsState }) {
  const [quantityText, setQuantityText] = useState('1');
  const [stopText, setStopText] = useState('');
  const [scaleText, setScaleText] = useState('1');
  const [exitText, setExitText] = useState('1');
  const active = sessions.activeSession;
  const projection = sessions.projection;
  // Canonical B2c open state. The legacy `openPosition` compatibility view is
  // never consulted for any panel decision or display.
  const open = projection?.openAggregate ?? null;
  const mutationDisabled = sessions.pending || sessions.safetyBlocked || active?.status !== 'active' || projection?.rewound === true;

  const entryQuantity = wholeContracts(quantityText);
  const stop = stopText.trim() === '' ? null : Number(stopText);
  const validEntry = entryQuantity !== null && (stop === null || (Number.isFinite(stop) && stop > 0));
  const scaleQuantity = wholeContracts(scaleText);
  const exitQuantity = wholeContracts(exitText);
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
          <label style={{ color: C.dim, fontSize: 10 }}>Whole contracts<Input type="number" min={1} step={1} width={110} value={quantityText} onChange={setQuantityText} disabled={mutationDisabled} /></label>
          <label style={{ color: C.dim, fontSize: 10 }}>Initial stop (optional)<Input type="number" step="0.25" width={140} value={stopText} onChange={setStopText} disabled={mutationDisabled} /></label>
          <Button variant="success" disabled={mutationDisabled || !validEntry}
            onClick={() => { if (validEntry && entryQuantity !== null) void submitReplayEntryIntent(sessions, 'long', entryQuantity, stop); }}>Long</Button>
          <Button variant="danger" disabled={mutationDisabled || !validEntry}
            onClick={() => { if (validEntry && entryQuantity !== null) void submitReplayEntryIntent(sessions, 'short', entryQuantity, stop); }}>Short</Button>
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
            <label style={{ color: C.dim, fontSize: 10 }}>Scale quantity<Input type="number" min={1} step={1} width={110} value={scaleText} onChange={setScaleText} disabled={mutationDisabled} /></label>
            <Button variant={open.side === 'long' ? 'success' : 'danger'} disabled={mutationDisabled || scaleQuantity === null}
              onClick={() => {
                // The controller independently inherits the immutable stop; the
                // third argument only satisfies the existing entry signature.
                if (scaleQuantity !== null) void submitReplayEntryIntent(sessions, open.side, scaleQuantity, open.initialStopPrice);
              }}>{open.side === 'long' ? 'Scale In Long' : 'Scale In Short'}</Button>
            <label style={{ color: C.dim, fontSize: 10 }}>Exit quantity<Input type="number" min={1} max={open.remainingQuantity} step={1} width={110} value={exitText} onChange={setExitText} disabled={mutationDisabled} /></label>
            <Button disabled={mutationDisabled || !validExit}
              onClick={() => { if (validExit && exitQuantity !== null) void sessions.exit(exitQuantity); }}>Exit</Button>
            <Button disabled={mutationDisabled}
              onClick={() => void sessions.exit(open.remainingQuantity)}>Exit All</Button>
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
