// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendBacktestAction, createBacktestSession, projectBacktestSession } from '@calculations/backtestSession.js';
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
const OPEN_NO_STOP = build([{ kind: 'entry', quantity: 2, price: 20000, stop: null }]);
const AFTER_PARTIAL = build([
  { kind: 'entry', quantity: 3, price: 20000, stop: 19995 }, { kind: 'exit', quantity: 1, price: 20002 },
]);
const SCALE_AFTER_PARTIAL = build([
  { kind: 'entry', quantity: 2, price: 20000, stop: 19995 }, { kind: 'exit', quantity: 1, price: 20002 },
  { kind: 'entry', quantity: 3, price: 20001.25, stop: 19995 },
]);

function stateFor(session: BacktestSession, overrides: Partial<ReplaySessionsState> = {}): ReplaySessionsState {
  return {
    sessions: [session], activeSession: session,
    projection: projectBacktestSession(session, Number.MAX_SAFE_INTEGER),
    hydrated: true, pending: false, safetyBlocked: false, error: null,
    createCurrentSession: vi.fn(async () => {}), selectSession: vi.fn(async () => {}),
    leaveSession: vi.fn(async () => {}), enter: vi.fn(async () => {}), exit: vi.fn(async () => {}),
    complete: vi.fn(async () => {}), recover: vi.fn(async () => {}),
    ...overrides,
  };
}

const roots: Array<{ root: Root; container: HTMLElement }> = [];

async function render(sessions: ReplaySessionsState) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<ReplayTradingPanel sessions={sessions} />); });
  return {
    container,
    rerender: async (next: ReplaySessionsState) => {
      await act(async () => { root.render(<ReplayTradingPanel sessions={next} />); });
    },
  };
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

const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll('button'));
const button = (c: HTMLElement, text: string) =>
  buttons(c).find((item) => item.textContent?.trim() === text);
const labelledInput = (c: HTMLElement, labelText: string) => {
  const label = Array.from(c.querySelectorAll('label')).find((item) => item.textContent?.includes(labelText));
  return label?.querySelector('input') ?? undefined;
};
/** Reads a value from the open-position definition list by its visible term. */
const summary = (c: HTMLElement, term: string) => {
  const dt = Array.from(c.querySelectorAll('dt')).find((item) => item.textContent?.trim() === term);
  return dt?.nextElementSibling?.textContent?.trim() ?? null;
};

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

describe('ReplayTradingPanel — Flat mode', () => {
  it('renders quantity, optional stop, Long and Short', async () => {
    const { container } = await render(stateFor(FLAT));
    expect(labelledInput(container, 'Whole contracts')).toBeInstanceOf(window.HTMLInputElement);
    expect(labelledInput(container, 'Initial stop')).toBeInstanceOf(window.HTMLInputElement);
    expect(button(container, 'Long')?.disabled).toBe(false);
    expect(button(container, 'Short')?.disabled).toBe(false);
  });

  it('submits a Long entry with the exact typed quantity and stop through a real click', async () => {
    const sessions = stateFor(FLAT);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Whole contracts')!, '4');
    await typeInto(labelledInput(container, 'Initial stop')!, '19995');
    await click(button(container, 'Long')!);
    expect(sessions.enter).toHaveBeenCalledTimes(1);
    expect(sessions.enter).toHaveBeenCalledWith('long', 4, 19995);
  });

  it('submits a Short entry with a null stop when the stop field is blank', async () => {
    const sessions = stateFor(FLAT);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Whole contracts')!, '2');
    await click(button(container, 'Short')!);
    expect(sessions.enter).toHaveBeenCalledWith('short', 2, null);
  });

  it('does not submit an entry for invalid quantities', async () => {
    for (const invalid of ['0', '-1', '1.5', '', 'abc']) {
      const sessions = stateFor(FLAT);
      const { container } = await render(sessions);
      await typeInto(labelledInput(container, 'Whole contracts')!, invalid);
      const long = button(container, 'Long')!;
      await click(long);
      expect(sessions.enter, invalid).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayTradingPanel — Open mode and Scale In', () => {
  it('shows the Long position summary with a same-side Scale In and no actionable Short', async () => {
    const { container } = await render(stateFor(OPEN_LONG));
    expect(summary(container, 'Side')).toBe('long');
    expect(summary(container, 'Remaining')).toBe('3');
    expect(button(container, 'Scale In Long')?.disabled).toBe(false);
    const short = button(container, 'Scale In Short');
    expect(short === undefined || short.disabled).toBe(true);
    expect(button(container, 'Short')).toBeUndefined();
  });

  it('shows the Short position summary with a same-side Scale In and no actionable Long', async () => {
    const { container } = await render(stateFor(OPEN_SHORT));
    expect(summary(container, 'Side')).toBe('short');
    expect(summary(container, 'Remaining')).toBe('2');
    expect(button(container, 'Scale In Short')?.disabled).toBe(false);
    const long = button(container, 'Scale In Long');
    expect(long === undefined || long.disabled).toBe(true);
    expect(button(container, 'Long')).toBeUndefined();
  });

  it('scales in on the aggregate side with the exact typed quantity and inherited anchor', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Scale quantity')!, '2');
    await click(button(container, 'Scale In Long')!);
    expect(sessions.enter).toHaveBeenCalledTimes(1);
    expect(sessions.enter).toHaveBeenCalledWith('long', 2, 19995);
  });

  it('scales in a short episode on the short side', async () => {
    const sessions = stateFor(OPEN_SHORT);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Scale quantity')!, '3');
    await click(button(container, 'Scale In Short')!);
    expect(sessions.enter).toHaveBeenCalledWith('short', 3, 20015);
  });

  it('does not scale in for invalid quantities', async () => {
    for (const invalid of ['0', '-2', '2.5', '', 'x']) {
      const sessions = stateFor(OPEN_LONG);
      const { container } = await render(sessions);
      await typeInto(labelledInput(container, 'Scale quantity')!, invalid);
      await click(button(container, 'Scale In Long')!);
      expect(sessions.enter, invalid).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayTradingPanel — stop anchor', () => {
  it('displays the exact anchor read-only with no editable stop control while open', async () => {
    const { container } = await render(stateFor(OPEN_LONG));
    expect(summary(container, 'Risk Stop Anchor')).toBe('19995');
    expect(labelledInput(container, 'Initial stop')).toBeUndefined();
    for (const label of ['Change Stop', 'Remove Stop', 'Add Stop']) {
      expect(button(container, label)).toBeUndefined();
    }
  });

  it('reports a missing anchor without offering any way to add one', async () => {
    const { container } = await render(stateFor(OPEN_NO_STOP));
    expect(summary(container, 'Risk Stop Anchor')).toBe('No stop anchor');
    expect(summary(container, 'Anchored Risk')).toBeNull();
    expect(labelledInput(container, 'Initial stop')).toBeUndefined();
    expect(button(container, 'Add Stop')).toBeUndefined();
  });
});

describe('ReplayTradingPanel — Exit', () => {
  it('exits the exact typed partial quantity', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Exit quantity')!, '1');
    await click(button(container, 'Exit')!);
    expect(sessions.exit).toHaveBeenCalledTimes(1);
    expect(sessions.exit).toHaveBeenCalledWith(1);
  });

  it('exits the full remaining quantity when the typed quantity equals remaining', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container } = await render(sessions);
    await typeInto(labelledInput(container, 'Exit quantity')!, '3');
    await click(button(container, 'Exit')!);
    expect(sessions.exit).toHaveBeenCalledWith(3);
  });

  it('Exit All submits the exact verified remaining quantity', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container } = await render(sessions);
    await click(button(container, 'Exit All')!);
    expect(sessions.exit).toHaveBeenCalledTimes(1);
    expect(sessions.exit).toHaveBeenCalledWith(3);
  });

  it('Exit All uses the current remaining quantity after a partial exit', async () => {
    const sessions = stateFor(AFTER_PARTIAL);
    const { container } = await render(sessions);
    await click(button(container, 'Exit All')!);
    expect(sessions.exit).toHaveBeenCalledWith(2);
  });

  it('does not exit for invalid or over-sized quantities and never clamps', async () => {
    for (const invalid of ['0', '-1', '1.5', '', 'x', '4']) {
      const sessions = stateFor(OPEN_LONG);
      const { container } = await render(sessions);
      await typeInto(labelledInput(container, 'Exit quantity')!, invalid);
      await click(button(container, 'Exit')!);
      expect(sessions.exit, invalid).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayTradingPanel — aggregate summary', () => {
  it('renders every aggregate field after a partial exit', async () => {
    const { container } = await render(stateFor(AFTER_PARTIAL));
    expect(summary(container, 'Side')).toBe('long');
    expect(summary(container, 'Entered')).toBe('3');
    expect(summary(container, 'Exited')).toBe('1');
    expect(summary(container, 'Remaining')).toBe('2');
    expect(summary(container, 'Avg Entry')).toBe('20000');
    expect(summary(container, 'Realized P/L')).toBe('$40.00');
    expect(summary(container, 'Risk Stop Anchor')).toBe('19995');
    expect(summary(container, 'Anchored Risk')).toBe('$300.00');
  });

  it('uses the aggregate weighted basis after a scale-in, not the first Entry price', async () => {
    const { container } = await render(stateFor(SCALE_AFTER_PARTIAL));
    expect(summary(container, 'Entered')).toBe('5');
    expect(summary(container, 'Exited')).toBe('1');
    expect(summary(container, 'Remaining')).toBe('4');
    expect(summary(container, 'Avg Entry')).toBe('20000.9375');
    expect(summary(container, 'Avg Entry')).not.toBe('20000');
    expect(summary(container, 'Anchored Risk')).toBe('$575.00');
  });

  it('labels the profit value as realized', async () => {
    const { container } = await render(stateFor(AFTER_PARTIAL));
    const terms = Array.from(container.querySelectorAll('dt')).map((item) => item.textContent?.trim());
    expect(terms).toContain('Realized P/L');
    expect(terms).not.toContain('Unrealized P/L');
    expect(terms).not.toContain('Open P/L');
  });
});

describe('ReplayTradingPanel — session and barrier states', () => {
  it('exposes no actionable trading control for a completed session', async () => {
    const completed = { ...AFTER_PARTIAL, status: 'completed' as const };
    const { container } = await render(stateFor(completed));
    for (const label of ['Scale In Long', 'Exit', 'Exit All', 'Long', 'Short']) {
      const control = button(container, label);
      expect(control === undefined || control.disabled, label).toBe(true);
    }
  });

  it('disables trading while rewound below the action high-water mark', async () => {
    const rewound = build([
      { kind: 'entry', quantity: 3, price: 20000, stop: 19995 }, { kind: 'exit', quantity: 1, price: 20002 },
    ]);
    const sessions = stateFor(rewound, { projection: projectBacktestSession(rewound, T0) });
    expect(sessions.projection?.rewound).toBe(true);
    const { container } = await render(sessions);
    for (const label of ['Scale In Long', 'Exit', 'Exit All']) {
      const control = button(container, label);
      expect(control === undefined || control.disabled, label).toBe(true);
    }
    const exitAll = button(container, 'Exit All');
    if (exitAll !== undefined) await click(exitAll);
    expect(sessions.exit).not.toHaveBeenCalled();
  });

  it('does not execute while pending or safety-blocked', async () => {
    for (const flags of [{ pending: true }, { safetyBlocked: true }]) {
      const sessions = stateFor(OPEN_LONG, flags);
      const { container } = await render(sessions);
      for (const label of ['Scale In Long', 'Exit', 'Exit All']) {
        const control = button(container, label);
        if (control !== undefined) await click(control);
      }
      expect(sessions.enter, JSON.stringify(flags)).not.toHaveBeenCalled();
      expect(sessions.exit, JSON.stringify(flags)).not.toHaveBeenCalled();
    }
  });
});

describe('ReplayTradingPanel — no automatic execution', () => {
  it('never executes from typing or rerendering alone', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container, rerender } = await render(sessions);
    await typeInto(labelledInput(container, 'Exit quantity')!, '2');
    await typeInto(labelledInput(container, 'Scale quantity')!, '5');
    await rerender(sessions);
    await rerender(sessions);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
  });

  it('cannot submit a stale Exit quantity that exceeds the new remaining quantity', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container, rerender } = await render(sessions);
    await typeInto(labelledInput(container, 'Exit quantity')!, '3');
    expect(button(container, 'Exit')?.disabled).toBe(false);

    // A verified partial exit lands elsewhere; remaining drops to 2 while the
    // input still reads 3.
    const reduced = stateFor(AFTER_PARTIAL, { enter: sessions.enter, exit: sessions.exit });
    await rerender(reduced);
    expect(summary(container, 'Remaining')).toBe('2');
    expect(labelledInput(container, 'Exit quantity')?.value).toBe('3');

    await click(button(container, 'Exit')!);
    expect(sessions.exit).not.toHaveBeenCalled();

    // Correcting the input to the new remaining quantity submits normally.
    await typeInto(labelledInput(container, 'Exit quantity')!, '2');
    await click(button(container, 'Exit')!);
    expect(sessions.exit).toHaveBeenCalledWith(2);
  });

  it('reflects an updated aggregate after a verified change without trading', async () => {
    const sessions = stateFor(OPEN_LONG);
    const { container, rerender } = await render(sessions);
    expect(summary(container, 'Remaining')).toBe('3');

    const updated = stateFor(SCALE_AFTER_PARTIAL, {
      enter: sessions.enter, exit: sessions.exit, complete: sessions.complete,
    });
    await rerender(updated);
    expect(summary(container, 'Remaining')).toBe('4');
    expect(summary(container, 'Avg Entry')).toBe('20000.9375');
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(sessions.exit).not.toHaveBeenCalled();
  });
});
