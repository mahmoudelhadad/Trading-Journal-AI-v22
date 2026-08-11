import { describe, expect, it } from 'vitest';
import type { Account } from '@apptypes/account.js';
import { FUT_SYMBOLS } from '@constants/symbols.js';
import {
  isCanonicalDate,
  isCanonicalTime,
  validateManualScaleLegs,
  validateTradeContent,
} from './tradeValidation.js';

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

describe('v1.2 validation regressions', () => {
  it('keeps every manual futures symbol valid independently of the broker allowlist', () => {
    for (const symbol of FUT_SYMBOLS) {
      expect(validateTradeContent({ ...validTrade(), market: 'futures', symbol }, [account('a', 'Main')]), symbol)
        .toEqual([]);
    }
  });

  it('accepts absent optional provenance fields without errors', () => {
    const trade = validTrade();
    expect(trade).not.toHaveProperty('legs');
    expect(trade).not.toHaveProperty('sourceInstrument');
    expect(trade).not.toHaveProperty('sourcePlatform');
    expect(trade).not.toHaveProperty('sourceAccountId');
    expect(validateTradeContent(trade, [account('a', 'Main')])).toEqual([]);
  });

  it('rejects present malformed optional provenance fields', () => {
    const validate = (overrides: Record<string, unknown>) => validateTradeContent(
      { ...validTrade(), ...overrides } as Parameters<typeof validateTradeContent>[0],
      [account('a', 'Main')],
    );
    const validLeg = {
      kind: 'entry', quantity: '1', price: '100', date: '2026-08-07',
      time: '09:30:00', sourceExecutionId: '123',
    };

    expect(validate({ legs: 'not-an-array' })).toContain('legs must be an array.');
    expect(validate({ legs: [{ ...validLeg, kind: 'scale' }] })).toContain('leg kind must be entry or exit.');
    expect(validate({ legs: [{ ...validLeg, time: '09:30' }] })).toContain('leg time must use HH:mm:ss.');
    expect(validate({ legs: [{ ...validLeg, sourceExecutionId: '12A' }] }))
      .toContain('leg source execution ID must be a non-empty digits-only string.');
    expect(validate({ sourceInstrument: '   ' })).toContain('Source instrument must be a non-blank string.');
  });
});

// ─── Manual Scale In / Scale Out ──────────────────────────────

const scaleLeg = (
  kind: 'entry' | 'exit',
  quantity: string,
  price: string,
  time: string,
) => ({ kind, quantity, price, date: '2026-08-10', time });

const scaleTrade = (legs: unknown[], overrides: Record<string, unknown> = {}) => ({
  ...validTrade(),
  market: 'futures',
  symbol: 'NQ',
  direction: 'Long',
  legs,
  ...overrides,
}) as Parameters<typeof validateManualScaleLegs>[0];

describe('manual scale leg validation', () => {
  const balanced = [
    scaleLeg('entry', '2', '28920', '09:32'),
    scaleLeg('entry', '2', '28930', '09:41'),
    scaleLeg('exit', '2', '28970.50', '10:15'),
    scaleLeg('exit', '2', '28980', '10:48'),
  ];

  it('accepts a manual leg with NO sourceExecutionId through base validation', () => {
    const trade = { ...validTrade(), legs: [scaleLeg('entry', '2', '100', '09:30')] };
    trade.legs[0].time = '09:30:00';
    expect(validateTradeContent(
      trade as Parameters<typeof validateTradeContent>[0],
      [account('a', 'Main')],
    )).toEqual([]);
  });

  it('still rejects a present but non-digit sourceExecutionId', () => {
    const trade = {
      ...validTrade(),
      legs: [{ ...scaleLeg('entry', '2', '100', '09:30'), time: '09:30:00', sourceExecutionId: '12A' }],
    };
    expect(validateTradeContent(
      trade as Parameters<typeof validateTradeContent>[0],
      [account('a', 'Main')],
    )).toContain('leg source execution ID must be a non-empty digits-only string.');
  });

  it('accepts a balanced scaled episode (V1-V10 all satisfied)', () => {
    expect(validateManualScaleLegs(scaleTrade(balanced))).toEqual([]);
  });

  it('accepts a partial exit followed by a re-entry', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '2', '100', '09:00'),
      scaleLeg('exit', '1', '140', '09:30'),
      scaleLeg('entry', '1', '130', '10:00'),
      scaleLeg('exit', '2', '155', '10:30'),
    ]))).toEqual([]);
  });

  it('V1 — requires at least one entry and one exit', () => {
    expect(validateManualScaleLegs(scaleTrade([scaleLeg('entry', '2', '100', '09:00')])))
      .toContain('add at least one exit leg.');
    expect(validateManualScaleLegs(scaleTrade([scaleLeg('exit', '2', '100', '09:00')])))
      .toContain('add at least one entry leg.');
  });

  it('V2 — requires a positive quantity', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '0', '100', '09:00'), scaleLeg('exit', '1', '110', '10:00'),
    ]))).toContain('each entry leg needs a quantity greater than zero.');
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '', '100', '09:00'), scaleLeg('exit', '1', '110', '10:00'),
    ]))).toContain('each entry leg needs a quantity greater than zero.');
  });

  it('V3 — requires a positive price', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1', '0', '09:00'), scaleLeg('exit', '1', '110', '10:00'),
    ]))).toContain('each entry leg needs a price greater than zero.');
  });

  it('V4 — futures need whole contracts, forex allows the same fractional lot', () => {
    const fractional = [
      scaleLeg('entry', '0.5', '100', '09:00'),
      scaleLeg('exit', '0.5', '110', '10:00'),
    ];
    expect(validateManualScaleLegs(scaleTrade(fractional)))
      .toContain('futures quantities must be whole contracts.');
    expect(validateManualScaleLegs(scaleTrade(fractional, { market: 'forex', symbol: 'EUR/USD' })))
      .toEqual([]);
  });

  it('V5 — requires HH:mm leg times', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1', '100', '9:00'), scaleLeg('exit', '1', '110', '10:00'),
    ]))).toContain('each entry leg needs a time in HH:mm.');
  });

  it('V6 — requires a Long or Short direction', () => {
    expect(validateManualScaleLegs(scaleTrade(balanced, { direction: '' })))
      .toContain('select Long or Short before adding scale legs.');
  });

  it('V7 — rejects exiting more than the open position', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '4', '100', '09:00'),
      scaleLeg('exit', '6', '110', '10:15'),
    ]))).toContain('exit quantity exceeds the open position at 10:15.');
  });

  it('V8 — rejects a position returning to flat before the final leg', () => {
    const errors = validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '2', '100', '09:00'),
      scaleLeg('exit', '2', '110', '09:30'),
      scaleLeg('entry', '2', '105', '10:00'),
      scaleLeg('exit', '2', '115', '10:30'),
    ]));
    expect(errors.some((error) => error.includes('separate trade'))).toBe(true);
  });

  it('V9 — requires entry and exit quantities to match', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '4', '100', '09:00'),
      scaleLeg('exit', '3', '110', '10:00'),
    ]))).toContain('entry quantity (4 contracts) must equal exit quantity (3 contracts).');
  });

  it('V10 — rejects over-precise prices and quantities', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1', '100.123456789', '09:00'),
      scaleLeg('exit', '1', '110', '10:00'),
    ]))).toContain('leg price supports at most 8 decimal places.');
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1.234567', '100', '09:00'),
      scaleLeg('exit', '1', '110', '10:00'),
    ], { market: 'forex', symbol: 'EUR/USD' })))
      .toContain('leg quantity supports at most 4 decimal places.');
  });

  it('accepts a bare leading-dot forex quantity as exactly 0.5', () => {
    for (const quantity of ['.5', '0.5', '+.5', '+0.5']) {
      expect(validateManualScaleLegs(scaleTrade([
        scaleLeg('entry', quantity, '1.10', '09:00'),
        scaleLeg('exit', quantity, '1.20', '10:00'),
      ], { market: 'forex', symbol: 'EUR/USD' }))).toEqual([]);
    }
  });

  it('rejects exponent notation that Number() would have accepted', () => {
    for (const quantity of ['1e0', '1e2', '1E2', '1e-2']) {
      const errors = validateManualScaleLegs(scaleTrade([
        scaleLeg('entry', quantity, '1.10', '09:00'),
        scaleLeg('exit', quantity, '1.20', '10:00'),
      ], { market: 'forex', symbol: 'EUR/USD' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('plain decimal number');
    }
    // Same rule on the price side.
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1', '1e2', '09:00'),
      scaleLeg('exit', '1', '1.20', '10:00'),
    ], { market: 'forex', symbol: 'EUR/USD' }))[0]).toContain('plain decimal number');
  });

  it('never lets an unparseable pair pass as a balanced episode (vacuous 0n === 0n)', () => {
    const errors = validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1e0', '1.10', '09:00'),
      scaleLeg('exit', '1e0', '1.20', '10:00'),
    ], { market: 'forex', symbol: 'EUR/USD' }));
    expect(errors.length).toBeGreaterThan(0);
    // The old failure mode: both totals stayed 0n so V9 passed silently
    // and the trade saved with all five owned aggregates blank.
    expect(errors.some((error) => error.includes('must equal exit quantity'))).toBe(false);
  });

  it('a malformed decimal-place result can no longer bypass validation', () => {
    // decimalPlaces() returns null for these; that must be an error, not a skip.
    for (const value of ['NaN', 'Infinity', '0x1F', '1.', '1px']) {
      expect(validateManualScaleLegs(scaleTrade([
        scaleLeg('entry', value, '1.10', '09:00'),
        scaleLeg('exit', '1', '1.20', '10:00'),
      ], { market: 'forex', symbol: 'EUR/USD' })).length).toBeGreaterThan(0);
    }
  });

  it('still enforces the V10 precision limits and futures whole contracts', () => {
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '.55555', '100', '09:00'),
      scaleLeg('exit', '1', '110', '10:00'),
    ], { market: 'forex', symbol: 'EUR/USD' })))
      .toContain('leg quantity supports at most 4 decimal places.');
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '1', '.123456789', '09:00'),
      scaleLeg('exit', '1', '110', '10:00'),
    ], { market: 'forex', symbol: 'EUR/USD' })))
      .toContain('leg price supports at most 8 decimal places.');
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '.5', '100', '09:00'),
      scaleLeg('exit', '.5', '110', '10:00'),
    ]))).toContain('futures quantities must be whole contracts.');
  });

  it('accepts a reopened manual leg whose stored time carries :00 seconds', () => {
    expect(validateManualScaleLegs(scaleTrade([
      { ...scaleLeg('entry', '2', '28920', '09:32'), time: '09:32:00' },
      { ...scaleLeg('exit', '2', '28980', '10:48'), time: '10:48:00' },
    ]))).toEqual([]);
  });

  // Editing order is now stable, so the array reaching validation may be in
  // any order. Validation must still fold CHRONOLOGICALLY.

  it('validates chronologically even when rows are stored out of order', () => {
    // Same balanced episode, rows shuffled as a user might have built them.
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('exit', '2', '28980', '10:48'),
      scaleLeg('entry', '2', '28920', '09:32'),
      scaleLeg('exit', '2', '28970.50', '10:15'),
      scaleLeg('entry', '2', '28930', '09:41'),
    ]))).toEqual([]);
  });

  it('V8 — still rejects flat-before-final when rows are entered out of order', () => {
    // Chronologically: E2@09:00, X2@09:30 (flat), E2@10:00, X2@10:30.
    // Visually shuffled, so only a chronological fold can detect it.
    const errors = validateManualScaleLegs(scaleTrade([
      scaleLeg('entry', '2', '120', '10:00'),
      scaleLeg('exit', '2', '110', '09:30'),
      scaleLeg('exit', '2', '130', '10:30'),
      scaleLeg('entry', '2', '100', '09:00'),
    ]));
    expect(errors.some((e) => e.includes('separate trade'))).toBe(true);
    expect(errors.some((e) => e.includes('09:30'))).toBe(true);
  });

  it('V7 — still rejects over-exit using chronological order, not array order', () => {
    // Array puts the big exit first; chronologically it follows the entry.
    expect(validateManualScaleLegs(scaleTrade([
      scaleLeg('exit', '6', '110', '10:15'),
      scaleLeg('entry', '4', '100', '09:00'),
    ]))).toContain('exit quantity exceeds the open position at 10:15.');
  });

  it('does not apply to legless or imported trades', () => {
    const legless = { ...validTrade() } as Parameters<typeof validateManualScaleLegs>[0];
    expect(validateManualScaleLegs(legless)).toEqual([]);
    // Imported legs are governed structurally (read-only UI + untouched
    // candidate), never by this validator — there is deliberately no V11.
    expect(validateManualScaleLegs(scaleTrade(
      [scaleLeg('entry', '99', '100', '09:00')],
      { sourcePlatform: 'ninjatrader' },
    ))).toEqual([]);
  });
});
