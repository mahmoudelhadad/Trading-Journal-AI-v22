import { describe, expect, it, vi } from 'vitest';
import { createReplayRuntime, type ReplayRuntimeDependencies } from './replayRuntime.js';
import type {
  HistoricalAvailability, HistoricalBarReader, HistoricalReadRequest, HistoricalReadResult,
} from './historicalBarReader.js';
import { DAY_MS, type HistoricalBar } from '@apptypes/marketData.js';

const SERIES = { root: 'NQ' as const, expiryYear: 2016, expiryMonth: 3, timeframe: '1m' as const };
const T0 = Date.parse('2016-03-01T00:00:00Z');
const bar = (t: number, p = 1): HistoricalBar => ({ t, o: p, h: p, l: p, c: p, v: 1 });
const availability: HistoricalAvailability = { available: true, observedFirstUtcMs: T0, observedLastUtcMs: T0 + 10 * 60_000, observedDays: ['2016-03-01'] };
const wideAvailability: HistoricalAvailability = { available: true, observedFirstUtcMs: T0, observedLastUtcMs: T0 + 4 * 86_400_000, observedDays: ['2016-03-01'] };
const ok = (bars: HistoricalBar[]): HistoricalReadResult => ({ ok: true, bars, returnedFirstUtcMs: bars[0]?.t ?? null, returnedLastUtcMs: bars.length === 0 ? null : bars[bars.length - 1].t });
const commitOk = { ok: true as const, message: 'ok' };

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

function harness(reader: HistoricalBarReader) {
  const frames = new Map<number, (time: number) => void>(); let nextFrame = 1;
  const listeners = new Set<() => void>(); let hidden = false; let perf = 0;
  const visibilityAdd = vi.fn((listener: () => void) => listeners.add(listener));
  const visibilityRemove = vi.fn((listener: () => void) => listeners.delete(listener));
  const deps: ReplayRuntimeDependencies = {
    openReader: vi.fn(async () => reader),
    monotonicNow: () => perf,
    requestFrame: (cb) => { const id = nextFrame++; frames.set(id, cb); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    visibility: { isHidden: () => hidden, add: visibilityAdd, remove: visibilityRemove },
  };
  const runtime = createReplayRuntime(deps);
  return { runtime, deps, frames, listeners, visibilityAdd, visibilityRemove,
    setHidden(v: boolean) { hidden = v; }, setPerf(v: number) { perf = v; } };
}

function runNextFrame(h: ReturnType<typeof harness>): void {
  const entry = [...h.frames.entries()][0];
  h.frames.delete(entry[0]);
  entry[1](0);
}

function fireVisibility(h: ReturnType<typeof harness>): void {
  expect(h.listeners.size).toBe(1);
  [...h.listeners][0]();
}

describe('production replay runtime authority and lifecycle', () => {
  it('returns authoritative commit booleans for racing session resumes', async () => {
    const first = deferred<HistoricalAvailability>(); const second = deferred<HistoricalAvailability>();
    const getLocalAvailability = vi.fn()
      .mockResolvedValueOnce(availability)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const reader: HistoricalBarReader = { getLocalAvailability, readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const seriesB = { ...SERIES, root: 'ES' as const };
    const resumeA = h.runtime.resumeSession(SERIES, T0 + 60_000); await flush();
    const resumeB = h.runtime.resumeSession(seriesB, T0 + 120_000); await flush();
    second.resolve(availability); await flush();
    expect(await resumeB).toBe(true);
    first.resolve(availability); await flush();
    expect(await resumeA).toBe(false);
    expect(h.runtime.getSnapshot()).toMatchObject({ series: seriesB, nowUtcMs: T0 + 120_000 });
  });

  /**
   * B2d Phase 0 characterization. Freezes the released ordering fact that
   * motivates the B2d overlay-eligibility gate: the runtime publishes the
   * resumed series, its bars and `loading: false` to subscribers BEFORE
   * `resumeSession` settles. The controller adopts the newly selected session
   * only after awaiting that promise, so a render can observe the new contract
   * while the previously selected session is still the active one.
   *
   * The other two transition facts the gate guards are already frozen by
   * 'clears every observable bar immediately on barrier entry' (import barrier
   * empties the revealed bars) and 'preserves the old cursor and chart when a
   * selected-series read fails' (a failed read publishes an error while stale
   * bars remain), so neither is duplicated here.
   */
  it('publishes the resumed series and settled state before resumeSession settles', async () => {
    const seriesB = { ...SERIES, root: 'ES' as const };
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => availability),
      readBars: vi.fn(async () => ok([bar(T0)])),
    };
    const h = harness(reader); h.runtime.attach(); await flush();
    const published: Array<{ root: string; loading: boolean; bars: number }> = [];
    const unsubscribe = h.runtime.subscribe(() => {
      const snapshot = h.runtime.getSnapshot();
      published.push({ root: snapshot.series.root, loading: snapshot.loading, bars: snapshot.bars.length });
    });
    let publishedAtSettle = -1;
    const committed = await h.runtime.resumeSession(seriesB, T0 + 60_000)
      .then((value) => { publishedAtSettle = published.length; return value; });
    expect(committed).toBe(true);
    const settledIndex = published.findIndex((entry) => entry.root === 'ES' && !entry.loading && entry.bars > 0);
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(settledIndex).toBeLessThan(publishedAtSettle);
    unsubscribe(); h.runtime.detach();
  });

  it('construction is inert and independent across two runtimes', () => {
    const reader = { getLocalAvailability: vi.fn(), readBars: vi.fn() } as unknown as HistoricalBarReader;
    const a = harness(reader); const b = harness(reader);
    expect(a.deps.openReader).not.toHaveBeenCalled(); expect(b.deps.openReader).not.toHaveBeenCalled();
    expect(a.frames.size + b.frames.size).toBe(0); expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it('attach detach attach leaves exactly one frame and listener', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); h.runtime.detach(); h.runtime.attach(); await flush();
    expect(h.frames.size).toBe(1); expect(h.listeners.size).toBe(1);
    expect(h.visibilityAdd).toHaveBeenCalledTimes(2); expect(h.visibilityRemove).toHaveBeenCalledTimes(1);
  });

  it('uses whole UTC-day initial coverage', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    expect(h.runtime.getSnapshot().coverageStartUtcMs).toBe(T0);
    expect(h.runtime.getSnapshot().coverageEndUtcMs).toBe(T0 + 2 * 86_400_000);
  });

  it('blocks readBars when an import barrier enters during availability suspension', async () => {
    const waiting = deferred<HistoricalAvailability>(); const commit = deferred<typeof commitOk>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(() => waiting.promise), readBars: vi.fn(async () => ok([])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const importing = h.runtime.runImport(SERIES, () => commit.promise); waiting.resolve(availability); await flush();
    expect(reader.readBars).not.toHaveBeenCalled();
    commit.resolve(commitOk); await importing; h.runtime.detach();
  });

  it('creates exactly one replacement when a barrier fully settles during an older suspension', async () => {
    const firstAvailability = deferred<HistoricalAvailability>();
    const getLocalAvailability = vi.fn()
      .mockImplementationOnce(() => firstAvailability.promise)
      .mockResolvedValue(availability);
    const reader: HistoricalBarReader = { getLocalAvailability, readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.runImport(SERIES, async () => commitOk); await flush();
    expect(getLocalAvailability).toHaveBeenCalledTimes(2);
    expect(reader.readBars).toHaveBeenCalledTimes(1);
    firstAvailability.resolve(availability); await flush();
    expect(getLocalAvailability).toHaveBeenCalledTimes(2);
    expect(reader.readBars).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight read after barrier entry without publishing it', async () => {
    const waitingRead = deferred<HistoricalReadResult>(); const commit = deferred<typeof commitOk>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(() => waitingRead.promise) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const importing = h.runtime.runImport(SERIES, () => commit.promise); waitingRead.resolve(ok([bar(T0, 999)])); await flush();
    expect(h.runtime.getSnapshot().bars).toEqual([]);
    commit.resolve(commitOk); await importing; h.runtime.detach();
  });

  it('clears every observable bar immediately on barrier entry', async () => {
    const commit = deferred<typeof commitOk>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); expect(h.runtime.getSnapshot().bars).toHaveLength(1);
    const importing = h.runtime.runImport(SERIES, () => commit.promise);
    expect(h.runtime.getSnapshot().bars).toEqual([]); expect(h.runtime.getSnapshot().importing).toBe(true);
    commit.resolve(commitOk); await importing; h.runtime.detach();
  });

  it('settles a detached import internally without notifying subscribers or issuing reads', async () => {
    const commit = deferred<typeof commitOk>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const subscriber = vi.fn(); h.runtime.subscribe(subscriber);
    const importing = h.runtime.runImport(SERIES, () => commit.promise);
    expect(subscriber).toHaveBeenCalledTimes(1);
    h.runtime.detach();
    const callbacksAtDetach = subscriber.mock.calls.length;
    commit.resolve(commitOk); await importing; await flush();
    expect(subscriber).toHaveBeenCalledTimes(callbacksAtDetach);
    expect(reader.getLocalAvailability).toHaveBeenCalledTimes(1);
    expect(reader.readBars).toHaveBeenCalledTimes(1);
    expect(h.frames.size).toBe(0); expect(h.listeners.size).toBe(0);
    expect(h.runtime.getSnapshot().importing).toBe(false);
    h.runtime.attach(); await flush();
    expect(reader.getLocalAvailability).toHaveBeenCalledTimes(2);
    expect(reader.readBars).toHaveBeenCalledTimes(2);
    expect(h.runtime.getSnapshot().loading).toBe(false);
  });

  it('closes the detach/reattach lost wakeup with one fresh attempt', async () => {
    const first = deferred<HistoricalAvailability>();
    const getAvailability = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(availability);
    const reader: HistoricalBarReader = { getLocalAvailability: getAvailability, readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.detach(); h.runtime.attach();
    first.resolve(availability); await flush();
    expect(getAvailability).toHaveBeenCalledTimes(2); expect(reader.readBars).toHaveBeenCalledTimes(1);
  });

  it('does not retry a stale lifecycle attempt over a newer Go To', async () => {
    const first = deferred<HistoricalAvailability>();
    const getAvailability = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(availability);
    const reader: HistoricalBarReader = { getLocalAvailability: getAvailability, readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); const go = h.runtime.goTo(T0 + 5 * 60_000);
    first.resolve(availability); await go; await flush();
    expect(getAvailability).toHaveBeenCalledTimes(2);
  });

  it('steps to the earliest real close through gaps and supports backward exact Go To', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0), bar(T0 + 5 * 60_000)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.stepForward(); expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 6 * 60_000);
    await h.runtime.goTo(T0 + 30_000); expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 30_000);
  });

  /**
   * B2d Phase 0.1 characterization. Freezes two released facts that the future
   * Step Backward must mirror exactly:
   *
   *   1. stepForward targets `min{ b.t : b.t + MINUTE_MS > nowUtcMs }` from the
   *      raw 1m buffer and never reads `state.timeframe`, so the step size is
   *      one canonical 1-minute bar at every display timeframe.
   *   2. the target is constant for every cursor inside the current bar's
   *      revealed interval, so an aligned and a non-aligned cursor step to the
   *      same bar. This is the "current bar", not "cursor milliseconds",
   *      semantic that Step Backward inverts.
   */
  it.each(['1m', '5m', '15m', '1h'] as const)(
    'steps one canonical 1m bar while displaying %s, from aligned and non-aligned cursors',
    async (timeframe) => {
      const bars = [bar(T0), bar(T0 + 60_000), bar(T0 + 120_000), bar(T0 + 180_000)];
      const reader: HistoricalBarReader = {
        getLocalAvailability: vi.fn(async () => availability),
        readBars: vi.fn(async () => ok(bars)),
      };
      const h = harness(reader); h.runtime.attach(); await flush();
      await h.runtime.goTo(T0 + 180_000); h.runtime.setTimeframe(timeframe);
      // The display really is aggregated, so the assertion below is not vacuous.
      expect(h.runtime.getSnapshot().bars).toHaveLength(timeframe === '1m' ? 3 : 1);

      await h.runtime.stepForward();
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 240_000);

      await h.runtime.goTo(T0 + 180_000 + 30_000);
      expect(h.runtime.getSnapshot().timeframe).toBe(timeframe);
      await h.runtime.stepForward();
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 240_000);
      h.runtime.detach();
    });

  it('preserves the old cursor and chart when a selected-series read fails', async () => {
    const readBars = vi.fn().mockResolvedValueOnce(ok([bar(T0)])).mockResolvedValueOnce({ ok: false, reason: 'read_failed', message: 'broken' });
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); const before = h.runtime.getSnapshot();
    h.runtime.selectSeries({ ...SERIES, root: 'ES' }); await flush();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(before.nowUtcMs);
    expect(h.runtime.getSnapshot().bars).toEqual(before.bars);
    expect(h.runtime.getSnapshot().series).toEqual(before.series);
  });

  it('prefetch is buffer-only and does not advance fixed-cursor coverage or chart output', async () => {
    const readBars = vi.fn().mockResolvedValueOnce(ok([bar(T0)])).mockResolvedValueOnce(ok([bar(T0 + 2 * 86_400_000, 99)]));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); const coverage = h.runtime.getSnapshot().coverageEndUtcMs;
    h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000); const entry = [...h.frames.entries()][0]; h.frames.delete(entry[0]); entry[1](0); await flush();
    expect(readBars).toHaveBeenCalledTimes(2);
    expect(h.runtime.getSnapshot().coverageEndUtcMs).toBe(coverage);
    expect(h.runtime.getSnapshot().bars.some((b) => b.h === 99)).toBe(false);
    const next = [...h.frames.entries()][0]; h.frames.delete(next[0]); next[1](0); await flush();
    expect(readBars).toHaveBeenCalledTimes(2);
  });

  it('retries a failed prefetch at the same edge, then deduplicates the accepted success', async () => {
    const future = bar(T0 + 2 * 86_400_000, 99);
    const readBars = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce({ ok: false, reason: 'read_failed', message: 'temporary' })
      .mockResolvedValueOnce(ok([future]));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(2);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(3);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(3);
    expect(h.runtime.getSnapshot().coverageEndUtcMs).toBe(T0 + 2 * 86_400_000);
  });

  it('retries a barrier-stale prefetch after settlement recovery', async () => {
    const stalePrefetch = deferred<HistoricalReadResult>();
    const readBars = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockImplementationOnce(() => stalePrefetch.promise)
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([bar(T0 + 2 * 86_400_000, 99)]));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(2);
    const importing = h.runtime.runImport(SERIES, async () => commitOk);
    stalePrefetch.resolve(ok([])); await flush(); await importing; await flush();
    expect(readBars).toHaveBeenCalledTimes(3);
    h.runtime.play(); h.setPerf(2 * (2 * 86_400_000 - 20 * 60_000)); runNextFrame(h); await flush();
    expect(readBars).toHaveBeenCalledTimes(4);
  });

  it('retries a lifecycle-stale prefetch after a valid reattach', async () => {
    const stalePrefetch = deferred<HistoricalReadResult>();
    const readBars = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockImplementationOnce(() => stalePrefetch.promise)
      .mockResolvedValueOnce(ok([bar(T0 + 2 * 86_400_000, 99)]));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(2);
    h.runtime.detach(); h.runtime.attach(); stalePrefetch.resolve(ok([])); await flush();
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(3);
  });

  it('does not let an older stale completion clear a newer prefetch attempt', async () => {
    const oldPrefetch = deferred<HistoricalReadResult>();
    const newPrefetch = deferred<HistoricalReadResult>();
    let readNumber = 0;
    const readBars = vi.fn(() => {
      readNumber += 1;
      if (readNumber === 1 || readNumber === 3) return Promise.resolve(ok([]));
      if (readNumber === 2) return oldPrefetch.promise;
      if (readNumber === 4) return newPrefetch.promise;
      return Promise.resolve(ok([]));
    });
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000);
    runNextFrame(h); await flush(); expect(readBars).toHaveBeenCalledTimes(2);
    await h.runtime.runImport(SERIES, async () => commitOk); await flush(); expect(readBars).toHaveBeenCalledTimes(3);
    h.runtime.play(); h.setPerf(2 * (2 * 86_400_000 - 20 * 60_000)); runNextFrame(h); await flush();
    expect(readBars).toHaveBeenCalledTimes(4);
    oldPrefetch.resolve(ok([])); await flush(); runNextFrame(h); await flush();
    expect(readBars).toHaveBeenCalledTimes(4);
    newPrefetch.resolve(ok([])); await flush(); runNextFrame(h); await flush();
    expect(readBars).toHaveBeenCalledTimes(4);
  });

  it('never lets a prefetched bar authorize Step before a real extension succeeds', async () => {
    const future = bar(T0 + 2 * 86_400_000, 99);
    const readBars = vi.fn().mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([future])).mockResolvedValueOnce(ok([future]));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 - 20 * 60_000);
    const entry = [...h.frames.entries()][0]; h.frames.delete(entry[0]); entry[1](0); await flush();
    h.runtime.pause(); await h.runtime.stepForward();
    expect(readBars).toHaveBeenCalledTimes(3);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(future.t + 60_000);
  });

  it('waits at authoritative coverage and resumes only after extension succeeds', async () => {
    const extension = deferred<HistoricalReadResult>();
    const readBars = vi.fn().mockResolvedValueOnce(ok([bar(T0)])).mockImplementationOnce(() => extension.promise);
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(2 * 86_400_000 + 60_000);
    const entry = [...h.frames.entries()][0]; h.frames.delete(entry[0]); entry[1](0); await flush();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 2 * 86_400_000);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    extension.resolve(ok([])); await flush(); expect(h.runtime.getSnapshot().playState).toBe('playing');
  });

  it('treats ok zero bars as valid and clamps playback to last start plus one minute', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([])) };
    const h = harness(reader); h.runtime.attach(); await flush(); expect(h.runtime.getSnapshot().error).toBeNull();
    h.runtime.play(); h.setPerf(999_999); const cb = [...h.frames.values()][0]; cb(0);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 11 * 60_000); expect(h.runtime.getSnapshot().playState).toBe('ended');
  });

  it('temporarily suspends playing while hidden and resumes from a fresh visible anchor', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    h.setPerf(1_000); runNextFrame(h); const cursorAtHide = h.runtime.getSnapshot().nowUtcMs;
    h.setHidden(true); fireVisibility(h); expect(h.runtime.getSnapshot().playState).toBe('paused');
    h.setPerf(11_000); runNextFrame(h); expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursorAtHide);
    h.setHidden(false); fireVisibility(h); expect(h.runtime.getSnapshot().playState).toBe('playing');
    h.setPerf(12_000); runNextFrame(h);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursorAtHide + 1_000);
  });

  it('does not consume a ten-second hidden interval at 300x', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.setSpeed(300); h.runtime.play();
    const cursorAtHide = h.runtime.getSnapshot().nowUtcMs;
    h.setHidden(true); fireVisibility(h); h.setPerf(10_000); runNextFrame(h);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursorAtHide);
    h.setHidden(false); fireVisibility(h); h.setPerf(11_000); runNextFrame(h);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursorAtHide + 300_000);
    expect(h.runtime.getSnapshot().nowUtcMs).not.toBe(cursorAtHide + 3_000_000);
  });

  it('leaves an already-paused replay paused across visibility changes', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const cursor = h.runtime.getSnapshot().nowUtcMs;
    h.setHidden(true); fireVisibility(h); h.setPerf(10_000); runNextFrame(h);
    h.setHidden(false); fireVisibility(h); h.setPerf(11_000); runNextFrame(h);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursor);
  });

  it('does not resurrect visibility play intent over an import barrier', async () => {
    const commit = deferred<typeof commitOk>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    h.setHidden(true); fireVisibility(h);
    const importing = h.runtime.runImport(SERIES, () => commit.promise);
    h.setHidden(false); fireVisibility(h);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    commit.resolve(commitOk); await importing; await flush();
    expect(h.runtime.getSnapshot().importing).toBe(false);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
  });

  it('does not resume over an authoritative read failure while hidden', async () => {
    const readBars = vi.fn()
      .mockResolvedValueOnce(ok([bar(T0)]))
      .mockResolvedValueOnce({ ok: false, reason: 'read_failed', message: 'broken' });
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    h.setHidden(true); fireVisibility(h); await h.runtime.goTo(T0 + DAY_MS);
    expect(h.runtime.getSnapshot().error).toBe('broken');
    h.setHidden(false); fireVisibility(h);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    expect(h.runtime.getSnapshot().error).toBe('broken');
  });

  it('invalidates visibility resume intent when explicitly paused while hidden', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    h.setHidden(true); fireVisibility(h); h.runtime.pause();
    h.setHidden(false); fireVisibility(h);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
  });

  it('does not restart frames or listeners while detached with visibility intent', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    h.setHidden(true); fireVisibility(h); const cursor = h.runtime.getSnapshot().nowUtcMs;
    h.runtime.detach(); h.setPerf(10_000);
    expect(h.frames.size).toBe(0); expect(h.listeners.size).toBe(0);
    h.runtime.attach(); await flush();
    expect(h.frames.size).toBe(1); expect(h.listeners.size).toBe(1);
    h.setHidden(false); fireVisibility(h);
    runNextFrame(h);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursor);
  });

  it('reanchors repeated hide-show cycles with one frame and listener', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play();
    const initial = h.runtime.getSnapshot().nowUtcMs;
    h.setHidden(true); fireVisibility(h); h.setPerf(10_000); runNextFrame(h);
    h.setHidden(false); fireVisibility(h); h.setPerf(10_100); runNextFrame(h);
    h.setHidden(true); fireVisibility(h); h.setPerf(20_100); runNextFrame(h);
    h.setHidden(false); fireVisibility(h); h.setPerf(20_200); runNextFrame(h);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(initial + 200);
    expect(h.runtime.getSnapshot().playState).toBe('playing');
    expect(h.frames.size).toBe(1); expect(h.listeners.size).toBe(1);
    expect(h.visibilityAdd).toHaveBeenCalledTimes(1); expect(h.visibilityRemove).not.toHaveBeenCalled();
  });

  it('keeps an ended replay ended across visibility changes', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([])) };
    const h = harness(reader); h.runtime.attach(); await flush(); h.runtime.play(); h.setPerf(999_999); runNextFrame(h);
    expect(h.runtime.getSnapshot().playState).toBe('ended');
    h.setHidden(true); fireVisibility(h); h.setHidden(false); fireVisibility(h);
    expect(h.runtime.getSnapshot().playState).toBe('ended');
  });

  it('settles a throwing import through finally and re-establishes', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush();
    const result = await h.runtime.runImport(SERIES, async () => { throw new Error('boom'); }); await flush();
    expect(result).toMatchObject({ ok: false, reason: 'write_failed' });
    expect(h.runtime.getSnapshot().importing).toBe(false);
    expect(reader.getLocalAvailability).toHaveBeenCalledTimes(2);
  });
});

describe('B2b private 1m execution authority and canonical barriers', () => {
  it.each(['1m', '5m', '15m', '1h'] as const)('fills from the latest revealed canonical 1m close while displaying %s', async (timeframe) => {
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => availability),
      readBars: vi.fn(async () => ok([bar(T0, 101.125), bar(T0 + 60_000, 999)])),
    };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000); h.runtime.setTimeframe(timeframe);
    const result = h.runtime.beginExecutionCommand(SERIES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fill).toEqual({ decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0,
      sourceBarCloseUtcMs: T0 + 60_000, price: 101.125, basis: 'revealed_1m_close' });
    expect(result.fill.price).not.toBe(999);
  });

  it('keeps HTF aggregation out of execution bar identity', async () => {
    const bars = [bar(T0, 1), bar(T0 + 60_000, 2), bar(T0 + 120_000, 3)];
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok(bars)) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 180_000); h.runtime.setTimeframe('5m');
    expect(h.runtime.getSnapshot().bars).toHaveLength(1);
    const result = h.runtime.beginExecutionCommand(SERIES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fill).toMatchObject({ sourceBarStartUtcMs: T0 + 120_000, sourceBarCloseUtcMs: T0 + 180_000, price: 3 });
  });

  it('rejects before the first close and excludes prefetched/future bars', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars: vi.fn(async () => ok([bar(T0), bar(T0 + 60_000, 999)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0);
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'no_closed_bar' });
    await h.runtime.goTo(T0 + 60_000);
    const result = h.runtime.beginExecutionCommand(SERIES);
    expect(result.ok && result.fill.price).toBe(1);
  });

  it('accepts freshness age 0 and 59,999 but rejects exactly 60,000 and market gaps', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0, 7)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000);
    expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true); h.runtime.releaseCanonicalCommand();
    await h.runtime.goTo(T0 + 60_000 + 59_999);
    expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true); h.runtime.releaseCanonicalCommand();
    await h.runtime.goTo(T0 + 120_000);
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'stale_quote' });
  });

  it('settles playing cursor and captures fill/progress once before persistence waiting', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0, 12.3456789)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000); h.runtime.setSpeed(5); h.runtime.play(); h.setPerf(1_000);
    const result = h.runtime.beginExecutionCommand(SERIES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.progress).toEqual({ cursorUtcMs: T0 + 65_000, displayTimeframe: '1m', speed: 5 });
    expect(result.fill.price).toBe(12.3456789);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
  });

  it('rejects series mismatch, loading, operational error, and detached capture', async () => {
    const waiting = deferred<HistoricalAvailability>();
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(() => waiting.promise), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader);
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
    h.runtime.attach(); await flush();
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
    waiting.resolve(availability); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000);
    expect(h.runtime.beginExecutionCommand({ ...SERIES, root: 'ES' })).toEqual({ ok: false, reason: 'series_mismatch' });
    h.runtime.detach();
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
  });

  it('action barrier rejects direct movement, series/import replacement, another action, and Complete', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000);
    expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
    const cursor = h.runtime.getSnapshot().nowUtcMs;
    h.runtime.play(); await h.runtime.stepForward(); await h.runtime.goTo(T0 + DAY_MS);
    h.runtime.selectSeries({ ...SERIES, root: 'ES' });
    expect(await h.runtime.runImport(SERIES, async () => commitOk)).toMatchObject({ ok: false, reason: 'command_pending' });
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'command_pending' });
    expect(h.runtime.beginCompletionCommand(SERIES)).toEqual({ ok: false, reason: 'command_pending' });
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursor);
    expect(h.runtime.getSnapshot().series).toEqual(SERIES);
  });

  it('completion barrier captures once, blocks commands, and releases explicitly', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000); h.runtime.setTimeframe('15m'); h.runtime.setSpeed(30);
    const complete = h.runtime.beginCompletionCommand(SERIES);
    expect(complete).toEqual({ ok: true, progress: { cursorUtcMs: T0 + 60_000, displayTimeframe: '15m', speed: 30 } });
    h.runtime.setTimeframe('1h'); h.runtime.setSpeed(300); h.runtime.play(); await h.runtime.goTo(T0 + DAY_MS);
    expect(h.runtime.getSnapshot()).toMatchObject({ nowUtcMs: T0 + 60_000, timeframe: '15m', speed: 30, playState: 'paused', canonicalBarrier: 'completion' });
    h.runtime.releaseCanonicalCommand(); h.runtime.setTimeframe('1h');
    expect(h.runtime.getSnapshot().timeframe).toBe('1h');
  });

  it('enforces the active session immutable-series lock below React', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000); h.runtime.setSessionSeriesLock(SERIES);
    h.runtime.selectSeries({ ...SERIES, root: 'ES' }); await flush();
    expect(h.runtime.getSnapshot().series).toEqual(SERIES);
    expect(await h.runtime.runImport({ ...SERIES, root: 'ES' }, async () => commitOk)).toMatchObject({ ok: false });
    h.runtime.setSessionSeriesLock(null); h.runtime.selectSeries({ ...SERIES, root: 'ES' }); await flush();
    expect(h.runtime.getSnapshot().series.root).toBe('ES');
  });

  it('blocks durable execution while rewound and blocks playback after a safety failure', async () => {
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars: vi.fn(async () => ok([bar(T0)])) };
    const h = harness(reader); h.runtime.attach(); await flush(); await h.runtime.resumeSession(SERIES, T0 + 60_000);
    h.runtime.setSessionMutationBlocked(true);
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
    await h.runtime.goTo(T0 + 120_000); // navigation remains available while rewound
    h.runtime.setSessionMutationBlocked(false); h.runtime.setSessionSafetyBlock(true); h.runtime.play();
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    expect(h.runtime.beginCompletionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
  });
});

/**
 * B2d Phase 2 — Step Backward runtime navigation.
 *
 * One press moves from the CURRENT revealed canonical 1m bar to the immediately
 * PREVIOUS EXISTING canonical 1m bar. The reader below answers real ranges so
 * the buffer, the coverage window and the committed-day traversal are exercised
 * as released rather than stubbed, and every target assertion is a bar-set fact
 * rather than a wall-clock offset.
 */
describe('production replay runtime Step Backward navigation', () => {
  const D01 = T0;                                       // 2016-03-01, Tuesday
  const FRI = Date.parse('2016-03-04T00:00:00Z');
  const D05 = Date.parse('2016-03-05T00:00:00Z');
  const MON = Date.parse('2016-03-07T00:00:00Z');
  const M = 60_000;

  const avail = (first: number, last: number, days: string[]): HistoricalAvailability =>
    ({ available: true, observedFirstUtcMs: first, observedLastUtcMs: last, observedDays: days });

  function rangeReader(bars: HistoricalBar[], availability: HistoricalAvailability) {
    const readBars = vi.fn(async (request: HistoricalReadRequest): Promise<HistoricalReadResult> =>
      ok(bars.filter((b) => b.t >= request.fromUtcMs && b.t < request.toUtcMs)));
    const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
    return { reader, readBars };
  }

  /**
   * Records EVERY runtime publish, because `startReestablish` publishes its
   * settled snapshot before its promise resolves to its caller: an intermediate
   * Step Backward state is observable to subscribers and must be safe on its
   * own, not merely overwritten by the final cursor.
   */
  function recordPublishes(h: ReturnType<typeof harness>) {
    const published: Array<{ nowUtcMs: number; starts: number[] }> = [];
    const stop = h.runtime.subscribe(() => {
      const snapshot = h.runtime.getSnapshot();
      published.push({ nowUtcMs: snapshot.nowUtcMs, starts: snapshot.bars.map((b) => b.t) });
    });
    return { published, stop };
  }

  const fourBars = [bar(D01), bar(D01 + M), bar(D01 + 2 * M), bar(D01 + 3 * M)];
  const fourBarAvailability = avail(D01, D01 + 4 * M, ['2016-03-01']);

  // A–D. The current bar is constant across [currentClose, nextClose), so every
  // cursor inside the bar that closed at +3m steps to the same predecessor.
  it.each([
    ['exactly on the current close', 3 * M],
    ['one millisecond after the close', 3 * M + 1],
    ['thirty seconds after the close', 3 * M + 30_000],
    ['one millisecond before the next close', 4 * M - 1],
  ])('steps to the same previous canonical bar with the cursor %s', async (_label, offset) => {
    const { reader } = rangeReader(fourBars, fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + offset);
    expect(await h.runtime.stepBackward()).toBe(true);   // B2d Phase 7A outcome
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 2 * M);
    h.runtime.detach();
  });

  it('crosses a missing minute in one press without synthesizing a bar', async () => {
    const { reader } = rangeReader([bar(D01), bar(D01 + M), bar(D01 + 3 * M)], fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + 4 * M);                 // current bar starts at +3m
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 2 * M); // close of the +1m bar
    h.runtime.detach();
  });

  it('crosses a multi-hour session gap in one press', async () => {
    const sixHours = 6 * 60 * M;
    const { reader, readBars } = rangeReader([bar(D01), bar(D01 + sixHours)], avail(D01, D01 + sixHours + M, ['2016-03-01']));
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + sixHours + M);
    const reads = readBars.mock.calls.length;
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + M);
    expect(readBars.mock.calls.length).toBe(reads);    // in-buffer path reads no history
    h.runtime.detach();
  });

  it('crosses a Friday-to-Monday weekend through committed days, not wall-clock days', async () => {
    const friday = FRI + 22 * 60 * M;
    const { reader, readBars } = rangeReader([bar(friday), bar(MON)], avail(friday, MON + M, ['2016-03-07', '2016-03-04']));
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(MON + M);                     // Monday's first bar is the current bar
    const before = readBars.mock.calls.length;
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(friday + M);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    // Exactly one reload: the current bar IS its day's first instant, so no
    // current-day reload is attempted, and the empty weekend days are skipped
    // by `observedDays` rather than stepped over one wall-clock day at a time.
    const reloads = readBars.mock.calls.slice(before);
    expect(reloads.map((call) => call[0].fromUtcMs)).toEqual([FRI]);
    h.runtime.detach();
  });

  it('selects the predecessor independently of reader bar order', async () => {
    const { reader } = rangeReader([bar(D01 + 3 * M), bar(D01), bar(D01 + 2 * M), bar(D01 + M)], fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + 4 * M);
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
    h.runtime.detach();
  });

  it('reloads the current committed day first, then the previous committed day', async () => {
    const late = D05 + 30 * M;
    const { reader, readBars } = rangeReader([bar(D01), bar(late)], avail(D01, late + M, ['2016-03-05', '2016-03-01']));
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(late + M);
    const before = readBars.mock.calls.length;
    expect(await h.runtime.stepBackward()).toBe(true);   // off-buffer success reports true
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + M);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    // Current committed day BEFORE the previous committed day: an absent
    // predecessor does not prove it belongs to an earlier day.
    const reloads = readBars.mock.calls.slice(before).map((call) => call[0].fromUtcMs);
    expect(reloads).toEqual([D05, D01]);
    // 03-02 .. 03-04 are not committed days and are never requested.
    expect(readBars.mock.calls.some((call) => call[0].fromUtcMs === FRI)).toBe(false);
    h.runtime.detach();
  });

  it('is a no-op at the absolute first available bar and issues no reload', async () => {
    const { reader, readBars } = rangeReader([bar(D01)], avail(D01, D01 + M, ['2016-03-01']));
    const h = harness(reader); h.runtime.attach(); await flush();
    const cursor = h.runtime.getSnapshot().nowUtcMs;
    expect(cursor).toBe(D01 + M);
    expect(await h.runtime.stepBackward()).toBe(false);  // first available bar has no predecessor
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursor);
    expect(h.runtime.getSnapshot().error).toBeNull();
    expect(readBars).toHaveBeenCalledTimes(1);
    h.runtime.detach();
  });

  it('is a no-op with unavailable availability and issues no reload', async () => {
    const late = D05 + 30 * M;
    const { reader, readBars } = rangeReader([bar(D01), bar(late)], { available: false });
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(late + M);
    const reads = readBars.mock.calls.length;
    expect(await h.runtime.stepBackward()).toBe(false);  // unavailable history cannot step
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(late + M);
    expect(readBars.mock.calls.length).toBe(reads);
    h.runtime.detach();
  });

  it('publishes no cursor when the off-buffer reload fails', async () => {
    const late = D05 + 30 * M;
    const bars = [bar(D01), bar(late)];
    let calls = 0;
    const readBars = vi.fn(async (request: HistoricalReadRequest): Promise<HistoricalReadResult> => {
      calls += 1;
      if (calls > 2) return { ok: false, reason: 'read_failed', message: 'broken' };
      return ok(bars.filter((b) => b.t >= request.fromUtcMs && b.t < request.toUtcMs));
    });
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => avail(D01, late + M, ['2016-03-05', '2016-03-01'])), readBars,
    };
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(late + M);
    expect(await h.runtime.stepBackward()).toBe(false);         // a failed reload is not a step
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(late + M);   // no fabricated predecessor
    expect(h.runtime.getSnapshot().error).toBe('broken');
    expect(readBars).toHaveBeenCalledTimes(3);                 // stops at the first failure
    h.runtime.detach();
  });

  it('publishes no cursor when a newer session resume supersedes the off-buffer reload', async () => {
    const late = D05 + 30 * M;
    const bars = [bar(D01), bar(D01 + M), bar(late)];
    const stale = deferred<HistoricalReadResult>();
    let calls = 0;
    const readBars = vi.fn((request: HistoricalReadRequest): Promise<HistoricalReadResult> => {
      calls += 1;
      if (calls === 3) return stale.promise;
      return Promise.resolve(ok(bars.filter((b) => b.t >= request.fromUtcMs && b.t < request.toUtcMs)));
    });
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => avail(D01, late + M, ['2016-03-05', '2016-03-01'])), readBars,
    };
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(late + M);
    const back = h.runtime.stepBackward(); await flush();      // suspended in the current-day reload
    const resume = h.runtime.resumeSession(SERIES, D01 + 3 * M);
    stale.resolve(ok([bar(late)])); await flush();
    expect(await resume).toBe(true);
    expect(await back).toBe(false);                    // superseded: the step did not apply
    // The superseded step never publishes; the winning resume owns the cursor.
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
    h.runtime.detach();
  });

  it('refuses to navigate under an action barrier and resumes after release', async () => {
    const { reader } = rangeReader(fourBars, fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.resumeSession(SERIES, D01 + 3 * M);   // capture requires the matching series
    expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
    expect(await h.runtime.stepBackward()).toBe(false);   // barrier rejection
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
    h.runtime.releaseCanonicalCommand();
    expect(await h.runtime.stepBackward()).toBe(true);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 2 * M);
    h.runtime.detach();
  });

  it('refuses to navigate while the session safety block is engaged', async () => {
    const { reader } = rangeReader(fourBars, fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + 3 * M);
    h.runtime.setSessionSafetyBlock(true);
    expect(await h.runtime.stepBackward()).toBe(false);   // safety rejection
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
    h.runtime.setSessionSafetyBlock(false);
    expect(await h.runtime.stepBackward()).toBe(true);
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 2 * M);
    h.runtime.detach();
  });

  // R. Canonical 1m step size at every display timeframe, from aligned and
  // non-aligned cursors, mirroring the released stepForward symmetry.
  it.each(['1m', '5m', '15m', '1h'] as const)(
    'steps back one canonical 1m bar while displaying %s', async (timeframe) => {
      const { reader } = rangeReader(fourBars, fourBarAvailability);
      const h = harness(reader); h.runtime.attach(); await flush();
      await h.runtime.goTo(D01 + 4 * M); h.runtime.setTimeframe(timeframe);
      // The display really is aggregated, so the assertion below is not vacuous.
      expect(h.runtime.getSnapshot().bars).toHaveLength(timeframe === '1m' ? 4 : 1);
      await h.runtime.stepBackward();
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);

      await h.runtime.goTo(D01 + 4 * M + 30_000);
      await h.runtime.stepBackward();
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
      expect(h.runtime.getSnapshot().timeframe).toBe(timeframe);
      h.runtime.detach();
    });

  it('ends paused, starts no second playback loop, and issues no execution command', async () => {
    const { reader, readBars } = rangeReader(fourBars, fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D01 + 3 * M);
    h.runtime.play();
    expect(h.runtime.getSnapshot().playState).toBe('playing');
    const frames = [...h.frames.keys()]; const reads = readBars.mock.calls.length;
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    expect([...h.frames.keys()]).toEqual(frames);      // no extra frame, no second clock
    expect(readBars.mock.calls.length).toBe(reads);
    expect(h.runtime.getSnapshot().canonicalBarrier).toBeNull();
    h.runtime.detach();
  });

  it('owns navigation only and leaves the released rewind blocking chain downstream', async () => {
    const { reader } = rangeReader(fourBars, fourBarAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.resumeSession(SERIES, D01 + 4 * M);   // capture requires the matching series
    await h.runtime.stepBackward();
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(D01 + 3 * M);
    // Step Backward blocks nothing by itself: capture is still available.
    expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
    h.runtime.releaseCanonicalCommand();
    // The released chain (projection.rewound -> setSessionMutationBlocked) is
    // what blocks execution below the high-water mark, unchanged by this phase.
    h.runtime.setSessionMutationBlocked(true);
    expect(h.runtime.beginExecutionCommand(SERIES)).toEqual({ ok: false, reason: 'not_ready' });
    h.runtime.detach();
  });

  // ── B2d Phase 2.1 — off-buffer no-look-ahead ──────────────────
  //
  // The current bar can be the FIRST EXISTING bar of its UTC day at a
  // non-midnight session time, with later bars of that same day already in the
  // retained buffer. The current-day reload must therefore never publish a
  // cursor beyond the origin cursor, or it would transiently reveal those later
  // bars to every subscriber.
  const sessionOpen = D05 + 14 * 60 * M + 30 * M;      // 2016-03-05 14:30 UTC
  const priorDayBar = D01 + 20 * 60 * M;               // previous committed day
  const sameDayFuture = [sessionOpen + M, sessionOpen + 2 * M, D05 + 15 * 60 * M];
  const sessionBars = [bar(priorDayBar), bar(sessionOpen), ...sameDayFuture.map((t) => bar(t))];
  const sessionAvailability = avail(priorDayBar, D05 + 15 * 60 * M + M, ['2016-03-05', '2016-03-01']);

  it('reloads the current committed day without ever revealing a later same-day bar', async () => {
    const { reader, readBars } = rangeReader(sessionBars, sessionAvailability);
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(sessionOpen + M);              // origin: only the 14:30 bar is revealed
    const originCursor = h.runtime.getSnapshot().nowUtcMs;
    expect(h.runtime.getSnapshot().bars.map((b) => b.t)).toEqual([sessionOpen]);
    const originHorizon = sessionOpen;
    const reads = readBars.mock.calls.length;
    const { published, stop } = recordPublishes(h);

    await h.runtime.stepBackward();

    expect(published.length).toBeGreaterThan(0);        // the assertions below are not vacuous
    // 1. the current committed day is reloaded first, the previous one second
    expect(readBars.mock.calls.slice(reads).map((call) => call[0].fromUtcMs)).toEqual([D05, D01]);
    // 2. replay time never moves forward during the operation
    for (const entry of published) expect(entry.nowUtcMs).toBeLessThanOrEqual(originCursor);
    // 3. no publish reveals anything past the origin revealed horizon
    for (const entry of published) for (const start of entry.starts) expect(start).toBeLessThanOrEqual(originHorizon);
    // 5. the later same-day bars are never observably revealed
    for (const entry of published) for (const future of sameDayFuture) expect(entry.starts).not.toContain(future);
    // 4. the final cursor is the real previous existing bar's close
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(priorDayBar + M);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    stop(); h.runtime.detach();
  });

  it('floors the current-day reload onto the current bar day for a 23:59 UTC bar', async () => {
    const lateBar = D05 + DAY_MS - M;                  // starts 23:59, closes at 00:00 next day
    const nextDayBar = D05 + DAY_MS + 5 * M;           // 2016-03-06 00:05 — must stay hidden
    const bars = [bar(priorDayBar), bar(lateBar), bar(nextDayBar)];
    const { reader, readBars } = rangeReader(bars,
      avail(priorDayBar, nextDayBar + M, ['2016-03-01', '2016-03-05', '2016-03-06']));
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(D05 + 12 * 60 * M);            // keeps coverage on 03-05
    await h.runtime.stepForward();                     // reveals the 23:59 bar at its 00:00 close
    const originCursor = h.runtime.getSnapshot().nowUtcMs;
    expect(originCursor).toBe(D05 + DAY_MS);
    expect(h.runtime.getSnapshot().bars.map((b) => b.t)).toEqual([lateBar]);
    const reads = readBars.mock.calls.length;
    const { published, stop } = recordPublishes(h);

    await h.runtime.stepBackward();

    // `currentBarStart + MINUTE_MS` would have floored onto 03-06 and loaded the
    // WRONG day; the clamped day-end target stays on 03-06's predecessor day.
    expect(readBars.mock.calls.slice(reads).map((call) => call[0].fromUtcMs)).toEqual([D05, D01]);
    expect(published.length).toBeGreaterThan(0);
    for (const entry of published) {
      expect(entry.nowUtcMs).toBeLessThanOrEqual(originCursor);
      expect(entry.starts).not.toContain(nextDayBar);
      for (const start of entry.starts) expect(start).toBeLessThanOrEqual(lateBar);
    }
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(priorDayBar + M);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    stop(); h.runtime.detach();
  });

  it('crosses a weekend from a non-midnight session open without revealing later session bars', async () => {
    const friday = FRI + 21 * 60 * M;                  // previous committed day
    const open = MON + 9 * 60 * M + 31 * M;            // Monday session open, not UTC midnight
    const later = [open + M, MON + 10 * 60 * M, MON + 16 * 60 * M];
    const bars = [bar(friday), bar(open), ...later.map((t) => bar(t))];
    const { reader, readBars } = rangeReader(bars,
      avail(friday, MON + 16 * 60 * M + M, ['2016-03-07', '2016-03-04']));
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(open + M);
    const originCursor = h.runtime.getSnapshot().nowUtcMs;
    const reads = readBars.mock.calls.length;
    const { published, stop } = recordPublishes(h);

    await h.runtime.stepBackward();

    expect(readBars.mock.calls.slice(reads).map((call) => call[0].fromUtcMs)).toEqual([MON, FRI]);
    for (const entry of published) {
      expect(entry.nowUtcMs).toBeLessThanOrEqual(originCursor);
      for (const future of later) expect(entry.starts).not.toContain(future);
    }
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(friday + M);
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    stop(); h.runtime.detach();
  });

  it('keeps the current-day reload safe when the previous-day reload then fails', async () => {
    let calls = 0;
    const readBars = vi.fn(async (request: HistoricalReadRequest): Promise<HistoricalReadResult> => {
      calls += 1;
      if (calls > 3) return { ok: false, reason: 'read_failed', message: 'broken' };
      return ok(sessionBars.filter((b) => b.t >= request.fromUtcMs && b.t < request.toUtcMs));
    });
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => sessionAvailability), readBars,
    };
    const h = harness(reader); h.runtime.attach(); await flush();
    await h.runtime.goTo(sessionOpen + M);
    const originCursor = h.runtime.getSnapshot().nowUtcMs;
    const { published, stop } = recordPublishes(h);

    // Item B is FROZEN: the accepted intermediate window may survive, and the
    // requested predecessor step is still reported as not applied.
    expect(await h.runtime.stepBackward()).toBe(false);

    expect(readBars).toHaveBeenCalledTimes(4);         // current day ok, previous day fails
    for (const entry of published) {
      expect(entry.nowUtcMs).toBeLessThanOrEqual(originCursor);
      for (const future of sameDayFuture) expect(entry.starts).not.toContain(future);
    }
    // Honest final state: no predecessor is fabricated, the released read-failure
    // behaviour is intact, and the cursor is exactly the origin cursor because
    // the clamped current-day reload target IS the origin cursor here.
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(originCursor);
    expect(h.runtime.getSnapshot().bars.map((b) => b.t)).toEqual([sessionOpen]);
    expect(h.runtime.getSnapshot().error).toBe('broken');
    expect(h.runtime.getSnapshot().playState).toBe('paused');
    stop(); h.runtime.detach();
  });
});

/**
 * B2d Phase 7A — the NAVIGATION OUTCOME CONTRACT.
 *
 * Each command reports whether the requested navigation was applied and
 * published. Every value below is a fact the released runtime already computed
 * — the reestablish commit decision, the next-bar selection, the released
 * command guards — and the state assertions that accompany them are unchanged:
 * a returned boolean is proven against what the snapshot actually did.
 *
 * The boolean is deliberately narrow. It says nothing about storage health,
 * checkpoint progress, execution permission, overlay eligibility or session
 * mutability, and no test here asserts otherwise.
 */
describe('B2d Phase 7A navigation outcome contract', () => {
  const M = 60_000;
  const okReader = (bars: HistoricalBar[], avail = availability): HistoricalBarReader =>
    ({ getLocalAvailability: vi.fn(async () => avail), readBars: vi.fn(async () => ok(bars)) });

  describe('goTo', () => {
    it('reports a successful in-range navigation and its published cursor', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M)])); h.runtime.attach(); await flush();
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(true);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 5 * M);
      h.runtime.detach();
    });

    it('reports a successful historical reestablish that reloads its coverage window', async () => {
      const later = T0 + 3 * DAY_MS;
      const reader: HistoricalBarReader = {
        getLocalAvailability: vi.fn(async () => wideAvailability),
        readBars: vi.fn(async (request: HistoricalReadRequest) =>
          ok([bar(T0), bar(later)].filter((b) => b.t >= request.fromUtcMs && b.t < request.toUtcMs))),
      };
      const h = harness(reader); h.runtime.attach(); await flush();
      expect(await h.runtime.goTo(later + M)).toBe(true);
      expect(h.runtime.getSnapshot().coverageStartUtcMs).toBe(T0 + 3 * DAY_MS);
      h.runtime.detach();
    });

    it('reports failure for an unavailable historical series and leaves the cursor alone', async () => {
      const readBars = vi.fn()
        .mockResolvedValueOnce(ok([bar(T0)]))
        .mockResolvedValue({ ok: false, reason: 'series_unavailable', message: 'gone' });
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      const before = h.runtime.getSnapshot().nowUtcMs;
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(before);
      expect(h.runtime.getSnapshot().error).toBe('This historical series is unavailable.');
      h.runtime.detach();
    });

    it('reports failure for a reader failure and for a throwing reader', async () => {
      const readBars = vi.fn()
        .mockResolvedValueOnce(ok([bar(T0)]))
        .mockResolvedValueOnce({ ok: false, reason: 'read_failed', message: 'broken' })
        .mockRejectedValueOnce(new Error('io'));
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(false);
      expect(h.runtime.getSnapshot().error).toBe('broken');
      expect(await h.runtime.goTo(T0 + 6 * M)).toBe(false);
      expect(h.runtime.getSnapshot().error).toBe('Historical bars could not be read.');
      h.runtime.detach();
    });

    it('reports failure for the superseded request and success for the winner', async () => {
      const first = deferred<HistoricalReadResult>();
      const readBars = vi.fn()
        .mockResolvedValueOnce(ok([bar(T0)]))
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(ok([bar(T0), bar(T0 + M)]));
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      const superseded = h.runtime.goTo(T0 + 5 * M); await flush();
      const winner = h.runtime.goTo(T0 + 7 * M);
      first.resolve(ok([bar(T0)])); await flush();
      expect(await winner).toBe(true);
      expect(await superseded).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 7 * M);
      h.runtime.detach();
    });

    it('reports failure under a canonical command barrier and under the safety block', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M)])); h.runtime.attach(); await flush();
      await h.runtime.resumeSession(SERIES, T0 + 2 * M);
      expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 2 * M);
      h.runtime.releaseCanonicalCommand();

      h.runtime.setSessionSafetyBlock(true);
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(false);
      h.runtime.setSessionSafetyBlock(false);
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(true);
      h.runtime.detach();
    });

    it('reports failure for a target that is not a safe integer', async () => {
      const h = harness(okReader([bar(T0)])); h.runtime.attach(); await flush();
      const before = h.runtime.getSnapshot().nowUtcMs;
      expect(await h.runtime.goTo(Number.NaN)).toBe(false);
      expect(await h.runtime.goTo(T0 + 0.5)).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(before);
      h.runtime.detach();
    });

    it('reports failure while detached, because no reestablish can commit', async () => {
      const h = harness(okReader([bar(T0)]));
      expect(await h.runtime.goTo(T0 + 5 * M)).toBe(false);
    });

    /**
     * Source-grounded, NOT special-cased for history UX: a Go To onto the
     * current cursor is a real reestablish, so it reports what that operation
     * did rather than a synthetic "nothing changed".
     */
    it('reports the same-cursor request exactly as its reestablish resolved', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M)])); h.runtime.attach(); await flush();
      const cursor = h.runtime.getSnapshot().nowUtcMs;
      expect(await h.runtime.goTo(cursor)).toBe(true);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursor);
      h.runtime.detach();
    });
  });

  describe('stepForward', () => {
    it('reports true for an adjacent bar and for a gap crossing', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M), bar(T0 + 5 * M)]));
      h.runtime.attach(); await flush();
      await h.runtime.goTo(T0 + M);
      expect(await h.runtime.stepForward()).toBe(true);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 2 * M);
      expect(await h.runtime.stepForward()).toBe(true);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 6 * M);   // the gap was crossed
      h.runtime.detach();
    });

    it('reports true when a coverage extension reveals the next bar', async () => {
      const future = bar(T0 + 2 * DAY_MS, 99);
      const readBars = vi.fn()
        .mockResolvedValueOnce(ok([bar(T0)]))
        .mockResolvedValue(ok([future]));
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      expect(await h.runtime.stepForward()).toBe(true);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(future.t + M);
      expect(h.runtime.getSnapshot().coverageEndUtcMs).toBe(T0 + 3 * DAY_MS);
      h.runtime.detach();
    });

    it('reports false at the end of the available data without publishing a cursor', async () => {
      // One bar only: the cursor already sits at its close, so there is no
      // later bar and no committed coverage left to extend into.
      const h = harness(okReader([bar(T0)])); h.runtime.attach(); await flush();
      const settled = h.runtime.getSnapshot().nowUtcMs;
      expect(settled).toBe(T0 + M);
      expect(await h.runtime.stepForward()).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(settled);
      h.runtime.detach();
    });

    it('reports false when the extension that could reveal a next bar fails', async () => {
      const readBars = vi.fn()
        .mockResolvedValueOnce(ok([bar(T0)]))
        .mockResolvedValue({ ok: false, reason: 'read_failed', message: 'broken' });
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => wideAvailability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      const before = h.runtime.getSnapshot().nowUtcMs;
      expect(await h.runtime.stepForward()).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(before);
      h.runtime.detach();
    });

    /**
     * An extension that STOPS is not itself a failed step: a bar already in the
     * buffer settles the step, and the outcome follows the cursor, not the read.
     */
    it('reports true from the buffer even when no extension is attempted', async () => {
      const readBars = vi.fn().mockResolvedValueOnce(ok([bar(T0), bar(T0 + M)]));
      const reader: HistoricalBarReader = { getLocalAvailability: vi.fn(async () => availability), readBars };
      const h = harness(reader); h.runtime.attach(); await flush();
      expect(await h.runtime.stepForward()).toBe(true);
      expect(readBars).toHaveBeenCalledTimes(1);                   // no extension was needed
      h.runtime.detach();
    });

    it('reports false under a canonical command barrier and under the safety block', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M)])); h.runtime.attach(); await flush();
      await h.runtime.resumeSession(SERIES, T0 + M);
      expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
      expect(await h.runtime.stepForward()).toBe(false);
      h.runtime.releaseCanonicalCommand();
      h.runtime.setSessionSafetyBlock(true);
      expect(await h.runtime.stepForward()).toBe(false);
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + M);
      h.runtime.detach();
    });
  });

  describe('setTimeframe', () => {
    it('reports true for an accepted change and publishes the derived bars', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M), bar(T0 + 2 * M)]));
      h.runtime.attach(); await flush();
      await h.runtime.goTo(T0 + 3 * M);
      expect(h.runtime.setTimeframe('5m')).toBe(true);
      expect(h.runtime.getSnapshot().timeframe).toBe('5m');
      h.runtime.detach();
    });

    it('reports false under a canonical command barrier and under the safety block', async () => {
      const h = harness(okReader([bar(T0), bar(T0 + M)])); h.runtime.attach(); await flush();
      await h.runtime.resumeSession(SERIES, T0 + 2 * M);
      expect(h.runtime.beginExecutionCommand(SERIES).ok).toBe(true);
      expect(h.runtime.setTimeframe('5m')).toBe(false);
      expect(h.runtime.getSnapshot().timeframe).toBe('1m');        // unchanged
      h.runtime.releaseCanonicalCommand();

      h.runtime.setSessionSafetyBlock(true);
      expect(h.runtime.setTimeframe('5m')).toBe(false);
      expect(h.runtime.getSnapshot().timeframe).toBe('1m');
      h.runtime.setSessionSafetyBlock(false);
      expect(h.runtime.setTimeframe('5m')).toBe(true);
      h.runtime.detach();
    });

    /**
     * Characterization of the RELEASED semantics, unchanged by Phase 7A: the
     * display timeframe is a view transform over the same canonical buffer, so
     * neither an import barrier nor an already-current value rejects it.
     */
    it('accepts the timeframe already in effect', async () => {
      const h = harness(okReader([bar(T0)])); h.runtime.attach(); await flush();
      expect(h.runtime.getSnapshot().timeframe).toBe('1m');
      expect(h.runtime.setTimeframe('1m')).toBe(true);
      h.runtime.detach();
    });

    it('is not gated on the import barrier', async () => {
      const commit = deferred<typeof commitOk>();
      const h = harness(okReader([bar(T0)])); h.runtime.attach(); await flush();
      const importing = h.runtime.runImport(SERIES, () => commit.promise); await flush();
      expect(h.runtime.getSnapshot().importing).toBe(true);
      expect(h.runtime.setTimeframe('15m')).toBe(true);
      expect(h.runtime.getSnapshot().timeframe).toBe('15m');
      commit.resolve(commitOk); await importing; await flush();
      h.runtime.detach();
    });
  });
});
