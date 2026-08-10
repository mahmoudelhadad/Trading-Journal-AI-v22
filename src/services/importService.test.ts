import { describe, expect, it } from 'vitest';
import type { Account } from '@apptypes/account.js';
import {
  convertRow, parseDate, parseTime, resolveImportAccount, parseWorkbookRows, processRows, isProcessError,
} from './importService.js';

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

describe('parseTime', () => {
  it.each([
    ['12:15:00 AM', '00:15'],
    ['12:30:00 PM', '12:30'],
    ['1:05:00 PM', '13:05'],
    ['3:45:10 PM', '15:45'],
    ['11:59:00 PM', '23:59'],
    ['9:33:53 AM', '09:33'],
  ])('converts %s to %s', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it.each([
    ['13:33', '13:33'],
    ['9:33', '09:33'],
    ['9:33:53', '09:33'],
    ['00:00', '00:00'],
  ])('preserves 24-hour behavior for %s', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it.each(['13:00 PM', '0:30 PM'])('fails closed for invalid 12-hour input %s', (input) => {
    expect(parseTime(input)).toBe(input);
  });

  it('does not parse a combined date and time', () => {
    expect(parseTime('7/24/2026 9:33:53 AM')).toBe('7/24/2026 9:33:53 AM');
  });

  it.each(['', '   '])('returns an empty string for empty or blank input', (input) => {
    expect(parseTime(input)).toBe('');
  });
});

/**
 * v1.1 (H-XLSX) regression cover.
 *
 * Excel import was silently unavailable in production: ImportWizard tested a
 * bare global `XLSX` that never existed, so every workbook hit the "Excel
 * library not loaded" branch while `tsc` stayed green behind an ambient
 * `declare`. These tests exercise the real dynamic-import path, so the
 * feature cannot regress to unavailable without failing here.
 *
 * The workbook is BUILT with the same library, so no fixture file and no new
 * dependency or test framework is required, and this runs in the existing
 * node environment.
 */
describe('excel workbook import', () => {
  const buildWorkbook = async (rows: string[][]): Promise<ArrayBuffer> => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trades');
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  };

  const sheetRows = [
    ['Date', 'Symbol', 'Direction', 'Entry Price', 'Stop Loss', 'Exit Price', 'Lots'],
    ['2026-03-02', 'EUR/USD', 'Long', '1.0800', '1.0750', '1.0900', '1'],
    ['2026-03-03', 'GBP/USD', 'Short', '1.2700', '1.2750', '1.2600', '2'],
  ];

  it('round-trips a workbook into the same string[][] shape CSV produces', async () => {
    const rows = await parseWorkbookRows(await buildWorkbook(sheetRows));
    expect(rows[0]).toEqual(sheetRows[0]);
    expect(rows[1][1]).toBe('EUR/USD');
    expect(rows[2][1]).toBe('GBP/USD');
  });

  it('feeds processRows() exactly like the CSV path', async () => {
    const rows = await parseWorkbookRows(await buildWorkbook(sheetRows));
    const processed = processRows(rows);
    expect(isProcessError(processed)).toBe(false);
    if (isProcessError(processed)) return;
    expect(processed.rows).toHaveLength(2);
    expect(processed.colMap.symbol).toBe('Symbol');
    expect(processed.colMap.date).toBe('Date');
  });

  it('rejects a structurally broken workbook so the Excel error UI fires', async () => {
    // A truncated ZIP container is recognized as a workbook and fails to
    // parse — this is the path ImportWizard's catch reports as
    // "Excel error: ...".
    const truncatedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]).buffer;
    await expect(parseWorkbookRows(truncatedZip)).rejects.toThrow();
  });

  it('cannot turn unrecognized bytes into an importable sheet', async () => {
    // Measured behavior: xlsx does NOT throw on unrecognized bytes — it
    // falls back to reading them as a single-cell text sheet. The guarantee
    // that matters is therefore downstream: such rows can never become an
    // import, because processRows() requires a header row of >3 non-empty
    // cells and rejects them.
    const notAWorkbook = new TextEncoder().encode('this is definitely not a workbook').buffer;
    const rows = await parseWorkbookRows(notAWorkbook);
    const processed = processRows(rows);
    expect(isProcessError(processed)).toBe(true);
    if (isProcessError(processed)) expect(processed.error).toBe('Could not detect headers.');
  });
});
