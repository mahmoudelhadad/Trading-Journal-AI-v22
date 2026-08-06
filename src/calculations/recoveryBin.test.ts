import { describe, expect, it } from 'vitest';
import {
  buildRecoveryBinEntries,
  formatTradeRecoveryLabel,
  type RecoveryBinCapture,
} from './recoveryBin.js';

interface TestRawTrade {
  _tid: number;
  symbol: string;
  direction: string;
  date: string;
  entryPrice: string;
  customNote?: string;
}

function rawTrade(
  tid: number,
  symbol: string,
  direction: string,
  date: string,
): TestRawTrade {
  return {
    _tid: tid,
    symbol,
    direction,
    date,
    entryPrice: `${tid}.25`,
    customNote: `raw-${tid}`,
  };
}

function sequentialIds(ids: readonly string[]): () => string {
  let index = 0;
  return () => ids[index++];
}

describe('buildRecoveryBinEntries', () => {
  it('returns an empty array without requesting an ID for zero captures', () => {
    let idCalls = 0;
    const entries = buildRecoveryBinEntries([], 1_000, () => {
      idCalls += 1;
      return 'unexpected';
    });

    expect(entries).toEqual([]);
    expect(idCalls).toBe(0);
  });

  it('builds one entry with the established persisted shape', () => {
    const trade = rawTrade(101, 'NQ', 'Long', '2026-08-01');
    const entries = buildRecoveryBinEntries(
      [{ item: trade, label: 'NQ Long — 2026-08-01' }],
      9_876,
      () => 'recovery_9876_1',
    );

    expect(entries).toEqual([{
      id: 'recovery_9876_1',
      deletedAt: 9_876,
      item: trade,
      label: 'NQ Long — 2026-08-01',
    }]);
    expect(Object.keys(entries[0]).sort()).toEqual(['deletedAt', 'id', 'item', 'label']);
    expect(entries[0].item).toBe(trade);
    expect(entries[0].item._tid).toBe(101);
  });

  it('maps N captures to N unique entries without omissions or duplicates', () => {
    const trades = [
      rawTrade(201, 'ES', 'Short', '2026-08-02'),
      rawTrade(202, 'MES', 'Long', '2026-08-03'),
      rawTrade(203, 'MNQ', 'Short', '2026-08-04'),
    ];
    const captures: RecoveryBinCapture<TestRawTrade>[] = trades.map((trade) => ({
      item: trade,
      label: `trade-${trade._tid}`,
    }));
    const entries = buildRecoveryBinEntries(
      captures,
      12_345,
      sequentialIds(['recovery_a', 'recovery_b', 'recovery_c']),
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.id)).toEqual(['recovery_a', 'recovery_b', 'recovery_c']);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
    expect(entries.map((entry) => entry.item._tid)).toEqual([201, 202, 203]);
    expect(entries.map((entry) => entry.item)).toEqual(trades);
    expect(entries.map((entry) => entry.item.customNote)).toEqual(['raw-201', 'raw-202', 'raw-203']);
  });

  it('preserves capture order and applies one operation timestamp to the batch', () => {
    const first = rawTrade(301, 'NQ', 'Long', '2026-08-05');
    const second = rawTrade(302, 'ES', 'Short', '2026-08-06');
    const entries = buildRecoveryBinEntries(
      [
        { item: first, label: 'first' },
        { item: second, label: 'second' },
      ],
      55_555,
      sequentialIds(['recovery_first', 'recovery_second']),
    );

    expect(entries.map((entry) => entry.item)).toEqual([first, second]);
    expect(entries.map((entry) => entry.label)).toEqual(['first', 'second']);
    expect(entries.map((entry) => entry.deletedAt)).toEqual([55_555, 55_555]);
  });

  it('exposes original items in the order consumed by existing Restore All', () => {
    const trades = [
      rawTrade(401, 'MES', 'Long', '2026-08-01'),
      rawTrade(402, 'MNQ', 'Short', '2026-08-02'),
    ];
    const entries = buildRecoveryBinEntries(
      trades.map((item) => ({ item, label: `trade-${item._tid}` })),
      77_777,
      sequentialIds(['recovery_401', 'recovery_402']),
    );

    const restoredItems = entries.map((entry) => entry.item);

    expect(restoredItems).toEqual(trades);
    expect(restoredItems[0]).toBe(trades[0]);
    expect(restoredItems[1]).toBe(trades[1]);
    expect(restoredItems.map((trade) => trade._tid)).toEqual([401, 402]);
  });
});

describe('formatTradeRecoveryLabel', () => {
  it('formats the exact normal trade label', () => {
    expect(formatTradeRecoveryLabel({
      symbol: 'NQ',
      direction: 'Long',
      date: '2026-08-06',
    })).toBe('NQ Long — 2026-08-06');
  });

  it('uses the exact symbol fallback', () => {
    expect(formatTradeRecoveryLabel({
      symbol: '',
      direction: 'Short',
      date: '2026-08-06',
    })).toBe('Trade Short — 2026-08-06');
  });

  it('omits a missing direction without leaving extra label content', () => {
    expect(formatTradeRecoveryLabel({
      symbol: 'ES',
      direction: '',
      date: '2026-08-06',
    })).toBe('ES — 2026-08-06');
  });

  it('uses the exact no-date fallback', () => {
    expect(formatTradeRecoveryLabel({
      symbol: 'MES',
      direction: 'Long',
      date: '',
    })).toBe('MES Long — no date');
  });
});
