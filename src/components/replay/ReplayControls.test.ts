import { describe, expect, it, vi } from 'vitest';
import { submitReplayGoTo } from './ReplayControls.js';

describe('ReplayControls Go To submission boundary', () => {
  it('does not invoke the runtime action for invalid input', () => {
    const goTo = vi.fn();
    expect(submitReplayGoTo('2026-13-99 99:99 PM', goTo)).toBeTruthy();
    expect(goTo).not.toHaveBeenCalled();
  });

  it('passes only the resolved canonical UTC instant to the runtime action', () => {
    const goTo = vi.fn();
    expect(submitReplayGoTo('2026-08-14 06:36 PM', goTo)).toBeNull();
    expect(goTo).toHaveBeenCalledOnce();
    expect(goTo).toHaveBeenCalledWith(Date.parse('2026-08-14T22:36:00.000Z'));
  });
});
