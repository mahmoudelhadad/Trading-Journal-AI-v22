/**
 * calculations/replayStepBack.test.ts
 *
 * B2d Phase 1 — exercises the REAL pure helpers.
 *
 * Phase 0/0.1 used test-local characterization helpers because the production
 * module did not exist. Those local algorithms are retired: `currentRevealedBarStart`,
 * `previousExistingBarStart` and the day search now come from
 * `calculations/replayStepBack.ts`. The only local function that remains is
 * `stepBackTarget`, a two-line COMPOSITION of the production helpers plus the
 * `+ MINUTE_MS` publish rule that the runtime will own in Phase 2, and `faulty`,
 * which preserves the REJECTED Phase-0 formula purely as a regression guard.
 *
 * ── RELEASED stepForward (services/replayRuntime.ts) ────────────
 *   next   = min{ b.t : b.t + MINUTE_MS >  nowUtcMs }      // earliest UNREVEALED bar
 *   cursor := next.t + MINUTE_MS
 *
 * Its complement defines the current bar; the inverse follows:
 *   current = max{ b.t : b.t + MINUTE_MS <= nowUtcMs }
 *   prev    = max{ b.t : b.t <  current }
 *   cursor := prev + MINUTE_MS
 *
 * ── FROZEN FIXTURE MATRIX ───────────────────────────────────────
 *   A. cursor exactly on the current bar close
 *   B. cursor 1 ms after the current close
 *   C. cursor 30 s after the current close
 *   D. cursor immediately before the next canonical close
 *   E. adjacent previous bar
 *   F. single missing-minute gap
 *   G. multi-hour / session gap
 *   H. Friday -> Monday weekend gap
 *   I. unsorted bar iterable
 *   J. previous bar outside current coverage
 *   K. absolute beginning of available history -> deterministic no-op
 *   L. no availability -> deterministic no-op
 *   M. HWM crossing keeps released rewind semantics
 *
 * A-I, K and the floor bound are covered here. J, L and M are runtime-level and
 * are exercised in services/replayRuntime.test.ts once the runtime operation
 * exists (Phase 2); display-timeframe independence is characterized there now.
 */
import { describe, expect, it } from 'vitest';
import {
  currentRevealedBarStart, previousCommittedDayStart, previousExistingBarStart,
} from './replayStepBack.js';
import { revealClosedBars } from './replayReveal.js';
import { DAY_MS, MINUTE_MS, utcDayOf, type HistoricalBar } from '@apptypes/marketData.js';

const bar = (t: number, p = 1): HistoricalBar => ({ t, o: p, h: p, l: p, c: p, v: 1 });
const UNBOUNDED = Number.NEGATIVE_INFINITY;

/** 2016-03-04 is a Friday; 03-05/03-06 are the weekend; 03-07 is the Monday. */
const FRI = Date.parse('2016-03-04T00:00:00Z');
const MON = Date.parse('2016-03-07T00:00:00Z');
const FRI_LAST = FRI + 22 * 60 * MINUTE_MS;        // Friday 22:00Z
const MON_FIRST = MON;                              // Monday 00:00Z

/**
 * Composition of the two production helpers plus the publish rule the runtime
 * owns in Phase 2. Contains no selection logic of its own.
 */
function stepBackTarget(
  bars: readonly HistoricalBar[], cursorUtcMs: number, floorUtcMs = UNBOUNDED,
): number | null {
  const current = currentRevealedBarStart(bars, cursorUtcMs, floorUtcMs);
  if (current === null) return null;
  const previous = previousExistingBarStart(bars, current, floorUtcMs);
  return previous === null ? null : previous + MINUTE_MS;
}

// ─── Cursor alignment independence (matrix cases A-D) ─────────

describe('replayStepBack — Step Backward is defined by the current bar, not the cursor', () => {
  // Bars start at minutes 59, 60 and 61. For every cursor in the half-open
  // interval [minute 61, minute 62) the current bar is the minute-60 bar.
  const bars = [bar(FRI + 59 * MINUTE_MS), bar(FRI + 60 * MINUTE_MS), bar(FRI + 61 * MINUTE_MS)];
  const currentClose = FRI + 61 * MINUTE_MS;
  const nextClose = FRI + 62 * MINUTE_MS;

  it.each([
    ['A · exactly on the current bar close', currentClose],
    ['B · 1 ms after the current close', currentClose + 1],
    ['C · 30 seconds after the current close', currentClose + 30_000],
    ['D · immediately before the next canonical close', nextClose - 1],
  ])('selects the same previous bar for a cursor %s', (_label, cursor) => {
    expect(currentRevealedBarStart(bars, cursor, UNBOUNDED)).toBe(FRI + 60 * MINUTE_MS);
    expect(previousExistingBarStart(bars, FRI + 60 * MINUTE_MS, UNBOUNDED)).toBe(FRI + 59 * MINUTE_MS);
    expect(stepBackTarget(bars, cursor)).toBe(FRI + 60 * MINUTE_MS);
  });

  it('advances the answer only once the next canonical bar has closed', () => {
    expect(currentRevealedBarStart(bars, nextClose, UNBOUNDED)).toBe(FRI + 61 * MINUTE_MS);
    expect(stepBackTarget(bars, nextClose)).toBe(FRI + 61 * MINUTE_MS);
  });

  it('rejects the superseded cursor-relative predicate on a non-aligned cursor', () => {
    // Regression guard for the formula this contract replaced: on an aligned
    // cursor it coincides with the correct answer; 30 s later it returns the
    // CURRENT bar, which would leave Step Backward stationary.
    const faulty = (cursor: number) => {
      const revealed = revealClosedBars(bars, cursor - 1);
      return revealed.length === 0 ? null : revealed[revealed.length - 1].t;
    };
    expect(faulty(currentClose)).toBe(FRI + 59 * MINUTE_MS);
    expect(faulty(currentClose + 30_000)).toBe(FRI + 60 * MINUTE_MS);
    expect(faulty(currentClose + 30_000))
      .not.toBe(previousExistingBarStart(bars, FRI + 60 * MINUTE_MS, UNBOUNDED));
  });

  it('moves the current bar to exactly its predecessor', () => {
    const cursor = currentClose + 30_000;
    const before = currentRevealedBarStart(bars, cursor, UNBOUNDED)!;
    const target = stepBackTarget(bars, cursor)!;
    // The published cursor makes the predecessor the new current bar, and the
    // original current bar is exactly the successor of that predecessor.
    expect(currentRevealedBarStart(bars, target, UNBOUNDED)).toBe(FRI + 59 * MINUTE_MS);
    expect(previousExistingBarStart(bars, before, UNBOUNDED)).toBe(FRI + 59 * MINUTE_MS);
  });
});

// ─── Bar-set selection (matrix cases E-I, K) ──────────────────

describe('replayStepBack — previous-bar selection is a bar-set maximum, not a clock offset', () => {
  it('E · selects the adjacent minute when there is no gap', () => {
    const bars = [bar(FRI), bar(FRI + MINUTE_MS), bar(FRI + 2 * MINUTE_MS)];
    const cursor = FRI + 3 * MINUTE_MS;                 // close of the minute-2 bar
    expect(currentRevealedBarStart(bars, cursor, UNBOUNDED)).toBe(FRI + 2 * MINUTE_MS);
    expect(stepBackTarget(bars, cursor)).toBe(FRI + 2 * MINUTE_MS);
  });

  it('F · skips a single missing minute', () => {
    const bars = [bar(FRI), bar(FRI + 2 * MINUTE_MS)];  // the minute-1 bar does not exist
    const cursor = FRI + 3 * MINUTE_MS;                 // close of the minute-2 bar
    expect(currentRevealedBarStart(bars, cursor, UNBOUNDED)).toBe(FRI + 2 * MINUTE_MS);
    expect(previousExistingBarStart(bars, FRI + 2 * MINUTE_MS, UNBOUNDED)).toBe(FRI);
    expect(stepBackTarget(bars, cursor)).toBe(FRI + MINUTE_MS);
    // The published cursor is an EXISTING bar's close; the hole is never
    // synthesized and never landed on as a bar start.
    expect(bars.some((entry) => entry.t === FRI + MINUTE_MS)).toBe(false);
  });

  it('G · skips a multi-hour session gap in one selection', () => {
    const bars = [bar(FRI + 60 * MINUTE_MS), bar(FRI + 600 * MINUTE_MS)];
    const cursor = FRI + 601 * MINUTE_MS;               // close of the minute-600 bar
    expect(currentRevealedBarStart(bars, cursor, UNBOUNDED)).toBe(FRI + 600 * MINUTE_MS);
    expect(stepBackTarget(bars, cursor)).toBe(FRI + 61 * MINUTE_MS);
    // One further press exhausts the loaded set: minute-60 is the first bar.
    expect(stepBackTarget(bars, FRI + 61 * MINUTE_MS)).toBeNull();
  });

  it('H · crosses a Friday-to-Monday weekend gap that repeated wall-clock steps cannot', () => {
    const bars = [bar(FRI_LAST - MINUTE_MS), bar(FRI_LAST), bar(MON_FIRST)];
    const cursor = MON_FIRST + MINUTE_MS;               // Monday's first bar just closed

    expect(currentRevealedBarStart(bars, cursor, UNBOUNDED)).toBe(MON_FIRST);
    const target = stepBackTarget(bars, cursor)!;
    expect(target).toBe(FRI_LAST + MINUTE_MS);          // Friday's last bar close
    expect(cursor - target).toBeGreaterThan(2 * DAY_MS);

    // A wall-clock fallback subtracts one minute per press. After the first
    // press the current bar is already Friday's last, and every further press
    // moves the cursor WITHOUT changing the current bar: it stalls for the whole
    // width of the gap instead of stepping a bar.
    let wallClock = cursor;
    expect(currentRevealedBarStart(bars, wallClock, UNBOUNDED)).toBe(MON_FIRST);
    wallClock -= MINUTE_MS;
    expect(currentRevealedBarStart(bars, wallClock, UNBOUNDED)).toBe(FRI_LAST);
    for (let press = 0; press < 10; press += 1) {
      wallClock -= MINUTE_MS;
      expect(currentRevealedBarStart(bars, wallClock, UNBOUNDED)).toBe(FRI_LAST);
    }

    // Bar-set selection, by contrast, advances on every single press.
    expect(stepBackTarget(bars, target)).toBe(FRI_LAST);
  });

  it('I · gives the same answer for an unsorted bar iterable', () => {
    const ordered = [bar(FRI), bar(FRI + MINUTE_MS), bar(FRI + 5 * MINUTE_MS)];
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    const cursor = FRI + 6 * MINUTE_MS;
    expect(stepBackTarget(shuffled, cursor)).toBe(stepBackTarget(ordered, cursor));
    expect(stepBackTarget(ordered, cursor)).toBe(FRI + 2 * MINUTE_MS);
    expect(currentRevealedBarStart(shuffled, cursor, UNBOUNDED)).toBe(FRI + 5 * MINUTE_MS);
  });

  it('K · returns nothing at the absolute beginning of the bar set', () => {
    expect(stepBackTarget([bar(FRI)], FRI + MINUTE_MS)).toBeNull();
    // Nothing revealed at all is also a deterministic no-op, never a throw.
    expect(currentRevealedBarStart([bar(FRI)], FRI, UNBOUNDED)).toBeNull();
    expect(stepBackTarget([bar(FRI)], FRI)).toBeNull();
    expect(stepBackTarget([], FRI + MINUTE_MS)).toBeNull();
  });

  it('honours the floor bound on both stages', () => {
    const bars = [bar(FRI), bar(FRI + MINUTE_MS), bar(FRI + 2 * MINUTE_MS)];
    const floor = FRI + MINUTE_MS;
    expect(currentRevealedBarStart(bars, FRI + 2 * MINUTE_MS, floor)).toBe(FRI + MINUTE_MS);
    // The minute-0 bar is below the floor, so the minute-1 bar has no visible
    // predecessor even though one exists in the raw set.
    expect(previousExistingBarStart(bars, FRI + MINUTE_MS, floor)).toBeNull();
    expect(previousExistingBarStart(bars, FRI + MINUTE_MS, UNBOUNDED)).toBe(FRI);
    expect(stepBackTarget(bars, FRI + 3 * MINUTE_MS, floor)).toBe(FRI + 2 * MINUTE_MS);
  });

  it('accepts any iterable, not only arrays', () => {
    const bars = new Map([
      [FRI, bar(FRI)], [FRI + MINUTE_MS, bar(FRI + MINUTE_MS)],
    ]);
    expect(currentRevealedBarStart(bars.values(), FRI + 2 * MINUTE_MS, UNBOUNDED)).toBe(FRI + MINUTE_MS);
    expect(previousExistingBarStart(bars.values(), FRI + MINUTE_MS, UNBOUNDED)).toBe(FRI);
  });
});

// ─── Committed-day arithmetic (matrix cases H, J) ─────────────

describe('replayStepBack — committed UTC day keys are exact UTC-midnight instants', () => {
  const OBSERVED = ['2016-03-04', '2016-03-01', '2016-03-07'];   // deliberately unsorted

  it('parses a canonical day key to UTC midnight and round-trips through utcDayOf', () => {
    for (const day of ['2016-03-04', '2016-03-07', '2016-01-01', '2016-12-31']) {
      const parsed = Date.parse(day);
      expect(parsed % DAY_MS).toBe(0);
      expect(utcDayOf(parsed)).toBe(day);
    }
  });

  it('is unaffected by a local DST transition day', () => {
    // 2016-03-13 is the US spring-forward date. Day arithmetic here is UTC-only,
    // so nothing about it is special — which is exactly the property to freeze.
    expect(previousCommittedDayStart(['2016-03-13', '2016-03-14'], Date.parse('2016-03-14')))
      .toBe(Date.parse('2016-03-13'));
    expect(utcDayOf(Date.parse('2016-03-13'))).toBe('2016-03-13');
  });

  it('finds the latest committed day strictly before an instant, from unsorted input', () => {
    expect(previousCommittedDayStart(OBSERVED, MON_FIRST)).toBe(FRI);
    expect(previousCommittedDayStart(OBSERVED, FRI)).toBe(Date.parse('2016-03-01'));
    expect(previousCommittedDayStart(OBSERVED, Date.parse('2016-03-01'))).toBeNull();
  });

  it('skips the weekend, because only data-bearing days are committed', () => {
    const bars = [bar(FRI), bar(FRI_LAST), bar(MON_FIRST)];
    const observedDays = [...new Set(bars.map((entry) => utcDayOf(entry.t)))];
    expect(observedDays).toEqual(['2016-03-04', '2016-03-07']);
    expect(previousCommittedDayStart(observedDays, MON_FIRST)).toBe(FRI);
  });

  it('bounds the search by the CURRENT BAR start, including its own day', () => {
    // A current bar inside its own day yields that same day, which is what lets
    // the first reload recover same-day bars lost to retention eviction.
    expect(previousCommittedDayStart(OBSERVED, MON_FIRST + 5 * MINUTE_MS)).toBe(MON);
    expect(previousCommittedDayStart(OBSERVED, MON_FIRST)).toBe(FRI);
  });

  it('ignores non-canonical day keys instead of trusting them', () => {
    const malformed = ['2016-3-4', '2016-13-01', '2016-02-30', '', 'not-a-day'];
    expect(previousCommittedDayStart(malformed, MON_FIRST)).toBeNull();
    expect(previousCommittedDayStart([...malformed, '2016-03-04'], MON_FIRST)).toBe(FRI);
    expect(previousCommittedDayStart(['2016-02-29'], MON_FIRST)).toBe(Date.parse('2016-02-29'));
  });

  it('returns null for an absent list or an invalid boundary', () => {
    expect(previousCommittedDayStart(undefined, MON_FIRST)).toBeNull();
    expect(previousCommittedDayStart(OBSERVED, null)).toBeNull();
    expect(previousCommittedDayStart(OBSERVED, Number.NaN)).toBeNull();
    expect(previousCommittedDayStart([], MON_FIRST)).toBeNull();
  });
});
