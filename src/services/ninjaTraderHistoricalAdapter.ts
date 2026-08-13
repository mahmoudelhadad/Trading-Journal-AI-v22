/**
 * services/ninjaTraderHistoricalAdapter.ts
 *
 * B1 — the ONE place that knows NinjaTrader.
 *
 * Everything provider-specific stops here: the semicolon grammar, the
 * `yyyyMMdd HHmmss` timestamp form, the absent header row, the missing
 * contract identity in rows, the 'MM-YY' expiry notation, and the
 * End-of-Bar source convention. Downstream modules see only the
 * canonical, provider-neutral model in types/marketData.ts. If any of
 * those concepts becomes visible past this file, provider independence
 * has already been lost.
 *
 * PURE: no I/O, no IndexedDB, no React, no DOM. Result objects, never
 * exceptions — matching the `{ ok: false; error: string }` convention
 * services/ninjaTraderAdapter.ts already established for the trade
 * import path. That file is a DIFFERENT adapter for a DIFFERENT format
 * (execution CSVs, comma-delimited, header-driven, naive local
 * wall-clock timestamps) and is deliberately not reused or modified.
 *
 * SOURCE CONTRACT (empirically characterized from real exports):
 *   yyyyMMdd HHmmss;Open;High;Low;Close;Volume
 *   20160301 050100;4197;4197;4196.5;4196.5;10
 * no header · semicolon · exactly six fields · Minute · Last ·
 * timestamps in UTC · End-of-Bar.
 *
 * NORMALIZATION: a 1-minute End-of-Bar stamp names the END of its
 * interval, so the canonical start instant is `sourceEnd - 60_000` and
 * the bar covers the half-open interval [start, start + 60_000). The
 * adapter refuses any other (timeframe, convention) pair rather than
 * guessing — a silent one-minute shift produces backtests that look
 * entirely normal and are entirely wrong.
 */

import {
  MINUTE_MS,
  isHistoricalRoot,
  type HistoricalBar,
  type HistoricalImportDescriptor,
  type HistoricalSeriesIdentity,
  type ImportWarningCounts,
} from '@apptypes/marketData.js';

/** Tick sizes used ONLY for a warning. Local to this adapter on purpose: PIP_TABLE is Journal calculation config, not market-data authority. */
const TICK_SIZE: Record<string, number> = { NQ: 0.25, ES: 0.25 };

const EXPIRY_PATTERN = /^(0[1-9]|1[0-2])-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/;
/** Ordinary decimal money text. No exponent, no sign, no separators. */
const PRICE_PATTERN = /^\d+(?:\.\d+)?$/;
const VOLUME_PATTERN = /^\d+$/;

export interface NinjaTraderParseSuccess {
  ok: true;
  series: HistoricalSeriesIdentity;
  bars: HistoricalBar[];
  /** Non-blank lines seen in the source file, before dedup. */
  sourceRowCount: number;
  warnings: ImportWarningCounts;
}

export interface NinjaTraderParseFailure {
  ok: false;
  error: string;
  /** 1-based source line number, when the failure is attributable to one row. */
  rowNumber?: number;
}

export type NinjaTraderParseResult = NinjaTraderParseSuccess | NinjaTraderParseFailure;

/**
 * 'MM-YY' → unambiguous numeric year/month.
 *
 * The two-digit year maps to 2000–2099 — exactly NinjaTrader's own
 * notation domain, and it covers all of B1's scope. A contract outside
 * that century is out of scope and requires an explicit decision rather
 * than an inference here.
 */
export function normalizeExpiry(expiryText: unknown): { expiryYear: number; expiryMonth: number } | null {
  if (typeof expiryText !== 'string') return null;
  const match = expiryText.trim().match(EXPIRY_PATTERN);
  if (!match) return null;
  return { expiryYear: 2000 + Number(match[2]), expiryMonth: Number(match[1]) };
}

function failure(error: string, rowNumber?: number): NinjaTraderParseFailure {
  return rowNumber === undefined ? { ok: false, error } : { ok: false, error, rowNumber };
}

/**
 * Parse a source timestamp into epoch milliseconds, or null when the
 * value is syntactically or calendrically impossible.
 *
 * The round-trip through Date.UTC is what rejects 2016-02-30: the
 * constructor happily rolls it forward to March 1, so the only reliable
 * validation is to read the components back out.
 */
function parseSourceTimestamp(value: string): { utcMs: number; seconds: number } | null {
  const match = value.match(TIMESTAMP_PATTERN);
  if (!match) return null;
  const [year, month, day, hour, minute, second] =
    [match[1], match[2], match[3], match[4], match[5], match[6]].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(utcMs);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return { utcMs, seconds: second };
}

function parsePrice(value: string): number | null {
  if (!PRICE_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** True when `price` is an exact multiple of `tick`. Quarter points are binary fractions, so this is exact for NQ/ES. */
function isOnTick(price: number, tick: number): boolean {
  return Number.isInteger(price / tick);
}

function sameBar(a: HistoricalBar, b: HistoricalBar): boolean {
  return a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
}

/**
 * Parse a NinjaTrader 1-minute historical export into canonical bars.
 *
 * REJECT is import-fatal by design: a file containing a structurally
 * invalid row has unknown provenance, and partial ingestion of an
 * unknown-quality file is worse than none — re-import is free.
 * Malformed OHLC is never repaired.
 */
export function parseNinjaTraderHistorical(
  text: string,
  descriptor: HistoricalImportDescriptor,
): NinjaTraderParseResult {
  if (descriptor.source !== 'ninjatrader') return failure('Unsupported historical source.');
  if (!isHistoricalRoot(descriptor.root)) {
    return failure(`Unsupported historical root "${String(descriptor.root)}".`);
  }
  if (descriptor.timeframe !== '1m') return failure('Only 1-minute historical source data is supported.');
  if (descriptor.dataType !== 'Last') return failure('Only the "Last" data type is supported.');
  if (descriptor.sourceTimeZone !== 'UTC') return failure('Source timestamps must be declared as UTC.');
  if (descriptor.sourceTimestampConvention !== 'end-of-bar') {
    return failure('Only End-of-Bar source timestamps can be normalized by this adapter.');
  }
  const expiry = normalizeExpiry(descriptor.expiryText);
  if (expiry === null) {
    return failure(`Contract expiry "${String(descriptor.expiryText)}" is not valid MM-YY notation.`);
  }

  const series: HistoricalSeriesIdentity = {
    root:        descriptor.root,
    expiryYear:  expiry.expiryYear,
    expiryMonth: expiry.expiryMonth,
    timeframe:   descriptor.timeframe,
  };
  const tick = TICK_SIZE[descriptor.root];

  const warnings: ImportWarningCounts = { offTick: 0, outOfOrder: 0, inFileDuplicates: 0 };
  const parsed: HistoricalBar[] = [];
  let sourceRowCount = 0;
  let previousSourceUtcMs: number | null = null;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '') continue;
    const rowNumber = index + 1;
    sourceRowCount++;

    const fields = line.split(';');
    if (fields.length !== 6) {
      return failure(`Row ${rowNumber} has ${fields.length} fields; exactly 6 are required.`, rowNumber);
    }

    const timestamp = parseSourceTimestamp(fields[0]);
    if (timestamp === null) {
      return failure(`Row ${rowNumber} has an invalid timestamp "${fields[0]}".`, rowNumber);
    }
    if (timestamp.seconds !== 0) {
      return failure(`Row ${rowNumber} has non-zero seconds in a 1-minute source.`, rowNumber);
    }

    const open = parsePrice(fields[1]);
    const high = parsePrice(fields[2]);
    const low = parsePrice(fields[3]);
    const close = parsePrice(fields[4]);
    if (open === null || high === null || low === null || close === null) {
      return failure(`Row ${rowNumber} has an invalid or non-positive price.`, rowNumber);
    }

    if (!VOLUME_PATTERN.test(fields[5])) {
      return failure(`Row ${rowNumber} has an invalid volume "${fields[5]}".`, rowNumber);
    }
    const volume = Number(fields[5]);
    if (!Number.isSafeInteger(volume)) {
      return failure(`Row ${rowNumber} has an out-of-range volume "${fields[5]}".`, rowNumber);
    }

    if (high < low) return failure(`Row ${rowNumber} has High below Low.`, rowNumber);
    if (high < open || high < close) return failure(`Row ${rowNumber} has High below Open/Close.`, rowNumber);
    if (low > open || low > close) return failure(`Row ${rowNumber} has Low above Open/Close.`, rowNumber);

    if (tick !== undefined
      && (!isOnTick(open, tick) || !isOnTick(high, tick) || !isOnTick(low, tick) || !isOnTick(close, tick))) {
      warnings.offTick++;
    }

    if (previousSourceUtcMs !== null && timestamp.utcMs < previousSourceUtcMs) warnings.outOfOrder++;
    previousSourceUtcMs = timestamp.utcMs;

    parsed.push({ t: timestamp.utcMs - MINUTE_MS, o: open, h: high, l: low, c: close, v: volume });
  }

  parsed.sort((left, right) => left.t - right.t);

  const bars: HistoricalBar[] = [];
  for (const bar of parsed) {
    const previous = bars[bars.length - 1];
    if (previous !== undefined && previous.t === bar.t) {
      if (!sameBar(previous, bar)) {
        return failure(
          `Conflicting duplicate observation at ${new Date(bar.t).toISOString()}; the import was rejected rather than choosing a winner.`,
        );
      }
      warnings.inFileDuplicates++;
      continue;
    }
    bars.push(bar);
  }

  return { ok: true, series, bars, sourceRowCount, warnings };
}

/**
 * SHA-256 of the raw source text, lowercase hex — provenance for WHICH
 * file was imported, which is the question a user can independently
 * reproduce. Returns null on a host without Web Crypto rather than
 * throwing or pulling in a dependency; the checksum is then proven at
 * Runtime Acceptance instead.
 */
export async function computeSourceChecksumSha256(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
