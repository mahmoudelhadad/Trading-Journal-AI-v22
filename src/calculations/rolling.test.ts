/**
 * calculations/rolling.test.ts
 *
 * Phase 23 — Analytics Integrity: characterization tests for the shared
 * aggregation primitives. Before this phase rolling.ts had no test file
 * at all; it appeared in backtest.test.ts only as a self-referential
 * oracle (`expect(result.summary).toEqual(summarizeTrades(matched))`),
 * which proves composition but never a value.
 *
 * summarizeTrades() is the most-called calculation in the application
 * (Dashboard, Insights, Strategy, backtest.ts, and internally by
 * aggregateByPeriod/getRollingStats), so its documented contract is
 * pinned here field by field.
 *
 * EXPECTED VALUES ARE HAND-DERIVED from each function's documented
 * FORMULA block — never produced by running the function under test.
 * The fixture makes that derivation checkable by hand: symbol 'US100'
 * has f = 1 and pv = 1 (constants/pipValues.js), and every trade uses
 * entryPrice 100 / stopLoss 90 / positionSize 1, so per tradeCalc.ts:
 *
 *   _r      = (exitPrice - 100) / |100 - 90|  = (exit - 100) / 10
 *   _pl     = 1 * (exit - 100) * 1 * 1        = exit - 100
 *   _netPL  = _pl - commission
 *   _rv     = 1 * |100 - 90| * 1 * 1          = 10
 *   _outcome: _r > 0.2 -> Green, _r < -0.2 -> Red, else Breakeven;
 *             '' when _r is null (calcOutcome, tradeCalc.ts:184)
 *
 * An empty exitPrice makes calcR/calcPL return null, which is how the
 * blank-outcome ('') case is produced.
 *
 * Class-B functions (getTradeFrequency, getRollingStats,
 * getStandardRollingWindows, and getWeekKey's Monday-start semantics)
 * are deliberately NOT covered — they carry no Formula/Source/
 * Assumptions/Edge-case block, so a test would manufacture a contract
 * rather than verify one. See the Phase 23 RFC §6.
 */
import { describe, expect, it } from 'vitest';
import { enrichTrades } from './tradeCalc.js';
import { summarizeTrades, groupTradesBy, aggregateByPeriod } from './rolling.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 1000 } as Account];

interface TradeOverrides {
  exitPrice?: string;
  commission?: string;
  date?: string;
  target?: string;
  entryTime?: string;
  exitTime?: string;
  entrySetup?: string;
  session?: string;
}

function trade(o: TradeOverrides = {}): Omit<RawTradeContent, '_tid'> {
  return {
    market: 'forex', symbol: 'US100', date: o.date ?? '2026-01-05', broker: '', account: '',
    accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: o.entrySetup ?? '',
    intraDaySetup: '', intraDayTF: '', session: o.session ?? '', daySwing: '', linkToChart: '',
    positionSize: '1', direction: 'Long', entryTime: o.entryTime ?? '', exitTime: o.exitTime ?? '',
    entryPrice: '100', stopLoss: '90', target: o.target ?? '', exitPrice: o.exitPrice ?? '',
    commission: o.commission ?? '0', setupType: '', personalRating: '',
    planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '', sl2: '', sl3: '',
    tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '', notes: '',
  };
}

/**
 * MIXED — the shared 6-trade fixture. Hand-derived enrichment:
 *
 *  #  exit  comm  date        _r    _pl   _netPL  _outcome
 *  T1  130   2    2026-01-05   3.0    30     28    Green
 *  T2  120   0    2026-01-05   2.0    20     20    Green
 *  T3   90   3    2026-01-06  -1.0   -10    -13    Red
 *  T4   80   0    2026-02-10  -2.0   -20    -20    Red
 *  T5  100   0    2026-02-10   0.0     0      0    Breakeven
 *  T6   ''   0    2026-02-11  null  null   null    ''        (blank)
 *
 * Deliberately contains BOTH a Breakeven and a blank-outcome trade, the
 * two categories that make green/(green+red) and green/n diverge.
 */
const MIXED = () => enrichTrades([
  trade({ exitPrice: '130', commission: '2', date: '2026-01-05', target: '150', entryTime: '09:00', exitTime: '09:30' }),
  trade({ exitPrice: '120', commission: '0', date: '2026-01-05' }),
  trade({ exitPrice: '90',  commission: '3', date: '2026-01-06', target: '120', entryTime: '10:00', exitTime: '11:00' }),
  trade({ exitPrice: '80',  commission: '0', date: '2026-02-10', entryTime: '10:00', exitTime: '10:20' }),
  trade({ exitPrice: '100', commission: '0', date: '2026-02-10' }),
  trade({ exitPrice: '',    commission: '0', date: '2026-02-11' }),
], accounts);

// ─── summarizeTrades ─────────────────────────────────────────

describe('summarizeTrades', () => {
  it('returns the documented empty-input baseline', () => {
    // EDGE CASES (rolling.ts:106-109): sums are legitimately 0, but
    // rate/average fields needing a non-zero denominator are null.
    expect(summarizeTrades([])).toEqual({
      n: 0, green: 0, red: 0, be: 0, wr: null, totalR: 0, avgR: null, pl: 0, netPL: 0,
    });
  });

  it('computes every documented field over a mixed set', () => {
    const s = summarizeTrades(MIXED());

    // n = ts.length
    expect(s.n).toBe(6);
    // counts by _outcome
    expect(s.green).toBe(2); // T1, T2
    expect(s.red).toBe(2);   // T3, T4
    expect(s.be).toBe(1);    // T5 (T6 is '', counted in none)

    // wr = green / (green + red) = 2 / 4
    expect(s.wr).toBe(0.5);

    // totalR = sum(_r ?? 0) = 3 + 2 - 1 - 2 + 0 + 0
    expect(s.totalR).toBe(2);
    // avgR = totalR / n = 2 / 6  — null counted as 0 in the numerator
    // but still counted in the denominator (this is what distinguishes
    // it from analytics.ts's avgActualR)
    expect(s.avgR).toBe(2 / 6);

    // pl = sum(_pl ?? 0) = 30 + 20 - 10 - 20 + 0 + 0
    expect(s.pl).toBe(20);
    // netPL = sum(_netPL ?? 0) = 28 + 20 - 13 - 20 + 0 + 0
    expect(s.netPL).toBe(15);
  });

  it('returns wr === null when no trade is decisive (all Breakeven)', () => {
    // green + red === 0 -> denominator 0 -> null, not 0
    const s = summarizeTrades(enrichTrades([
      trade({ exitPrice: '100' }), trade({ exitPrice: '101' }), trade({ exitPrice: '99' }),
    ], accounts));
    expect(s.be).toBe(3);
    expect(s.green).toBe(0);
    expect(s.red).toBe(0);
    expect(s.wr).toBeNull();
  });

  it('treats blank-outcome trades as zero contributors but still counts them in n', () => {
    // Two trades with no exitPrice: _r/_pl/_netPL all null, _outcome ''
    const s = summarizeTrades(enrichTrades([trade(), trade()], accounts));
    expect(s.n).toBe(2);
    expect(s.green + s.red + s.be).toBe(0);
    expect(s.wr).toBeNull();
    expect(s.totalR).toBe(0);
    // avgR is 0, NOT null: n > 0, and null R values contribute 0
    expect(s.avgR).toBe(0);
    expect(s.pl).toBe(0);
    expect(s.netPL).toBe(0);
  });

  it('returns nullable aggregate fields for positive and negative finite-operand overflow', () => {
    const [a, b] = MIXED();
    Object.assign(a, { _r: 1e308, _pl: 1e308, _netPL: 1e308 });
    Object.assign(b, { _r: 1e308, _pl: 1e308, _netPL: 1e308 });
    expect(summarizeTrades([a, b])).toMatchObject({ totalR: null, avgR: null, pl: null, netPL: null });

    Object.assign(a, { _r: -1e308, _pl: -1e308, _netPL: -1e308 });
    Object.assign(b, { _r: -1e308, _pl: -1e308, _netPL: -1e308 });
    expect(summarizeTrades([a, b])).toMatchObject({ totalR: null, avgR: null, pl: null, netPL: null });
  });
});

// ─── groupTradesBy ───────────────────────────────────────────

describe('groupTradesBy', () => {
  it('accumulates trades into buckets keyed by keyFn', () => {
    const ts = enrichTrades([
      trade({ entrySetup: 'FVG' }), trade({ entrySetup: 'BB' }), trade({ entrySetup: 'FVG' }),
    ], accounts);
    const groups = groupTradesBy(ts, (t) => t.entrySetup);
    expect(Object.keys(groups).sort()).toEqual(['BB', 'FVG']);
    expect(groups.FVG).toHaveLength(2);
    expect(groups.BB).toHaveLength(1);
  });

  it('excludes trades whose key is null, undefined or the empty string', () => {
    // FORMULA (rolling.ts:137-143): skip the trade entirely if keyFn
    // returns null/undefined/'' — the falsy-check convention.
    const ts = enrichTrades([
      trade({ entrySetup: 'FVG' }), trade({ entrySetup: '' }), trade({ entrySetup: 'BB' }),
    ], accounts);
    expect(Object.keys(groupTradesBy(ts, (t) => t.entrySetup)).sort()).toEqual(['BB', 'FVG']);
    expect(groupTradesBy(ts, () => null)).toEqual({});
    expect(groupTradesBy(ts, () => undefined)).toEqual({});
    expect(groupTradesBy(ts, () => '')).toEqual({});
  });

  it('stringifies non-string keys', () => {
    const ts = enrichTrades([trade(), trade()], accounts);
    const groups = groupTradesBy(ts, () => 7);
    expect(Object.keys(groups)).toEqual(['7']);
    expect(groups['7']).toHaveLength(2);
  });
});

// ─── aggregateByPeriod ───────────────────────────────────────

describe('aggregateByPeriod', () => {
  it("groups by calendar day and maps onto the PeriodStats shape, sorted ascending", () => {
    // Hand-derived per day from the MIXED table above:
    //   2026-01-05: T1+T2 -> n 2, totalR 3+2=5,  netPL 28+20=48, wr 2/(2+0)=1
    //   2026-01-06: T3    -> n 1, totalR -1,     netPL -13,      wr 0/(0+1)=0
    //   2026-02-10: T4+T5 -> n 2, totalR -2+0=-2, netPL -20+0=-20, wr 0/(0+1)=0
    //   2026-02-11: T6    -> n 1, totalR 0,      netPL 0,        wr null (no decisive trade)
    expect(aggregateByPeriod(MIXED(), 'day')).toEqual([
      { key: '2026-01-05', trades: 2, totalR: 5,  netPL: 48,  winRate: 1 },
      { key: '2026-01-06', trades: 1, totalR: -1, netPL: -13, winRate: 0 },
      { key: '2026-02-10', trades: 2, totalR: -2, netPL: -20, winRate: 0 },
      { key: '2026-02-11', trades: 1, totalR: 0,  netPL: 0,   winRate: null },
    ]);
  });

  it('groups by calendar month using the YYYY-MM key', () => {
    //   2026-01: T1,T2,T3 -> n 3, totalR 5-1=4, netPL 48-13=35, wr 2/(2+1)=2/3
    //   2026-02: T4,T5,T6 -> n 3, totalR -2,    netPL -20,      wr 0/(0+1)=0
    expect(aggregateByPeriod(MIXED(), 'month')).toEqual([
      { key: '2026-01', trades: 3, totalR: 4,  netPL: 35,  winRate: 2 / 3 },
      { key: '2026-02', trades: 3, totalR: -2, netPL: -20, winRate: 0 },
    ]);
  });

  it('silently excludes trades with no date, returning [] when none have one', () => {
    // ASSUMPTIONS (rolling.ts:188-189)
    const dateless = enrichTrades([trade({ date: '' }), trade({ date: '' })], accounts);
    expect(aggregateByPeriod(dateless, 'day')).toEqual([]);
    expect(aggregateByPeriod(dateless, 'month')).toEqual([]);

    const partial = enrichTrades([trade({ exitPrice: '130', date: '2026-03-02' }), trade({ date: '' })], accounts);
    expect(aggregateByPeriod(partial, 'day').map((p) => p.key)).toEqual(['2026-03-02']);
  });

  it('excludes malformed dates and exposes period arithmetic overflow as null', () => {
    const malformed = enrichTrades([trade({ date: 'not-a-date', exitPrice: '120' })], accounts);
    expect(aggregateByPeriod(malformed, 'week')).toEqual([]);

    const [a, b] = MIXED();
    Object.assign(a, { date: '2026-03-01', _r: 1e308, _netPL: 1e308 });
    Object.assign(b, { date: '2026-03-01', _r: 1e308, _netPL: 1e308 });
    expect(aggregateByPeriod([a, b], 'day')).toEqual([
      { key: '2026-03-01', trades: 2, totalR: null, netPL: null, winRate: 1 },
    ]);
  });

  it("partitions every dated trade exactly once for 'week', in ascending key order", () => {
    // SHAPE AND SORT ONLY. The Monday-start key itself comes from the
    // private, undocumented getWeekKey(), which builds a LOCAL date and
    // then reads toISOString() — an environment-dependent behavior
    // deferred by the Phase 23 RFC (§6, R-4). Asserting a literal week
    // key here would freeze that behavior as though it were a contract.
    const weekly = aggregateByPeriod(MIXED(), 'week');
    const keys = weekly.map((p) => p.key);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    // All 6 MIXED trades carry a date, so none may be dropped.
    expect(weekly.reduce((s, p) => s + p.trades, 0)).toBe(6);
    expect(weekly.reduce((s, p) => s + (p.netPL as number), 0)).toBe(15);
  });
});
