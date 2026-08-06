/**
 * calculations/analytics.test.ts
 *
 * Phase 23 — Analytics Integrity: characterization tests for the core
 * analytics engine. Before this phase analytics.ts had no test file;
 * computeCoreAnalytics() returns 34 fields, 26 of which are reachable
 * in the UI only through the Backtest tab, and none of which had a
 * value-level assertion anywhere.
 *
 * EXPECTED VALUES ARE HAND-DERIVED from computeCoreAnalytics()'s own
 * FORMULA blocks — never produced by running the function under test.
 * The fixture is identical in construction to rolling.test.ts: symbol
 * 'US100' (f = 1, pv = 1), entryPrice 100, stopLoss 90, positionSize 1,
 * so per tradeCalc.ts:
 *
 *   _r        = (exit - 100) / 10          _pl   = exit - 100
 *   _netPL    = _pl - commission           _rv   = 10
 *   _plannedR = (target - 100) / 10        (null when target is '')
 *   _outcome  = _r > 0.2 Green | _r < -0.2 Red | else Breakeven;
 *               '' when _r is null
 *
 * Class-C fields (recoveryFactor, avgRR, expectancyScore) are asserted
 * as IDENTITIES only — they are documented aliases or deferred fills,
 * so re-deriving them would assert a tautology rather than a formula.
 */
import { describe, expect, it } from 'vitest';
import { enrichTrades } from './tradeCalc.js';
import { computeCoreAnalytics, getWinLossBreakdown, withRecoveryFactor } from './analytics.js';
import { summarizeTrades } from './rolling.js';
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
}

function trade(o: TradeOverrides = {}): Omit<RawTradeContent, '_tid'> {
  return {
    market: 'forex', symbol: 'US100', date: o.date ?? '2026-01-05', broker: '', account: '',
    accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: '', intraDaySetup: '',
    intraDayTF: '', session: '', daySwing: '', linkToChart: '', positionSize: '1',
    direction: 'Long', entryTime: o.entryTime ?? '', exitTime: o.exitTime ?? '',
    entryPrice: '100', stopLoss: '90', target: o.target ?? '', exitPrice: o.exitPrice ?? '',
    commission: o.commission ?? '0', setupType: '', personalRating: '',
    planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '', sl2: '', sl3: '',
    tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '', notes: '',
  };
}

/**
 * MIXED — the shared 6-trade fixture (same table as rolling.test.ts):
 *
 *  #  exit  comm  target  dur   date        _r    _pl   _netPL  _outcome
 *  T1  130   2     150     30m  2026-01-05   3.0    30     28    Green
 *  T2  120   0      —       —   2026-01-05   2.0    20     20    Green
 *  T3   90   3     120     60m  2026-01-06  -1.0   -10    -13    Red
 *  T4   80   0      —      20m  2026-02-10  -2.0   -20    -20    Red
 *  T5  100   0      —       —   2026-02-10   0.0     0      0    Breakeven
 *  T6   ''   0      —       —   2026-02-11  null  null   null    ''
 */
const MIXED = () => enrichTrades([
  trade({ exitPrice: '130', commission: '2', date: '2026-01-05', target: '150', entryTime: '09:00', exitTime: '09:30' }),
  trade({ exitPrice: '120', commission: '0', date: '2026-01-05' }),
  trade({ exitPrice: '90',  commission: '3', date: '2026-01-06', target: '120', entryTime: '10:00', exitTime: '11:00' }),
  trade({ exitPrice: '80',  commission: '0', date: '2026-02-10', entryTime: '10:00', exitTime: '10:20' }),
  trade({ exitPrice: '100', commission: '0', date: '2026-02-10' }),
  trade({ exitPrice: '',    commission: '0', date: '2026-02-11' }),
], accounts);

// ─── getWinLossBreakdown ─────────────────────────────────────

describe('getWinLossBreakdown', () => {
  it('splits on _outcome, placing Breakeven and blank trades in neither bucket', () => {
    // ASSUMPTIONS (analytics.ts:106-108): a scratch trade is neither a
    // win nor a loss. NOTE: `closed` means DECISIVE here — a Breakeven
    // trade is closed in the ordinary sense but is excluded.
    const { winners, losers, closed } = getWinLossBreakdown(MIXED());
    expect(winners.map((t) => t._pl)).toEqual([30, 20]);
    expect(losers.map((t) => t._pl)).toEqual([-10, -20]);
    expect(closed).toHaveLength(4);
    expect(closed.some((t) => t._outcome === 'Breakeven')).toBe(false);
    expect(closed.some((t) => t._outcome === '')).toBe(false);
  });

  it('returns empty arrays for an empty input', () => {
    expect(getWinLossBreakdown([])).toEqual({ winners: [], losers: [], closed: [] });
  });
});

// ─── computeCoreAnalytics — empty baseline ───────────────────

describe('computeCoreAnalytics — empty input', () => {
  it('returns the documented all-null baseline with zero sums', () => {
    // netProfit/grossProfit/grossLoss are 0 (a sum over zero elements
    // is legitimately 0, analytics.ts:270-271); every rate and average
    // requiring a denominator is null.
    expect(computeCoreAnalytics([])).toEqual({
      expectancyR: null, expectancyDollar: null, profitFactor: null,
      recoveryFactor: null, payoffRatio: null,
      avgWinnerDollar: null, avgLoserDollar: null, avgWinR: null, avgLossR: null,
      avgPlannedR: null, avgActualR: null,
      avgHoldingMins: null, avgWinningHoldingMins: null, avgLosingHoldingMins: null,
      avgRiskDollar: null, avgRewardDollar: null, avgRR: null,
      largestWinnerDollar: null, largestLoserDollar: null,
      largestWinningDay: null, largestLosingDay: null,
      winPct: null, lossPct: null, bePct: null,
      netProfit: 0, grossProfit: 0, grossLoss: 0,
      avgCommission: null, commissionPct: null,
      kellyPercent: null, riskOfRuinPercent: null, sqn: null,
      expectancyScore: null, consistencyScore: null,
    });
  });
});

// ─── computeCoreAnalytics — Class A fields over MIXED ────────

describe('computeCoreAnalytics — outcome percentages', () => {
  const c = computeCoreAnalytics(MIXED());

  it('divides each outcome count by ALL trades, not just closed ones', () => {
    expect(c.winPct).toBe(2 / 6);
    expect(c.lossPct).toBe(2 / 6);
    expect(c.bePct).toBe(1 / 6);
  });

  it('does not sum to 100% when blank-outcome trades exist', () => {
    // ASSUMPTIONS (analytics.ts:259-264) — intentional: T6 is counted
    // in the denominator but matches no outcome bucket.
    // toBeCloseTo, not toBe: summing 2/6 + 2/6 + 1/6 left-to-right in
    // IEEE-754 yields 0.8333333333333333 while the literal 5/6 is
    // 0.8333333333333334. That is an artifact of this expression's
    // addition order, not of the values under test — each individual
    // percentage is asserted exactly in the test above.
    expect((c.winPct as number) + (c.lossPct as number) + (c.bePct as number)).toBeCloseTo(5 / 6, 12);
    expect((c.winPct as number) + (c.lossPct as number) + (c.bePct as number)).toBeLessThan(1);
  });
});

describe('computeCoreAnalytics — averages and extrema', () => {
  const c = computeCoreAnalytics(MIXED());

  it('averages winner/loser dollars over the matching bucket only', () => {
    expect(c.avgWinnerDollar).toBe(25);  // (30 + 20) / 2
    expect(c.avgLoserDollar).toBe(-15);  // (-10 + -20) / 2
  });

  it('averages winner/loser R over the matching bucket only', () => {
    expect(c.avgWinR).toBe(2.5);   // (3 + 2) / 2
    expect(c.avgLossR).toBe(-1.5); // (-1 + -2) / 2
  });

  it('takes planned R over ALL trades that have one, excluding trades without a target', () => {
    // T1 -> (150-100)/10 = 5 ; T3 -> (120-100)/10 = 2 ; rest null
    expect(c.avgPlannedR).toBe(3.5); // (5 + 2) / 2
  });

  it('excludes null R from avgActualR rather than counting it as zero', () => {
    // mean(_r) over the 5 non-null values [3, 2, -1, -2, 0] = 2 / 5
    expect(c.avgActualR).toBe(0.4);
  });

  it('averages holding time over all / winners / losers, excluding trades with no duration', () => {
    expect(c.avgHoldingMins).toBe(110 / 3); // (30 + 60 + 20) / 3
    expect(c.avgWinningHoldingMins).toBe(30); // T1 only; T2 has no times
    expect(c.avgLosingHoldingMins).toBe(40);  // (60 + 20) / 2
  });

  it('averages risk over every trade and reward only where both inputs exist', () => {
    expect(c.avgRiskDollar).toBe(10); // _rv is 10 for all six trades
    // FORMULA (analytics.ts:212): mean(_rv * _plannedR) over trades
    // having BOTH -> T1 10*5=50, T3 10*2=20
    expect(c.avgRewardDollar).toBe(35);
  });

  it('reports the extremum of _pl within each bucket', () => {
    expect(c.largestWinnerDollar).toBe(30);
    expect(c.largestLoserDollar).toBe(-20);
  });
});

describe('computeCoreAnalytics — sums and ratios', () => {
  const c = computeCoreAnalytics(MIXED());

  it('sums net P/L treating null as zero', () => {
    expect(c.netProfit).toBe(15); // 28 + 20 - 13 - 20 + 0 + 0
  });

  it('splits gross P/L by sign, keeping gross loss negative', () => {
    // Only strictly-positive _pl counts toward grossProfit, so T5's 0
    // falls in neither bucket.
    expect(c.grossProfit).toBe(50);  // 30 + 20
    expect(c.grossLoss).toBe(-30);   // -10 + -20
  });

  it('computes profit factor as grossProfit / |grossLoss|', () => {
    expect(c.profitFactor).toBe(50 / 30);
  });

  it('computes payoff ratio as avgWinner$ / |avgLoser$|', () => {
    expect(c.payoffRatio).toBe(25 / 15);
  });

  it('computes expectancy over CLOSED trades only', () => {
    // winRateClosed = lossRateClosed = 2/4 = 0.5
    // expectancyR = 0.5*2.5 - 0.5*|-1.5| = 1.25 - 0.75
    expect(c.expectancyR).toBe(0.5);
    // expectancyDollar = 0.5*25 - 0.5*|-15| = 12.5 - 7.5
    expect(c.expectancyDollar).toBe(5);
  });

  it('averages commission over parseable values and expresses it against gross profit', () => {
    expect(c.avgCommission).toBe(5 / 6);   // [2,0,3,0,0,0] / 6
    expect(c.commissionPct).toBe(0.1);     // total 5 / grossProfit 50
  });
});

describe('computeCoreAnalytics — daily rollup', () => {
  const c = computeCoreAnalytics(MIXED());

  it('sums net P/L per calendar date and reports the best and worst day', () => {
    // 2026-01-05: 28+20=48 | 2026-01-06: -13 | 2026-02-10: -20+0=-20 | 2026-02-11: 0
    expect(c.largestWinningDay).toEqual({ date: '2026-01-05', netPL: 48 });
    expect(c.largestLosingDay).toEqual({ date: '2026-02-10', netPL: -20 });
  });

  it('returns null for both when no trade carries a date', () => {
    // ASSUMPTIONS (analytics.ts:249-251)
    const undated = computeCoreAnalytics(enrichTrades([
      trade({ exitPrice: '130', date: '' }), trade({ exitPrice: '80', date: '' }),
    ], accounts));
    expect(undated.largestWinningDay).toBeNull();
    expect(undated.largestLosingDay).toBeNull();
  });

  it('reports the same single day as both best and worst when only one day traded', () => {
    const oneDay = computeCoreAnalytics(enrichTrades([
      trade({ exitPrice: '130', date: '2026-04-01' }), trade({ exitPrice: '80', date: '2026-04-01' }),
    ], accounts));
    expect(oneDay.largestWinningDay).toEqual({ date: '2026-04-01', netPL: 10 }); // 30 + (-20)
    expect(oneDay.largestLosingDay).toEqual({ date: '2026-04-01', netPL: 10 });
  });
});

describe('computeCoreAnalytics — risk/quality scores', () => {
  const c = computeCoreAnalytics(MIXED());

  it('computes Kelly as W - (1-W)/R, clamped to [0,1]', () => {
    // 0.5 - 0.5 / (25/15) = 0.5 - 0.3 = 0.2
    expect(c.kellyPercent).toBeCloseTo(0.2, 12);
  });

  it('reports 100% risk of ruin when the closed-trade edge is not positive', () => {
    // edge = winRateClosed - lossRateClosed = 0.5 - 0.5 = 0 -> <= 0 -> 100
    expect(c.riskOfRuinPercent).toBe(100);
  });

  it('computes SQN as (mean(R)/stddev(R)) * sqrt(min(N,100)) using POPULATION stddev', () => {
    // R = [3, 2, -1, -2, 0]; mean = 2/5 = 0.4
    // deviations 2.6, 1.6, -1.4, -2.4, -0.4
    // squares    6.76, 2.56, 1.96, 5.76, 0.16 -> sum 17.2
    // variance = 17.2 / 5 = 3.44   (divide by n, not n-1)
    expect(c.sqn).toBeCloseTo((0.4 / Math.sqrt(3.44)) * Math.sqrt(5), 12);
  });

  it('caps consistency variability at 100, flooring the score at 0', () => {
    // monthly net P/L: 2026-01 = 28+20-13 = 35 ; 2026-02 = -20+0+0 = -20
    // mean 7.5 ; population stddev 27.5
    // variability = min(100, (27.5/7.5)*100) = 100 -> score = 100 - 100
    expect(c.consistencyScore).toBe(0);
  });

  it('returns a consistency score below the cap when monthly results are close', () => {
    // 2026-01 = 30 ; 2026-02 = 20 -> mean 25, population stddev 5
    // variability = (5/25)*100 = 20 -> score = 80
    const steady = computeCoreAnalytics(enrichTrades([
      trade({ exitPrice: '130', date: '2026-01-05' }),
      trade({ exitPrice: '120', date: '2026-02-05' }),
    ], accounts));
    expect(steady.consistencyScore).toBe(80);
  });

  it('returns a null consistency score with fewer than two trading months', () => {
    const oneMonth = computeCoreAnalytics(enrichTrades([
      trade({ exitPrice: '130', date: '2026-01-05' }), trade({ exitPrice: '80', date: '2026-01-06' }),
    ], accounts));
    expect(oneMonth.consistencyScore).toBeNull();
  });

  it('returns a null SQN when fewer than two trades carry an R value', () => {
    // stddev is undefined for a single data point (analytics.ts:88-89)
    const single = computeCoreAnalytics(enrichTrades([trade({ exitPrice: '130' })], accounts));
    expect(single.sqn).toBeNull();
  });

  it('returns a null SQN when every R is identical (stddev exactly 0)', () => {
    const flat = computeCoreAnalytics(enrichTrades([
      trade({ exitPrice: '130' }), trade({ exitPrice: '130' }),
    ], accounts));
    expect(flat.sqn).toBeNull();
  });
});

describe('computeCoreAnalytics — undefined-denominator cases', () => {
  // A set with winners but NO losers: two Green trades.
  const noLosers = computeCoreAnalytics(enrichTrades([
    trade({ exitPrice: '130' }), trade({ exitPrice: '120' }),
  ], accounts));

  it('returns a null profit factor when there is no losing trade', () => {
    // EDGE CASES (analytics.ts:149-150): undefined/infinite, not 0 or 999
    expect(noLosers.grossLoss).toBe(0);
    expect(noLosers.profitFactor).toBeNull();
  });

  it('returns a null payoff ratio and null Kelly when there is no losing trade', () => {
    expect(noLosers.payoffRatio).toBeNull();
    expect(noLosers.kellyPercent).toBeNull();
  });

  it('returns null expectancy when avgLossR/avgLoser$ do not exist', () => {
    expect(noLosers.expectancyR).toBeNull();
    expect(noLosers.expectancyDollar).toBeNull();
  });

  it('reports zero risk of ruin at a 100% closed win rate', () => {
    // edge = 1 - 0 = 1 -> edge >= 1 -> 0
    expect(noLosers.riskOfRuinPercent).toBe(0);
  });

  it('returns a null commission percentage when gross profit is zero', () => {
    const noProfit = computeCoreAnalytics(enrichTrades([trade({ exitPrice: '80', commission: '4' })], accounts));
    expect(noProfit.grossProfit).toBe(0);
    expect(noProfit.commissionPct).toBeNull();
  });
});

// ─── Class-C fields — identity assertions only ───────────────

describe('computeCoreAnalytics — documented aliases and deferred fills', () => {
  const c = computeCoreAnalytics(MIXED());

  it('exposes avgRR as an alias of avgPlannedR, not a second calculation', () => {
    expect(c.avgRR).toBe(c.avgPlannedR);
  });

  it('exposes expectancyScore as an alias of expectancyR', () => {
    expect(c.expectancyScore).toBe(c.expectancyR);
  });

  it('always leaves recoveryFactor null — it is filled in by withRecoveryFactor()', () => {
    // ASSUMPTIONS (analytics.ts:156-163): max drawdown needs the full
    // equity SEQUENCE, which lives in drawdown.ts; computing it here
    // would create a circular dependency.
    expect(c.recoveryFactor).toBeNull();
  });
});

describe('withRecoveryFactor', () => {
  it('divides net profit by the absolute max drawdown', () => {
    const c = computeCoreAnalytics(MIXED()); // netProfit = 15
    expect(withRecoveryFactor(c, -5).recoveryFactor).toBe(3);
    expect(withRecoveryFactor(c, 5).recoveryFactor).toBe(3);
  });

  it('returns null when max drawdown is zero or unknown', () => {
    const c = computeCoreAnalytics(MIXED());
    expect(withRecoveryFactor(c, 0).recoveryFactor).toBeNull();
    expect(withRecoveryFactor(c, null).recoveryFactor).toBeNull();
  });

  it('does not mutate the analytics object it is given', () => {
    const c = computeCoreAnalytics(MIXED());
    const filled = withRecoveryFactor(c, -5);
    expect(c.recoveryFactor).toBeNull();
    expect(filled).not.toBe(c);
    expect(filled.netProfit).toBe(c.netProfit);
  });
});

// ─── The divergence guard ────────────────────────────────────

describe('win-rate vocabulary: winPct and summarizeTrades().wr are different metrics', () => {
  it('yields different values whenever Breakeven or blank-outcome trades exist', () => {
    // This is the property Phase 23's label disambiguation exists to
    // communicate. Both formulas are correct and intentional
    // (analytics.ts:256-258); they answer different questions:
    //   summarizeTrades().wr = Green / (Green + Red)  -> 2 / 4
    //   core.winPct          = Green / total trades   -> 2 / 6
    const trades = MIXED();
    const wr = summarizeTrades(trades).wr;
    const winPct = computeCoreAnalytics(trades).winPct;

    expect(wr).toBe(0.5);
    expect(winPct).toBe(2 / 6);
    expect(wr).not.toBe(winPct);
  });

  it('agrees only when every trade is decisive', () => {
    const decisive = enrichTrades([
      trade({ exitPrice: '130' }), trade({ exitPrice: '120' }), trade({ exitPrice: '80' }),
    ], accounts);
    expect(summarizeTrades(decisive).wr).toBe(computeCoreAnalytics(decisive).winPct);
  });
});

describe('finite aggregate integrity', () => {
  it('makes CoreAnalytics scalar sums and daily extrema null on positive overflow', () => {
    const [a, b] = MIXED();
    Object.assign(a, { date: '2026-03-01', _pl: 1e308, _netPL: 1e308 });
    Object.assign(b, { date: '2026-03-01', _pl: 1e308, _netPL: 1e308 });
    const core = computeCoreAnalytics([a, b]);
    expect(core.netProfit).toBeNull();
    expect(core.grossProfit).toBeNull();
    expect(core.largestWinningDay).toBeNull();
    expect(core.largestLosingDay).toBeNull();
  });

  it('makes grossLoss null on negative overflow', () => {
    const [a, b] = MIXED();
    Object.assign(a, { _pl: -1e308, _netPL: -1e308 });
    Object.assign(b, { _pl: -1e308, _netPL: -1e308 });
    const core = computeCoreAnalytics([a, b]);
    expect(core.netProfit).toBeNull();
    expect(core.grossLoss).toBeNull();
  });

  it('does not silently omit finite reward multiplication overflow', () => {
    const [a] = MIXED();
    Object.assign(a, { _rv: 1e308, _plannedR: 1e308 });
    expect(computeCoreAnalytics([a]).avgRewardDollar).toBeNull();
  });

  it('keeps a valid aggregate finite when another enriched value is unavailable', () => {
    const trades = enrichTrades([
      trade({ exitPrice: 'BE', commission: '0' }),
      trade({ exitPrice: '120', commission: '0' }),
    ], accounts);
    expect(computeCoreAnalytics(trades).netProfit).toBe(20);
  });

  it('returns null recovery factor when finite division overflows', () => {
    const core = { ...computeCoreAnalytics([]), netProfit: 1e308 };
    expect(withRecoveryFactor(core, 1e-308).recoveryFactor).toBeNull();
  });
});
