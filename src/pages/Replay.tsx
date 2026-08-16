import { Card } from '@components/ui/Card.js';
import { HistoricalImportPanel, ReplayChart, ReplayControls, ReplayTimeReadout, ReplayTradingPanel } from '@components/replay/index.js';
import { normalizeExpiry } from '@services/ninjaTraderHistoricalAdapter.js';
import { COLORS as C } from '@constants/lists.js';
import type { HistoricalRoot } from '@apptypes/marketData.js';
import type { ReplayImportRequest, ReplayImportResult, ReplaySnapshot, ReplaySpeed, ReplayTimeframe } from '@apptypes/replay.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

export interface ReplayPageProps {
  snapshot: ReplaySnapshot;
  actions: {
    selectSeries(series: { root: HistoricalRoot; expiryYear: number; expiryMonth: number; timeframe: '1m' }): void;
    setTimeframe(timeframe: ReplayTimeframe): void; setSpeed(speed: ReplaySpeed): void;
    play(): void; pause(): void; goTo(utcMs: number): void; stepForward(): void;
    importNinjaTrader(request: ReplayImportRequest): Promise<ReplayImportResult>;
  };
  sessions: ReplaySessionsState;
}

export function ReplayPage({ snapshot, actions, sessions }: ReplayPageProps) {
  const selectSeries = (root: HistoricalRoot, expiryText: string) => {
    const expiry = normalizeExpiry(expiryText);
    if (expiry !== null) actions.selectSeries({ root, ...expiry, timeframe: '1m' });
  };
  return <div style={{ padding: 16 }}>
    <h2 style={{ color: C.white, marginTop: 0 }}>Historical Replay</h2>
    <Card><HistoricalImportPanel snapshot={snapshot} onSeries={selectSeries} onImport={actions.importNinjaTrader} /></Card>
    <Card><div style={{ display: 'grid', gap: 10 }}>
      <ReplayTimeReadout nowUtcMs={snapshot.nowUtcMs} />
      <ReplayControls snapshot={snapshot} onPlay={actions.play} onPause={actions.pause} onStep={actions.stepForward}
        onSpeed={actions.setSpeed} onTimeframe={actions.setTimeframe} onGoTo={actions.goTo} />
      {snapshot.error && <div role="alert" style={{ color: C.red }}>{snapshot.error}</div>}
    </div></Card>
    <Card><ReplayTradingPanel sessions={sessions} /></Card>
    <Card padding={0}><ReplayChart bars={snapshot.bars} /></Card>
  </div>;
}
