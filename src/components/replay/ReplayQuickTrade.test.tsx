// @vitest-environment jsdom
/**
 * components/replay/ReplayQuickTrade.test.tsx
 *
 * B2d Phase 5 — chart quick-trade controls, and the cross-surface consistency
 * proof that Quick Trade, the context menu and the detailed panel submit
 * IDENTICAL arguments for identical state.
 *
 * jsdom proves rendered controls, disabled semantics, command arguments and
 * shared-state wiring. It proves nothing about where the overlay actually sits
 * on the live chart, or whether it overlaps the price scale — Runtime Acceptance.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendBacktestAction, createBacktestSession, projectBacktestSession } from '@calculations/backtestSession.js';
import { ReplayQuickTrade } from './ReplayQuickTrade.js';
import { ReplayContextMenu } from './ReplayContextMenu.js';
import { ReplayTradingPanel } from './ReplayTradingPanel.js';
import type { BacktestAction, BacktestSession } from '@apptypes/backtestSession.js';
import type { ReplaySessionsState } from '@hooks/useReplaySessions.js';

const SID = '11111111-1111-4111-8111-111111111111';
const TID = '33333333-3333-4333-8333-333333333333';
const T0 = 1_700_000_040_000;
const ISO = '2026-08-14T12:00:00.000Z';

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

interface QuickProps {
  sessions: ReplaySessionsState;
  quantity?: string;
  stop?: string;
  onQuantity?: (text: string) => void;
  close?: number | null;
}

async function render({ sessions, quantity = '1', stop = '', onQuantity = () => {}, close = 21042.75 }: QuickProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(<ReplayQuickTrade sessions={sessions} orderQuantityText={quantity}
      onOrderQuantityTextChange={onQuantity} initialStopText={stop} lastRevealedClose={close} />);
  });
  return { container };
}

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const button = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
const quantityInput = (c: HTMLElement) => c.querySelector('input')!;

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('ReplayQuickTrade — state matrix', () => {
  it('offers BUY MARKET and SELL MARKET while flat', async () => {
    const { container } = await render({ sessions: stateFor(FLAT) });
    expect(button(container, 'BUY MARKET')?.disabled).toBe(false);
    expect(button(container, 'SELL MARKET')?.disabled).toBe(false);
    expect(button(container, 'SCALE IN LONG')).toBeUndefined();
    expect(button(container, 'EXIT ALL')).toBeUndefined();
  });

  it('offers SCALE IN LONG and EXIT ALL while long, with no flat group', async () => {
    const { container } = await render({ sessions: stateFor(OPEN_LONG) });
    expect(button(container, 'SCALE IN LONG')?.disabled).toBe(false);
    expect(button(container, 'EXIT ALL')?.disabled).toBe(false);
    expect(button(container, 'BUY MARKET')).toBeUndefined();
    expect(button(container, 'SELL MARKET')).toBeUndefined();
    expect(button(container, 'SCALE IN SHORT')).toBeUndefined();
  });

  it('offers SCALE IN SHORT while short', async () => {
    const { container } = await render({ sessions: stateFor(OPEN_SHORT) });
    expect(button(container, 'SCALE IN SHORT')?.disabled).toBe(false);
    expect(button(container, 'SCALE IN LONG')).toBeUndefined();
  });

  it('disables execution with no active session', async () => {
    const sessions = stateFor(null);
    const { container } = await render({ sessions });
    expect(button(container, 'BUY MARKET')?.disabled).toBe(true);
    await click(button(container, 'BUY MARKET')!);
    expect(sessions.enter).not.toHaveBeenCalled();
  });

  it('disables execution while pending, safety-blocked, rewound or completed', async () => {
    const rewound = stateFor(AFTER_PARTIAL, { projection: projectBacktestSession(AFTER_PARTIAL, T0) });
    expect(rewound.projection?.rewound).toBe(true);
    const cases: ReplaySessionsState[] = [
      stateFor(OPEN_LONG, { pending: true }),
      stateFor(OPEN_LONG, { safetyBlocked: true }),
      rewound,
      stateFor({ ...OPEN_LONG, status: 'completed' as const }),
    ];
    for (const sessions of cases) {
      const { container } = await render({ sessions });
      for (const label of ['SCALE IN LONG', 'EXIT ALL']) {
        const control = button(container, label);
        expect(control?.disabled, label).toBe(true);
        if (control !== undefined) await click(control);
      }
      expect(sessions.enter).not.toHaveBeenCalled();
      expect(sessions.exit).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayQuickTrade — shared state and command arguments', () => {
  it('delegates quantity edits to the shared workspace setter', async () => {
    const onQuantity = vi.fn();
    const { container } = await render({ sessions: stateFor(FLAT), onQuantity });
    await typeInto(quantityInput(container), '4');
    expect(onQuantity).toHaveBeenCalledWith('4');
  });

  it('buys and sells with the shared quantity and shared initial stop', async () => {
    const buySessions = stateFor(FLAT);
    const buy = await render({ sessions: buySessions, quantity: '4', stop: '19995' });
    await click(button(buy.container, 'BUY MARKET')!);
    expect(buySessions.enter).toHaveBeenCalledWith('long', 4, 19995);

    const sellSessions = stateFor(FLAT);
    const sell = await render({ sessions: sellSessions, quantity: '2', stop: '' });
    await click(button(sell.container, 'SELL MARKET')!);
    expect(sellSessions.enter).toHaveBeenCalledWith('short', 2, null);
  });

  it('never executes for an invalid quantity or an invalid stop', async () => {
    for (const [quantity, stop] of [['0', ''], ['-1', ''], ['1.5', ''], ['', ''], ['abc', ''], ['2', '-5'], ['2', 'abc']]) {
      const sessions = stateFor(FLAT);
      const { container } = await render({ sessions, quantity, stop });
      const buy = button(container, 'BUY MARKET')!;
      expect(buy.disabled, `${quantity}/${stop}`).toBe(true);
      await click(buy);
      expect(sessions.enter, `${quantity}/${stop}`).not.toHaveBeenCalled();
    }
  });

  it('scales in with the shared quantity and the episode anchor, not the stop text', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container } = await render({ sessions, quantity: '2', stop: '19800' });
    await click(button(container, 'SCALE IN LONG')!);
    expect(sessions.enter).toHaveBeenCalledWith('long', 2, 19995);   // inherited, never 19800
  });

  it('exits all with the exact remaining quantity, ignoring the order quantity', async () => {
    const sessions = stateFor(AFTER_PARTIAL);
    const { container } = await render({ sessions, quantity: '9' });
    await click(button(container, 'EXIT ALL')!);
    expect(sessions.exit).toHaveBeenCalledWith(2);
    expect(container.textContent).not.toContain('Exit quantity');
  });
});

describe('ReplayQuickTrade — advisory readout and forbidden surfaces', () => {
  it('shows the last revealed close as advisory text', async () => {
    const { container } = await render({ sessions: stateFor(FLAT), close: 21042.75 });
    expect(container.textContent).toContain('Last revealed close');
    expect(container.textContent).toContain('21042.75');
    expect(container.textContent).not.toContain('Executable');
  });

  it('shows an em dash when nothing is revealed', async () => {
    const { container } = await render({ sessions: stateFor(FLAT), close: null });
    expect(container.textContent).toContain('Last revealed close · —');
  });

  it('never renders bid, ask, spread or any pending-order control', async () => {
    for (const sessions of [stateFor(FLAT), stateFor(OPEN_LONG), stateFor(OPEN_SHORT), stateFor(null)]) {
      const { container } = await render({ sessions });
      const text = container.textContent ?? '';
      for (const forbidden of ['Bid', 'Ask', 'Spread', 'Buy Limit', 'Sell Limit', 'Buy Stop', 'Sell Stop']) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    }
  });
});

/**
 * B2d Phase 5 §31 — the three surfaces are separate CALL SITES of one command
 * path. For identical state and identical shared input they must submit exactly
 * the same arguments.
 */
describe('Replay trading surfaces — cross-surface argument consistency', () => {
  async function renderPanel(sessions: ReplaySessionsState, quantity: string, stop: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(<ReplayTradingPanel sessions={sessions} orderQuantityText={quantity}
        onOrderQuantityTextChange={() => {}} initialStopText={stop} onInitialStopTextChange={() => {}} />);
    });
    return container;
  }

  async function renderMenu(sessions: ReplaySessionsState, quantity: string, stop: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(<ReplayContextMenu
        request={{ clientX: 10, clientY: 10, price: 30000, barStartUtcMs: T0 }}
        sessions={sessions} orderQuantityText={quantity} initialStopText={stop}
        priceText="30000" onUseAsInitialStop={() => {}} onGoToBar={() => {}} onClose={() => {}} />);
    });
    return container;
  }

  it('submits identical arguments for a flat long from all three surfaces', async () => {
    const viaPanel = stateFor(FLAT);
    const viaQuick = stateFor(FLAT);
    const viaMenu = stateFor(FLAT);
    await click(button(await renderPanel(viaPanel, '4', '19995'), 'Long')!);
    await click(button((await render({ sessions: viaQuick, quantity: '4', stop: '19995' })).container, 'BUY MARKET')!);
    await click(button(await renderMenu(viaMenu, '4', '19995'), 'Buy Market')!);
    const expected = ['long', 4, 19995];
    expect(viaPanel.enter).toHaveBeenCalledWith(...expected);
    expect(viaQuick.enter).toHaveBeenCalledWith(...expected);
    expect(viaMenu.enter).toHaveBeenCalledWith(...expected);
  });

  it('submits identical arguments for a flat short from all three surfaces', async () => {
    const viaPanel = stateFor(FLAT);
    const viaQuick = stateFor(FLAT);
    const viaMenu = stateFor(FLAT);
    await click(button(await renderPanel(viaPanel, '2', ''), 'Short')!);
    await click(button((await render({ sessions: viaQuick, quantity: '2', stop: '' })).container, 'SELL MARKET')!);
    await click(button(await renderMenu(viaMenu, '2', ''), 'Sell Market')!);
    for (const state of [viaPanel, viaQuick, viaMenu]) {
      expect(state.enter).toHaveBeenCalledWith('short', 2, null);
    }
  });

  it('submits identical scale-in and exit-all arguments from all three surfaces', async () => {
    const viaPanel = stateFor(OPEN_LONG);
    const viaQuick = stateFor(OPEN_LONG);
    const viaMenu = stateFor(OPEN_LONG);
    const panel = await renderPanel(viaPanel, '2', '19800');
    const quick = (await render({ sessions: viaQuick, quantity: '2', stop: '19800' })).container;
    const menu = await renderMenu(viaMenu, '2', '19800');
    await click(button(panel, 'Scale In Long')!);
    await click(button(quick, 'SCALE IN LONG')!);
    await click(button(menu, 'Scale In Long')!);
    for (const state of [viaPanel, viaQuick, viaMenu]) {
      expect(state.enter).toHaveBeenCalledWith('long', 2, 19995);
    }

    await click(button(panel, 'Exit All')!);
    await click(button(quick, 'EXIT ALL')!);
    await click(button(menu, 'Exit All at Market')!);
    for (const state of [viaPanel, viaQuick, viaMenu]) {
      expect(state.exit).toHaveBeenCalledWith(3);
    }
  });
});
