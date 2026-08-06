/**
 * pages/Calendar.tsx
 *
 * Phase 10 — Calendar page.
 *
 * Migrated from the original single-file app's CalendarTab(props)
 * function. Every layout value, color, spacing, and stat formula is
 * copied verbatim — month navigation, the 7-column day grid, per-day
 * P&L/R/trade-count display, win/loss cell coloring, and the four
 * month-summary stat boxes (Monthly P/L, Total R, Trading Days, W/L).
 *
 * PRESERVED QUIRK (documented, not silently fixed):
 * The original day cells set `cursor: hasTrades ? "pointer" : "default"`
 * but had NO onClick handler at all — a purely visual affordance
 * implying clickability that did nothing. This has been noted in
 * MIGRATION_NOTES.md as KI-003.
 *
 * PRE-APPROVED SCOPE ADDITION (not new-scope creep):
 * "Click Day -> Show Trades" was explicitly listed under CALENDAR in
 * the original migration plan approved at the start of this project
 * (Phase 10: "Migrate + improve | Heatmap, click -> trades, monthly
 * stats"). This phase completes that pre-scoped feature — clicking a
 * day with trades now opens a read-only list of that day's trades. No
 * new calculations were introduced to build this: it reuses the
 * existing `fr` formatters, `getOutcomeColor`/`getDirectionColor`
 * helpers (calculations/formatters.ts, Phase 5), and the `TableHeader`/
 * `TableCell`/`Badge`/`Modal` UI atoms (Phase 3) — a simple date-filter
 * over already-enriched trades, not a new metric.
 *
 * The existing green/red per-day cell coloring already IS the
 * "Heatmap" item from the approved plan — the original app's two-tone
 * (win-day/loss-day) coloring is preserved exactly, not replaced with
 * a new gradient-intensity scheme, per "do not redesign."
 *
 * REUSE NOTE: The day-trades list is deliberately NOT built from the
 * existing <TradeTable>/<TradeRow> components (Phase 5), since those
 * carry bulk-select/edit/delete workflow that a read-only day-detail
 * view does not need. A minimal local table is used instead, still
 * built entirely from shared atoms (TableHeader, TableCell, Badge) and
 * shared formatters — no new formatting logic was written.
 */

import React, { useState, useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { TableHeader, TableCell } from '@components/ui/Table.js';
import { Badge } from '@components/ui/Badge.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { fr, getOutcomeColor, getDirectionColor } from '@calculations/formatters.js';
import { sumFinite, type EnrichedTrade } from '@calculations/tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface CalendarPageProps {
  trades: EnrichedTrade[];
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// ─── Day-trades detail modal (local, Calendar-specific) ───────

interface DayTradesModalProps {
  date:    string; // 'YYYY-MM-DD'
  trades:  EnrichedTrade[];
  onClose: () => void;
}

function DayTradesModal({ date, trades, onClose }: DayTradesModalProps) {
  return (
    <Modal onClose={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 700, marginTop: 40 }}>
        <div style={{ padding: '13px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>{`Trades on ${date}`}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 14, maxHeight: '70vh', overflowY: 'auto' }}>
          {trades.length === 0 ? (
            <EmptyState message="No trades on this day" />
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${C.border}` }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
                <thead>
                  <tr>
                    {['Symbol', 'Dir', 'Entry', 'Exit', 'R', 'Net P/L', 'Outcome'].map((hd) => (
                      <TableHeader key={hd}>{hd}</TableHeader>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={t._tid} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                      <TableCell style={{ fontWeight: 700, color: C.white }}>{t.symbol || '—'}</TableCell>
                      <TableCell style={{ color: getDirectionColor(t.direction ?? ''), fontWeight: 700 }}>{t.direction || '—'}</TableCell>
                      <TableCell>{t.entryPrice || '—'}</TableCell>
                      <TableCell>{t.exitPrice || '—'}</TableCell>
                      <TableCell style={{ color: t._r !== null ? (t._r > 0 ? C.green : C.red) : C.dim, fontWeight: 700 }}>{fr.r(t._r)}</TableCell>
                      <TableCell style={{ color: t._netPL !== null ? (t._netPL > 0 ? C.green : C.red) : C.dim }}>{fr.usd(t._netPL)}</TableCell>
                      <TableCell><Badge color={getOutcomeColor(t._outcome)}>{t._outcome || '—'}</Badge></TableCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Component ───────────────────────────────────────────────

export function CalendarPage({ trades }: CalendarPageProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  }
  function goToday() {
    setYear(now.getFullYear());
    setMonth(now.getMonth());
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  // Phase 17: memoized — this is the most expensive computation on this
  // page (an O(n) pass over the FULL trades array, not just the
  // visible month), so it benefits from not re-running on every
  // render (e.g. when only `selectedDay` changes via a day click).
  // Pure caching change — the grouping/aggregation logic itself is
  // copied verbatim from the prior implementation. See
  // MIGRATION_NOTES.md's Phase 17 entry.
  const { byDay, monthPL, monthR, tradingDays, winDays, lossDays } = useMemo(() => {
    // Group trades by day-of-month (within the currently viewed month)
    const byDay: Record<number, EnrichedTrade[]> = {};
    trades.forEach((t) => {
      if (!t.date) return;
      const parts = t.date.split('-');
      if (+parts[0] === year && +parts[1] === month + 1) {
        const d = +parts[2];
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push(t);
      }
    });

    const allMonthTrades = Object.values(byDay).reduce<EnrichedTrade[]>((a, b) => a.concat(b), []);
    const monthPL = sumFinite(allMonthTrades.map((t) => t._netPL));
    const monthR  = sumFinite(allMonthTrades.map((t) => t._r));
    const dayEntries = Object.entries(byDay);
    const tradingDays = dayEntries.length;
    const dayTotals = dayEntries.map(([, dayTrades]) => sumFinite(dayTrades.map((t) => t._netPL)));
    const winDays = dayTotals.filter((total) => total !== null && total > 0).length;
    const lossDays = dayTotals.filter((total) => total !== null && total <= 0).length;

    return { byDay, monthPL, monthR, tradingDays, winDays, lossDays };
  }, [trades, year, month]);

  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayD = now.getDate(), todayM = now.getMonth(), todayY = now.getFullYear();

  // Build the 'YYYY-MM-DD' string for the currently selected day, if any
  const selectedDateStr = selectedDay !== null
    ? `${year}-${String(month + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`
    : null;
  const selectedDayTrades = selectedDay !== null ? (byDay[selectedDay] ?? []) : [];

  return (
    <div style={{ background: C.bg, minHeight: '100%' }}>
      {/* ── Header: nav + month stats ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={goToday} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '5px 12px', fontSize: 11, cursor: 'pointer' }}>Today</button>
          <button onClick={prevMonth} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '5px 10px', fontSize: 13, cursor: 'pointer' }}>‹</button>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 15, minWidth: 160, textAlign: 'center' }}>{`${MONTH_NAMES[month]} ${year}`}</span>
          <button onClick={nextMonth} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '5px 10px', fontSize: 13, cursor: 'pointer' }}>›</button>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ background: C.card, borderRadius: 8, padding: '6px 14px', border: `1px solid ${C.border}` }}>
            <span style={{ color: C.dim, fontSize: 10 }}>Monthly P/L: </span>
            <span style={{ color: monthPL === null ? C.dim : monthPL >= 0 ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>{fr.usd(monthPL)}</span>
          </div>
          <div style={{ background: C.card, borderRadius: 8, padding: '6px 14px', border: `1px solid ${C.border}` }}>
            <span style={{ color: C.dim, fontSize: 10 }}>Total R: </span>
            <span style={{ color: monthR === null ? C.dim : monthR >= 0 ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>{fr.r(monthR)}</span>
          </div>
          <div style={{ background: C.card, borderRadius: 8, padding: '6px 14px', border: `1px solid ${C.border}` }}>
            <span style={{ color: C.dim, fontSize: 10 }}>Trading Days: </span>
            <span style={{ color: C.blue, fontWeight: 700, fontSize: 13 }}>{tradingDays}</span>
          </div>
          <div style={{ background: C.card, borderRadius: 8, padding: '6px 14px', border: `1px solid ${C.border}` }}>
            <span style={{ color: C.green, fontSize: 10, fontWeight: 700 }}>{`${winDays}W `}</span>
            <span style={{ color: C.red, fontSize: 10, fontWeight: 700 }}>{`${lossDays}L`}</span>
          </div>
        </div>
      </div>

      {/* ── Day-of-week header row ─────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 2 }}>
        {DAY_NAMES.map((dn) => (
          <div key={dn} style={{ textAlign: 'center', color: C.dim, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '5px 0', background: C.card, borderRadius: 4 }}>{dn}</div>
        ))}
      </div>

      {/* ── Calendar grid ───────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} style={{ background: `${C.card}44`, borderRadius: 6, minHeight: 90, opacity: 0.3 }} />;

          const dayTrades = byDay[day] ?? [];
          const dayPL = sumFinite(dayTrades.map((t) => t._netPL));
          const dayR  = sumFinite(dayTrades.map((t) => t._r));
          const isToday = day === todayD && month === todayM && year === todayY;
          const hasTrades = dayTrades.length > 0;
          const isWin = dayPL !== null && dayPL > 0;
          const isAvailable = dayPL !== null;
          const bgColor = !hasTrades || !isAvailable ? C.card : isWin ? C.winBg : C.lossBg;
          const borderColor = isToday ? C.blue : (!hasTrades || !isAvailable ? C.border : isWin ? C.winBorder : C.lossBorder);

          return (
            <div
              key={day}
              onClick={hasTrades ? () => setSelectedDay(day) : undefined}
              style={{
                background: bgColor, border: `1px solid ${borderColor}`,
                borderRadius: 6, minHeight: 90, padding: '7px 8px', position: 'relative',
                cursor: hasTrades ? 'pointer' : 'default',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ color: isToday ? C.blue : C.dim, fontSize: 11, fontWeight: isToday ? 700 : 400 }}>{day}</span>
                {hasTrades && (
                  <span style={{ background: !isAvailable ? `${C.dim}33` : isWin ? `${C.green}33` : `${C.red}33`, color: !isAvailable ? C.dim : isWin ? C.green : C.red, fontSize: 8, borderRadius: 3, padding: '1px 4px', fontWeight: 700 }}>
                    {`${dayTrades.length} trade${dayTrades.length !== 1 ? 's' : ''}`}
                  </span>
                )}
              </div>
              {hasTrades && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: !isAvailable ? C.dim : isWin ? C.green : C.red, fontSize: 13, fontWeight: 800 }}>
                    {fr.usd(dayPL)}
                  </div>
                  <div style={{ color: isWin ? '#22C55E99' : '#EF444499', fontSize: 10 }}>
                    {fr.r(dayR)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Day detail modal (pre-approved Phase 10 addition) ────── */}
      {selectedDateStr && (
        <DayTradesModal
          date={selectedDateStr}
          trades={selectedDayTrades}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}
