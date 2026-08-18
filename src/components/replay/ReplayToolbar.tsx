import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { Button } from '@components/ui/Button.js';
import { ReplayIconButton, REPLAY_ICONS } from './ReplayControls.js';
import { COLORS as C } from '@constants/lists.js';
import { REPLAY_FLOATING_SAFE_TOP_PX } from '@calculations/replayWorkspace.js';
import type { ReplayToolbarMode, ReplayToolbarPosition } from '@hooks/useReplayWorkspace.js';

/**
 * components/replay/ReplayToolbar.tsx
 *
 * B2d Phase 6A — the one Replay toolbar.
 *
 * A UI shell: it knows nothing about session persistence, execution authority,
 * the historical reader, action semantics or marker semantics. The released
 * `ReplayControls` and `ReplayTimeReadout` arrive as SLOTS and are rendered
 * unchanged exactly once, so Play/Pause/Step Forward/speed/timeframe/Go To keep
 * their released behaviour and no handler is forked.
 *
 * Step Backward is a delegation only — the toolbar computes no predecessor; the
 * runtime owns that target algorithm. Undo and Redo are navigation history only
 * (Phase 6B); the toolbar owns no stack logic. Phase 9A gives Step Backward,
 * Undo and Redo icon-only faces with hover/accessible names — presentation only.
 */
export interface ReplayToolbarProps {
  controls: ReactNode;
  timeReadout: ReactNode;
  /** Coarse enablement from `isStepBackEnabled`; the toolbar adds no rule. */
  stepBackEnabled: boolean;
  onStepBackward: () => void;
  /**
   * B2d Phase 6B — NAVIGATION Undo/Redo. Enablement comes from the pure history
   * model (and from the owner's apply guard); the toolbar owns no stack logic
   * and never sees an action, a trade or a session.
   */
  undoEnabled: boolean;
  redoEnabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selectBarActive: boolean;
  onToggleSelectBar: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  mode: ReplayToolbarMode;
  onModeChange: (mode: ReplayToolbarMode) => void;
  position: ReplayToolbarPosition;
  onPositionChange: (position: ReplayToolbarPosition) => void;
}

/** Frozen B2d rule: floating is unavailable below this viewport width. */
export const FLOATING_MIN_VIEWPORT_WIDTH = 768;
const VIEWPORT_MARGIN = 4;

const BASE: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
  background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10,
};

function clamp(value: number, max: number, min: number = VIEWPORT_MARGIN): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function ReplayToolbar({
  controls, timeReadout, stepBackEnabled, onStepBackward, undoEnabled, redoEnabled, onUndo, onRedo,
  selectBarActive, onToggleSelectBar, focusMode, onToggleFocusMode,
  mode, onModeChange, position, onPositionChange,
}: ReplayToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const [wideEnough, setWideEnough] = useState(
    () => window.innerWidth >= FLOATING_MIN_VIEWPORT_WIDTH);

  // Narrow viewports force docked and hide the Float action entirely.
  useEffect(() => {
    const onResize = () => setWideEnough(window.innerWidth >= FLOATING_MIN_VIEWPORT_WIDTH);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!wideEnough && mode === 'floating') onModeChange('docked');
  }, [wideEnough, mode, onModeChange]);

  const floating = mode === 'floating' && wideEnough;

  const clampToViewport = useCallback((x: number, y: number): ReplayToolbarPosition => {
    const rect = toolbarRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    return {
      x: clamp(x, window.innerWidth - width - VIEWPORT_MARGIN),
      // Y floors at the shared safe top, never the plain viewport margin, so a
      // drag cannot park the handle back under the Header.
      y: clamp(y, window.innerHeight - height - VIEWPORT_MARGIN, REPLAY_FLOATING_SAFE_TOP_PX),
    };
  }, []);

  // Re-clamp when the viewport shrinks under a floating toolbar.
  useEffect(() => {
    if (!floating) return;
    const onResize = () => onPositionChange(clampToViewport(position.x, position.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [floating, clampToViewport, onPositionChange, position.x, position.y]);

  /*
   * Drag moves the toolbar and nothing else — no cursor movement, no chart
   * coordinate, no execution, no session state. Only the explicit handle starts
   * it, so pressing Play, Step, Select Bar, Focus or any input never drags.
   */
  useEffect(() => {
    if (!floating) return;
    const onPointerMove = (event: PointerEvent) => {
      const offset = dragOffset.current;
      if (offset === null) return;
      onPositionChange(clampToViewport(event.clientX - offset.x, event.clientY - offset.y));
    };
    const stop = () => { dragOffset.current = null; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      dragOffset.current = null;
    };
  }, [floating, clampToViewport, onPositionChange]);

  const beginDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!floating) return;
    const rect = toolbarRef.current?.getBoundingClientRect();
    dragOffset.current = {
      x: event.clientX - (rect?.left ?? position.x),
      y: event.clientY - (rect?.top ?? position.y),
    };
  };

  const style: CSSProperties = floating
    ? { ...BASE, position: 'fixed', left: position.x, top: position.y, zIndex: 15 }
    : { ...BASE, marginTop: 14 };

  return <div ref={toolbarRef} aria-label="Replay toolbar" data-replay-toolbar=""
    data-replay-toolbar-mode={floating ? 'floating' : 'docked'} style={style}>
    {floating && <span data-replay-toolbar-handle="" aria-label="Move toolbar" role="presentation"
      onPointerDown={beginDrag}
      style={{ cursor: 'grab', color: C.dim, fontSize: 14, padding: '0 4px', userSelect: 'none' }}>⠿</span>}

    {timeReadout}
    {controls}

    {/* B2d Phase 9A — icon-only navigation controls, sharing the transport
        primitive so both halves of the toolbar look like one control strip.
        Enablement and handlers are unchanged; only the face is. */}
    <ReplayIconButton label="Step Backward" icon={REPLAY_ICONS.stepBackward}
      disabled={!stepBackEnabled} onClick={onStepBackward} />
    <ReplayIconButton label="Undo" icon={REPLAY_ICONS.undo}
      disabled={!undoEnabled} onClick={onUndo} />
    <ReplayIconButton label="Redo" icon={REPLAY_ICONS.redo}
      disabled={!redoEnabled} onClick={onRedo} />
    {/* Active state is shown through the existing primary variant; the data
        attribute is the same fact in a form tests can read. */}
    <span data-replay-toggle="select-bar" data-replay-active={selectBarActive ? 'true' : 'false'}>
      <Button size="sm" variant={selectBarActive ? 'primary' : 'secondary'}
        onClick={onToggleSelectBar}>Select Bar</Button>
    </span>
    <span data-replay-toggle="focus" data-replay-active={focusMode ? 'true' : 'false'}>
      <Button size="sm" variant={focusMode ? 'primary' : 'secondary'}
        onClick={onToggleFocusMode}>{focusMode ? 'Exit Focus' : 'Focus'}</Button>
    </span>
    {wideEnough && <Button size="sm" onClick={() => onModeChange(floating ? 'docked' : 'floating')}>
      {floating ? 'Dock' : 'Float'}</Button>}
  </div>;
}
