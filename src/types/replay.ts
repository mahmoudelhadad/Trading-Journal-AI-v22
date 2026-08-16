import type { HistoricalBar, HistoricalRoot, HistoricalSeriesIdentity } from './marketData.js';
import type { BacktestSessionSeries, ExecutionFill, SessionProgress } from './backtestSession.js';

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
  canonicalBarrier: 'action' | 'completion' | null;
}

export type ReplayCanonicalCaptureResult =
  | { ok: true; progress: SessionProgress; fill?: ExecutionFill }
  | { ok: false; reason: 'command_pending' | 'not_ready' | 'series_mismatch' | 'no_closed_bar' | 'stale_quote' };

export interface ReplayExecutionAuthority {
  beginExecutionCommand(series: BacktestSessionSeries): ReplayCanonicalCaptureResult & ({ ok: true; fill: ExecutionFill } | { ok: false });
  beginCompletionCommand(series: BacktestSessionSeries): ReplayCanonicalCaptureResult;
  releaseCanonicalCommand(): void;
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
