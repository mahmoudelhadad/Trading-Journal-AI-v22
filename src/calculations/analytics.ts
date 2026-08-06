/**
 * calculations/analytics.ts
 *
 * Phase 8 — Analytics Engine: Advanced trading statistics.
 *
 * ALL metrics in this file are NEW — none existed in the original
 * single-file app (which only computed basic win-rate/R/P&L math inline
 * per-page). There is no "original behavior" to preserve here; every
 * formula is documented below with Formula / Source / Assumptions /
 * Edge-case handling, per the standard established in this phase.
 *
 * This module operates purely on already-enriched trades (EnrichedTrade[])
 * - it does not touch LocalStorage, accounts, or any existing calculation
 * in tradeCalc.ts. Zero existing business logic is modified.
 *
 * Per Phase 9 instructions: this module remains independent of the UI
 * until a consuming page explicitly imports it (Equity page - Phase 9
 * consumes computeDrawdownFromTrades from drawdown.ts, not this file yet;
 * Strategy/Insights pages will consume this file in later phases).
 */

import {
  finiteOrNull, isFiniteNumber, sumFinite, toFiniteNumber,
  type EnrichedTrade,
} from './tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface WinLossBreakdown {
  winners: EnrichedTrade[];
  losers:  EnrichedTrade[];
  /** Green + Red only (excludes Breakeven and unclosed trades) */
  closed:  EnrichedTrade[];
}

export interface CoreAnalytics {
  expectancyR:       number | null;
  expectancyDollar:  number | null;
  profitFactor:      number | null;
  recoveryFactor:    number | null;
  payoffRatio:       number | null;

  avgWinnerDollar:   number | null;
  avgLoserDollar:    number | null;
  avgWinR:           number | null;
  avgLossR:          number | null;
  avgPlannedR:       number | null;
  avgActualR:        number | null;
  avgHoldingMins:        number | null;
  avgWinningHoldingMins: number | null;
  avgLosingHoldingMins:  number | null;
  avgRiskDollar:     number | null;
  avgRewardDollar:   number | null;
  avgRR:             number | null;

  largestWinnerDollar: number | null;
  largestLoserDollar:  number | null;
  largestWinningDay:   { date: string; netPL: number } | null;
  largestLosingDay:    { date: string; netPL: number } | null;

  winPct:  number | null;
  lossPct: number | null;
  bePct:   number | null;

  netProfit:   number | null;
  grossProfit: number | null;
  grossLoss:   number | null;

  avgCommission:  number | null;
  commissionPct:  number | null;

  kellyPercent:      number | null;
  riskOfRuinPercent: number | null;
  sqn: number | null;
  expectancyScore: number | null;
  consistencyScore: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────

const sum = (arr: number[]): number | null => sumFinite(arr);
const mean = (arr: number[]): number | null => {
  if (arr.length === 0) return null;
  const total = sum(arr);
  return total === null ? null : finiteOrNull(total / arr.length);
};

/**
 * Population standard deviation.
 * FORMULA:   stddev = sqrt( sum((x - mean)^2) / n )
 * SOURCE:    Standard statistical definition (population, not sample —
 *            divides by n, not n-1, consistent with treating the full
 *            trade history as the complete population under analysis).
 * ASSUMPTIONS: None beyond standard statistics.
 * EDGE CASES: Returns null for arrays with fewer than 2 elements
 *            (stddev is undefined/meaningless for 0 or 1 data points).
 */
function stddev(arr: number[]): number | null {
  if (arr.length < 2) return null;
  const m = mean(arr);
  if (m === null) return null;
  const squaredDiffs: number[] = [];
  for (const value of arr) {
    const squared = finiteOrNull((value - m) ** 2);
    if (squared === null) return null;
    squaredDiffs.push(squared);
  }
  const squaredTotal = sum(squaredDiffs);
  if (squaredTotal === null) return null;
  const variance = finiteOrNull(squaredTotal / arr.length);
  return variance === null ? null : finiteOrNull(Math.sqrt(variance));
}

/**
 * Split trades into winners/losers/closed.
 * FORMULA:   winners = trades where _outcome === 'Green'
 *            losers  = trades where _outcome === 'Red'
 *            closed  = winners + losers (excludes 'Breakeven' and '')
 * SOURCE:    Uses the existing _outcome classification from tradeCalc.ts
 *            (calcOutcome: R > 0.2 = Green, R < -0.2 = Red, else Breakeven) —
 *            this file does not redefine what counts as a win/loss.
 * ASSUMPTIONS: Breakeven trades are excluded from win/loss ratio math
 *            everywhere in this file, matching standard trading-journal
 *            convention (a scratch trade is neither a win nor a loss).
 * EDGE CASES: Returns empty arrays for an empty input, never throws.
 */
export function getWinLossBreakdown(trades: EnrichedTrade[]): WinLossBreakdown {
  const winners = trades.filter((t) => t._outcome === 'Green');
  const losers  = trades.filter((t) => t._outcome === 'Red');
  const closed  = trades.filter((t) => t._outcome === 'Green' || t._outcome === 'Red');
  return { winners, losers, closed };
}

// ─── Main entry point ──────────────────────────────────────────

/**
 * Compute the full Core Analytics object for a set of enriched trades.
 * Pure function - no side effects, no hooks, no UI dependency.
 *
 * Every field below is documented with its formula, source, assumptions,
 * and edge-case handling. Fields are computed independently — a missing
 * input for one metric never prevents another metric from being computed.
 *
 * ─────────────────────────────────────────────────────────────
 * expectancyR
 *   FORMULA:     (WinRate x AvgWinR) - (LossRate x |AvgLossR|)
 *                WinRate/LossRate computed over CLOSED trades only.
 *   SOURCE:      Standard "trading expectancy" formula (Van Tharp,
 *                "Trade Your Way to Financial Freedom").
 *   ASSUMPTIONS: Requires at least 1 closed (Green/Red) trade with valid R.
 *   EDGE CASES:  null if no closed trades, or if avgWinR/avgLossR
 *                themselves are null (e.g. all closed trades missing R).
 *
 * expectancyDollar
 *   FORMULA:     (WinRate x AvgWinner$) - (LossRate x |AvgLoser$|)
 *   SOURCE:      Same as expectancyR, expressed in dollars instead of R.
 *   ASSUMPTIONS: Same as expectancyR.
 *   EDGE CASES:  Same as expectancyR.
 *
 * profitFactor
 *   FORMULA:     GrossProfit / |GrossLoss|
 *   SOURCE:      Standard industry metric (used by nearly all trading
 *                platforms — MT4/5, TradingView strategy tester, etc.).
 *   ASSUMPTIONS: Uses gross (pre-commission) P/L, not net.
 *   EDGE CASES:  null when GrossLoss is 0 (no losing trades — profit
 *                factor is undefined/infinite in that case, not "0" or "999").
 *
 * recoveryFactor
 *   FORMULA:     NetProfit / |MaxDrawdown$|
 *   SOURCE:      Standard metric relating total return to worst
 *                observed equity decline.
 *   ASSUMPTIONS: NOT computed by this function directly — max drawdown
 *                requires the full equity SEQUENCE (order-dependent),
 *                which lives in drawdown.ts, not this file. This field
 *                is always null immediately after computeCoreAnalytics()
 *                and must be filled in via withRecoveryFactor() (below)
 *                once the caller has computed drawdown separately. This
 *                avoids a circular dependency between analytics.ts and
 *                drawdown.ts.
 *   EDGE CASES:  null until withRecoveryFactor() is applied, or if
 *                maxDrawdownDollar is 0 (no losing period at all).
 *
 * payoffRatio
 *   FORMULA:     AvgWinner$ / |AvgLoser$|
 *   SOURCE:      Standard "Win/Loss Ratio" — used directly by the Kelly
 *                Criterion formula below.
 *   ASSUMPTIONS: None beyond requiring both averages to exist.
 *   EDGE CASES:  null if there are no losers (division by zero) or no winners.
 * ─────────────────────────────────────────────────────────────
 * avgWinnerDollar / avgLoserDollar
 *   FORMULA:     mean(_pl) over winners / losers respectively
 *   SOURCE:      Direct average of the existing _pl field (gross P/L,
 *                computed in tradeCalc.ts, unchanged by this file).
 *   ASSUMPTIONS: Trades with a null _pl (incomplete data) are excluded
 *                from the average, not treated as zero.
 *   EDGE CASES:  null if there are zero winners / losers.
 *
 * avgWinR / avgLossR
 *   FORMULA:     mean(_r) over winners / losers respectively
 *   SOURCE:      Direct average of the existing _r field (R multiple).
 *   ASSUMPTIONS/EDGE CASES: Same as avgWinnerDollar/avgLoserDollar.
 *
 * avgPlannedR / avgActualR
 *   FORMULA:     mean(_plannedR) / mean(_r) over ALL trades in the set
 *                (not just closed ones).
 *   SOURCE:      Direct averages of existing computed fields.
 *   ASSUMPTIONS: avgActualR is intentionally the same computation as
 *                the "Avg R" KPI already shown on the Dashboard page
 *                (Phase 6) — this is a deliberate duplication accepted
 *                per the "temporary duplication acceptable during
 *                migration" rule; long-term consolidation is deferred.
 *   EDGE CASES:  null if no trades have a non-null value for that field.
 *
 * avgHoldingMins / avgWinningHoldingMins / avgLosingHoldingMins
 *   FORMULA:     mean(_durMins) over all / winners / losers respectively
 *   SOURCE:      Direct average of the existing _durMins field
 *                (computed in tradeCalc.ts from entryTime/exitTime).
 *   ASSUMPTIONS: Trades without both entry and exit time recorded have
 *                a null _durMins and are excluded from the average.
 *   EDGE CASES:  null if no trades in that category have duration data.
 *
 * avgRiskDollar
 *   FORMULA:     mean(_rv) over all trades
 *   SOURCE:      Direct average of the existing _rv field ($ risk value).
 *   EDGE CASES:  null if no trades have risk data.
 *
 * avgRewardDollar
 *   FORMULA:     mean(_rv x _plannedR) over trades having BOTH fields
 *   SOURCE:      Derived, not a direct field — since _plannedR is a
 *                ratio (planned reward:risk) and _rv is the $ risk,
 *                their product is the planned dollar reward. No
 *                separate "$ reward" field exists elsewhere in the app.
 *   ASSUMPTIONS: This assumes the planned reward scales linearly with
 *                position size the same way risk does (true for this
 *                app's position-sizing model, where both risk and
 *                reward are computed from the same entry/SL/target
 *                geometry and the same position size).
 *   EDGE CASES:  A trade is excluded from this average (not treated as
 *                zero) if EITHER _rv or _plannedR is null.
 *
 * avgRR
 *   FORMULA:     Identical value to avgPlannedR.
 *   SOURCE:      By construction, _plannedR IS the planned reward:risk
 *                ratio (see calcPlannedR in tradeCalc.ts — it's exactly
 *                (target-entry)/(entry-SL) or the inverse for shorts,
 *                which is the definition of a reward:risk ratio).
 *   ASSUMPTIONS: This field exists as a named alias for clarity/API
 *                completeness (matching the migration plan's explicit
 *                "Average RR" requirement) — it is intentionally NOT a
 *                separate calculation, to avoid computing the same
 *                number twice under two different formulas.
 * ─────────────────────────────────────────────────────────────
 * largestWinnerDollar / largestLoserDollar
 *   FORMULA:     max(_pl) over winners / min(_pl) over losers
 *   SOURCE:      Direct extremum of the existing _pl field.
 *   EDGE CASES:  null if there are zero winners / losers.
 *
 * largestWinningDay / largestLosingDay
 *   FORMULA:     Group all trades by calendar date (t.date), sum
 *                _netPL per date, return the date with the highest /
 *                lowest sum.
 *   SOURCE:      New aggregation — no equivalent existed in the
 *                original app (which had no cross-trade daily rollup
 *                outside the not-yet-migrated Daily period tab).
 *   ASSUMPTIONS: Trades without a date field are excluded from this
 *                aggregation entirely (cannot be attributed to a day).
 *   EDGE CASES:  null if no trades have a date at all.
 * ─────────────────────────────────────────────────────────────
 * winPct / lossPct / bePct
 *   FORMULA:     count(outcome) / totalTradeCount, where totalTradeCount
 *                is ALL trades in the input set (not just closed ones).
 *   SOURCE:      New metric. Deliberately different denominator from
 *                the existing "Win Rate" KPI on the Dashboard page,
 *                which divides by (green+red) only — see Assumptions.
 *   ASSUMPTIONS: winPct + lossPct + bePct will NOT sum to 100% if any
 *                trades have outcome '' (empty — e.g. missing entry/
 *                exit price data), since those are counted in the
 *                denominator but don't match any of the three outcome
 *                buckets. This is intentional: it correctly reflects
 *                "% of ALL logged trades," including incomplete ones.
 *   EDGE CASES:  null if the trade set is empty.
 * ─────────────────────────────────────────────────────────────
 * netProfit
 *   FORMULA:     sum(_netPL) over all trades (null treated as 0)
 *   SOURCE:      Direct sum of the existing _netPL field.
 *   EDGE CASES:  0 (not null) for an empty trade set — a sum over
 *                zero elements is legitimately 0, not "unknown."
 *
 * grossProfit / grossLoss
 *   FORMULA:     grossProfit = sum(_pl) where _pl > 0
 *                grossLoss   = sum(_pl) where _pl < 0  (kept NEGATIVE)
 *   SOURCE:      Standard trading-platform convention. grossLoss is
 *                intentionally signed negative (not an absolute value)
 *                so that grossProfit + grossLoss = net gross P/L.
 *   EDGE CASES:  0 for an empty trade set or a set with no winners/losers.
 * ─────────────────────────────────────────────────────────────
 * avgCommission
 *   FORMULA:     mean(parseFloat(commission)) over trades with a
 *                parseable commission value
 *   SOURCE:      Direct average of the existing commission form field
 *                (stored as a string, per the original app's form design).
 *   EDGE CASES:  Trades with an empty or non-numeric commission string
 *                are excluded (not treated as 0). Returns null if no
 *                trade has a valid commission value.
 *
 * commissionPct
 *   FORMULA:     totalCommission / grossProfit
 *   SOURCE:      New metric — expresses commission drag as a % of
 *                gross winnings.
 *   ASSUMPTIONS: Denominator is grossProfit (winning trades only), not
 *                gross volume or total P/L, since commission is most
 *                meaningfully compared against what was actually won.
 *   EDGE CASES:  null if grossProfit is 0 (would be division by zero,
 *                or the ratio would be meaningless if there's no
 *                profit to compare against).
 * ─────────────────────────────────────────────────────────────
 * kellyPercent
 *   FORMULA:     K = W - (1-W)/R
 *                where W = win rate (decimal, closed trades only),
 *                      R = payoffRatio
 *                Result clamped to [0, 1].
 *   SOURCE:      Classic Kelly Criterion for binary win/loss betting
 *                (Kelly, J.L. "A New Interpretation of Information
 *                Rate," 1956; widely adapted for trading position
 *                sizing in trading literature).
 *   ASSUMPTIONS: This is the SIMPLE (binary-outcome) Kelly formula. It
 *                assumes a fixed win/loss payoff ratio across all
 *                trades, which is an approximation — real trade R
 *                multiples vary per trade. Treat this as a rough sizing
 *                guide, not a precise optimum.
 *   EDGE CASES:  null if payoffRatio is null or <= 0. Clamped to 0 if
 *                the raw Kelly value is negative (a negative Kelly
 *                means "this system has no edge — do not bet," which
 *                this function reports as 0% rather than a negative
 *                position size).
 *
 * riskOfRuinPercent
 *   FORMULA:     edge = winRate - lossRate  (closed trades only)
 *                if edge <= 0: 100 (ruin considered certain over time)
 *                if edge >= 1: 0   (only possible with 100% win rate)
 *                else: RoR = ((1-edge)/(1+edge))^N x 100, where N =
 *                      number of closed trades
 *   SOURCE:      A simplified "gambler's ruin"-style approximation
 *                commonly cited in retail trading-education material.
 *                This is NOT the rigorous, capital-and-position-size-
 *                aware Risk of Ruin model used in professional risk
 *                management (which requires Monte Carlo simulation or
 *                a closed-form model incorporating account size and
 *                risk-per-trade). No single canonical formula exists
 *                for this metric across the industry.
 *   ASSUMPTIONS: Uses a simple win%-minus-loss% "edge" proxy rather
 *                than an edge computed from expectancy/R — this is a
 *                deliberate simplification, documented here so a more
 *                rigorous model can replace it later without ambiguity
 *                about what the original implementation assumed.
 *   EDGE CASES:  null if there are zero closed trades. Result is
 *                clamped to [0, 100].
 *
 * sqn
 *   FORMULA:     SQN = (mean(R) / stddev(R)) x sqrt(min(N, 100))
 *                where R = the _r field across ALL trades with a
 *                non-null value, N = count of those trades.
 *   SOURCE:      Van Tharp's System Quality Number ("Trade Your Way to
 *                Financial Freedom," Van K. Tharp, 2006).
 *   ASSUMPTIONS: Per Van Tharp's original convention, N is capped at
 *                100 in the sqrt term — using more than 100 trades
 *                would overstate statistical significance beyond what
 *                Tharp's scale (which tops out around SQN=7 for
 *                "Holy Grail" systems) was calibrated for.
 *   EDGE CASES:  null if stddev(R) is null (fewer than 2 trades with R)
 *                or exactly 0 (every trade has an identical R — division
 *                by zero avoided).
 *
 * expectancyScore
 *   FORMULA:     Identical value to expectancyR.
 *   SOURCE:      The migration plan lists "Expectancy" and "Expectancy
 *                Score" as separate line items; in standard trading
 *                literature (including Van Tharp's own SQN framework)
 *                these refer to the same underlying R-multiple
 *                expectancy value. Exposed as a named alias for API
 *                completeness, not computed twice.
 *
 * consistencyScore
 *   FORMULA:     monthlyPL[] = net P/L summed per calendar month
 *                variability = min(100, (stddev(monthlyPL) / |mean(monthlyPL)|) x 100)
 *                score = 100 - variability
 *   SOURCE:      ORIGINAL definition — no industry-standard
 *                "Consistency Score" formula exists. This uses the
 *                coefficient of variation (stddev/mean) of monthly P/L,
 *                inverted onto a 0-100 scale, as a reasonable proxy for
 *                "how similar were my results month to month." This
 *                formula should be treated as a working definition, not
 *                an authoritative one, and can be revisited if a more
 *                standard metric is preferred later.
 *   ASSUMPTIONS: Requires at least 2 distinct calendar months of
 *                trading activity — a single month has no variability
 *                to measure. If the mean monthly P/L is exactly 0, the
 *                score is left null (division by zero avoided) rather
 *                than reporting a misleading extreme value.
 *   EDGE CASES:  null with 0 or 1 trading months, or if mean monthly
 *                P/L is exactly 0.
 * ─────────────────────────────────────────────────────────────
 */
export function computeCoreAnalytics(trades: EnrichedTrade[]): CoreAnalytics {
  const n = trades.length;
  const { winners, losers, closed } = getWinLossBreakdown(trades);
  const nClosed = closed.length;

  const beCountAll = trades.filter((t) => t._outcome === 'Breakeven').length;
  const winPct  = n > 0 ? finiteOrNull(winners.length / n) : null;
  const lossPct = n > 0 ? finiteOrNull(losers.length  / n) : null;
  const bePct   = n > 0 ? finiteOrNull(beCountAll     / n) : null;

  const winnerDollars = winners.map((t) => t._pl).filter(isFiniteNumber);
  const loserDollars  = losers.map((t) => t._pl).filter(isFiniteNumber);
  const avgWinnerDollar = mean(winnerDollars);
  const avgLoserDollar  = mean(loserDollars);

  const largestWinnerDollar = winnerDollars.length > 0 ? Math.max(...winnerDollars) : null;
  const largestLoserDollar  = loserDollars.length  > 0 ? Math.min(...loserDollars)  : null;

  const winRs = winners.map((t) => t._r).filter(isFiniteNumber);
  const lossRs = losers.map((t) => t._r).filter(isFiniteNumber);
  const avgWinR  = mean(winRs);
  const avgLossR = mean(lossRs);

  const plannedRs = trades.map((t) => t._plannedR).filter(isFiniteNumber);
  const actualRs  = trades.map((t) => t._r).filter(isFiniteNumber);
  const avgPlannedR = mean(plannedRs);
  const avgActualR  = mean(actualRs);

  const allDurations = trades.map((t) => t._durMins).filter(isFiniteNumber);
  const winDurations = winners.map((t) => t._durMins).filter(isFiniteNumber);
  const lossDurations = losers.map((t) => t._durMins).filter(isFiniteNumber);
  const avgHoldingMins        = mean(allDurations);
  const avgWinningHoldingMins = mean(winDurations);
  const avgLosingHoldingMins  = mean(lossDurations);

  const riskVals = trades.map((t) => t._rv).filter(isFiniteNumber);
  const avgRiskDollar = mean(riskVals);

  const rewardVals: number[] = [];
  let rewardUnavailable = false;
  for (const trade of trades) {
    if (!isFiniteNumber(trade._rv) || !isFiniteNumber(trade._plannedR)) continue;
    const reward = finiteOrNull(trade._rv * trade._plannedR);
    if (reward === null) { rewardUnavailable = true; break; }
    rewardVals.push(reward);
  }
  const avgRewardDollar = rewardUnavailable ? null : mean(rewardVals);
  const avgRR = avgPlannedR;

  const netProfit = sumFinite(trades.map((t) => t._netPL));
  const allPL = trades.map((t) => t._pl).filter(isFiniteNumber);
  const grossProfit = sum(allPL.filter((v) => v > 0));
  const grossLoss   = sum(allPL.filter((v) => v < 0));

  const profitFactor = grossProfit !== null && grossLoss !== null && grossLoss !== 0
    ? finiteOrNull(grossProfit / Math.abs(grossLoss))
    : null;
  const payoffRatio  = avgWinnerDollar !== null && avgLoserDollar !== null && avgLoserDollar !== 0
    ? finiteOrNull(avgWinnerDollar / Math.abs(avgLoserDollar))
    : null;

  const winRateClosed  = nClosed > 0 ? finiteOrNull(winners.length / nClosed) : null;
  const lossRateClosed = nClosed > 0 ? finiteOrNull(losers.length  / nClosed) : null;

  const expectancyR = (winRateClosed !== null && lossRateClosed !== null && avgWinR !== null && avgLossR !== null)
    ? finiteOrNull((winRateClosed * avgWinR) - (lossRateClosed * Math.abs(avgLossR)))
    : null;

  const expectancyDollar = (winRateClosed !== null && lossRateClosed !== null && avgWinnerDollar !== null && avgLoserDollar !== null)
    ? finiteOrNull((winRateClosed * avgWinnerDollar) - (lossRateClosed * Math.abs(avgLoserDollar)))
    : null;

  const commissionVals = trades.flatMap((t) => {
    if (typeof t.commission !== 'string' || t.commission.trim() === '') return [];
    const commission = toFiniteNumber(t.commission);
    return commission === null ? [] : [commission];
  });
  const avgCommission = mean(commissionVals);
  const totalCommission = sum(commissionVals);
  const commissionPct = grossProfit !== null && grossProfit !== 0 && totalCommission !== null
    ? finiteOrNull(totalCommission / grossProfit)
    : null;

  const byDate: Record<string, number | null> = {};
  trades.forEach((t) => {
    if (!t.date) return;
    const value = isFiniteNumber(t._netPL) ? t._netPL : null;
    if (!(t.date in byDate)) byDate[t.date] = 0;
    if (value === null || byDate[t.date] === null) return;
    byDate[t.date] = finiteOrNull((byDate[t.date] as number) + value);
  });
  const dailyAggregateUnavailable = Object.values(byDate).some((value) => value === null);
  const dateEntries = Object.entries(byDate).filter((entry): entry is [string, number] => entry[1] !== null);
  const largestWinningDay = !dailyAggregateUnavailable && dateEntries.length > 0
    ? dateEntries.reduce((best, cur) => (cur[1] > best[1] ? cur : best))
    : null;
  const largestLosingDay = !dailyAggregateUnavailable && dateEntries.length > 0
    ? dateEntries.reduce((worst, cur) => (cur[1] < worst[1] ? cur : worst))
    : null;

  const kellyPercent = (winRateClosed !== null && payoffRatio !== null && payoffRatio > 0)
    ? finiteOrNull(Math.max(0, Math.min(1, winRateClosed - (1 - winRateClosed) / payoffRatio)))
    : null;

  const riskOfRuinPercent = (winRateClosed !== null && lossRateClosed !== null && nClosed > 0)
    ? (() => {
        const edge = winRateClosed - lossRateClosed;
        if (edge <= 0) return 100;
        if (edge >= 1) return 0;
        const ratio = (1 - edge) / (1 + edge);
        return finiteOrNull(Math.min(100, Math.pow(ratio, nClosed) * 100));
      })()
    : null;

  const rValues = trades.map((t) => t._r).filter(isFiniteNumber);
  const rMean = mean(rValues);
  const rStd  = stddev(rValues);
  const sqn = (rMean !== null && rStd !== null && rStd > 0)
    ? finiteOrNull((rMean / rStd) * Math.sqrt(Math.min(rValues.length, 100)))
    : null;

  const byMonth: Record<string, number | null> = {};
  trades.forEach((t) => {
    if (!t.date) return;
    const m = t.date.slice(0, 7);
    const value = isFiniteNumber(t._netPL) ? t._netPL : null;
    if (!(m in byMonth)) byMonth[m] = 0;
    if (value === null || byMonth[m] === null) return;
    byMonth[m] = finiteOrNull((byMonth[m] as number) + value);
  });
  const monthlyUnavailable = Object.values(byMonth).some((value) => value === null);
  const monthlyValues = Object.values(byMonth).filter(isFiniteNumber);
  let consistencyScore: number | null = null;
  if (!monthlyUnavailable && monthlyValues.length >= 2) {
    const mMean = mean(monthlyValues);
    const mStd  = stddev(monthlyValues);
    if (mMean !== null && mStd !== null && mMean !== 0) {
      const variability = finiteOrNull(Math.min(100, (mStd / Math.abs(mMean)) * 100));
      consistencyScore = variability === null ? null : finiteOrNull(100 - variability);
    }
  }

  return {
    expectancyR,
    expectancyDollar,
    profitFactor,
    recoveryFactor: null,
    payoffRatio,

    avgWinnerDollar,
    avgLoserDollar,
    avgWinR,
    avgLossR,
    avgPlannedR,
    avgActualR,
    avgHoldingMins,
    avgWinningHoldingMins,
    avgLosingHoldingMins,
    avgRiskDollar,
    avgRewardDollar,
    avgRR,

    largestWinnerDollar,
    largestLoserDollar,
    largestWinningDay: largestWinningDay ? { date: largestWinningDay[0], netPL: largestWinningDay[1] } : null,
    largestLosingDay:  largestLosingDay  ? { date: largestLosingDay[0],  netPL: largestLosingDay[1] }  : null,

    winPct,
    lossPct,
    bePct,

    netProfit,
    grossProfit,
    grossLoss,

    avgCommission,
    commissionPct,

    kellyPercent,
    riskOfRuinPercent,
    sqn,
    expectancyScore: expectancyR,
    consistencyScore,
  };
}

/**
 * Attach Recovery Factor to an already-computed CoreAnalytics object.
 * FORMULA:     NetProfit / |MaxDrawdown$|
 * SOURCE / ASSUMPTIONS / EDGE CASES: see the recoveryFactor entry in
 * computeCoreAnalytics()'s doc block above — this function exists solely
 * to avoid a circular import between analytics.ts and drawdown.ts (the
 * drawdown value must be computed from the full equity sequence, which
 * lives in drawdown.ts).
 */
export function withRecoveryFactor(
  analytics: CoreAnalytics,
  maxDrawdownDollar: number | null,
): CoreAnalytics {
  const recoveryFactor = (
    maxDrawdownDollar !== null
    && maxDrawdownDollar !== 0
    && analytics.netProfit !== null
  )
    ? finiteOrNull(analytics.netProfit / Math.abs(maxDrawdownDollar))
    : null;
  return { ...analytics, recoveryFactor };
}
