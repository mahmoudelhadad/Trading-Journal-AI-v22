/**
 * services/historicalBarReader.ts
 *
 * B1 — the Replay-facing boundary, and the only market-data contract a
 * future Replay engine is allowed to know.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION. A read request names a MARKET
 * SERIES (root, expiry year/month, timeframe) and a UTC range. It does
 * not name a provider, a file, a database, or a cache. That is what
 * lets a future shared historical service become a different
 * implementation of `HistoricalChunkSource` rather than a change to
 * Replay: source selection lives strictly below this line.
 *
 * MANIFEST-GATED VISIBILITY. The reader resolves the series record
 * first and then reads ONLY the chunk ids that record references. It
 * never derives a chunk id from (series, day). That single discipline
 * is what makes a half-finished import invisible: chunks written before
 * a manifest commit are unreferenced, and therefore unreachable, rather
 * than merely unlikely to be read.
 *
 * ABSENCE IS NOT FAILURE. Sparse minutes are ordinary market data —
 * measured at 5–11% of a two-day window in the characterized samples —
 * so a range that legitimately contains no bars is `ok` with an empty
 * array, never an error, and no bar is ever synthesized to fill a gap
 * or to align two instruments.
 *
 * OBSERVED, NOT COMPLETE. `getLocalAvailability` reports what is held,
 * never that a day is complete. A source file cannot distinguish "no
 * trade in that minute" from "that minute was outside the requested
 * export window", so claiming coverage would be claiming knowledge the
 * data does not contain.
 */

import {
  seriesIdOf,
  chunkIdOf,
  type HistoricalBar,
  type HistoricalBarChunk,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
} from '@apptypes/marketData.js';

/**
 * One read from the chunk source, with three distinct outcomes:
 *
 *   { ok: true,  value: X    } — read succeeded, the record exists
 *   { ok: true,  value: null } — read succeeded and PROVED absence
 *   { ok: false }             — the read failed and proves nothing
 *
 * The third case is why this is a union rather than `X | null`.
 * Collapsing an operational failure into `null` would let the reader
 * report a storage error as "this series does not exist here", which is
 * a stronger claim than the evidence supports.
 */
export type ChunkSourceRead<T> =
  | { ok: true; value: T | null }
  | { ok: false };

/**
 * The seam between the reader and wherever canonical data lives.
 * B1 supplies an IndexedDB implementation; a later phase may supply one
 * that fills the local cache from a shared service on a miss.
 */
export interface HistoricalChunkSource {
  getSeries(seriesId: string): Promise<ChunkSourceRead<HistoricalSeriesRecord>>;
  getChunk(chunkId: string): Promise<ChunkSourceRead<HistoricalBarChunk>>;
}

export interface HistoricalReadRequest {
  series:    HistoricalSeriesIdentity;
  /** Inclusive lower bound, epoch ms UTC. */
  fromUtcMs: number;
  /** Exclusive upper bound, epoch ms UTC. */
  toUtcMs:   number;
}

export type HistoricalReadResult =
  | {
      ok: true;
      bars: HistoricalBar[];
      /** Extremes OF THE RETURNED BARS — not of any requested or cached window. */
      returnedFirstUtcMs: number | null;
      returnedLastUtcMs:  number | null;
    }
  | { ok: false; reason: 'series_unavailable' }
  | { ok: false; reason: 'read_failed'; message: string };

export type HistoricalAvailability =
  | { available: false }
  | {
      available: true;
      observedFirstUtcMs: number;
      observedLastUtcMs:  number;
      /** UTC days holding at least one committed observation. NOT a completeness claim. */
      observedDays: string[];
    };

export interface HistoricalBarReader {
  readBars(request: HistoricalReadRequest): Promise<HistoricalReadResult>;
  getLocalAvailability(series: HistoricalSeriesIdentity): Promise<HistoricalAvailability>;
}

function chunkBarsInRange(
  chunk: HistoricalBarChunk,
  fromUtcMs: number,
  toUtcMs: number,
): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  for (let i = 0; i < chunk.t.length; i++) {
    const t = chunk.t[i];
    if (t < fromUtcMs || t >= toUtcMs) continue;
    bars.push({ t, o: chunk.o[i], h: chunk.h[i], l: chunk.l[i], c: chunk.c[i], v: chunk.v[i] });
  }
  return bars;
}

export function createHistoricalBarReader(chunkSource: HistoricalChunkSource): HistoricalBarReader {
  /**
   * `{ ok: false }` means the lookup FAILED and established nothing.
   * `{ ok: true, record: null }` means the lookup SUCCEEDED and proved
   * the series is absent or not active. Callers must not treat the
   * first as the second.
   */
  async function activeRecord(
    seriesId: string,
  ): Promise<{ ok: true; record: HistoricalSeriesRecord | null } | { ok: false }> {
    const read = await chunkSource.getSeries(seriesId);
    if (!read.ok) return { ok: false };
    const record = read.value;
    // Any non-active state fails closed — an unknown future lifecycle
    // state must hide the series rather than expose it.
    return { ok: true, record: record !== null && record.state === 'active' ? record : null };
  }

  return {
    async readBars(request: HistoricalReadRequest): Promise<HistoricalReadResult> {
      const seriesId = seriesIdOf(request.series);
      const lookup = await activeRecord(seriesId);
      if (!lookup.ok) {
        return {
          ok: false,
          reason: 'read_failed',
          message: `The manifest for ${seriesId} could not be read; its availability is unknown.`,
        };
      }
      const record = lookup.record;
      if (record === null) return { ok: false, reason: 'series_unavailable' };

      if (!(request.toUtcMs > request.fromUtcMs)) {
        return { ok: true, bars: [], returnedFirstUtcMs: null, returnedLastUtcMs: null };
      }

      // Iterate the COMMITTED day set, not a derived calendar range —
      // bounded by what exists, and impossible to point at an
      // unreferenced chunk.
      const days = Object.keys(record.committed.activeChunks).sort();
      const bars: HistoricalBar[] = [];

      for (const day of days) {
        const revision = record.committed.activeChunks[day];
        const chunkId = chunkIdOf(seriesId, day, revision);
        const chunkRead = await chunkSource.getChunk(chunkId);

        if (!chunkRead.ok) {
          return {
            ok: false,
            reason: 'read_failed',
            message: `Committed chunk ${chunkId} could not be read; whether it exists is unknown.`,
          };
        }

        if (chunkRead.value === null) {
          // Benign race, or genuine integrity violation? Re-check once:
          // a series deleted mid-read is unavailable, not corrupt.
          const recheck = await activeRecord(seriesId);
          if (!recheck.ok) {
            // The re-read failed, so absence was never established.
            // Claiming series_unavailable here would assert more than
            // the evidence supports.
            return {
              ok: false,
              reason: 'read_failed',
              message: `Committed chunk ${chunkId} was not returned and the manifest could not be re-read.`,
            };
          }
          if (recheck.record === null) return { ok: false, reason: 'series_unavailable' };
          return {
            ok: false,
            reason: 'read_failed',
            message: `Committed chunk ${chunkId} is missing; the manifest and the chunk store disagree.`,
          };
        }

        // Appended one at a time, NOT `push(...arr)`. Spreading passes one
        // argument per element, so a large chunk would overflow the
        // engine's argument limit. Today a chunk is bounded to one UTC
        // day of 1-minute bars (<=1440), but that bound is a property of
        // the current timeframe rather than of this code, and sub-minute
        // data would invalidate it. The reader does not rely on it.
        for (const b of chunkBarsInRange(chunkRead.value, request.fromUtcMs, request.toUtcMs)) {
          bars.push(b);
        }
      }

      bars.sort((left, right) => left.t - right.t);
      return {
        ok: true,
        bars,
        returnedFirstUtcMs: bars.length === 0 ? null : bars[0].t,
        returnedLastUtcMs:  bars.length === 0 ? null : bars[bars.length - 1].t,
      };
    },

    /**
     * NOTE the deliberate asymmetry with `readBars`. This answers "can
     * the local cache serve this series right now?", so a failed read
     * and a genuine absence are both honestly `false` — neither can be
     * served. `readBars` needs the stronger distinction because a
     * caller must not conclude data is missing when storage merely
     * failed, so it reports `read_failed` instead.
     */
    async getLocalAvailability(series: HistoricalSeriesIdentity): Promise<HistoricalAvailability> {
      const lookup = await activeRecord(seriesIdOf(series));
      if (!lookup.ok || lookup.record === null) return { available: false };
      const record = lookup.record;
      return {
        available: true,
        observedFirstUtcMs: record.committed.observedFirstUtcMs,
        observedLastUtcMs:  record.committed.observedLastUtcMs,
        observedDays:       Object.keys(record.committed.activeChunks).sort(),
      };
    },
  };
}
