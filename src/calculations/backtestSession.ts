import { getFuturesInstrument } from '@constants/futuresInstruments.js';
import { REPLAY_SPEEDS, type ReplayTimeframe } from '@apptypes/replay.js';
import {
  BACKTEST_ACTION_VERSION, BACKTEST_FILL_BASIS, BACKTEST_SESSION_SCHEMA_VERSION,
  type BacktestAction, type BacktestClosedTrade, type BacktestEntryAction,
  type BacktestSession, type BacktestSessionProjection, type BacktestSessionSeries,
  type ExecutionFill, type SessionProgress,
} from '@apptypes/backtestSession.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEFRAMES: ReplayTimeframe[] = ['1m', '5m', '15m', '1h'];
const SESSION_KEYS = ['schemaVersion', 'sessionId', 'series', 'status', 'createdAt', 'updatedAt', 'startedAtReplayUtcMs', 'cursorUtcMs', 'displayTimeframe', 'speed', 'revision', 'actions'] as const;
const SERIES_KEYS = ['root', 'expiryYear', 'expiryMonth', 'timeframe'] as const;
const PROGRESS_KEYS = ['cursorUtcMs', 'displayTimeframe', 'speed'] as const;
const FILL_KEYS = ['decisionUtcMs', 'sourceBarStartUtcMs', 'sourceBarCloseUtcMs', 'price', 'basis'] as const;
const ACTION_BASE_KEYS = ['actionVersion', 'actionId', 'tradeId', 'sessionId', 'sequence', 'quantity', 'fill', 'clientCreatedAt', 'kind'] as const;
const ENTRY_ACTION_KEYS = [...ACTION_BASE_KEYS, 'side', 'initialStopPrice'] as const;
const EXIT_ACTION_KEYS = ACTION_BASE_KEYS;

export type BacktestDomainFailure =
  | 'invalid_session' | 'invalid_action' | 'invalid_transition' | 'series_mismatch'
  | 'rewound' | 'completed' | 'position_open';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function hasExactKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isUtcMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProgressFields(value: unknown): value is SessionProgress {
  if (!value || typeof value !== 'object') return false;
  const p = value as SessionProgress;
  return isUtcMs(p.cursorUtcMs) && TIMEFRAMES.includes(p.displayTimeframe)
    && (REPLAY_SPEEDS as readonly number[]).includes(p.speed);
}

function isExactProgress(value: unknown): value is SessionProgress {
  return Boolean(value && typeof value === 'object' && hasExactKeys(value, PROGRESS_KEYS) && isProgressFields(value));
}

export function sameSessionSeries(a: BacktestSessionSeries, b: BacktestSessionSeries): boolean {
  return a.root === b.root && a.expiryYear === b.expiryYear && a.expiryMonth === b.expiryMonth && a.timeframe === b.timeframe;
}

export function isValidSessionSeries(value: unknown): value is BacktestSessionSeries {
  if (!value || typeof value !== 'object') return false;
  const s = value as BacktestSessionSeries;
  return hasExactKeys(value, SERIES_KEYS) && (s.root === 'NQ' || s.root === 'ES') && Number.isInteger(s.expiryYear)
    && s.expiryYear >= 2000 && s.expiryYear <= 2099 && Number.isInteger(s.expiryMonth)
    && s.expiryMonth >= 1 && s.expiryMonth <= 12 && s.timeframe === '1m';
}

function isTickAligned(price: number, tickSize: number): boolean {
  const ticks = price / tickSize;
  return Number.isSafeInteger(ticks);
}

export function validateExecutionFill(value: unknown): value is ExecutionFill {
  if (!value || typeof value !== 'object') return false;
  const f = value as ExecutionFill;
  return hasExactKeys(value, FILL_KEYS) && isUtcMs(f.decisionUtcMs) && isUtcMs(f.sourceBarStartUtcMs)
    && f.sourceBarCloseUtcMs === f.sourceBarStartUtcMs + 60_000
    && f.sourceBarCloseUtcMs <= f.decisionUtcMs
    && f.decisionUtcMs - f.sourceBarCloseUtcMs < 60_000
    && Number.isFinite(f.price) && f.price > 0 && f.basis === BACKTEST_FILL_BASIS;
}

export function validateBacktestAction(value: unknown, root?: 'NQ' | 'ES'): value is BacktestAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as BacktestAction;
  if (a.actionVersion !== BACKTEST_ACTION_VERSION || !isUuid(a.actionId) || !isUuid(a.tradeId)
    || !isUuid(a.sessionId) || !Number.isSafeInteger(a.sequence) || a.sequence < 1
    || !Number.isSafeInteger(a.quantity) || a.quantity < 1 || !validateExecutionFill(a.fill)
    || !isIsoUtc(a.clientCreatedAt) || (a.kind !== 'entry' && a.kind !== 'exit')) return false;
  if (a.kind === 'exit') {
    return hasExactKeys(value, EXIT_ACTION_KEYS);
  }
  if (!hasExactKeys(value, ENTRY_ACTION_KEYS)) return false;
  if (a.side !== 'long' && a.side !== 'short') return false;
  if (root === undefined) return a.initialStopPrice === null;
  return validateInitialStop(root, a.side, a.fill.price, a.initialStopPrice);
}

export function validateInitialStop(
  root: 'NQ' | 'ES',
  side: 'long' | 'short',
  entryPrice: number,
  initialStopPrice: number | null,
): boolean {
  if (initialStopPrice === null) return true;
  if (!Number.isFinite(initialStopPrice) || initialStopPrice <= 0) return false;
  const { tickSize } = getFuturesInstrument(root);
  return isTickAligned(initialStopPrice, tickSize) && initialStopPrice !== entryPrice
    && (side === 'long' ? initialStopPrice < entryPrice : initialStopPrice > entryPrice);
}

export function canonicalActionEqual(a: BacktestAction, b: BacktestAction): boolean {
  const base = a.actionVersion === b.actionVersion && a.actionId === b.actionId && a.tradeId === b.tradeId
    && a.sessionId === b.sessionId && a.sequence === b.sequence && a.kind === b.kind
    && a.quantity === b.quantity && a.clientCreatedAt === b.clientCreatedAt
    && a.fill.decisionUtcMs === b.fill.decisionUtcMs
    && a.fill.sourceBarStartUtcMs === b.fill.sourceBarStartUtcMs
    && a.fill.sourceBarCloseUtcMs === b.fill.sourceBarCloseUtcMs
    && a.fill.price === b.fill.price && a.fill.basis === b.fill.basis;
  if (!base || a.kind !== b.kind) return false;
  return a.kind === 'exit' || (b.kind === 'entry' && a.side === b.side && a.initialStopPrice === b.initialStopPrice);
}

export function calculateClosedTrade(root: 'NQ' | 'ES', entry: BacktestEntryAction, exit: Extract<BacktestAction, { kind: 'exit' }>): BacktestClosedTrade {
  const { tickSize, pointValue } = getFuturesInstrument(root);
  const points = entry.side === 'long' ? exit.fill.price - entry.fill.price : entry.fill.price - exit.fill.price;
  const riskDistance = entry.initialStopPrice === null ? null : Math.abs(entry.fill.price - entry.initialStopPrice);
  return {
    tradeId: entry.tradeId, side: entry.side, quantity: entry.quantity, entry, exit,
    points, ticks: points / tickSize, grossPL: points * pointValue * entry.quantity,
    initialRisk: riskDistance === null ? null : riskDistance * pointValue * entry.quantity,
    rMultiple: riskDistance === null ? null : points / riskDistance,
  };
}

export function projectBacktestSession(session: BacktestSession, cursorUtcMs = session.cursorUtcMs): BacktestSessionProjection {
  const highWaterMarkUtcMs = session.actions.length === 0 ? null
    : Math.max(...session.actions.map((action) => action.fill.decisionUtcMs));
  const visibleActions = session.actions.filter((action) => action.fill.decisionUtcMs <= cursorUtcMs);
  let openPosition: BacktestEntryAction | null = null;
  const closedTrades: BacktestClosedTrade[] = [];
  for (const action of visibleActions) {
    if (action.kind === 'entry') openPosition = action;
    else if (openPosition !== null) {
      closedTrades.push(calculateClosedTrade(session.series.root, openPosition, action));
      openPosition = null;
    }
  }
  return { visibleActions, openPosition, closedTrades, highWaterMarkUtcMs, rewound: highWaterMarkUtcMs !== null && cursorUtcMs < highWaterMarkUtcMs };
}

export function validateBacktestSession(value: unknown): value is BacktestSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as BacktestSession;
  if (!hasExactKeys(value, SESSION_KEYS) || s.schemaVersion !== BACKTEST_SESSION_SCHEMA_VERSION || !isUuid(s.sessionId) || !isValidSessionSeries(s.series)
    || (s.status !== 'active' && s.status !== 'completed') || !isIsoUtc(s.createdAt) || !isIsoUtc(s.updatedAt)
    || !isUtcMs(s.startedAtReplayUtcMs) || !isProgressFields(s) || !Number.isSafeInteger(s.revision) || s.revision < 1
    || !Array.isArray(s.actions)) return false;
  let open: BacktestEntryAction | null = null;
  let priorDecisionUtcMs = -1;
  const actionIds = new Set<string>();
  const tradeIds = new Set<string>();
  for (let index = 0; index < s.actions.length; index += 1) {
    const action = s.actions[index];
    if (!validateBacktestAction(action, s.series.root) || action.sessionId !== s.sessionId || action.sequence !== index + 1) return false;
    if (actionIds.has(action.actionId)) return false;
    actionIds.add(action.actionId);
    if (action.fill.decisionUtcMs < priorDecisionUtcMs) return false;
    priorDecisionUtcMs = action.fill.decisionUtcMs;
    if (action.kind === 'entry') {
      if (open !== null || tradeIds.has(action.tradeId)) return false;
      tradeIds.add(action.tradeId);
      open = action;
    } else {
      if (open === null || open.tradeId !== action.tradeId || open.quantity !== action.quantity) return false;
      open = null;
    }
  }
  return s.status !== 'completed' || open === null;
}

export function createBacktestSession(input: {
  sessionId: string; series: BacktestSessionSeries; progress: SessionProgress; createdAt: string;
}): BacktestSession {
  const session: BacktestSession = {
    schemaVersion: 1, sessionId: input.sessionId, series: { ...input.series }, status: 'active',
    createdAt: input.createdAt, updatedAt: input.createdAt, startedAtReplayUtcMs: input.progress.cursorUtcMs,
    ...input.progress, revision: 1, actions: [],
  };
  if (!validateBacktestSession(session)) throw new Error('invalid_session');
  return session;
}

export function appendBacktestAction(session: BacktestSession, action: BacktestAction, progress: SessionProgress, updatedAt: string): BacktestSession {
  if (session.status === 'completed') throw new Error('completed');
  if (!validateBacktestSession(session) || !isExactProgress(progress) || !isIsoUtc(updatedAt)
    || !validateBacktestAction(action, session.series.root) || action.sessionId !== session.sessionId
    || action.sequence !== session.actions.length + 1) throw new Error('invalid_action');
  if (projectBacktestSession(session, progress.cursorUtcMs).rewound) throw new Error('rewound');
  if (action.fill.decisionUtcMs !== progress.cursorUtcMs) throw new Error('invalid_action');
  const existingHighWater = session.actions.length === 0 ? null : Math.max(...session.actions.map((item) => item.fill.decisionUtcMs));
  if (existingHighWater !== null && action.fill.decisionUtcMs < existingHighWater) throw new Error('rewound');
  const current = projectBacktestSession(session, Number.MAX_SAFE_INTEGER).openPosition;
  if ((action.kind === 'entry' && current !== null) || (action.kind === 'exit' && (current === null
    || current.tradeId !== action.tradeId || current.quantity !== action.quantity))) throw new Error('invalid_transition');
  const next = { ...session, ...progress, updatedAt, revision: session.revision + 1, actions: [...session.actions, action] };
  if (!validateBacktestSession(next)) throw new Error('invalid_session');
  return next;
}

export function highWaterMark(session: BacktestSession): number | null {
  return projectBacktestSession(session).highWaterMarkUtcMs;
}
