import { REPLAY_SPEEDS, type ReplaySpeed } from '@apptypes/replay.js';

export interface ReplayClockAnchor {
  cursorUtcMs: number;
  perfMs: number;
  speed: ReplaySpeed;
}

export function isReplaySpeed(value: unknown): value is ReplaySpeed {
  return typeof value === 'number'
    && Number.isFinite(value)
    && REPLAY_SPEEDS.includes(value as ReplaySpeed);
}

export function projectReplayCursor(anchor: ReplayClockAnchor, perfNowMs: number): number {
  if (!Number.isFinite(perfNowMs) || perfNowMs <= anchor.perfMs) return anchor.cursorUtcMs;
  return anchor.cursorUtcMs + Math.floor((perfNowMs - anchor.perfMs) * anchor.speed);
}
