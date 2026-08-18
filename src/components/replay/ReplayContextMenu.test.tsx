// @vitest-environment jsdom
/**
 * components/replay/ReplayContextMenu.test.tsx
 *
 * B2d Phase 5 — safe chart context menu.
 *
 * jsdom proves the item matrix, omission rules, delegated commands, clipboard
 * delegation, dismissal paths and the fixed-position style values. It proves
 * NOTHING about real visual fit: whether the menu overlaps the price scale, how
 * it behaves under a touch long-press, or how it looks at any screen size.
 * Those are Runtime Acceptance items.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBacktestAction, createBacktestSession, projectBacktestSession } from '@calculations/backtestSession.js';
import { ReplayContextMenu } from './ReplayContextMenu.js';
import { roundPriceToTick } from '@calculations/replayWorkspace.js';
import { getFuturesInstrument } from '@constants/futuresInstruments.js';
import type { BacktestAction, BacktestSession } from '@apptypes/backtestSession.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';
import type { ReplayWorkspaceContextRequest } from '@hooks/useReplayWorkspace.js';

const SID = '11111111-1111-4111-8111-111111111111';
const TID = '33333333-3333-4333-8333-333333333333';
const T0 = 1_700_000_040_000;
const ISO = '2026-08-14T12:00:00.000Z';
/** Exact labels that must never appear in any state — pending orders are B2e. */
const FORBIDDEN = ['Buy Limit', 'Sell Limit', 'Buy Stop', 'Sell Stop'];

const baseSession = () => createBacktestSession({
  sessionId: SID, series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
  progress: { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, createdAt: ISO,
});

interface Leg { kind: 'entry' | 'exit'; quantity: number; price: number; side?: 'long' | 'short'; stop?: number | null }

const build = (legs: readonly Leg[]): BacktestSession => legs.reduce<BacktestSession>((session, leg, index) => {
  const decisionUtcMs = T0 + index * 60_000;
  const base = {
    actionVersion: 1 as const,
    actionId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
    tradeId: TID, sessionId: SID, sequence: index + 1, quantity: leg.quantity,
    fill: {
      decisionUtcMs, sourceBarStartUtcMs: decisionUtcMs - 60_000, sourceBarCloseUtcMs: decisionUtcMs,
      price: leg.price, basis: 'revealed_1m_close' as const,
    },
    clientCreatedAt: ISO,
  };
  const action: BacktestAction = leg.kind === 'entry'
    ? { ...base, kind: 'entry', side: leg.side ?? 'long', initialStopPrice: leg.stop ?? null }
    : { ...base, kind: 'exit' };
  return appendBacktestAction(session, action,
    { cursorUtcMs: decisionUtcMs, displayTimeframe: '1m', speed: 1 }, ISO);
}, baseSession());

const FLAT = baseSession();
const OPEN_LONG = build([{ kind: 'entry', quantity: 3, price: 20000, stop: 19995 }]);
const OPEN_SHORT = build([{ kind: 'entry', quantity: 2, price: 20010, side: 'short', stop: 20015 }]);
const AFTER_PARTIAL = build([
  { kind: 'entry', quantity: 3, price: 20000, stop: 19995 }, { kind: 'exit', quantity: 1, price: 20002 },
]);

function stateFor(session: BacktestSession | null, overrides: Partial<ReplaySessionsState> = {}): ReplaySessionsState {
  return {
    sessions: session === null ? [] : [session], activeSession: session,
    projection: session === null ? null : projectBacktestSession(session, Number.MAX_SAFE_INTEGER),
    hydrated: true, pending: false, safetyBlocked: false, error: null,
    createCurrentSession: vi.fn(async () => {}), selectSession: vi.fn(async () => {}),
    leaveSession: vi.fn(async () => {}), enter: vi.fn(async () => {}), exit: vi.fn(async () => {}),
    complete: vi.fn(async () => {}), recover: vi.fn(async () => {}),
    ...overrides,
  };
}

const roots: Array<{ root: Root; container: HTMLElement }> = [];

interface MenuOptions {
  sessions?: ReplaySessionsState;
  request?: Partial<ReplayWorkspaceContextRequest>;
  quantity?: string;
  stop?: string;
  priceText?: string | null;
  onUseAsInitialStop?: (price: number) => void;
  onGoToBar?: (barStartUtcMs: number) => void;
  onClose?: () => void;
}

async function render(options: MenuOptions = {}) {
  const {
    sessions = stateFor(FLAT), quantity = '1', stop = '', priceText = '20000.25',
    onUseAsInitialStop = () => {}, onGoToBar = () => {}, onClose = () => {},
  } = options;
  const request: ReplayWorkspaceContextRequest = {
    clientX: 100, clientY: 120, price: 20000.25, barStartUtcMs: T0, ...options.request,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(<ReplayContextMenu request={request} sessions={sessions}
      orderQuantityText={quantity} initialStopText={stop} priceText={priceText}
      onUseAsInitialStop={onUseAsInitialStop} onGoToBar={onGoToBar} onClose={onClose} />);
  });
  return { container };
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
});

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const labels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim() ?? '');
const item = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((entry) => entry.textContent?.trim() === text);

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

describe('ReplayContextMenu — item matrix', () => {
  it('offers both market entries while flat', async () => {
    const { container } = await render({ sessions: stateFor(FLAT) });
    expect(labels(container)).toEqual([
      'Buy Market', 'Sell Market', 'Use 20000.25 as Initial Stop', 'Copy Price', 'Go To This Bar', 'Cancel',
    ]);
  });

  it('offers scale-in and exit-all while long, with no flat entries and no stop-writing item', async () => {
    const { container } = await render({ sessions: stateFor(OPEN_LONG) });
    expect(labels(container)).toEqual([
      'Scale In Long', 'Exit All at Market', 'Copy Price', 'Go To This Bar', 'Cancel',
    ]);
  });

  it('offers the short-side scale-in while short', async () => {
    const { container } = await render({ sessions: stateFor(OPEN_SHORT) });
    expect(labels(container)).toContain('Scale In Short');
    expect(labels(container)).not.toContain('Scale In Long');
  });

  it('OMITS every execution item when trading is blocked', async () => {
    const rewound = stateFor(AFTER_PARTIAL, { projection: projectBacktestSession(AFTER_PARTIAL, T0) });
    expect(rewound.projection?.rewound).toBe(true);
    const blocked: Array<[string, ReplaySessionsState]> = [
      ['pending', stateFor(OPEN_LONG, { pending: true })],
      ['safetyBlocked', stateFor(OPEN_LONG, { safetyBlocked: true })],
      ['rewound', rewound],
      ['completed', stateFor({ ...OPEN_LONG, status: 'completed' as const })],
      ['no session', stateFor(null)],
    ];
    for (const [name, sessions] of blocked) {
      const { container } = await render({ sessions });
      const rendered = labels(container);
      for (const execution of ['Buy Market', 'Sell Market', 'Scale In Long', 'Scale In Short', 'Exit All at Market']) {
        expect(rendered, `${name} / ${execution}`).not.toContain(execution);
      }
      expect(rendered, name).toContain('Cancel');   // dismissal always available
    }
  });

  it('omits the coordinate utilities when the chart resolved no price or no bar', async () => {
    const noPrice = await render({ request: { price: null }, priceText: null });
    expect(labels(noPrice.container)).not.toContain('Copy Price');
    expect(labels(noPrice.container).some((label) => label.includes('as Initial Stop'))).toBe(false);
    expect(labels(noPrice.container)).toContain('Go To This Bar');

    const noBar = await render({ request: { barStartUtcMs: null } });
    expect(labels(noBar.container)).not.toContain('Go To This Bar');
    expect(labels(noBar.container)).toContain('Copy Price');
  });

  it('offers the stop-writing item only for a flat session', async () => {
    const flat = await render({ sessions: stateFor(FLAT) });
    expect(labels(flat.container)).toContain('Use 20000.25 as Initial Stop');

    const open = await render({ sessions: stateFor(OPEN_LONG) });
    expect(labels(open.container).some((label) => label.includes('as Initial Stop'))).toBe(false);

    const none = await render({ sessions: stateFor(null) });
    expect(labels(none.container).some((label) => label.includes('as Initial Stop'))).toBe(false);
  });

  it('never renders a pending-order label in any state', async () => {
    const states = [
      stateFor(FLAT), stateFor(OPEN_LONG), stateFor(OPEN_SHORT), stateFor(null),
      stateFor(OPEN_LONG, { pending: true }), stateFor(OPEN_LONG, { safetyBlocked: true }),
      stateFor({ ...OPEN_LONG, status: 'completed' as const }),
    ];
    for (const sessions of states) {
      for (const request of [{}, { price: null }, { barStartUtcMs: null }]) {
        const { container } = await render({ sessions, request });
        for (const forbidden of FORBIDDEN) {
          expect(labels(container), forbidden).not.toContain(forbidden);
          expect(container.textContent, forbidden).not.toContain(forbidden);
        }
      }
    }
  });
});

describe('ReplayContextMenu — market execution', () => {
  it('buys and sells through the shared command path with shared inputs', async () => {
    const buy = stateFor(FLAT);
    const buyView = await render({ sessions: buy, quantity: '4', stop: '19995' });
    await click(item(buyView.container, 'Buy Market')!);
    expect(buy.enter).toHaveBeenCalledWith('long', 4, 19995);

    const sell = stateFor(FLAT);
    const sellView = await render({ sessions: sell, quantity: '2' });
    await click(item(sellView.container, 'Sell Market')!);
    expect(sell.enter).toHaveBeenCalledWith('short', 2, null);
  });

  it('NEVER passes the clicked chart price as an execution argument', async () => {
    const sessions = stateFor(FLAT);
    const { container } = await render({
      sessions, quantity: '3', stop: '', request: { price: 30000 }, priceText: '30000',
    });
    await click(item(container, 'Buy Market')!);
    expect(sessions.enter).toHaveBeenCalledWith('long', 3, null);
    const call = (sessions.enter as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call).not.toContain(30000);
  });

  it('scales in with the episode anchor and exits all with the remaining quantity', async () => {
    const scale = stateFor(OPEN_LONG);
    const scaleView = await render({ sessions: scale, quantity: '2', stop: '19800', request: { price: 30000 } });
    await click(item(scaleView.container, 'Scale In Long')!);
    expect(scale.enter).toHaveBeenCalledWith('long', 2, 19995);

    const exit = stateFor(AFTER_PARTIAL);
    const exitView = await render({ sessions: exit });
    await click(item(exitView.container, 'Exit All at Market')!);
    expect(exit.exit).toHaveBeenCalledWith(2);
  });

  it('does not execute for an invalid shared quantity', async () => {
    for (const quantity of ['0', '-1', '1.5', '', 'abc']) {
      const sessions = stateFor(FLAT);
      const { container } = await render({ sessions, quantity });
      await click(item(container, 'Buy Market')!);
      expect(sessions.enter, quantity).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayContextMenu — coordinate utilities', () => {
  it('writes the clicked price to the stop field without executing', async () => {
    const onUseAsInitialStop = vi.fn();
    const sessions = stateFor(FLAT);
    const { container } = await render({ sessions, onUseAsInitialStop, request: { price: 20000.25 } });
    await click(item(container, 'Use 20000.25 as Initial Stop')!);
    expect(onUseAsInitialStop).toHaveBeenCalledWith(20000.25);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
  });

  /**
   * B2d Phase 5.1 — the two price utilities have DIFFERENT semantics.
   *
   * Copy Price observes: it copies what the chart coordinate resolved to. Use as
   * Initial Stop produces a value that may later become an execution stop
   * anchor, so it must obey the instrument tick size. For an off-tick click the
   * two strings must differ.
   */
  it('copies the raw resolved price while the stop field receives the tick-normalized one', async () => {
    const RAW = 21042.63;
    const NORMALIZED = roundPriceToTick(RAW, getFuturesInstrument('NQ').tickSize)!;
    expect(NORMALIZED).toBe(21042.75);

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // Mirrors the page wiring: the label and the written value are normalized,
    // the clipboard is not.
    let stopField: string | null = null;
    const onUseAsInitialStop = (price: number) => {
      stopField = String(roundPriceToTick(price, getFuturesInstrument('NQ').tickSize));
    };
    const { container } = await render({
      sessions: stateFor(FLAT), request: { price: RAW },
      priceText: String(NORMALIZED), onUseAsInitialStop,
    });

    await click(item(container, 'Copy Price')!);
    expect(writeText).toHaveBeenCalledWith('21042.63');
    expect(writeText).not.toHaveBeenCalledWith('21042.75');

    await click(item(container, `Use ${String(NORMALIZED)} as Initial Stop`)!);
    expect(stopField).toBe('21042.75');
  });

  it('copies the price text through the clipboard when available', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onClose = vi.fn();
    const { container } = await render({ priceText: '20000.25', onClose });
    await click(item(container, 'Copy Price')!);
    expect(writeText).toHaveBeenCalledWith('20000.25');
    expect(onClose).toHaveBeenCalled();
  });

  it('survives a rejected or unavailable clipboard without touching session state', async () => {
    const sessions = stateFor(OPEN_LONG);
    const rejecting = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: rejecting }, configurable: true });
    const onClose = vi.fn();
    const rejected = await render({ sessions, onClose });
    await click(item(rejected.container, 'Copy Price')!);
    await act(async () => { await Promise.resolve(); });
    expect(onClose).toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const missing = await render({ sessions, onClose });
    await click(item(missing.container, 'Copy Price')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
  });

  it('delegates Go To This Bar with the clicked bar start', async () => {
    const onGoToBar = vi.fn();
    const sessions = stateFor(FLAT);
    const { container } = await render({ sessions, onGoToBar, request: { barStartUtcMs: T0 - 300_000 } });
    await click(item(container, 'Go To This Bar')!);
    expect(onGoToBar).toHaveBeenCalledWith(T0 - 300_000);
    expect(sessions.enter).not.toHaveBeenCalled();
  });
});

describe('ReplayContextMenu — dismissal and position', () => {
  it('closes on Cancel, on selecting an action, and on Escape', async () => {
    const cancel = vi.fn();
    const cancelView = await render({ onClose: cancel });
    await click(item(cancelView.container, 'Cancel')!);
    expect(cancel).toHaveBeenCalledTimes(1);

    const select = vi.fn();
    const selectView = await render({ onClose: select });
    await click(item(selectView.container, 'Buy Market')!);
    expect(select).toHaveBeenCalledTimes(1);

    const escape = vi.fn();
    await render({ onClose: escape });
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(escape).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated keys', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on an outside pointer press but not on a press inside the menu', async () => {
    const onClose = vi.fn();
    const { container } = await render({ onClose });
    await act(async () => {
      container.querySelector('[role="menu"]')!
        .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on scroll', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => { window.dispatchEvent(new window.Event('scroll')); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners on unmount', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new window.Event('scroll'));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('positions with fixed viewport coordinates and clamps inside the viewport', async () => {
    const inside = await render({ request: { clientX: 100, clientY: 120 } });
    const menu = inside.container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('120px');

    const offscreen = await render({ request: { clientX: 5000, clientY: 4000 } });
    const clamped = offscreen.container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(Number(clamped.style.left.replace('px', ''))).toBeLessThanOrEqual(window.innerWidth);
    expect(Number(clamped.style.top.replace('px', ''))).toBeLessThanOrEqual(window.innerHeight);
  });
});
