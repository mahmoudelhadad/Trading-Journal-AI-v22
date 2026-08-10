import { isSupportedSymbol } from '@constants/pipValues.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

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
        if (typeof leg.sourceExecutionId !== 'string' || !/^\d+$/.test(leg.sourceExecutionId)) {
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
