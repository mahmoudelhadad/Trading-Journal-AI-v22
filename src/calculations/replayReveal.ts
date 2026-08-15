import { MINUTE_MS, type HistoricalBar } from '@apptypes/marketData.js';

/** The single bar-level publication chokepoint. */
export function revealClosedBars(
  bars: Iterable<HistoricalBar>,
  nowUtcMs: number,
  coverageStartUtcMs = Number.NEGATIVE_INFINITY,
  coverageEndUtcMs = Number.POSITIVE_INFINITY,
): HistoricalBar[] {
  const revealed: HistoricalBar[] = [];
  for (const bar of bars) {
    if (bar.t < coverageStartUtcMs || bar.t >= coverageEndUtcMs) continue;
    if (bar.t + MINUTE_MS <= nowUtcMs) revealed.push(bar);
  }
  return revealed.sort((a, b) => a.t - b.t);
}

export function mergeBarsInsertIfAbsent(
  target: Map<number, HistoricalBar>,
  bars: readonly HistoricalBar[],
): void {
  for (const bar of bars) if (!target.has(bar.t)) target.set(bar.t, bar);
}
