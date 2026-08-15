import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createReplayComposition } from '@services/replayComposition.js';
import type { HistoricalSeriesIdentity } from '@apptypes/marketData.js';
import type { ReplayImportRequest, ReplaySpeed, ReplayTimeframe } from '@apptypes/replay.js';

export function useReplayRuntime() {
  const composition = useMemo(() => createReplayComposition(), []);
  const { runtime } = composition;
  useEffect(() => { runtime.attach(); return () => runtime.detach(); }, [runtime]);
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const importNinjaTrader = useCallback((request: ReplayImportRequest) => composition.importNinjaTrader(request), [composition]);
  return {
    snapshot,
    actions: {
      selectSeries: (series: HistoricalSeriesIdentity) => runtime.selectSeries(series),
      setTimeframe: (timeframe: ReplayTimeframe) => runtime.setTimeframe(timeframe),
      setSpeed: (speed: ReplaySpeed) => runtime.setSpeed(speed),
      play: () => runtime.play(), pause: () => runtime.pause(),
      goTo: (utcMs: number) => runtime.goTo(utcMs), stepForward: () => runtime.stepForward(),
      importNinjaTrader,
    },
  };
}
