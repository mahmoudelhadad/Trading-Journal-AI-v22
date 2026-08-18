import { useCallback, useRef, useState } from 'react';
import {
  EMPTY_NAV_HISTORY, REPLAY_FLOATING_SAFE_TOP_PX,
  canRedoNav, canUndoNav, pushNavState, redoNav, undoNav,
  type NavHistory, type NavTransition, type WorkspaceNavState,
} from '@calculations/replayWorkspace.js';

/**
 * hooks/useReplayWorkspace.ts
 *
 * B2d Phase 4 — workspace-level Replay form state.
 *
 * TRANSIENT UI TEXT ONLY. No parsing, no validation, no execution, no
 * persistence: nothing here reaches LocalStorage, IndexedDB, the session
 * repository or a BacktestSession field. The detailed Trading Panel and the
 * chart Quick Trade controls read the SAME values from here, so the two surfaces
 * cannot disagree about what the user typed.
 *
 * ── DELIBERATE UX CONSOLIDATION ────────────────────────────────
 * The released panel held two independent quantity states — one for the initial
 * Entry and one for Scale In. They are merged here into a single Order Quantity.
 * This is an intentional B2d UX change, not a behaviour-preserving refactor:
 * after entering Long with 3, the Scale In field now also reads 3 instead of
 * showing an independently stored value. Partial-exit quantity is deliberately
 * NOT merged; reducing a position is a different intention from opening or
 * adding to one, so it stays panel-local.
 *
 * ── STOP TEXT IS NOT THE EPISODE ANCHOR ────────────────────────
 * `initialStopText` is form text for a FLAT entry only. An open episode's stop
 * is immutable and lives in `projection.openAggregate.initialStopPrice`; Scale In
 * inherits that and must never read this text. The two can therefore legitimately
 * differ on screen, and that is not a defect.
 *
 * Scope beyond that shared text: context-menu state, Select Bar, Focus Mode,
 * toolbar dock mode and floating position, and the navigation Undo/Redo stack —
 * the complete transient workspace UI state for the Replay page.
 */
/**
 * One resolved right-click, as produced by the chart's own scales.
 *
 * Structurally identical to the Phase-3 `ReplayChartContextRequest`, and
 * deliberately declared here rather than imported: this hook stays free of any
 * chart-component dependency, and the two are assignable in both directions, so
 * `ReplayChart`'s callback can be wired straight to `openContextRequest`.
 */
export interface ReplayWorkspaceContextRequest {
  clientX: number;
  clientY: number;
  price: number | null;
  barStartUtcMs: number | null;
}

export interface ReplayWorkspaceState {
  /** Shared Order Quantity text — initial Entry, Scale In, and Quick Trade. */
  orderQuantityText: string;
  setOrderQuantityText: (text: string) => void;
  /** Shared Initial Stop text — used only while FLAT. */
  initialStopText: string;
  setInitialStopText: (text: string) => void;
  /** Open right-click request, or null when no context menu is showing. */
  contextRequest: ReplayWorkspaceContextRequest | null;
  openContextRequest: (request: ReplayWorkspaceContextRequest) => void;
  closeContextRequest: () => void;
  /** B2d Phase 6A — one pending bar selection; exits after a valid selection. */
  selectBarActive: boolean;
  toggleSelectBar: () => void;
  closeSelectBar: () => void;
  /** Application-level chart Focus Mode. Never the browser Fullscreen API. */
  focusMode: boolean;
  toggleFocusMode: () => void;
  closeFocusMode: () => void;
  toolbarMode: ReplayToolbarMode;
  setToolbarMode: (mode: ReplayToolbarMode) => void;
  toolbarPosition: ReplayToolbarPosition;
  setToolbarPosition: (position: ReplayToolbarPosition) => void;
  /**
   * B2d Phase 6B — NAVIGATION history only. The entry type carries a cursor and
   * a display timeframe and nothing else, so no execution, action, trade,
   * session revision or form value can structurally enter it.
   */
  navHistory: NavHistory;
  canUndoNavigation: boolean;
  canRedoNavigation: boolean;
  /**
   * Records where the user IS, before a navigation command moves them — and
   * only once that command has truthfully reported that it applied.
   *
   * `contextGeneration` is the value `readNavGeneration()` returned BEFORE the
   * command was issued. A record whose generation is stale is dropped: the
   * navigation context it belonged to was cleared while the command was still
   * in flight, and its pre-state describes a world that no longer exists.
   */
  recordNavState: (state: WorkspaceNavState, contextGeneration?: number) => void;
  /**
   * The navigation context generation. Bumped by `clearNavHistory` and by
   * nothing else, so a caller can tell whether the Replay navigation context it
   * started an asynchronous operation in is still the current one.
   */
  readNavGeneration: () => number;
  /**
   * Resolve one step WITHOUT consuming it. The pure module computes the target
   * and the resulting stacks; this hook stores neither until `commitNavTransition`
   * is called, so a navigation that never applies costs no history.
   */
  resolveUndoNavigation: (current: WorkspaceNavState) => ResolvedNavTransition | null;
  resolveRedoNavigation: (current: WorkspaceNavState) => ResolvedNavTransition | null;
  /**
   * Consume a previously resolved transition. Returns whether it was applied:
   * a stale descriptor is a deterministic no-op. The hook never navigates,
   * never touches the runtime, never reads bars and never persists.
   */
  commitNavTransition: (resolved: ResolvedNavTransition) => boolean;
  clearNavHistory: () => void;
}

/**
 * One resolved-but-not-yet-consumed Undo/Redo step.
 *
 * `historyVersion` is the history's mutation counter at resolve time. Any
 * mutation invalidates the descriptor — a `clearNavHistory` (session, series or
 * import context change) and an interleaved `recordNavState` alike — so a
 * commit can neither resurrect a cleared context's frames nor overwrite a
 * navigation that was recorded while this one was still being applied.
 */
export interface ResolvedNavTransition {
  transition: NavTransition;
  historyVersion: number;
}

export type ReplayToolbarMode = 'docked' | 'floating';

export interface ReplayToolbarPosition { x: number; y: number }

/**
 * Only used once Float is first chosen; the toolbar clamps it on measure. The Y
 * is the shared safe-top authority, so a first Float can never land the drag
 * handle under the Header. The released X is unchanged.
 */
const INITIAL_FLOATING_POSITION: ReplayToolbarPosition = { x: 24, y: REPLAY_FLOATING_SAFE_TOP_PX };

export function useReplayWorkspace(): ReplayWorkspaceState {
  // Released panel defaults: quantity '1', stop blank (blank means "no stop").
  const [orderQuantityText, setOrderQuantityText] = useState('1');
  const [initialStopText, setInitialStopText] = useState('');
  // Transient: a right-click is never persisted and clears with the workspace.
  const [contextRequest, setContextRequest] = useState<ReplayWorkspaceContextRequest | null>(null);
  const openContextRequest = useCallback((request: ReplayWorkspaceContextRequest) => {
    setContextRequest(request);
  }, []);
  const closeContextRequest = useCallback(() => { setContextRequest(null); }, []);
  // B2d Phase 6A — workstation UI state. Transient like everything else here:
  // a reload legitimately returns to docked, unfocused, Select Bar off.
  const [selectBarActive, setSelectBarActive] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [toolbarMode, setToolbarMode] = useState<ReplayToolbarMode>('docked');
  const [toolbarPosition, setToolbarPosition] = useState<ReplayToolbarPosition>(INITIAL_FLOATING_POSITION);
  const toggleSelectBar = useCallback(() => { setSelectBarActive((active) => !active); }, []);
  const closeSelectBar = useCallback(() => { setSelectBarActive(false); }, []);
  const toggleFocusMode = useCallback(() => { setFocusMode((focused) => !focused); }, []);
  const closeFocusMode = useCallback(() => { setFocusMode(false); }, []);
  /*
   * B2d Phase 6B — navigation history.
   *
   * Every stack rule (push, depth cap, redo invalidation, underflow) lives in
   * the frozen pure module; this hook only holds the value and hands the
   * resolved transition back to its caller. React restates none of it.
   */
  const [navHistory, setNavHistory] = useState<NavHistory>(EMPTY_NAV_HISTORY);
  /*
   * B2d Phase 7A — two transient counters, each with one job. Neither is state:
   * they are read at the exact moment an operation starts or finishes, never
   * rendered, so a stale render can never make a decision with an old value.
   *
   *   contextGeneration  the Replay navigation CONTEXT. Only a clear bumps it.
   *   historyVersion     any history mutation at all. Guards a deferred commit.
   */
  const contextGenerationRef = useRef(0);
  const historyVersionRef = useRef(0);
  const readNavGeneration = useCallback(() => contextGenerationRef.current, []);
  const recordNavState = useCallback((state: WorkspaceNavState, contextGeneration?: number) => {
    if (contextGeneration !== undefined && contextGeneration !== contextGenerationRef.current) return;
    historyVersionRef.current += 1;
    setNavHistory((history) => pushNavState(history, state));
  }, []);
  const resolveUndoNavigation = useCallback((current: WorkspaceNavState) => {
    const transition = undoNav(navHistory, current);
    return transition === null ? null : { transition, historyVersion: historyVersionRef.current };
  }, [navHistory]);
  const resolveRedoNavigation = useCallback((current: WorkspaceNavState) => {
    const transition = redoNav(navHistory, current);
    return transition === null ? null : { transition, historyVersion: historyVersionRef.current };
  }, [navHistory]);
  const commitNavTransition = useCallback((resolved: ResolvedNavTransition) => {
    if (resolved.historyVersion !== historyVersionRef.current) return false;
    historyVersionRef.current += 1;
    setNavHistory(resolved.transition.history);
    return true;
  }, []);
  const clearNavHistory = useCallback(() => {
    contextGenerationRef.current += 1;
    historyVersionRef.current += 1;
    setNavHistory(EMPTY_NAV_HISTORY);
  }, []);
  // Never reset on an open, a close, a Scale In, a Partial Exit or a session
  // change: the released panel did not remount in any of those transitions, so
  // the value simply lives as long as the mounted workspace.
  return {
    orderQuantityText, setOrderQuantityText, initialStopText, setInitialStopText,
    contextRequest, openContextRequest, closeContextRequest,
    selectBarActive, toggleSelectBar, closeSelectBar,
    focusMode, toggleFocusMode, closeFocusMode,
    toolbarMode, setToolbarMode, toolbarPosition, setToolbarPosition,
    navHistory,
    canUndoNavigation: canUndoNav(navHistory),
    canRedoNavigation: canRedoNav(navHistory),
    recordNavState, readNavGeneration,
    resolveUndoNavigation, resolveRedoNavigation, commitNavTransition, clearNavHistory,
  };
}
