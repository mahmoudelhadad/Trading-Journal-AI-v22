import { useEffect, useRef, useState } from 'react';
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
    <Button variant="primary" onClick={onPlay} disabled={snapshot.playState === 'playing' || snapshot.loading}>Play</Button>
    <Button onClick={onPause} disabled={snapshot.playState !== 'playing'}>Pause</Button>
    <Button onClick={onStep} disabled={snapshot.loading || snapshot.importing}>Step Forward</Button>
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
