import type { HistoricalRoot } from './marketData.js';
import type { ReplaySpeed, ReplayTimeframe } from './replay.js';

export const BACKTEST_SESSION_SCHEMA_VERSION = 1 as const;
export const BACKTEST_ACTION_VERSION = 1 as const;
export const BACKTEST_FILL_BASIS = 'revealed_1m_close' as const;

export interface BacktestSessionSeries {
  root: HistoricalRoot;
  expiryYear: number;
  expiryMonth: number;
  timeframe: '1m';
}

export interface SessionProgress {
  cursorUtcMs: number;
  displayTimeframe: ReplayTimeframe;
  speed: ReplaySpeed;
}

export interface ExecutionFill {
  decisionUtcMs: number;
  sourceBarStartUtcMs: number;
  sourceBarCloseUtcMs: number;
  price: number;
  basis: typeof BACKTEST_FILL_BASIS;
}

interface BacktestActionBase {
  actionVersion: typeof BACKTEST_ACTION_VERSION;
  actionId: string;
  tradeId: string;
  sessionId: string;
  sequence: number;
  quantity: number;
  fill: ExecutionFill;
  clientCreatedAt: string;
}

export interface BacktestEntryAction extends BacktestActionBase {
  kind: 'entry';
  side: 'long' | 'short';
  initialStopPrice: number | null;
}

export interface BacktestExitAction extends BacktestActionBase {
  kind: 'exit';
}

export type BacktestAction = BacktestEntryAction | BacktestExitAction;

export interface BacktestSession extends SessionProgress {
  schemaVersion: typeof BACKTEST_SESSION_SCHEMA_VERSION;
  sessionId: string;
  series: BacktestSessionSeries;
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
  startedAtReplayUtcMs: number;
  revision: number;
  actions: BacktestAction[];
}

export interface BacktestClosedTrade {
  tradeId: string;
  side: 'long' | 'short';
  quantity: number;
  entry: BacktestEntryAction;
  exit: BacktestExitAction;
  points: number;
  ticks: number;
  grossPL: number;
  initialRisk: number | null;
  rMultiple: number | null;
}

export interface BacktestSessionProjection {
  visibleActions: BacktestAction[];
  openPosition: BacktestEntryAction | null;
  closedTrades: BacktestClosedTrade[];
  highWaterMarkUtcMs: number | null;
  rewound: boolean;
}
