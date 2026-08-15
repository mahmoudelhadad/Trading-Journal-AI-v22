import { describe, expect, it } from 'vitest';
import { isReplaySpeed, projectReplayCursor } from './replayClock.js';

describe('replay clock', () => {
  it('accepts only the frozen speed domain', () => {
    expect([1, 2, 5, 10, 30, 60, 300].every(isReplaySpeed)).toBe(true);
    expect([NaN, Infinity, 0, -1, 3, '1'].some(isReplaySpeed)).toBe(false);
  });
  it('projects deterministically from a monotonic anchor', () => {
    expect(projectReplayCursor({ cursorUtcMs: 1000, perfMs: 10, speed: 5 }, 12.9)).toBe(1014);
  });
  it('never moves backwards on a stale monotonic sample', () => {
    expect(projectReplayCursor({ cursorUtcMs: 1000, perfMs: 10, speed: 1 }, 9)).toBe(1000);
  });
});
