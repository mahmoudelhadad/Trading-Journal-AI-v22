/**
 * components/charts/RatingGauge.tsx
 *
 * "⭐ Avg Personal Rating" gauge widget.
 *
 * Migrated VERBATIM from the original RatingGauge(props) function.
 *
 * ⚠️ PRESERVED BUG (see Migration Notes in Phase 6 report):
 * The original code has:
 *
 *   h("div", {...}, h("span","0"), h("span","1"), h("span","2"),
 *                    h("span","3"), h("span","4"), h("span","5"))
 *
 * `h("span","0")` is `React.createElement("span", "0")` — the SECOND
 * argument to createElement is the `props` object, not children. When
 * given a string, React iterates over its indices (`for...in` "0"
 * has one index) and reads `config["0"]` as an prop, producing an
 * invalid/no-op prop. NO third argument (children) is passed, so the
 * span renders with NO visible text. The "0 1 2 3 4 5" scale labels
 * NEVER actually appear in the original app.
 *
 * This migration reproduces the same VISUAL RESULT (empty, unlabeled
 * spans) rather than the exact broken call, since JSX cannot express
 * `createElement(type, "someString")` directly. The rendered DOM
 * output is identical: six empty <span> elements, no numbers shown.
 *
 * Per Phase 6 rule "do not fix any existing application bugs," this
 * behavior is preserved exactly, not corrected.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface RatingGaugeProps {
  /** Average personal rating, 0–5 */
  avg: number;
}

// ─── Component ───────────────────────────────────────────────

export function RatingGauge({ avg }: RatingGaugeProps) {
  const pct   = avg / 5;
  const barH  = 18;

  // Matches original: pct<0.3?C.red:pct<0.6?C.orange:pct<0.8?C.gold:C.green
  const color =
    pct < 0.3 ? C.red : pct < 0.6 ? C.orange : pct < 0.8 ? C.gold : C.green;

  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1 }}>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>
        ⭐ Avg Personal Rating
      </div>

      <div style={{ color, fontSize: 20, fontWeight: 800, marginBottom: 8 }}>
        {avg.toFixed(2)} / 5
      </div>

      <div
        style={{
          position:     'relative',
          height:       barH,
          borderRadius: barH / 2,
          overflow:     'hidden',
          background:
            'linear-gradient(to right, #EF4444 0%, #F97316 30%, #F59E0B 55%, #84CC16 80%, #22C55E 100%)',
        }}
      >
        <div
          style={{
            position:     'absolute',
            left:         `${Math.max(0, Math.min(pct * 100 - 1, 98))}%`,
            top:          0,
            width:        4,
            height:       '100%',
            background:   '#fff',
            borderRadius: 2,
            boxShadow:    '0 0 6px rgba(255,255,255,0.8)',
          }}
        />
      </div>

      {/* ⚠️ Scale labels 0–5: original bug means these render empty — preserved */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: C.dim, fontSize: 9 }}>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
