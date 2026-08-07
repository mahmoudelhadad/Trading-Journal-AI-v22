/**
 * components/trade/TradeRow.tsx
 *
 * Single row in the Raw trades table.
 *
 * Migrated VERBATIM from the row-rendering logic inside the original
 * RawTab's filtered.map(function(t,i){ ... }) block. Every column,
 * every color rule, and the Edit/Delete button behavior are preserved
 * exactly. Only the underlying primitives were swapped for the
 * Phase 3 UI atoms (TableCell, Badge) — visual output is identical.
 *
 * Column order (28 total, matches original hdrs array exactly):
 *   ☐ # Mkt Symbol Date Day Session Account Dir Size Entry SL Target Exit
 *   R Pts P/L Net P/L PlanR Outcome Setup ★ Plan Risk$ Risk% Dur Chart Edit
 *
 * Backward compatibility: FULLY PRESERVED
 * - Selected-row highlight color: '#1A2E50' (matches original exactly)
 * - Alternating row colors: C.row / C.rowAlt
 * - All color-mapping rules copied verbatim via formatters.ts helpers
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { TableCell } from '@components/ui/Table.js';
import { Badge } from '@components/ui/Badge.js';
import {
  fr,
  getOutcomeColor,
  getDirectionColor,
  getSignColor,
  getPlanFollowedColor,
  formatDayShort,
} from '@calculations/formatters.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface TradeRowProps {
  trade:       EnrichedTrade;
  accounts:    Account[];
  isSelected:  boolean;
  /** Row index within the filtered list — determines alternating background */
  rowIndex:    number;
  onToggleSelect: (tid: number) => void;
  onEdit:      (trade: EnrichedTrade) => void;
  onDelete:    (tid: number) => void;
}

// ─── Component ───────────────────────────────────────────────

export function TradeRow({
  trade: t,
  accounts,
  isSelected,
  rowIndex,
  onToggleSelect,
  onEdit,
  onDelete,
}: TradeRowProps) {
  // Matches original:
  //   var bg = isSelected ? "#1A2E50" : i%2===0 ? C.row : C.rowAlt;
  const bg = isSelected ? '#1A2E50' : rowIndex % 2 === 0 ? C.row : C.rowAlt;

  const day  = formatDayShort(t.date);
  const mc   = t.market === 'futures' ? C.orange : C.blue;
  const account = accounts.find((a) => a.id === t.accountId);
  const accName = account?.name ?? '⚠ Unresolved account';

  return (
    <tr style={{ background: bg }}>
      {/* ☐ Selection checkbox */}
      <TableCell>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(t._tid)}
          style={{ cursor: 'pointer', accentColor: C.blue }}
        />
      </TableCell>

      {/* # */}
      <TableCell>{t._i}</TableCell>

      {/* Mkt */}
      <TableCell>
        <Badge color={mc}>{t.market === 'futures' ? 'Fut' : 'FX'}</Badge>
      </TableCell>

      {/* Symbol */}
      <TableCell style={{ fontWeight: 700, color: C.white }}>
        {t.symbol || '—'}
      </TableCell>

      {/* Date */}
      <TableCell>{t.date || '—'}</TableCell>

      {/* Day */}
      <TableCell>{day}</TableCell>

      {/* Session */}
      <TableCell>{t.session || '—'}</TableCell>

      {/* Account */}
      <TableCell
        style={{ fontSize: 10, color: account ? C.dim : C.gold, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        <span title={account ? undefined : 'This trade references an account that is no longer available. Account-capital calculations are unavailable.'}>
          {accName}
        </span>
      </TableCell>

      {/* Dir */}
      <TableCell style={{ color: getDirectionColor(t.direction ?? ''), fontWeight: 700 }}>
        {t.direction || '—'}
      </TableCell>

      {/* Size */}
      <TableCell>{t.positionSize || '—'}</TableCell>

      {/* Entry */}
      <TableCell>{t.entryPrice || '—'}</TableCell>

      {/* SL */}
      <TableCell>{t.stopLoss || '—'}</TableCell>

      {/* Target */}
      <TableCell>{t.target || '—'}</TableCell>

      {/* Exit */}
      <TableCell>{t.exitPrice || '—'}</TableCell>

      {/* R */}
      <TableCell style={{ color: getSignColor(t._r), fontWeight: 700 }}>
        {fr.r(t._r)}
      </TableCell>

      {/* Pts */}
      <TableCell style={{ color: t._pts !== null ? getSignColor(t._pts) : C.dim }}>
        {t._pts !== null ? fr.pt(t._pts) : '—'}
      </TableCell>

      {/* P/L */}
      <TableCell style={{ color: t._pl !== null ? getSignColor(t._pl) : C.dim }}>
        {fr.usd(t._pl)}
      </TableCell>

      {/* Net P/L */}
      <TableCell style={{ color: t._netPL !== null ? getSignColor(t._netPL) : C.dim }}>
        {fr.usd(t._netPL)}
      </TableCell>

      {/* PlanR */}
      <TableCell style={{ color: C.gold }}>
        {fr.r(t._plannedR)}
      </TableCell>

      {/* Outcome */}
      <TableCell>
        <Badge color={getOutcomeColor(t._outcome)}>{t._outcome || '—'}</Badge>
      </TableCell>

      {/* Setup */}
      <TableCell>{t.setupType || '—'}</TableCell>

      {/* ★ Rating */}
      <TableCell>{t.personalRating || '—'}</TableCell>

      {/* Plan */}
      <TableCell style={{ color: getPlanFollowedColor(t.planFollowed ?? '') }}>
        {t.planFollowed || '—'}
      </TableCell>

      {/* Risk$ */}
      <TableCell>{t._rv !== null ? `$${t._rv.toFixed(0)}` : '—'}</TableCell>

      {/* Risk% */}
      <TableCell>{fr.pct(t._rPct)}</TableCell>

      {/* Dur */}
      <TableCell>{t._dur || '—'}</TableCell>

      {/* Chart */}
      <TableCell>
        {t.linkToChart ? (
          <a
            href={t.linkToChart}
            target="_blank"
            rel="noopener noreferrer"
            className="chart-link"
          >
            🔗 View
          </a>
        ) : (
          <span style={{ color: C.dim, fontSize: 10 }}>—</span>
        )}
      </TableCell>

      {/* Edit / Del */}
      <TableCell>
        <div style={{ display: 'flex', gap: 3 }}>
          <button
            onClick={() => onEdit(t)}
            style={{
              background: '#1A3A6B', border: 'none', color: C.blue,
              borderRadius: 4, padding: '2px 7px', fontSize: 10, cursor: 'pointer',
            }}
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(t._tid)}
            style={{
              background: '#3A1A1A', border: 'none', color: C.red,
              borderRadius: 4, padding: '2px 7px', fontSize: 10, cursor: 'pointer',
            }}
          >
            Del
          </button>
        </div>
      </TableCell>
    </tr>
  );
}
