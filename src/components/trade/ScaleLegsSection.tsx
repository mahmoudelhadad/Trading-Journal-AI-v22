/**
 * components/trade/ScaleLegsSection.tsx
 *
 * Manual Scale In / Scale Out — collapsible section inside TradeForm.
 *
 * Placement is FROZEN (RFC §4): directly below the
 * Entry Price / Stop Loss / Target / Exit Price row and directly above
 * the QUALITY & REVIEW section header.
 *
 * This component is a thin presentational shell. Every decision —
 * ordering, folding, weighted averages, candidate construction — lives
 * in calculations/scaleLegs.ts, and validation lives in
 * services/tradeValidation.ts. That split is deliberate: the project's
 * test harness is Node-only with no DOM (vitest.config.ts sets
 * `environment: 'node'`), so keeping the logic pure is what makes this
 * feature testable without adding a dependency.
 *
 * Visual language reuses the existing atoms and palette unchanged —
 * SectionHeader for the bar, Input for fields, COLORS for the accent.
 * Accent is C.green, tying Scale visually to POSITION & ENTRY, which
 * it extends.
 *
 * IMPORTANT: expansion state lives in this component's own useState and
 * is NEVER written onto the trade object. The manual save chain has no
 * field-projection step anywhere (TradeForm -> Raw.handleSave ->
 * useTrades -> JSON.stringify), so anything parked on the trade would
 * be persisted to storage verbatim. Expanding or collapsing the
 * section must not mutate the trade.
 */

import React, { useCallback, useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Input } from '@components/ui/Input.js';
import { SectionHeader } from '@components/ui/SectionHeader.js';
import {
  deriveAggregatesFromLegs,
  isImportedTrade,
  openQuantityText,
  scaleLegsReducer,
} from '@calculations/scaleLegs.js';
import type { ScaleLegsAction } from '@calculations/scaleLegs.js';
import type { RawTradeContent, TradeLeg } from '@apptypes/trade.js';

// ─── Types ───────────────────────────────────────────────────

export interface ScaleLegsSectionProps {
  trade:    RawTradeContent;
  onChange: (next: RawTradeContent) => void;
  /** First manual-scale validation message for the current draft, if any. */
  error?:   string | null;
}

// ─── Layout ──────────────────────────────────────────────────

const rowGrid: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: '58px 1fr 1fr 1fr 26px',
  gap:                 8,
  alignItems:          'center',
  marginBottom:        6,
};

const headGrid: React.CSSProperties = {
  ...rowGrid,
  marginBottom: 4,
};

const headCell: React.CSSProperties = {
  color:         C.dim,
  fontSize:      9,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const addButton = (color: string): React.CSSProperties => ({
  background:   `${color}22`,
  color,
  border:       `1px solid ${color}66`,
  borderRadius: 6,
  padding:      '4px 12px',
  fontSize:     11,
  fontWeight:   700,
  cursor:       'pointer',
  fontFamily:   'inherit',
});

const dash = (value: string): string => (value === '' ? '—' : value);

// ─── Component ───────────────────────────────────────────────

export function ScaleLegsSection({ trade, onChange, error }: ScaleLegsSectionProps) {
  const legs: TradeLeg[] = Array.isArray(trade.legs) ? trade.legs : [];
  const imported = isImportedTrade(trade);

  // Auto-expanded when the trade already carries legs (a saved manual
  // scaled trade, or an imported one) — there is something to see, and
  // the read-only aggregates above would otherwise look inexplicable.
  // Collapsed by default for an ordinary legless trade, so a trader who
  // does not scale sees essentially the previous simple form.
  const [expanded, setExpanded] = useState<boolean>(() => legs.length > 0);

  const dispatch = useCallback((action: ScaleLegsAction) => {
    onChange(scaleLegsReducer(trade, action));
  }, [onChange, trade]);

  // EDITING ORDER IS STABLE. Visible rows are NEVER reordered while the
  // user is editing: rows stay where they were added, and changing a
  // quantity, price or time never moves another row.
  //
  // This previously re-sorted on blur, which made rows visibly jump
  // mid-entry. Combined with index-based row keys, React kept focus on
  // the same DOM node while the underlying leg changed beneath it, so a
  // user could find themselves typing into an already-filled row.
  //
  // Chronological order is still authoritative for correctness — it is
  // just computed on a COPY (`canonicalLegOrder` returns `[...legs]
  // .sort(...)`) by validation, folding and aggregate derivation, and
  // applied for real only by `buildScaledTradeCandidate` at save time.
  // So the persisted contract is unchanged and reopening a saved trade
  // naturally shows canonical order.

  const isFuturesMarket = trade.market === 'futures';
  const qtyLabel = isFuturesMarket ? 'Contracts' : 'Lots';

  // Written already-uppercased so the literal frozen wording is the real
  // text content. SectionHeader's `textTransform: 'uppercase'` is a CSS
  // presentation rule — it would leave the underlying text lowercase.
  const legCount = legs.length ? ` · ${legs.length} legs` : '';
  const headerLabel = expanded
    ? `▾ SCALE IN / OUT${legCount}`
    : `▸ SCALE IN / OUT${legs.length ? legCount : ' (Optional)'}`;

  // Imported trades show the aggregates the importer reconciled against
  // the broker's own Trades file — never a recomputation, which could
  // silently disagree with reconciled broker truth.
  const derived = imported
    ? {
      positionSize: trade.positionSize ?? '',
      entryPrice:   trade.entryPrice ?? '',
      exitPrice:    trade.exitPrice ?? '',
    }
    : deriveAggregatesFromLegs(legs);
  const openText = imported ? '' : openQuantityText(legs);

  return (
    <div>
      <div
        onClick={() => setExpanded((prev) => !prev)}
        style={{ cursor: 'pointer' }}
        data-testid="scale-legs-header"
      >
        <SectionHeader color={C.green} label={headerLabel} />
      </div>

      {expanded && (
        <div
          style={{
            border:       `1px solid ${C.border}`,
            borderRadius: 8,
            padding:      10,
            marginBottom: 8,
          }}
        >
          {imported && (
            <div style={{ color: C.dim, fontSize: 10, marginBottom: 8 }}>
              📥 Imported from NinjaTrader · read-only
            </div>
          )}

          {legs.length > 0 && (
            <div style={headGrid}>
              <span style={headCell} />
              <span style={headCell}>{qtyLabel}</span>
              <span style={headCell}>Price</span>
              <span style={headCell}>Time</span>
              <span style={headCell} />
            </div>
          )}

          {legs.map((leg, index) => {
            const entry = leg.kind === 'entry';
            const kindColor = entry ? C.green : C.red;
            return (
              <div
                key={index}
                style={{
                  ...rowGrid,
                  borderLeft:  `3px solid ${kindColor}`,
                  paddingLeft: 8,
                }}
              >
                {/* Text badge AND colored border — type is never conveyed by color alone. */}
                <span style={{ color: kindColor, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em' }}>
                  {entry ? 'ENTRY' : 'EXIT'}
                </span>

                {imported ? (
                  <>
                    <span style={{ color: C.text, fontSize: 11 }}>{leg.quantity}</span>
                    <span style={{ color: C.text, fontSize: 11 }}>{leg.price}</span>
                    <span style={{ color: C.text, fontSize: 11 }}>{leg.time}</span>
                    <span />
                  </>
                ) : (
                  <>
                    <Input
                      value={leg.quantity}
                      onChange={(value) => dispatch({ type: 'updateLeg', index, field: 'quantity', value })}
                      type="number"
                      step={isFuturesMarket ? 1 : 0.01}
                      placeholder={isFuturesMarket ? '1' : '0.01'}
                    />
                    <Input
                      value={leg.price}
                      onChange={(value) => dispatch({ type: 'updateLeg', index, field: 'price', value })}
                      type="number"
                      placeholder="0.00"
                    />
                    <Input
                      value={leg.time.slice(0, 5)}
                      onChange={(value) => dispatch({
                        type:  'updateLeg',
                        index,
                        field: 'time',
                        // 'HH:mm' from the native input, stored as 'HH:mm:00'.
                        // Two legs in the same minute legitimately share ':00';
                        // seconds are never fabricated to separate them.
                        value: value === '' ? '' : `${value}:00`,
                      })}
                      type="time"
                    />
                    <button
                      onClick={() => dispatch({ type: 'removeLeg', index })}
                      title="Remove leg"
                      style={{
                        background: 'none',
                        border:     'none',
                        color:      C.dim,
                        fontSize:   14,
                        cursor:     'pointer',
                        lineHeight: 1,
                        fontFamily: 'inherit',
                      }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {!imported && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={() => dispatch({ type: 'addEntry' })} style={addButton(C.green)}>
                + Add Entry
              </button>
              <button onClick={() => dispatch({ type: 'addExit' })} style={addButton(C.red)}>
                + Add Exit
              </button>
            </div>
          )}

          {legs.length > 0 && (
            <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 8 }}>
              {error ? (
                <div style={{ color: C.red, fontSize: 11 }}>⚠ {error}</div>
              ) : (
                <div style={{ color: C.text, fontSize: 11 }}>
                  {/* "Entry qty" — total entry-side transacted quantity, NOT peak
                      exposure. Never labelled "Max size": for
                      Entry 2 -> Exit 1 -> Entry 1 -> Exit 2 this reads 3 while
                      exposure never exceeded 2. */}
                  {`Entry qty ${dash(derived.positionSize)}`}
                  {!imported && ` · Open ${dash(openText)}`}
                  {` · Avg entry ${dash(derived.entryPrice)} · Avg exit ${dash(derived.exitPrice)}`}
                </div>
              )}
              <div style={{ color: C.dim, fontSize: 10, marginTop: 4 }}>
                {imported
                  ? 'Broker execution detail cannot be edited here.'
                  : 'Size, entry, exit and times above are set by these legs.'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
