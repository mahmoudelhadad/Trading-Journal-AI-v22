import { describe, expect, it } from 'vitest';
import type { Account } from '@apptypes/account.js';
import { isCanonicalDate, isCanonicalTime, validateTradeContent } from './tradeValidation.js';

const account = (id: string, name: string, deletedAt: string | null = null) => ({
  id, name, capital: 10_000, color: '#fff', deletedAt,
} as Account);

const validTrade = () => ({
  _tid: 1, accountId: 'a', date: '2026-08-07', symbol: 'US100', direction: 'Long',
  entryPrice: '100', stopLoss: '90', target: '120', exitPrice: '110', positionSize: '1',
  commission: '0', entryTime: '09:30', exitTime: '10:15',
});

describe('trade domain validation', () => {
  it('accepts a valid canonical trade and leap day', () => {
    expect(validateTradeContent(validTrade(), [account('a', 'Main')], { requireIdentity: true })).toEqual([]);
    expect(isCanonicalDate('2024-02-29')).toBe(true);
  });

  it.each(['2026-02-30', '02/03/2026', 'March 2, 2026', ''])('rejects invalid or ambiguous date %s', (date) => {
    expect(isCanonicalDate(date)).toBe(false);
  });

  it.each(['00:00', '09:30', '23:59'])('accepts canonical time %s', (time) => {
    expect(isCanonicalTime(time)).toBe(true);
  });

  it.each(['24:00', '9:30', '12:60', 'noon'])('rejects invalid time %s', (time) => {
    expect(isCanonicalTime(time)).toBe(false);
  });

  it('allows blank optional numbers, zero and negative commission', () => {
    const trade = { ...validTrade(), target: '', exitPrice: '', commission: '-1.25' };
    expect(validateTradeContent(trade, [account('a', 'Main')])).toEqual([]);
    expect(validateTradeContent({ ...trade, commission: '0' }, [account('a', 'Main')])).toEqual([]);
  });

  it.each([
    ['entryPrice', '0'], ['entryPrice', '-1'], ['positionSize', '0'], ['positionSize', '-2'],
    ['entryPrice', 'NaN'], ['entryPrice', 'Infinity'], ['entryPrice', 'not-a-number'],
  ] as const)('rejects invalid %s value %s', (field, value) => {
    const errors = validateTradeContent({ ...validTrade(), [field]: value }, [account('a', 'Main')]);
    expect(errors.some((error) => error.includes('finite number greater than zero'))).toBe(true);
  });

  it('rejects a missing, unknown, or tombstoned account', () => {
    expect(validateTradeContent(validTrade(), [])).toContain('select an active account.');
    expect(validateTradeContent({ ...validTrade(), accountId: 'missing' }, [account('a', 'Main')])).toContain('select an active account.');
    expect(validateTradeContent(validTrade(), [account('a', 'Main', '2026-08-07T00:00:00Z')])).toContain('select an active account.');
  });

  it('permits blank direction only while calculation inputs are blank', () => {
    const incomplete = { ...validTrade(), direction: '', entryPrice: '', stopLoss: '', target: '', exitPrice: '', positionSize: '' };
    expect(validateTradeContent(incomplete, [account('a', 'Main')])).toEqual([]);
    expect(validateTradeContent({ ...validTrade(), direction: '' }, [account('a', 'Main')]))
      .toContain('direction must be Long or Short when trade prices are entered.');
    expect(validateTradeContent({ ...incomplete, direction: 'Buy' }, [account('a', 'Main')]))
      .toContain('direction must be Long or Short when trade prices are entered.');
  });
});
