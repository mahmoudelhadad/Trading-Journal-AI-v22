import { getFuturesInstrument } from '@constants/futuresInstruments.js';
import { REPLAY_SPEEDS, type ReplayTimeframe } from '@apptypes/replay.js';
import {
  BACKTEST_ACTION_VERSION, BACKTEST_FILL_BASIS, BACKTEST_SESSION_SCHEMA_VERSION,
  type BacktestAction, type BacktestClosedTrade, type BacktestEntryAction, type BacktestExitAction,
  type BacktestOpenPosition, type BacktestSession, type BacktestSessionProjection,
  type BacktestSessionSeries, type ExecutionFill, type SessionProgress,
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

/**
 * Exact rational arithmetic used by the B2c scaled-history fold.
 *
 * Invariants: `d > 0n` and `gcd(|n|, d) === 1n`. Values are internal only —
 * nothing here is persisted, and every rational is converted back to a Number
 * at the derived-projection boundary.
 */
interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const RATIONAL_ZERO: Rational = { n: 0n, d: 1n };
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const RATIONAL_NUMBER_DIGITS = 25;
const CANONICAL_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function bigIntGcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function normalizeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error('invalid_rational');
  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  if (n === 0n) return RATIONAL_ZERO;
  const divisor = bigIntGcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

/**
 * Converts a finite Number through its canonical round-trippable decimal
 * representation (including exponent notation such as `1e-7` / `1.5e+21`) into
 * an exact rational. No precision is lost or invented.
 */
function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new Error('invalid_rational');
  const match = CANONICAL_DECIMAL.exec(String(value));
  if (match === null) throw new Error('invalid_rational');
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const mantissa = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? normalizeRational(mantissa, 10n ** BigInt(scale))
    : normalizeRational(mantissa * 10n ** BigInt(-scale), 1n);
}

function rationalFromBigInt(value: bigint): Rational {
  return normalizeRational(value, 1n);
}

function rationalAdd(a: Rational, b: Rational): Rational {
  return normalizeRational(a.n * b.d + b.n * a.d, a.d * b.d);
}

function rationalSubtract(a: Rational, b: Rational): Rational {
  return normalizeRational(a.n * b.d - b.n * a.d, a.d * b.d);
}

function rationalMultiply(a: Rational, b: Rational): Rational {
  return normalizeRational(a.n * b.n, a.d * b.d);
}

function rationalDivide(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new Error('invalid_rational');
  return normalizeRational(a.n * b.d, a.d * b.n);
}

function rationalEqual(a: Rational, b: Rational): boolean {
  return a.n === b.n && a.d === b.d;
}

/** The single Rational → Number conversion point of the B2c scaled path. */
function rationalToNumber(value: Rational): number {
  if (value.n === 0n) return 0;
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  if (n <= MAX_SAFE_BIGINT && value.d <= MAX_SAFE_BIGINT) {
    const quotient = Number(n) / Number(value.d);
    return negative ? -quotient : quotient;
  }
  let remainder = n % value.d;
  let digits = '';
  for (let index = 0; index < RATIONAL_NUMBER_DIGITS; index += 1) {
    remainder *= 10n;
    digits += (remainder / value.d).toString();
    remainder %= value.d;
  }
  const parsed = Number(`${n / value.d}.${digits}`);
  return negative ? -parsed : parsed;
}

interface InstrumentRationals {
  tickSize: Rational;
  pointValue: Rational;
}

function instrumentRationals(root: 'NQ' | 'ES'): InstrumentRationals {
  const { tickSize, pointValue } = getFuturesInstrument(root);
  return { tickSize: rationalFromNumber(tickSize), pointValue: rationalFromNumber(pointValue) };
}

interface OpenEpisode {
  tradeId: string;
  side: 'long' | 'short';
  entries: BacktestEntryAction[];
  exits: BacktestExitAction[];
  initialStopPrice: number | null;
  /** Weighted-average basis of the remaining inventory only. */
  basis: Rational;
  remaining: bigint;
  totalEntered: bigint;
  totalExited: bigint;
  realized: Rational;
  anchoredRisk: Rational | null;
}

function entryAnchoredRisk(
  side: 'long' | 'short', price: Rational, stop: Rational, quantity: bigint, pointValue: Rational,
): Rational {
  const distance = side === 'long' ? rationalSubtract(price, stop) : rationalSubtract(stop, price);
  return rationalMultiply(rationalMultiply(rationalFromBigInt(quantity), distance), pointValue);
}

function openEpisodeFromEntry(action: BacktestEntryAction, instrument: InstrumentRationals): OpenEpisode {
  const price = rationalFromNumber(action.fill.price);
  const quantity = BigInt(action.quantity);
  return {
    tradeId: action.tradeId, side: action.side, entries: [action], exits: [],
    initialStopPrice: action.initialStopPrice, basis: price,
    remaining: quantity, totalEntered: quantity, totalExited: 0n, realized: RATIONAL_ZERO,
    anchoredRisk: action.initialStopPrice === null ? null
      : entryAnchoredRisk(action.side, price, rationalFromNumber(action.initialStopPrice), quantity, instrument.pointValue),
  };
}

function applyEpisodeEntry(episode: OpenEpisode, action: BacktestEntryAction, instrument: InstrumentRationals): OpenEpisode {
  const price = rationalFromNumber(action.fill.price);
  const quantity = BigInt(action.quantity);
  const nextRemaining = episode.remaining + quantity;
  // Only the CURRENT remaining inventory contributes the previous basis; exited
  // contracts never re-enter the average.
  const basis = rationalDivide(
    rationalAdd(
      rationalMultiply(rationalFromBigInt(episode.remaining), episode.basis),
      rationalMultiply(rationalFromBigInt(quantity), price),
    ),
    rationalFromBigInt(nextRemaining),
  );
  const commonStop = episode.initialStopPrice;
  return {
    ...episode,
    entries: [...episode.entries, action],
    basis,
    remaining: nextRemaining,
    totalEntered: episode.totalEntered + quantity,
    anchoredRisk: episode.anchoredRisk === null || commonStop === null ? null
      : rationalAdd(episode.anchoredRisk,
        entryAnchoredRisk(episode.side, price, rationalFromNumber(commonStop), quantity, instrument.pointValue)),
  };
}

function applyEpisodeExit(episode: OpenEpisode, action: BacktestExitAction, instrument: InstrumentRationals): OpenEpisode {
  const price = rationalFromNumber(action.fill.price);
  const quantity = BigInt(action.quantity);
  // Realize against the basis as it stands immediately before this Exit; the
  // basis of the contracts that remain open is untouched.
  const move = episode.side === 'long'
    ? rationalSubtract(price, episode.basis)
    : rationalSubtract(episode.basis, price);
  return {
    ...episode,
    exits: [...episode.exits, action],
    remaining: episode.remaining - quantity,
    totalExited: episode.totalExited + quantity,
    realized: rationalAdd(episode.realized,
      rationalMultiply(rationalMultiply(rationalFromBigInt(quantity), move), instrument.pointValue)),
  };
}

/**
 * Structural legacy predicate — deterministic and derived only from canonical
 * action history. Exactly one Entry closed by exactly one equal-quantity Exit
 * is the released v1.8.0 shape and keeps released IEEE-754 Number semantics;
 * anything else is a scaled history and uses exact rational arithmetic.
 */
function isLegacyStructuralEpisode(episode: OpenEpisode): boolean {
  return episode.entries.length === 1 && episode.exits.length === 1
    && episode.exits[0].quantity === episode.entries[0].quantity;
}

function weightedFillPrice(actions: readonly BacktestAction[], totalQuantity: bigint): Rational {
  const weighted = actions.reduce((sum, action) => rationalAdd(sum, rationalMultiply(
    rationalFromBigInt(BigInt(action.quantity)), rationalFromNumber(action.fill.price),
  )), RATIONAL_ZERO);
  return rationalDivide(weighted, rationalFromBigInt(totalQuantity));
}

function finalizeClosedTrade(root: 'NQ' | 'ES', episode: OpenEpisode, instrument: InstrumentRationals): BacktestClosedTrade {
  const entry = episode.entries[0];
  const exit = episode.exits[episode.exits.length - 1];
  if (isLegacyStructuralEpisode(episode)) return calculateClosedTrade(root, entry, exit);
  if (episode.totalEntered !== episode.totalExited) throw new Error('invalid_aggregate_economics');
  const weightedEntry = weightedFillPrice(episode.entries, episode.totalEntered);
  const weightedExit = weightedFillPrice(episode.exits, episode.totalExited);
  const points = episode.side === 'long'
    ? rationalSubtract(weightedExit, weightedEntry)
    : rationalSubtract(weightedEntry, weightedExit);
  const grossPL = rationalMultiply(
    rationalMultiply(points, rationalFromBigInt(episode.totalEntered)), instrument.pointValue,
  );
  // Exact conservation: aggregate fill economics must equal the sum of the
  // partial realizations, in rational form, before any Number conversion.
  if (!rationalEqual(grossPL, episode.realized)) throw new Error('invalid_aggregate_economics');
  const anchoredRisk = episode.anchoredRisk;
  return {
    tradeId: episode.tradeId, side: episode.side,
    entries: episode.entries, exits: episode.exits, entry, exit,
    quantity: Number(episode.totalEntered),
    weightedEntryPrice: rationalToNumber(weightedEntry),
    weightedExitPrice: rationalToNumber(weightedExit),
    points: rationalToNumber(points),
    ticks: rationalToNumber(rationalDivide(points, instrument.tickSize)),
    grossPL: rationalToNumber(grossPL),
    initialRisk: anchoredRisk === null ? null : rationalToNumber(anchoredRisk),
    rMultiple: anchoredRisk === null || anchoredRisk.n === 0n ? null
      : rationalToNumber(rationalDivide(grossPL, anchoredRisk)),
  };
}

function toOpenPosition(root: 'NQ' | 'ES', episode: OpenEpisode): BacktestOpenPosition {
  // A single Entry with no Exits is the released v1.8.0 open shape and keeps
  // released Number semantics for its basis and anchored risk.
  const legacyOpen = episode.entries.length === 1 && episode.exits.length === 0;
  const entry = episode.entries[0];
  const { pointValue } = getFuturesInstrument(root);
  const legacyRisk = entry.initialStopPrice === null ? null
    : Math.abs(entry.fill.price - entry.initialStopPrice) * pointValue * entry.quantity;
  return {
    tradeId: episode.tradeId, side: episode.side,
    entries: episode.entries, exits: episode.exits,
    totalEntryQuantity: Number(episode.totalEntered),
    totalExitedQuantity: Number(episode.totalExited),
    remainingQuantity: Number(episode.remaining),
    weightedAverageEntryPrice: legacyOpen ? entry.fill.price : rationalToNumber(episode.basis),
    realizedGrossPL: rationalToNumber(episode.realized),
    initialStopPrice: episode.initialStopPrice,
    anchoredRisk: episode.anchoredRisk === null ? null
      : legacyOpen ? legacyRisk : rationalToNumber(episode.anchoredRisk),
  };
}

export function calculateClosedTrade(root: 'NQ' | 'ES', entry: BacktestEntryAction, exit: Extract<BacktestAction, { kind: 'exit' }>): BacktestClosedTrade {
  const { tickSize, pointValue } = getFuturesInstrument(root);
  const points = entry.side === 'long' ? exit.fill.price - entry.fill.price : entry.fill.price - exit.fill.price;
  const riskDistance = entry.initialStopPrice === null ? null : Math.abs(entry.fill.price - entry.initialStopPrice);
  return {
    tradeId: entry.tradeId, side: entry.side, quantity: entry.quantity,
    entries: [entry], exits: [exit], entry, exit,
    weightedEntryPrice: entry.fill.price, weightedExitPrice: exit.fill.price,
    points, ticks: points / tickSize, grossPL: points * pointValue * entry.quantity,
    initialRisk: riskDistance === null ? null : riskDistance * pointValue * entry.quantity,
    rMultiple: riskDistance === null ? null : points / riskDistance,
  };
}

export function projectBacktestSession(session: BacktestSession, cursorUtcMs = session.cursorUtcMs): BacktestSessionProjection {
  const highWaterMarkUtcMs = session.actions.length === 0 ? null
    : Math.max(...session.actions.map((action) => action.fill.decisionUtcMs));
  const visibleActions = session.actions.filter((action) => action.fill.decisionUtcMs <= cursorUtcMs);
  const instrument = instrumentRationals(session.series.root);
  let episode: OpenEpisode | null = null;
  const closedTrades: BacktestClosedTrade[] = [];
  for (const action of visibleActions) {
    if (action.kind === 'entry') {
      episode = episode === null ? openEpisodeFromEntry(action, instrument) : applyEpisodeEntry(episode, action, instrument);
    } else if (episode !== null) {
      episode = applyEpisodeExit(episode, action, instrument);
      if (episode.remaining <= 0n) {
        closedTrades.push(finalizeClosedTrade(session.series.root, episode, instrument));
        episode = null;
      }
    }
  }
  return {
    visibleActions,
    openPosition: episode === null ? null : episode.entries[0],
    openAggregate: episode === null ? null : toOpenPosition(session.series.root, episode),
    closedTrades,
    highWaterMarkUtcMs,
    rewound: highWaterMarkUtcMs !== null && cursorUtcMs < highWaterMarkUtcMs,
  };
}

/**
 * Canonical B2c transition state for one open episode. Derived from action
 * history exactly like the aggregate projection — never from the legacy
 * `openPosition` compatibility view.
 */
interface EpisodeTransitionState {
  tradeId: string;
  side: 'long' | 'short';
  /** Immutable common stop anchored by the episode's first Entry. */
  initialStopPrice: number | null;
  remaining: number;
}

function openTransitionState(action: BacktestEntryAction): EpisodeTransitionState {
  return {
    tradeId: action.tradeId, side: action.side,
    initialStopPrice: action.initialStopPrice, remaining: action.quantity,
  };
}

/**
 * Applies a Scale In to an open episode, or returns null when the Entry breaks
 * the frozen contract: different tradeId, opposite side, or any change to the
 * common stop (changed value, removal, or introduction where there was none).
 * The per-Entry risk-side and tick-alignment rules are already enforced by
 * `validateBacktestAction`.
 */
function scaleTransitionState(open: EpisodeTransitionState, action: BacktestEntryAction): EpisodeTransitionState | null {
  if (action.tradeId !== open.tradeId || action.side !== open.side
    || action.initialStopPrice !== open.initialStopPrice) return null;
  const remaining = open.remaining + action.quantity;
  return Number.isSafeInteger(remaining) ? { ...open, remaining } : null;
}

export function validateBacktestSession(value: unknown): value is BacktestSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as BacktestSession;
  if (!hasExactKeys(value, SESSION_KEYS) || s.schemaVersion !== BACKTEST_SESSION_SCHEMA_VERSION || !isUuid(s.sessionId) || !isValidSessionSeries(s.series)
    || (s.status !== 'active' && s.status !== 'completed') || !isIsoUtc(s.createdAt) || !isIsoUtc(s.updatedAt)
    || !isUtcMs(s.startedAtReplayUtcMs) || !isProgressFields(s) || !Number.isSafeInteger(s.revision) || s.revision < 1
    || !Array.isArray(s.actions)) return false;
  let open: EpisodeTransitionState | null = null;
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
      if (open === null) {
        // Flat → Entry opens a new episode; a tradeId is never reopened.
        if (tradeIds.has(action.tradeId)) return false;
        tradeIds.add(action.tradeId);
        open = openTransitionState(action);
      } else {
        // Open → same-side Scale In under the same tradeId and common stop.
        const scaled = scaleTransitionState(open, action);
        if (scaled === null) return false;
        open = scaled;
      }
    } else {
      // Open → Exit of at most the remaining quantity; equality returns Flat.
      if (open === null || open.tradeId !== action.tradeId || action.quantity > open.remaining) return false;
      const remaining: number = open.remaining - action.quantity;
      const exited: EpisodeTransitionState = { ...open, remaining };
      open = remaining === 0 ? null : exited;
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
  // Canonical B2c transition state comes from the aggregate projection, never
  // from the legacy `openPosition` compatibility view.
  const current = projectBacktestSession(session, Number.MAX_SAFE_INTEGER).openAggregate;
  if (action.kind === 'entry') {
    if (current === null) {
      if (session.actions.some((existing) => existing.tradeId === action.tradeId)) throw new Error('invalid_transition');
    } else if (action.tradeId !== current.tradeId || action.side !== current.side
      || action.initialStopPrice !== current.initialStopPrice) throw new Error('invalid_transition');
  } else if (current === null || action.tradeId !== current.tradeId
    || action.quantity > current.remainingQuantity) throw new Error('invalid_transition');
  const next = { ...session, ...progress, updatedAt, revision: session.revision + 1, actions: [...session.actions, action] };
  if (!validateBacktestSession(next)) throw new Error('invalid_session');
  return next;
}

export function highWaterMark(session: BacktestSession): number | null {
  return projectBacktestSession(session).highWaterMarkUtcMs;
}
