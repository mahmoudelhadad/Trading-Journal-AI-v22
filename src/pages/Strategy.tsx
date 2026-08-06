/**
 * pages/Strategy.tsx
 *
 * Phase 11 — Strategy page.
 *
 * Migrated from the original single-file app's StrategyTab(props)
 * function, including its local PerfTable helper and its module-level
 * aggG()/byField() functions. Every layout value, threshold, color, and
 * formula is preserved exactly.
 *
 * CENTRALIZATION (per your Phase 11 rules — avoid duplicate calculation
 * logic, keep business logic centralized):
 *   - avgPlannedR, avgActualR, avgHoldingMins, avgWinningHoldingMins,
 *     avgLosingHoldingMins are consumed from useAdvancedAnalytics()'s
 *     `core` object (calculations/analytics.ts, Phase 8) INSTEAD OF
 *     being recomputed inline, as the original app did. These 5 values
 *     are formula-for-formula IDENTICAL to what the original StrategyTab
 *     computed inline — verified in the Phase 11 validation report.
 *     This is an intentional implementation choice: now that a central
 *     analytics engine exists (it did not yet exist when Dashboard.tsx
 *     was migrated in Phase 6), reusing it here avoids a second,
 *     independent implementation of the same 5 formulas.
 *   - The by-field groupings (Entry Setup, Daily Setup, Session, Setup
 *     Type, Day of Week) and the Before/After 9:30 comparison all use
 *     the newly-extracted summarizeTrades() (calculations/rolling.ts,
 *     Phase 11 refactor) instead of a page-local copy of the original
 *     aggG() function.
 *
 * NOT centralized (intentionally, documented per your rule 3):
 *   - "Total Trade Time" (a SUM of _durMins, not an average) has no
 *     equivalent in analytics.ts and is computed inline here — a
 *     single-use, one-line reduction not worth extracting to a shared
 *     module (same standard applied to Equity.tsx's Monthly Returns %
 *     in Phase 9).
 *   - "Avg Entry Time" (a display-formatted time-of-day average) is
 *     also page-local — it is a display concern (HH:MM formatting of
 *     an average minute-of-day), not a trading-performance metric, and
 *     has no reuse elsewhere in the app today.
 *   - SL Study (avg/max/min of sl1/sl2/sl3/beSL/afSL/_r) and Trade
 *     Management R comparison (avg/max of tm1-6) remain page-local:
 *     these are simple avg/max/min-over-a-named-field computations,
 *     genuinely specific to this page, not duplicated anywhere else in
 *     the codebase.
 *
 * PRESERVED BUG (documented, not fixed — see MIGRATION_NOTES.md KI-004):
 * The Before/After 9:30 comparison's trade-count label has an operator-
 * precedence bug in the original app: `d.trades||0+" trades"` parses as
 * `d.trades || (0+" trades")` because `+` binds tighter than `||`. This
 * means whenever a period has ANY trades (a truthy count), only the bare
 * NUMBER is shown with no "trades" suffix — the suffix text only ever
 * appears when the count is exactly 0. Reproduced exactly below.
 */

import React, { useState, useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { StatBox } from '@components/ui/StatBox.js';
import { TableHeader, TableCell } from '@components/ui/Table.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { fr } from '@calculations/formatters.js';
import { summarizeTrades, type TradeSummary } from '@calculations/rolling.js';
import { useAdvancedAnalytics } from '@hooks/useAdvancedAnalytics.js';
import { DayOfWeekRChart } from '@components/charts/DayOfWeekRChart.js';
import { EntrySetupWinRateChart } from '@components/charts/EntrySetupWinRateChart.js';
import {
  finiteOrNull, isFiniteNumber, sumFinite, toFiniteNumber,
  type EnrichedTrade,
} from '@calculations/tradeCalc.js';
import type { ListsState } from '@hooks/useLists.js';

// ─── Types ───────────────────────────────────────────────────

export interface StrategyPageProps {
  trades: EnrichedTrade[];
  lists:  ListsState;
}

interface KeyedSummary extends TradeSummary {
  key: string;
}

const sectionTitle: React.CSSProperties = { color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 };
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function entryMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const [hourText, minuteText = '0'] = value.split(':');
  const hour = toFiniteNumber(hourText);
  const minute = toFiniteNumber(minuteText);
  return hour === null || minute === null ? null : finiteOrNull(hour * 60 + minute);
}

const round2 = (value: number): number | null => finiteOrNull(Math.round(value * 100) / 100);

// ─── byField helper — matches original byField() exactly ──────

function byField(trades: EnrichedTrade[], field: keyof EnrichedTrade, list: string[]): KeyedSummary[] {
  return list
    .map((k) => {
      const ts = trades.filter((t) => t[field] === k);
      if (!ts.length) return null;
      return { ...summarizeTrades(ts), key: k };
    })
    .filter((v): v is KeyedSummary => v !== null);
}

// ─── PerfTable — migrated verbatim from the original local component ──

interface PerfTableProps {
  title: string;
  color: string;
  rows:  KeyedSummary[];
}

function PerfTable({ title, color, rows }: PerfTableProps) {
  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1, minWidth: 260 }}>
      <div style={{ color, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Name', 'Trades', 'Win%', 'Total R', 'Avg R'].map((hd) => (
              <TableHeader key={hd}>{hd}</TableHeader>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={5} style={{ textAlign: 'center', padding: 14, color: C.dim, fontSize: 11 }}>Not enough data</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
              <TableCell style={{ fontWeight: 700 }}>{r.key}</TableCell>
              <TableCell>{r.n}</TableCell>
              <TableCell style={{ color: r.wr !== null && r.wr > 0.5 ? C.green : C.red }}>{r.wr !== null ? `${(r.wr * 100).toFixed(0)}%` : '—'}</TableCell>
              <TableCell style={{ color: r.totalR === null ? C.dim : r.totalR >= 0 ? C.green : C.red, fontWeight: 700 }}>{r.totalR !== null ? r.totalR.toFixed(2) : '—'}</TableCell>
              <TableCell style={{ color: r.avgR === null ? C.dim : r.avgR >= 0 ? C.green : C.red }}>{r.avgR !== null ? r.avgR.toFixed(2) : '—'}</TableCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Multi-filter comparison field config — matches original exactly ──

const FILTERABLE_FIELDS: Array<{ key: keyof EnrichedTrade; label: string; list: keyof ListsState }> = [
  { key: 'entrySetup',    label: 'Entry Setup',    list: 'EntrySetup' },
  { key: 'dailySetup',    label: 'Daily Setup',    list: 'DailySetup' },
  { key: 'session',       label: 'Session',        list: 'Session' },
  { key: 'direction',     label: 'Direction',      list: 'Direction' },
  { key: 'setupType',     label: 'Setup Type',     list: 'SetupType' },
  { key: 'daySwing',      label: 'Day/Swing',      list: 'DaySwing' },
  { key: 'intraDaySetup', label: 'IntraDay Setup', list: 'IntraDaySetup' },
  { key: 'broker',        label: 'Broker',         list: 'Broker' },
  { key: 'account',       label: 'Account Type',   list: 'Account' },
  { key: 'liquidity',     label: 'Liquidity',      list: 'Liquidity' },
];

// ─── Component ───────────────────────────────────────────────

export function StrategyPage({ trades, lists }: StrategyPageProps) {
  const { core } = useAdvancedAnalytics(trades, 0); // startingCapital=0: drawdown/recoveryFactor unused on this page

  const [field1, setField1] = useState<keyof EnrichedTrade>('entrySetup');
  const [val1, setVal1] = useState('');
  const [field2, setField2] = useState<keyof EnrichedTrade>('dailySetup');
  const [val2, setVal2] = useState('');

  const getFieldList = (fieldKey: keyof EnrichedTrade): string[] => {
    const cfg = FILTERABLE_FIELDS.find((f) => f.key === fieldKey);
    return cfg ? (lists[cfg.list] ?? []) : [];
  };

  const f1Trades = useMemo(() => (val1 ? trades.filter((t) => t[field1] === val1) : []), [trades, field1, val1]);
  const f2Trades = useMemo(() => (val2 ? trades.filter((t) => t[field2] === val2) : []), [trades, field2, val2]);
  const combinedTrades = useMemo(() => {
    if (!val1 && !val2) return [];
    if (val1 && val2) return trades.filter((t) => t[field1] === val1 && t[field2] === val2);
    return val1 ? f1Trades : f2Trades;
  }, [trades, field1, val1, field2, val2, f1Trades, f2Trades]);

  const durMins = trades.map((t) => t._durMins).filter(isFiniteNumber);
  const totalMins = sumFinite(durMins);

  const entryTimes = trades.map((t) => entryMinutes(t.entryTime)).filter(isFiniteNumber);
  const entryTimeTotal = sumFinite(entryTimes);
  const avgEntryMins = entryTimes.length > 0 && entryTimeTotal !== null
    ? finiteOrNull(entryTimeTotal / entryTimes.length)
    : null;
  const avgEntryStr = avgEntryMins !== null
    ? `${Math.floor(avgEntryMins / 60)}:${Math.round(avgEntryMins % 60) < 10 ? '0' : ''}${Math.round(avgEntryMins % 60)}`
    : '—';

  const before930 = trades.filter((t) => {
    if (!t.entryTime) return false;
    const minutes = entryMinutes(t.entryTime);
    return minutes !== null && minutes < 9 * 60 + 30;
  });
  const after930 = trades.filter((t) => {
    if (!t.entryTime) return false;
    const minutes = entryMinutes(t.entryTime);
    return minutes !== null && minutes >= 9 * 60 + 30;
  });
  const b9a = summarizeTrades(before930);
  const a9a = summarizeTrades(after930);
  const timeCompData = [
    { name: 'Before 9:30', trades: b9a.n, wr: b9a.wr !== null ? round2(b9a.wr * 100) : null, totalR: b9a.totalR === null ? null : round2(b9a.totalR), avgR: b9a.avgR === null ? null : round2(b9a.avgR), green: b9a.green, red: b9a.red },
    { name: 'After 9:30',  trades: a9a.n, wr: a9a.wr !== null ? round2(a9a.wr * 100) : null, totalR: a9a.totalR === null ? null : round2(a9a.totalR), avgR: a9a.avgR === null ? null : round2(a9a.avgR), green: a9a.green, red: a9a.red },
  ];

  const byEntry  = useMemo(() => byField(trades, 'entrySetup',  lists.EntrySetup  ?? []), [trades, lists]);
  const byDaily  = useMemo(() => byField(trades, 'dailySetup',  lists.DailySetup  ?? []), [trades, lists]);
  const byST     = useMemo(() => byField(trades, 'setupType',   lists.SetupType   ?? []), [trades, lists]);
  const bySess   = useMemo(() => byField(trades, 'session',     lists.Session     ?? []), [trades, lists]);

  const byDay = useMemo(() => {
    return DAY_NAMES.map((d) => {
      const ts = trades.filter((t) => t.date && new Date(`${t.date}T12:00`).toLocaleDateString('en', { weekday: 'long' }) === d);
      if (!ts.length) return null;
      return { ...summarizeTrades(ts), key: d.slice(0, 3) };
    }).filter((v): v is KeyedSummary => v !== null);
  }, [trades]);

  const slStudy = useMemo(() => {
    const items: Array<{ l: string; f: keyof EnrichedTrade | '_r'; direct?: boolean }> = [
      { l: 'Actual R', f: '_r', direct: true },
      { l: 'Be SL', f: 'beSL' }, { l: 'Af SL', f: 'afSL' },
      { l: 'SL 1', f: 'sl1' }, { l: 'SL 2', f: 'sl2' }, { l: 'SL 3', f: 'sl3' },
    ];
    return items.map(({ l, f, direct }) => {
      const vals = trades
        .map((t) => direct ? t._r : toFiniteNumber(t[f as keyof EnrichedTrade]))
        .filter(isFiniteNumber);
      if (!vals.length) return null;
      const total = sumFinite(vals);
      const avg = total === null ? null : finiteOrNull(total / vals.length);
      return { l, n: vals.length, avg: avg === null ? null : round2(avg), max: round2(Math.max(...vals)), min: round2(Math.min(...vals)) };
    }).filter((v): v is { l: string; n: number; avg: number | null; max: number | null; min: number | null } => v !== null);
  }, [trades]);

  const tmStudy = useMemo(() => {
    const fields = ['tm1', 'tm2', 'tm3', 'tm4', 'tm5', 'tm6'] as const;
    return fields.map((f, i) => {
      const vals = trades.map((t) => toFiniteNumber(t[f])).filter(isFiniteNumber);
      if (!vals.length) return null;
      const total = sumFinite(vals);
      const avg = total === null ? null : finiteOrNull(total / vals.length);
      return { l: `TM ${i + 1}`, n: vals.length, avg: avg === null ? null : round2(avg), max: round2(Math.max(...vals)) };
    }).filter((v): v is { l: string; n: number; avg: number | null; max: number | null } => v !== null);
  }, [trades]);

  const noData = <EmptyState message="Not enough data" padding={16} fontSize={11} />;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBox label="Avg Planned R" value={fr.r(core.avgPlannedR)} color={core.avgPlannedR !== null && core.avgPlannedR > 0 ? C.blue : C.dim} />
        <StatBox label="Avg Real R" value={fr.r(core.avgActualR)} color={core.avgActualR === null ? C.dim : core.avgActualR > 0 ? C.green : C.red} />
        <StatBox label="Total Trade Time" value={totalMins === null ? '—' : `${Math.floor(totalMins / 60)}h ${Math.round(totalMins % 60)}m`} color={C.teal} />
        <StatBox label="Avg Trade Duration" value={core.avgHoldingMins !== null ? `${Math.floor(core.avgHoldingMins / 60)}h ${Math.round(core.avgHoldingMins % 60)}m` : '—'} color={C.blue} />
        <StatBox label="Avg Winning Duration" value={core.avgWinningHoldingMins !== null ? `${Math.floor(core.avgWinningHoldingMins / 60)}h ${Math.round(core.avgWinningHoldingMins % 60)}m` : '—'} color={C.green} />
        <StatBox label="Avg Losing Duration" value={core.avgLosingHoldingMins !== null ? `${Math.floor(core.avgLosingHoldingMins / 60)}h ${Math.round(core.avgLosingHoldingMins % 60)}m` : '—'} color={C.red} />
        <StatBox label="Avg Entry Time" value={avgEntryStr} color={C.gold} />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <PerfTable title="By Entry Setup" color={C.green} rows={byEntry} />
        <PerfTable title="By Daily Setup" color={C.blue} rows={byDaily} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <PerfTable title="By Session" color={C.teal} rows={bySess} />
        <PerfTable title="By Setup Type" color={C.gold} rows={byST} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Card>
          <div style={{ ...sectionTitle, color: C.purple }}>⏱ Before vs After 9:30 AM</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {['Before 9:30', 'After 9:30'].map((name) => {
              const d = timeCompData.find((x) => x.name === name) ?? { trades: 0, totalR: null, avgR: null, wr: null };
              return (
                <div key={name} style={{ flex: 1, background: C.row, borderRadius: 7, padding: '7px 10px', border: `1px solid ${C.border}` }}>
                  <div style={{ color: C.dim, fontSize: 9, marginBottom: 2 }}>{name}</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <span style={{ color: C.text, fontSize: 10 }}>{(d.trades || (0 + ' trades')) as unknown as string}</span>
                    <span style={{ color: d.totalR === null ? C.dim : d.totalR >= 0 ? C.green : C.red, fontWeight: 700, fontSize: 11 }}>{d.totalR === null ? '—' : `${d.totalR >= 0 ? '+' : ''}${d.totalR.toFixed(2)}R total`}</span>
                    <span style={{ color: d.avgR === null ? C.dim : d.avgR >= 0 ? C.green : C.red, fontSize: 10 }}>{d.avgR === null ? 'avg: —' : `avg: ${d.avgR >= 0 ? '+' : ''}${d.avgR.toFixed(2)}R`}</span>
                    {d.wr !== null && <span style={{ color: d.wr > 50 ? C.green : C.red, fontSize: 10 }}>{`win: ${d.wr.toFixed(1)}%`}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <div style={{ ...sectionTitle, color: C.teal }}>📅 Total R & Avg R by Day of Week</div>
          {byDay.length === 0 || byDay.some((r) => r.avgR === null || r.totalR === null) ? noData : (
            <DayOfWeekRChart data={byDay.map((r) => ({ name: r.key, avgR: r.avgR as number, totalR: r.totalR as number, n: r.n }))} />
          )}
        </Card>
      </div>

      <Card>
        <div style={{ ...sectionTitle, color: C.teal }}>R & Win Rate by Entry Setup</div>
        {byEntry.length === 0 || byEntry.some((r) => r.wr === null || r.totalR === null) ? noData : (
          <EntrySetupWinRateChart data={byEntry.map((r) => ({ name: r.key, wr: (r.wr as number) * 100, totalR: r.totalR as number }))} />
        )}
      </Card>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1, minWidth: 260 }}>
          <div style={{ ...sectionTitle, color: C.gold }}>SL Study — Avg R Comparison</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><TableHeader>SL</TableHeader><TableHeader>n</TableHeader><TableHeader>Avg R</TableHeader><TableHeader>Max</TableHeader><TableHeader>Min</TableHeader></tr></thead>
            <tbody>
              {slStudy.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 12, color: C.dim, fontSize: 11 }}>No data yet</td></tr>
              ) : slStudy.map((r, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                  <TableCell style={{ fontWeight: 700 }}>{r.l}</TableCell>
                  <TableCell>{r.n}</TableCell>
                  <TableCell style={{ color: r.avg === null ? C.dim : r.avg >= 0 ? C.green : C.red, fontWeight: 700 }}>{r.avg ?? '—'}</TableCell>
                  <TableCell style={{ color: r.max === null ? C.dim : C.green }}>{r.max ?? '—'}</TableCell>
                  <TableCell style={{ color: r.min === null ? C.dim : C.red }}>{r.min ?? '—'}</TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1, minWidth: 260 }}>
          <div style={{ ...sectionTitle, color: C.blue }}>Trade Management R Comparison</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><TableHeader>TM</TableHeader><TableHeader>n</TableHeader><TableHeader>Avg R</TableHeader><TableHeader>Max R</TableHeader></tr></thead>
            <tbody>
              {tmStudy.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 12, color: C.dim, fontSize: 11 }}>No data yet</td></tr>
              ) : tmStudy.map((r, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                  <TableCell style={{ fontWeight: 700 }}>{r.l}</TableCell>
                  <TableCell>{r.n}</TableCell>
                  <TableCell style={{ color: r.avg === null ? C.dim : r.avg >= 0 ? C.green : C.red, fontWeight: 700 }}>{r.avg ?? '—'}</TableCell>
                  <TableCell style={{ color: r.max === null ? C.dim : C.green }}>{r.max ?? '—'}</TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Card>
        <div style={{ ...sectionTitle, color: C.orange }}>🔀 Multi-Filter Comparison</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div>
            <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>Filter 1 — Field</div>
            <select value={field1 as string} onChange={(e) => { setField1(e.target.value as keyof EnrichedTrade); setVal1(''); }} style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              {FILTERABLE_FIELDS.map((f) => <option key={f.key as string} value={f.key as string}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>Filter 1 — Value</div>
            <select value={val1} onChange={(e) => setVal1(e.target.value)} style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              <option value="">Any</option>
              {getFieldList(field1).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>Filter 2 — Field</div>
            <select value={field2 as string} onChange={(e) => { setField2(e.target.value as keyof EnrichedTrade); setVal2(''); }} style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              {FILTERABLE_FIELDS.map((f) => <option key={f.key as string} value={f.key as string}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: C.dim, fontSize: 9, marginBottom: 2, textTransform: 'uppercase' }}>Filter 2 — Value</div>
            <select value={val2} onChange={(e) => setVal2(e.target.value)} style={{ width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              <option value="">Any</option>
              {getFieldList(field2).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        {(val1 || val2) ? (
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              {val1 && <StatBox label={`${String(field1)} = ${val1}`} value={`${f1Trades.length} trades`} color={C.blue} />}
              {val2 && <StatBox label={`${String(field2)} = ${val2}`} value={`${f2Trades.length} trades`} color={C.orange} />}
              {val1 && val2 && <StatBox label="Both combined" value={`${combinedTrades.length} trades`} color={C.purple} />}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                <thead>
                  <tr>{['Filter', 'Trades', 'Win%', 'Total R', 'Avg R', 'P/L'].map((hd) => <TableHeader key={hd}>{hd}</TableHeader>)}</tr>
                </thead>
                <tbody>
                  {[
                    val1 ? { label: `${String(field1)}=${val1}`, data: summarizeTrades(f1Trades) } : null,
                    val2 ? { label: `${String(field2)}=${val2}`, data: summarizeTrades(f2Trades) } : null,
                    val1 && val2 ? { label: 'Both ∩', data: summarizeTrades(combinedTrades) } : null,
                    { label: 'All Trades', data: summarizeTrades(trades) },
                  ].filter((v): v is { label: string; data: TradeSummary } => v !== null).map((item, i) => {
                    const r = item.data;
                    return (
                      <tr key={i} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                        <TableCell style={{ fontWeight: 700 }}>{item.label}</TableCell>
                        <TableCell>{r.n}</TableCell>
                        <TableCell style={{ color: r.wr !== null && r.wr > 0.5 ? C.green : C.red }}>{r.wr !== null ? `${(r.wr * 100).toFixed(0)}%` : '—'}</TableCell>
                        <TableCell style={{ color: r.totalR === null ? C.dim : r.totalR >= 0 ? C.green : C.red, fontWeight: 700 }}>{r.totalR !== null ? r.totalR.toFixed(2) : '—'}</TableCell>
                        <TableCell style={{ color: r.avgR === null ? C.dim : r.avgR >= 0 ? C.green : C.red }}>{r.avgR !== null ? r.avgR.toFixed(2) : '—'}</TableCell>
                        <TableCell style={{ color: r.pl === null ? C.dim : r.pl >= 0 ? C.green : C.red }}>{fr.usd(r.pl)}</TableCell>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ color: C.dim, fontSize: 11, textAlign: 'center', padding: 16 }}>Select filter values above to compare trade subsets</div>
        )}
      </Card>
    </div>
  );
}
