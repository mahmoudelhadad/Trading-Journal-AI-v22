import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatReplayGoToTime, parseReplayGoToTime } from '@calculations/displayTime.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Select } from '@components/ui/Select.js';
import { COLORS as C } from '@constants/lists.js';
import { REPLAY_SPEEDS, type ReplaySnapshot, type ReplaySpeed, type ReplayTimeframe } from '@apptypes/replay.js';

interface Props {
  snapshot: ReplaySnapshot;
  onPlay(): void; onPause(): void; onStep(): void;
  onSpeed(speed: ReplaySpeed): void; onTimeframe(timeframe: ReplayTimeframe): void;
  onGoTo(utcMs: number): void;
}

/**
 * B2d Phase 9A — the compact chart-control primitive shared by the replay
 * transport and navigation controls.
 *
 * WHY LOCAL: the shared `ui/Button` renders no `title` and no `aria-label`
 * and has no rest-spread, so an icon-only face built on it would lose its
 * accessible name. Rather than widen a site-wide component for one surface,
 * the replay controls own this small primitive. It is a real `<button>`, so
 * keyboard activation and the disabled contract are the platform's, unchanged.
 *
 * The label is BOTH the hover tooltip (`title`) and the accessible name
 * (`aria-label`), so an icon-only control never becomes anonymous.
 */
export interface ReplayIconButtonProps {
  /** Hover tooltip AND accessible name. Never rendered as a visible text face. */
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Subtle accent for the primary transport action. Presentation only. */
  accent?: boolean;
}

const ICON_BUTTON: CSSProperties = {
  width: 28, height: 28, padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: '1px solid transparent', borderRadius: 6,
  lineHeight: 0, transition: 'background 0.12s, color 0.12s, border-color 0.12s',
};

export function ReplayIconButton({ label, icon, onClick, disabled = false, accent = false }: ReplayIconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = !disabled;
  return <button type="button" title={label} aria-label={label}
    onClick={onClick} disabled={disabled}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onBlur={() => setHovered(false)}
    style={{
      ...ICON_BUTTON,
      color: disabled ? C.dim : (accent ? C.blue : C.text),
      background: interactive && hovered ? C.border : 'transparent',
      borderColor: interactive && hovered ? C.border : 'transparent',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1,
    }}>{icon}</button>;
}

/**
 * Conventional transport / navigation glyphs, drawn inline so no icon package,
 * font or downloaded asset is introduced. `currentColor` lets one definition
 * serve the normal, accent and disabled states.
 */
const svg = (children: ReactNode) =>
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">{children}</svg>;

export const REPLAY_ICONS = {
  play: svg(<path d="M5 3.2v9.6l8-4.8z" fill="currentColor" />),
  pause: svg(<><rect x="4.2" y="3.2" width="2.6" height="9.6" rx="0.7" fill="currentColor" />
    <rect x="9.2" y="3.2" width="2.6" height="9.6" rx="0.7" fill="currentColor" /></>),
  stepForward: svg(<><path d="M3.5 3.2v9.6l7-4.8z" fill="currentColor" />
    <rect x="11.2" y="3.2" width="2.3" height="9.6" rx="0.7" fill="currentColor" /></>),
  stepBackward: svg(<><rect x="2.5" y="3.2" width="2.3" height="9.6" rx="0.7" fill="currentColor" />
    <path d="M12.5 3.2v9.6l-7-4.8z" fill="currentColor" /></>),
  undo: svg(<g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4.4h3.6a4.2 4.2 0 1 1 0 8.4H5.2" />
    <path d="M8.1 2.1 5.5 4.4l2.6 2.3" />
  </g>),
  redo: svg(<g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 4.4H6.4a4.2 4.2 0 1 0 0 8.4h4.4" />
    <path d="M7.9 2.1 10.5 4.4 7.9 6.7" />
  </g>),
} as const;

export function submitReplayGoTo(text: string, onGoTo: (utcMs: number) => void): string | null {
  const parsed = parseReplayGoToTime(text);
  if (!parsed.ok) return parsed.message;
  onGoTo(parsed.utcMs);
  return null;
}

export function ReplayControls({ snapshot, onPlay, onPause, onStep, onSpeed, onTimeframe, onGoTo }: Props) {
  const [goToText, setGoToText] = useState(() => formatReplayGoToTime(snapshot.nowUtcMs));
  const [goToError, setGoToError] = useState<string | null>(null);
  const editingGoTo = useRef(false);
  useEffect(() => {
    if (!editingGoTo.current) {
      setGoToText(formatReplayGoToTime(snapshot.nowUtcMs));
      setGoToError(null);
    }
  }, [snapshot.nowUtcMs]);
  const submitGoTo = () => {
    const error = submitReplayGoTo(goToText, onGoTo);
    setGoToError(error);
    editingGoTo.current = error !== null;
  };
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    {/* B2d Phase 9A — icon-only transport controls. Presentation only: every
        disabled expression and every handler below is the released one. */}
    <ReplayIconButton label="Play" accent icon={REPLAY_ICONS.play}
      onClick={onPlay} disabled={snapshot.playState === 'playing' || snapshot.loading} />
    <ReplayIconButton label="Pause" icon={REPLAY_ICONS.pause}
      onClick={onPause} disabled={snapshot.playState !== 'playing'} />
    <ReplayIconButton label="Step Forward" icon={REPLAY_ICONS.stepForward}
      onClick={onStep} disabled={snapshot.loading || snapshot.importing} />
    <Select value={String(snapshot.speed)} width={90} options={REPLAY_SPEEDS.map((speed) => ({ value: String(speed), label: `${speed}×` }))} onChange={(value) => onSpeed(Number(value) as ReplaySpeed)} />
    <Select value={snapshot.timeframe} width={90} options={['1m', '5m', '15m', '1h']} onChange={(value) => onTimeframe(value as ReplayTimeframe)} />
    <div onFocusCapture={() => { editingGoTo.current = true; }} onBlurCapture={() => { editingGoTo.current = false; }}
      style={{ display: 'grid', gridTemplateColumns: '250px auto', columnGap: 8, rowGap: 2, alignItems: 'end' }}>
      <label htmlFor="replay-go-to" style={{ gridColumn: '1 / -1', color: C.dim, fontSize: 10 }}>Go To (New York)</label>
      <Input id="replay-go-to" value={goToText} width={250} onChange={(value) => { setGoToText(value); setGoToError(null); }}
        placeholder="YYYY-MM-DD hh:mm AM/PM" />
      <Button onClick={submitGoTo}>Go To</Button>
      {goToError && <span role="alert" style={{ gridColumn: '1 / -1', color: C.red, fontSize: 10 }}>{goToError}</span>}
    </div>
  </div>;
}
