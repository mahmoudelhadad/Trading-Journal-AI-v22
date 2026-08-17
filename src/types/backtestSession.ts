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

/**
 * Derived-only B2c aggregates. These are projected from canonical Entry/Exit
 * actions on every read and are never persisted: schemaVersion stays 1,
 * actionVersion stays 1, and the persisted action shapes above are unchanged.
 */
export interface BacktestOpenPosition {
  tradeId: string;
  side: 'long' | 'short';
  entries: BacktestEntryAction[];
  exits: BacktestExitAction[];
  totalEntryQuantity: number;
  totalExitedQuantity: number;
  remainingQuantity: number;
  /** Moving weighted-average basis of the currently remaining inventory only. */
  weightedAverageEntryPrice: number;
  realizedGrossPL: number;
  /** Common stop anchored by the first Entry of the episode. */
  initialStopPrice: number | null;
  anchoredRisk: number | null;
}

export interface BacktestClosedTrade {
  tradeId: string;
  side: 'long' | 'short';
  entries: BacktestEntryAction[];
  exits: BacktestExitAction[];
  /** Legacy v1.8.0 compatibility view: the opening Entry (`entries[0]`). */
  entry: BacktestEntryAction;
  /** Legacy v1.8.0 compatibility view: the closing Exit (last of `exits`). */
  exit: BacktestExitAction;
  quantity: number;
  weightedEntryPrice: number;
  weightedExitPrice: number;
  points: number;
  ticks: number;
  grossPL: number;
  initialRisk: number | null;
  rMultiple: number | null;
}

export interface BacktestSessionProjection {
  visibleActions: BacktestAction[];
  /**
   * Legacy v1.8.0 compatibility view of the open episode: its first Entry
   * action. Retained so released consumers keep compiling; `openAggregate` is
   * the B2c-complete view.
   */
  openPosition: BacktestEntryAction | null;
  openAggregate: BacktestOpenPosition | null;
  closedTrades: BacktestClosedTrade[];
  highWaterMarkUtcMs: number | null;
  rewound: boolean;
}
