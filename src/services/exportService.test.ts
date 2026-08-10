import { describe, expect, it } from 'vitest';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import { buildExportCSV } from './exportService.js';
import { isProcessError, parseFileContent, processRows } from './importService.js';

function trade(overrides: Partial<EnrichedTrade> = {}): EnrichedTrade {
  return {
    _tid: 1,
    _i: 1,
    _r: 2,
    _pts: 10,
    _pl: 100,
    _netPL: 98,
    _rv: 50,
    _rPct: 1,
    _plannedR: 2,
    _outcome: 'Green',
    _capital: 10_000,
    _durMins: 60,
    _dur: '1h',
    _isFutures: false,
    _ptLabel: 'Pips',
    date: '2026-08-09',
    symbol: 'EURUSD',
    market: 'forex',
    direction: 'Long',
    positionSize: '1',
    entryPrice: '1.1000',
    stopLoss: '1.0950',
    target: '1.1100',
    exitPrice: '1.1100',
    notes: 'Test note',
    ...overrides,
  };
}

describe('buildExportCSV', () => {
  it('starts with a UTF-8 BOM', () => {
    expect(buildExportCSV([trade()]).startsWith('\ufeff')).toBe(true);
  });

  it('round-trips through import with an identical column map', () => {
    const csvWithBom = buildExportCSV([trade()]);
    const withBom = processRows(parseFileContent(csvWithBom));
    const withoutBom = processRows(parseFileContent(csvWithBom.slice(1)));

    expect(isProcessError(withBom)).toBe(false);
    expect(isProcessError(withoutBom)).toBe(false);
    if (isProcessError(withBom) || isProcessError(withoutBom)) return;

    expect(withBom.colMap).toEqual(withoutBom.colMap);
    expect(withBom.colMap.date).toBe('Date');
  });

  it('preserves Arabic notes through export and parsing', () => {
    const notes = 'صفقة ناجحة مع إدارة مخاطر جيدة';
    const processed = processRows(parseFileContent(buildExportCSV([trade({ notes })])));

    expect(isProcessError(processed)).toBe(false);
    if (isProcessError(processed)) return;
    expect(processed.rows[0].Notes).toBe(notes);
  });

  it('exports a legless historical trade with all 23 columns and no undefined strings', () => {
    const historicalTrade = trade({
      _tid: 2,
      notes: 'Historical trade',
    });
    const csv = buildExportCSV([historicalTrade]);
    const rows = parseFileContent(csv);

    expect(rows[0]).toHaveLength(23);
    expect(rows[1]).toHaveLength(23);
    expect(csv).not.toContain('undefined');
  });
});
