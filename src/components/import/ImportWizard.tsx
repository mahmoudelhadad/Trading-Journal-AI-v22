/**
 * components/import/ImportWizard.tsx
 *
 * Phase 13 — Import Wizard (modal component, not a page — matches the
 * original app's structure where Import/Export was always a header-
 * triggered modal, never a tab).
 *
 * Migrated from the original single-file app's ImportExport(props)
 * component. Every workflow step, status message, and the export
 * button row are preserved exactly. Parsing/mapping/conversion logic
 * itself lives in services/importService.ts and services/
 * exportService.ts (Phase 13) — this component only handles file
 * input, state transitions, and rendering, reusing those services.
 *
 * PRE-APPROVED SCOPE ADDITIONS (not new-scope creep — quoting the
 * original migration plan, approved before any migration work began):
 *
 *   "IMPORT / EXPORT — Improve existing import system. Support: CSV,
 *   Excel, Better Validation, Duplicate Detection, Column Mapping
 *   Improvements, Import Preview, Error Report."
 *
 * "Import Preview" and "Column Mapping" (display) already existed in
 * the original app and are migrated as-is. "Duplicate Detection" did
 * NOT exist in the original app and is added here, exactly as scoped:
 *   - Each previewed row is checked against existing trades via
 *     detectDuplicate() (services/importService.ts) — a simple,
 *     documented 4-field heuristic (date+symbol+entryPrice+direction).
 *   - Duplicate rows are visually flagged in the preview table.
 *   - A "Skip likely duplicates" checkbox (default ON) lets the user
 *     exclude flagged rows from the import; turning it off imports
 *     everything, including flagged rows — the tool never silently
 *     drops data without the user's control.
 *   - "Error Report" scope item: the post-import success message now
 *     also reports how many rows were skipped as duplicates, if any.
 *
 * No other feature beyond these two explicitly pre-scoped items was
 * added. No new file formats, no new column-mapping UI beyond the
 * existing read-only display, no redesign of the modal's layout.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { SectionHeader } from '@components/ui/SectionHeader.js';
import { Divider } from '@components/ui/Divider.js';
import {
  parseFileContent, parseWorkbookRows, processRows, isProcessError, convertRow, detectDuplicate, resolveImportAccount,
  type ColumnMap, type ParsedRow,
} from '@services/importService.js';
import { validateTradeContent } from '@services/tradeValidation.js';
import { exportTradesAsCSV } from '@services/exportService.js';
import type { RawTrade, RawTradeContent } from '@hooks/useTrades.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface ImportWizardProps {
  trades:      EnrichedTrade[]; // for export + existing-trade duplicate comparison
  rawTrades:   RawTrade[];      // existing trades, used for duplicate detection
  accounts:    Account[];
  // RawTradeContent — freshly-converted CSV/Excel rows have no sync
  // identity yet (see convertRow(), services/importService.ts); it's
  // assigned by useTrades().importTrades() (Phase 5a decision 4).
  onImport:    (trades: RawTradeContent[]) => void;
  onClose:     () => void;
}

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'done';

// ─── Component ───────────────────────────────────────────────

export function ImportWizard({ trades, rawTrades, accounts, onImport, onClose }: ImportWizardProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [feedback, setFeedback] = useState('');
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [colMap, setColMap] = useState<ColumnMap>({});
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  function handleProcessed(parsedRows: string[][]) {
    const result = processRows(parsedRows);
    if (isProcessError(result)) {
      setFeedback(result.error);
      setStatus('error');
      return;
    }
    setColMap(result.colMap);
    setRows(result.rows);
    setPreview(result.rows.slice(0, 3));
    const mappedCount = Object.keys(result.colMap).length;
    setFeedback(`✅ ${result.rows.length} rows detected. Auto-mapped ${mappedCount}/${result.headers.length} columns.`);
    setStatus('ready');
  }

  function handleFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setStatus('loading');
    setFeedback('Reading file...');
    setPreview(null);
    setRows([]);
    const name = file.name.toLowerCase();

    if (name.endsWith('.csv')) {
      const r = new FileReader();
      r.onload = (e) => {
        try {
          const parsed = parseFileContent(e.target?.result as string);
          handleProcessed(parsed);
        } catch (err) {
          setFeedback(`CSV error: ${(err as Error).message}`);
          setStatus('error');
        }
      };
      r.readAsText(file);
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      // v1.1: the Excel parser is loaded on demand by parseWorkbookRows()
      // (services/importService.ts). A failed chunk fetch rejects like any
      // other workbook failure, so it surfaces through this same channel
      // instead of the old always-true "library not loaded" dead end.
      const r2 = new FileReader();
      r2.onload = (e) => {
        parseWorkbookRows(e.target?.result as ArrayBuffer)
          .then(handleProcessed)
          .catch((err) => {
            setFeedback(`Excel error: ${(err as Error).message}`);
            setStatus('error');
          });
      };
      r2.readAsArrayBuffer(file);
    } else {
      setFeedback('Unsupported format. Use CSV or XLSX.');
      setStatus('error');
    }
  }

  // Pre-compute duplicate flags for the current row set (used by both
  // the preview badges and the actual import filter)
  const rowsWithDupFlag = rows.map((row) => {
    const candidate = convertRow(row, colMap, accounts);
    const accountResolution = resolveImportAccount(candidate.broker || candidate.account || '', accounts);
    const errors = validateTradeContent(candidate, accounts).map((error) => {
      if (error === 'select an active account.') return accountResolution.error ?? 'Account does not exactly match an active account.';
      if (error === 'enter a valid YYYY-MM-DD date.') return 'Date is missing or ambiguous; use YYYY-MM-DD.';
      if (error === 'select a supported symbol.') return 'Symbol is missing or unsupported.';
      if (error === 'direction must be Long or Short when trade prices are entered.') return 'Direction must be Long or Short when trade prices are present.';
      return error;
    });
    return { row, candidate, errors, isDuplicate: detectDuplicate(candidate, rawTrades).isDuplicate };
  });
  const duplicateCount = rowsWithDupFlag.filter((r) => r.isDuplicate).length;
  const rejectedCount = rowsWithDupFlag.filter((r) => r.errors.length > 0).length;
  const acceptedRows = rowsWithDupFlag.filter((r) => r.errors.length === 0);

  function doImport() {
    if (!rows.length) return;
    const toImport = acceptedRows
      .filter((r) => !(skipDuplicates && r.isDuplicate))
      .map((r) => r.candidate);

    if (!acceptedRows.length) {
      setFeedback('No valid trades to import. Review the rejected rows.');
      setStatus('error');
      return;
    }

    onImport(toImport);
    setStatus('done');
    const skippedMsg = skipDuplicates && duplicateCount > 0 ? ` (${duplicateCount} likely duplicate${duplicateCount !== 1 ? 's' : ''} skipped)` : '';
    setFeedback(`Imported ${toImport.length} trades. Rejected ${rejectedCount} invalid rows.${skippedMsg}`);
    setPreview(null);
    setRows([]);
    setColMap({});
  }

  function handleExport(accountId: string) {
    exportTradesAsCSV(trades, { accountId });
  }

  const accOpts = [{ id: 'all', name: 'All Accounts' }, ...accounts];

  return (
    <Modal onClose={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 640, marginTop: 16, marginBottom: 20 }}>
        <div style={{ padding: '13px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>📂 Smart Import / Export</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          <SectionHeader color={C.blue} label="Import Trades — CSV or Excel (any format)" />
          <div style={{ background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`, padding: 12, marginBottom: 10 }}>
            <div style={{ color: C.dim, fontSize: 10, marginBottom: 8 }}>
              Upload any CSV/Excel file. The system auto-detects columns and maps them — no manual setup needed.
            </div>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} style={{ color: C.text, fontSize: 11, width: '100%' }} />
          </div>

          {feedback && (
            <div style={{
              background: status === 'error' ? `${C.red}22` : status === 'done' ? `${C.green}22` : `${C.blue}22`,
              border: `1px solid ${(status === 'error' ? C.red : status === 'done' ? C.green : C.blue)}44`,
              borderRadius: 7, padding: '8px 12px', fontSize: 11,
              color: status === 'error' ? C.red : status === 'done' ? C.green : C.text, marginBottom: 10,
            }}>
              {feedback}
            </div>
          )}

          {status === 'ready' && rows.length > 0 && (
            <div>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 6, fontWeight: 600 }}>Auto-detected column mapping:</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', background: C.bg, borderRadius: 7, padding: 10, border: `1px solid ${C.border}`, maxHeight: 180, overflowY: 'auto', marginBottom: 10 }}>
                {Object.keys(colMap).map((field) => (
                  <div key={field} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
                    <span style={{ color: C.green, fontSize: 10, fontWeight: 700, minWidth: 90 }}>{`${field}:`}</span>
                    <span style={{ color: C.text, fontSize: 10 }}>{colMap[field]}</span>
                  </div>
                ))}
              </div>

              {/* Duplicate Detection — pre-approved scope addition, see file header */}
              {duplicateCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: `${C.gold}15`, border: `1px solid ${C.gold}44`, borderRadius: 7, padding: '8px 12px', marginBottom: 10 }}>
                  <span style={{ color: C.gold, fontSize: 11 }}>
                    {`⚠️ ${duplicateCount} row${duplicateCount !== 1 ? 's' : ''} look${duplicateCount === 1 ? 's' : ''} like duplicate${duplicateCount !== 1 ? 's' : ''} of existing trades (same date, symbol, entry price & direction).`}
                  </span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', fontSize: 10, color: C.text, whiteSpace: 'nowrap', cursor: 'pointer' }}>
                    <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                    Skip duplicates
                  </label>
                </div>
              )}

              <div style={{ color: rejectedCount > 0 ? C.red : C.green, fontSize: 10, marginBottom: 8 }}>
                {`${acceptedRows.length} rows ready to import. ${rejectedCount} rows rejected.`}
              </div>

              {preview && preview.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>Preview (first 3 rows after mapping):</div>
                  <div style={{ overflowX: 'auto', borderRadius: 6, border: `1px solid ${C.border}` }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 10 }}>
                      <thead>
                        <tr>
                          {['Symbol', 'Date', 'Direction', 'Entry', 'SL', 'Exit', 'Session', ''].map((hd) => (
                            <th key={hd} style={{ background: C.bg, color: C.dim, padding: '4px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{hd}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => {
                          const t = convertRow(row, colMap, accounts);
                          const rowState = rowsWithDupFlag[i];
                          const isDup = rowState?.isDuplicate;
                          const cells = [t.symbol || '—', t.date || '—', t.direction || '—', t.entryPrice || '—', t.stopLoss || '—', t.exitPrice || '—', t.session || '—'];
                          return (
                            <tr key={i} style={{ background: isDup ? `${C.gold}15` : (i % 2 === 0 ? C.row : C.rowAlt) }}>
                              {cells.map((v, j) => (
                                <td key={j} style={{ color: C.text, padding: '4px 8px', borderBottom: '1px solid #151E2E', whiteSpace: 'nowrap' }}>{v}</td>
                              ))}
                              <td title={rowState?.errors.join(' ')} style={{ padding: '4px 8px', borderBottom: '1px solid #151E2E' }}>
                                {rowState?.errors.length
                                  ? <span style={{ color: C.red, fontSize: 9 }}>rejected</span>
                                  : isDup && <span style={{ color: C.gold, fontSize: 9 }}>⚠️ dup</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <button onClick={doImport} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' }}>
                {`✅ Import ${skipDuplicates ? acceptedRows.length - acceptedRows.filter((r) => r.isDuplicate).length : acceptedRows.length} Trades Now`}
              </button>
            </div>
          )}

          {status === 'done' && (
            <button onClick={() => { setStatus('idle'); setFeedback(''); }} style={{ background: C.blue, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 12, fontWeight: 700, marginBottom: 10, width: '100%' }}>
              Import Another File
            </button>
          )}

          <Divider />

          <SectionHeader color={C.green} label="Export Trades to CSV" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {accOpts.map((a) => {
              const cnt = a.id === 'all' ? trades.length : trades.filter((t) => t.accountId === a.id).length;
              return (
                <button key={a.id} onClick={() => handleExport(a.id)} style={{ background: C.row, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}>
                  {`⬇ ${a.name} (${cnt})`}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
