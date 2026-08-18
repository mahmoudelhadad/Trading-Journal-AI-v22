import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@components/ui/Card.js';
import { HistoricalImportPanel, ReplayChart, ReplayControls, ReplayTimeReadout, ReplayTradingPanel } from '@components/replay/index.js';
import { ReplayWorkspace } from '@components/replay/ReplayWorkspace.js';
import { ReplayQuickTrade } from '@components/replay/ReplayQuickTrade.js';
import { ReplayContextMenu } from '@components/replay/ReplayContextMenu.js';
import { ReplayToolbar } from '@components/replay/ReplayToolbar.js';
import { deriveReplayOverlay, resolveOverlayEligibility } from '@calculations/replayOverlay.js';
import {
  isStepBackEnabled, lastRevealedClose, roundPriceToTick, selectBarTargetCursor,
} from '@calculations/replayWorkspace.js';
import { useReplayWorkspace, type ResolvedNavTransition } from '@hooks/useReplayWorkspace.js';
import { getFuturesInstrument } from '@constants/futuresInstruments.js';
import { normalizeExpiry } from '@services/ninjaTraderHistoricalAdapter.js';
import { COLORS as C } from '@constants/lists.js';
import type { HistoricalRoot } from '@apptypes/marketData.js';
import type { ReplayImportRequest, ReplayImportResult, ReplaySnapshot, ReplaySpeed, ReplayTimeframe } from '@apptypes/replay.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

export interface ReplayPageProps {
  snapshot: ReplaySnapshot;
  actions: {
    selectSeries(series: { root: HistoricalRoot; expiryYear: number; expiryMonth: number; timeframe: '1m' }): void;
    setTimeframe(timeframe: ReplayTimeframe): boolean; setSpeed(speed: ReplaySpeed): void;
    play(): void; pause(): void;
    /**
     * B2d Phase 7A — the runtime's navigation OUTCOME contract. Each of these
     * reports whether the requested navigation was applied and published, which
     * is what lets this page record history on success instead of on intent. It
     * never means storage is healthy, execution is allowed or a session is
     * mutable; those authorities are unchanged and live elsewhere.
     */
    goTo(utcMs: number): Promise<boolean>;
    stepForward(): Promise<boolean>;
    /** Released Phase-2 navigation authority; the page never computes its target. */
    stepBackward(): Promise<boolean>;
    importNinjaTrader(request: ReplayImportRequest): Promise<ReplayImportResult>;
  };
  sessions: ReplaySessionsState;
}

/**
 * Application-level Focus layer. Never the browser Fullscreen API.
 *
 * B2d Phase 9A — STACKING OWNERSHIP. The released app header is
 * `position: sticky; z-index: 100`, so the previous value of 10 let the header
 * paint over the focused layer: it covered the top of the chart and the entire
 * Quick Trade bar, making those controls unclickable while focused.
 *
 * 110 is the smallest value that clears the header while staying BELOW every
 * released overlay that must remain reachable from Focus — the account menu
 * (200), Modal (300) and ConfirmDialog (400). Focus owns its stacking locally;
 * no global stacking value is changed.
 */
export const FOCUS_LAYER_Z_INDEX = 110;

const FOCUS_LAYER = {
  position: 'fixed', inset: 0, zIndex: FOCUS_LAYER_Z_INDEX, background: C.bg,
  overflow: 'hidden', padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
} as const;

export function ReplayPage({ snapshot, actions, sessions }: ReplayPageProps) {
  const selectSeries = (root: HistoricalRoot, expiryText: string) => {
    const expiry = normalizeExpiry(expiryText);
    if (expiry !== null) actions.selectSeries({ root, ...expiry, timeframe: '1m' });
  };
  /*
   * B2d Phase 3 — the chart overlay composition boundary.
   *
   * The page supplies the two real inputs (the active session and the runtime
   * snapshot) and nothing else: eligibility, marker classification, anchors and
   * the basis/stop values are all derived by `@calculations/replayOverlay.js`, so
   * no overlay rule is restated in React and markers can never disagree with
   * lines about readiness.
   */
  const renderedBarTimes = useMemo(() => new Set(snapshot.bars.map((bar) => bar.t)), [snapshot.bars]);
  const eligibility = useMemo(
    () => resolveOverlayEligibility(sessions.activeSession, snapshot), [sessions.activeSession, snapshot]);
  const overlay = useMemo(
    () => deriveReplayOverlay(eligibility, sessions.projection, snapshot.timeframe, renderedBarTimes),
    [eligibility, sessions.projection, snapshot.timeframe, renderedBarTimes]);
  // B2d Phase 4 — one shared Order Quantity / Initial Stop for the whole
  // workspace. Transient UI text: nothing here is parsed, executed or persisted.
  const workspace = useReplayWorkspace();
  /*
   * B2d Phase 6B — NAVIGATION Undo / Redo.
   *
   * Two action surfaces exist, and the distinction is load-bearing:
   *   `actions`     RAW released runtime actions.
   *   `navActions`  the same interface, wrapped so a USER navigation records the
   *                 state being left behind — see the Phase-7A note below for
   *                 exactly when.
   * Undo and Redo apply their resolved target through the RAW actions, so
   * replaying history can never append to it. Only a cursor and a display
   * timeframe are ever recorded, so no execution, action, trade or session state
   * can structurally enter the stack.
   *
   * B2d Phase 7A — RECORD ON SUCCESS, CONSUME ON SUCCESS.
   *
   * The pre-command state is still what gets recorded; what changed is WHEN.
   * Every wrapper captures the state being left behind, issues the raw command,
   * and records that captured value only once the runtime reports the
   * navigation actually applied. A Step Forward at the end of the data, a Go To
   * onto unavailable history and a rejected timeframe change therefore leave no
   * frame behind, and no bar or boundary rule is restated here to know that.
   */
  const recordNavState = workspace.recordNavState;
  const readNavGeneration = workspace.readNavGeneration;
  const commitNavTransition = workspace.commitNavTransition;
  const clearNavHistory = workspace.clearNavHistory;
  const [applyingHistory, setApplyingHistory] = useState(false);
  const applyingRef = useRef(false);          // serializes history application
  const prePlayCaptured = useRef(false);
  const currentNavState = useCallback(
    () => ({ cursorUtcMs: snapshot.nowUtcMs, displayTimeframe: snapshot.timeframe }),
    [snapshot.nowUtcMs, snapshot.timeframe]);

  // One pre-play checkpoint per explicit playback run; frames are never history.
  useEffect(() => { if (snapshot.playState !== 'playing') prePlayCaptured.current = false; },
    [snapshot.playState]);

  /**
   * Runs one asynchronous navigation command and records the state it moved
   * away from, but only if it moved. The generation captured up front is what
   * stops a slow success from re-seeding history into a navigation context that
   * was legitimately cleared while the command was in flight.
   */
  const recordOnSuccess = async (command: () => Promise<boolean>): Promise<boolean> => {
    const previous = currentNavState();       // PRE-command: never the state it lands on
    const generation = readNavGeneration();
    const applied = await command();
    if (applied) recordNavState(previous, generation);
    return applied;
  };

  const navActions: ReplayPageProps['actions'] = {
    ...actions,                               // pause, speed and the rest stay raw
    goTo: (utcMs: number) => utcMs === snapshot.nowUtcMs
      ? actions.goTo(utcMs)                   // known no-op adds nothing
      : recordOnSuccess(() => actions.goTo(utcMs)),
    stepForward: () => recordOnSuccess(() => actions.stepForward()),
    stepBackward: () => recordOnSuccess(() => actions.stepBackward()),
    setTimeframe: (timeframe: ReplayTimeframe) => {
      if (timeframe === snapshot.timeframe) return actions.setTimeframe(timeframe);
      const previous = currentNavState();
      const applied = actions.setTimeframe(timeframe);
      if (applied) recordNavState(previous);  // synchronous: no in-flight window to guard
      return applied;
    },
    play: () => {
      if (snapshot.playState !== 'playing' && !prePlayCaptured.current) {
        recordNavState(currentNavState());
        prePlayCaptured.current = true;       // a duplicate Play in the same run adds nothing
      }
      actions.play();
    },
  };

  /*
   * B2d Phase 7A — the history TRANSACTION.
   *
   * A resolved transition is applied through the RAW actions first and consumed
   * only if the whole target actually landed. A failed application therefore
   * leaves that Undo (or Redo) exactly where it was, instead of spending a frame
   * on navigation that never happened.
   *
   * Atomicity across the two-command cross-timeframe case is explicit: the
   * display timeframe is restored when the cursor half fails, so the workspace
   * navigation state that history still describes is the one the user is
   * actually left in. The restore is skipped when the navigation context has
   * since changed — the history it belonged to has already been cleared, and
   * re-imposing a previous context's timeframe would be the stale write this
   * phase exists to prevent.
   */
  const applyNavTransition = async (resolved: ResolvedNavTransition) => {
    setApplyingHistory(true);
    try {
      const target = resolved.transition.state;
      const generation = readNavGeneration();
      const previousTimeframe = snapshot.timeframe;
      // Timeframe first, and only when it actually differs, so the smallest
      // truthful command sequence reaches the released runtime.
      if (target.displayTimeframe !== previousTimeframe
        && !actions.setTimeframe(target.displayTimeframe)) return;   // nothing applied, nothing consumed
      if (!await actions.goTo(target.cursorUtcMs)) {
        if (target.displayTimeframe !== previousTimeframe && readNavGeneration() === generation) {
          actions.setTimeframe(previousTimeframe);   // raw: a restore is not a navigation
        }
        return;
      }
      commitNavTransition(resolved);          // stale descriptors are a no-op
    } finally {
      applyingRef.current = false;            // the guard always releases
      setApplyingHistory(false);
    }
  };
  const runHistory = (resolve: () => ResolvedNavTransition | null) => {
    if (applyingRef.current) return;          // a pending apply owns the stack
    applyingRef.current = true;
    const resolved = resolve();
    if (resolved === null) { applyingRef.current = false; return; }
    // The runtime owns every user-visible navigation error; an unexpected
    // rejection must still not escape as an unhandled promise.
    void applyNavTransition(resolved).catch(() => {});
  };
  const undoNavigation = () => runHistory(() => workspace.resolveUndoNavigation(currentNavState()));
  const redoNavigation = () => runHistory(() => workspace.resolveRedoNavigation(currentNavState()));

  /*
   * History belongs to ONE replay navigation context. A different active session
   * (including none — which is also how the released controller expresses an
   * owner change: it bumps its owner generation and nulls the active session), a
   * different futures series contract, or an import replacing the market data
   * all invalidate it. A display-timeframe change does NOT: that is itself an
   * undoable navigation. Focus, dock/float, drag and form edits do not either.
   */
  const activeSessionId = sessions.activeSession?.sessionId ?? null;
  const seriesKey = `${snapshot.series.root}:${snapshot.series.expiryYear}:`
    + `${snapshot.series.expiryMonth}:${snapshot.series.timeframe}`;
  useEffect(() => { clearNavHistory(); }, [clearNavHistory, activeSessionId, seriesKey]);
  useEffect(() => { if (snapshot.importing) clearNavHistory(); }, [clearNavHistory, snapshot.importing]);
  /*
   * B2d Phase 5 — chart trading surfaces.
   *
   * The page orchestrates; it computes no trading rule of its own. The advisory
   * readout, the tick normalization and the Go-To target all come from pure
   * helpers, the tick size from the released futures instrument authority, and
   * every execution stays inside the released `sessions` command path.
   */
  const advisoryClose = useMemo(() => lastRevealedClose(snapshot.bars), [snapshot.bars]);
  const contextRequest = workspace.contextRequest;
  const closeContextRequest = workspace.closeContextRequest;
  // The menu is anchored to one chart state; a series, timeframe or bar-window
  // change makes its resolved price and bar meaningless, so it closes.
  useEffect(() => { closeContextRequest(); },
    [closeContextRequest, snapshot.series, snapshot.timeframe, snapshot.bars]);
  const contextPriceText = contextRequest?.price === null || contextRequest === null
    ? null
    : String(roundPriceToTick(contextRequest.price, getFuturesInstrument(snapshot.series.root).tickSize)
      ?? contextRequest.price);
  const useClickedPriceAsStop = (price: number) => {
    const normalized = roundPriceToTick(price, getFuturesInstrument(snapshot.series.root).tickSize);
    // FORM TEXT ONLY — no action, no repository write, no runtime fill.
    if (normalized !== null) workspace.setInitialStopText(String(normalized));
  };
  const goToClickedBar = (barStartUtcMs: number) => {
    // The same wrapped Go-To the released controls use, so a context-menu jump
    // is undoable like any other navigation.
    void navActions.goTo(selectBarTargetCursor(barStartUtcMs, snapshot.timeframe, snapshot.nowUtcMs));
  };
  /*
   * B2d Phase 6A — workspace controls.
   *
   * Select Bar is navigation only: the chart reports a rendered bar's start, the
   * pure helper turns it into a cursor (already clamped so it can never exceed
   * the current cursor), and the released Go-To action applies it. Step Backward
   * delegates straight to the runtime, which owns the predecessor algorithm.
   * Both go through `navActions`, so each move records the state it navigated
   * away from and is undoable; the history stack is never touched directly here.
   */
  const focusMode = workspace.focusMode;
  const closeSelectBar = workspace.closeSelectBar;
  const closeFocusMode = workspace.closeFocusMode;
  const barsEmpty = snapshot.bars.length === 0;
  // The pending selection belongs to one chart context; a series, timeframe,
  // import, error or emptied-chart transition invalidates it.
  useEffect(() => { closeSelectBar(); },
    [closeSelectBar, snapshot.series, snapshot.timeframe, snapshot.importing, snapshot.error, barsEmpty]);
  const selectRenderedBar = (barStartUtcMs: number) => {
    void navActions.goTo(selectBarTargetCursor(barStartUtcMs, snapshot.timeframe, snapshot.nowUtcMs));
    closeSelectBar();                       // one selection, then the mode exits
  };
  // Escape leaves Focus — but the context menu owns the FIRST Escape, so a menu
  // that is still open swallows it and Focus survives that key event.
  useEffect(() => {
    if (!focusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || contextRequest !== null) return;
      closeFocusMode();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusMode, contextRequest, closeFocusMode]);
  /*
   * The element tree below keeps every slot in a STABLE position across a Focus
   * toggle — the header and import card are hidden with style rather than
   * removed — so the chart, its marker plugin, the quick-trade controls and the
   * detailed panel are never unmounted and no runtime reattach occurs.
   */
  return <div style={focusMode ? FOCUS_LAYER : { padding: 16 }} data-replay-focus-layer={focusMode ? '' : undefined}>
    <div style={focusMode ? { display: 'none' } : undefined}>
      <h2 style={{ color: C.white, marginTop: 0 }}>Historical Replay</h2>
      <Card><HistoricalImportPanel snapshot={snapshot} onSeries={selectSeries} onImport={actions.importNinjaTrader} /></Card>
    </div>
    {snapshot.error && <div role="alert" style={{ color: C.red }}>{snapshot.error}</div>}
    {/* Phase 4 — chart-first workspace. The page owns the shared workspace form
        state; the layout component owns only where the two regions sit. Phase 5
        adds the quick-trade overlay inside the chart slot and supplies the
        chart's context-request consumer, so right-click now opens the safe
        custom menu instead of the browser's. Phase 6A adds Select Bar and the
        focus-fill chart height. */}
    <ReplayWorkspace focusMode={focusMode}
      chart={<Card padding={0} style={focusMode ? { height: '100%', marginBottom: 0 } : undefined}>
        <div style={{ position: 'relative', height: focusMode ? '100%' : undefined }}>
          <ReplayChart bars={snapshot.bars} overlay={overlay} onContextRequest={workspace.openContextRequest}
            selectBarActive={workspace.selectBarActive} onSelectBar={selectRenderedBar} fillHeight={focusMode} />
          <ReplayQuickTrade sessions={sessions}
            orderQuantityText={workspace.orderQuantityText}
            onOrderQuantityTextChange={workspace.setOrderQuantityText}
            initialStopText={workspace.initialStopText}
            lastRevealedClose={advisoryClose} />
        </div></Card>}
      tradingPanel={<Card><ReplayTradingPanel sessions={sessions}
        orderQuantityText={workspace.orderQuantityText}
        onOrderQuantityTextChange={workspace.setOrderQuantityText}
        initialStopText={workspace.initialStopText}
        onInitialStopTextChange={workspace.setInitialStopText} /></Card>} />
    {/* The released controls and readout live here now — exactly one instance of
        each, unchanged, with their released handlers. */}
    <ReplayToolbar
      timeReadout={<ReplayTimeReadout nowUtcMs={snapshot.nowUtcMs} />}
      controls={<ReplayControls snapshot={snapshot} onPlay={navActions.play} onPause={actions.pause}
        onStep={navActions.stepForward} onSpeed={actions.setSpeed} onTimeframe={navActions.setTimeframe}
        onGoTo={navActions.goTo} />}
      stepBackEnabled={isStepBackEnabled(snapshot, sessions.safetyBlocked)}
      onStepBackward={() => { void navActions.stepBackward(); }}
      undoEnabled={workspace.canUndoNavigation && !applyingHistory}
      redoEnabled={workspace.canRedoNavigation && !applyingHistory}
      onUndo={undoNavigation} onRedo={redoNavigation}
      selectBarActive={workspace.selectBarActive} onToggleSelectBar={workspace.toggleSelectBar}
      focusMode={focusMode} onToggleFocusMode={workspace.toggleFocusMode}
      mode={workspace.toolbarMode} onModeChange={workspace.setToolbarMode}
      position={workspace.toolbarPosition} onPositionChange={workspace.setToolbarPosition} />
    {contextRequest !== null && <ReplayContextMenu request={contextRequest} sessions={sessions}
      orderQuantityText={workspace.orderQuantityText} initialStopText={workspace.initialStopText}
      priceText={contextPriceText} onUseAsInitialStop={useClickedPriceAsStop}
      onGoToBar={goToClickedBar} onClose={closeContextRequest} />}
  </div>;
}
