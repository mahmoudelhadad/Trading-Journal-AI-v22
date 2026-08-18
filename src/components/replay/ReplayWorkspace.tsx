import type { ReactNode } from 'react';

/**
 * components/replay/ReplayWorkspace.tsx
 *
 * B2d Phase 4 — Replay workspace layout, and nothing else.
 *
 * Pure slots: this component receives two already-composed regions and owns only
 * where they sit. It never sees the runtime, the session repository, market data
 * or a projection, so it cannot acquire a second overlay derivation or a second
 * command path.
 *
 * The chart is the PRIMARY surface and takes the larger flexible share; the
 * detailed trading panel is secondary. `flexWrap` alone produces the responsive
 * behaviour — wide viewports put the panel beside the chart, narrow ones let it
 * fall below — so no global stylesheet, media query or breakpoint constant is
 * introduced. `minWidth: 0` on both regions keeps a wide child (the chart canvas)
 * from forcing horizontal page overflow.
 *
 * No toolbar, no Quick Trade, no context menu and no fixed/fullscreen mode exist
 * here; those belong to Phases 5 and 6.
 */
export interface ReplayWorkspaceProps {
  chart: ReactNode;
  tradingPanel: ReactNode;
  /**
   * B2d Phase 6A — Focus Mode. The chart region takes the whole workspace and
   * the panel region is hidden with style only: its child stays MOUNTED, so the
   * detailed panel's transient form state survives entering and leaving Focus.
   */
  focusMode?: boolean;
}

export function ReplayWorkspace({ chart, tradingPanel, focusMode = false }: ReplayWorkspaceProps) {
  return <div aria-label="Replay workspace" data-replay-workspace="" data-replay-focus={focusMode ? '' : undefined}
    style={{
      display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start',
      ...(focusMode ? { height: '100%', flexWrap: 'nowrap' as const, gap: 0 } : {}),
    }}>
    <section aria-label="Replay chart" data-replay-region="primary"
      style={focusMode ? { flex: '1 1 100%', minWidth: 0, height: '100%' } : { flex: '3 1 640px', minWidth: 0 }}>
      {chart}
    </section>
    {/* Hidden, never unmounted. */}
    <aside aria-label="Replay trading panel" data-replay-region="secondary"
      aria-hidden={focusMode ? true : undefined}
      style={focusMode
        ? { display: 'none' }
        : { flex: '1 1 320px', minWidth: 0 }}>{tradingPanel}</aside>
  </div>;
}
