import type { HistoricalBar, HistoricalRoot, HistoricalSeriesIdentity } from './marketData.js';

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60, 300] as const;
export type ReplaySpeed = typeof REPLAY_SPEEDS[number];
export type ReplayTimeframe = '1m' | '5m' | '15m' | '1h';
export type ReplayPlayState = 'paused' | 'playing' | 'ended';

export interface ReplaySnapshot {
  series: HistoricalSeriesIdentity;
  nowUtcMs: number;
  speed: ReplaySpeed;
  timeframe: ReplayTimeframe;
  playState: ReplayPlayState;
  bars: HistoricalBar[];
  availability: {
    available: boolean;
    observedFirstUtcMs?: number;
    observedLastUtcMs?: number;
    observedDays?: string[];
  };
  coverageStartUtcMs: number | null;
  coverageEndUtcMs: number | null;
  loading: boolean;
  importing: boolean;
  error: string | null;
}

export interface ReplayImportRequest {
  root: HistoricalRoot;
  expiryText: string;
  text: string;
  fileName: string;
}

export interface ReplayImportResult {
  ok: boolean;
  message: string;
}
