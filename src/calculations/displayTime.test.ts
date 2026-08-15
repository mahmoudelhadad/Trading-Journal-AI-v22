import { describe, expect, it } from 'vitest';
import {
  formatReplayChartTime, formatReplayGoToTime, formatReplayTime, parseReplayGoToTime,
} from './displayTime.js';

describe('New York display formatting over UTC identity', () => {
  it('keeps the DST fall-back repeated hour distinct with offset/UTC fallback', () => {
    const first = Date.parse('2024-11-03T05:30:00Z');
    const second = Date.parse('2024-11-03T06:30:00Z');
    const localClock = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'shortOffset',
    });
    const offsetOf = (utcMs: number) => offset.formatToParts(new Date(utcMs))
      .find((part) => part.type === 'timeZoneName')?.value;
    const firstOffset = offsetOf(first);
    const secondOffset = offsetOf(second);
    expect(first).not.toBe(second);
    expect(localClock.format(new Date(first))).toBe(localClock.format(new Date(second)));
    expect(firstOffset).toBeTruthy();
    expect(secondOffset).toBeTruthy();
    expect(firstOffset).not.toBe(secondOffset);
    expect(formatReplayTime(first)).toContain(firstOffset!);
    expect(formatReplayTime(second)).toContain(secondOffset!);
    expect(formatReplayTime(first)).toContain('2024-11-03T05:30:00.000Z');
    expect(formatReplayTime(second)).toContain('2024-11-03T06:30:00.000Z');
  });
  it('formats chart labels in New York without shifting the coordinate', () => {
    expect(formatReplayChartTime(Date.parse('2024-01-15T15:00:00Z') / 1000)).toMatch(/10:00/);
  });
});

describe('Replay Go To New York input boundary', () => {
  it('formats a UTC instant as the friendly New York primary value', () => {
    expect(formatReplayGoToTime(Date.parse('2026-08-14T22:36:00.000Z'))).toBe('2026-08-14 06:36 PM');
  });

  it('parses a unique friendly New York time to canonical UTC minute precision', () => {
    expect(parseReplayGoToTime('2026-08-14 06:36 PM')).toEqual({
      ok: true, utcMs: Date.parse('2026-08-14T22:36:00.000Z'), source: 'new_york',
    });
  });

  it('parses an AM value through New York IANA rules', () => {
    expect(parseReplayGoToTime('2016-03-01 01:00 AM')).toEqual({
      ok: true, utcMs: Date.parse('2016-03-01T06:00:00.000Z'), source: 'new_york',
    });
  });

  it('preserves exact seconds and milliseconds through the ISO UTC fallback', () => {
    expect(parseReplayGoToTime('2016-03-01T06:00:30.123Z')).toEqual({
      ok: true, utcMs: Date.parse('2016-03-01T06:00:30.123Z'), source: 'iso_utc',
    });
  });

  it.each(['2026-13-99 99:99 PM', 'random text', '2026-02-29 01:00 PM'])(
    'rejects invalid calendar/time input: %s',
    (input) => { expect(parseReplayGoToTime(input)).toMatchObject({ ok: false, reason: 'invalid' }); },
  );

  it('rejects the repeated fall-back wall time as ambiguous', () => {
    expect(parseReplayGoToTime('2024-11-03 01:30 AM')).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('rejects the skipped spring-forward wall time as nonexistent', () => {
    expect(parseReplayGoToTime('2024-03-10 02:30 AM')).toMatchObject({ ok: false, reason: 'nonexistent' });
  });

  it('round-trips a unique minute-level instant through friendly New York text', () => {
    const utcMs = Date.parse('2025-05-20T14:47:00.000Z');
    expect(parseReplayGoToTime(formatReplayGoToTime(utcMs))).toEqual({ ok: true, utcMs, source: 'new_york' });
  });

  it('uses different winter and summer New York offsets without fixed-offset assumptions', () => {
    const winter = parseReplayGoToTime('2024-01-15 10:00 AM');
    const summer = parseReplayGoToTime('2024-07-15 10:00 AM');
    expect(winter).toMatchObject({ ok: true, utcMs: Date.parse('2024-01-15T15:00:00.000Z') });
    expect(summer).toMatchObject({ ok: true, utcMs: Date.parse('2024-07-15T14:00:00.000Z') });
  });
});
