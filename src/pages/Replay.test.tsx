// @vitest-environment jsdom
/**
 * pages/Replay.test.tsx
 *
 * B2d Phase 6A — page ORCHESTRATION contracts.
 *
 * Phase 6A introduces wiring no component-isolated test can prove: the released
 * controls relocating into the toolbar, Select Bar travelling chart → pure
 * target helper → released Go-To, and Focus Mode preserving the live component
 * tree. `lightweight-charts` is mocked, so this proves composition, delegation,
 * mode transitions and DOM state — never pixels, chart fill, or how any of it
 * looks in a real browser.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_LAYER_Z_INDEX, ReplayPage, type ReplayPageProps } from './Replay.js';
import { selectBarTargetCursor } from '@calculations/replayWorkspace.js';
import { formatReplayGoToTime } from '@calculations/displayTime.js';
import type { HistoricalBar } from '@apptypes/marketData.js';
import type { ReplaySnapshot } from '@apptypes/replay.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

const chartMocks = vi.hoisted(() => {
  const series = {
    setData: vi.fn(), createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
    removePriceLine: vi.fn(), coordinateToPrice: vi.fn(() => 20000.5),
  };
  const coordinateToTime = vi.fn(() => 1_456_790_400);
  const timeScale = vi.fn(() => ({ width: () => 800, height: () => 30, coordinateToTime }));
  let element: HTMLDivElement | null = null;
  const chartElement = vi.fn(() => {
    if (element === null) {
      element = document.createElement('div');
      element.getBoundingClientRect = () => ({
        left: 0, top: 0, width: 900, height: 520, right: 900, bottom: 520, x: 0, y: 0,
      }) as DOMRect;
    }
    return element;
  });
  const subscribeClick = vi.fn();
  const chart = {
    addSeries: vi.fn(() => series), applyOptions: vi.fn(), remove: vi.fn(), timeScale,
    subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
    subscribeClick, unsubscribeClick: vi.fn(), chartElement,
  };
  const createChart = vi.fn(() => chart);
  const createSeriesMarkers = vi.fn(() => ({ setMarkers: vi.fn(), detach: vi.fn(), markers: vi.fn(() => []) }));
  return {
    chart, createChart, createSeriesMarkers, series, subscribeClick, chartElement,
    reset() { element = null; },
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
  CandlestickSeries: 'CandlestickSeries',
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
}));

const T0 = Date.parse('2016-03-01T00:00:00Z');
const MINUTE = 60_000;
const bar = (t: number, p = 100): HistoricalBar => ({ t, o: p, h: p + 1, l: p - 1, c: p, v: 5 });

function snapshotOf(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return {
    series: { root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' },
    nowUtcMs: T0 + 10 * MINUTE, speed: 1, timeframe: '1m', playState: 'paused',
    bars: [bar(T0), bar(T0 + MINUTE), bar(T0 + 2 * MINUTE)],
    availability: {
      available: true, observedFirstUtcMs: T0, observedLastUtcMs: T0 + 30 * MINUTE,
      observedDays: ['2016-03-01'],
    },
    coverageStartUtcMs: T0, coverageEndUtcMs: T0 + 2 * 86_400_000,
    loading: false, importing: false, error: null, canonicalBarrier: null,
    ...overrides,
  };
}

/**
 * B2d Phase 7A — the navigation actions report an OUTCOME, and the page records
 * history on that outcome. The default harness is therefore a runtime whose
 * navigation succeeds; every "did not apply" case makes its refusal explicit.
 */
function actionsOf(): ReplayPageProps['actions'] {
  return {
    selectSeries: vi.fn(), setTimeframe: vi.fn(() => true), setSpeed: vi.fn(),
    play: vi.fn(), pause: vi.fn(),
    goTo: vi.fn(async () => true), stepForward: vi.fn(async () => true),
    stepBackward: vi.fn(async () => true),
    importNinjaTrader: vi.fn(async () => ({ ok: true, message: 'ok' }) as never),
  };
}

/** Only the fields the page actually reads: identity, series and status. */
const sessionStub = (sessionId: string) => ({
  sessionId, status: 'active',
  series: { root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' },
}) as unknown as ReplaySessionsState['activeSession'];

function sessionsOf(overrides: Partial<ReplaySessionsState> = {}): ReplaySessionsState {
  return {
    sessions: [], activeSession: null, projection: null,
    hydrated: true, pending: false, safetyBlocked: false, error: null,
    createCurrentSession: vi.fn(async () => {}), selectSession: vi.fn(async () => {}),
    leaveSession: vi.fn(async () => {}), enter: vi.fn(async () => {}), exit: vi.fn(async () => {}),
    complete: vi.fn(async () => {}), recover: vi.fn(async () => {}),
    ...overrides,
  };
}

const roots: Array<{ root: Root; container: HTMLElement }> = [];

async function render(overrides: Partial<ReplayPageProps> = {}) {
  const props: ReplayPageProps = {
    snapshot: snapshotOf(), actions: actionsOf(), sessions: sessionsOf(), ...overrides,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<ReplayPage {...props} />); });
  return {
    container, props,
    rerender: async (next: Partial<ReplayPageProps> = {}) => {
      await act(async () => { root.render(<ReplayPage {...{ ...props, ...next }} />); });
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  globalThis.ResizeObserver = class {
    observe(): void { /* jsdom performs no layout */ }
    unobserve(): void { /* unused */ }
    disconnect(): void { /* unused */ }
  } as unknown as typeof ResizeObserver;
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

/**
 * Finds a control by its NAME, which after B2d Phase 9A may be carried either by
 * a visible text face or — for the six icon-only chart controls — by the
 * accessible name. Every behavioural assertion below is therefore unchanged by
 * the icon conversion, which is exactly the point: only the face changed.
 */
const button = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('button')).find((item) =>
    item.textContent?.trim() === text || item.getAttribute('aria-label') === text);
const toolbar = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-replay-toolbar]')!;
const toggleState = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLElement>(`[data-replay-toggle="${name}"]`)!.getAttribute('data-replay-active');
const goToInputs = (c: HTMLElement) => c.querySelectorAll('#replay-go-to');
const readouts = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('div')).filter((item) => item.style.fontFamily === 'monospace');

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}
async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}
/**
 * Lets an already-resolved navigation outcome reach React. The chart's click
 * subscription is a plain callback, so `act` returns before the record-on-success
 * continuation has run; this is a harness detail, not a page behaviour.
 */
async function settle() {
  await act(async () => { await Promise.resolve(); });
}
async function chartClick(time: unknown) {
  const handler = chartMocks.subscribeClick.mock.calls[0][0] as (params: { time?: unknown }) => void;
  await act(async () => { handler({ time }); });
}
async function rightClickChart() {
  const element = chartMocks.chartElement();
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('contextmenu', {
      clientX: 200, clientY: 200, bubbles: true, cancelable: true,
    }));
  });
}

describe('ReplayPage — toolbar composition', () => {
  it('renders the released controls and readout exactly once, inside the toolbar', async () => {
    const { container } = await render();
    expect(goToInputs(container)).toHaveLength(1);
    expect(readouts(container)).toHaveLength(1);
    expect(container.querySelectorAll('[data-replay-toolbar]')).toHaveLength(1);
    expect(toolbar(container).contains(goToInputs(container)[0])).toBe(true);
    expect(toolbar(container).contains(readouts(container)[0])).toBe(true);
    // Released controls keep their released behaviour and are not duplicated.
    expect(Array.from(container.querySelectorAll('button'))
      .filter((item) => item.getAttribute('aria-label') === 'Play')).toHaveLength(1);
  });

  /**
   * B2d Phase 9A — the six core controls became icon-only chart controls. These
   * assert the FACE and the NAME; every behavioural test in this file continues
   * to locate them by name, which is what proves the conversion changed nothing
   * but presentation.
   */
  it('renders the six core controls as named icon-only chart controls', async () => {
    const { container } = await render();
    for (const label of ['Play', 'Pause', 'Step Forward', 'Step Backward', 'Undo', 'Redo']) {
      const control = button(container, label)!;
      expect(control, label).toBeDefined();
      expect(control.tagName, label).toBe('BUTTON');            // never a div-as-button
      expect(control.getAttribute('aria-label'), label).toBe(label);   // accessible name
      expect(control.getAttribute('title'), label).toBe(label);        // hover name
      expect(control.querySelector('svg'), label).not.toBeNull();      // icon face
      expect(control.textContent?.trim(), label).toBe('');             // no text face
    }
  });

  it('keeps the surrounding controls as their released non-icon faces', async () => {
    const { container } = await render();
    // Explicitly NOT converted by Phase 9A.
    for (const label of ['Go To', 'Select Bar', 'Focus']) {
      const control = button(container, label)!;
      expect(control, label).toBeDefined();
      expect(control.textContent?.trim(), label).toBe(label);
      expect(control.querySelector('svg'), label).toBeNull();
    }
    expect(goToInputs(container)).toHaveLength(1);
  });

  it('renders the navigation Undo and Redo controls, initially unavailable', async () => {
    const { container } = await render();
    expect(button(container, 'Undo')?.disabled).toBe(true);
    expect(button(container, 'Redo')?.disabled).toBe(true);
  });
});

describe('ReplayPage — Step Backward delegation', () => {
  it('delegates to the released runtime action', async () => {
    const actions = actionsOf();
    const { container } = await render({ actions });
    await click(button(container, 'Step Backward')!);
    expect(actions.stepBackward).toHaveBeenCalledTimes(1);
    expect(actions.goTo).not.toHaveBeenCalled();
  });

  it('takes its enablement from the published coarse authority', async () => {
    // At or below the first available bar's close there is no predecessor.
    const atStart = await render({ snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    expect(button(atStart.container, 'Step Backward')?.disabled).toBe(true);

    const later = await render({ snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE + 1 }) });
    expect(button(later.container, 'Step Backward')?.disabled).toBe(false);

    const blocked = await render({ sessions: sessionsOf({ safetyBlocked: true }) });
    expect(button(blocked.container, 'Step Backward')?.disabled).toBe(true);
  });
});

describe('ReplayPage — Select Bar', () => {
  it('navigates through the pure target authority and exits after one selection', async () => {
    const actions = actionsOf();
    const snapshot = snapshotOf();
    const { container } = await render({ actions, snapshot });

    await click(button(container, 'Select Bar')!);
    expect(toggleState(container, 'select-bar')).toBe('true');

    await chartClick(T0 / 1000);
    expect(actions.goTo).toHaveBeenCalledTimes(1);
    expect(actions.goTo).toHaveBeenCalledWith(
      selectBarTargetCursor(T0, snapshot.timeframe, snapshot.nowUtcMs));
    expect(actions.goTo).toHaveBeenCalledWith(T0 + MINUTE);
    expect(toggleState(container, 'select-bar')).toBe('false');
    // Navigation only — no execution of any kind.
    expect(actions.stepBackward).not.toHaveBeenCalled();
  });

  it('never resolves a target later than the current cursor', async () => {
    const actions = actionsOf();
    // Cursor sits inside the bar that starts at +2m, so that bar's close is later.
    const snapshot = snapshotOf({ nowUtcMs: T0 + 2 * MINUTE + 30_000 });
    const { container } = await render({ actions, snapshot });
    await click(button(container, 'Select Bar')!);
    await chartClick((T0 + 2 * MINUTE) / 1000);
    expect(actions.goTo).toHaveBeenCalledWith(snapshot.nowUtcMs);
    expect((actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls[0][0])
      .toBeLessThanOrEqual(snapshot.nowUtcMs);
  });

  it('ignores a click that resolves no numeric bar time and stays armed', async () => {
    const actions = actionsOf();
    const { container } = await render({ actions });
    await click(button(container, 'Select Bar')!);
    await chartClick(undefined);
    await chartClick('2016-03-01');
    expect(actions.goTo).not.toHaveBeenCalled();
    expect(toggleState(container, 'select-bar')).toBe('true');
  });

  it('exits when its chart context changes', async () => {
    const cases: Array<[string, Partial<ReplaySnapshot>]> = [
      ['timeframe', { timeframe: '5m' }],
      ['series', { series: { root: 'ES', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' } }],
      ['import', { importing: true }],
      ['error', { error: 'This historical series is unavailable.' }],
      ['no bars', { bars: [] }],
    ];
    for (const [name, patch] of cases) {
      const view = await render();
      await click(button(view.container, 'Select Bar')!);
      expect(toggleState(view.container, 'select-bar'), name).toBe('true');
      await view.rerender({ snapshot: snapshotOf(patch) });
      expect(toggleState(view.container, 'select-bar'), name).toBe('false');
    }
  });

  it('does not arm Select Bar from a right-click, and a left click does not open the menu', async () => {
    const actions = actionsOf();
    const { container } = await render({ actions });
    await rightClickChart();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(actions.goTo).not.toHaveBeenCalled();
    expect(toggleState(container, 'select-bar')).toBe('false');
  });
});

/**
 * B2d Phase 6B — navigation history ORCHESTRATION.
 *
 * The stack itself is proven against the pure module; these tests prove which
 * events record, what they record, how Undo/Redo apply through RAW actions, and
 * which context changes clear the history.
 */
describe('ReplayPage — navigation history recording', () => {
  const goToCalls = (actions: ReplayPageProps['actions']) =>
    (actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls.map((call) => call[0]);

  it('records the pre-command state for Step Forward and returns to it on Undo', async () => {
    const actions = actionsOf();
    const start = snapshotOf({ nowUtcMs: T0 + 10 * MINUTE });
    const view = await render({ actions, snapshot: start });
    await click(button(view.container, 'Step Forward')!);
    expect(actions.stepForward).toHaveBeenCalledTimes(1);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);

    // The runtime moved on; the page observes the new published cursor.
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 11 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    expect(goToCalls(actions)).toEqual([T0 + 10 * MINUTE]);
    expect(actions.setTimeframe).not.toHaveBeenCalled();     // same timeframe
    expect(button(view.container, 'Redo')?.disabled).toBe(false);
  });

  it('records the pre-command state for Step Backward', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await click(button(view.container, 'Step Backward')!);
    expect(actions.stepBackward).toHaveBeenCalledTimes(1);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 9 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    expect(goToCalls(actions)).toEqual([T0 + 10 * MINUTE]);
  });

  it('records a Go To from the released controls, and skips a known no-op', async () => {
    const actions = actionsOf();
    const snapshot = snapshotOf({ nowUtcMs: T0 + 10 * MINUTE });
    const { container } = await render({ actions, snapshot });
    // A Go To to the current cursor cannot move anything, so nothing is recorded.
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#replay-go-to')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, formatReplayGoToTime(snapshot.nowUtcMs));
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(button(container, 'Go To')!);
    expect(goToCalls(actions)).toEqual([snapshot.nowUtcMs]);
    expect(button(container, 'Undo')?.disabled).toBe(true);

    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#replay-go-to')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, formatReplayGoToTime(T0 + 5 * MINUTE));
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(button(container, 'Go To')!);
    expect(button(container, 'Undo')?.disabled).toBe(false);
  });

  it('records a Select Bar navigation', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await click(button(view.container, 'Select Bar')!);
    await chartClick(T0 / 1000);
    expect(goToCalls(actions)).toEqual([T0 + MINUTE]);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Undo')!);
    expect(goToCalls(actions)).toEqual([T0 + MINUTE, T0 + 10 * MINUTE]);
  });

  it('records a context-menu Go To This Bar', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await rightClickChart();
    const goToItem = Array.from(view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((entry) => entry.textContent?.trim() === 'Go To This Bar')!;
    await click(goToItem);
    expect(actions.goTo).toHaveBeenCalledTimes(1);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);
  });

  it('records a display-timeframe change and restores it before the cursor', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE, timeframe: '1m' }) });
    await act(async () => {
      const select = Array.from(view.container.querySelectorAll('select'))
        .find((item) => item.value === '1m')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '5m');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(actions.setTimeframe).toHaveBeenCalledWith('5m');

    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 12 * MINUTE, timeframe: '5m' }) });
    await click(button(view.container, 'Undo')!);
    expect(actions.setTimeframe).toHaveBeenLastCalledWith('1m');
    expect(goToCalls(actions)).toEqual([T0 + 10 * MINUTE]);
    // Timeframe is applied first, then the cursor.
    const order = (actions.setTimeframe as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder;
    const goToOrder = (actions.goTo as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder;
    expect(order[order.length - 1]).toBeLessThan(goToOrder[goToOrder.length - 1]);
  });

  it('does not record Pause or a speed change', async () => {
    const actions = actionsOf();
    const { container } = await render({ actions, snapshot: snapshotOf({ playState: 'playing' }) });
    await click(button(container, 'Pause')!);
    await act(async () => {
      const select = Array.from(container.querySelectorAll('select')).find((item) => item.value === '1')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '30');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.setSpeed).toHaveBeenCalledWith(30);
    expect(button(container, 'Undo')?.disabled).toBe(true);     // neither is navigation history
  });
});

/**
 * B2d Phase 7A — history is recorded on the runtime's OUTCOME, never on intent.
 *
 * Every case below differs from its sibling in the block above by exactly one
 * thing: the navigation action reports that it did not apply. The page restates
 * no boundary, availability or bar rule to reach that conclusion.
 */
describe('ReplayPage — record on navigation outcome', () => {
  const undoAvailable = (c: HTMLElement) => button(c, 'Undo')?.disabled === false;

  it('records nothing when Step Forward is already at the end of the data', async () => {
    const actions = actionsOf();
    actions.stepForward = vi.fn(async () => false);
    const { container } = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await click(button(container, 'Step Forward')!);
    expect(actions.stepForward).toHaveBeenCalledTimes(1);
    expect(undoAvailable(container)).toBe(false);
  });

  it('records nothing when Step Backward does not apply', async () => {
    const actions = actionsOf();
    actions.stepBackward = vi.fn(async () => false);
    const { container } = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await click(button(container, 'Step Backward')!);
    expect(actions.stepBackward).toHaveBeenCalledTimes(1);
    expect(undoAvailable(container)).toBe(false);
  });

  async function submitGoTo(container: HTMLElement, utcMs: number) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#replay-go-to')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, formatReplayGoToTime(utcMs));
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(button(container, 'Go To')!);
  }

  it('records nothing when a Go To does not apply', async () => {
    const actions = actionsOf();
    actions.goTo = vi.fn(async () => false);
    const { container } = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await submitGoTo(container, T0 + 5 * MINUTE);
    expect(actions.goTo).toHaveBeenCalledWith(T0 + 5 * MINUTE);
    expect(undoAvailable(container)).toBe(false);
  });

  it('records nothing when a display-timeframe change is rejected', async () => {
    const actions = actionsOf();
    actions.setTimeframe = vi.fn(() => false);
    const { container } = await render({ actions, snapshot: snapshotOf({ timeframe: '1m' }) });
    await act(async () => {
      const select = Array.from(container.querySelectorAll('select')).find((item) => item.value === '1m')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '5m');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(actions.setTimeframe).toHaveBeenCalledWith('5m');
    expect(undoAvailable(container)).toBe(false);
  });

  // The applying sibling of this case is 'records a Select Bar navigation'
  // above; only one chart may exist per test, because the click subscription is
  // taken from the single mocked chart instance.
  it('records nothing when a Select Bar navigation does not apply', async () => {
    const actions = actionsOf();
    actions.goTo = vi.fn(async () => false);
    const { container } = await render({ actions });
    await click(button(container, 'Select Bar')!);
    await chartClick(T0 / 1000);
    await settle();
    expect(actions.goTo).toHaveBeenCalledTimes(1);
    expect(undoAvailable(container)).toBe(false);
  });

  it('records a context-menu Go To only when it applies', async () => {
    const actions = actionsOf();
    actions.goTo = vi.fn(async () => false);
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await rightClickChart();
    const goToItem = Array.from(view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((entry) => entry.textContent?.trim() === 'Go To This Bar')!;
    await click(goToItem);
    expect(actions.goTo).toHaveBeenCalledTimes(1);
    expect(undoAvailable(view.container)).toBe(false);
  });

  it('still records the PRE-command state, not the state it landed on', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 11 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    expect((actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls)
      .toEqual([[T0 + 10 * MINUTE]]);
  });
});

/**
 * B2d Phase 7A — the Undo/Redo TRANSACTION. Each of these fails against the
 * Phase-6B consume-before-navigate ordering, which spent the frame regardless.
 */
describe('ReplayPage — transactional Undo / Redo', () => {
  async function withOneUndoFrame(actions: ReplayPageProps['actions']) {
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    return view;
  }

  it('keeps Undo available when its Go To does not apply', async () => {
    const actions = actionsOf();
    const view = await withOneUndoFrame(actions);
    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(async () => false);

    await click(button(view.container, 'Undo')!);
    expect(actions.goTo).toHaveBeenCalledWith(T0 + MINUTE);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);   // the frame was not spent
    expect(button(view.container, 'Redo')?.disabled).toBe(true);    // and no redo was invented
  });

  it('keeps Redo available when its Go To does not apply', async () => {
    const actions = actionsOf();
    const view = await withOneUndoFrame(actions);
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    expect(button(view.container, 'Redo')?.disabled).toBe(false);

    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(async () => false);
    await click(button(view.container, 'Redo')!);
    expect(button(view.container, 'Redo')?.disabled).toBe(false);   // still available
    expect(button(view.container, 'Undo')?.disabled).toBe(true);    // and not falsely advanced
  });

  it('consumes a successful transition exactly once', async () => {
    const actions = actionsOf();
    const view = await withOneUndoFrame(actions);
    await click(button(view.container, 'Undo')!);
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
    expect(button(view.container, 'Redo')?.disabled).toBe(false);
    // Applying through the RAW actions records no extra frame of its own.
    expect((actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls)
      .toEqual([[T0 + MINUTE]]);
  });

  it('performs no session or execution command on a failed application', async () => {
    const sessions = sessionsOf();
    const actions = actionsOf();
    const view = await render({ actions, sessions, snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(async () => false);
    await click(button(view.container, 'Undo')!);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
    expect(sessions.complete).not.toHaveBeenCalled();
  });
});

/**
 * B2d Phase 7A — cross-timeframe atomicity. An Undo whose target changes BOTH
 * the display timeframe and the cursor is two runtime commands, and a half of it
 * must never survive while history still describes the world before it.
 */
describe('ReplayPage — cross-timeframe history transaction', () => {
  /** One frame recorded at 1m, then the page observes the runtime at 5m. */
  async function withTimeframeFrame(actions: ReplayPageProps['actions']) {
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 10 * MINUTE, timeframe: '1m' }) });
    await act(async () => {
      const select = Array.from(view.container.querySelectorAll('select')).find((item) => item.value === '1m')!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '5m');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 12 * MINUTE, timeframe: '5m' }) });
    return view;
  }

  const timeframeCalls = (actions: ReplayPageProps['actions']) =>
    (actions.setTimeframe as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]);

  it('restores the display timeframe when the cursor half fails, and consumes nothing', async () => {
    const actions = actionsOf();
    const view = await withTimeframeFrame(actions);
    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(async () => false);

    await click(button(view.container, 'Undo')!);
    // Applied 1m, the cursor failed, so 5m is put back: the actual navigation
    // state matches the history that was NOT consumed.
    expect(timeframeCalls(actions)).toEqual(['5m', '1m', '5m']);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('never issues the cursor command when the timeframe half is rejected', async () => {
    const actions = actionsOf();
    const view = await withTimeframeFrame(actions);
    (actions.setTimeframe as unknown as { mockImplementation: (fn: () => boolean) => void })
      .mockImplementation(() => false);
    const goToBefore = (actions.goTo as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;

    await click(button(view.container, 'Undo')!);
    expect((actions.goTo as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(goToBefore);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);   // nothing consumed
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('does not restore a previous context timeframe when the context changed mid-flight', async () => {
    let resolveGoTo!: (applied: boolean) => void;
    const actions = actionsOf();
    const view = await withTimeframeFrame(actions);
    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(() => new Promise<boolean>((resolve) => { resolveGoTo = resolve; }));

    await click(button(view.container, 'Undo')!);
    expect(timeframeCalls(actions)).toEqual(['5m', '1m']);          // timeframe half applied
    // The navigation context is replaced while the cursor half is still pending.
    await view.rerender({ snapshot: snapshotOf({
      nowUtcMs: T0 + 12 * MINUTE, timeframe: '1m',
      series: { root: 'ES', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' },
    }) });
    await act(async () => { resolveGoTo(false); });

    expect(timeframeCalls(actions)).toEqual(['5m', '1m']);          // no stale restore
    expect(button(view.container, 'Undo')?.disabled).toBe(true);    // cleared history stays cleared
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('commits nothing when the context is cleared while a cross-timeframe apply succeeds', async () => {
    let resolveGoTo!: (applied: boolean) => void;
    const actions = actionsOf();
    const view = await withTimeframeFrame(actions);
    (actions.goTo as unknown as { mockImplementation: (fn: () => Promise<boolean>) => void })
      .mockImplementation(() => new Promise<boolean>((resolve) => { resolveGoTo = resolve; }));

    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 12 * MINUTE, timeframe: '5m', importing: true }) });
    await act(async () => { resolveGoTo(true); });
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });
});

describe('ReplayPage — playback history', () => {
  it('records one pre-play checkpoint and no playback frame', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 5 * MINUTE }) });
    await click(button(view.container, 'Play')!);
    expect(actions.play).toHaveBeenCalledTimes(1);

    // Playback publishes many cursors; none of them is a history frame.
    for (const minute of [6, 7, 8, 9]) {
      await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + minute * MINUTE, playState: 'playing' }) });
    }
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 9 * MINUTE, playState: 'paused' }) });
    await click(button(view.container, 'Undo')!);
    expect((actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls)
      .toEqual([[T0 + 5 * MINUTE]]);
    expect(button(view.container, 'Undo')?.disabled).toBe(true);   // exactly one frame existed
  });

  it('records one frame for two immediate Play requests in the same run', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 5 * MINUTE }) });
    await click(button(view.container, 'Play')!);
    await click(button(view.container, 'Play')!);
    expect(actions.play).toHaveBeenCalledTimes(2);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 9 * MINUTE, playState: 'paused' }) });
    await click(button(view.container, 'Undo')!);
    expect(button(view.container, 'Undo')?.disabled).toBe(true);   // not two identical frames
  });

  it('records a new checkpoint for a second explicit playback run', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 5 * MINUTE }) });
    await click(button(view.container, 'Play')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 9 * MINUTE, playState: 'playing' }) });
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 9 * MINUTE, playState: 'paused' }) });
    await click(button(view.container, 'Play')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 12 * MINUTE, playState: 'paused' }) });

    await click(button(view.container, 'Undo')!);
    await click(button(view.container, 'Undo')!);
    expect((actions.goTo as unknown as { mock: { calls: number[][] } }).mock.calls)
      .toEqual([[T0 + 9 * MINUTE], [T0 + 5 * MINUTE]]);
  });
});

describe('ReplayPage — Undo / Redo semantics', () => {
  it('walks a three-step history back and forward', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 1 * MINUTE }) });   // A
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });                  // B
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 3 * MINUTE }) });                  // C
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 4 * MINUTE }) });                  // D

    const goTo = actions.goTo as unknown as { mock: { calls: number[][] } };
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 3 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 1 * MINUTE }) });
    expect(goTo.mock.calls).toEqual([[T0 + 3 * MINUTE], [T0 + 2 * MINUTE], [T0 + 1 * MINUTE]]);
    expect(button(view.container, 'Undo')?.disabled).toBe(true);   // deterministic boundary

    await click(button(view.container, 'Redo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    await click(button(view.container, 'Redo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 3 * MINUTE }) });
    await click(button(view.container, 'Redo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 4 * MINUTE }) });
    expect(goTo.mock.calls.slice(3)).toEqual([[T0 + 2 * MINUTE], [T0 + 3 * MINUTE], [T0 + 4 * MINUTE]]);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('clears Redo when a new navigation happens after an Undo', async () => {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 1 * MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 1 * MINUTE }) });
    expect(button(view.container, 'Redo')?.disabled).toBe(false);

    await click(button(view.container, 'Step Forward')!);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('never invokes a session or execution command', async () => {
    const sessions = sessionsOf();
    const actions = actionsOf();
    const view = await render({ actions, sessions, snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    await click(button(view.container, 'Undo')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Redo')!);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
    expect(sessions.complete).not.toHaveBeenCalled();
    expect(sessions.selectSession).not.toHaveBeenCalled();
    expect(sessions.createCurrentSession).not.toHaveBeenCalled();
  });

  it('serializes a rapid double Undo while the first application is pending', async () => {
    let resolveGoTo!: (applied: boolean) => void;
    const actions = actionsOf();
    actions.goTo = vi.fn(() => new Promise<boolean>((resolve) => { resolveGoTo = resolve; }));
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 3 * MINUTE }) });

    await click(button(view.container, 'Undo')!);
    await click(button(view.container, 'Undo')!);          // ignored while pending
    expect(actions.goTo).toHaveBeenCalledTimes(1);
    expect(button(view.container, 'Undo')?.disabled).toBe(true);

    await act(async () => { resolveGoTo(true); });
    expect(button(view.container, 'Undo')?.disabled).toBe(false);   // guard released
    await click(button(view.container, 'Undo')!);
    expect(actions.goTo).toHaveBeenCalledTimes(2);
  });

  it('releases the serialization guard when the application fails or rejects', async () => {
    const actions = actionsOf();
    actions.goTo = vi.fn(async () => false);
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + MINUTE }) });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }) });

    await click(button(view.container, 'Undo')!);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);   // guard released, frame kept

    actions.goTo = vi.fn(async () => { throw new Error('unexpected'); });
    await click(button(view.container, 'Undo')!);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);   // no unhandled rejection, no lock
  });
});

describe('ReplayPage — history clearing', () => {
  async function withOneFrame(overrides: Partial<ReplayPageProps> = {}) {
    const actions = actionsOf();
    const view = await render({ actions, snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }), ...overrides });
    await click(button(view.container, 'Step Forward')!);
    expect(button(view.container, 'Undo')?.disabled).toBe(false);
    return { ...view, actions };
  }

  it('clears when the active session changes and when it becomes null', async () => {
    const session = sessionStub('session-a');
    const other = sessionStub('session-b');
    const view = await withOneFrame({ sessions: sessionsOf({ activeSession: session }) });
    await view.rerender({ sessions: sessionsOf({ activeSession: other }) });
    expect(button(view.container, 'Undo')?.disabled).toBe(true);

    const leaving = await withOneFrame({ sessions: sessionsOf({ activeSession: session }) });
    await leaving.rerender({ sessions: sessionsOf({ activeSession: null }) });
    expect(button(leaving.container, 'Undo')?.disabled).toBe(true);
  });

  it('clears when the futures series contract changes', async () => {
    const view = await withOneFrame();
    await view.rerender({ snapshot: snapshotOf({
      nowUtcMs: T0 + 2 * MINUTE,
      series: { root: 'ES', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' },
    }) });
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
  });

  it('clears when an import begins', async () => {
    const view = await withOneFrame();
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE, importing: true }) });
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
  });

  it('does NOT clear for a display-timeframe change, Focus, dock or form state', async () => {
    const view = await withOneFrame();
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE, timeframe: '5m' }) });
    expect(button(view.container, 'Undo')?.disabled).toBe(false);

    await click(button(view.container, 'Focus')!);
    await click(button(view.container, 'Exit Focus')!);
    await click(button(view.container, 'Float')!);
    await click(button(view.container, 'Select Bar')!);
    const quantity = view.container.querySelector<HTMLInputElement>('[data-replay-quick-trade] input')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(quantity, '3');
      quantity.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(button(view.container, 'Undo')?.disabled).toBe(false);
  });

  it('keeps a cleared history cleared when a stale application resolves late', async () => {
    let resolveGoTo!: (applied: boolean) => void;
    const actions = actionsOf();
    actions.goTo = vi.fn(() => new Promise<boolean>((resolve) => { resolveGoTo = resolve; }));
    const session = sessionStub('session-a');
    const view = await render({
      actions, sessions: sessionsOf({ activeSession: session }),
      snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }),
    });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ snapshot: snapshotOf({ nowUtcMs: T0 + 3 * MINUTE }) });
    await click(button(view.container, 'Undo')!);          // application pending

    await view.rerender({ sessions: sessionsOf({ activeSession: null }) });
    await act(async () => { resolveGoTo(true); });
    // The navigation SUCCEEDED, and its transition is still not committed: the
    // context it belonged to no longer exists.
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
  });

  it('drops a slow successful navigation whose context was cleared mid-flight', async () => {
    let resolveStep!: (applied: boolean) => void;
    const actions = actionsOf();
    actions.stepForward = vi.fn(() => new Promise<boolean>((resolve) => { resolveStep = resolve; }));
    const view = await render({
      actions, sessions: sessionsOf({ activeSession: sessionStub('session-a') }),
      snapshot: snapshotOf({ nowUtcMs: T0 + 2 * MINUTE }),
    });
    await click(button(view.container, 'Step Forward')!);
    await view.rerender({ sessions: sessionsOf({ activeSession: null }) });
    await act(async () => { resolveStep(true); });
    // A pre-state from the previous navigation context never seeds the new one.
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
  });
});

describe('ReplayPage — Focus Mode', () => {
  it('opens an application-level fixed layer without touching the Fullscreen API', async () => {
    const requestFullscreen = vi.fn();
    Object.defineProperty(Element.prototype, 'requestFullscreen', { value: requestFullscreen, configurable: true });
    const { container } = await render();
    expect(container.querySelector('[data-replay-focus-layer]')).toBeNull();

    await click(button(container, 'Focus')!);
    const layer = container.querySelector<HTMLElement>('[data-replay-focus-layer]')!;
    expect(layer.style.position).toBe('fixed');
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(document.fullscreenElement ?? null).toBeNull();
  });

  /**
   * B2d Phase 9A — the Focus STACKING contract.
   *
   * jsdom performs no compositing, so this asserts only the explicit style
   * contract: Focus must declare a stacking value above the released app
   * header's 100, and below the released overlays that must stay reachable.
   * Real paint/hit-testing order is proven by browser re-acceptance, not here.
   */
  it('declares a stacking value above the released app header', async () => {
    const { container } = await render();
    await click(button(container, 'Focus')!);
    const layer = container.querySelector<HTMLElement>('[data-replay-focus-layer]')!;
    const zIndex = Number(layer.style.zIndex);
    expect(FOCUS_LAYER_Z_INDEX).toBe(zIndex);
    expect(zIndex).toBeGreaterThan(100);        // released Header.tsx
    expect(zIndex).toBeLessThan(200);           // released UserMenu / Modal / ConfirmDialog
  });

  it('preserves the live component tree across enter and exit', async () => {
    const { container } = await render();
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);

    await click(button(container, 'Focus')!);
    // One chart, one quick trade, one toolbar, panel still mounted.
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[aria-label="Historical replay candlestick chart"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-replay-quick-trade]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-replay-toolbar]')).toHaveLength(1);
    expect(container.querySelector('[data-replay-region="secondary"]')!.getAttribute('aria-hidden')).toBe('true');

    await click(button(container, 'Exit Focus')!);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(1);
    expect(chartMocks.chart.remove).not.toHaveBeenCalled();
    expect(container.querySelector('[data-replay-focus-layer]')).toBeNull();
  });

  it('keeps the shared order inputs and performs no session action when toggling', async () => {
    const sessions = sessionsOf();
    const { container } = await render({ sessions });
    const quantity = container.querySelector<HTMLInputElement>('[data-replay-quick-trade] input')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(quantity, '5');
      quantity.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    await click(button(container, 'Focus')!);
    await click(button(container, 'Exit Focus')!);
    expect(container.querySelector<HTMLInputElement>('[data-replay-quick-trade] input')!.value).toBe('5');
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
    expect(sessions.selectSession).not.toHaveBeenCalled();
  });

  it('exits on Escape', async () => {
    const { container } = await render();
    await click(button(container, 'Focus')!);
    expect(container.querySelector('[data-replay-focus-layer]')).not.toBeNull();
    await pressEscape();
    expect(container.querySelector('[data-replay-focus-layer]')).toBeNull();
  });

  it('gives the first Escape to an open context menu and keeps Focus', async () => {
    const { container } = await render();
    await click(button(container, 'Focus')!);
    await rightClickChart();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    await pressEscape();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-replay-focus-layer]')).not.toBeNull();   // focus survives

    await pressEscape();
    expect(container.querySelector('[data-replay-focus-layer]')).toBeNull();
  });

  it('keeps exactly one toolbar available in Focus', async () => {
    const { container } = await render();
    await click(button(container, 'Focus')!);
    expect(container.querySelectorAll('[data-replay-toolbar]')).toHaveLength(1);
    expect(goToInputs(container)).toHaveLength(1);
    expect(button(container, 'Step Backward')).toBeDefined();
  });
});
