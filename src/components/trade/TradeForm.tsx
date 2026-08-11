/**
 * components/trade/TradeForm.tsx
 *
 * Add / Edit trade modal.
 *
 * Migrated VERBATIM from the original TradeForm(props) function.
 * Every field, every section, every grid layout, and the save/cancel
 * workflow is preserved except for the Phase 32C validation boundary. The underlying primitives were
 * swapped for the Phase 3 UI atoms (Select, Input, FormField,
 * SectionHeader, Modal) — visual output is identical.
 *
 * Original workflow (preserved exactly):
 *   1. Modal opens with either an empty trade (createEmptyTrade) or
 *      the trade being edited (props.trade).
 *   2. Market toggle (Forex/Futures) resets the symbol field when
 *      switched — matches original sm() function exactly.
 *   3. All fields update local state via a generic setter — matches
 *      original s(k) curried setter exactly.
 *   4. "💾 Save Trade" validates current-domain invariants before onSave(t).
 *   5. "Cancel" or clicking the backdrop calls onClose().
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same 39 fields, same order, same grid groupings
 * - Same section colors (blue/green/purple/teal/gold/blue)
 * - Same market-switch behavior (resets symbol)
 * - Same Account dropdown (native <select>, not the Select atom,
 *   because it lists account IDs with account.name as label —
 *   matches original inline <select> exactly)
 */

import React, { useState, useCallback } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { FX_SYMBOLS, FUT_SYMBOLS } from '@constants/symbols.js';
import { createEmptyTrade } from '@apptypes/trade.js';
import {
  toManualSaveMessage,
  validateManualScaleLegs,
  validateTradeContent,
} from '@services/tradeValidation.js';
import {
  buildScaledTradeCandidate,
  deriveAggregatesFromLegs,
  hasManualLegs,
} from '@calculations/scaleLegs.js';
import { ScaleLegsSection } from '@components/trade/ScaleLegsSection.js';
import { Modal } from '@components/ui/Modal.js';
import { Select } from '@components/ui/Select.js';
import { Input } from '@components/ui/Input.js';
import { FormField } from '@components/ui/FormField.js';
import { SectionHeader } from '@components/ui/SectionHeader.js';
import type { RawTradeContent } from '@hooks/useTrades.js';
import type { Account } from '@hooks/useAccounts.js';
import type { ListsState } from '@hooks/useLists.js';

// ─── Types ───────────────────────────────────────────────────

// RawTradeContent, not RawTrade — this form only ever reads/writes
// business fields (never sync metadata), for both a brand-new trade
// (genuinely has no sync identity yet) and an existing one being
// edited (its metadata rides along on the runtime object but this
// component has no reason to type or touch it). See pages/Raw.tsx's
// handleSave for where the edit path's original metadata is merged
// back in before calling updateTrade().
export interface TradeFormProps {
  /** Trade being edited, or undefined/null for a new trade */
  trade?:        RawTradeContent | null;
  accounts:      Account[];
  lists:         ListsState;
  /** Default account ID to pre-select for new trades */
  defaultAccId:  string;
  onSave:        (trade: RawTradeContent) => void;
  onClose:       () => void;
}

// ─── Layout style shortcuts — matches original g4/g3/g2 ───────
const g4: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 };
const g3: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 };
const g2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 };

// ─── Component ───────────────────────────────────────────────

export function TradeForm({
  trade,
  accounts,
  lists,
  defaultAccId,
  onSave,
  onClose,
}: TradeFormProps) {
  // Matches original: var init = props.trade || emptyT(props.defaultAccId)
  const [t, setT] = useState<RawTradeContent>(
    () => (trade ?? (createEmptyTrade(defaultAccId) as RawTradeContent)),
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  // Manual scale legs own five aggregate fields while they exist.
  // Imported trades are excluded: their legs are broker executions and
  // their aggregates were reconciled against the broker's own Trades
  // file, so nothing here recomputes or rewrites them.
  const scaled = hasManualLegs(t);
  // Live preview — the disabled aggregate inputs must show what the
  // CURRENT legs derive to, never a stale pre-scale value. This is
  // display only; handleSave re-derives and never trusts it.
  const preview = scaled ? deriveAggregatesFromLegs(t.legs ?? []) : null;
  const scaleErrors = scaled ? validateManualScaleLegs(t) : [];

  const handleSave = useCallback(() => {
    // FROZEN SAVE PIPELINE (RFC §14). The candidate that passes final
    // validation is the exact object handed to onSave — validating the
    // stale editable aggregates and deriving afterwards would persist
    // values that were never validated.
    //   1. manual leg invariants V1-V10, using canonical ordering
    //   2/3/4/5. canonicalize legs, apply the trade date to every leg,
    //            derive aggregates, construct the candidate
    //   6. validateTradeContent(candidate)
    //   7. onSave(candidate)
    // Trades with no legs, and imported trades, keep the v1.2 path
    // unchanged: buildScaledTradeCandidate returns them untouched.
    if (hasManualLegs(t)) {
      const legMessage = toManualSaveMessage(validateManualScaleLegs(t));
      if (legMessage) {
        setSaveError(legMessage);
        return;
      }
    }
    const candidate = buildScaledTradeCandidate(t);
    const message = toManualSaveMessage(validateTradeContent(candidate, accounts));
    if (message) {
      setSaveError(message);
      return;
    }
    setSaveError(null);
    onSave(candidate);
  }, [accounts, onSave, t]);

  // Generic field setter — matches original s(k) curried function
  const setField = useCallback(
    <K extends keyof RawTradeContent>(key: K) =>
      (value: RawTradeContent[K]) => {
        setT((prev) => ({ ...prev, [key]: value }));
      },
    [],
  );

  // Market switch — matches original sm(v): resets symbol on market change
  const setMarket = useCallback((market: string) => {
    setT((prev) => ({ ...prev, market, symbol: '' }));
  }, []);

  const symList = t.market === 'futures' ? FUT_SYMBOLS : FX_SYMBOLS;
  const mColor  = t.market === 'futures' ? C.orange : C.blue;

  return (
    <Modal onClose={onClose}>
      <div
        style={{
          background:   C.card,
          border:       `1px solid ${mColor}66`,
          borderRadius: 12,
          width:        '100%',
          maxWidth:     800,
          marginTop:    8,
          marginBottom: 20,
        }}
      >
        {/* ── Header: title + market toggle + close ────────── */}
        <div
          style={{
            padding:        '12px 18px',
            borderBottom:   `1px solid ${C.border}`,
            display:        'flex',
            justifyContent: 'space-between',
            alignItems:     'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>
              {trade ? 'Edit Trade' : 'New Trade'}
            </span>

            <div style={{ display: 'flex', gap: 4 }}>
              {(['forex', 'futures'] as const).map((m) => {
                const active = t.market === m;
                const mc = m === 'futures' ? C.orange : C.blue;
                return (
                  <button
                    key={m}
                    onClick={() => setMarket(m)}
                    style={{
                      background:   active ? `${mc}22` : 'none',
                      color:        active ? mc : C.dim,
                      border:       `1px solid ${active ? mc : C.border}`,
                      borderRadius: 6,
                      padding:      '3px 12px',
                      fontSize:     11,
                      fontWeight:   700,
                      cursor:       'pointer',
                      fontFamily:   'inherit',
                    }}
                  >
                    {m === 'forex' ? '📈 Forex' : '📊 Futures'}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'none',
              border:     'none',
              color:      C.dim,
              fontSize:   22,
              cursor:     'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* ── Body: scrollable form ─────────────────────────── */}
        <div style={{ padding: 14, maxHeight: '80vh', overflowY: 'auto' }}>
          <SectionHeader color={mColor} label="Trade Info" />
          <div style={g4}>
            <FormField label="Symbol">
              <Select value={t.symbol} onChange={setField('symbol')} options={symList} />
            </FormField>
            <FormField label="Date">
              <Input value={t.date} onChange={setField('date')} type="date" />
            </FormField>
            <FormField label="Account">
              {/* Native select — lists account IDs with account.name label, matches original exactly */}
              <select
                value={t.accountId}
                onChange={(e) => setField('accountId')(e.target.value)}
                style={{
                  width: '100%', background: C.bg, color: C.text,
                  border: `1px solid ${C.border}`, borderRadius: 6,
                  padding: '5px 8px', fontSize: 11,
                }}
              >
                <option value="">— Select —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Account Type">
              <Select value={t.account} onChange={setField('account')} options={lists.Account || []} />
            </FormField>
          </div>

          <div style={g4}>
            <FormField label="Broker">
              <Select value={t.broker} onChange={setField('broker')} options={lists.Broker || []} />
            </FormField>
            <FormField label="Session">
              <Select value={t.session} onChange={setField('session')} options={lists.Session || []} />
            </FormField>
            <FormField label="Day/Swing">
              <Select value={t.daySwing} onChange={setField('daySwing')} options={lists.DaySwing || []} />
            </FormField>
            <FormField label="Daily Setup">
              <Select value={t.dailySetup} onChange={setField('dailySetup')} options={lists.DailySetup || []} />
            </FormField>
          </div>

          <div style={g4}>
            <FormField label="Liquidity">
              <Select value={t.liquidity} onChange={setField('liquidity')} options={lists.Liquidity || []} />
            </FormField>
            <FormField label="Entry Setup">
              <Select value={t.entrySetup} onChange={setField('entrySetup')} options={lists.EntrySetup || []} />
            </FormField>
            <FormField label="IntraDay Setup">
              <Select value={t.intraDaySetup} onChange={setField('intraDaySetup')} options={lists.IntraDaySetup || []} />
            </FormField>
            <FormField label="IntraDay TF">
              <Select value={t.intraDayTF} onChange={setField('intraDayTF')} options={lists.IntraDayTF || []} />
            </FormField>
          </div>

          <FormField label="Link to Chart">
            <Input value={t.linkToChart} onChange={setField('linkToChart')} placeholder="https://..." />
          </FormField>

          <SectionHeader color={C.green} label="Position & Entry" />
          <div style={g4}>
            <FormField label="Direction">
              <Select value={t.direction} onChange={setField('direction')} options={lists.Direction || []} />
            </FormField>
            <FormField label={t.market === 'futures' ? 'Contracts' : 'Lots'}>
              <Input
                value={preview ? preview.positionSize : t.positionSize}
                onChange={setField('positionSize')}
                type="number"
                placeholder="1"
                disabled={scaled}
              />
            </FormField>
            <FormField label="Entry Time">
              <Input
                value={preview ? preview.entryTime : t.entryTime}
                onChange={setField('entryTime')}
                type="time"
                disabled={scaled}
              />
            </FormField>
            <FormField label="Exit Time">
              <Input
                value={preview ? preview.exitTime : t.exitTime}
                onChange={setField('exitTime')}
                type="time"
                disabled={scaled}
              />
            </FormField>
          </div>

          <div style={g4}>
            <FormField label="Entry Price">
              <Input
                value={preview ? preview.entryPrice : t.entryPrice}
                onChange={setField('entryPrice')}
                type="number"
                placeholder="0.00"
                disabled={scaled}
              />
            </FormField>
            <FormField label="Stop Loss">
              <Input value={t.stopLoss} onChange={setField('stopLoss')} type="number" placeholder="0.00" />
            </FormField>
            <FormField label="Target">
              <Input value={t.target} onChange={setField('target')} type="number" placeholder="0.00" />
            </FormField>
            <FormField label="Exit Price">
              <Input
                value={preview ? preview.exitPrice : t.exitPrice}
                onChange={setField('exitPrice')}
                type="number"
                placeholder="0.00"
                disabled={scaled}
              />
            </FormField>
          </div>

          {/* FROZEN LOCATION (RFC §4): directly below the Entry Price /
              Stop Loss / Target / Exit Price row, directly above
              QUALITY & REVIEW. Collapsed by default for a legless trade. */}
          <ScaleLegsSection
            trade={t}
            onChange={setT}
            error={scaleErrors.length ? scaleErrors[0] : null}
          />

          <SectionHeader color={C.purple} label="Quality & Review" />
          <div style={g4}>
            <FormField label="Commission ($)">
              <Input value={t.commission} onChange={setField('commission')} type="number" placeholder="0.00" />
            </FormField>
            <FormField label="Setup Type">
              <Select value={t.setupType} onChange={setField('setupType')} options={lists.SetupType || []} />
            </FormField>
            <FormField label="Rating">
              <Select value={t.personalRating} onChange={setField('personalRating')} options={lists.Rating || []} />
            </FormField>
            <FormField label="Plan Followed">
              <Select value={t.planFollowed} onChange={setField('planFollowed')} options={lists.PlanFollowed || []} />
            </FormField>
          </div>

          <div style={g2}>
            <FormField label="Emotions">
              <Select value={t.emotions} onChange={setField('emotions')} options={lists.Emotions || []} />
            </FormField>
            <FormField label="Notes">
              <Input value={t.notes} onChange={setField('notes')} placeholder="Notes..." />
            </FormField>
          </div>

          <FormField label="Error">
            <Input value={t.error} onChange={setField('error')} placeholder="Describe any mistake..." />
          </FormField>

          <SectionHeader color={C.teal} label="Max R" />
          <div style={g2}>
            <FormField label="Be SL (best R before SL hit)">
              <Input value={t.beSL} onChange={setField('beSL')} type="number" placeholder="e.g. 1.5" />
            </FormField>
            <FormField label="Af SL (best R after SL hit)">
              <Input value={t.afSL} onChange={setField('afSL')} type="number" placeholder="e.g. -0.5" />
            </FormField>
          </div>

          <SectionHeader color={C.gold} label="SL Study" />
          <div style={g3}>
            <FormField label="SL 1">
              <Input value={t.sl1} onChange={setField('sl1')} type="number" placeholder="e.g. 1.2" />
            </FormField>
            <FormField label="SL 2">
              <Input value={t.sl2} onChange={setField('sl2')} type="number" placeholder="e.g. 0.8" />
            </FormField>
            <FormField label="SL 3">
              <Input value={t.sl3} onChange={setField('sl3')} type="number" placeholder="e.g. 2.0" />
            </FormField>
          </div>

          <SectionHeader color={C.blue} label="Trade Management R" />
          <div style={g3}>
            {(['tm1', 'tm2', 'tm3', 'tm4', 'tm5', 'tm6'] as const).map((k, i) => (
              <FormField key={k} label={`TM ${i + 1}`}>
                <Input value={t[k]} onChange={setField(k)} type="number" />
              </FormField>
            ))}
          </div>

          {/* ── Footer: save / cancel ───────────────────────── */}
          <div
            style={{
              display:      'flex',
              gap:          10,
              marginTop:    14,
              paddingTop:   14,
              borderTop:    `1px solid ${C.border}`,
            }}
          >
            {saveError && (
              <div style={{ color: C.red, fontSize: 11, alignSelf: 'center' }}>{saveError}</div>
            )}
            <button
              onClick={handleSave}
              style={{
                background:   mColor,
                color:        '#fff',
                border:       'none',
                borderRadius: 8,
                padding:      '9px 22px',
                fontSize:     13,
                fontWeight:   700,
                flex:         1,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              💾 Save Trade
            </button>
            <button
              onClick={onClose}
              style={{
                background:   C.border,
                color:        C.text,
                border:       'none',
                borderRadius: 8,
                padding:      '9px 14px',
                fontSize:     12,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
