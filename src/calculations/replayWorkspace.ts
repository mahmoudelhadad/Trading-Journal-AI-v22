/**
 * calculations/replayWorkspace.ts
 *
 * B2d Phase 1 — pure Replay workspace calculations.
 *
 * No React, no DOM, no chart, no persistence. This module owns only the
 * workspace logic that would otherwise be duplicated across the toolbar, the
 * quick-trade controls and the context menu. Every value here is transient:
 * nothing in this file is written anywhere.
 *
 * It deliberately does NOT own Step Backward target selection. That algorithm
 * lives once, in `replayStepBack.ts`, and is consumed by the runtime (Phase 2).
 * What lives here is only the coarse toolbar enablement BOUND — see
 * `isStepBackEnabled`.
 */
import { REPLAY_TIMEFRAME_MS } from './htfDerivation.js';
import { MINUTE_MS, type HistoricalBar } from '@apptypes/marketData.js';
import type { ReplaySnapshot, ReplayTimeframe } from '@apptypes/replay.js';

// ─── Workspace navigation history (Undo / Redo) ───────────────

/**
 * The complete undoable workspace state. Deliberately just two scalars: no
 * action, no session, no repository revision, and no execution can be
 * represented here, so Undo can never rewrite simulated trading history.
 */
export interface WorkspaceNavState {
  cursorUtcMs: number;
  displayTimeframe: ReplayTimeframe;
}

export interface NavHistory {
  undo: readonly WorkspaceNavState[];
  redo: readonly WorkspaceNavState[];
}

/** Bounded so a long session cannot grow the stack without limit. */
export const NAV_HISTORY_DEPTH = 50;

export const EMPTY_NAV_HISTORY: NavHistory = Object.freeze({
  undo: Object.freeze([]) as readonly WorkspaceNavState[],
  redo: Object.freeze([]) as readonly WorkspaceNavState[],
});

/**
 * Records the state being navigated AWAY FROM, before a discrete navigation
 * command is applied. Any new push invalidates the redo branch.
 */
export function pushNavState(history: NavHistory, previous: WorkspaceNavState): NavHistory {
  const undo = [...history.undo, { ...previous }];
  return {
    undo: undo.length > NAV_HISTORY_DEPTH ? undo.slice(undo.length - NAV_HISTORY_DEPTH) : undo,
    redo: EMPTY_NAV_HISTORY.redo,
  };
}

export interface NavTransition {
  history: NavHistory;
  /** The state the caller should apply. This module never applies it itself. */
  state: WorkspaceNavState;
}

export function canUndoNav(history: NavHistory): boolean {
  return history.undo.length > 0;
}

export function canRedoNav(history: NavHistory): boolean {
  return history.redo.length > 0;
}

/** Returns null — a deterministic no-op — when the undo stack is empty. */
export function undoNav(history: NavHistory, current: WorkspaceNavState): NavTransition | null {
  if (history.undo.length === 0) return null;
  const state = history.undo[history.undo.length - 1];
  return {
    history: { undo: history.undo.slice(0, -1), redo: [...history.redo, { ...current }] },
    state: { ...state },
  };
}

/** Returns null — a deterministic no-op — when the redo stack is empty. */
export function redoNav(history: NavHistory, current: WorkspaceNavState): NavTransition | null {
  if (history.redo.length === 0) return null;
  const state = history.redo[history.redo.length - 1];
  return {
    history: { undo: [...history.undo, { ...current }], redo: history.redo.slice(0, -1) },
    state: { ...state },
  };
}

// ─── Floating toolbar safe top ────────────────────────────────

/**
 * B2d Phase 9B — minimum top inset, in CSS px, for the FLOATING toolbar.
 *
 * The released app Header is sticky at z-index 100 and owns the top 54px while
 * the floating toolbar sits at z-index 15, so a toolbar placed above this line
 * is painted UNDER the Header outside Focus — which left its drag handle out of
 * reach. Inside Focus the Header is covered, but that same high position put the
 * toolbar over the Quick Trade strip instead. One inset below both bands fixes
 * both, and costs a negligible amount of workspace.
 *
 * SINGLE AUTHORITY: the initial float position and the drag clamp's minimum Y
 * both derive from this one value, so the two cannot drift apart. Deliberately a
 * plain constant — this module measures nothing and never touches the DOM.
 */
export const REPLAY_FLOATING_SAFE_TOP_PX = 72;

// ─── Select Bar ───────────────────────────────────────────────

/**
 * Cursor that makes the clicked bar the newest revealed one: its close, which
 * is the bucket start plus one bucket at the current display timeframe.
 *
 * Only revealed bars are ever rendered, so a click can never resolve later than
 * the current cursor. The clamp is defence in depth against look-ahead, not a
 * behaviour anyone can reach.
 */
export function selectBarTargetCursor(
  barStartUtcMs: number,
  timeframe: ReplayTimeframe,
  currentCursorUtcMs: number,
): number {
  return Math.min(barStartUtcMs + REPLAY_TIMEFRAME_MS[timeframe], currentCursorUtcMs);
}

// ─── Advisory price ───────────────────────────────────────────

/**
 * The `Last revealed close` readout: the close of the newest rendered bar.
 *
 * ADVISORY ONLY. It states a historical fact about a bar that has already
 * closed. It never decides whether trading is possible, never rejects a stale
 * quote, never computes a fill, and is never consulted by any command path —
 * `beginExecutionCommand` remains the sole execution authority.
 */
export function lastRevealedClose(bars: readonly HistoricalBar[]): number | null {
  return bars.length === 0 ? null : bars[bars.length - 1].c;
}

// ─── Shared trading-mutation predicate ────────────────────────

/**
 * Structural view of the released controller state. Structural typing lets the
 * real `ReplaySessionsState` satisfy it without this pure module importing the
 * hooks layer.
 */
export interface TradingMutationState {
  pending: boolean;
  safetyBlocked: boolean;
  activeSession: { status: 'active' | 'completed' } | null;
  projection: { rewound: boolean } | null;
}

/**
 * The single trading-disabled authority, mirroring the released panel expression
 * exactly so the chart quick controls and the context menu cannot drift from it.
 *
 * Overlay eligibility is deliberately NOT part of this: chart-data validity and
 * trading validity are separate contracts, and conflating them would let a
 * transient chart reload disable trading (or vice versa).
 */
export function isTradingMutationDisabled(state: TradingMutationState): boolean {
  return state.pending
    || state.safetyBlocked
    || state.activeSession === null
    || state.activeSession.status !== 'active'
    || state.projection?.rewound === true;
}

// ─── Shared order-input parsing (B2d Phase 5) ─────────────────
//
// ONE parsing authority for every trading surface. The detailed Trading Panel,
// the chart Quick Trade controls and the chart context menu all call these, so
// the set of accepted and rejected inputs cannot fork between them. The released
// panel semantics are reproduced exactly; nothing here executes, formats or
// persists anything.

/** Whole positive contract count, or null. Released `wholeContracts` semantics. */
export function parseOrderQuantity(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type ParsedInitialStop = { ok: true; price: number | null } | { ok: false };

/**
 * Blank means "no stop" and is VALID — the released panel submits `null`.
 * Any other text must parse to a finite positive price.
 */
export function parseInitialStop(text: string): ParsedInitialStop {
  if (text.trim() === '') return { ok: true, price: null };
  const price = Number(text);
  return Number.isFinite(price) && price > 0 ? { ok: true, price } : { ok: false };
}

export interface ParsedEntryIntent {
  quantity: number;
  /** null means the entry carries no stop, which the released path accepts. */
  initialStopPrice: number | null;
}

/**
 * The complete FLAT-entry gate: null is exactly the released `!validEntry`
 * condition, and a non-null result carries the exact arguments to submit.
 *
 * Scale In deliberately does NOT use this: an open episode's stop is immutable
 * and inherited from `openAggregate`, never from workspace text.
 */
export function parseEntryIntent(quantityText: string, initialStopText: string): ParsedEntryIntent | null {
  const quantity = parseOrderQuantity(quantityText);
  const stop = parseInitialStop(initialStopText);
  if (quantity === null || !stop.ok) return null;
  return { quantity, initialStopPrice: stop.price };
}

// ─── Tick normalization ───────────────────────────────────────

/** Decimal places implied by a tick size, used only to erase binary FP residue. */
function tickDecimals(tickSize: number): number {
  const text = String(tickSize);
  if (text.includes('e') || text.includes('E')) return 12;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(text.length - dot - 1, 12);
}

/**
 * Nearest valid tick for an arbitrary clicked chart price.
 *
 * The released canonical convention is `backtestSession.isTickAligned`:
 * `price / tickSize` must be a safe integer. This helper produces exactly such a
 * price, and rounds away binary residue so a clicked 19999.999999999996 becomes
 * 20000 rather than a value whose text no longer parses back to itself.
 *
 * Returns null for a non-finite price, a non-positive or non-finite tick size,
 * an out-of-range tick count, or a non-positive result — a price must be > 0.
 * The tick size itself comes from the released futures instrument authority at
 * the composition boundary; no instrument table is duplicated here.
 */
export function roundPriceToTick(price: number, tickSize: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  const ticks = Math.round(price / tickSize);
  if (!Number.isSafeInteger(ticks)) return null;
  const rounded = Number((ticks * tickSize).toFixed(tickDecimals(tickSize)));
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

// ─── Step Backward coarse enablement bound ────────────────────

/**
 * COARSE BOUND ONLY — not target selection.
 *
 * This deliberately performs no previous-bar search; doing so here would create
 * a second step-back algorithm alongside `replayStepBack.ts`. It answers only
 * "could a previous bar plausibly exist, and is the runtime in a state that
 * accepts navigation at all?".
 *
 * A press that passes this bound may still receive a deterministic runtime
 * no-op at the true boundary. That is the frozen, accepted behaviour.
 */
export function isStepBackEnabled(snapshot: ReplaySnapshot, safetyBlocked: boolean): boolean {
  if (safetyBlocked || snapshot.loading || snapshot.importing || snapshot.canonicalBarrier !== null) return false;
  if (!snapshot.availability.available) return false;
  const observedFirstUtcMs = snapshot.availability.observedFirstUtcMs;
  if (observedFirstUtcMs === undefined) return false;
  // At or below the first available bar's close the current bar can only be the
  // first one, which has no predecessor.
  return snapshot.nowUtcMs > observedFirstUtcMs + MINUTE_MS;
}
