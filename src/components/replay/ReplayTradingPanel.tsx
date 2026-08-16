import { useState } from 'react';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Select } from '@components/ui/Select.js';
import { COLORS as C } from '@constants/lists.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

function money(value: number): string { return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }

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
  const quantity = Number(quantityText);
  const stop = stopText.trim() === '' ? null : Number(stopText);
  const validIntent = Number.isSafeInteger(quantity) && quantity > 0 && (stop === null || (Number.isFinite(stop) && stop > 0));
  const active = sessions.activeSession;
  const projection = sessions.projection;
  const mutationDisabled = sessions.pending || sessions.safetyBlocked || active?.status !== 'active' || projection?.rewound === true;

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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
        <label style={{ color: C.dim, fontSize: 10 }}>Whole contracts<Input type="number" min={1} step={1} width={110} value={quantityText} onChange={setQuantityText} disabled={mutationDisabled || projection?.openPosition !== null} /></label>
        <label style={{ color: C.dim, fontSize: 10 }}>Initial stop (optional)<Input type="number" step="0.25" width={140} value={stopText} onChange={setStopText} disabled={mutationDisabled || projection?.openPosition !== null} /></label>
        <Button variant="success" disabled={mutationDisabled || projection?.openPosition !== null || !validIntent} onClick={() => void submitReplayEntryIntent(sessions, 'long', quantity, stop)}>Long</Button>
        <Button variant="danger" disabled={mutationDisabled || projection?.openPosition !== null || !validIntent} onClick={() => void submitReplayEntryIntent(sessions, 'short', quantity, stop)}>Short</Button>
        <Button disabled={mutationDisabled || projection?.openPosition === null} onClick={() => void sessions.exit()}>Close Position</Button>
        <Button disabled={mutationDisabled || projection?.openPosition !== null} onClick={() => void sessions.complete()}>Complete Session</Button>
      </div>
      <div style={{ color: C.text, fontSize: 11 }}>
        {projection?.openPosition
          ? `Open ${projection.openPosition.side} · ${projection.openPosition.quantity} @ ${projection.openPosition.fill.price}`
          : 'Flat'}
        {' · '}{projection?.closedTrades.length ?? 0} closed trade(s)
        {' · Gross P/L '}{money(projection?.closedTrades.reduce((sum, trade) => sum + trade.grossPL, 0) ?? 0)}
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
