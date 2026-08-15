import type { HistoricalBar } from '@apptypes/marketData.js';
import type { ReplayTimeframe } from '@apptypes/replay.js';

export const REPLAY_TIMEFRAME_MS: Record<ReplayTimeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

export function deriveReplayBars(
  revealedOneMinuteBars: readonly HistoricalBar[],
  timeframe: ReplayTimeframe,
): HistoricalBar[] {
  if (timeframe === '1m') return [...revealedOneMinuteBars];
  const bucketMs = REPLAY_TIMEFRAME_MS[timeframe];
  const result: HistoricalBar[] = [];
  for (const bar of revealedOneMinuteBars) {
    const t = Math.floor(bar.t / bucketMs) * bucketMs;
    const current = result[result.length - 1];
    if (current === undefined || current.t !== t) {
      result.push({ t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    } else {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v;
    }
  }
  return result;
}
