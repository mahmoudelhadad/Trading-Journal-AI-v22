/**
 * services/exportService.ts
 *
 * Phase 13 — Export Trades to CSV.
 *
 * Migrated VERBATIM from the original single-file app's exportCSV()
 * function. Same 23-column header order, same field formatting
 * (R to 3 decimals, $ values to 2 decimals, points to 2 decimals),
 * same CSV-quoting/escaping, same filename convention.
 */

import type { EnrichedTrade } from '@calculations/tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface ExportOptions {
  /** 'all' or a specific account ID */
  accountId: string;
}

// ─── Column headers — copied verbatim ──────────────────────────

const EXPORT_HEADERS = [
  '#', 'Date', 'Symbol', 'Market', 'Direction', 'Size', 'Entry', 'SL', 'Target', 'Exit',
  'R', 'P/L', 'Net P/L', 'Points/Pips', 'Outcome', 'Setup', 'Type', 'Session',
  'Broker', 'Account', 'Duration', 'Commission', 'Notes',
];

// ─── Row builder — copied verbatim ─────────────────────────────

function buildRow(t: EnrichedTrade): (string | number)[] {
  return [
    t._i, t.date ?? '', t.symbol ?? '', t.market ?? '', t.direction ?? '', t.positionSize ?? '',
    t.entryPrice ?? '', t.stopLoss ?? '', t.target ?? '', t.exitPrice ?? '',
    t._r !== null ? t._r.toFixed(3) : '',
    t._pl !== null ? t._pl.toFixed(2) : '',
    t._netPL !== null ? t._netPL.toFixed(2) : '',
    t._pts !== null ? t._pts.toFixed(2) : '',
    t._outcome, t.entrySetup ?? '', t.setupType ?? '', t.session ?? '',
    t.broker ?? '', t.account ?? '', t._dur ?? '', t.commission ?? '', t.notes ?? '',
  ];
}

// ─── CSV serialization — copied verbatim ───────────────────────

/**
 * Build a CSV string for the given trades.
 * FORMULA: Header row + one row per trade, all fields double-quoted
 *          with internal quotes escaped as "" (RFC 4180).
 * SOURCE:  Migrated verbatim from the original app's exportCSV().
 */
export function buildExportCSV(trades: EnrichedTrade[]): string {
  const rows = trades.map(buildRow);
  const lines = [EXPORT_HEADERS.join(',')].concat(
    rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')),
  );
  return '\ufeff' + lines.join('\n');
}

/**
 * Trigger a browser download of the given trades as a CSV file.
 * FORMULA: Filters trades by accountId ('all' = no filter), builds the
 *          CSV, and triggers a download via an in-memory Blob URL.
 * SOURCE:  Migrated verbatim from the original app's exportCSV(accId).
 * Filename convention preserved exactly:
 *   trades_{accountId|"all"}_{YYYY-MM-DD}.csv
 */
export function exportTradesAsCSV(trades: EnrichedTrade[], options: ExportOptions): void {
  const filtered = options.accountId === 'all'
    ? trades
    : trades.filter((t) => t.accountId === options.accountId);

  const csv = buildExportCSV(filtered);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trades_${options.accountId === 'all' ? 'all' : options.accountId}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
