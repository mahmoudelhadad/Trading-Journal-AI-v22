import { describe, expect, it, vi } from 'vitest';
import { createReplayRuntime, type ReplayRuntimeDependencies } from './replayRuntime.js';
import type { HistoricalAvailability, HistoricalBarReader, HistoricalReadResult } from './historicalBarReader.js';
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
