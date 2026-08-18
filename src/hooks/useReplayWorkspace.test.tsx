// @vitest-environment jsdom
/**
 * hooks/useReplayWorkspace.test.tsx
 *
 * B2d Phase 6A — the workspace hook now carries enough state to deserve direct
 * coverage. Everything it owns is transient UI state: no persistence call is
 * mocked here because the hook must make none, and the absence of any storage
 * seam is itself part of the contract.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useReplayWorkspace, type ReplayWorkspaceState } from './useReplayWorkspace.js';
import { NAV_HISTORY_DEPTH, REPLAY_FLOATING_SAFE_TOP_PX } from '@calculations/replayWorkspace.js';
import type { ReplayTimeframe } from '@apptypes/replay.js';

const roots: Array<{ root: Root; container: HTMLElement }> = [];

const nav = (cursorUtcMs: number, displayTimeframe: ReplayTimeframe = '1m') =>
  ({ cursorUtcMs, displayTimeframe });

async function mountHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  const seen: ReplayWorkspaceState[] = [];
  function Probe() {
    seen.push(useReplayWorkspace());
    return null;
  }
  await act(async () => { root.render(<Probe />); });
  return {
    latest: () => seen[seen.length - 1],
    renders: () => seen.length,
    run: async (action: (state: ReplayWorkspaceState) => void) => {
      await act(async () => { action(seen[seen.length - 1]); });
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
});

describe('useReplayWorkspace — defaults', () => {
  it('keeps the released Phase-4 form defaults and starts with no context menu', async () => {
    const hook = await mountHook();
    expect(hook.latest().orderQuantityText).toBe('1');
    expect(hook.latest().initialStopText).toBe('');
    expect(hook.latest().contextRequest).toBeNull();
  });

  it('starts unfocused, docked, with Select Bar off', async () => {
    const hook = await mountHook();
    expect(hook.latest().selectBarActive).toBe(false);
    expect(hook.latest().focusMode).toBe(false);
    expect(hook.latest().toolbarMode).toBe('docked');
    // B2d Phase 9B — the released X is preserved; Y is the shared safe-top
    // authority, never a second literal, so it cannot drift from the drag clamp.
    expect(hook.latest().toolbarPosition).toEqual({ x: 24, y: REPLAY_FLOATING_SAFE_TOP_PX });
  });

  it('starts the floating toolbar clear of the Header band', async () => {
    const hook = await mountHook();
    // The Header owns the top 54px; the initial float must begin below it.
    expect(hook.latest().toolbarPosition.y).toBeGreaterThan(54);
  });
});

describe('useReplayWorkspace — Phase-6A state', () => {
  it('toggles and closes Select Bar', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.toggleSelectBar());
    expect(hook.latest().selectBarActive).toBe(true);
    await hook.run((state) => state.toggleSelectBar());
    expect(hook.latest().selectBarActive).toBe(false);
    await hook.run((state) => state.toggleSelectBar());
    await hook.run((state) => state.closeSelectBar());
    expect(hook.latest().selectBarActive).toBe(false);
  });

  it('toggles and closes Focus Mode', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.toggleFocusMode());
    expect(hook.latest().focusMode).toBe(true);
    await hook.run((state) => state.toggleFocusMode());
    expect(hook.latest().focusMode).toBe(false);
    await hook.run((state) => state.toggleFocusMode());
    await hook.run((state) => state.closeFocusMode());
    expect(hook.latest().focusMode).toBe(false);
  });

  it('changes toolbar mode and floating position', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.setToolbarMode('floating'));
    expect(hook.latest().toolbarMode).toBe('floating');
    await hook.run((state) => state.setToolbarPosition({ x: 320, y: 180 }));
    expect(hook.latest().toolbarPosition).toEqual({ x: 320, y: 180 });
    await hook.run((state) => state.setToolbarMode('docked'));
    expect(hook.latest().toolbarMode).toBe('docked');
    // Position survives a dock/float round trip; nothing resets it.
    expect(hook.latest().toolbarPosition).toEqual({ x: 320, y: 180 });
  });

  it('opens and closes a context request without touching anything else', async () => {
    const hook = await mountHook();
    const request = { clientX: 10, clientY: 20, price: 20000.25, barStartUtcMs: 1_700_000_000_000 };
    await hook.run((state) => state.openContextRequest(request));
    expect(hook.latest().contextRequest).toEqual(request);
    await hook.run((state) => state.closeContextRequest());
    expect(hook.latest().contextRequest).toBeNull();
  });
});

describe('useReplayWorkspace — independence of the workspace surfaces', () => {
  it('never lets a workstation control disturb the shared order inputs', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.setOrderQuantityText('4'));
    await hook.run((state) => state.setInitialStopText('19995'));
    await hook.run((state) => state.openContextRequest(
      { clientX: 1, clientY: 2, price: 100, barStartUtcMs: 3 }));

    await hook.run((state) => state.toggleFocusMode());
    await hook.run((state) => state.toggleSelectBar());
    await hook.run((state) => state.setToolbarMode('floating'));
    await hook.run((state) => state.setToolbarPosition({ x: 90, y: 90 }));

    expect(hook.latest().orderQuantityText).toBe('4');
    expect(hook.latest().initialStopText).toBe('19995');
    expect(hook.latest().contextRequest).toEqual({ clientX: 1, clientY: 2, price: 100, barStartUtcMs: 3 });
    expect(hook.latest().focusMode).toBe(true);
    expect(hook.latest().selectBarActive).toBe(true);
  });

  it('exposes stable callback identities so consumers do not resubscribe', async () => {
    const hook = await mountHook();
    const before = hook.latest();
    await hook.run((state) => state.setOrderQuantityText('9'));
    const after = hook.latest();
    expect(after.openContextRequest).toBe(before.openContextRequest);
    expect(after.closeContextRequest).toBe(before.closeContextRequest);
    expect(after.toggleSelectBar).toBe(before.toggleSelectBar);
    expect(after.closeSelectBar).toBe(before.closeSelectBar);
    expect(after.toggleFocusMode).toBe(before.toggleFocusMode);
    expect(after.closeFocusMode).toBe(before.closeFocusMode);
  });

  it('performs no persistence', async () => {
    const hook = await mountHook();
    const before = window.localStorage.length;
    await hook.run((state) => state.toggleFocusMode());
    await hook.run((state) => state.setToolbarPosition({ x: 5, y: 5 }));
    await hook.run((state) => state.setOrderQuantityText('7'));
    await hook.run((state) => state.recordNavState(nav(1)));
    expect(window.localStorage.length).toBe(before);
  });
});

/**
 * B2d Phase 6B — navigation history. The stack rules themselves are already
 * proven against the pure module; these prove the React wiring keeps consuming
 * that model and never restates it.
 *
 * B2d Phase 7A — resolution and consumption are now two separate steps, so the
 * tests below distinguish "the hook worked out where to go" from "the hook spent
 * the history frame".
 */
describe('useReplayWorkspace — navigation history', () => {
  /** Resolve and immediately commit — the Phase-6B single-step equivalent. */
  const undoAndCommit = (state: ReplayWorkspaceState, current: ReturnType<typeof nav>) => {
    const resolved = state.resolveUndoNavigation(current);
    if (resolved !== null) state.commitNavTransition(resolved);
    return resolved;
  };
  const redoAndCommit = (state: ReplayWorkspaceState, current: ReturnType<typeof nav>) => {
    const resolved = state.resolveRedoNavigation(current);
    if (resolved !== null) state.commitNavTransition(resolved);
    return resolved;
  };

  it('starts empty in both directions', async () => {
    const hook = await mountHook();
    expect(hook.latest().navHistory).toEqual({ undo: [], redo: [] });
    expect(hook.latest().canUndoNavigation).toBe(false);
    expect(hook.latest().canRedoNavigation).toBe(false);
    expect(hook.latest().resolveUndoNavigation(nav(10))).toBeNull();
    expect(hook.latest().resolveRedoNavigation(nav(10))).toBeNull();
  });

  it('records a state and offers Undo, then Redo after undoing', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    expect(hook.latest().canUndoNavigation).toBe(true);
    expect(hook.latest().canRedoNavigation).toBe(false);

    let transition: ReturnType<ReplayWorkspaceState['resolveUndoNavigation']> = null;
    await hook.run((state) => { transition = undoAndCommit(state, nav(2)); });
    expect(transition!.transition.state).toEqual(nav(1));       // returns where to go
    expect(hook.latest().canUndoNavigation).toBe(false);
    expect(hook.latest().canRedoNavigation).toBe(true);

    let redo: ReturnType<ReplayWorkspaceState['resolveRedoNavigation']> = null;
    await hook.run((state) => { redo = redoAndCommit(state, nav(1)); });
    expect(redo!.transition.state).toEqual(nav(2));
    expect(hook.latest().canUndoNavigation).toBe(true);
    expect(hook.latest().canRedoNavigation).toBe(false);
  });

  it('drops the redo branch when a new navigation is recorded', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    await hook.run((state) => undoAndCommit(state, nav(2)));
    expect(hook.latest().canRedoNavigation).toBe(true);
    await hook.run((state) => state.recordNavState(nav(1)));
    expect(hook.latest().canRedoNavigation).toBe(false);
    expect(hook.latest().canUndoNavigation).toBe(true);
  });

  /* B2d Phase 7A — the transactional contract. */

  it('resolves Undo and Redo WITHOUT consuming the history', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    const before = hook.latest().navHistory;

    let resolved: ReturnType<ReplayWorkspaceState['resolveUndoNavigation']> = null;
    await hook.run((state) => { resolved = state.resolveUndoNavigation(nav(2)); });
    expect(resolved!.transition.state).toEqual(nav(1));
    expect(hook.latest().navHistory).toBe(before);          // untouched, not merely equal
    expect(hook.latest().canUndoNavigation).toBe(true);
    expect(hook.latest().canRedoNavigation).toBe(false);

    // The same holds for Redo once a redo branch exists.
    await hook.run((state) => state.commitNavTransition(resolved!));
    const afterUndo = hook.latest().navHistory;
    await hook.run((state) => { state.resolveRedoNavigation(nav(1)); });
    expect(hook.latest().navHistory).toBe(afterUndo);
    expect(hook.latest().canRedoNavigation).toBe(true);
  });

  it('applies the resolved transition only when it is committed', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    let resolved: ReturnType<ReplayWorkspaceState['resolveUndoNavigation']> = null;
    await hook.run((state) => { resolved = state.resolveUndoNavigation(nav(2)); });

    let committed = false;
    await hook.run((state) => { committed = state.commitNavTransition(resolved!); });
    expect(committed).toBe(true);
    expect(hook.latest().navHistory).toEqual({ undo: [], redo: [nav(2)] });
  });

  it('leaves the history exactly unchanged when a resolved transition is never committed', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    await hook.run((state) => state.recordNavState(nav(2)));
    const before = hook.latest().navHistory;

    await hook.run((state) => { state.resolveUndoNavigation(nav(3)); });
    await hook.run((state) => { state.resolveUndoNavigation(nav(3)); });   // resolving is idempotent
    expect(hook.latest().navHistory).toEqual(before);
    expect(hook.latest().canUndoNavigation).toBe(true);
    expect(hook.latest().canRedoNavigation).toBe(false);
  });

  it('refuses a commit whose context was cleared while it was pending', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    let resolved: ReturnType<ReplayWorkspaceState['resolveUndoNavigation']> = null;
    await hook.run((state) => { resolved = state.resolveUndoNavigation(nav(2)); });

    await hook.run((state) => state.clearNavHistory());
    let committed = true;
    await hook.run((state) => { committed = state.commitNavTransition(resolved!); });
    expect(committed).toBe(false);
    // No frame of the old context comes back.
    expect(hook.latest().navHistory).toEqual({ undo: [], redo: [] });
    expect(hook.latest().canUndoNavigation).toBe(false);
    expect(hook.latest().canRedoNavigation).toBe(false);
  });

  it('refuses a commit that a navigation recorded meanwhile would overwrite', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    let resolved: ReturnType<ReplayWorkspaceState['resolveUndoNavigation']> = null;
    await hook.run((state) => { resolved = state.resolveUndoNavigation(nav(2)); });

    await hook.run((state) => state.recordNavState(nav(2)));
    let committed = true;
    await hook.run((state) => { committed = state.commitNavTransition(resolved!); });
    expect(committed).toBe(false);
    expect(hook.latest().navHistory).toEqual({ undo: [nav(1), nav(2)], redo: [] });
  });

  it('bumps the context generation only on a clear, and drops a stale record', async () => {
    const hook = await mountHook();
    const generation = hook.latest().readNavGeneration();
    await hook.run((state) => state.recordNavState(nav(1)));
    expect(hook.latest().readNavGeneration()).toBe(generation);   // a record is not a context change

    await hook.run((state) => state.clearNavHistory());
    expect(hook.latest().readNavGeneration()).not.toBe(generation);
    // A command that started in the previous context finishes and is dropped.
    await hook.run((state) => state.recordNavState(nav(1), generation));
    expect(hook.latest().canUndoNavigation).toBe(false);
    // The same record in the CURRENT context is kept.
    await hook.run((state) => state.recordNavState(nav(1), hook.latest().readNavGeneration()));
    expect(hook.latest().canUndoNavigation).toBe(true);
  });

  it('keeps consuming the capped pure model', async () => {
    const hook = await mountHook();
    for (let index = 0; index < NAV_HISTORY_DEPTH + 5; index += 1) {
      await hook.run((state) => state.recordNavState(nav(index)));
    }
    expect(hook.latest().navHistory.undo).toHaveLength(NAV_HISTORY_DEPTH);
    // The oldest frames fell off the bottom, not the newest.
    expect(hook.latest().navHistory.undo[NAV_HISTORY_DEPTH - 1]).toEqual(nav(NAV_HISTORY_DEPTH + 4));
  });

  it('clears both directions', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(1)));
    await hook.run((state) => undoAndCommit(state, nav(2)));
    await hook.run((state) => state.clearNavHistory());
    expect(hook.latest().navHistory).toEqual({ undo: [], redo: [] });
    expect(hook.latest().canUndoNavigation).toBe(false);
    expect(hook.latest().canRedoNavigation).toBe(false);
  });

  it('never disturbs any other workspace state', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.setOrderQuantityText('4'));
    await hook.run((state) => state.setInitialStopText('19995'));
    await hook.run((state) => state.openContextRequest(
      { clientX: 1, clientY: 2, price: 100, barStartUtcMs: 3 }));
    await hook.run((state) => state.toggleFocusMode());
    await hook.run((state) => state.toggleSelectBar());
    await hook.run((state) => state.setToolbarMode('floating'));
    await hook.run((state) => state.setToolbarPosition({ x: 70, y: 80 }));

    await hook.run((state) => state.recordNavState(nav(1)));
    await hook.run((state) => undoAndCommit(state, nav(2)));
    await hook.run((state) => redoAndCommit(state, nav(1)));
    await hook.run((state) => state.clearNavHistory());

    expect(hook.latest().orderQuantityText).toBe('4');
    expect(hook.latest().initialStopText).toBe('19995');
    expect(hook.latest().contextRequest).toEqual({ clientX: 1, clientY: 2, price: 100, barStartUtcMs: 3 });
    expect(hook.latest().focusMode).toBe(true);
    expect(hook.latest().selectBarActive).toBe(true);
    expect(hook.latest().toolbarMode).toBe('floating');
    expect(hook.latest().toolbarPosition).toEqual({ x: 70, y: 80 });
  });

  it('records nothing but a cursor and a display timeframe', async () => {
    const hook = await mountHook();
    await hook.run((state) => state.recordNavState(nav(7, '5m')));
    expect(Object.keys(hook.latest().navHistory.undo[0]).sort()).toEqual(['cursorUtcMs', 'displayTimeframe']);
  });
});
