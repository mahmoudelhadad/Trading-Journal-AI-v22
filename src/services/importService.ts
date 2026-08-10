/**
 * services/importService.ts
 *
 * Phase 13 — Import Wizard: parsing, column auto-mapping, row conversion.
 *
 * Migrated VERBATIM from the original single-file app's smart-import
 * logic: COL_ALIASES, smartAutoMap(), cleanVal(), cleanNum(), parseDate(),
 * parseTime(), parseFileContent() (RFC 4180 CSV parser), convertRow().
 * Every formula, every alias list, every heuristic is preserved exactly.
 *
 * CENTRALIZATION (per your Phase 13 rules — reuse existing calculation
 * functions, keep shared business logic centralized):
 *   - convertRow() now calls createEmptyTrade() from types/trade.js
 *     (Phase 1) instead of a page-local copy of emptyT().
 *   - convertRow() now calls isFutures() from constants/pipValues.js
 *     (Phase 1) instead of a page-local copy of isFut(). Both were
 *     ALREADY centralized in Phase 1, before this component existed in
 *     the migrated codebase — this is simply the first time a Phase 13
 *     module actually consumes them, not a new refactor.
 *
 * PRESERVED QUIRK (documented, not "fixed" — see MIGRATION_NOTES.md
 * KI-005): cleanNum()'s ternary `isNaN(+s)||s===""?s:s` returns the
 * SAME value `s` on both branches — the condition is dead code. The
 * function still behaves correctly (it strips commas via cleanVal()
 * before the ternary runs), so there is no functional bug, just a
 * vestigial no-op conditional. Reproduced exactly, not simplified.
 *
 * NEW in Phase 13 (pre-approved scope — see file header rationale in
 * components/import/ImportWizard.tsx): detectDuplicates(). Everything
 * else in this file is a faithful migration of existing logic.
 */

import { createEmptyTrade } from '@apptypes/trade.js';
import { isFutures } from '@constants/pipValues.js';
import type { RawTrade, RawTradeContent } from '@apptypes/trade.js';
import type { Account } from '@apptypes/account.js';
import { activeAccounts } from './tradeValidation.js';

// ─── Types ───────────────────────────────────────────────────

export type ColumnMap = Partial<Record<string, string>>;
export type ParsedRow = Record<string, string>;

// ─── Column alias table — copied verbatim ──────────────────────

export const COL_ALIASES: Record<string, string[]> = {
  symbol: ['symbol', 'sym', 'instrument', 'pair', 'ticker', 'asset', 'product', 'contract'],
  date: ['date', 'trade date', 'open date', 'close date', 'open_date', 'tradedate', 'entry date'],
  // account = account TYPE (EVAL/Funded/Demo), broker = the firm name (FTMO/TTP)
  account: ['account type', 'account_type', 'acc type', 'acct type', 'type of account', 'acc_type'],
  broker: ['broker', 'platform', 'source', 'account', 'firm', 'company'],
  session: ['session'],
  daySwing: ['day/ swing', 'day/swing', 'day swing', 'swing'],
  dailySetup: ['daily setup', 'daily_setup', 'daily bias', 'bias'],
  entrySetup: ['entry setup', 'entry_setup', 'entry pattern'],
  intraDaySetup: ['intraday setup', 'intraday_setup', 'mss msb ifvg', 'id setup', 'intra day setup'],
  intraDayTF: ['intraday tf', 'intraday_tf', 'timeframe', 'time frame'],
  direction: ['direction', 'long/ short', 'long/short', 'side', 'buy/sell', 'trade direction', 'long_short'],
  positionSize: ['lots', 'position size', 'size', 'volume', 'qty', 'quantity', 'contracts', 'lot size', 'lot', 'pos size'],
  entryTime: ['entry time', ' entry time', 'open time', 'entry_time', 'time open', 'time in'],
  exitTime: ['exit time', ' exit  time', 'exit   time', 'close time', 'exit_time', 'time close', 'time out'],
  entryPrice: ['entry price', 'entry_price', 'open price', 'price open', 'entry'],
  exitPrice: ['exit   price', 'exit price', 'exit_price', 'close price', 'price close', 'exit'],
  stopLoss: ['stop  loss', 'stop loss', 'sl', 'stop_loss', 'stoploss', 'stop'],
  target: ['target', 'tp', 'take profit', 'take_profit'],
  commission: ['commission', 'comm', 'fee', 'swap', 'charges'],
  notes: ['notes', 'note', 'comment', 'comments', 'remark', 'remarks'],
  beSL: ['be sl', ' be sl', 'besl', 'before sl'],
  afSL: ['af sl', 'afsl', 'after sl'],
  sl1: ['sl 1', 'sl1'], sl2: ['sl 2', 'sl2'], sl3: ['sl 3', 'sl3'],
  tm1: ['tm 1', 'tm1'], tm2: ['tm 2', 'tm2'], tm3: ['tm 3', 'tm3'],
  tm4: ['tm 4', 'tm4'], tm5: ['tm 5', 'tm5'], tm6: ['tm 6', 'tm6'],
  personalRating: ['personal rating', 'rating', 'score'],
  planFollowed: ['plan followed', 'plan_followed', 'followed plan'],
  emotions: ['emotions', 'emotion', 'psychology'],
  setupType: ['setup type', 'setup_type', 'grade', 'quality'],
  linkToChart: ['link to chart', 'chart link', 'chart url', 'screenshot'],
};

// ─── Smart column auto-mapping — copied verbatim ────────────────

/**
 * Auto-map source CSV/Excel headers to internal trade field names.
 * FORMULA: Two passes — (1) exact match against any alias (whitespace-
 *          normalised), (2) partial match (header CONTAINS a >=5-char
 *          alias), only for fields not already mapped by pass 1.
 * SOURCE:  Migrated verbatim from the original app's smartAutoMap().
 * ASSUMPTIONS: First-match-wins per field; once a field is mapped in
 *          pass 1, pass 2 never overwrites it. Headers are matched
 *          case-insensitively with whitespace collapsed.
 * EDGE CASES: Returns {} if no header matches any alias.
 */
export function smartAutoMap(headers: string[]): ColumnMap {
  const mapped: ColumnMap = {};

  headers.forEach((csvH) => {
    const low = csvH.toLowerCase().trim().replace(/\s+/g, ' ');
    Object.keys(COL_ALIASES).forEach((field) => {
      if (mapped[field]) return;
      const aliases = COL_ALIASES[field];
      for (const a0 of aliases) {
        const a = a0.toLowerCase().trim();
        if (low === a || low.replace(/\s+/g, '') === a.replace(/\s+/g, '')) {
          mapped[field] = csvH;
          return;
        }
      }
    });
  });

  headers.forEach((csvH) => {
    const low = csvH.toLowerCase().trim().replace(/\s+/g, ' ');
    Object.keys(COL_ALIASES).forEach((field) => {
      if (mapped[field]) return;
      const aliases = COL_ALIASES[field];
      for (const a0 of aliases) {
        const a = a0.toLowerCase().trim();
        if (a.length >= 5 && low.indexOf(a) >= 0) {
          mapped[field] = csvH;
          return;
        }
      }
    });
  });

  return mapped;
}

// ─── Value cleaning helpers — copied verbatim ───────────────────

export function cleanVal(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(/\r/g, '').replace(/\n/g, ' ').trim();
  if (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') s = s.slice(1, -1).trim();
  return s;
}

/**
 * Strip thousands-separator commas from a numeric-looking string.
 * PRESERVED QUIRK: the original app's ternary `isNaN(+s)||s===""?s:s`
 * returns `s` on both branches — a no-op condition. The function's
 * real work (comma stripping) still happens correctly beforehand; this
 * is reproduced exactly, not simplified. See MIGRATION_NOTES.md KI-005.
 */
export function cleanNum(v: unknown): string {
  const s = cleanVal(v).replace(/,/g, '');
  return isNaN(+s) || s === '' ? s : s; // eslint-disable-line no-unneeded-ternary
}

/**
 * Parse an unambiguous date string into 'YYYY-MM-DD' format.
 * Ambiguous and unsupported strings remain unchanged so validation
 * rejects them instead of relying on locale/browser interpretation.
 * SOURCE:  Migrated verbatim.
 * ASSUMPTIONS: When the first slash-separated number is <= 12, it is
 *          assumed to be the MONTH (M/D/YYYY, the common US broker
 *          export convention) — this is a heuristic, not a guarantee.
 * EDGE CASES: Returns the cleaned-but-unparsed string if no pattern
 *          matches and Date() parsing also fails (isNaN date).
 */
export function parseDate(v: unknown): string {
  const s = cleanVal(v);
  if (!s) return '';

  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    let mo = +m1[1], dy = +m1[2];
    const yr = +m1[3];
    if (mo <= 12 && dy <= 12) return s;
    if (mo > 12 && dy <= 12) { const t = mo; mo = dy; dy = t; }
    if (mo > 12 || dy > 31) return s;
    return `${yr}-${mo < 10 ? '0' + mo : mo}-${dy < 10 ? '0' + dy : dy}`;
  }

  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;

  return s;
}

export function parseTime(v: unknown): string {
  const s = cleanVal(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM)\b)?/i);
  if (m) {
    let h = +m[1];
    const mi = +m[2];
    const meridiem = m[3]?.toUpperCase();
    if (meridiem) {
      if (h < 1 || h > 12) return s;
      if (meridiem === 'AM') h = h === 12 ? 0 : h;
      else h = h === 12 ? 12 : h + 12;
    }
    return `${h < 10 ? '0' + h : h}:${mi < 10 ? '0' + mi : mi}`;
  }
  return s;
}

// ─── RFC 4180 CSV parser — copied verbatim ──────────────────────

/**
 * Parse raw CSV text into rows of string cells, per RFC 4180 —
 * handles quoted fields containing commas, newlines, and escaped
 * double-quotes ("").
 * SOURCE: Migrated verbatim from the original app's parseFileContent().
 * EDGE CASES: A trailing row with no terminating newline is still
 *          captured. Fully empty rows (all-empty cells) are dropped.
 */
/**
 * Parse an Excel workbook (.xlsx/.xls) into the SAME `string[][]` shape
 * `parseFileContent()` produces for CSV, so both feed `processRows()`
 * identically.
 *
 * v1.1 (H-XLSX): before this, components/import/ImportWizard.tsx declared
 * `declare const XLSX: any` and tested a bare GLOBAL that never existed in
 * the migrated app — the original single-file app loaded XLSX from a CDN
 * <script> tag, which index.html does not have. The ambient declaration kept
 * `tsc` green, so the defect was invisible to typecheck, and every Excel
 * upload fell into the "Excel library not loaded. Use CSV." branch. Vite
 * reported the same fact as `Generated an empty chunk: "xlsx"`.
 *
 * The `xlsx` package was already a declared dependency and already had a
 * manualChunks entry, so the repair needs no new dependency: it is loaded
 * DYNAMICALLY here, keeping it out of the initial bundle and fetching it
 * only when a user actually imports a workbook.
 *
 * The read/sheet_to_json call shape is retained exactly as it was.
 */
export async function parseWorkbookRows(data: ArrayBuffer): Promise<string[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(data, { type: 'array', cellDates: false, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('The workbook contains no sheets.');
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }) as string[][];
}

export function parseFileContent(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQ = false; i++; }
      } else { field += c; i++; }
    } else {
      if (c === '"') { inQ = true; i++; }
      else if (c === ',') { row.push(field.trim()); field = ''; i++; }
      else if (c === '\r' && text[i + 1] === '\n') { row.push(field.trim()); result.push(row); row = []; field = ''; i += 2; }
      else if (c === '\n' || c === '\r') { row.push(field.trim()); result.push(row); row = []; field = ''; i++; }
      else { field += c; i++; }
    }
  }
  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.some((v) => v)) result.push(row);
  }
  return result;
}

// ─── Row -> Trade conversion — copied verbatim (with centralized deps) ──

/**
 * Convert one parsed row into a RawTrade using the given column mapping.
 * FORMULA:  For each mapped field, clean the raw value and apply
 *           field-specific parsing (date/time/numeric). Account is
 *           resolved by matching the row's broker (preferred) or
 *           account field against active account names exactly, or by
 *           sole-account inference. Market is auto-detected via
 *           isFutures(symbol).
 * SOURCE:   Migrated verbatim from the original app's convertRow(),
 *           except emptyT()->createEmptyTrade() and isFut()->
 *           isFutures() now come from their Phase 1 centralized
 *           locations instead of page-local copies.
 * EDGE CASES: A row with no value for a mapped field is left as the
 *           empty-trade default for that field (not overwritten).
 */
export interface AccountResolution {
  accountId: string | null;
  error?: string;
}

export function resolveImportAccount(matchValue: string, accounts: Account[]): AccountResolution {
  const candidates = activeAccounts(accounts);
  const normalized = cleanVal(matchValue).toLowerCase();
  if (!normalized) {
    if (candidates.length === 1) return { accountId: candidates[0].id };
    return candidates.length > 1
      ? { accountId: null, error: 'Account is missing and more than one active account exists.' }
      : { accountId: null, error: 'Account does not exactly match an active account.' };
  }
  const matches = candidates.filter((account) => account.name.toLowerCase() === normalized);
  if (matches.length === 1) return { accountId: matches[0].id };
  if (matches.length > 1) return { accountId: null, error: 'Account name matches more than one active account.' };
  return { accountId: null, error: 'Account does not exactly match an active account.' };
}

export function convertRow(row: ParsedRow, colMap: ColumnMap, accounts: Account[]): RawTradeContent {
  const t = createEmptyTrade('') as RawTradeContent;
  t.date = '';
  t._tid = Date.now() + Math.random();

  Object.keys(colMap).forEach((field) => {
    const csvCol = colMap[field];
    if (!csvCol) return;
    let val = cleanVal(row[csvCol]);
    if (!val) return;
    if (field === 'date') val = parseDate(val);
    else if (field === 'entryTime' || field === 'exitTime') val = parseTime(val);
    else if (['entryPrice', 'exitPrice', 'stopLoss', 'target', 'positionSize', 'commission'].indexOf(field) >= 0) val = cleanNum(val);
    (t as unknown as Record<string, string>)[field] = val;
  });

  const resolution = resolveImportAccount(t.broker || t.account || '', accounts);
  if (resolution.accountId) t.accountId = resolution.accountId;

  t.market = isFutures(t.symbol) ? 'futures' : 'forex';

  return t;
}

// ─── Header detection — copied verbatim from processRows() ──────

export interface ProcessedFile {
  headers:  string[];
  rows:     ParsedRow[];
  colMap:   ColumnMap;
}

export interface ProcessFileError {
  error: string;
}

/**
 * Detect the header row (first row with >3 non-empty cells, scanning
 * up to the first 10 rows), convert remaining rows to objects, and
 * auto-map columns.
 * SOURCE: Migrated verbatim from the original app's processRows().
 * EDGE CASES: Returns a ProcessFileError if no header row is found in
 *           the first 10 rows, or if no data rows remain after the
 *           header.
 */
export function processRows(rows: string[][]): ProcessedFile | ProcessFileError {
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i].filter((v) => cleanVal(v)).length > 3) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) return { error: 'Could not detect headers.' };

  const headers = rows[hdrIdx].map((h) => cleanVal(h).replace(/[\r\n]/g, ' ').trim());
  const dataRows = rows.slice(hdrIdx + 1).filter((r) => r.some((v) => cleanVal(v)));
  if (!dataRows.length) return { error: 'No data rows found.' };

  const objs: ParsedRow[] = dataRows.map((row) => {
    const obj: ParsedRow = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  const colMap = smartAutoMap(headers);

  return { headers, rows: objs, colMap };
}

export function isProcessError(x: ProcessedFile | ProcessFileError): x is ProcessFileError {
  return 'error' in x;
}

// ─── NEW in Phase 13: Duplicate Detection ────────────────────────
// Pre-approved scope — see components/import/ImportWizard.tsx header
// for the exact quote from the originally-approved migration plan.

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  /** The existing trade this row appears to match, if any */
  matchedTrade?: RawTrade;
}

/**
 * Check whether an about-to-be-imported trade appears to already exist.
 * FORMULA:  A row is flagged as a likely duplicate if an EXISTING trade
 *           has the SAME date AND symbol AND entryPrice AND direction.
 * SOURCE:   New — no equivalent in the original app (which had no
 *           duplicate-detection at all). This specific 4-field match
 *           rule (date+symbol+entryPrice+direction) was chosen as a
 *           reasonable, conservative heuristic: it is specific enough
 *           to avoid false positives on genuinely different trades of
 *           the same symbol on the same day, while still catching the
 *           most common real-world duplicate scenario (re-importing
 *           the same broker statement twice).
 * ASSUMPTIONS: This is a HEURISTIC, not a guarantee — two genuinely
 *           different trades that happen to share all 4 fields (e.g.
 *           two identical scalps at the same price) would be flagged
 *           as a false positive. The UI always lets the user import
 *           flagged rows anyway (see ImportWizard.tsx) rather than
 *           silently dropping them.
 * EDGE CASES: A row missing date, symbol, entryPrice, or direction
 *           never matches (treated as insufficient data to compare).
 */
export function detectDuplicate(candidate: RawTradeContent, existingTrades: RawTrade[]): DuplicateCheckResult {
  if (!candidate.date || !candidate.symbol || !candidate.entryPrice || !candidate.direction) {
    return { isDuplicate: false };
  }
  const match = existingTrades.find((t) =>
    t.date === candidate.date &&
    t.symbol === candidate.symbol &&
    t.entryPrice === candidate.entryPrice &&
    t.direction === candidate.direction,
  );
  return match ? { isDuplicate: true, matchedTrade: match } : { isDuplicate: false };
}

/**
 * Run detectDuplicate() over a full batch of candidate trades.
 * Returns the same array with each item's duplicate status attached.
 */
export function detectDuplicates(
  candidates: RawTradeContent[],
  existingTrades: RawTrade[],
): Array<RawTradeContent & { _isDuplicate: boolean }> {
  return candidates.map((c) => ({ ...c, _isDuplicate: detectDuplicate(c, existingTrades).isDuplicate }));
}
