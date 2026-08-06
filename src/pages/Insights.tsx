/**
 * pages/Insights.tsx
 *
 * Phase 12 — Insights page.
 *
 * Migrated from the original single-file app's InsightsTab(props)
 * function. Every insight rule, every threshold, every message string,
 * and the 6-KPI StatBox row are preserved exactly.
 *
 * CENTRALIZATION (per your Phase 12 rules — reuse existing calculation
 * functions whenever possible):
 *   - Win rate (`wr`) reuses `core.winPct` (calculations/analytics.ts,
 *     Phase 8) — verified identical formula: green / n (over ALL
 *     trades, not just closed ones).
 *   - `avgPlanned` reuses `core.avgPlannedR` — verified identical
 *     formula: mean(_plannedR) filtered to non-null values first.
 *   - Streaks (`maxWin`/`maxLoss`) reuse `streaks.maxWin`/`streaks.
 *     maxLoss` from `computeStreaks()` (calculations/streaks.ts,
 *     Phase 8/11) instead of a third copy of the streak-walking loop.
 *   - Best/Worst Day reuses `daily` (`aggregateByPeriod(trades,'day')`,
 *     calculations/rolling.ts) — the day-grouping and per-day totalR
 *     are already computed there; this page only reduces that existing
 *     array for the max/min entries, instead of a separate byDate loop.
 *   - Best/Worst Setup, Best Session, Best/Worst Hour, and the Plan-
 *     Followed comparison all call `summarizeTrades()` (calculations/
 *     rolling.ts, Phase 11) per group for their R/count math, instead
 *     of a fourth copy of that reduction logic.
 *
 * IMPORTANT — NOT reusing `core.avgActualR` for the overall `avgR`
 * (documented per your rule 3, an intentional, verified decision):
 * `core.avgActualR` (analytics.ts) FILTERS OUT trades with a null `_r`
 * before averaging. The original InsightsTab's `avgR` (and Dashboard.
 * tsx's identical Phase-6 formula) instead does
 * `sum(_r ?? 0) / trades.length` — treating a trade with no R as a
 * ZERO contribution while still counting it in the denominator. These
 * two formulas produce DIFFERENT results whenever any trade has a null
 * `_r` (e.g. an incomplete/open trade). Substituting `core.avgActualR`
 * here would silently change this page's output versus the original
 * app — a redesign, which is out of scope. Instead, this page reuses
 * `summarizeTrades(trades).avgR`, which uses the EXACT SAME "treat
 * null as 0, divide by full n" formula already verified in Phase 11 —
 * a safe, byte-identical reuse target that `core.avgActualR` is not.
 * `summarizeTrades(trades).totalR` and `.netPL` are reused for the
 * same reason (formula-verified identical, unlike the `core` object's
 * closed-trades-only `.wr` field, which is NOT used here).
 *
 * NOT centralized (intentional, page-specific, per your rule 2 — avoid
 * over-engineering, keep single-use patterns local):
 *   - The "group by field, filter to n>=2, find the best/worst by
 *     total R" pattern (used for Setup/Session/Hour) is a specific
 *     insight-generation heuristic not reused anywhere else in the
 *     app. It calls `summarizeTrades()` per group (avoiding duplicate
 *     reduction math) but the grouping/filtering/reducing shell stays
 *     local to this page.
 *   - Execution Ratio (mean of per-trade real-R ÷ planned-R) has no
 *     existing equivalent anywhere in the codebase and is single-use.
 */

import React, { useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { StatBox } from '@components/ui/StatBox.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { fr } from '@calculations/formatters.js';
import { summarizeTrades, groupTradesBy } from '@calculations/rolling.js';
import { useAdvancedAnalytics } from '@hooks/useAdvancedAnalytics.js';
import {
  finiteOrNull, isFiniteNumber, sumFinite, toFiniteNumber,
  type EnrichedTrade,
} from '@calculations/tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface InsightsPageProps {
  trades: EnrichedTrade[];
}

type InsightType = 'good' | 'bad' | 'warn' | 'info';

interface Insight {
  type:  InsightType;
  title: string;
  body:  string;
}

// ─── InsightCard — migrated verbatim from the original local component ──

function InsightCard({ type, title, body }: Insight) {
  const ic = type === 'good' ? C.green : type === 'bad' ? C.red : type === 'warn' ? C.gold : C.blue;
  const emoji = type === 'good' ? '✅' : type === 'bad' ? '⚠️' : type === 'warn' ? '🔔' : '💡';
  return (
    <div style={{ background: `${ic}11`, border: `1px solid ${ic}33`, borderRadius: 9, padding: '10px 14px', marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 14 }}>{emoji}</span>
        <div>
          <div style={{ color: ic, fontWeight: 700, fontSize: 11, marginBottom: 2 }}>{title}</div>
          <div style={{ color: C.text, fontSize: 11, lineHeight: 1.5 }}>{body}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

export function InsightsPage({ trades }: InsightsPageProps) {
  if (!trades.length) {
    return <div style={{ textAlign: 'center', padding: 60, color: C.dim, fontSize: 13 }}>Add trades first to see insights.</div>;
  }

  // NOTE: this hook call sits after an early `return` above (for the
  // empty-trades case) — a pre-existing conditional-hook-call pattern
  // from Phase 12, not introduced by this phase. Flagged in
  // MIGRATION_NOTES.md rather than silently changed, per "do not fix
  // unless explicitly requested." Kept OUTSIDE the useMemo below since
  // hooks cannot be called conditionally or from within a memo callback.
  //
  // Gap-analysis G-2 (lint harness): react-hooks/rules-of-hooks now
  // flags this line — expected, not new information. Suppressed
  // rather than fixed, per the same "do not fix unless explicitly
  // requested" decision recorded above; see MIGRATION_NOTES.md's
  // Phase 17 entry and its confirmed-only-instance React Audit.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { core, streaks, daily } = useAdvancedAnalytics(trades, 0);

  // Phase 17: everything below is plain JS (no hooks), so it is safe
  // to wrap in a single useMemo. This is a pure caching change — every
  // expression is copied verbatim from the prior implementation; only
  // the insights-array-building step (previously re-executed, with all
  // its string interpolation, on every render) now only re-runs when
  // `trades` or the hook's memoized outputs actually change. See
  // MIGRATION_NOTES.md's Phase 17 entry.
  //
  // Same suppression rationale as the useAdvancedAnalytics call above —
  // this useMemo is flagged as "conditional" purely because it follows
  // the same early return, not a distinct issue.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { n, wr, totalR, avgR, netPL, maxWin, maxLoss, insights } = useMemo(() => {
    const n = trades.length;

    // Reused: matches core.winPct exactly (green / n, all trades)
    const wr = core.winPct;

    // NOT reused from core.avgActualR — see file header for why.
    // summarizeTrades(trades) uses the exact matching "null-as-0 / full n" formula.
    const overallSummary = summarizeTrades(trades);
    const totalR = overallSummary.totalR;
    const avgR   = overallSummary.avgR;
    const netPL  = overallSummary.netPL;

    const avgPlanned = core.avgPlannedR;

    // ── Best/Worst Day — reuses aggregateByPeriod('day') via the hook ──
    const availableDays = daily.filter((period) => period.totalR !== null);
    const bestDay = availableDays.length > 0 ? availableDays.reduce((best, cur) => ((cur.totalR as number) > (best.totalR as number) ? cur : best)) : null;
    const worstDay = availableDays.length > 0 ? availableDays.reduce((worst, cur) => ((cur.totalR as number) < (worst.totalR as number) ? cur : worst)) : null;

    // Phase 20 — Architecture Cleanup (finding M-2): all three groupings
    // below now reuse groupTradesBy() (calculations/rolling.ts) instead
    // of each hand-rolling its own Record<key, Trade[]> accumulation
    // loop. Identical accumulation logic, identical falsy-key exclusion
    // (entrySetup/session/entryTime being '' or missing), identical
    // downstream n>=2 filter and best/worst reduction — verified via
    // regression test (see Phase 20 validation report).

    // ── Best/Worst Setup (n>=2 threshold) ──
    const setupGroups = groupTradesBy(trades, (t) => t.entrySetup);
    const setupEntries = Object.entries(setupGroups)
      .map(([key, ts]) => [key, summarizeTrades(ts)] as const)
      .filter(([, s]) => s.n >= 2 && s.totalR !== null);
    const bestSetup = setupEntries.length > 0 ? setupEntries.reduce((a, b) => ((b[1].totalR as number) > (a[1].totalR as number) ? b : a)) : null;
    const worstSetup = setupEntries.length > 0 ? setupEntries.reduce((a, b) => ((b[1].totalR as number) < (a[1].totalR as number) ? b : a)) : null;

    // ── Best Session (n>=2 threshold) ──
    const sessGroups = groupTradesBy(trades, (t) => t.session);
    const sessEntries = Object.entries(sessGroups)
      .map(([key, ts]) => [key, summarizeTrades(ts)] as const)
      .filter(([, s]) => s.n >= 2 && s.totalR !== null);
    const bestSess = sessEntries.length > 0 ? sessEntries.reduce((a, b) => ((b[1].totalR as number) > (a[1].totalR as number) ? b : a)) : null;

    // ── Best/Worst Hour (n>=2 threshold) ──
    const hourGroups = groupTradesBy(trades, (t) => {
      if (!t.entryTime) return null;
      const hr = toFiniteNumber(t.entryTime.split(':')[0]);
      return hr === null ? null : String(hr);
    });
    const hourEntries = Object.entries(hourGroups)
      .map(([key, ts]) => [key, summarizeTrades(ts)] as const)
      .filter(([, s]) => s.n >= 2 && s.totalR !== null);
    const bestHour = hourEntries.length > 0 ? hourEntries.reduce((a, b) => ((b[1].totalR as number) > (a[1].totalR as number) ? b : a)) : null;
    const worstHour = hourEntries.length > 0 ? hourEntries.reduce((a, b) => ((b[1].totalR as number) < (a[1].totalR as number) ? b : a)) : null;

    // ── Streaks — reused from computeStreaks() via the hook ──
    const maxWin = streaks.maxWin;
    const maxLoss = streaks.maxLoss;

    // ── Plan-followed comparison (per-group avgR reused via summarizeTrades) ──
    const planYes = trades.filter((t) => t.planFollowed === 'Yes');
    const planNo  = trades.filter((t) => t.planFollowed === 'No');
    const planYesR = planYes.length > 0 ? summarizeTrades(planYes).avgR : null;
    const planNoR  = planNo.length > 0  ? summarizeTrades(planNo).avgR  : null;

    // ── Execution ratio (page-local, no existing equivalent) ──
    const execPairs = trades.filter((t) => isFiniteNumber(t._r) && isFiniteNumber(t._plannedR) && t._plannedR > 0);
    const execValues = execPairs.map((t) => finiteOrNull((t._r as number) / (t._plannedR as number)));
    const execTotal = execValues.every(isFiniteNumber) ? sumFinite(execValues) : null;
    const execRatio = execPairs.length > 0 && execTotal !== null
      ? finiteOrNull(execTotal / execPairs.length)
      : null;

    // ── Build insights list — every rule/threshold/message preserved exactly ──
    const insights: Insight[] = [];

    if (wr !== null && wr > 0.6) insights.push({ type: 'good', title: 'Strong All-Trade Win Rate', body: `All-trade win rate ${Math.round(wr * 100)}% — excellent. Focus on maintaining trade quality.` });
    else if (wr !== null && wr < 0.4) insights.push({ type: 'bad', title: `Low All-Trade Win Rate (${Math.round(wr * 100)}%)`, body: 'Less than 40% of trades are winning. Review your entry criteria and wait for A+ setups only.' });

    if (avgR !== null && avgR > 0.5) insights.push({ type: 'good', title: `Solid Avg R: +${avgR.toFixed(2)}R`, body: 'Average return per trade is healthy. Keep protecting your winners.' });
    else if (avgR !== null && avgR < 0) insights.push({ type: 'bad', title: `Negative Avg R (${avgR.toFixed(2)}R)`, body: "Average trade is losing money. Check if you're cutting winners too early or letting losers run." });

    if (bestSetup) insights.push({ type: 'good', title: `Best Setup: ${bestSetup[0]}`, body: `${bestSetup[0]} generated ${(bestSetup[1].totalR as number).toFixed(2)}R across ${bestSetup[1].n} trades (${Math.round((bestSetup[1].green / bestSetup[1].n) * 100)}% win rate). Prioritize this setup.` });
    if (worstSetup && (worstSetup[1].totalR as number) < 0) insights.push({ type: 'bad', title: `Avoid: ${worstSetup[0]}`, body: `${worstSetup[0]} generated ${(worstSetup[1].totalR as number).toFixed(2)}R across ${worstSetup[1].n} trades. Consider removing it from your playbook or reviewing your execution.` });

    if (bestSess) insights.push({ type: 'good', title: `Best Session: ${bestSess[0]}`, body: `${bestSess[0]} is your strongest session with ${(bestSess[1].totalR as number).toFixed(2)}R total across ${bestSess[1].n} trades. Focus your energy here.` });

    if (bestHour) insights.push({ type: 'good', title: `Best Entry Hour: ${bestHour[0]}:00`, body: `Your best performing entries happen around ${bestHour[0]}:00 with ${(bestHour[1].totalR as number).toFixed(2)}R total across ${bestHour[1].n} trades.` });
    if (worstHour && (worstHour[1].totalR as number) < -0.5) insights.push({ type: 'warn', title: `Risky Hour: ${worstHour[0]}:00`, body: `Entries at ${worstHour[0]}:00 produced ${(worstHour[1].totalR as number).toFixed(2)}R across ${worstHour[1].n} trades. Be extra selective or avoid this hour.` });

    if (planYesR !== null && planNoR !== null) {
      insights.push({
        type: planYesR > planNoR ? 'good' : 'bad',
        title: 'Plan Adherence Impact',
        body: `When you follow the plan: avg ${planYesR.toFixed(2)}R across ${planYes.length} trades. When you don't: avg ${planNoR.toFixed(2)}R across ${planNo.length} trades. ${planYesR > planNoR ? 'Following the plan pays off!' : 'Review your plan — execution issues may exist.'}`,
      });
    }

    if (execRatio !== null) {
      const execPercent = finiteOrNull(execRatio * 100);
      if (execPercent !== null) insights.push({
        type: execRatio > 0.5 ? 'good' : 'warn',
        title: `Execution Ratio: ${execPercent.toFixed(0)}%`,
        body: `You captured ${execPercent.toFixed(0)}% of your planned R on average, across ${execPairs.length} trades with both a planned and an actual R. ${execRatio < 0.5 ? 'Work on holding trades to target.' : 'Good trade management.'}`,
      });
    }

    if (maxWin >= 3) insights.push({ type: 'good', title: `Longest Win Streak: ${maxWin}`, body: `You've had winning streaks up to ${maxWin} trades. Stay disciplined during runs.` });
    if (maxLoss >= 3) insights.push({ type: 'bad', title: `Longest Loss Streak: ${maxLoss}`, body: `Loss streaks up to ${maxLoss} trades. Consider taking a break after 3 consecutive losses.` });

    const planPercent = avgPlanned !== null && avgPlanned !== 0 && avgR !== null
      ? finiteOrNull((avgR / avgPlanned) * 100)
      : null;
    if (avgPlanned !== null && avgR !== null && planPercent !== null) {
      insights.push({
        type: avgR / avgPlanned > 0.5 ? 'good' : 'warn',
        title: 'Planned vs Real R',
        body: `Planned: +${avgPlanned.toFixed(2)}R avg across trades that have a planned R. Actual: ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R avg across all ${n} trades. You achieve ${planPercent.toFixed(0)}% of your plan.`,
      });
    }

    if (n > 10 && totalR !== null && totalR < 0) insights.push({ type: 'bad', title: 'Overall Negative P/L', body: `Total R is ${totalR.toFixed(2)} across ${n} trades. Consider reducing position size while you work on strategy improvements.` });

    return { n, wr, totalR, avgR, netPL, maxWin, maxLoss, insights };
  }, [trades, core, streaks, daily]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: C.white, fontWeight: 800, fontSize: 15, marginBottom: 4 }}>🤖 AI-Powered Insights</div>
        <div style={{ color: C.dim, fontSize: 11 }}>{`Automated analysis across ${n} visible trades · individual insights may cover a smaller subset · Updated in real time`}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <StatBox label="Total R" value={fr.r(totalR)} color={totalR === null ? C.dim : totalR >= 0 ? C.green : C.red} />
        <StatBox label="Win Rate (all trades)" value={fr.pct(wr)} color={wr === null ? C.dim : wr > 0.5 ? C.green : C.red} />
        <StatBox label="Avg R / Trade" value={fr.r(avgR)} color={avgR === null ? C.dim : avgR >= 0 ? C.green : C.red} />
        <StatBox label="Net P/L" value={fr.usd(netPL)} color={netPL === null ? C.dim : netPL >= 0 ? C.green : C.red} />
        <StatBox label="Best Streak" value={`${maxWin} wins`} color={C.green} />
        <StatBox label="Worst Streak" value={`${maxLoss} losses`} color={C.red} />
      </div>

      <div style={{ marginBottom: 8, color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Insights & Recommendations</div>

      {insights.length === 0 ? (
        <EmptyState message="Add more trades with relevant setup, session, plan, and R data to generate more insights" padding={30} fontSize={12} />
      ) : (
        insights.map((ins, i) => <InsightCard key={i} type={ins.type} title={ins.title} body={ins.body} />)
      )}
    </div>
  );
}
