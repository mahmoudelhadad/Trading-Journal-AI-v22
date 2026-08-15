const DISPLAY_TIME_ZONE = 'America/New_York';

const dateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZoneName: 'shortOffset',
});

const tickTime = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

const goToTime = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

const wallTimeParts = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type GoToTimeParseResult =
  | { ok: true; utcMs: number; source: 'new_york' | 'iso_utc' }
  | { ok: false; reason: 'invalid' | 'ambiguous' | 'nonexistent'; message: string };

const FRIENDLY_GO_TO = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (AM|PM)$/;
const ISO_WITH_ZONE = /(Z|[+-]\d{2}:\d{2})$/i;
const SEARCH_WINDOW_MINUTES = 24 * 60;

function partsByType(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function wallTimeAt(utcMs: number): WallTime {
  const parts = partsByType(wallTimeParts, new Date(utcMs));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function sameWallTime(left: WallTime, right: WallTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

function wallTimeAsUtcMs(wall: WallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, 0, 0);
  return date.getTime();
}

function isValidWallTime(wall: WallTime): boolean {
  const date = new Date(wallTimeAsUtcMs(wall));
  return date.getUTCFullYear() === wall.year && date.getUTCMonth() === wall.month - 1
    && date.getUTCDate() === wall.day && date.getUTCHours() === wall.hour
    && date.getUTCMinutes() === wall.minute;
}

export function formatReplayTime(utcMs: number): string {
  return `${dateTime.format(new Date(utcMs))} · ${new Date(utcMs).toISOString()}`;
}

export function formatReplayChartTime(utcSeconds: number): string {
  return tickTime.format(new Date(utcSeconds * 1000));
}

export function formatReplayGoToTime(utcMs: number): string {
  const parts = partsByType(goToTime, new Date(utcMs));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

export function parseReplayGoToTime(input: string): GoToTimeParseResult {
  const text = input.trim();
  if (ISO_WITH_ZONE.test(text)) {
    const utcMs = Date.parse(text);
    return Number.isSafeInteger(utcMs)
      ? { ok: true, utcMs, source: 'iso_utc' }
      : { ok: false, reason: 'invalid', message: 'Enter a valid New York date/time or exact UTC instant.' };
  }

  const match = FRIENDLY_GO_TO.exec(text);
  if (match === null) {
    return { ok: false, reason: 'invalid', message: 'Use YYYY-MM-DD hh:mm AM/PM or an exact UTC instant.' };
  }
  const hour12 = Number(match[4]);
  const minute = Number(match[5]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid New York date and time.' };
  }
  const wall: WallTime = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: (hour12 % 12) + (match[6] === 'PM' ? 12 : 0), minute,
  };
  if (!isValidWallTime(wall)) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid New York date and time.' };
  }

  const estimate = wallTimeAsUtcMs(wall);
  const matches: number[] = [];
  for (let deltaMinutes = -SEARCH_WINDOW_MINUTES; deltaMinutes <= SEARCH_WINDOW_MINUTES; deltaMinutes += 1) {
    const candidate = estimate + deltaMinutes * 60_000;
    if (sameWallTime(wallTimeAt(candidate), wall)) matches.push(candidate);
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', message: 'This New York time occurs twice because of DST. Enter the exact UTC time instead.' };
  }
  if (matches.length === 0) {
    return { ok: false, reason: 'nonexistent', message: 'This New York time does not exist because of the DST transition.' };
  }
  return { ok: true, utcMs: matches[0], source: 'new_york' };
}

export { DISPLAY_TIME_ZONE };
