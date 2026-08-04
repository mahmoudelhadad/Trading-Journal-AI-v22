/**
 * components/charts/chartTheme.ts
 *
 * Shared Recharts tooltip styling.
 * Copied VERBATIM from the original global constant:
 *
 *   var TT = { contentStyle:{background:"#1A2535",border:"1px solid #243350",
 *     color:"#C8D6E8",fontSize:10,borderRadius:6},
 *     labelStyle:{color:"#C8D6E8"}, itemStyle:{color:"#C8D6E8"} };
 *
 * Used by every chart in the Dashboard (and later Strategy) pages
 * that does not supply a fully custom tooltip content component.
 *
 * Phase 6 — Dashboard migration. No new styling introduced.
 */

export const TOOLTIP_STYLE = {
  contentStyle: {
    background:   '#1A2535',
    border:       '1px solid #243350',
    color:        '#C8D6E8',
    fontSize:     10,
    borderRadius: 6,
  },
  labelStyle: { color: '#C8D6E8' },
  itemStyle:  { color: '#C8D6E8' },
};
