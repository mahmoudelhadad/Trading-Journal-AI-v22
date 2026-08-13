/**
 * services/ninjaTraderHistoricalAdapter.test.ts
 *
 * B1 — characterization tests for the NinjaTrader historical source
 * grammar, the frozen validation matrix, and End-of-Bar → Start-of-Bar
 * normalization.
 *
 * SYNTHETIC DATA ONLY. No real NinjaTrader export is present in this
 * repository, in any fixture, or in Git. Every literal below is written
 * by hand to exercise one structural case.
 *
 * EXPECTED VALUES ARE DERIVED INDEPENDENTLY of the implementation:
 * 2016-03-01T05:01:00Z is 16861 days after the epoch (16861 * 86_400_000
 * = 1_456_790_400_000 for midnight) plus 5h01m, giving
 * 1_456_808_460_000. The canonical start-of-bar value is therefore
 * 1_456_808_400_000, one MINUTE_MS earlier.
 */

import { describe, expect, it } from 'vitest';
import {
  parseNinjaTraderHistorical,
  normalizeExpiry,
  computeSourceChecksumSha256,
} from './ninjaTraderHistoricalAdapter.js';
import type { HistoricalImportDescriptor } from '@apptypes/marketData.js';

const SOURCE_FIRST_UTC_MS = 1_456_808_460_000; // 2016-03-01T05:01:00Z
const CANONICAL_FIRST_UTC_MS = 1_456_808_400_000; // 2016-03-01T05:00:00Z

const NQ_DESCRIPTOR: HistoricalImportDescriptor = {
  source:                    'ninjatrader',
  root:                      'NQ',
  expiryText:                '03-16',
  timeframe:                 '1m',
  dataType:                  'Last',
  sourceTimeZone:            'UTC',
  sourceTimestampConvention: 'end-of-bar',
};

function descriptor(overrides: Partial<HistoricalImportDescriptor> = {}): HistoricalImportDescriptor {
  return { ...NQ_DESCRIPTOR, ...overrides };
}

function parse(text: string, overrides: Partial<HistoricalImportDescriptor> = {}) {
  return parseNinjaTraderHistorical(text, descriptor(overrides));
}

const TWO_VALID_ROWS = [
  '20160301 050100;4197;4197;4196.5;4196.5;10',
  '20160301 050200;4196.5;4198;4196.25;4197.75;25',
].join('\n');

// ─── Expiry normalization ─────────────────────────────────────

describe('normalizeExpiry', () => {
  it('canonicalizes MM-YY to an unambiguous numeric year and month', () => {
    expect(normalizeExpiry('03-16')).toEqual({ expiryYear: 2016, expiryMonth: 3 });
    expect(normalizeExpiry('06-16')).toEqual({ expiryYear: 2016, expiryMonth: 6 });
    expect(normalizeExpiry('12-99')).toEqual({ expiryYear: 2099, expiryMonth: 12 });
    expect(normalizeExpiry('01-00')).toEqual({ expiryYear: 2000, expiryMonth: 1 });
  });

  it('rejects every malformed form rather than guessing', () => {
    expect(normalizeExpiry('13-16')).toBeNull();
    expect(normalizeExpiry('00-16')).toBeNull();
    expect(normalizeExpiry('3-16')).toBeNull();
    expect(normalizeExpiry('03-1')).toBeNull();
    expect(normalizeExpiry('03/16')).toBeNull();
    expect(normalizeExpiry('2016-03')).toBeNull();
    expect(normalizeExpiry('')).toBeNull();
  });
});

// ─── Descriptor authority ─────────────────────────────────────

describe('descriptor is the sole contract-identity authority', () => {
  it('derives provider-neutral series identity from the descriptor', () => {
    const result = parse(TWO_VALID_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series).toEqual({
      root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m',
    });
    // The provider must not survive into series identity.
    expect(Object.keys(result.series).sort()).toEqual(
      ['expiryMonth', 'expiryYear', 'root', 'timeframe'],
    );
  });

  it('rejects a root outside the market-data domain authority', () => {
    const result = parse(TWO_VALID_ROWS, { root: 'CL' as never });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed expiry without inferring one from the rows', () => {
    expect(parse(TWO_VALID_ROWS, { expiryText: '13-16' }).ok).toBe(false);
  });

  it('rejects source semantics it was not frozen to normalize', () => {
    expect(parse(TWO_VALID_ROWS, { sourceTimestampConvention: 'start-of-bar' as never }).ok).toBe(false);
    expect(parse(TWO_VALID_ROWS, { sourceTimeZone: 'America/New_York' as never }).ok).toBe(false);
    expect(parse(TWO_VALID_ROWS, { timeframe: '5m' as never }).ok).toBe(false);
    expect(parse(TWO_VALID_ROWS, { dataType: 'Bid' as never }).ok).toBe(false);
    expect(parse(TWO_VALID_ROWS, { source: 'databento' as never }).ok).toBe(false);
  });
});

// ─── Grammar + normalization ──────────────────────────────────

describe('source grammar and EOB → SOB normalization', () => {
  it('parses the frozen six-field semicolon grammar with no header', () => {
    const result = parse(TWO_VALID_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceRowCount).toBe(2);
    expect(result.bars).toHaveLength(2);
    expect(result.bars[0]).toEqual({
      t: CANONICAL_FIRST_UTC_MS, o: 4197, h: 4197, l: 4196.5, c: 4196.5, v: 10,
    });
  });

  it('shifts an End-of-Bar source stamp back by exactly one minute', () => {
    const result = parse(TWO_VALID_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars[0].t).toBe(CANONICAL_FIRST_UTC_MS);
    expect(SOURCE_FIRST_UTC_MS - result.bars[0].t).toBe(60_000);
    expect(result.bars[1].t).toBe(CANONICAL_FIRST_UTC_MS + 60_000);
  });

  it('accepts integer and decimal prices in the same file', () => {
    const result = parse('20160301 050100;4197;4197;4196.5;4196.5;10');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars[0].o).toBe(4197);
    expect(result.bars[0].l).toBe(4196.5);
  });

  it('accepts zero volume as a real observation', () => {
    const result = parse('20160301 050100;4197;4197;4197;4197;0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars[0].v).toBe(0);
  });

  it('ignores blank and whitespace-only lines without counting them as rows', () => {
    const result = parse(`\n${TWO_VALID_ROWS}\n   \n\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceRowCount).toBe(2);
    expect(result.bars).toHaveLength(2);
  });

  it('accepts CRLF line endings', () => {
    const result = parse(TWO_VALID_ROWS.replace(/\n/g, '\r\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toHaveLength(2);
  });

  it('normalizes an End-of-Bar midnight stamp back into the previous UTC day', () => {
    // 2016-03-02T00:00:00Z end-of-bar covers [23:59, 00:00) of 2016-03-01.
    const result = parse('20160302 000000;4200;4200;4200;4200;1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Date(result.bars[0].t).toISOString()).toBe('2016-03-01T23:59:00.000Z');
  });
});

// ─── REJECT matrix ────────────────────────────────────────────

describe('validation matrix — REJECT cases abort the whole import', () => {
  const rejects: Array<[string, string]> = [
    ['wrong field count',            '20160301 050100;4197;4197;4196.5;4196.5'],
    ['extra field',                  '20160301 050100;4197;4197;4196.5;4196.5;10;99'],
    ['malformed timestamp syntax',   '2016-03-01 05:01:00;4197;4197;4196.5;4196.5;10'],
    ['short timestamp',              '2016301 050100;4197;4197;4196.5;4196.5;10'],
    ['impossible calendar date',     '20160230 050100;4197;4197;4196.5;4196.5;10'],
    ['impossible month',             '20161301 050100;4197;4197;4196.5;4196.5;10'],
    ['impossible hour',              '20160301 240100;4197;4197;4196.5;4196.5;10'],
    ['impossible minute',            '20160301 056000;4197;4197;4196.5;4196.5;10'],
    ['non-zero seconds for 1m',      '20160301 050130;4197;4197;4196.5;4196.5;10'],
    ['non-numeric price',            '20160301 050100;abc;4197;4196.5;4196.5;10'],
    ['exponent-form price',          '20160301 050100;4.197e3;4197;4196.5;4196.5;10'],
    ['signed price',                 '20160301 050100;+4197;4197;4196.5;4196.5;10'],
    ['zero price',                   '20160301 050100;0;4197;4196.5;4196.5;10'],
    ['negative price',               '20160301 050100;-4197;4197;4196.5;4196.5;10'],
    ['negative volume',              '20160301 050100;4197;4197;4196.5;4196.5;-5'],
    ['non-integer volume',           '20160301 050100;4197;4197;4196.5;4196.5;1.5'],
    ['non-numeric volume',           '20160301 050100;4197;4197;4196.5;4196.5;x'],
    ['high < low',                   '20160301 050100;100;99;101;100;1'],
    ['high < open',                  '20160301 050100;105;100;99;100;1'],
    ['high < close',                 '20160301 050100;100;100;99;105;1'],
    ['low > open',                   '20160301 050100;100;105;101;102;1'],
    ['low > close',                  '20160301 050100;102;105;101;100;1'],
  ];

  it.each(rejects)('rejects %s', (_label, line) => {
    const result = parse(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects a conflicting duplicate timestamp rather than choosing a winner', () => {
    const result = parse([
      '20160301 050100;4197;4197;4196.5;4196.5;10',
      '20160301 050100;4197;4197;4196.5;4196.75;10',
    ].join('\n'));
    expect(result.ok).toBe(false);
  });

  it('never repairs malformed OHLC — one bad row loses the whole file', () => {
    const result = parse([
      '20160301 050100;4197;4197;4196.5;4196.5;10',
      '20160301 050200;100;99;101;100;1',
      '20160301 050300;4197;4197;4196.5;4196.5;10',
    ].join('\n'));
    expect(result.ok).toBe(false);
  });

  it('reports the offending row number', () => {
    const result = parse([
      '20160301 050100;4197;4197;4196.5;4196.5;10',
      '20160301 050200;100;99;101;100;1',
    ].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowNumber).toBe(2);
  });
});

// ─── WARN matrix ──────────────────────────────────────────────

describe('validation matrix — WARN cases are counted, never fatal', () => {
  it('warns on an off-tick NQ price without rejecting or inferring instrument', () => {
    const result = parse('20160301 050100;4197.1;4197.1;4197.1;4197.1;1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.offTick).toBe(1);
    expect(result.bars).toHaveLength(1);
  });

  it('does not warn when every NQ/ES price is a quarter-point multiple', () => {
    const result = parse('20160301 050100;4197.25;4197.75;4196.5;4197;1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.offTick).toBe(0);
  });

  it('warns on out-of-order source rows and returns bars sorted ascending', () => {
    const result = parse([
      '20160301 050300;4197;4197;4197;4197;1',
      '20160301 050100;4198;4198;4198;4198;2',
      '20160301 050200;4199;4199;4199;4199;3',
    ].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.outOfOrder).toBeGreaterThan(0);
    expect(result.bars.map((b) => b.t)).toEqual([
      CANONICAL_FIRST_UTC_MS,
      CANONICAL_FIRST_UTC_MS + 60_000,
      CANONICAL_FIRST_UTC_MS + 120_000,
    ]);
  });

  it('collapses an identical in-file duplicate and counts it', () => {
    const result = parse([
      '20160301 050100;4197;4197;4196.5;4196.5;10',
      '20160301 050100;4197;4197;4196.5;4196.5;10',
    ].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.inFileDuplicates).toBe(1);
    expect(result.bars).toHaveLength(1);
    expect(result.sourceRowCount).toBe(2);
  });
});

// ─── Missing minutes ──────────────────────────────────────────

describe('missing minutes', () => {
  it('preserves gaps exactly — no densification, no flat candles', () => {
    const result = parse([
      '20160301 050100;4197;4197;4197;4197;1',
      // 05:02 and 05:03 absent on purpose
      '20160301 050400;4198;4198;4198;4198;1',
    ].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toHaveLength(2);
    expect(result.bars.map((b) => b.t)).toEqual([
      CANONICAL_FIRST_UTC_MS,
      CANONICAL_FIRST_UTC_MS + 180_000,
    ]);
    expect(result.bars.some((b) => b.v === 0 && b.o === b.h && b.h === b.l && b.l === b.c)).toBe(false);
  });
});

// ─── Checksum ─────────────────────────────────────────────────

describe('source checksum', () => {
  it('produces a stable lowercase SHA-256 hex digest, or null when unavailable', async () => {
    const first = await computeSourceChecksumSha256(TWO_VALID_ROWS);
    const second = await computeSourceChecksumSha256(TWO_VALID_ROWS);
    const other = await computeSourceChecksumSha256(`${TWO_VALID_ROWS}\n`);

    if (first === null) {
      // Host without Web Crypto: proven at Runtime Acceptance instead.
      expect(second).toBeNull();
      return;
    }
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});
