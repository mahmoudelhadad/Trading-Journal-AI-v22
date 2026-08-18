// @vitest-environment jsdom
/**
 * components/replay/ReplayWorkspace.test.tsx
 *
 * B2d Phase 4 — workspace LAYOUT CONTRACT only.
 *
 * jsdom performs no layout, so these tests prove composition, DOM structure,
 * deterministic ordering, and the style/relationship contract this component sets
 * directly. They prove NOTHING about real desktop column widths, the actual
 * responsive wrap point, chart pixel size, or visual quality — those belong to
 * browser Runtime Acceptance.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplayWorkspace } from './ReplayWorkspace.js';

const roots: Array<{ root: Root; container: HTMLElement }> = [];

/** Records how many times its instance was constructed, to expose a remount. */
let panelMounts = 0;
function PanelProbe() {
  React.useEffect(() => { panelMounts += 1; }, []);
  return <div data-testid="panel-slot">panel</div>;
}

async function render(focusMode = false) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  const tree = (focused: boolean) => (
    <ReplayWorkspace focusMode={focused}
      chart={<div data-testid="chart-slot">candles</div>}
      tradingPanel={<PanelProbe />} />
  );
  await act(async () => { root.render(tree(focusMode)); });
  return {
    container,
    rerender: async (focused = focusMode) => { await act(async () => { root.render(tree(focused)); }); },
  };
}

beforeEach(() => { panelMounts = 0; });

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  document.body.innerHTML = '';
});

const workspace = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-replay-workspace]');
const region = (c: HTMLElement, kind: 'primary' | 'secondary') =>
  c.querySelector<HTMLElement>(`[data-replay-region="${kind}"]`);

describe('ReplayWorkspace — layout contract', () => {
  it('renders each slot exactly once inside one workspace region', async () => {
    const { container } = await render();
    expect(container.querySelectorAll('[data-replay-workspace]')).toHaveLength(1);
    const chart = container.querySelector('[data-testid="chart-slot"]')!;
    const panel = container.querySelector('[data-testid="panel-slot"]')!;
    expect(container.querySelectorAll('[data-testid="chart-slot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="panel-slot"]')).toHaveLength(1);
    expect(workspace(container)!.contains(chart)).toBe(true);
    expect(workspace(container)!.contains(panel)).toBe(true);
  });

  it('marks the chart as the primary region and the panel as secondary', async () => {
    const { container } = await render();
    const primary = region(container, 'primary')!;
    const secondary = region(container, 'secondary')!;
    expect(primary.querySelector('[data-testid="chart-slot"]')).not.toBeNull();
    expect(secondary.querySelector('[data-testid="panel-slot"]')).not.toBeNull();
    expect(primary.getAttribute('aria-label')).toBe('Replay chart');
    expect(secondary.getAttribute('aria-label')).toBe('Replay trading panel');
    // The chart takes the larger flexible share — not a 50/50 dashboard tile.
    expect(primary.style.flexGrow).toBe('3');
    expect(secondary.style.flexGrow).toBe('1');
    expect(Number(primary.style.flexBasis.replace('px', '')))
      .toBeGreaterThan(Number(secondary.style.flexBasis.replace('px', '')));
  });

  it('wraps rather than overflowing, with no global stylesheet involvement', async () => {
    const { container } = await render();
    const host = container.querySelector<HTMLElement>('[data-replay-workspace]')!;
    expect(host.style.display).toBe('flex');
    expect(host.style.flexWrap).toBe('wrap');           // narrow width drops the panel below
    expect(host.className).toBe('');                    // no global CSS class dependency
    expect(region(container, 'primary')!.style.minWidth).toBe('0px');
    expect(region(container, 'secondary')!.style.minWidth).toBe('0px');
  });

  it('keeps a deterministic chart-then-panel DOM order', async () => {
    const { container } = await render();
    const host = container.querySelector('[data-replay-workspace]')!;
    expect(Array.from(host.children).map((child) => child.getAttribute('data-replay-region')))
      .toEqual(['primary', 'secondary']);
  });

  it('does not duplicate children across rerenders', async () => {
    const view = await render();
    await view.rerender();
    await view.rerender();
    expect(view.container.querySelectorAll('[data-testid="chart-slot"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-testid="panel-slot"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-replay-region]')).toHaveLength(2);
  });

  it('keeps both children mounted and unduplicated across a focus toggle', async () => {
    const view = await render(false);
    expect(panelMounts).toBe(1);

    await view.rerender(true);
    const focused = view.container.querySelector<HTMLElement>('[data-replay-workspace]')!;
    expect(focused.getAttribute('data-replay-focus')).toBe('');
    // Chart region takes the workspace; the panel region is hidden by style only.
    expect(region(view.container, 'primary')!.style.flexBasis).toBe('100%');
    expect(region(view.container, 'secondary')!.style.display).toBe('none');
    expect(region(view.container, 'secondary')!.getAttribute('aria-hidden')).toBe('true');
    // Still in the DOM, still the same instance: no remount, so its transient
    // form state survives entering Focus.
    expect(view.container.querySelectorAll('[data-testid="panel-slot"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-testid="chart-slot"]')).toHaveLength(1);
    expect(panelMounts).toBe(1);

    await view.rerender(false);
    expect(region(view.container, 'secondary')!.style.display).not.toBe('none');
    expect(region(view.container, 'primary')!.style.flexBasis).toBe('640px');
    expect(view.container.querySelectorAll('[data-testid="panel-slot"]')).toHaveLength(1);
    expect(panelMounts).toBe(1);
  });

  it('renders no later-phase surface', async () => {
    const { container } = await render();
    // Phase 5/6 surfaces must not exist yet.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    for (const text of ['BUY MARKET', 'SELL MARKET', 'SCALE IN', 'EXIT ALL', 'Step Back', 'Select Bar', 'Undo', 'Redo']) {
      expect(container.textContent).not.toContain(text);
    }
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-replay-toolbar]')).toBeNull();
    const host = container.querySelector<HTMLElement>('[data-replay-workspace]')!;
    expect(host.style.position).toBe('');               // no fixed/fullscreen mode
    expect(host.style.height).toBe('');
  });
});
