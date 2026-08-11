import { isSupportedSymbol } from '@constants/pipValues.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';
// Ordering/folding/parsing helpers only. The dependency direction is
// frozen one-way (RFC §15): this file may import from scaleLegs.ts, and
// scaleLegs.ts must never import from here, so no cycle is possible.
import {
  PRICE_DECIMALS,
  QTY_DECIMALS,
  foldPosition,
  formatExactQuotient,
  isImportedTrade,
  isManualLegTime,
  isWholeQuantity,
  legTimeKey,
  parseDecimal,
  parseScaled,
} from '@calculations/scaleLegs.js';

export type TradeValidationError = string;

const POSITIVE_FIELDS = [
  ['entryPrice', 'Entry price'],
  ['stopLoss', 'Stop loss'],
  ['target', 'Target'],
  ['exitPrice', 'Exit price'],
  ['positionSize', 'Position size'],
] as const;

const TIME_FIELDS = [
  ['entryTime', 'Entry'],
  ['exitTime', 'Exit'],
] as const;

export const activeAccounts = (accounts: readonly Account[]): Account[] =>
  accounts.filter((account) => account.deletedAt == null);

export function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isCanonicalTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

export function isFiniteNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

export function validateTradeContent(
  trade: Partial<RawTradeContent>,
  accounts: readonly Account[],
  options: { requireIdentity?: boolean } = {},
): TradeValidationError[] {
  const errors: string[] = [];
  const currentAccounts = activeAccounts(accounts);

  if (options.requireIdentity && (!(typeof trade._tid === 'number') || !Number.isFinite(trade._tid) || trade._tid <= 0)) {
    errors.push('trade identity must be a finite positive number.');
  }
  if (typeof trade.accountId !== 'string' || !currentAccounts.some((account) => account.id === trade.accountId)) {
    errors.push('select an active account.');
  }
  if (!isCanonicalDate(trade.date)) errors.push('enter a valid YYYY-MM-DD date.');
  if (typeof trade.symbol !== 'string' || !isSupportedSymbol(trade.symbol)) {
    errors.push('select a supported symbol.');
  }

  for (const [field, label] of POSITIVE_FIELDS) {
    const value = trade[field];
    if (!isBlank(value) && (!isFiniteNumeric(value) || Number(value) <= 0)) {
      errors.push(`${label} must be a finite number greater than zero.`);
    }
  }
  if (!isBlank(trade.commission) && !isFiniteNumeric(trade.commission)) {
    errors.push('Commission must be a finite number.');
  }
  for (const [field, label] of TIME_FIELDS) {
    const value = trade[field];
    if (!isBlank(value) && !isCanonicalTime(value)) errors.push(`${label} time must use HH:mm.`);
  }

  const hasDirectionalInputs = ['entryPrice', 'stopLoss', 'target', 'exitPrice', 'positionSize']
    .some((field) => !isBlank(trade[field as keyof RawTradeContent]));
  const directionPresent = !isBlank(trade.direction);
  if ((hasDirectionalInputs || directionPresent) && trade.direction !== 'Long' && trade.direction !== 'Short') {
    errors.push('direction must be Long or Short when trade prices are entered.');
  }

  if (Object.prototype.hasOwnProperty.call(trade, 'legs')) {
    if (!Array.isArray(trade.legs)) {
      errors.push('legs must be an array.');
    } else {
      for (const leg of trade.legs) {
        if (leg == null || typeof leg !== 'object') {
          errors.push('each leg must be an object.');
          continue;
        }
        if (leg.kind !== 'entry' && leg.kind !== 'exit') {
          errors.push('leg kind must be entry or exit.');
        }
        if (typeof leg.quantity !== 'string' || !isFiniteNumeric(leg.quantity) || Number(leg.quantity) <= 0) {
          errors.push('leg quantity must be a numeric string greater than zero.');
        }
        if (typeof leg.price !== 'string' || !isFiniteNumeric(leg.price) || Number(leg.price) <= 0) {
          errors.push('leg price must be a numeric string greater than zero.');
        }
        if (!isCanonicalDate(leg.date)) {
          errors.push('leg date must be a valid YYYY-MM-DD date.');
        }
        if (typeof leg.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(leg.time)) {
          errors.push('leg time must use HH:mm:ss.');
        }
        // RELAXED for manual scale entry: a manually entered leg has no
        // broker execution behind it, so it carries NO `sourceExecutionId`
        // property at all — that absence is the provenance statement, and
        // fabricating a digits-only ID would be a lie. When the property IS
        // present (every imported leg) it must still be a real digits-only
        // ID. This widens the accepted set and never narrows it, which
        // matters because validateTradeContent also gates backup restore
        // (services/backupService.ts) — existing v1.2 backups must keep
        // restoring unchanged.
        if (Object.prototype.hasOwnProperty.call(leg, 'sourceExecutionId')
          && (typeof leg.sourceExecutionId !== 'string' || !/^\d+$/.test(leg.sourceExecutionId))) {
          errors.push('leg source execution ID must be a non-empty digits-only string.');
        }
      }
    }
  }

  const optionalSourceFields = [
    ['sourceInstrument', 'Source instrument'],
    ['sourcePlatform', 'Source platform'],
    ['sourceAccountId', 'Source account ID'],
  ] as const;
  for (const [field, label] of optionalSourceFields) {
    if (Object.prototype.hasOwnProperty.call(trade, field)
      && (typeof trade[field] !== 'string' || trade[field].trim() === '')) {
      errors.push(`${label} must be a non-blank string.`);
    }
  }
  return errors;
}

export function toManualSaveMessage(errors: readonly string[]): string | null {
  return errors.length ? `Trade not saved: ${errors[0]}` : null;
}

/**
 * Manual Scale In / Scale Out invariants — V1..V10, manual legs only.
 *
 * Deliberately SEPARATE from `validateTradeContent`, which is a shared
 * boundary used by manual save, generic import, NinjaTrader import AND
 * backup restore (services/backupService.ts). Adding cross-leg
 * invariants there could make legitimate existing v1.2 backups
 * unrestorable, so the fail-closed manual rules live here and run only
 * at the manual form boundary.
 *
 * There is deliberately NO "imported legs unchanged" rule. That claim
 * cannot be proven from a single current trade object, and adding an
 * `originalTrade` baseline parameter for one rule was rejected on
 * simplicity grounds. Imported-leg integrity is enforced structurally
 * instead: the Scale UI is read-only whenever `sourcePlatform` is
 * present, and `buildScaledTradeCandidate` returns imported trades
 * untouched.
 *
 * Returns [] for trades with no legs and for imported trades — neither
 * is in this validator's domain.
 */
export function validateManualScaleLegs(trade: Partial<RawTradeContent>): TradeValidationError[] {
  if (!Array.isArray(trade.legs) || trade.legs.length === 0) return [];
  if (isImportedTrade(trade as RawTradeContent)) return [];

  const errors: string[] = [];
  const legs = trade.legs;
  const isFuturesMarket = trade.market === 'futures';
  const unit = isFuturesMarket ? 'contracts' : 'lots';

  // V6 — direction is inherited by every leg, so it must exist first.
  if (trade.direction !== 'Long' && trade.direction !== 'Short') {
    errors.push('select Long or Short before adding scale legs.');
  }

  // V1 — a journal trade is one completed flat-to-flat episode.
  const entryCount = legs.filter((leg) => leg.kind === 'entry').length;
  const exitCount = legs.filter((leg) => leg.kind === 'exit').length;
  if (entryCount === 0) errors.push('add at least one entry leg.');
  if (exitCount === 0) errors.push('add at least one exit leg.');

  // V2/V3/V5/V10/V4 — per-leg checks, before any cross-leg folding, so a
  // half-typed row reports its own problem rather than an aggregate one.
  //
  // EXACT PARSING IS THE AUTHORITY. `Number()`/`isFiniteNumeric` are
  // deliberately not used for scale-leg numbers: they accept forms the
  // bigint layer cannot parse ('1e2', 'Infinity', '0x1F'), and that
  // validator/parser disagreement previously let an unparseable
  // quantity through to the save pipeline. `decimalPlaces()` returning
  // null now means MALFORMED and is always an error — never a silently
  // skipped check.
  for (const leg of legs) {
    const label = leg.kind === 'entry' ? 'entry' : 'exit';

    const quantityText = typeof leg.quantity === 'string' ? leg.quantity.trim() : '';
    const parsedQuantity = parseDecimal(quantityText);
    if (quantityText === '') {
      errors.push(`each ${label} leg needs a quantity greater than zero.`);
    } else if (parsedQuantity === null) {
      errors.push(`leg quantity must be a positive plain decimal number such as 0.5 (1e2 and similar forms are not accepted).`);
    } else if (parsedQuantity.fractionText.length > QTY_DECIMALS) {
      errors.push(`leg quantity supports at most ${QTY_DECIMALS} decimal places.`);
    } else if ((parseScaled(quantityText, QTY_DECIMALS) ?? 0n) <= 0n) {
      errors.push(`each ${label} leg needs a quantity greater than zero.`);
    } else if (isFuturesMarket && !isWholeQuantity(quantityText)) {
      errors.push('futures quantities must be whole contracts.');
    }

    const priceText = typeof leg.price === 'string' ? leg.price.trim() : '';
    const parsedPrice = parseDecimal(priceText);
    if (priceText === '') {
      errors.push(`each ${label} leg needs a price greater than zero.`);
    } else if (parsedPrice === null) {
      errors.push(`leg price must be a positive plain decimal number such as 1.10 (1e2 and similar forms are not accepted).`);
    } else if (parsedPrice.fractionText.length > PRICE_DECIMALS) {
      errors.push(`leg price supports at most ${PRICE_DECIMALS} decimal places.`);
    } else if ((parseScaled(priceText, PRICE_DECIMALS) ?? 0n) <= 0n) {
      errors.push(`each ${label} leg needs a price greater than zero.`);
    }

    if (!isManualLegTime(leg.time)) {
      errors.push(`each ${label} leg needs a time in HH:mm.`);
    }
  }

  if (errors.length) return errors;

  // V7/V8/V9 — structural, folded in canonical order.
  const fold = foldPosition(legs);
  // Defence in depth: never evaluate balance on a fold that could not
  // read every quantity. An unparseable pair would otherwise leave both
  // totals at 0n and pass V9 vacuously. The per-leg checks above should
  // already have caught this — but the math layer must not convert a
  // parse failure into a meaningful zero-position episode.
  if (!fold.ok) {
    errors.push('leg quantities could not be read as exact decimals.');
    return errors;
  }
  if (fold.overExitIndex !== -1) {
    const step = fold.steps[fold.overExitIndex];
    errors.push(`exit quantity exceeds the open position at ${legTimeKey(step.leg.time).slice(0, 5)}.`);
  }
  if (fold.earlyFlatIndex !== -1) {
    const step = fold.steps[fold.earlyFlatIndex];
    errors.push(
      `position returns to flat at ${legTimeKey(step.leg.time).slice(0, 5)} before the final leg — record that as a separate trade.`,
    );
  }
  if (fold.entryQtyScaled !== fold.exitQtyScaled) {
    const entryText = formatExactQuotient(fold.entryQtyScaled, 10n ** BigInt(QTY_DECIMALS)) ?? '?';
    const exitText = formatExactQuotient(fold.exitQtyScaled, 10n ** BigInt(QTY_DECIMALS)) ?? '?';
    errors.push(`entry quantity (${entryText} ${unit}) must equal exit quantity (${exitText} ${unit}).`);
  }
  return errors;
}
