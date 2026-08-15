import { formatReplayTime } from '@calculations/displayTime.js';
import { COLORS as C } from '@constants/lists.js';

export function ReplayTimeReadout({ nowUtcMs }: { nowUtcMs: number }) {
  return <div style={{ color: C.text, fontFamily: 'monospace', fontSize: 13 }}>{formatReplayTime(nowUtcMs)}</div>;
}
