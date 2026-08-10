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

import React, { useRef, useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { SectionHeader } from '@components/ui/SectionHeader.js';
import { Divider } from '@components/ui/Divider.js';
import {
  parseFileContent, parseWorkbookRows, processRows, isProcessError, convertRow, detectDuplicate, resolveImportAccount,
  type ColumnMap, type ParsedRow,
} from '@services/importService.js';
import { activeAccounts, validateTradeContent } from '@services/tradeValidation.js';
import { exportTradesAsCSV } from '@services/exportService.js';
import {
  executionProvenanceKey, importNinjaTrader, inspectNinjaTraderFiles,
  type NinjaTraderInspection,
} from '@services/ninjaTraderAdapter.js';
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
type ImportSource = 'generic' | 'ninjatrader';

// ─── Component ───────────────────────────────────────────────

export function ImportWizard({ trades, rawTrades, accounts, onImport, onClose }: ImportWizardProps) {
  const [importSource, setImportSource] = useState<ImportSource>('generic');
  const [status, setStatus] = useState<Status>('idle');
  const [feedback, setFeedback] = useState('');
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [colMap, setColMap] = useState<ColumnMap>({});
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [executionsCsv, setExecutionsCsv] = useState('');
  const [tradesCsv, setTradesCsv] = useState('');
  const [ninjaInspection, setNinjaInspection] = useState<NinjaTraderInspection | null>(null);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [timezoneAcknowledged, setTimezoneAcknowledged] = useState(false);
  const executionsCsvRef = useRef('');
  const tradesCsvRef = useRef('');

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

  function inspectNinjaTrader(executionsText: string, tradesText: string) {
    const result = inspectNinjaTraderFiles(executionsText, tradesText);
    if (!result.ok) {
      setNinjaInspection(null);
      setAccountMap({});
      setFeedback(result.error);
      setStatus('error');
      return;
    }
    setNinjaInspection(result.inspection);
    setAccountMap(Object.fromEntries(result.inspection.sourceAccounts.map((sourceAccount) => [sourceAccount, ''])));
    setFeedback(`Discovered ${result.inspection.sourceAccounts.length} source account${result.inspection.sourceAccounts.length === 1 ? '' : 's'} and ${result.inspection.instruments.length} instrument${result.inspection.instruments.length === 1 ? '' : 's'}.`);
    setStatus('ready');
  }

  function handleNinjaTraderFile(kind: 'executions' | 'trades', ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setStatus('loading');
    setFeedback(`Reading ${kind === 'executions' ? 'Executions' : 'Trades'} CSV...`);
    setNinjaInspection(null);
    setAccountMap({});
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (kind === 'executions') {
        executionsCsvRef.current = text;
        setExecutionsCsv(text);
      } else {
        tradesCsvRef.current = text;
        setTradesCsv(text);
      }
      const nextExecutions = executionsCsvRef.current;
      const nextTrades = tradesCsvRef.current;
      if (nextExecutions && nextTrades) inspectNinjaTrader(nextExecutions, nextTrades);
      else {
        setFeedback(`${kind === 'executions' ? 'Executions' : 'Trades'} CSV loaded. Select the other NinjaTrader file.`);
        setStatus('idle');
      }
    };
    reader.onerror = () => {
      setFeedback(`Could not read the ${kind === 'executions' ? 'Executions' : 'Trades'} CSV.`);
      setStatus('error');
    };
    reader.readAsText(file);
  }

  function doNinjaTraderImport() {
    if (!ninjaInspection || !timezoneAcknowledged
      || ninjaInspection.sourceAccounts.some((sourceAccount) => !accountMap[sourceAccount])) return;

    const existingProvenance = new Set<string>();
    for (const trade of rawTrades) {
      if (!Array.isArray(trade.legs) || !trade.sourcePlatform || !trade.sourceAccountId || !trade.sourceInstrument) continue;
      for (const leg of trade.legs) {
        existingProvenance.add(executionProvenanceKey(
          trade.sourcePlatform, trade.sourceAccountId, trade.sourceInstrument, leg.sourceExecutionId,
        ));
      }
    }

    const result = importNinjaTrader({ executionsCsv, tradesCsv, accountMap, existingProvenance, accounts });
    if (!result.ok) {
      setFeedback(result.error);
      setStatus('error');
      return;
    }

    // `episodeCount` is how many flat-to-flat episodes the source FILES contained;
    // `result.trades` is how many were actually imported after the idempotency
    // filter removed already-imported ones. Reporting the former as "Imported"
    // claimed work that never happened on a fully-skipped re-import, so the three
    // quantities are now stated separately and `totalLegCount` — which is already
    // summed over `result.trades` only — is explicitly labelled as new legs.
    const importedCount = result.trades.length;
    const totalLegCount = result.trades.reduce((total, trade) => total + (trade.legs?.length ?? 0), 0);
    const plural = (n: number) => (n === 1 ? '' : 's');
    onImport(result.trades);
    setFeedback(`Processed ${result.episodeCount} episode${plural(result.episodeCount)}: imported ${importedCount} (${totalLegCount} new leg${plural(totalLegCount)}), skipped ${result.skippedAlreadyImported} already imported.`);
    setStatus('done');
  }

  // Pre-compute duplicate flags for the current row set (used by both
  // the preview badges and the actual import filter)
  const rowsWithDupFlag = importSource === 'generic' ? rows.map((row) => {
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
  }) : [];
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
  const currentAccounts = activeAccounts(accounts);
  const ninjaImportDisabled = !ninjaInspection || !timezoneAcknowledged
    || ninjaInspection.sourceAccounts.some((sourceAccount) => !accountMap[sourceAccount]);

  return (
    <Modal onClose={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, width: '100%', maxWidth: 640, marginTop: 16, marginBottom: 20 }}>
        <div style={{ padding: '13px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>📂 Smart Import / Export</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.dim, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: 10 }}>
            <label style={{ color: C.dim, fontSize: 10, display: 'block', marginBottom: 4 }}>Import source</label>
            <select value={importSource} onChange={(event) => {
              setImportSource(event.target.value as ImportSource);
              setStatus('idle');
              setFeedback('');
            }} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '7px 10px', fontSize: 11, width: '100%' }}>
              <option value="generic">Generic CSV/Excel</option>
              <option value="ninjatrader">NinjaTrader</option>
            </select>
          </div>

          {importSource === 'generic' && (
            <>
          <SectionHeader color={C.blue} label="Import Trades — CSV or Excel (any format)" />
          <div style={{ background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`, padding: 12, marginBottom: 10 }}>
            <div style={{ color: C.dim, fontSize: 10, marginBottom: 8 }}>
              Upload any CSV/Excel file. The system auto-detects columns and maps them — no manual setup needed.
            </div>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} style={{ color: C.text, fontSize: 11, width: '100%' }} />
          </div>
            </>
          )}

          {importSource === 'ninjatrader' && (
            <>
              <SectionHeader color={C.blue} label="Import Trades — NinjaTrader" />
              <div style={{ background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`, padding: 12, marginBottom: 10 }}>
                <label style={{ color: C.text, fontSize: 11, display: 'block', marginBottom: 10 }}>
                  <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Executions CSV</span>
                  <input type="file" accept=".csv" onChange={(event) => handleNinjaTraderFile('executions', event)} style={{ color: C.text, fontSize: 11, width: '100%' }} />
                </label>
                <label style={{ color: C.text, fontSize: 11, display: 'block' }}>
                  <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Trades CSV</span>
                  <input type="file" accept=".csv" onChange={(event) => handleNinjaTraderFile('trades', event)} style={{ color: C.text, fontSize: 11, width: '100%' }} />
                </label>
              </div>
            </>
          )}

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

          {importSource === 'generic' && status === 'ready' && rows.length > 0 && (
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

          {importSource === 'ninjatrader' && ninjaInspection && status !== 'done' && (
            <div>
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, marginBottom: 10 }}>
                <div style={{ color: C.dim, fontSize: 10, marginBottom: 4, fontWeight: 600 }}>Discovered source accounts:</div>
                <div style={{ color: C.text, fontSize: 11, marginBottom: 8 }}>{ninjaInspection.sourceAccounts.join(', ') || 'None'}</div>
                <div style={{ color: C.dim, fontSize: 10, marginBottom: 4, fontWeight: 600 }}>Discovered instruments:</div>
                <div style={{ color: C.text, fontSize: 11 }}>{ninjaInspection.instruments.join(', ') || 'None'}</div>
              </div>

              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, marginBottom: 10 }}>
                <div style={{ color: C.dim, fontSize: 10, marginBottom: 8, fontWeight: 600 }}>Account mapping:</div>
                {ninjaInspection.sourceAccounts.map((sourceAccount) => (
                  <label key={sourceAccount} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center', marginBottom: 6, color: C.text, fontSize: 11 }}>
                    <span>{sourceAccount}</span>
                    <select value={accountMap[sourceAccount] ?? ''} onChange={(event) => setAccountMap((current) => ({ ...current, [sourceAccount]: event.target.value }))} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: '6px 8px', fontSize: 11 }}>
                      <option value="">Select an active account</option>
                      {currentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                    </select>
                  </label>
                ))}
              </div>

              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: C.text, fontSize: 11, background: `${C.gold}15`, border: `1px solid ${C.gold}44`, borderRadius: 7, padding: '8px 12px', marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={timezoneAcknowledged} onChange={(event) => setTimezoneAcknowledged(event.target.checked)} />
                NinjaTrader timestamps are imported exactly as written and are assumed to already be New York local time, with no timezone or DST conversion.
              </label>

              <button disabled={ninjaImportDisabled} onClick={doNinjaTraderImport} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontSize: 13, fontWeight: 700, cursor: ninjaImportDisabled ? 'not-allowed' : 'pointer', opacity: ninjaImportDisabled ? 0.5 : 1, width: '100%' }}>
                Import NinjaTrader Trades
              </button>
            </div>
          )}

          {importSource === 'generic' && status === 'done' && (
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
