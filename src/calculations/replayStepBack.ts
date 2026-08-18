/**
 * calculations/replayStepBack.ts
 *
 * B2d Phase 1 — pure selection helpers for Replay Step Backward.
 *
 * THIS MODULE IS NOT THE OPERATION. `replayRuntime.stepBackward()` (Phase 2) is
 * the authoritative operation; it consumes these functions and owns the cursor
 * publish (`previous + MINUTE_MS`), the guards, and the off-buffer reload. There
 * is exactly one target-selection algorithm and it lives here.
 *
 * ── WHY TWO STAGES ─────────────────────────────────────────────
 * Released `stepForward` selects `min{ b.t : b.t + MINUTE_MS > nowUtcMs }` — the
 * earliest UNREVEALED bar — and publishes that bar's close. Its exact
 * complement defines the current bar, and the inverse follows:
 *
 *   current = max{ b.t : b.t + MINUTE_MS <= cursorUtcMs }   // newest REVEALED
 *   prev    = max{ b.t : b.t <  current }                   // bar-set predecessor
 *
 * The predecessor is ranked against the CURRENT BAR'S START, never against
 * cursor milliseconds. A single-stage `max{ b.t : b.t + MINUTE_MS <= cursor }`
 * returns the current bar itself for every cursor strictly inside that bar's
 * revealed interval (+1 ms, +30 s, just before the next close), which would
 * leave Step Backward stationary. Switching `<=` to `<` does not fix it.
 *
 * Because the current bar is constant across the half-open interval
 * [currentClose, nextClose), the answer is identical for every cursor in it —
 * which is what makes the operation well-defined for a non-aligned cursor.
 *
 * Selection is always over the BAR SET. A wall-clock offset is never used: a
 * missing minute, a session gap, and a Friday-to-Monday weekend are crossed in
 * one step, and no bar is ever synthesized.
 *
 * ── LAYERING NOTE ──────────────────────────────────────────────
 * `isCanonicalUtcDay` is imported from the market-data reader, which is the
 * released authority for committed day-key validity. That module imports only
 * `@apptypes/marketData.js`, so this introduces no import cycle. Re-deriving the
 * validation here would create a second source of truth, which is the outcome
 * this module exists to prevent.
 */
import { isCanonicalUtcDay } from '@services/historicalBarReader.js';
import { MINUTE_MS, type HistoricalBar } from '@apptypes/marketData.js';

/**
 * Newest EXISTING canonical 1m bar whose close is at or before the cursor — the
 * released definition of the CURRENT revealed bar.
 *
 * `max { b.t : b.t >= floorUtcMs AND b.t + MINUTE_MS <= cursorUtcMs }`
 *
 * Returns null when nothing is revealed at the cursor.
 */
export function currentRevealedBarStart(
  bars: Iterable<HistoricalBar>,
  cursorUtcMs: number,
  floorUtcMs: number,
): number | null {
  if (!Number.isFinite(cursorUtcMs)) return null;
  let best: number | null = null;
  for (const candidate of bars) {
    if (candidate.t < floorUtcMs) continue;
    if (candidate.t + MINUTE_MS > cursorUtcMs) continue;
    if (best === null || candidate.t > best) best = candidate.t;
  }
  return best;
}

/**
 * Immediately previous EXISTING canonical 1m bar.
 *
 * `max { b.t : b.t >= floorUtcMs AND b.t < currentBarStartUtcMs }`
 *
 * Ranks against `currentBarStartUtcMs`, never against a cursor. Returns null at
 * the start of the supplied bar set, which the runtime treats as a deterministic
 * no-op or as the trigger for its off-buffer search.
 */
export function previousExistingBarStart(
  bars: Iterable<HistoricalBar>,
  currentBarStartUtcMs: number,
  floorUtcMs: number,
): number | null {
  if (!Number.isFinite(currentBarStartUtcMs)) return null;
  let best: number | null = null;
  for (const candidate of bars) {
    if (candidate.t < floorUtcMs) continue;
    if (candidate.t >= currentBarStartUtcMs) continue;
    if (best === null || candidate.t > best) best = candidate.t;
  }
  return best;
}

/**
 * Latest committed UTC day whose midnight instant is strictly before
 * `beforeUtcMs`, or null when there is none.
 *
 * Order-independent: `observedDays` may arrive unsorted. Entries that are not
 * canonical `YYYY-MM-DD` keys are ignored rather than trusted. Date-only ISO
 * strings parse as UTC by specification, so no local-time arithmetic occurs
 * anywhere in this function.
 */
export function previousCommittedDayStart(
  observedDays: readonly string[] | undefined,
  beforeUtcMs: number | null,
): number | null {
  if (observedDays === undefined || beforeUtcMs === null || !Number.isFinite(beforeUtcMs)) return null;
  let best: number | null = null;
  for (const day of observedDays) {
    if (!isCanonicalUtcDay(day)) continue;
    const instant = Date.parse(day);
    if (!Number.isSafeInteger(instant) || instant >= beforeUtcMs) continue;
    if (best === null || instant > best) best = instant;
  }
  return best;
}
