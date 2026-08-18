// @vitest-environment jsdom
/**
 * components/replay/ReplayToolbar.test.tsx
 *
 * B2d Phase 6A — toolbar composition, mode and drag lifecycle.
 *
 * jsdom proves which controls exist, which callbacks fire, the docked/floating
 * style contract, pointer-drag state maths, the narrow-viewport rule and
 * listener cleanup. It proves NOTHING about visual quality, comfortable
 * dragging, or real clipping at the viewport edge — Runtime Acceptance owns
 * those, and jsdom reports every element as zero-sized.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayToolbar, type ReplayToolbarProps } from './ReplayToolbar.js';
import { REPLAY_FLOATING_SAFE_TOP_PX } from '@calculations/replayWorkspace.js';

const roots: Array<{ root: Root; container: HTMLElement }> = [];

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

async function render(overrides: Partial<ReplayToolbarProps> = {}) {
  const props: ReplayToolbarProps = {
    controls: <div data-testid="controls-slot">controls</div>,
    timeReadout: <div data-testid="readout-slot">readout</div>,
    stepBackEnabled: true,
    onStepBackward: vi.fn(),
    undoEnabled: false,
    redoEnabled: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    selectBarActive: false,
    onToggleSelectBar: vi.fn(),
    focusMode: false,
    onToggleFocusMode: vi.fn(),
    mode: 'docked',
    onModeChange: vi.fn(),
    position: { x: 40, y: 60 },
    onPositionChange: vi.fn(),
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<ReplayToolbar {...props} />); });
  return {
    container, props,
    rerender: async (next: Partial<ReplayToolbarProps> = {}) => {
      await act(async () => { root.render(<ReplayToolbar {...{ ...props, ...next }} />); });
    },
  };
}

beforeEach(() => { setViewport(1400); });

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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
const handle = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-replay-toolbar-handle]');
const toggle = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLElement>(`[data-replay-toggle="${name}"]`)!;

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}
function pointer(type: string, clientX: number, clientY: number) {
  // jsdom has no PointerEvent constructor; MouseEvent carries the same fields.
  const event = new window.MouseEvent(type, { bubbles: true, clientX, clientY });
  return event;
}

/**
 * B2d Phase 9A — the three navigation controls this component owns became
 * icon-only chart controls. Presentation only: every enablement and delegation
 * test in this file still finds them by NAME and is otherwise untouched.
 */
describe('ReplayToolbar — icon-only navigation controls', () => {
  it('renders Step Backward, Undo and Redo as named icons with no text face', async () => {
    const { container } = await render({ stepBackEnabled: true, undoEnabled: true, redoEnabled: true });
    for (const label of ['Step Backward', 'Undo', 'Redo']) {
      const control = button(container, label)!;
      expect(control, label).toBeDefined();
      expect(control.tagName, label).toBe('BUTTON');                   // real button
      expect(control.getAttribute('aria-label'), label).toBe(label);   // accessible name
      expect(control.getAttribute('title'), label).toBe(label);        // hover name
      expect(control.querySelector('svg'), label).not.toBeNull();      // icon face
      expect(control.textContent?.trim(), label).toBe('');             // no English text face
    }
    // The visible toolbar no longer renders those three words as button faces.
    const faces = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    for (const label of ['Step Backward', 'Undo', 'Redo']) expect(faces).not.toContain(label);
  });

  it('keeps the controls this phase did not convert as text faces', async () => {
    const { container } = await render();
    for (const label of ['Select Bar', 'Focus', 'Float']) {
      expect(button(container, label)?.textContent?.trim(), label).toBe(label);
      expect(button(container, label)?.querySelector('svg'), label).toBeNull();
    }
  });

  it('keeps icon controls genuinely disabled rather than merely styled', async () => {
    const onStepBackward = vi.fn(); const onUndo = vi.fn(); const onRedo = vi.fn();
    const { container } = await render({
      stepBackEnabled: false, undoEnabled: false, redoEnabled: false,
      onStepBackward, onUndo, onRedo,
    });
    for (const label of ['Step Backward', 'Undo', 'Redo']) {
      const control = button(container, label)!;
      expect(control.disabled, label).toBe(true);
      await click(control);
    }
    expect(onStepBackward).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });
});

describe('ReplayToolbar — composition', () => {
  it('renders each released slot exactly once alongside the Phase-6A actions', async () => {
    const { container } = await render();
    expect(container.querySelectorAll('[data-testid="controls-slot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="readout-slot"]')).toHaveLength(1);
    expect(button(container, 'Step Backward')).toBeDefined();
    expect(button(container, 'Select Bar')).toBeDefined();
    expect(button(container, 'Focus')).toBeDefined();
    expect(button(container, 'Float')).toBeDefined();
  });

  it('renders the navigation Undo and Redo controls', async () => {
    const { container } = await render({ selectBarActive: true, focusMode: true, mode: 'floating' });
    expect(button(container, 'Undo')).toBeDefined();
    expect(button(container, 'Redo')).toBeDefined();
  });
});

/**
 * B2d Phase 6B — the toolbar owns no stack logic: it renders two buttons whose
 * enablement its owner computes from the pure history model.
 */
describe('ReplayToolbar — navigation Undo / Redo', () => {
  it('disables both while the history model reports nothing available', async () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { container } = await render({ undoEnabled: false, redoEnabled: false, onUndo, onRedo });
    expect(button(container, 'Undo')?.disabled).toBe(true);
    expect(button(container, 'Redo')?.disabled).toBe(true);
    await click(button(container, 'Undo')!);
    await click(button(container, 'Redo')!);
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  it('invokes each handler exactly once when enabled', async () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { container } = await render({ undoEnabled: true, redoEnabled: true, onUndo, onRedo });
    expect(button(container, 'Undo')?.disabled).toBe(false);
    expect(button(container, 'Redo')?.disabled).toBe(false);
    await click(button(container, 'Undo')!);
    await click(button(container, 'Redo')!);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it('disables both while the owner reports a history application in flight', async () => {
    // The owner passes `false` for both while an apply is pending; the toolbar
    // simply reflects it — it holds no guard of its own.
    const onUndo = vi.fn();
    const view = await render({ undoEnabled: true, redoEnabled: true, onUndo });
    await view.rerender({ undoEnabled: false, redoEnabled: false });
    expect(button(view.container, 'Undo')?.disabled).toBe(true);
    expect(button(view.container, 'Redo')?.disabled).toBe(true);
    await click(button(view.container, 'Undo')!);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('leaves the Phase-6A controls untouched', async () => {
    const onStepBackward = vi.fn();
    const onToggleSelectBar = vi.fn();
    const onToggleFocusMode = vi.fn();
    const { container } = await render({
      undoEnabled: true, redoEnabled: true, onStepBackward, onToggleSelectBar, onToggleFocusMode,
    });
    await click(button(container, 'Step Backward')!);
    await click(button(container, 'Select Bar')!);
    await click(button(container, 'Focus')!);
    expect(onStepBackward).toHaveBeenCalledTimes(1);
    expect(onToggleSelectBar).toHaveBeenCalledTimes(1);
    expect(onToggleFocusMode).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-testid="controls-slot"]')).toHaveLength(1);
    expect(button(container, 'Float')).toBeDefined();
  });
});

describe('ReplayToolbar — Step Backward', () => {
  it('is disabled when the coarse enablement prop is false and never fires', async () => {
    const onStepBackward = vi.fn();
    const { container } = await render({ stepBackEnabled: false, onStepBackward });
    expect(button(container, 'Step Backward')?.disabled).toBe(true);
    await click(button(container, 'Step Backward')!);
    expect(onStepBackward).not.toHaveBeenCalled();
  });

  it('delegates exactly once when enabled', async () => {
    const onStepBackward = vi.fn();
    const { container } = await render({ stepBackEnabled: true, onStepBackward });
    await click(button(container, 'Step Backward')!);
    expect(onStepBackward).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayToolbar — Select Bar and Focus', () => {
  it('reflects and toggles Select Bar state', async () => {
    const onToggleSelectBar = vi.fn();
    const view = await render({ onToggleSelectBar });
    expect(toggle(view.container, 'select-bar').getAttribute('data-replay-active')).toBe('false');
    const inactiveBackground = button(view.container, 'Select Bar')!.style.background;
    await click(button(view.container, 'Select Bar')!);
    expect(onToggleSelectBar).toHaveBeenCalledTimes(1);

    await view.rerender({ selectBarActive: true });
    expect(toggle(view.container, 'select-bar').getAttribute('data-replay-active')).toBe('true');
    // Visibly distinguishable through the existing button variant styling.
    expect(button(view.container, 'Select Bar')!.style.background).not.toBe(inactiveBackground);
  });

  it('reflects and toggles Focus state', async () => {
    const onToggleFocusMode = vi.fn();
    const view = await render({ onToggleFocusMode });
    expect(toggle(view.container, 'focus').getAttribute('data-replay-active')).toBe('false');
    await click(button(view.container, 'Focus')!);
    expect(onToggleFocusMode).toHaveBeenCalledTimes(1);

    await view.rerender({ focusMode: true });
    expect(toggle(view.container, 'focus').getAttribute('data-replay-active')).toBe('true');
    expect(button(view.container, 'Exit Focus')).toBeDefined();
    expect(button(view.container, 'Focus')).toBeUndefined();
  });
});

describe('ReplayToolbar — docked and floating modes', () => {
  it('defaults to a docked, non-fixed bar with no drag handle', async () => {
    const { container } = await render({ mode: 'docked' });
    expect(toolbar(container).getAttribute('data-replay-toolbar-mode')).toBe('docked');
    expect(toolbar(container).style.position).toBe('');
    expect(handle(container)).toBeNull();
  });

  it('requests floating mode from the Float control', async () => {
    const onModeChange = vi.fn();
    const { container } = await render({ mode: 'docked', onModeChange });
    await click(button(container, 'Float')!);
    expect(onModeChange).toHaveBeenCalledWith('floating');
  });

  it('renders floating at fixed viewport coordinates with an explicit handle', async () => {
    const { container } = await render({ mode: 'floating', position: { x: 40, y: 60 } });
    expect(toolbar(container).getAttribute('data-replay-toolbar-mode')).toBe('floating');
    expect(toolbar(container).style.position).toBe('fixed');
    expect(toolbar(container).style.left).toBe('40px');
    expect(toolbar(container).style.top).toBe('60px');
    expect(handle(container)).not.toBeNull();
    expect(button(container, 'Dock')).toBeDefined();
  });

  it('moves only through the handle, and only while a drag is in progress', async () => {
    const onPositionChange = vi.fn();
    const { container } = await render({ mode: 'floating', onPositionChange });

    // A move with no drag in progress changes nothing.
    await act(async () => { window.dispatchEvent(pointer('pointermove', 500, 400)); });
    expect(onPositionChange).not.toHaveBeenCalled();

    // Pressing a normal control must never start a drag.
    await act(async () => { button(container, 'Step Backward')!.dispatchEvent(pointer('pointerdown', 100, 100)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 520, 410)); });
    expect(onPositionChange).not.toHaveBeenCalled();

    await act(async () => { handle(container)!.dispatchEvent(pointer('pointerdown', 45, 65)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 245, 265)); });
    expect(onPositionChange).toHaveBeenCalledTimes(1);
    // The toolbar moves by the pointer's delta, keeping the grab point under the
    // cursor: press at (45,65) then move to (245,265) shifts it by (200,200).
    expect(onPositionChange.mock.calls[0][0]).toEqual({ x: 200, y: 200 });

    await act(async () => { window.dispatchEvent(pointer('pointerup', 245, 265)); });
    onPositionChange.mockClear();
    await act(async () => { window.dispatchEvent(pointer('pointermove', 600, 600)); });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('clamps a drag inside the viewport', async () => {
    setViewport(1000, 700);
    const onPositionChange = vi.fn();
    const { container } = await render({ mode: 'floating', onPositionChange });
    await act(async () => { handle(container)!.dispatchEvent(pointer('pointerdown', 0, 0)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 5000, 4000)); });
    const clamped = onPositionChange.mock.calls[0][0] as { x: number; y: number };
    expect(clamped.x).toBeLessThanOrEqual(1000);
    expect(clamped.y).toBeLessThanOrEqual(700);

    onPositionChange.mockClear();
    await act(async () => { window.dispatchEvent(pointer('pointermove', -500, -500)); });
    const floored = onPositionChange.mock.calls[0][0] as { x: number; y: number };
    expect(floored.x).toBeGreaterThanOrEqual(0);
    expect(floored.y).toBeGreaterThanOrEqual(0);
  });

  /*
   * B2d Phase 9B. These assert COORDINATES ONLY. jsdom paints nothing, so they
   * cannot and do not claim the Header stops covering the toolbar or that Quick
   * Trade is visually uncovered — only browser re-acceptance proves that.
   */
  it('floors a drag at the safe top so the handle cannot go under the Header', async () => {
    setViewport(1000, 700);
    const onPositionChange = vi.fn();
    const { container } = await render({ mode: 'floating', onPositionChange });
    await act(async () => { handle(container)!.dispatchEvent(pointer('pointerdown', 0, 0)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 400, -900)); });
    const floored = onPositionChange.mock.calls[0][0] as { x: number; y: number };
    expect(floored.y).toBe(REPLAY_FLOATING_SAFE_TOP_PX);
    expect(floored.y).toBeGreaterThan(54);
  });

  it('still allows a drag below the safe top to keep its exact Y', async () => {
    setViewport(1000, 700);
    const onPositionChange = vi.fn();
    const { container } = await render({ mode: 'floating', onPositionChange });
    await act(async () => { handle(container)!.dispatchEvent(pointer('pointerdown', 0, 0)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 300, 400)); });
    expect(onPositionChange.mock.calls[0][0]).toEqual({ x: 300, y: 400 });
  });

  it('keeps released right and bottom clamping alongside the safe top', async () => {
    setViewport(1000, 700);
    const onPositionChange = vi.fn();
    const { container } = await render({ mode: 'floating', onPositionChange });
    await act(async () => { handle(container)!.dispatchEvent(pointer('pointerdown', 0, 0)); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', 5000, 4000)); });
    const clamped = onPositionChange.mock.calls[0][0] as { x: number; y: number };
    expect(clamped.x).toBeLessThanOrEqual(1000);
    expect(clamped.y).toBeLessThanOrEqual(700);
    expect(clamped.y).toBeGreaterThanOrEqual(REPLAY_FLOATING_SAFE_TOP_PX);
  });

  it('removes its pointer listeners on unmount', async () => {
    const onPositionChange = vi.fn();
    const view = await render({ mode: 'floating', onPositionChange });
    await act(async () => { handle(view.container)!.dispatchEvent(pointer('pointerdown', 45, 65)); });
    const entry = roots.pop()!;
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
    await act(async () => { window.dispatchEvent(pointer('pointermove', 300, 300)); });
    expect(onPositionChange).not.toHaveBeenCalled();
  });
});

describe('ReplayToolbar — narrow viewport rule', () => {
  it('omits Float and stays docked below 768 px', async () => {
    setViewport(600);
    const { container } = await render({ mode: 'docked' });
    expect(button(container, 'Float')).toBeUndefined();
    expect(button(container, 'Dock')).toBeUndefined();
    expect(toolbar(container).getAttribute('data-replay-toolbar-mode')).toBe('docked');
  });

  it('returns a floating toolbar to docked when the viewport becomes narrow', async () => {
    const onModeChange = vi.fn();
    const view = await render({ mode: 'floating', onModeChange });
    expect(toolbar(view.container).style.position).toBe('fixed');

    setViewport(500);
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    expect(onModeChange).toHaveBeenCalledWith('docked');
    // It also stops rendering as floating immediately, without waiting for the
    // owner to echo the new mode back.
    expect(toolbar(view.container).getAttribute('data-replay-toolbar-mode')).toBe('docked');
    expect(handle(view.container)).toBeNull();
  });

  it('keeps the floating request when the viewport is wide', async () => {
    const onModeChange = vi.fn();
    const view = await render({ mode: 'floating', onModeChange });
    setViewport(1200);
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    expect(onModeChange).not.toHaveBeenCalled();
    expect(toolbar(view.container).getAttribute('data-replay-toolbar-mode')).toBe('floating');
  });
});
