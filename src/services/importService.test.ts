import { describe, expect, it } from 'vitest';
import type { Account } from '@apptypes/account.js';
import { convertRow, parseDate, resolveImportAccount } from './importService.js';

const account = (id: string, name: string, deletedAt: string | null = null) => ({
  id, name, capital: 10_000, color: '#fff', deletedAt,
} as Account);

describe('import account resolution', () => {
  it('resolves one case-insensitive exact active account', () => {
    expect(resolveImportAccount('main', [account('a', 'Main')])).toEqual({ accountId: 'a' });
  });

  it('infers the sole active account when account text is absent', () => {
    expect(resolveImportAccount('', [account('a', 'Main')])).toEqual({ accountId: 'a' });
  });

  it('rejects missing text with multiple active accounts', () => {
    expect(resolveImportAccount('', [account('a', 'A'), account('b', 'B')]).accountId).toBeNull();
  });

  it('rejects unmatched and substring-only names', () => {
    expect(resolveImportAccount('Unknown', [account('a', 'Main')]).accountId).toBeNull();
    expect(resolveImportAccount('Main', [account('a', 'Main Account')]).accountId).toBeNull();
  });

  it('rejects duplicate exact names and tombstoned matches', () => {
    expect(resolveImportAccount('Main', [account('a', 'Main'), account('b', 'MAIN')]).error)
      .toBe('Account name matches more than one active account.');
    expect(resolveImportAccount('Main', [account('a', 'Main', '2026-08-07T00:00:00Z')]).accountId).toBeNull();
  });

  it('does not overwrite an exact match with the first account', () => {
    const trade = convertRow(
      { Broker: 'Second', Symbol: 'US100', Date: '2026-08-07' },
      { broker: 'Broker', symbol: 'Symbol', date: 'Date' },
      [account('a', 'First'), account('b', 'Second')],
    );
    expect(trade.accountId).toBe('b');
  });

  it('does not invent today when the source has no date', () => {
    const trade = convertRow({ Symbol: 'US100' }, { symbol: 'Symbol' }, [account('a', 'Main')]);
    expect(trade.date).toBe('');
  });
});

describe('deterministic import date parsing', () => {
  it('preserves canonical dates and converts unambiguous slash dates', () => {
    expect(parseDate('2026-08-07')).toBe('2026-08-07');
    expect(parseDate('13/02/2026')).toBe('2026-02-13');
    expect(parseDate('02/13/2026')).toBe('2026-02-13');
  });

  it('does not interpret ambiguous or locale-dependent dates', () => {
    expect(parseDate('02/03/2026')).toBe('02/03/2026');
    expect(parseDate('March 2, 2026')).toBe('March 2, 2026');
  });
});
