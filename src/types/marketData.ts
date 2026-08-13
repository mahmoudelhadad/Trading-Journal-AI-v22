/**
 * types/marketData.ts
 *
 * B1 — Free Historical Data Foundation: canonical market-data types.
 *
 * This file owns the PROVIDER-NEUTRAL canonical model. The single most
 * important property it encodes is the split between:
 *
 *   SERIES IDENTITY   — what market contract/timeframe this data is.
 *                       Replay-visible. Appears in seriesId and chunkId.
 *                       Contains NO provider/source.
 *
 *   SOURCE PROVENANCE — where these observations came from.
 *                       Storage-only, never Replay-visible.
 *                       This is the ONLY place a provider appears.
 *
 * That split is what allows a future shared historical service to fill
 * the same cache without Replay ever gaining a provider parameter.
 *
 * Historical market data is a RECONSTRUCTABLE cache domain, distinct
 * from the Journal's user-owned durable state (AD-014's Class A/Class B
 * split): it lives in its own IndexedDB database, never participates in
 * the resolver, sync, or backup, and is removable without touching
 * Journal data.
 *
 * SUPPORTED ROOTS are declared HERE, not derived from
 * constants/pipValues.js's PIP_TABLE. PIP_TABLE is Journal calculation
 * configuration; making it the authority for whether market data is
 * valid would couple two domains that have no reason to move together.
 */

// ─── Supported roots ──────────────────────────────────────────

/** The market-data domain's own root authority. Deliberately NOT PIP_TABLE. */
export const HISTORICAL_ROOTS = ['NQ', 'ES'] as const;

export type HistoricalRoot = typeof HISTORICAL_ROOTS[number];

export type HistoricalTimeframe = '1m';

/** One canonical bar interval, in milliseconds. B1 is 1-minute only. */
export const MINUTE_MS = 60_000;

/** One UTC calendar day, in milliseconds — the frozen chunk boundary. */
export const DAY_MS = 86_400_000;

const HISTORICAL_ROOT_SET = new Set<string>(HISTORICAL_ROOTS);

export function isHistoricalRoot(value: unknown): value is HistoricalRoot {
  return typeof value === 'string' && HISTORICAL_ROOT_SET.has(value);
}

// ─── Series identity (provider-neutral, Replay-visible) ───────

/**
 * What contract/timeframe this data represents.
 *
 * `expiryYear`/`expiryMonth` are numeric on purpose: the source's
 * 'MM-YY' notation leaves the century implicit and would force string
 * parsing into every key comparison. Canonical identity never retains
 * the ambiguous form.
 */
export interface HistoricalSeriesIdentity {
  root:        HistoricalRoot;
  expiryYear:  number;
  expiryMonth: number;
  timeframe:   HistoricalTimeframe;
}

// ─── Canonical bar (provider-neutral, Replay-visible) ─────────

/**
 * One canonical observation.
 *
 * `t` is the START instant of the interval, epoch milliseconds UTC.
 * The bar covers the half-open interval [t, t + MINUTE_MS).
 *
 * Deliberately absent: local/New York timestamp, session or RTH/ETH
 * classification, trading date, provider, contract identity, and any
 * completeness/synthetic flag. Every one of those is either derived at
 * display time or carried by the enclosing chunk. A raw bar states what
 * traded, nothing else.
 */
export interface HistoricalBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ─── Import descriptor (contains provider, ingestion-only) ────

/**
 * Everything the importer must be TOLD, because a source row cannot
 * prove it. Contract identity is supplied here and is authoritative:
 * a filename may prefill this, but never silently becomes canonical,
 * and instrument identity is never inferred from prices.
 *
 * The last four fields are constants for the only source B1 supports.
 * They are stored rather than implied so that a future source declaring
 * different semantics cannot be silently mis-ingested.
 */
export interface HistoricalImportDescriptor {
  source:                    'ninjatrader';
  root:                      HistoricalRoot;
  /** Source notation, 'MM-YY'. Normalized to numeric year/month at the adapter boundary. */
  expiryText:                string;
  timeframe:                 HistoricalTimeframe;
  dataType:                  'Last';
  sourceTimeZone:            'UTC';
  sourceTimestampConvention: 'end-of-bar';
}

// ─── Chunk (provider-neutral, storage-only) ───────────────────

/**
 * One UTC calendar day of bars for one series, column-oriented.
 *
 * Column arrays rather than an array of objects: at production scale
 * (~10M bars) per-bar object overhead dominates, and the six parallel
 * arrays structured-clone cleanly into IndexedDB.
 *
 * `revision` makes the chunk id unique per version of a day. A chunk
 * referenced by a committed manifest is never modified — a new version
 * of a day is always written to a NEW id, which is what makes the
 * manifest swap the sole visibility-changing operation.
 */
export interface HistoricalBarChunk {
  chunkId:  string;
  seriesId: string;
  /** UTC calendar day, 'YYYY-MM-DD'. */
  day:      string;
  revision: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

// ─── Provenance (contains provider, storage-only) ─────────────

export interface ImportWarningCounts {
  offTick:          number;
  outOfOrder:       number;
  inFileDuplicates: number;
}

/**
 * One import of one source file.
 *
 * NOTE what is absent: any universal "missing bar" count. The source
 * file encodes the bars it contains, never the export window the user
 * originally requested, so observed first/last bars do not prove the
 * requested range and an absence count cannot be derived from them in
 * general. Recording one would be a number that looks authoritative and
 * is not.
 */
export interface ImportProvenanceEntry {
  source:                    'ninjatrader';
  importedAt:                number;
  sourceChecksumSha256:      string;
  sourceRowCount:            number;
  acceptedBarCount:          number;
  idempotentDuplicates:      number;
  warnings:                  ImportWarningCounts;
  observedFirstUtcMs:        number;
  observedLastUtcMs:         number;
  sourceTimestampConvention: 'end-of-bar';
  normalizedConvention:      'start-of-bar';
  normalizationVersion:      number;
  dataType:                  'Last';
  sourceTimeZone:            'UTC';
}

/** Current normalization contract version, recorded on every import. */
export const NORMALIZATION_VERSION = 1;

// ─── Series record (the committed manifest) ───────────────────

/**
 * Canonical series state plus import provenance, in one physical
 * record because the commit must be a single atomic `put`.
 *
 * `state` is the deletion tombstone. `deleteSeries` sets it to
 * 'deleting' while PRESERVING committed.activeChunks, so the series
 * becomes reader-invisible immediately but the cleanup map survives a
 * crash and the deletion can be resumed deterministically without ever
 * scanning the chunk store.
 *
 * VISIBILITY RULE: a chunk is visible if and only if
 * `committed.activeChunks[day] === revision` on an 'active' record.
 * The existence of a chunk record is never, by itself, evidence of
 * visibility — which is why the reader must resolve this record first
 * and must never derive a chunk id speculatively.
 */
export interface HistoricalSeriesRecord {
  seriesId: string;
  series:   HistoricalSeriesIdentity;
  state:    'active' | 'deleting';

  /** CANONICAL SERIES STATE — read by the reader. */
  committed: {
    /** UTC day ('YYYY-MM-DD') → active revision number. */
    activeChunks:       Record<string, number>;
    observedFirstUtcMs: number;
    observedLastUtcMs:  number;
    barCount:           number;
  };

  /** IMPORT PROVENANCE — audit only, never consulted for visibility. */
  provenance: {
    imports: ImportProvenanceEntry[];
  };
}

// ─── Key derivation ───────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Canonical series key. Contains NO provider token — a future shared
 * service and a local NinjaTrader import address the same series.
 */
export function seriesIdOf(series: HistoricalSeriesIdentity): string {
  return `${series.root}|${series.expiryYear}|${pad2(series.expiryMonth)}|${series.timeframe}`;
}

/** Canonical chunk key. Revision-bearing, so committed chunks are never targeted. */
export function chunkIdOf(seriesId: string, day: string, revision: number): string {
  return `${seriesId}|${day}|r${revision}`;
}

/**
 * UTC calendar day of an instant, 'YYYY-MM-DD'.
 * Zero-padded so lexicographic order equals chronological order.
 */
export function utcDayOf(utcMs: number): string {
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
