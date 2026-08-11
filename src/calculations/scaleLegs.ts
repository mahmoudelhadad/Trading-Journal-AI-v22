/**
 * calculations/scaleLegs.ts
 *
 * Manual Scale In / Scale Out — pure domain + exact arithmetic.
 *
 * This module is the LOWER-LEVEL half of the manual-scale feature. It
 * owns leg ordering, position folding, exact weighted-average
 * derivation, the leg-editing reducer, and save-candidate
 * construction. It is pure: no React, no DOM, no storage, no I/O.
 *
 * FROZEN DEPENDENCY DIRECTION (RFC §15):
 *   scaleLegs.ts  MUST NOT import services/tradeValidation.ts
 *   tradeValidation.ts  MAY import ordering/folding helpers from here
 *   components/trade/TradeForm.tsx  orchestrates validate -> build ->
 *     validate -> save
 * `buildScaledTradeCandidate()` is therefore a pure TRANSFORMATION
 * only. It never validates. Validation orchestration lives in the
 * form, so this module can never participate in an import cycle.
 *
 * EXACT ARITHMETIC (RFC §16):
 * Weighted averages use bigint throughout — never `Number` — because
 * float64 accumulation produces artefacts like 1.0834633333333335 on
 * ordinary 5-decimal forex prices. This reuses the TECHNIQUE
 * established by services/ninjaTraderAdapter.ts in v1.2 (scaled
 * integers + long division with trimmed decimal output); it does NOT
 * import from that file, which stays frozen. The scales are wider here
 * than the adapter's `PRICE_SCALE = 10_000n`, because the adapter only
 * ever handled 4-decimal futures prices while manual entry must also
 * express 5-decimal forex prices and 0.01-lot quantities.
 *
 * POSITION SEMANTICS (RFC §9):
 * `positionSize` is TOTAL ENTRY-SIDE TRANSACTED QUANTITY, not peak
 * simultaneous exposure. For `Entry 2 -> Exit 1 -> Entry 1 -> Exit 2`
 * it is 3, even though exposure never exceeded 2. This is not a legacy
 * quirk: it is the only multiplier that makes calculations/tradeCalc.ts
 * `calcPL()` correct against a weighted-average entry and exit, since
 *   size * (wavgExit - wavgEntry) == exact realized value difference
 * only when `size` is the entry-side total. It also matches what
 * services/ninjaTraderAdapter.ts already persists for imported trades.
 */

import type { RawTradeContent, TradeLeg } from '@apptypes/trade.js';

// ─── Scales ───────────────────────────────────────────────────

/** Decimal places retained for prices. Covers 5-decimal forex (EUR/USD) with headroom. */
export const PRICE_DECIMALS = 8;
/** Decimal places retained for quantities. Covers 0.01-lot forex granularity with headroom. */
export const QTY_DECIMALS = 4;

const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);

/** Maximum fractional digits emitted by a derived decimal string. Matches the v1.2 adapter. */
const MAX_FRACTION_DIGITS = 10;

// ─── Types ────────────────────────────────────────────────────

/** The five aggregate fields a manual scaled trade derives from its legs. */
export interface ScaleAggregates {
  positionSize: string;
  entryPrice:   string;
  exitPrice:    string;
  entryTime:    string;
  exitTime:     string;
}

/** One step of the chronological position fold. */
export interface FoldStep {
  leg: TradeLeg;
  /** Open quantity AFTER this leg, at QTY_SCALE. Null when the leg quantity is unparseable. */
  openScaled: bigint | null;
}

export interface PositionFold {
  /** Steps in canonical order. */
  steps: FoldStep[];
  /**
   * True ONLY when every leg quantity parsed exactly, i.e. when the
   * totals and indices below are meaningful. When false the fold says
   * nothing at all about balance — see `ok` handling in
   * services/tradeValidation.ts.
   */
  ok: boolean;
  /** Canonical index of the first leg whose quantity could not be parsed, or -1. */
  unparseableIndex: number;
  entryQtyScaled: bigint;
  exitQtyScaled:  bigint;
  /** Canonical index of the first exit removing more than is open, or -1. */
  overExitIndex: number;
  /** Canonical index of a leg returning the position to flat before the final leg, or -1. */
  earlyFlatIndex: number;
}

export type ScaleLegsAction =
  | { type: 'addEntry' }
  | { type: 'addExit' }
  | { type: 'updateLeg'; index: number; field: 'quantity' | 'price' | 'time'; value: string }
  | { type: 'removeLeg'; index: number };

// ─── Parsing / formatting helpers (exact, bigint) ─────────────

/** A value accepted by the single manual-scale decimal grammar. */
export interface ParsedDecimal {
  integerText:  string;
  fractionText: string;
}

/**
 * THE single numeric grammar for manual scale legs.
 *
 * Every layer — manual validation, decimal-place limits, bigint
 * parsing, position folding and aggregate derivation — goes through
 * this one function, so they cannot disagree. `Number()` is
 * deliberately NOT the authority anywhere in the scale path: it
 * accepts forms this grammar rejects (`1e2`, `Infinity`, `0x1F`), and
 * a validator/parser split of exactly that kind is what allowed an
 * unparseable quantity to reach the save pipeline.
 *
 * ACCEPTS ordinary decimal notation, with an optional leading `+` and
 * an optional leading `0`:
 *   '1'  '1.25'  '0.5'  '.5'  '+0.5'  '+.5'
 * REJECTS everything else, including:
 *   exponent form ('1e2', '1E2', '1e-2'), 'NaN', 'Infinity',
 *   hexadecimal ('0x1F'), negatives, trailing junk ('1.', '1px'),
 *   thousands separators, and the empty string.
 *
 * Journal execution data is ordinary decimal money/quantity text; there
 * is no exponent normalization here by design.
 */
export function parseDecimal(value: unknown): ParsedDecimal | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\+?(?:(\d+)(?:\.(\d+))?|\.(\d+))$/);
  if (!match) return null;
  return {
    integerText:  match[1] ?? '0',
    fractionText: match[2] ?? match[3] ?? '',
  };
}

/**
 * Parse a decimal string into a scaled bigint, or null when the value
 * is malformed or carries more precision than `decimals` allows.
 */
export function parseScaled(value: unknown, decimals: number): bigint | null {
  const parsed = parseDecimal(value);
  if (parsed === null || parsed.fractionText.length > decimals) return null;
  const fraction = parsed.fractionText.padEnd(decimals, '0');
  return BigInt(parsed.integerText) * (10n ** BigInt(decimals))
    + BigInt(fraction === '' ? '0' : fraction);
}

/** Count decimal places in a numeric string, or null when malformed. */
export function decimalPlaces(value: unknown): number | null {
  return parseDecimal(value)?.fractionText.length ?? null;
}

/**
 * Exact decimal string for `numerator / denominator`, trimmed.
 * Long division on bigints — the same shape as the v1.2 adapter's
 * `formatWeightedAverage`, reimplemented here rather than imported so
 * services/ninjaTraderAdapter.ts stays untouched.
 */
export function formatExactQuotient(
  numerator: bigint,
  denominator: bigint,
  maxFractionDigits: number = MAX_FRACTION_DIGITS,
): string | null {
  if (denominator <= 0n) return null;
  const integerPart = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder === 0n) return integerPart.toString();
  let fraction = '';
  for (let index = 0; index < maxFractionDigits && remainder !== 0n; index++) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString();
    remainder %= denominator;
  }
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? integerPart.toString() : `${integerPart}.${trimmed}`;
}

// ─── Time helpers ─────────────────────────────────────────────

/**
 * Comparable, storage-shaped time key.
 *
 * Manual entry collects `HH:mm` (the native time input's granularity)
 * and stores `HH:mm:00`. That trailing `:00` is the storage form, NOT
 * a fabricated distinguishing value: two manual legs in the same
 * minute both legitimately store `:00` and are separated only by their
 * position in the array. Imported legs already carry real `HH:mm:ss`
 * seconds and pass through untouched.
 */
export function legTimeKey(time: unknown): string {
  if (typeof time !== 'string') return '';
  const text = time.trim();
  return /^\d{2}:\d{2}$/.test(text) ? `${text}:00` : text;
}

/** True for a valid `HH:mm` wall-clock time (the manual UI's input shape). */
export function isManualLegTime(time: unknown): boolean {
  return typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time.trim().slice(0, 5))
    && (/^\d{2}:\d{2}$/.test(time.trim()) || /^\d{2}:\d{2}:\d{2}$/.test(time.trim()));
}

// ─── Trade shape predicates ───────────────────────────────────

/**
 * True when the trade's legs came from a broker import.
 *
 * Imported trades never enter manual canonicalization, date
 * propagation, or aggregate derivation — their legs are source
 * executions and must survive byte-for-byte (RFC §13).
 */
export function isImportedTrade(trade: Pick<RawTradeContent, 'sourcePlatform'>): boolean {
  return typeof trade.sourcePlatform === 'string' && trade.sourcePlatform.trim() !== '';
}

/** True when the trade carries manually entered legs the form owns. */
export function hasManualLegs(
  trade: Pick<RawTradeContent, 'legs' | 'sourcePlatform'>,
): boolean {
  return Array.isArray(trade.legs) && trade.legs.length > 0 && !isImportedTrade(trade);
}

// ─── Canonical ordering ───────────────────────────────────────

/**
 * Canonical manual leg order (RFC §B, frozen):
 *   1. `time` ascending
 *   2. for equal time, PRESERVE THE EXISTING ARRAY ORDER
 *
 * Rule 2 is deliberately self-referential rather than "original
 * insertion order": `Array.prototype.sort` is stable, so it preserves
 * the order of the array being sorted, which after any earlier
 * re-sort is no longer insertion order. Defining the tie-break against
 * the CURRENT array makes the rule deterministic and idempotent with
 * no sequence field, no hidden insertion ID, and no fabricated
 * seconds. After a save, the persisted array order becomes the
 * tie-break reference for later edits.
 */
export function canonicalLegOrder(legs: readonly TradeLeg[]): TradeLeg[] {
  return [...legs].sort((left, right) => {
    const a = legTimeKey(left.time);
    const b = legTimeKey(right.time);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ─── Position folding ─────────────────────────────────────────

/**
 * Fold legs chronologically, tracking the open position after each.
 *
 * Reports the two structural violations the manual validator needs:
 * exiting more than is open (V7) and returning to flat before the
 * final leg (V8 — a second trade, not a scale-out). Both mirror the
 * episode boundary rules services/ninjaTraderAdapter.ts already
 * enforces for imported fills.
 */
export function foldPosition(legs: readonly TradeLeg[]): PositionFold {
  const ordered = canonicalLegOrder(legs);
  const steps: FoldStep[] = [];
  let open = 0n;
  let entryQtyScaled = 0n;
  let exitQtyScaled = 0n;
  let overExitIndex = -1;
  let earlyFlatIndex = -1;
  let unparseableIndex = -1;
  let broken = false;

  ordered.forEach((leg, index) => {
    const quantity = parseScaled(leg.quantity, QTY_DECIMALS);
    if (quantity === null || quantity <= 0n || broken) {
      // FAIL CLOSED. A quantity that cannot be parsed is NOT zero.
      // Treating it as zero was the latent hazard behind the vacuous
      // `0n === 0n` balance pass: two unparseable legs left both totals
      // at zero, so the episode looked perfectly balanced. Once broken,
      // every later step is unknown too, and `ok` is false, so no
      // caller may read the totals as meaningful.
      if (unparseableIndex === -1) unparseableIndex = index;
      broken = true;
      steps.push({ leg, openScaled: null });
      return;
    }
    if (leg.kind === 'entry') {
      entryQtyScaled += quantity;
      open += quantity;
    } else {
      exitQtyScaled += quantity;
      if (quantity > open && overExitIndex === -1) overExitIndex = index;
      open -= quantity;
    }
    steps.push({ leg, openScaled: open });
    if (open === 0n && index < ordered.length - 1 && earlyFlatIndex === -1) {
      earlyFlatIndex = index;
    }
  });

  return {
    steps,
    ok: unparseableIndex === -1 && ordered.length > 0,
    unparseableIndex,
    entryQtyScaled,
    exitQtyScaled,
    overExitIndex,
    earlyFlatIndex,
  };
}

/**
 * True when a quantity string represents a whole unit.
 * Value-based, not representation-based: '2', '2.0' and '2.0000' all
 * qualify, while '2.5' does not.
 */
export function isWholeQuantity(value: unknown): boolean {
  const scaled = parseScaled(value, QTY_DECIMALS);
  return scaled !== null && scaled % QTY_SCALE === 0n;
}

/** Currently open quantity as a trimmed decimal string ('' when unavailable). */
export function openQuantityText(legs: readonly TradeLeg[]): string {
  const fold = foldPosition(legs);
  const last = fold.steps[fold.steps.length - 1];
  if (!last || last.openScaled === null) return '';
  return formatExactQuotient(last.openScaled, QTY_SCALE) ?? '';
}

// ─── Aggregate derivation ─────────────────────────────────────

const EMPTY_AGGREGATES: ScaleAggregates = {
  positionSize: '',
  entryPrice:   '',
  exitPrice:    '',
  entryTime:    '',
  exitTime:     '',
};

/**
 * Derive the five owned aggregate fields from legs.
 *
 * FORMULAS (RFC §10). With entry legs (qi, pi) and exit legs (rj, sj)
 * parsed to bigint at QTY_SCALE / PRICE_SCALE:
 *
 *   entryQtyScaled   = Sum qi                        scale 1e4
 *   entryValueScaled = Sum (pi * qi)                 scale 1e12
 *   exitValueScaled  = Sum (sj * rj)                 scale 1e12
 *
 *   positionSize = entryQtyScaled / QTY_SCALE
 *   entryPrice   = entryValueScaled / (entryQtyScaled * PRICE_SCALE)
 *   exitPrice    = exitValueScaled  / (entryQtyScaled * PRICE_SCALE)
 *   entryTime    = earliest entry leg time, 'HH:mm'
 *   exitTime     = latest exit leg time, 'HH:mm'
 *
 * The exit average uses the ENTRY-side divisor, matching
 * services/ninjaTraderAdapter.ts's `episodeToTrade`. The two sides are
 * equal for any saveable trade (V9 requires it), so this is only
 * observable mid-edit — and while the episode is still unbalanced the
 * exit average is not yet meaningful, so it is reported as '' rather
 * than as a misleading number. This is the "blank/partial derived
 * state" the live preview requires: never a stale pre-scale value.
 *
 * Total function — an incomplete or malformed episode yields blanks
 * instead of throwing, because the form calls this on every keystroke.
 */
export function deriveAggregatesFromLegs(legs: readonly TradeLeg[]): ScaleAggregates {
  if (!Array.isArray(legs) || legs.length === 0) return { ...EMPTY_AGGREGATES };

  const ordered = canonicalLegOrder(legs);
  const result: ScaleAggregates = { ...EMPTY_AGGREGATES };

  let entryQtyScaled = 0n;
  let exitQtyScaled = 0n;
  let entryValueScaled = 0n;
  let exitValueScaled = 0n;
  let entryValid = true;
  let exitValid = true;
  let hasEntry = false;
  let hasExit = false;
  let entryTime = '';
  let exitTime = '';

  for (const leg of ordered) {
    const quantity = parseScaled(leg.quantity, QTY_DECIMALS);
    const price = parseScaled(leg.price, PRICE_DECIMALS);
    const valid = quantity !== null && quantity > 0n && price !== null && price > 0n;
    const time = legTimeKey(leg.time);

    if (leg.kind === 'entry') {
      hasEntry = true;
      if (!valid) { entryValid = false; continue; }
      entryQtyScaled += quantity as bigint;
      entryValueScaled += (price as bigint) * (quantity as bigint);
      if (time !== '' && (entryTime === '' || time < entryTime)) entryTime = time;
    } else {
      hasExit = true;
      if (!valid) { exitValid = false; continue; }
      exitQtyScaled += quantity as bigint;
      exitValueScaled += (price as bigint) * (quantity as bigint);
      if (time !== '' && time > exitTime) exitTime = time;
    }
  }

  if (hasEntry && entryValid && entryQtyScaled > 0n) {
    result.positionSize = formatExactQuotient(entryQtyScaled, QTY_SCALE) ?? '';
    result.entryPrice = formatExactQuotient(entryValueScaled, entryQtyScaled * PRICE_SCALE) ?? '';
    result.entryTime = entryTime.slice(0, 5);
  }
  // Exit average is only meaningful once the episode balances; see above.
  if (hasExit && exitValid && entryValid && exitQtyScaled > 0n && exitQtyScaled === entryQtyScaled) {
    result.exitPrice = formatExactQuotient(exitValueScaled, entryQtyScaled * PRICE_SCALE) ?? '';
  }
  if (hasExit && exitTime !== '') {
    result.exitTime = exitTime.slice(0, 5);
  }
  return result;
}

// ─── Leg editing (pure reducer) ───────────────────────────────

/**
 * A brand-new manual leg.
 *
 * NOTE the shape: `sourceExecutionId` is ABSENT, not `undefined`. A
 * manual leg has no broker execution behind it, so it carries no
 * execution ID at all. Writing `sourceExecutionId: undefined` would
 * create the property (visible to `hasOwnProperty`, and serialized by
 * services/syncMappers.ts) and would be a quiet lie about provenance.
 */
export function createManualLeg(kind: 'entry' | 'exit', date: string): TradeLeg {
  return { kind, quantity: '', price: '', date, time: '' };
}

/**
 * Pure leg-editing transitions over the trade object.
 *
 * EDITING ORDER IS PRESERVED. No action here reorders `legs` — rows stay
 * in the order the user built them, so nothing moves under the cursor
 * mid-entry. Chronological order is a CALCULATION concern, applied on a
 * copy by `foldPosition`/`deriveAggregatesFromLegs` and materialized for
 * persistence only by `buildScaledTradeCandidate`. A reordering action
 * deliberately does not exist: one used to, driven from the section's
 * blur handler, and it was the cause of rows visibly jumping while a
 * trader was still typing.
 *
 * Removing the FINAL leg deletes the `legs` property outright rather
 * than leaving `legs: []`. That distinction is load-bearing, not
 * cosmetic: services/tradeValidation.ts gates on
 * `hasOwnProperty('legs')`, services/syncMappers.ts serializes the
 * property whenever it exists, and services/backupService.test.ts
 * asserts a legless trade round-trips WITHOUT the property.
 */
export function scaleLegsReducer<T extends RawTradeContent>(trade: T, action: ScaleLegsAction): T {
  const legs = Array.isArray(trade.legs) ? trade.legs : [];

  switch (action.type) {
    case 'addEntry':
      return { ...trade, legs: [...legs, createManualLeg('entry', trade.date)] };

    case 'addExit':
      return { ...trade, legs: [...legs, createManualLeg('exit', trade.date)] };

    case 'updateLeg': {
      if (action.index < 0 || action.index >= legs.length) return trade;
      const next = legs.map((leg, index) => (
        index === action.index ? { ...leg, [action.field]: action.value } : leg
      ));
      return { ...trade, legs: next };
    }

    case 'removeLeg': {
      if (action.index < 0 || action.index >= legs.length) return trade;
      const next = legs.filter((_, index) => index !== action.index);
      if (next.length === 0) {
        const cleared = { ...trade };
        delete cleared.legs;
        return cleared;
      }
      return { ...trade, legs: next };
    }

    default:
      return trade;
  }
}

// ─── Save-candidate construction ──────────────────────────────

/**
 * Build the object that will be validated and then persisted.
 *
 * PURE TRANSFORMATION ONLY — it never calls a validator (RFC §15).
 * components/trade/TradeForm.tsx owns the orchestration:
 *   validateManualScaleLegs -> buildScaledTradeCandidate ->
 *   validateTradeContent -> onSave
 * and the SAME candidate that passes final validation is the object
 * handed to `onSave`. Validating stale editable aggregates and
 * deriving afterwards would persist values that were never validated.
 *
 * For a manual scaled trade this canonicalizes leg order, propagates
 * the logical trade date onto every leg (the Scale UI has no per-leg
 * date input, and a trade has exactly one date by construction —
 * v1.2 rejects overnight positions and `parseDurMins` reads a single
 * `date`), normalizes manual times to 'HH:mm:00', and derives the five
 * aggregates.
 *
 * For an imported trade it returns the input UNCHANGED: no reorder, no
 * date propagation, no time rewrite, no `sourceExecutionId` rewrite.
 * Trades with no legs are likewise returned unchanged, preserving the
 * existing v1.2 save path exactly.
 */
export function buildScaledTradeCandidate<T extends RawTradeContent>(trade: T): T {
  if (!hasManualLegs(trade)) return trade;

  const ordered = canonicalLegOrder(trade.legs as TradeLeg[]).map((leg) => ({
    ...leg,
    date: trade.date,
    time: legTimeKey(leg.time),
  }));

  return { ...trade, ...deriveAggregatesFromLegs(ordered), legs: ordered };
}
