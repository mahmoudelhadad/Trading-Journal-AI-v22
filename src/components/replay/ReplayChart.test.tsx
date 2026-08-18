// @vitest-environment jsdom
/**
 * components/replay/ReplayChart.test.tsx
 *
 * B2d Phase 0 characterization (retained) + Phase 3 primitive lifecycle.
 *
 * The Phase-0 released baseline is preserved verbatim in intent: one chart, one
 * candlestick series, reactive `setData`, the ResizeObserver path, complete
 * teardown, and `subscribeCrosshairMove` at zero — the final RFC rejected a
 * cached-crosshair coordinate authority, so the native `contextmenu` event is
 * the only coordinate source. `subscribeClick` also stays at zero: Select Bar is
 * a later phase.
 *
 * Phase 3 adds the marker-plugin lifecycle, the AVG/STOP price-line
 * reconciliation, and the right-click coordinate plumbing.
 *
 * `lightweight-charts` is mocked, so this proves CALL SEQUENCING, LIFECYCLE,
 * PRIMITIVE COUNTS, MAPPING, CLEANUP and COORDINATE DELEGATION ONLY. It proves
 * nothing about pixels, marker placement, line visibility or overlap quality —
 * those belong to browser Runtime Acceptance.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayChart, type ReplayChartContextRequest, type ReplayChartProps } from './ReplayChart.js';
import { EMPTY_OVERLAY, type MarkerClass, type OverlayMarker, type ReplayOverlay } from '@calculations/replayOverlay.js';
import type { HistoricalBar } from '@apptypes/marketData.js';

const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const coordinateToPrice = vi.fn((y: number) => 5000 - y);
  const createdLines: Array<{ price: number; title: string; applyOptions: ReturnType<typeof vi.fn> }> = [];
  const createPriceLine = vi.fn((options: { price: number; title: string }) => {
    const line = { price: options.price, title: options.title, applyOptions: vi.fn() };
    createdLines.push(line);
    return line;
  });
  const removePriceLine = vi.fn();
  const series = { setData, createPriceLine, removePriceLine, coordinateToPrice };
  const addSeries = vi.fn(() => series);
  const applyOptions = vi.fn();
  const remove = vi.fn();
  const subscribeCrosshairMove = vi.fn();
  const unsubscribeCrosshairMove = vi.fn();
  const subscribeClick = vi.fn();
  const unsubscribeClick = vi.fn();
  const coordinateToTime = vi.fn((x: number) => 1_456_790_400 + x);
  const timeScaleWidth = vi.fn(() => 800);
  const timeScaleHeight = vi.fn(() => 30);
  const timeScale = vi.fn(() => ({ width: timeScaleWidth, height: timeScaleHeight, coordinateToTime }));
  // One stable element per mounted chart, so the component's captured reference
  // and the test's dispatch target are the same node.
  let element: HTMLDivElement | null = null;
  const chartElement = vi.fn(() => {
    if (element === null) element = document.createElement('div');
    return element;
  });
  const chart = {
    addSeries, applyOptions, remove, timeScale,
    subscribeCrosshairMove, unsubscribeCrosshairMove, subscribeClick, unsubscribeClick, chartElement,
  };
  const createChart = vi.fn(() => chart);
  const setMarkers = vi.fn();
  const detach = vi.fn();
  const markersPlugin = { setMarkers, detach, markers: vi.fn(() => []) };
  const createSeriesMarkers = vi.fn(() => markersPlugin);
  return {
    setData, series, coordinateToPrice, createPriceLine, removePriceLine, createdLines,
    addSeries, applyOptions, remove, subscribeCrosshairMove, subscribeClick, unsubscribeClick,
    timeScale, timeScaleWidth, timeScaleHeight, coordinateToTime, chartElement, chart, createChart,
    createSeriesMarkers, markersPlugin, setMarkers, detach,
    reset() { createdLines.length = 0; element = null; },
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
  CandlestickSeries: 'CandlestickSeries',
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
}));

const bar = (t: number, p: number): HistoricalBar => ({ t, o: p, h: p + 2, l: p - 2, c: p + 1, v: 7 });
const T0 = Date.parse('2016-03-01T00:00:00Z');
const LONG = '#22C55E';
const SHORT = '#EF4444';
const NEUTRAL = '#C8D6E8';

/** `Array.prototype.at` is outside this project's configured lib target. */
const last = <T,>(items: readonly T[]): T => items[items.length - 1];
const lastMarkerArray = (): Array<{ time: number; id: string }> =>
  last(chartMocks.setMarkers.mock.calls)[0] as Array<{ time: number; id: string }>;

const marker = (klass: MarkerClass, over: Partial<OverlayMarker> = {}): OverlayMarker => ({
  actionId: `id-${klass}`, anchorUtcMs: T0, klass, quantity: 3, sequence: 1, ...over,
});
const overlayOf = (
  markers: readonly OverlayMarker[], lines: ReplayOverlay['lines'] = [],
): ReplayOverlay => ({ markers, lines });

/** jsdom implements no ResizeObserver; this stub captures the released callback. */
let resizeCallbacks: Array<() => void> = [];
let observeCount = 0;
let disconnectCount = 0;

class TestResizeObserver {
  constructor(callback: () => void) { resizeCallbacks.push(callback); }
  observe(): void { observeCount += 1; }
  unobserve(): void { /* released code does not call this */ }
  disconnect(): void { disconnectCount += 1; }
}

const roots: Array<{ root: Root; container: HTMLElement }> = [];

/** Viewport offset + plot geometry: plot is x <= 800 and y <= 520 - 30. */
const RECT = { left: 50, top: 20, width: 900, height: 520, right: 950, bottom: 540, x: 50, y: 20 };

function stubChartElementRect() {
  const element = chartMocks.chartElement();
  element.getBoundingClientRect = () => RECT as DOMRect;
  return element;
}

function rightClick(clientX: number, clientY: number) {
  const element = stubChartElementRect();
  const event = new MouseEvent('contextmenu', { clientX, clientY, bubbles: true, cancelable: true });
  act(() => { element.dispatchEvent(event); });
  return event;
}

async function render(props: Partial<ReplayChartProps> = {}) {
  const resolved = { bars: [bar(T0, 100)], overlay: EMPTY_OVERLAY, ...props };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<ReplayChart {...resolved} />); });
  return {
    container,
    rerender: async (next: Partial<ReplayChartProps> = {}) => {
      await act(async () => { root.render(<ReplayChart {...{ ...resolved, ...next }} />); });
    },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

beforeEach(() => {
  resizeCallbacks = []; observeCount = 0; disconnectCount = 0;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  chartMocks.reset();
});

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  document.body.innerHTML = '';
});

describe('ReplayChart — released construction lifecycle (B2d Phase 0)', () => {
  it('constructs exactly one chart and one candlestick series for the whole lifetime', async () => {
    const view = await render();
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.addSeries).toHaveBeenCalledTimes(1);
    expect(chartMocks.addSeries).toHaveBeenCalledWith('CandlestickSeries', expect.any(Object));

    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 101)] });
    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 101), bar(T0 + 120_000, 102)] });
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.addSeries).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible chart container', async () => {
    const view = await render({ bars: [] });
    const host = view.container.querySelector('[aria-label]');
    expect(host?.getAttribute('aria-label')).toBe('Historical replay candlestick chart');
  });
});

describe('ReplayChart — released data reactivity (B2d Phase 0)', () => {
  it('maps bars to seconds-based candlestick points on mount', async () => {
    await render({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    expect(chartMocks.setData).toHaveBeenCalledTimes(1);
    expect(chartMocks.setData.mock.calls[0][0]).toEqual([
      { time: T0 / 1000, open: 100, high: 102, low: 98, close: 101 },
      { time: (T0 + 60_000) / 1000, open: 200, high: 202, low: 198, close: 201 },
    ]);
  });

  it('re-sets data on every bars change without recreating the chart', async () => {
    const view = await render();
    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    expect(chartMocks.setData).toHaveBeenCalledTimes(2);
    expect(chartMocks.setData.mock.calls[1][0]).toHaveLength(2);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty bar set', async () => {
    await render({ bars: [] });
    expect(chartMocks.setData).toHaveBeenCalledWith([]);
  });
});

describe('ReplayChart — released resize and teardown (B2d Phase 0)', () => {
  it('observes the container and applies width through the ResizeObserver path', async () => {
    await render();
    expect(observeCount).toBe(1);
    expect(resizeCallbacks).toHaveLength(1);
    chartMocks.applyOptions.mockClear();
    act(() => { resizeCallbacks[0](); });
    expect(chartMocks.applyOptions).toHaveBeenCalledTimes(1);
    expect(chartMocks.applyOptions.mock.calls[0][0]).toHaveProperty('width');
  });

  it('disconnects the observer and removes the chart exactly once on unmount', async () => {
    const view = await render();
    expect(chartMocks.remove).not.toHaveBeenCalled();
    await view.unmount();
    expect(disconnectCount).toBe(1);
    expect(chartMocks.remove).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayChart — B2d forward guards (baseline must stay at zero)', () => {
  it('never subscribes to crosshair movement', async () => {
    const view = await render({ overlay: overlayOf([marker('entry_long')], [{ kind: 'basis', price: 4800 }]) });
    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    rightClick(400, 200);
    // The RFC rejected a cached-crosshair coordinate authority; Phase 6A's Select
    // Bar uses the chart's own click event instead, never a movement cache.
    expect(chartMocks.subscribeCrosshairMove).not.toHaveBeenCalled();
  });

  it('creates no price line while the overlay carries no lines', async () => {
    const view = await render({ overlay: overlayOf([marker('entry_long')]) });
    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    expect(chartMocks.createPriceLine).not.toHaveBeenCalled();
    expect(chartMocks.removePriceLine).not.toHaveBeenCalled();
  });
});

describe('ReplayChart — B2d Phase 3 marker plugin lifecycle', () => {
  it('creates the marker plugin exactly once and never recreates it', async () => {
    const view = await render({ overlay: EMPTY_OVERLAY });
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    // Attached to the one candlestick series, empty, above the series.
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledWith(
      chartMocks.series, [], { zOrder: 'aboveSeries' });

    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    await view.rerender({ overlay: overlayOf([marker('entry_long')]) });
    await view.rerender({ overlay: overlayOf([marker('entry_long'), marker('final_long')]) });
    await view.rerender({ overlay: EMPTY_OVERLAY });
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
  });

  it('maps every marker class to its frozen presentation', async () => {
    const classes: MarkerClass[] = [
      'entry_long', 'entry_short', 'scale_long', 'scale_short',
      'partial_long', 'partial_short', 'final_long', 'final_short',
    ];
    const markers = classes.map((klass, index) => marker(klass, { quantity: index + 1 }));
    await render({ overlay: overlayOf(markers) });
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([
      { time: T0 / 1000, position: 'belowBar', shape: 'arrowUp',   color: LONG,    id: 'id-entry_long',    text: 'B 1' },
      { time: T0 / 1000, position: 'aboveBar', shape: 'arrowDown', color: SHORT,   id: 'id-entry_short',   text: 'S 2' },
      { time: T0 / 1000, position: 'belowBar', shape: 'arrowUp',   color: LONG,    id: 'id-scale_long',    text: '+3' },
      { time: T0 / 1000, position: 'aboveBar', shape: 'arrowDown', color: SHORT,   id: 'id-scale_short',   text: '+4' },
      { time: T0 / 1000, position: 'aboveBar', shape: 'circle',    color: NEUTRAL, id: 'id-partial_long',  text: '-5' },
      { time: T0 / 1000, position: 'belowBar', shape: 'circle',    color: NEUTRAL, id: 'id-partial_short', text: '-6' },
      { time: T0 / 1000, position: 'aboveBar', shape: 'square',    color: NEUTRAL, id: 'id-final_long',    text: 'X 7' },
      { time: T0 / 1000, position: 'belowBar', shape: 'square',    color: NEUTRAL, id: 'id-final_short',   text: 'X 8' },
    ]);
  });

  it('converts each anchor to chart seconds and keeps several markers in one bucket', async () => {
    const anchor = T0 + 15 * 60_000;
    await render({ overlay: overlayOf([
      marker('entry_long', { actionId: 'a1', anchorUtcMs: anchor, sequence: 1 }),
      marker('scale_long', { actionId: 'a2', anchorUtcMs: anchor, sequence: 2 }),
      marker('partial_long', { actionId: 'a3', anchorUtcMs: anchor + 60_000, sequence: 3 }),
    ]) });
    const sent = lastMarkerArray();
    expect(sent.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3']);   // upstream order preserved
    expect(sent.map((entry) => entry.time)).toEqual([anchor / 1000, anchor / 1000, (anchor + 60_000) / 1000]);
  });

  it('sends an empty marker array for an empty overlay and detaches once on unmount', async () => {
    const view = await render({ overlay: EMPTY_OVERLAY });
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([]);
    expect(chartMocks.detach).not.toHaveBeenCalled();
    await view.unmount();
    expect(chartMocks.detach).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayChart — B2d Phase 3 price-line reconciliation', () => {
  const basis = (price: number): ReplayOverlay['lines'] => [{ kind: 'basis', price }];
  const basisAndStop = (basisPrice: number, stopPrice: number): ReplayOverlay['lines'] =>
    [{ kind: 'basis', price: basisPrice }, { kind: 'stop', price: stopPrice }];

  it('creates the AVG line once with its title and price, then updates in place', async () => {
    const view = await render({ overlay: overlayOf([], basis(4810.25)) });
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(1);
    expect(chartMocks.createPriceLine.mock.calls[0][0]).toMatchObject({
      price: 4810.25, title: 'AVG', axisLabelVisible: true, lineVisible: true, lineStyle: 0,
    });

    await view.rerender({ overlay: overlayOf([], basis(4815.5)) });
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(1);          // no second line
    expect(chartMocks.createdLines[0].applyOptions).toHaveBeenCalledWith({ price: 4815.5 });
  });

  it('creates the STOP line once, dashed, and updates in place', async () => {
    const view = await render({ overlay: overlayOf([], basisAndStop(4810, 4790)) });
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(2);
    expect(chartMocks.createPriceLine.mock.calls[1][0]).toMatchObject({
      price: 4790, title: 'STOP', axisLabelVisible: true, lineStyle: 2, color: SHORT,
    });

    await view.rerender({ overlay: overlayOf([], basisAndStop(4810, 4795)) });
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(2);
    expect(chartMocks.createdLines[1].applyOptions).toHaveBeenCalledWith({ price: 4795 });
  });

  it('creates no stop primitive for a stopless episode', async () => {
    await render({ overlay: overlayOf([marker('entry_long')], basis(4810)) });
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(1);
    expect(chartMocks.createPriceLine.mock.calls[0][0]).toMatchObject({ title: 'AVG' });
  });

  it('never holds more than two price lines across many overlay updates', async () => {
    const view = await render({ overlay: overlayOf([], basisAndStop(4810, 4790)) });
    for (const [basisPrice, stopPrice] of [[4811, 4791], [4812, 4792], [4813, 4793]]) {
      await view.rerender({ overlay: overlayOf([], basisAndStop(basisPrice, stopPrice)) });
    }
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(2);
    expect(chartMocks.removePriceLine).not.toHaveBeenCalled();
  });

  it('removes both lines when the episode goes flat while markers remain', async () => {
    const markers = [marker('entry_long'), marker('final_long', { actionId: 'exit' })];
    const view = await render({ overlay: overlayOf(markers, basisAndStop(4810, 4790)) });
    await view.rerender({ overlay: overlayOf(markers) });
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);
    expect(chartMocks.removePriceLine.mock.calls.map((call) => call[0].title)).toEqual(['AVG', 'STOP']);
    // Historical markers survive a Final Exit; only the live lines disappear.
    expect(lastMarkerArray()).toHaveLength(2);
  });

  it('removes existing lines on unmount and never double-removes a cleared line', async () => {
    const view = await render({ overlay: overlayOf([], basisAndStop(4810, 4790)) });
    await view.rerender({ overlay: EMPTY_OVERLAY });
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);
    await view.unmount();
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);          // refs were already cleared
  });

  it('removes the lines it still holds when unmounted while open', async () => {
    const view = await render({ overlay: overlayOf([], basisAndStop(4810, 4790)) });
    expect(chartMocks.removePriceLine).not.toHaveBeenCalled();
    await view.unmount();
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);
  });
});

describe('ReplayChart — B2d Phase 3 overlay eligibility reconciliation', () => {
  it('clears every primitive for an empty overlay and restores them afterwards', async () => {
    const overlayA = overlayOf([marker('entry_long', { actionId: 'a1' })],
      [{ kind: 'basis', price: 4810 }, { kind: 'stop', price: 4790 }]);
    const view = await render({ overlay: overlayA });
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a1' })]);
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(2);

    // Ineligible: session mismatch, loading, importing, error or an empty chart
    // all arrive here as EMPTY_OVERLAY — one declarative path, no teardown hook.
    await view.rerender({ overlay: EMPTY_OVERLAY });
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([]);
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);

    const overlayB = overlayOf([marker('entry_short', { actionId: 'b1' })],
      [{ kind: 'basis', price: 5200 }, { kind: 'stop', price: 5250 }]);
    await view.rerender({ overlay: overlayB });
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'b1' })]);
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(4);          // fresh pair, no stale primitive
    expect(chartMocks.createPriceLine.mock.calls[2][0]).toMatchObject({ price: 5200, title: 'AVG' });
    expect(chartMocks.createPriceLine.mock.calls[3][0]).toMatchObject({ price: 5250, title: 'STOP' });
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayChart — B2d Phase 6A Select Bar', () => {
  const clickHandler = () =>
    chartMocks.subscribeClick.mock.calls[0][0] as (params: { time?: unknown }) => void;
  const chartClick = async (params: { time?: unknown }) => {
    await act(async () => { clickHandler()(params); });
  };

  it('subscribes to chart clicks exactly once and never re-subscribes', async () => {
    const onSelectBar = vi.fn();
    const view = await render({ selectBarActive: false, onSelectBar });
    expect(chartMocks.subscribeClick).toHaveBeenCalledTimes(1);

    await view.rerender({ selectBarActive: true });
    await view.rerender({ selectBarActive: false });
    await view.rerender({ onSelectBar: vi.fn() });
    await view.rerender({ bars: [bar(T0, 100), bar(T0 + 60_000, 200)] });
    await view.rerender({ overlay: overlayOf([marker('entry_long')]) });
    await view.rerender({ fillHeight: true });
    expect(chartMocks.subscribeClick).toHaveBeenCalledTimes(1);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
  });

  it('reports a clicked bar start in canonical milliseconds while active', async () => {
    const onSelectBar = vi.fn();
    await render({ selectBarActive: true, onSelectBar });
    await chartClick({ time: T0 / 1000 });
    expect(onSelectBar).toHaveBeenCalledWith(T0);      // chart seconds -> ms
  });

  it('ignores clicks while Select Bar is inactive', async () => {
    const onSelectBar = vi.fn();
    const view = await render({ selectBarActive: false, onSelectBar });
    await chartClick({ time: T0 / 1000 });
    expect(onSelectBar).not.toHaveBeenCalled();
    // The same subscription serves the active mode; no re-subscribe happens.
    await view.rerender({ selectBarActive: true });
    await chartClick({ time: T0 / 1000 });
    expect(onSelectBar).toHaveBeenCalledTimes(1);
    expect(chartMocks.subscribeClick).toHaveBeenCalledTimes(1);
  });

  it('ignores a click that resolves no numeric chart time', async () => {
    const onSelectBar = vi.fn();
    await render({ selectBarActive: true, onSelectBar });
    await chartClick({});
    await chartClick({ time: undefined });
    await chartClick({ time: '2016-03-01' });
    await chartClick({ time: { year: 2016, month: 3, day: 1 } });
    expect(onSelectBar).not.toHaveBeenCalled();
  });

  it('routes to the latest callback and unsubscribes exactly once on unmount', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = await render({ selectBarActive: true, onSelectBar: first });
    await view.rerender({ onSelectBar: second });
    await chartClick({ time: T0 / 1000 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(T0);

    expect(chartMocks.unsubscribeClick).not.toHaveBeenCalled();
    await view.unmount();
    expect(chartMocks.unsubscribeClick).toHaveBeenCalledTimes(1);
    expect(chartMocks.unsubscribeClick.mock.calls[0][0]).toBe(chartMocks.subscribeClick.mock.calls[0][0]);
  });

  it('leaves the right-click contextmenu path unchanged', async () => {
    const requests: ReplayChartContextRequest[] = [];
    const onSelectBar = vi.fn();
    await render({ selectBarActive: true, onSelectBar, onContextRequest: (request) => requests.push(request) });
    const event = rightClick(350, 200);
    expect(event.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(1);
    expect(onSelectBar).not.toHaveBeenCalled();       // right-click never selects a bar
  });
});

describe('ReplayChart — B2d Phase 6A focus height', () => {
  const chartHost = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-label]')!;
  const measure = (container: HTMLElement, width: number, height: number) => {
    const host = chartHost(container);
    Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: height, configurable: true });
    return host;
  };

  it('constructs at the released 520 px height and resizes width only in normal mode', async () => {
    const view = await render();
    expect(chartMocks.createChart).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ height: 520 }));
    measure(view.container, 1200, 900);
    chartMocks.applyOptions.mockClear();
    act(() => { resizeCallbacks[0](); });
    expect(chartMocks.applyOptions).toHaveBeenCalledWith({ width: 1200 });
  });

  it('sends the measured container height to the chart in fill mode', async () => {
    const view = await render();
    measure(view.container, 1200, 900);
    chartMocks.applyOptions.mockClear();
    await view.rerender({ fillHeight: true });
    // Toggling focus resizes in place — no observer tick required.
    expect(chartMocks.applyOptions).toHaveBeenCalledWith({ width: 1200, height: 900 });
    chartMocks.applyOptions.mockClear();
    act(() => { resizeCallbacks[0](); });
    expect(chartMocks.applyOptions).toHaveBeenCalledWith({ width: 1200, height: 900 });
  });

  it('never recreates the chart, series, marker plugin or price lines across a focus toggle', async () => {
    const overlay = overlayOf([marker('entry_long')], [{ kind: 'basis', price: 4810 }, { kind: 'stop', price: 4790 }]);
    const view = await render({ overlay });
    measure(view.container, 1200, 900);
    const createdLines = chartMocks.createPriceLine.mock.calls.length;

    await view.rerender({ fillHeight: true });
    await view.rerender({ fillHeight: false });
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.addSeries).toHaveBeenCalledTimes(1);
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    expect(chartMocks.createPriceLine).toHaveBeenCalledTimes(createdLines);
    expect(chartMocks.removePriceLine).not.toHaveBeenCalled();
    expect(chartMocks.remove).not.toHaveBeenCalled();
    expect(chartMocks.detach).not.toHaveBeenCalled();

    // Back in normal mode the height is left alone again.
    chartMocks.applyOptions.mockClear();
    act(() => { resizeCallbacks[0](); });
    expect(chartMocks.applyOptions).toHaveBeenCalledWith({ width: 1200 });
  });
});

describe('ReplayChart — B2d Phase 3 right-click coordinate foundation', () => {
  it('resolves coordinates from the click alone, with no prior mouse movement', async () => {
    const requests: ReplayChartContextRequest[] = [];
    await render({ onContextRequest: (request) => requests.push(request) });
    const event = rightClick(350, 200);                 // local 300, 180 inside the plot
    expect(event.defaultPrevented).toBe(true);
    expect(chartMocks.coordinateToPrice).toHaveBeenCalledWith(180);
    expect(chartMocks.coordinateToTime).toHaveBeenCalledWith(300);
    expect(requests).toEqual([{
      clientX: 350, clientY: 200,
      price: 5000 - 180,
      barStartUtcMs: (1_456_790_400 + 300) * 1000,      // chart seconds -> canonical ms
    }]);
    expect(chartMocks.subscribeCrosshairMove).not.toHaveBeenCalled();
  });

  it('returns no coordinate payload over the price scale or the time scale', async () => {
    const requests: ReplayChartContextRequest[] = [];
    await render({ onContextRequest: (request) => requests.push(request) });
    rightClick(900, 200);                               // local x 850 > plot width 800
    rightClick(350, 540);                               // local y 520 > plot bottom 490
    expect(requests).toEqual([
      { clientX: 900, clientY: 200, price: null, barStartUtcMs: null },
      { clientX: 350, clientY: 540, price: null, barStartUtcMs: null },
    ]);
    expect(chartMocks.coordinateToPrice).not.toHaveBeenCalled();
    expect(chartMocks.coordinateToTime).not.toHaveBeenCalled();
  });

  it('passes through a null price and a null or non-numeric chart time', async () => {
    const requests: ReplayChartContextRequest[] = [];
    await render({ onContextRequest: (request) => requests.push(request) });
    chartMocks.coordinateToPrice.mockReturnValueOnce(null as unknown as number);
    rightClick(350, 200);
    expect(last(requests)).toMatchObject({ price: null, barStartUtcMs: (1_456_790_400 + 300) * 1000 });

    chartMocks.coordinateToTime.mockReturnValueOnce(null as unknown as number);
    rightClick(360, 210);
    expect(last(requests)).toMatchObject({ price: 5000 - 190, barStartUtcMs: null });

    chartMocks.coordinateToTime.mockReturnValueOnce('2016-03-01' as unknown as number);
    rightClick(360, 210);
    expect(last(requests).barStartUtcMs).toBeNull();    // display strings are never parsed
  });

  it('leaves the browser context menu alone while no consumer is attached', async () => {
    await render();                                     // no onContextRequest
    const event = rightClick(350, 200);
    expect(event.defaultPrevented).toBe(false);
    expect(chartMocks.coordinateToPrice).not.toHaveBeenCalled();
    expect(chartMocks.coordinateToTime).not.toHaveBeenCalled();
  });

  it('routes to the latest callback without recreating the chart, and stops on unmount', async () => {
    const first: ReplayChartContextRequest[] = [];
    const second: ReplayChartContextRequest[] = [];
    const view = await render({ onContextRequest: (request) => first.push(request) });
    rightClick(350, 200);
    await view.rerender({ onContextRequest: (request) => second.push(request) });
    rightClick(360, 210);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);

    await view.unmount();
    rightClick(370, 220);
    expect(second).toHaveLength(1);                     // listener removed on teardown
  });
});
